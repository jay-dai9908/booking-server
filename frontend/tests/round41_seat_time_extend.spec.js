// frontend/tests/round41_seat_time_extend.spec.js
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
  await page.waitForURL(url => url.pathname.includes('/admin/sessions'), { timeout: 15000 });
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(300);
}

async function run() {
  console.log('--- Starting Round 41 Seat Time & Extend Playwright Test ---');
  await ensureFreshDbSeeded(prisma);
  await cleanOperationalData(prisma);

  const now = new Date();
  const todayStr = toTaipeiDateString(now);
  const todayDate = dateOnly(todayStr);
  const ts = Date.now().toString().slice(-6);

  let layout = null;
  let prevPublishedIds = [];
  let s14 = null;
  let s15 = null;
  let s16 = null;
  let s17 = null;
  const createdUserIds = [];

  try {
    const existingLayouts = await prisma.seatLayout.findMany({
      where: { status: 'published' },
      select: { id: true }
    });
    prevPublishedIds = existingLayouts.map(l => l.id);
    if (prevPublishedIds.length > 0) {
      await prisma.seatLayout.updateMany({
        where: { id: { in: prevPublishedIds } },
        data: { status: 'archived' }
      });
    }

    layout = await prisma.seatLayout.create({
      data: {
        name: `R41測試空間-${ts}`,
        status: 'published',
        effective_from: dateOnly('2020-01-01'),
        canvas_w: 640,
        canvas_h: 420,
        capacity: 4
      }
    });
    const zone = await prisma.seatZone.create({
      data: { layout_id: layout.id, name: 'A區', sort_order: 0 }
    });
    const tableA1 = await prisma.seatTable.create({
      data: {
        layout_id: layout.id,
        zone_id: zone.id,
        label: 'A1',
        shape: 'rect',
        arrangement: 'one_side',
        cx: 180,
        cy: 200,
        w: 60,
        h: 160,
        sort_order: 0
      }
    });
    const tableA2 = await prisma.seatTable.create({
      data: {
        layout_id: layout.id,
        zone_id: zone.id,
        label: 'A2',
        shape: 'rect',
        arrangement: 'one_side',
        cx: 420,
        cy: 200,
        w: 60,
        h: 160,
        sort_order: 1
      }
    });
    await prisma.seat.createMany({
      data: [
        { layout_id: layout.id, table_id: tableA1.id, zone_id: zone.id, code: 'A1-1', lx: 40, ly: -35, side: 'R', side_mode: 'auto', is_active: true, sort_order: 0 },
        { layout_id: layout.id, table_id: tableA1.id, zone_id: zone.id, code: 'A1-2', lx: 40, ly: 35, side: 'R', side_mode: 'auto', is_active: true, sort_order: 1 },
        { layout_id: layout.id, table_id: tableA2.id, zone_id: zone.id, code: 'A2-1', lx: 40, ly: -35, side: 'R', side_mode: 'auto', is_active: true, sort_order: 0 },
        { layout_id: layout.id, table_id: tableA2.id, zone_id: zone.id, code: 'A2-2', lx: 40, ly: 35, side: 'R', side_mode: 'auto', is_active: true, sort_order: 1 }
      ]
    });

    await prisma.dailySetting.deleteMany({ where: { date: todayDate } });
    await prisma.dailySetting.create({
      data: {
        date: todayDate,
        allow_unlimited: true,
        hourly_price: 200,
        unlimited_price: 600
      }
    });

    await prisma.session.deleteMany({ where: { session_date: todayDate } });
    s14 = await prisma.session.create({ data: { session_date: todayDate, start_time: '14:00', end_time: '15:00', max_capacity: 10 } });
    s15 = await prisma.session.create({ data: { session_date: todayDate, start_time: '15:00', end_time: '16:00', max_capacity: 10 } });
    s16 = await prisma.session.create({ data: { session_date: todayDate, start_time: '16:00', end_time: '17:00', max_capacity: 10 } });
    s17 = await prisma.session.create({ data: { session_date: todayDate, start_time: '17:00', end_time: '18:00', max_capacity: 10 } });

    const uPaidStay = await prisma.user.create({
      data: { line_user_id: `r41_e2e_stay_${ts}`, name: '已結未走客', phone: `094121${ts.slice(-4)}` } // check-secrets: fake-data
    });
    const uExtend = await prisma.user.create({
      data: { line_user_id: `r41_e2e_ext_${ts}`, name: '加時待補客', phone: `094122${ts.slice(-4)}` } // check-secrets: fake-data
    });
    createdUserIds.push(uPaidStay.id, uExtend.id);

    const refPaidStay = `R41-E2E-STAY-${ts}`;
    const refExtend = `R41-E2E-EXT-${ts}`;
    const dt1400 = new Date(`${todayStr}T14:00:00+08:00`);

    // Booking 1: Paid Stay on A1-1 (14:00-16:00)
    await prisma.reservation.createMany({
      data: [s14, s15].map(s => ({
        booking_ref: refPaidStay,
        session_id: s.id,
        user_id: uPaidStay.id,
        pax: 1,
        status: 'confirmed',
        attendance: 'checked_in',
        checked_in_at: dt1400,
        assigned_seats: ['A1-1'],
        seat_source: 'staff',
        is_seat_locked: true,
        amount_due: 400
      }))
    });
    await prisma.bookingPerson.create({
      data: {
        booking_ref: refPaidStay,
        person_no: 1,
        seat_code: 'A1-1',
        status: 'active',
        billing_start_at: dt1400,
        timer_started_at: dt1400
      }
    });

    // Booking 2: Paid person on A1-2 ready for ExtendTime -> pending supplement NT$200
    await prisma.reservation.createMany({
      data: [s14, s15].map(s => ({
        booking_ref: refExtend,
        session_id: s.id,
        user_id: uExtend.id,
        pax: 1,
        status: 'confirmed',
        attendance: 'checked_in',
        checked_in_at: dt1400,
        assigned_seats: ['A1-2'],
        seat_source: 'staff',
        is_seat_locked: true,
        billing_status: 'paid',
        is_paid: true,
        paid_persons: 1,
        amount_due: 400,
        amount_received: 400
      }))
    });
    await prisma.bookingPerson.create({
      data: {
        booking_ref: refExtend,
        person_no: 1,
        seat_code: 'A1-2',
        status: 'active',
        billing_start_at: dt1400,
        timer_started_at: dt1400
      }
    });
    await prisma.payment.create({
      data: {
        payment_no: `PAY-R41E2E-${ts}`,
        batch_no: `BAT-R41E2E-${ts}`,
        booking_ref: refExtend,
        kind: 'charge',
        status: 'valid',
        method: 'cash',
        amount: 400,
        person_nos: [1],
        staff_name: 'R41E2E',
        device_label: 'POS',
        breakdown_json: {
          persons: [{ person_no: 1, entry: { amount: 400 }, total: 400 }]
        }
      }
    });

    const browser = await chromium.launch({ headless: HEADLESS });
    const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
    const page = await context.newPage();

    let mockNowIso = `${todayStr}T15:30:00+08:00`;

    page.on('pageerror', (err) => console.error('[pageerror]', err));
    page.on('console', (msg) => {
      if (msg.type() === 'error') console.error('[console.error]', msg.text());
    });

    try {
      await page.clock.install({ time: new Date(mockNowIso) });
      await page.route('**/api/floor/live*', async (route) => {
        const reqUrl = new URL(route.request().url());
        reqUrl.searchParams.set('now', mockNowIso);
        const response = await route.fetch({ url: reqUrl.toString() });
        if (response.status() === 200) {
          const data = await response.json();
          data.server_now = mockNowIso;
          await route.fulfill({ response, json: data });
        } else {
          await route.fulfill({ response });
        }
      });
      await page.route('**/api/floor/*/check-in', async (route) => {
        const req = route.request();
        if (req.method() === 'POST') {
          let bodyObj = {};
          try {
            bodyObj = JSON.parse(req.postData() || '{}');
          } catch (_) {
            bodyObj = {};
          }
          bodyObj.now = mockNowIso;
          await route.continue({ postData: JSON.stringify(bodyObj) });
          return;
        }
        await route.continue();
      });

      await adminLogin(page);
      await page.goto(`${BASE_URL}/admin/seating`, { waitUntil: 'networkidle' });
      await page.waitForTimeout(400);

      // SHOT 1: Checkout -> click 客人還沒走 -> advance clock past 16:00 -> seat stays 已結清 (peach) -> 離場 -> 空位
      await page.locator('button[data-testid="tab-list"]:visible').first().click();
      await page.waitForTimeout(250);
      await page.locator(`[data-booking-ref="${refPaidStay}"] button:has-text("結帳")`).first().click();

      const collectOpenBtn = page.locator('[data-testid="workbench-collect-btn"]:visible').first();
      await collectOpenBtn.waitFor({ state: 'visible', timeout: 8000 });
      await collectOpenBtn.click();

      const cashInput = page.locator('[data-testid="cashpad-received-input"]:visible').first();
      await cashInput.waitFor({ state: 'visible', timeout: 5000 });
      await cashInput.fill('400');
      const confirmPayBtn = page.locator('button:has-text("確認收款 NT$400"):visible').first();
      await confirmPayBtn.click();

      const stayBtn = page.locator('button:has-text("客人還沒走"):visible').first();
      await stayBtn.waitFor({ state: 'visible', timeout: 8000 });
      await stayBtn.click();
      await page.waitForTimeout(400);

      // Advance time past 16:00
      mockNowIso = `${todayStr}T16:10:00+08:00`;
      await page.clock.setFixedTime(new Date(mockNowIso));
      await page.goto(`${BASE_URL}/admin/seating`, { waitUntil: 'networkidle' });
      await page.waitForTimeout(400);
      await page.locator('button[data-testid="tab-floor"]:visible').first().click();
      await page.waitForTimeout(300);

      // Verify seat A1-1 still shows orange 已結清 on floor plan
      const a11Tile = page.locator('button[data-seat-code="A1-1"]:visible, [data-seat-code="A1-1"]:visible').first();
      await a11Tile.waitFor({ state: 'visible', timeout: 8000 });
      const a11Text = await a11Tile.innerText();
      assert.ok(a11Text.includes('已結清'), `Expected A1-1 to still show 已結清 after 16:00, got: ${a11Text}`);

      const shot1 = path.join(SCREENSHOT_DIR, 'round41_shot1_paid_seated.png');
      await page.screenshot({ path: shot1 });
      console.log(`Saved Shot 1: ${shot1}`);

      // Click A1-1 -> click 離場 -> seat frees to 空位
      await a11Tile.click();
      const leaveSeatBtn = page.locator('[data-testid="seat-panel-leave-btn"]');
      await leaveSeatBtn.waitFor({ state: 'visible', timeout: 5000 });
      await leaveSeatBtn.click();
      await page.waitForTimeout(500);
      const a11After = await a11Tile.innerText();
      assert.ok(a11After.includes('空位'), `Expected A1-1 to become 空位 after leave, got: ${a11After}`);

      // SHOT 2: Extend time 1h on paid booking -> pending supplement NT$200 in CheckoutWorkbench
      await page.locator('button[data-testid="tab-list"]:visible').first().click();
      await page.waitForTimeout(250);
      await page.locator(`[data-booking-ref="${refExtend}"]`).first().click();
      await page.locator('[data-testid="extend-time-btn"]').waitFor({ state: 'visible', timeout: 5000 });
      await page.locator('[data-testid="extend-time-btn"]').click();
      await page.locator('[data-testid="confirm-extend-btn"]').waitFor({ state: 'visible', timeout: 5000 });
      await page.locator('text=16:00 - 17:00').first().click();
      await page.locator('[data-testid="confirm-extend-btn"]').click();
      await page.locator('text=加時成功').waitFor({ state: 'visible', timeout: 8000 });
      await page.keyboard.press('Escape');
      await page.waitForTimeout(300);

      await page.locator(`[data-booking-ref="${refExtend}"] button:has-text("結帳"):visible`).first().click();
      await page.locator('[data-testid="supplement-btn-1"]').waitFor({ state: 'visible', timeout: 8000 });
      await page.locator('span:has-text("待補收 NT$200"):visible').first().waitFor({ state: 'visible', timeout: 5000 });
      const shot2 = path.join(SCREENSHOT_DIR, 'round41_shot2_extend_supplement.png');
      await page.screenshot({ path: shot2 });
      console.log(`Saved Shot 2: ${shot2}`);

      await page.keyboard.press('Escape');
      await page.waitForTimeout(300);

      // Clear refPaidStay and refExtend so A1-1, A1-2 and A2-1, A2-2 are all free for Shot 3 & Shot 4
      await prisma.payment.deleteMany({ where: { booking_ref: { in: [refPaidStay, refExtend] } } });
      await prisma.bookingPerson.deleteMany({ where: { booking_ref: { in: [refPaidStay, refExtend] } } });
      await prisma.reservation.deleteMany({ where: { booking_ref: { in: [refPaidStay, refExtend] } } });

      // SHOT 3: 14:40 Walk-in hold -> ForceAdd hint -> Check-in -> TableCard shows 延伸佔位到 16:40 & Timeline right end is 16:40
      mockNowIso = `${todayStr}T14:40:00+08:00`;
      await page.clock.setFixedTime(new Date(mockNowIso));
      await page.setViewportSize({ width: 412, height: 915 });
      await page.goto(`${BASE_URL}/admin/seating`, { waitUntil: 'networkidle' });
      await page.waitForTimeout(400);

      await page.locator('button:has-text("加人"):visible').first().click();
      const holdHint = page.locator('[data-testid="walkin-hold-hint"]');
      await holdHint.waitFor({ state: 'visible', timeout: 5000 });
      const hintText = await holdHint.innerText();
      assert.ok(hintText.includes('可使用到 16:40') && hintText.includes('座位保留到 16:40'), `Unexpected ForceAdd hint: ${hintText}`);

      await page.locator('input[placeholder="例如：王先生"]').fill('臨時延伸客');
      await page.locator('button:has-text("下一步：安排座位")').click();

      const checkInConfirmBtn = page.locator('button:has-text("入座並開始計時"), button:has-text("確認帶位")').first();
      await checkInConfirmBtn.waitFor({ state: 'visible', timeout: 5000 });
      await checkInConfirmBtn.click();
      await page.waitForTimeout(600);

      // Switch to floor view (mobile TableCard) and verify "延伸佔位到 16:40"
      await page.locator('button[data-testid="tab-floor"]:visible').first().click();
      await page.locator(':text("延伸佔位到 16:40"):visible').first().waitFor({ state: 'visible', timeout: 8000 });

      // Open Timer details modal and verify right end tick is 16:40
      await page.locator('button[data-testid="tab-list"]:visible').first().click();
      await page.waitForTimeout(250);
      await page.locator(':text("臨時延伸客"):visible').first().click();
      await page.locator('[data-testid="person-timeline-bar-1"]').waitFor({ state: 'visible', timeout: 5000 });
      await page.locator('span:has-text("16:40"):visible').first().waitFor({ state: 'visible', timeout: 5000 });

      const shot3 = path.join(SCREENSHOT_DIR, 'round41_shot3_walkin_hold.png');
      await page.screenshot({ path: shot3 });
      console.log(`Saved Shot 3: ${shot3}`);

      // SHOT 4: "新的一組坐這桌 · 空 2 位" on Table A2 preselects A2-1 & A2-2 into CheckInPanel
      await page.keyboard.press('Escape');
      await page.waitForTimeout(300);
      await page.locator('button[data-testid="tab-floor"]:visible').first().click();
      await page.waitForTimeout(300);
      await page.locator(`[data-testid="table-title-btn-${tableA2.id}"]:visible`).first().click();
      const forceAddTableBtn = page.locator('[data-testid="force-add-table-btn"]');
      await forceAddTableBtn.waitFor({ state: 'visible', timeout: 5000 });
      assert.ok((await forceAddTableBtn.innerText()).includes('空 2 位'));
      await forceAddTableBtn.click();

      await page.locator('input[placeholder="例如：王先生"]').waitFor({ state: 'visible', timeout: 5000 });
      await page.locator('input[placeholder="例如：王先生"]').fill('預選桌客');
      await page.locator('button:has-text("下一步：安排座位")').click();

      const checkInStartBtn2 = page.locator('button:has-text("入座並開始計時"), button:has-text("確認帶位")').first();
      await checkInStartBtn2.waitFor({ state: 'visible', timeout: 5000 });
      await page.waitForTimeout(300);

      // Verify DB booking created with A2-1 & A2-2 preselected
      const preselectUser = await prisma.user.findFirst({ where: { name: '預選桌客' } });
      assert.ok(preselectUser, 'Expected user 預選桌客 created');
      createdUserIds.push(preselectUser.id);
      const preselectRes = await prisma.reservation.findFirst({ where: { user_id: preselectUser.id } });
      assert.deepEqual(preselectRes.assigned_seats, ['A2-1', 'A2-2']);

      const shot4 = path.join(SCREENSHOT_DIR, 'round41_shot4_table_preselect.png');
      await page.screenshot({ path: shot4 });
      console.log(`Saved Shot 4: ${shot4}`);

      await checkInStartBtn2.click();
      await page.waitForTimeout(500);

      const walkInUser = await prisma.user.findFirst({ where: { name: '臨時延伸客' } });
      if (walkInUser) createdUserIds.push(walkInUser.id);

      console.log('--- Round 41 Seat Time & Extend Playwright Test PASSED ---');
    } finally {
      await browser.close();
    }
  } finally {
    await cleanOperationalData(prisma);
    await prisma.dailySetting.deleteMany({ where: { date: todayDate } }).catch(() => {});
    for (const s of [s14, s15, s16, s17]) {
      if (s) await prisma.session.deleteMany({ where: { id: s.id } }).catch(() => {});
    }
    if (createdUserIds.length > 0) {
      await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } }).catch(() => {});
    }
    if (layout) {
      await prisma.seatLayout.delete({ where: { id: layout.id } }).catch(() => {});
    }
    if (prevPublishedIds.length > 0) {
      await prisma.seatLayout.updateMany({
        where: { id: { in: prevPublishedIds } },
        data: { status: 'published' }
      }).catch(() => {});
    }
    await prisma.$disconnect();
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
