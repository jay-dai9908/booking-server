import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const dotenv = require('../../backend/node_modules/dotenv/lib/main.js');
dotenv.config({ path: path.resolve(__dirname, '../../backend/.env') });

const { PrismaClient } = require('../../backend/node_modules/@prisma/client/index.js');
const { ensureFreshDbSeeded, cleanOperationalData } = await import('./helpers/seedFreshDb.js');
const { toTaipeiDateString, dateOnly } = await import('../../shared/time.js');

const testDbUrl =
  process.env.TEST_DATABASE_URL ||
  'postgresql://user:password@localhost:5432/booking_db_test?schema=public';
const prisma = new PrismaClient({ datasources: { db: { url: testDbUrl.trim() } } });

const BASE_URL = process.env.BASE_URL || 'http://localhost:5173';
const HEADLESS = process.env.HEADLESS !== 'false';
if (!process.env.ADMIN_PASSWORD?.trim()) {
  console.error('請設定 ADMIN_PASSWORD 環境變數');
  process.exit(1);
}
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD.trim();

const SCREENSHOT_DIR = process.env.SCREENSHOT_DIR
  ? path.resolve(process.env.SCREENSHOT_DIR)
  : path.resolve(__dirname, 'screenshots');
fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

async function adminLogin(page) {
  await page.goto(`${BASE_URL}/admin/login`, { waitUntil: 'networkidle' });
  const pwdInput = page.locator('input[type="password"]');
  await pwdInput.waitFor({ state: 'visible', timeout: 10000 });
  await pwdInput.fill(ADMIN_PASSWORD);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL((url) => url.pathname.includes('/admin/'), { timeout: 15000 });
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(300);
}

async function setAccountingDateRange(page, fromStr, toStr) {
  const dateInputs = page.locator('input[type="date"]');
  await dateInputs.nth(0).fill(fromStr);
  await dateInputs.nth(1).fill(toStr);
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(450);
}

