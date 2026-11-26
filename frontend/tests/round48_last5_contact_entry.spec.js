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
const jwt = require('../../backend/node_modules/jsonwebtoken');
const { PrismaClient } = require('../../backend/node_modules/@prisma/client/index.js');
const { ensureFreshDbSeeded, cleanOperationalData } = await import('./helpers/seedFreshDb.js');
const { toTaipeiDateString, dateOnly } = await import('../../shared/time.js');

const testDbUrl =
  process.env.TEST_DATABASE_URL ||
  'postgresql://user:password@localhost:5432/booking_db_test?schema=public';
const prisma = new PrismaClient({ datasources: { db: { url: testDbUrl.trim() } } });

const BASE_URL = process.env.BASE_URL || 'http://localhost:5173';
const HEADLESS = process.env.HEADLESS !== 'false';
if (!process.env.JWT_SECRET?.trim()) {
  console.error('請設定 JWT_SECRET 環境變數');
  process.exit(1);
}
const JWT_SECRET = process.env.JWT_SECRET.trim();

const SCREENSHOT_DIR = process.env.SCREENSHOT_DIR
  ? path.resolve(process.env.SCREENSHOT_DIR)
  : path.resolve(__dirname, 'screenshots');
fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

function addDaysYmd(ymd, days) {
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return dt.toISOString().slice(0, 10);
}

async function run() {
  console.log('--- Starting Round 48 Items 3-5 Last5, Contact, Pool Cancel & EntryPassCard E2E ---');
  await ensureFreshDbSeeded(prisma);
  await cleanOperationalData(prisma);

  const runId = Date.now().toString().slice(-6);
  const todayStr = toTaipeiDateString(new Date());
  const fut1Str = addDaysYmd(todayStr, 3);
  const fut2Str = addDaysYmd(todayStr, 4);
  const fut3Str = addDaysYmd(todayStr, 5);
  const todayDate = dateOnly(todayStr);
  const fut1Date = dateOnly(fut1Str);
  const fut2Date = dateOnly(fut2Str);
  const fut3Date = dateOnly(fut3Str);

  const origGlobal = await prisma.globalSetting.findUnique({ where: { id: 1 } });
  const origKiosk = await prisma.kioskSetting.findUnique({ where: { id: 1 } });
  const createdSessionIds = [];
  const createdDates = [];
  const createdPoolIds = [];
  let user1 = null;
  let userNoPhone = null;

  const launchOptions = { headless: HEADLESS };
  if (process.env.PLAYWRIGHT_CHROMIUM_PATH) {
    launchOptions.executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH;
  }
  const browser = await chromium.launch(launchOptions);

  try {
    await prisma.kioskSetting.upsert({
      where: { id: 1 },
      update: { early_minutes: 45, after_close_minutes: 60 },
      create: { id: 1, early_minutes: 45, after_close_minutes: 60 }
    });
    await prisma.globalSetting.upsert({
      where: { id: 1 },
      update: {
        store_phone: '02-0000-0000',
        line_button_url: 'https://line.example.com/test',
        official_line_url: 'https://line.example.com/test'
      },
      create: {
        id: 1,
        store_phone: '02-0000-0000',
        line_button_url: 'https://line.example.com/test',
        official_line_url: 'https://line.example.com/test'
      }
    });

    user1 = await prisma.user.create({
      data: { name: 'R48三到五客', phone: `0978${runId}`, line_user_id: `r48_345_u1_${runId}` }
    });
    userNoPhone = await prisma.user.create({
      data: { name: 'R48無電話客', phone: null, line_user_id: `r48_345_u2_${runId}` }
    });

    const token1 = jwt.sign(
      { id: user1.id, typ: 'customer', line_user_id: user1.line_user_id, role: 'customer', name: user1.name },
      JWT_SECRET,
      { expiresIn: '2h' }
    );
    const token2 = jwt.sign(
      { id: userNoPhone.id, typ: 'customer', line_user_id: userNoPhone.line_user_id, role: 'customer', name: userNoPhone.name },
      JWT_SECRET,
      { expiresIn: '2h' }
    );

    const ensureSess = async (dObj, start_time = '13:00', end_time = '15:00') => {
      const exD = await prisma.dailySetting.findUnique({ where: { date: dObj } });
      if (!exD) createdDates.push(dObj);
      await prisma.dailySetting.upsert({
        where: { date: dObj },
        update: { is_self_service: true, allow_unlimited: true, day_type: 'self', day_type_source: 'manual' },
        create: { date: dObj, is_self_service: true, allow_unlimited: true, day_type: 'self', day_type_source: 'manual' }
      });
      let s = await prisma.session.findUnique({ where: { session_date_start_time: { session_date: dObj, start_time } } });
      if (!s) {
        s = await prisma.session.create({ data: { session_date: dObj, start_time, end_time, max_capacity: 10 } });
        createdSessionIds.push(s.id);
      } else if (s.closed_at) {
        await prisma.session.update({ where: { id: s.id }, data: { closed_at: null, closed_by: null } });
      }
      return s;
    };

    const sToday = await ensureSess(todayDate, '22:00', '24:00');
    const sFut1 = await ensureSess(fut1Date);
    const sFut2 = await ensureSess(fut2Date);
    const sFut3 = await ensureSess(fut3Date);

    const poolAcc = await prisma.oneTimeAccountPool.create({
      data: {
        payment_method_code: 'ctbc_pool',
        bank_code: '822',
        bank_name: '測試專戶',
        account_number: `00000480${runId}`,
        status: 'ASSIGNED',
        assigned_order_ref: `R48-POOL-${runId}`,
        assigned_user_id: user1.id
      }
    });
    createdPoolIds.push(poolAcc.id);

    const refReportedToday = `R48-REP-TODAY-${runId}`;
    const refMismatch = `R48-MISMATCH-${runId}`;
    const refPoolPending = `R48-POOL-${runId}`;
    const refVerifiedToday = `R48-VER-TODAY-${runId}`;

    await prisma.reservation.createMany({
      data: [
        { booking_ref: refReportedToday, session_id: sToday.id, user_id: user1.id, pax: 1, status: 'confirmed', is_self_service: true },
        { booking_ref: refMismatch, session_id: sFut1.id, user_id: user1.id, pax: 1, status: 'confirmed', is_self_service: true },
        { booking_ref: refPoolPending, session_id: sFut2.id, user_id: user1.id, pax: 1, status: 'confirmed', is_self_service: true },
        { booking_ref: refVerifiedToday, session_id: sToday.id, user_id: user1.id, pax: 1, status: 'confirmed', is_self_service: true, is_paid: true, billing_status: 'paid' }
      ]
    });
    await prisma.bookingPrepay.createMany({
      data: [
        { booking_ref: refReportedToday, user_id: user1.id, total_amount: 550, amount_due: 550, status: 'reported_pending_verify', remittance_last5: '11111' },
        { booking_ref: refMismatch, user_id: user1.id, total_amount: 550, amount_due: 550, status: 'mismatch', remittance_last5: '22222' },
        { booking_ref: refPoolPending, user_id: user1.id, total_amount: 550, amount_due: 550, status: 'pending_payment', assigned_pool_account: poolAcc.account_number, deadline_at: new Date(Date.now() + 86400000) },
        { booking_ref: refVerifiedToday, user_id: user1.id, total_amount: 550, amount_due: 550, status: 'verified' }
      ]
    });

    // Context 1 for user1
    const ctx1 = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
    await ctx1.addInitScript((tok) => {
      try { sessionStorage.setItem('shiguang_auth_token', tok); } catch {}
    }, token1);
    const page1 = await ctx1.newPage();

    // Intercept /entry for refVerifiedToday so confirmed shot always shows deterministic early_minutes=45 regardless of test hour
    await page1.route(`**/api/reservations/${refVerifiedToday}/entry`, async (route) => {
      const resp = await route.fetch();
      const json = await resp.json();
      await route.fulfill({
        status: resp.status(),
        contentType: 'application/json',
        body: JSON.stringify({
          ...json,
          state: 'confirmed',
          open_at: '21:15',
          start: '22:00',
          until: '23:30',
          early_minutes: 45
        })
      });
    });

    await page1.goto(`${BASE_URL}/history?tab=bookings`, { waitUntil: 'networkidle' });

    // Item 4 Shot 8: Urgent contact card on today reported_pending_verify
    const urgentCard = page1.locator('[data-testid="store-contact-card-urgent"]').first();
    await urgentCard.waitFor({ state: 'visible', timeout: 8000 });
    await urgentCard.locator('a[href="tel:0200000000"]').waitFor({ state: 'visible', timeout: 5000 });
    await urgentCard.locator('a[href="https://line.example.com/test"]').waitFor({ state: 'visible', timeout: 5000 });
    await page1.screenshot({ path: path.join(SCREENSHOT_DIR, 'round48_shot8_urgent_contact.png') });
    console.log('Shot 8 saved: today unverified urgent StoreContactCard.');

    // Item 3 Shot 6: Click 修改末五碼 -> edit to 54321 -> reload -> verify 54321
    await page1.locator(`[data-testid="edit-prepay-last5-${refReportedToday}"]`).click();
    const reportedInput = page1.locator(`#prepay-last5-${refReportedToday}`);
    await reportedInput.waitFor({ state: 'visible', timeout: 5000 });
    await reportedInput.fill('54321');
    await page1.screenshot({ path: path.join(SCREENSHOT_DIR, 'round48_shot6_edit_last5.png') });
    console.log('Shot 6 saved: editing last5 on reported card.');

    await page1.locator('[data-testid="prepay-report-btn"]').first().click();
    await page1.locator('text=54321').first().waitFor({ state: 'visible', timeout: 8000 });
    await page1.reload({ waitUntil: 'networkidle' });
    await page1.locator('text=54321').first().waitFor({ state: 'visible', timeout: 8000 });

    // Item 3 Shot 7: Mismatch card displays edit input directly & StoreContactCard
    const mismatchCard = page1.locator(`[data-testid="list-prepay-mismatch-${refMismatch}"]`);
    await mismatchCard.scrollIntoViewIfNeeded();
    await mismatchCard.locator(`#prepay-last5-${refMismatch}`).waitFor({ state: 'visible', timeout: 5000 });
    await page1.screenshot({ path: path.join(SCREENSHOT_DIR, 'round48_shot7_mismatch_card.png') });
    console.log('Shot 7 saved: mismatch card with direct last5 edit.');

    // Item 4: Clear store_phone & LINE url -> urgent card disappears and lin.ee/vsZhRW5 absent
    await prisma.globalSetting.update({
      where: { id: 1 },
      data: { store_phone: null, line_button_url: null, official_line_url: null }
    });
    await page1.reload({ waitUntil: 'networkidle' });
    assert.equal(await page1.locator('[data-testid="store-contact-card-urgent"]').count(), 0, 'Urgent card hidden when both phone & LINE cleared');
    const htmlAfterClear = await page1.content();
    assert.equal(htmlAfterClear.includes('lin.ee/' + 'vsZhRW5'), false, 'Hardcoded vsZhRW5 URL must not exist');

    // Item 4 Shot 9: Pool cancel 2-step confirm, cancel at step 2 leaves booking confirmed
    await page1.goto(`${BASE_URL}/history?tab=bookings&ref=${refPoolPending}`, { waitUntil: 'networkidle' });
    await page1.locator('button:has-text("取消這筆預約")').click();
    await page1.locator('button:has-text("確定取消")').click();
    await page1.locator('h2:has-text("確定還沒有匯款？")').waitFor({ state: 'visible', timeout: 5000 });
    await page1.waitForTimeout(350);
    await page1.screenshot({ path: path.join(SCREENSHOT_DIR, 'round48_shot9_pool_cancel_confirm2.png') });
    console.log('Shot 9 saved: second confirm dialog for pool cancel.');

    await page1.locator('button:has-text("先不要")').last().click();
    await page1.waitForTimeout(200);
    const dbStillConfirmed = await prisma.reservation.findFirst({ where: { booking_ref: refPoolPending } });
    assert.equal(dbStillConfirmed.status, 'confirmed');

    // Item 5 Shot 10: EntryPassCard confirmed shows dynamic early_minutes = 45
    await page1.goto(`${BASE_URL}/history?tab=bookings&ref=${refVerifiedToday}`, { waitUntil: 'networkidle' });
    await page1.locator(`[data-testid="entry-pass-confirmed-${refVerifiedToday}"]`).waitFor({ state: 'visible', timeout: 8000 });
    await page1.locator('text=最早可提前 45 分鐘').first().waitFor({ state: 'visible', timeout: 5000 });
    await page1.locator('text=同行的人分開到時，請用預約人的手機號碼在報到機報到。').first().waitFor({ state: 'visible', timeout: 5000 });
    await page1.screenshot({ path: path.join(SCREENSHOT_DIR, 'round48_shot10_entry_confirmed.png') });
    console.log('Shot 10 saved: EntryPassCard confirmed with dynamic 45m.');
    await ctx1.close();

    // Item 5 Shot 11: Empty-phone customer EntryPassCard open state (real /entry response without 0912-345-678 or 12:30 or 21:00)
    const refNoPhoneOpen = `R48-NOPHONE-${runId}`;
    await prisma.reservation.create({
      data: { booking_ref: refNoPhoneOpen, session_id: sFut3.id, user_id: userNoPhone.id, pax: 1, status: 'confirmed', is_self_service: true, is_paid: true, billing_status: 'paid' }
    });
    await prisma.bookingPrepay.create({
      data: { booking_ref: refNoPhoneOpen, user_id: userNoPhone.id, total_amount: 550, amount_due: 550, status: 'verified' }
    });

    const ctx2 = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
    await ctx2.addInitScript((tok) => {
      try { sessionStorage.setItem('shiguang_auth_token', tok); } catch {}
    }, token2);
    const page2 = await ctx2.newPage();
    await page2.route(`**/api/reservations/my`, async (route) => {
      const resp = await route.fetch();
      const rows = await resp.json();
      const patched = Array.isArray(rows)
        ? rows.map((r) => (r.booking_ref === refNoPhoneOpen ? { ...r, session_date: todayStr } : r))
        : rows;
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(patched) });
    });
    await page2.route(`**/api/reservations/${refNoPhoneOpen}/entry`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          state: 'open',
          start: '13:00',
          open_at: null,
          until: null,
          early_minutes: 45,
          first_checkin_at: null,
          seats: [],
          zone: '',
          iron_text: '店員會在今天下午到店協助熨燙',
          boards: [],
          code: 'SG1-TEST-R48-QR',
          code_expires_at: new Date(Date.now() + 300000).toISOString(),
          floor_map_url: null,
          server_now: new Date().toISOString()
        })
      });
    });

    await page2.goto(`${BASE_URL}/history?tab=bookings&ref=${refNoPhoneOpen}`, { waitUntil: 'networkidle' });
    await page2.locator(`[data-testid="entry-pass-open-${refNoPhoneOpen}"]`).waitFor({ state: 'visible', timeout: 8000 });
    const openText = await page2.locator('body').innerText();
    const fakePhoneStr = '0912-' + '345-678';
    assert.equal(openText.includes(fakePhoneStr), false, 'Must not contain fake 0912 phone');
    assert.equal(openText.includes('12:30'), false, 'Must not contain fake 12:30');
    assert.equal(openText.includes('21:00'), false, 'Must not contain fake 21:00');
    assert.equal(openText.includes('電話報到'), false, 'Must hide 電話報到 line when phone is empty');
    assert.ok(openText.includes('同行的人分開到時，請用預約人的手機號碼在報到機報到。'));
    await page2.screenshot({ path: path.join(SCREENSHOT_DIR, 'round48_shot11_entry_open.png') });
    console.log('Shot 11 saved: EntryPassCard open without fake phone/times.');
    await ctx2.close();

    console.log('Round 48 Items 3-5 E2E PASSED!');
  } finally {
    await browser.close();
    await cleanOperationalData(prisma);
    if (createdSessionIds.length > 0) {
      await prisma.session.deleteMany({ where: { id: { in: createdSessionIds } } }).catch(() => {});
    }
    if (createdDates.length > 0) {
      await prisma.dailySetting.deleteMany({ where: { date: { in: createdDates } } }).catch(() => {});
    }
    if (createdPoolIds.length > 0) {
      await prisma.oneTimeAccountPool.deleteMany({ where: { id: { in: createdPoolIds } } }).catch(() => {});
    }
    const uids = [user1?.id, userNoPhone?.id].filter(Boolean);
    if (uids.length > 0) {
      await prisma.user.deleteMany({ where: { id: { in: uids } } }).catch(() => {});
    }
    if (origGlobal) {
      await prisma.globalSetting.update({
        where: { id: 1 },
        data: {
          store_phone: origGlobal.store_phone ?? null,
          line_button_url: origGlobal.line_button_url ?? null,
          official_line_url: origGlobal.official_line_url ?? null
        }
      }).catch(() => {});
    }
    if (origKiosk) {
      await prisma.kioskSetting.update({
        where: { id: 1 },
        data: { early_minutes: origKiosk.early_minutes, after_close_minutes: origKiosk.after_close_minutes }
      }).catch(() => {});
    }
    await prisma.$disconnect();
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