async function run() {
  console.log('--- Starting Round 44 Accounting, Method Keys, Unpaid, Member & Shop Revenue E2E ---');
  await ensureFreshDbSeeded(prisma);
  await cleanOperationalData(prisma);

  const now = new Date();
  const todayStr = toTaipeiDateString(now);
  const runId = Date.now().toString().slice(-6);

  const launchOptions = { headless: HEADLESS };
  if (process.env.PLAYWRIGHT_CHROMIUM_PATH) {
    launchOptions.executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH;
  }

  const browser = await chromium.launch(launchOptions);
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    acceptDownloads: true
  });
  const page = await context.newPage();

  const origGlobal = await prisma.globalSetting.findUnique({ where: { id: 1 } });
  const createdUserIds = [];

  try {
    await adminLogin(page);

    const customer = await prisma.user.create({
      data: {
        line_user_id: `r44_e2e_u1_${runId}`,
        name: '陳月報',
        phone: '0900000123'
      }
    });
    createdUserIds.push(customer.id);

    // =========================================================================
    // SCENARIO 1 (Item 1): 60 booking payments + 1 refund + 1 excluded shop payment in 2026-11
    // =========================================================================
    console.log('1. Verifying Item 1: 60 payments daily chart, avg ticket NT$95, and 61-row CSV...');
    const paySeed = [];
    for (let d = 1; d <= 30; d += 1) {
      const dStr = `2026-11-${String(d).padStart(2, '0')}`;
      const sess = await prisma.session.upsert({
        where: { session_date_start_time: { session_date: dateOnly(dStr), start_time: '14:00' } },
        update: {},
        create: { session_date: dateOnly(dStr), start_time: '14:00', end_time: '18:00', max_capacity: 20 }
      });
      for (let k = 1; k <= 2; k += 1) {
        const ref = `R44P1-${runId}-${d}-${k}`;
        await prisma.reservation.create({
          data: {
            booking_ref: ref,
            user_id: customer.id,
            session_id: sess.id,
            pax: 1,
            assigned_seats: [`1-${k}`],
            status: 'confirmed',
            is_paid: true,
            billing_status: 'paid',
            total_amount: 100
          }
        });
        const pNo = `P1-${runId}-${d}-${k}`;
        paySeed.push({
          payment_no: pNo,
          batch_no: `B_${pNo}`,
          booking_ref: ref,
          source: 'booking',
          source_ref: ref,
          kind: 'charge',
          method: 'cash',
          amount: 100,
          status: 'valid',
          staff_name: '店長',
          device_label: 'e2e',
          breakdown_json: {},
          created_at: new Date(`${dStr}T06:00:00.000Z`)
        });
      }
    }
    paySeed.push({
      payment_no: `P1-${runId}-REF`,
      batch_no: `B_P1-${runId}-REF`,
      booking_ref: `R44P1-${runId}-15-1`,
      source: 'booking',
      source_ref: `R44P1-${runId}-15-1`,
      kind: 'refund',
      method: 'cash',
      amount: 300,
      status: 'valid',
      staff_name: '店長',
      device_label: 'e2e',
      breakdown_json: {},
      created_at: new Date('2026-11-15T08:00:00.000Z')
    });
    paySeed.push({
      payment_no: `P1-${runId}-SHOP`,
      batch_no: `B_P1-${runId}-SHOP`,
      booking_ref: `PO-R44P1-${runId}`,
      source: 'shop',
      source_ref: `PO-R44P1-${runId}`,
      kind: 'charge',
      method: 'cash',
      amount: 500,
      status: 'valid',
      staff_name: '店長',
      device_label: 'e2e',
      breakdown_json: {},
      created_at: new Date('2026-11-10T08:00:00.000Z')
    });
    await prisma.payment.createMany({ data: paySeed });

    await page.goto(`${BASE_URL}/admin/accounting`, { waitUntil: 'networkidle' });
    await setAccountingDateRange(page, '2026-11-01', '2026-11-30');

    const body1 = await page.locator('body').innerText();
    assert.ok(body1.includes('NT$5,700'), `Expected NT$5,700 net revenue, got snippet: ${body1.slice(0, 400)}`);
    assert.ok(body1.includes('NT$95'), 'Expected NT$95 avg ticket');
    assert.ok(body1.includes('共 60 組已結帳'), 'Expected 60 paid bookings');

    // Day 1 bar in SVG must have height > 3 (not zero!)
    const firstBarHeight = await page.locator('svg rect').first().getAttribute('height');
    assert.ok(Number(firstBarHeight) > 5, `Expected day 1 chart bar height > 5, got ${firstBarHeight}`);

    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'round44_shot1_daily_chart.png'), fullPage: false });

    // Switch to payments tab & download full CSV (must contain 61 data rows!)
    await page.getByRole('tab', { name: '收款明細' }).click();
    await page.waitForTimeout(300);
    const paymentsTxt = await page.locator('body').innerText();
    assert.ok(paymentsTxt.includes('共 61 筆'), 'Expected 共 61 筆 in payments tab');

    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: /匯出 CSV/ }).click();
    const download = await downloadPromise;
    const dlPath = await download.path();
    const dlContent = fs.readFileSync(dlPath, 'utf8').replace(/^\uFEFF/, '');
    const dlLines = dlContent.split(/\r?\n/).filter(Boolean);
    assert.equal(dlLines.length - 1, 61, `Expected 61 data rows in downloaded CSV, got ${dlLines.length - 1}`);

    // =========================================================================
    // SCENARIO 2 (Item 2): Normalized linepay/line_pay & dynamic custom_1 / card cards + closing
    // =========================================================================
    console.log('2. Verifying Item 2: Dynamic method cards, LINE Pay merge, filter, & closing breakdown...');
    await cleanOperationalData(prisma);
    await prisma.globalSetting.update({
      where: { id: 1 },
      data: {
        payment_methods_json: [
          { key: 'cash', label: '現金', enabled: true },
          { key: 'linepay', label: 'LINE Pay', enabled: true },
          { key: 'card', label: '信用卡', enabled: true },
          { key: 'custom_1', label: '街口', enabled: true }
        ]
      }
    });

    const s18 = await prisma.session.upsert({
      where: { session_date_start_time: { session_date: dateOnly('2026-11-18'), start_time: '14:00' } },
      update: {},
      create: { session_date: dateOnly('2026-11-18'), start_time: '14:00', end_time: '18:00', max_capacity: 20 }
    });
    const ref2 = `R44P2-${runId}`;
    await prisma.reservation.create({
      data: {
        booking_ref: ref2,
        user_id: customer.id,
        session_id: s18.id,
        pax: 1,
        assigned_seats: ['1-1'],
        status: 'confirmed',
        is_paid: true,
        billing_status: 'paid',
        total_amount: 1150
      }
    });
    await prisma.payment.createMany({
      data: [
        { payment_no: `P2-${runId}-1`, batch_no: 'B2-1', booking_ref: ref2, source: 'booking', source_ref: ref2, kind: 'charge', method: 'linepay', amount: 300, status: 'valid', staff_name: '店長', device_label: 'e2e', breakdown_json: {}, created_at: new Date('2026-11-18T06:00:00.000Z') },
        { payment_no: `P2-${runId}-2`, batch_no: 'B2-2', booking_ref: ref2, source: 'booking', source_ref: ref2, kind: 'charge', method: 'line_pay', amount: 200, status: 'valid', staff_name: '店長', device_label: 'e2e', breakdown_json: {}, created_at: new Date('2026-11-18T06:01:00.000Z') },
        { payment_no: `P2-${runId}-3`, batch_no: 'B2-3', booking_ref: ref2, source: 'booking', source_ref: ref2, kind: 'charge', method: 'card', amount: 500, status: 'valid', staff_name: '店長', device_label: 'e2e', breakdown_json: {}, created_at: new Date('2026-11-18T06:02:00.000Z') },
        { payment_no: `P2-${runId}-4`, batch_no: 'B2-4', booking_ref: ref2, source: 'booking', source_ref: ref2, kind: 'charge', method: 'custom_1', amount: 100, status: 'valid', staff_name: '店長', device_label: 'e2e', breakdown_json: {}, created_at: new Date('2026-11-18T06:03:00.000Z') },
        { payment_no: `P2-${runId}-5`, batch_no: 'B2-5', booking_ref: ref2, source: 'booking', source_ref: ref2, kind: 'charge', method: 'other', amount: 50, status: 'valid', staff_name: '店長', device_label: 'e2e', breakdown_json: {}, created_at: new Date('2026-11-18T06:04:00.000Z') }
      ]
    });

    await page.goto(`${BASE_URL}/admin/accounting`, { waitUntil: 'networkidle' });
    await setAccountingDateRange(page, '2026-11-18', '2026-11-18');
    const overview2 = await page.locator('body').innerText();
    assert.ok(overview2.includes('LINE Pay（2 筆）') && overview2.includes('NT$500'), 'Expected LINE Pay NT$500');
    assert.ok(overview2.includes('信用卡（1 筆）') && overview2.includes('NT$500'), 'Expected 信用卡 NT$500');
    assert.ok(overview2.includes('街口（1 筆）') && overview2.includes('NT$100'), 'Expected 街口 NT$100');
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'round44_shot2_overview_methods.png'), fullPage: false });

    // Payments filter for LINE Pay -> 2 rows
    await page.getByRole('tab', { name: '收款明細' }).click();
    await page.waitForTimeout(300);
    await page.getByRole('button', { name: 'LINE Pay', exact: true }).click();
    await page.waitForTimeout(400);
    const filteredTxt = await page.locator('body').innerText();
    assert.ok(filteredTxt.includes('共 2 筆'), 'Expected LINE Pay filter to show 共 2 筆');

    // Closing tab -> 信用卡 & 街口 rows
    await page.getByRole('tab', { name: '日結', exact: true }).first().click();
    await page.waitForTimeout(300);
    await page.locator('input[type="date"]').first().fill('2026-11-18');
    await page.waitForTimeout(450);
    const closing2Txt = await page.locator('body').innerText();
    assert.ok(closing2Txt.includes('信用卡（1 筆）'), 'Expected 信用卡 row in closing');
    assert.ok(closing2Txt.includes('街口（1 筆）'), 'Expected 街口 row in closing');
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'round44_shot3_closing_methods.png'), fullPage: false });

    // =========================================================================
    // SCENARIO 3 (Item 3): Unified unpaid count (2) & pass deduction (B shows NT$400)
    // =========================================================================
    console.log('3. Verifying Item 3: Unified unpaid count & pass deduction...');
    await cleanOperationalData(prisma);
    const sToday = await prisma.session.upsert({
      where: { session_date_start_time: { session_date: dateOnly(todayStr), start_time: '14:00' } },
      update: {},
      create: { session_date: dateOnly(todayStr), start_time: '14:00', end_time: '18:00', max_capacity: 30 }
    });
    await prisma.reservation.createMany({
      data: [
        { booking_ref: `R44U-${runId}-A`, user_id: customer.id, session_id: sToday.id, pax: 1, assigned_seats: ['1-1'], status: 'confirmed', billing_status: 'partial', is_paid: false, amount_due: 1100, amount_received: 550, total_amount: 1100 },
        { booking_ref: `R44U-${runId}-B`, user_id: customer.id, session_id: sToday.id, pax: 1, assigned_seats: ['1-2'], status: 'confirmed', billing_status: 'partial', is_paid: false, amount_due: 600, amount_received: 200, total_amount: 600 },
        { booking_ref: `R44U-${runId}-C`, user_id: customer.id, session_id: sToday.id, pax: 1, assigned_seats: ['1-3'], status: 'confirmed', billing_status: null, is_paid: false, amount_due: null, amount_received: 0, total_amount: 300 },
        { booking_ref: `R44U-${runId}-D`, user_id: customer.id, session_id: sToday.id, pax: 1, assigned_seats: ['1-4'], status: 'confirmed', attendance: 'no_show', billing_status: 'unpaid', is_paid: false, amount_due: 500, amount_received: 0, total_amount: 500 },
        { booking_ref: `R44U-${runId}-E`, user_id: customer.id, session_id: sToday.id, pax: 1, assigned_seats: ['1-5'], status: 'cancelled', billing_status: 'unpaid', is_paid: false, amount_due: 800, amount_received: 0, total_amount: 800 }
      ]
    });
    await prisma.payment.createMany({
      data: [
        { payment_no: `P3-${runId}-1`, batch_no: 'B3-1', booking_ref: `R44U-${runId}-A`, source: 'booking', source_ref: `R44U-${runId}-A`, kind: 'charge', method: 'cash', amount: 550, status: 'valid', staff_name: '店長', device_label: 'e2e', breakdown_json: {}, created_at: now },
        { payment_no: `P3-${runId}-2`, batch_no: 'B3-2', booking_ref: `R44U-${runId}-A`, source: 'booking', source_ref: `R44U-${runId}-A`, kind: 'charge', method: 'pass', amount: 550, status: 'valid', staff_name: '店長', device_label: 'e2e', breakdown_json: {}, created_at: now }
      ]
    });

    await page.goto(`${BASE_URL}/admin/accounting`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(400);
    const unpaidBtn = page.getByRole('tab', { name: /未結追蹤/ });
    assert.ok((await unpaidBtn.innerText()).includes('(2)'), 'Expected 未結追蹤 (2) badge');

    await page.getByRole('tab', { name: '日結', exact: true }).first().click();
    await page.waitForTimeout(400);
    assert.ok((await page.locator('body').innerText()).includes('未結（2 筆'), 'Expected 2 unpaid in closing');

    await unpaidBtn.click();
    await page.waitForTimeout(400);
    const unpaidTabTxt = await page.locator('body').innerText();
    assert.ok(unpaidTabTxt.includes('NT$400'), 'Expected booking B NT$400 in unpaid table');
    assert.ok(unpaidTabTxt.includes('NT$300'), 'Expected booking C NT$300 in unpaid table');
    assert.ok(!unpaidTabTxt.includes(`R44U-${runId}-A`), 'Booking A settled with pass must not appear');

    // =========================================================================
    // SCENARIO 4 (Item 4): Member modal tabs/total_paid + Reservations auto 'all' phone search
    // =========================================================================
    console.log('4. Verifying Item 4: Member modal tabs & Reservations cross-month search...');
    await cleanOperationalData(prisma);
    const [yr, mo] = todayStr.slice(0, 7).split('-').map(Number);
    const prevMonthStr = new Date(Date.UTC(yr, mo - 2, 15)).toISOString().slice(0, 10);
    const sPrev = await prisma.session.upsert({
      where: { session_date_start_time: { session_date: dateOnly(prevMonthStr), start_time: '14:00' } },
      update: {},
      create: { session_date: dateOnly(prevMonthStr), start_time: '14:00', end_time: '18:00', max_capacity: 20 }
    });
    const mRef1 = `R44M4-${runId}-1`;
    const mRefPrev = `R44M4-${runId}-PREV`;
    const mOrderRef = `PO-M4-${runId}`;
    await prisma.reservation.createMany({
      data: [
        { booking_ref: mRef1, user_id: customer.id, session_id: sToday.id, pax: 1, assigned_seats: ['1-1'], status: 'confirmed', attendance: 'checked_in', is_paid: true, billing_status: 'paid', has_refund: true, total_amount: 600, amount_due: 600, amount_received: 500 },
        { booking_ref: mRefPrev, user_id: customer.id, session_id: sPrev.id, pax: 1, assigned_seats: ['1-2'], status: 'confirmed', total_amount: 300 }
      ]
    });
    await prisma.productOrder.create({
      data: {
        order_ref: mOrderRef,
        user_id: customer.id,
        total_amount: 800,
        deposit_required: 300,
        paid_amount: 300,
        balance_amount: 500,
        payment_method_code: 'cash',
        payment_status: 'deposit_verified',
        order_status: 'preorder_placed'
      }
    });
    await prisma.payment.createMany({
      data: [
        { payment_no: `P4-${runId}-1`, batch_no: 'B4-1', booking_ref: mRef1, source: 'booking', source_ref: mRef1, kind: 'charge', method: 'cash', amount: 600, status: 'valid', staff_name: '店長', device_label: 'e2e', breakdown_json: {}, created_at: now },
        { payment_no: `P4-${runId}-2`, batch_no: 'B4-2', booking_ref: mRef1, source: 'booking', source_ref: mRef1, kind: 'refund', method: 'cash', amount: 100, status: 'valid', staff_name: '店長', device_label: 'e2e', breakdown_json: {}, created_at: now },
        { payment_no: `P4-${runId}-3`, batch_no: 'B4-3', booking_ref: mOrderRef, source: 'shop', source_ref: mOrderRef, kind: 'charge', method: 'cash', amount: 300, status: 'valid', staff_name: '店長', device_label: 'e2e', breakdown_json: {}, created_at: now }
      ]
    });

    await page.goto(`${BASE_URL}/admin/members`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(400);
    await page.getByText('陳月報').first().click();
    await page.waitForTimeout(500);
    const modalTxt = await page.locator('body').innerText();
    assert.ok(modalTxt.includes('累計實付 NT$500'), 'Expected 累計實付 NT$500 in member modal');
    assert.ok(modalTxt.includes('商城另計 NT$300'), 'Expected 商城另計 NT$300 in member modal');

    await page.getByRole('button', { name: /^退款 \(/ }).click();
    await page.waitForTimeout(300);
    assert.ok((await page.locator('body').innerText()).includes('NT$100'), 'Expected NT$100 in refund tab');

    await page.getByRole('button', { name: /^收款 \(/ }).click();
    await page.waitForTimeout(300);
    assert.ok((await page.locator('body').innerText()).includes('NT$600'), 'Expected NT$600 in charge tab');
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'round44_shot4_member_payments.png'), fullPage: false });

    // Reservations cross-month auto 'all' phone search
    await page.goto(`${BASE_URL}/admin/reservations`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(400);
    await page.getByPlaceholder('搜尋訂單編號、姓名或電話...').fill('0900000123');
    await page.waitForTimeout(550);
    const resTxt = await page.locator('body').innerText();
    assert.ok(resTxt.includes(prevMonthStr.slice(5).replace('-', '/')) || resTxt.includes('陳月報'), 'Expected prevMonth booking match');
    const allScopeBtnClass = await page.getByTestId('scope-btn-all').getAttribute('class');
    assert.ok(allScopeBtnClass?.includes('bg-sg-brown'), 'Expected scope-btn-all to auto-activate on search');
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'round44_shot5_reservations_search.png'), fullPage: false });

    // =========================================================================
    // SCENARIO 5 (Item 5): Dedicated Shop Revenue Tab (NT$1,800) vs Overview (NT$1,000)
    // =========================================================================
    console.log('5. Verifying Item 5: Dedicated Shop Revenue tab NT$1,800 vs Overview NT$1,000...');
    await cleanOperationalData(prisma);
    const sNov10 = await prisma.session.upsert({
      where: { session_date_start_time: { session_date: dateOnly('2026-11-10'), start_time: '14:00' } },
      update: {},
      create: { session_date: dateOnly('2026-11-10'), start_time: '14:00', end_time: '18:00', max_capacity: 20 }
    });
    const ref5 = `R44S5-${runId}`;
    const ord5 = `PO-S5-${runId}`;
    await prisma.reservation.create({
      data: { booking_ref: ref5, user_id: customer.id, session_id: sNov10.id, pax: 1, assigned_seats: ['1-1'], status: 'confirmed', is_paid: true, billing_status: 'paid', total_amount: 1000 }
    });
    await prisma.productOrder.create({
      data: { order_ref: ord5, user_id: customer.id, total_amount: 2000, deposit_required: 500, paid_amount: 1800, balance_amount: 0, payment_method_code: 'transfer', payment_status: 'fully_paid', order_status: 'picked_up' }
    });
    await prisma.payment.createMany({
      data: [
        { payment_no: `P5-${runId}-1`, batch_no: 'B5-1', booking_ref: ord5, source: 'shop', source_ref: ord5, kind: 'charge', method: 'transfer', amount: 500, status: 'valid', staff_name: '店長', device_label: 'e2e', breakdown_json: {}, created_at: new Date('2026-11-10T06:00:00.000Z') },
        { payment_no: `P5-${runId}-2`, batch_no: 'B5-2', booking_ref: ord5, source: 'shop', source_ref: ord5, kind: 'supplement', method: 'cash', amount: 1500, status: 'valid', staff_name: '店長', device_label: 'e2e', breakdown_json: {}, created_at: new Date('2026-11-12T06:00:00.000Z') },
        { payment_no: `P5-${runId}-3`, batch_no: 'B5-3', booking_ref: ord5, source: 'shop', source_ref: ord5, kind: 'refund', method: 'cash', amount: 200, status: 'valid', staff_name: '店長', device_label: 'e2e', breakdown_json: {}, created_at: new Date('2026-11-15T06:00:00.000Z') },
        { payment_no: `P5-${runId}-4`, batch_no: 'B5-4', booking_ref: ref5, source: 'booking', source_ref: ref5, kind: 'charge', method: 'cash', amount: 1000, status: 'valid', staff_name: '店長', device_label: 'e2e', breakdown_json: {}, created_at: new Date('2026-11-10T08:00:00.000Z') }
      ]
    });

    await page.goto(`${BASE_URL}/admin/accounting`, { waitUntil: 'networkidle' });
    await setAccountingDateRange(page, '2026-11-01', '2026-11-30');
    await page.getByRole('tab', { name: '商城收入' }).click();
    await page.waitForTimeout(450);
    const shopTabTxt = await page.locator('body').innerText();
    assert.ok(shopTabTxt.includes('NT$1,800'), 'Expected 商城淨額 NT$1,800');
    assert.ok(shopTabTxt.includes('商城收入不算進上面的營收'), 'Expected store exclusion notice');
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'round44_shot6_shop_revenue.png'), fullPage: false });

    await page.getByRole('tab', { name: '營收總覽' }).click();
    await page.waitForTimeout(400);
    const backOverviewTxt = await page.locator('body').innerText();
    assert.ok(backOverviewTxt.includes('NT$1,000'), 'Expected store overview net_revenue NT$1,000');

    console.log('✅ Round 44 Accounting, Method Keys, Unpaid, Member & Shop Revenue E2E ALL PASSED!');
  } finally {
    await browser.close().catch(() => {});
    if (origGlobal) {
      await prisma.globalSetting.update({
        where: { id: 1 },
        data: { payment_methods_json: origGlobal.payment_methods_json }
      }).catch(() => {});
    }
    await cleanOperationalData(prisma).catch(() => {});
    if (createdUserIds.length > 0) {
      await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } }).catch(() => {});
    }
    await prisma.$disconnect().catch(() => {});
  }
}

run().catch((err) => {
  console.error('FAILED:', err);
  process.exit(1);
});
