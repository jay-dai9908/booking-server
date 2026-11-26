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
  console.log('--- Starting Round 49 Booking Flow E2E (Items 1, 2, 4) ---');
  await ensureFreshDbSeeded(prisma);
  await cleanOperationalData(prisma);

  const runId = Date.now().toString().slice(-6);
  const todayStr = toTaipeiDateString(new Date());
  const d1Str = addDaysYmd(todayStr, 1);
  const d2Str = addDaysYmd(todayStr, 2);
  const d3Str = addDaysYmd(todayStr, 3);
  const d1Date = dateOnly(d1Str);
  const d2Date = dateOnly(d2Str);
  const d3Date = dateOnly(d3Str);
  const [, d1M, d1D] = d1Str.split('-').map(Number);
  const [, d3M, d3D] = d3Str.split('-').map(Number);

  const createdSessionIds = [];
  const createdDates = [d1Date, d2Date, d3Date];
  let customer = null;
  let adminUser = null;
  let passPlan = null;
  const origGlobal = await prisma.globalSetting.findUnique({ where: { id: 1 } });

  const launchOptions = { headless: HEADLESS };
  if (process.env.PLAYWRIGHT_CHROMIUM_PATH) {
    launchOptions.executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH;
  }
  const browser = await chromium.launch(launchOptions);

  try {
    const adminPass = `R49Admin_${runId}!`;
    adminUser = await prisma.adminUser.create({
      data: {
        name: `R49設定測試_${runId}`,
        password: adminPass,
        role: 'superadmin',
        permissions: ['all'],
        is_active: true
      }
    });

    customer = await prisma.user.create({
      data: {
        name: 'R49顧客流程客',
        phone: `0987${runId}`,
        line_user_id: `r49_flow_cust_${runId}`
      }
    });
    const custToken = jwt.sign(
      { id: customer.id, typ: 'customer', line_user_id: customer.line_user_id, role: 'customer', name: customer.name },
      JWT_SECRET,
      { expiresIn: '2h' }
    );

    const ensureDaySessions = async (dateObj, hours) => {
      const list = [];
      for (const h of hours) {
        const start_time = `${String(h).padStart(2, '0')}:00`;
        const end_time = `${String(h + 1).padStart(2, '0')}:00`;
        let s = await prisma.session.findUnique({ where: { session_date_start_time: { session_date: dateObj, start_time } } });
        if (!s) {
          s = await prisma.session.create({ data: { session_date: dateObj, start_time, end_time, max_capacity: 16 } });
          createdSessionIds.push(s.id);
        } else if (s.closed_at) {
          await prisma.session.update({ where: { id: s.id }, data: { closed_at: null, closed_by: null } });
        }
        list.push(s);
      }
      return list;
    };

    const d1Sessions = await ensureDaySessions(d1Date, [10, 11, 12, 13, 14, 15, 16, 17]);
    await ensureDaySessions(d2Date, [13, 14, 15, 16]);
    await ensureDaySessions(d3Date, [13, 14, 15, 16]);

    await prisma.dailySetting.deleteMany({ where: { date: { in: createdDates } } });
    await prisma.dailySetting.create({
      data: { date: d3Date, is_self_service: true, self_allow_hourly: true, self_allow_equipment: false }
    });

    passPlan = await prisma.passPlan.create({
      data: {
        code: `r49_plan_${runId}`,
        name: 'R49測試卡券',
        pass_type: 'PUNCH_CARD',
        price: 1000,
        total_quota: 5,
        checkout_effect: 'entry_full',
        day_restriction: 'ALL',
        is_active: true
      }
    });
    await prisma.userPass.create({
      data: {
        pass_code: `PASS-R49-${runId}`,
        user_id: customer.id,
        plan_id: passPlan.id,
        plan_name_snapshot: passPlan.name,
        pass_type: 'PUNCH_CARD',
        total_quota: 5,
        remaining_quota: 5,
        status: 'ACTIVE',
        payment_status: 'active',
        day_restriction: 'ALL'
      }
    });

    // --- 1. Admin Settings persistence (Shot 1) ---
    const adminCtx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const admPage = await adminCtx.newPage();
    await admPage.goto(`${BASE_URL}/admin/login`, { waitUntil: 'networkidle' });
    await admPage.locator('input[type="password"]').fill(adminPass);
    await admPage.locator('button[type="submit"]').click();
    await admPage.waitForURL((url) => url.pathname.includes('/admin/') && !url.pathname.includes('/admin/login'), { timeout: 15000 });
    await admPage.waitForLoadState('networkidle');
    await admPage.waitForTimeout(350);
    await admPage.goto(`${BASE_URL}/admin/settings`, { waitUntil: 'networkidle' });

    const maxActInput = admPage.locator('[data-testid="max-active-bookings-input"]');
    const maxPaxInput = admPage.locator('[data-testid="max-pax-per-booking-input"]');
    await maxActInput.waitFor({ state: 'visible', timeout: 10000 });
    await maxActInput.fill('2');
    await maxPaxInput.fill('4');
    await admPage.locator('[data-testid="save-business-hours-btn"]').click();
    await admPage.waitForTimeout(800);
    await admPage.reload({ waitUntil: 'networkidle' });
    assert.equal(await maxActInput.inputValue(), '2');
    assert.equal(await maxPaxInput.inputValue(), '4');
    await maxPaxInput.scrollIntoViewIfNeeded();
    await admPage.screenshot({ path: path.join(SCREENSHOT_DIR, 'round49_shot1_admin_limits.png'), fullPage: false });
    console.log('Shot 1 saved: admin booking limits.');
    await adminCtx.close();

    // --- 2. Customer context ---
    const custCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
    await custCtx.addInitScript((tok) => {
      try {
        sessionStorage.setItem('shiguang_auth_token', tok);
        if (!sessionStorage.getItem('__r49_flow_init')) {
          sessionStorage.setItem('__r49_flow_init', '1');
          sessionStorage.removeItem('shiguang_booking_draft');
          localStorage.removeItem('shiguang_customer_settings_v2');
        }
      } catch {}
    }, custToken);
    const page = await custCtx.newPage();
    page.on('pageerror', (err) => console.error('[PAGEERROR]', err));

    // Item 1: max_pax_per_booking = 4 + LINE URL -> verify text & link, then cleared LINE URL
    await prisma.globalSetting.update({
      where: { id: 1 },
      data: {
        max_pax_per_booking: 4,
        max_active_bookings_per_user: 5,
        line_button_url: 'https://line.example.com/test',
        official_line_url: 'https://line.example.com/test'
      }
    });

    await page.goto(`${BASE_URL}/booking`, { waitUntil: 'networkidle' });
    await page.locator(`button[aria-label*="${d1M} 月 ${d1D} 日"]`).first().click();
    await page.locator('button:has-text("10:00")').first().click();
    await page.locator('button:has-text("下一步")').click();
    await page.waitForURL('**/booking?step=2', { timeout: 8000 });

    const plusBtn = page.locator('button[aria-label="增加人數"]');
    await plusBtn.click(); // 2
    await plusBtn.click(); // 3
    await plusBtn.click(); // 4
    assert.equal(await plusBtn.isDisabled(), true, 'Plus button must disable at max_pax_per_booking=4');
    const noticeBox = page.locator('[data-testid="pax-limit-notice"]');
    await noticeBox.waitFor({ state: 'visible', timeout: 5000 });
    assert.ok((await noticeBox.innerText()).includes('超過 4 人請用 LINE 聯繫我們'));
    const lineHref = await noticeBox.locator('[data-testid="store-contact-line-btn"]').getAttribute('href');
    assert.equal(lineHref, 'https://line.example.com/test');
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'round49_shot2_pax_limit_line.png'), fullPage: true });
    console.log('Shot 2 saved: pax limit + LINE button.');

    // Clear LINE URL -> text stays, LINE button hidden
    await prisma.globalSetting.update({
      where: { id: 1 },
      data: { line_button_url: null, official_line_url: null }
    });
    await page.evaluate(() => localStorage.removeItem('shiguang_customer_settings_v2'));
    await page.reload({ waitUntil: 'networkidle' });
    await noticeBox.waitFor({ state: 'visible', timeout: 8000 });
    assert.ok((await noticeBox.innerText()).includes('超過 4 人請用 LINE 聯繫我們'));
    assert.equal(await noticeBox.locator('[data-testid="store-contact-line-btn"]').count(), 0, 'No LINE button when URL is cleared');

    // Restore LINE URL & set max_active_bookings_per_user = 1 -> Step 3 hits TOO_MANY_ACTIVE_BOOKINGS (Shot 3)
    await prisma.globalSetting.update({
      where: { id: 1 },
      data: {
        max_active_bookings_per_user: 1,
        max_pax_per_booking: 8,
        line_button_url: 'https://line.example.com/test',
        official_line_url: 'https://line.example.com/test'
      }
    });
    await prisma.reservation.create({
      data: {
        booking_ref: `R49-EXIST-${runId}`,
        session_id: d1Sessions[6].id,
        user_id: customer.id,
        pax: 1,
        status: 'confirmed'
      }
    });
    await page.evaluate(() => localStorage.removeItem('shiguang_customer_settings_v2'));
    await page.reload({ waitUntil: 'networkidle' });
    await page.locator('button:has-text("下一步")').click();
    await page.waitForURL('**/booking?step=3', { timeout: 8000 });
    await page.locator('button:has-text("送出預約")').waitFor({ state: 'visible', timeout: 8000 });
    await page.locator('button:has-text("送出預約")').click();
    const errBox = page.locator('[data-testid="booking-limit-error-box"]');
    await errBox.waitFor({ state: 'visible', timeout: 8000 });
    assert.ok((await errBox.innerText()).includes('已有 1 筆'));
    assert.equal(await errBox.locator('[data-testid="store-contact-line-btn"]').getAttribute('href'), 'https://line.example.com/test');
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'round49_shot3_active_booking_limit.png'), fullPage: true });
    console.log('Shot 3 saved: TOO_MANY_ACTIVE_BOOKINGS error box + LINE button.');

    // --- 3. Item 2 SplitSeatSheet Playwright route interception (Shots 4, 5, 6) ---
    await prisma.globalSetting.update({ where: { id: 1 }, data: { max_active_bookings_per_user: 0 } });
    await prisma.reservation.deleteMany({ where: { user_id: customer.id } });

    let mockSplitPayload = null;
    await page.route('**/api/reservations', async (route) => {
      if (route.request().method() === 'POST' && mockSplitPayload) {
        return route.fulfill({
          status: 409,
          contentType: 'application/json',
          body: JSON.stringify(mockSplitPayload)
        });
      }
      return route.continue();
    });

    // Shot 4: Normal day 1 pax no_seat -> must NOT contain 同行
    mockSplitPayload = {
      code: 'SPLIT_REQUIRED',
      split_kind: 'no_seat',
      pax: 1,
      is_self_service: false,
      error: '連續座位不足，同行者將被拆散。是否確認預約？'
    };
    await page.evaluate(() => sessionStorage.removeItem('shiguang_booking_draft'));
    await page.goto(`${BASE_URL}/booking`, { waitUntil: 'networkidle' });
    await page.locator(`button[aria-label*="${d1M} 月 ${d1D} 日"]`).first().click();
    await page.locator('button:has-text("10:00")').first().click();
    await page.locator('button:has-text("下一步")').click();
    await page.waitForURL('**/booking?step=2', { timeout: 8000 });
    await page.locator('button:has-text("下一步")').click();
    await page.waitForURL('**/booking?step=3', { timeout: 8000 });
    await page.locator('button:has-text("送出預約")').click();
    await page.locator('text=這段時間座位已排滿').waitFor({ state: 'visible', timeout: 8000 });
    const dialog1Text = await page.locator('[role="dialog"]').innerText();
    assert.equal(dialog1Text.includes('同行'), false, '1 pax sheet must NOT mention 同行');
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'round49_shot4_split_normal_1pax.png'), fullPage: false });
    console.log('Shot 4 saved: normal 1 pax no_seat sheet.');

    // Shot 6: Normal day 3 pax split -> must contain 分桌
    await page.locator('button:has-text("回去換時段")').click();
    await page.waitForURL('**/booking?step=1', { timeout: 8000 });
    await page.locator('button:has-text("下一步")').click();
    await page.waitForURL('**/booking?step=2', { timeout: 8000 });
    await page.locator('button[aria-label="增加人數"]').click(); // 2
    await page.locator('button[aria-label="增加人數"]').click(); // 3
    await page.locator('button:has-text("下一步")').click();
    await page.waitForURL('**/booking?step=3', { timeout: 8000 });
    mockSplitPayload = {
      code: 'SPLIT_REQUIRED',
      split_kind: 'split',
      pax: 3,
      is_self_service: false,
      error: '連續座位不足，同行者將被拆散。是否確認預約？'
    };
    await page.locator('button:has-text("送出預約")').click();
    await page.locator('text=分桌').waitFor({ state: 'visible', timeout: 8000 });
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'round49_shot6_split_normal_3pax.png'), fullPage: false });
    console.log('Shot 6 saved: normal 3 pax split sheet.');

    // Shot 5: Self-service day -> has 請自由選擇空位, must NOT contain 現場人員
    await page.evaluate(() => sessionStorage.removeItem('shiguang_booking_draft'));
    await page.goto(`${BASE_URL}/booking`, { waitUntil: 'networkidle' });
    await page.locator(`button[aria-label*="${d3M} 月 ${d3D} 日"]`).first().click();
    await page.locator('[data-testid="self-service-info-card"]').waitFor({ state: 'visible', timeout: 8000 });
    await page.locator('button:has-text("13:00")').first().click();
    await page.locator('button:has-text("下一步")').click();
    await page.waitForURL('**/booking?step=2', { timeout: 8000 });
    await page.locator('button:has-text("下一步")').click();
    await page.waitForURL('**/booking?step=3', { timeout: 8000 });
    await page.locator('button[aria-label*="增加R49測試卡券"]').first().click();
    await page.locator('[data-testid="self-ack-checkbox"]').check();
    mockSplitPayload = {
      code: 'SPLIT_REQUIRED',
      split_kind: 'no_seat',
      pax: 1,
      is_self_service: true,
      error: '連續座位不足，同行者將被拆散。是否確認預約？'
    };
    await page.locator('button:has-text("送出預約")').click();
    await page.locator('text=請自由選擇空位').waitFor({ state: 'visible', timeout: 8000 });
    const dialogSelfText = await page.locator('[role="dialog"]').innerText();
    assert.equal(dialogSelfText.includes('現場人員'), false, 'Self-service split sheet must NOT mention 現場人員');
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'round49_shot5_split_self.png'), fullPage: false });
    console.log('Shot 5 saved: self-service split sheet.');

    // --- 4. Item 4 Board discount disabled -> 4h board shows no 買三送一 on StepDone & HistoryPage (Shot 10) ---
    mockSplitPayload = null;
    await page.unroute('**/api/reservations');
    await prisma.globalSetting.update({
      where: { id: 1 },
      data: { equipment_discount_enabled: false, equipment_discount2_enabled: false }
    });
    await page.evaluate(() => {
      sessionStorage.removeItem('shiguang_booking_draft');
      localStorage.removeItem('shiguang_customer_settings_v2');
    });
    await page.goto(`${BASE_URL}/booking`, { waitUntil: 'networkidle' });
    await page.locator(`button[aria-label*="${d1M} 月 ${d1D} 日"]`).first().click();
    await page.locator('button[aria-label*="10:00 到 11:00"]').first().click();
    await page.locator('button[aria-label*="13:00 到 14:00"]').first().click(); // 10:00..14:00 = 4 hours
    await page.locator('button:has-text("下一步")').click();
    await page.waitForURL('**/booking?step=2', { timeout: 8000 });

    const addSmallBtn = page.locator('button[aria-label*="增加小板"]').first();
    await addSmallBtn.waitFor({ state: 'visible', timeout: 8000 });
    await addSmallBtn.click();
    await page.locator('button:has-text("下一步")').click();
    await page.waitForURL('**/booking?step=3', { timeout: 8000 });
    await page.locator('button:has-text("送出預約")').click();
    await page.waitForURL('**/booking?step=done**', { timeout: 12000 });
    const summaryEl = page.locator('[data-testid="booking-summary-text"]');
    await summaryEl.waitFor({ state: 'visible', timeout: 8000 });
    const summaryText = await summaryEl.innerText();
    console.log('StepDone summary for Shot 10:', summaryText);
    assert.ok(summaryText.includes('4 小時'), `Expected 4 小時 in summary, got: ${summaryText}`);
    const doneBody = await page.locator('body').innerText();
    assert.equal(doneBody.includes('買三送一'), false, 'StepDone must NOT show 買三送一 when discount is disabled');
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'round49_shot10_done_discount_off.png'), fullPage: true });
    console.log('Shot 10 saved: StepDone with board discount disabled.');

    await page.goto(`${BASE_URL}/history?tab=bookings`, { waitUntil: 'networkidle' });
    await page.locator('text=4 小時').first().waitFor({ state: 'visible', timeout: 8000 });
    const histBody = await page.locator('body').innerText();
    assert.equal(histBody.includes('買三送一'), false, 'HistoryPage must NOT show 買三送一 when discount is disabled');

    await custCtx.close();
    console.log('Round 49 Booking Flow E2E PASSED!');
  } finally {
    await browser.close();
    await cleanOperationalData(prisma);
    if (createdSessionIds.length > 0) {
      await prisma.session.deleteMany({ where: { id: { in: createdSessionIds } } }).catch(() => {});
    }
    if (createdDates.length > 0) {
      await prisma.dailySetting.deleteMany({ where: { date: { in: createdDates } } }).catch(() => {});
    }
    if (passPlan) await prisma.passPlan.deleteMany({ where: { id: passPlan.id } }).catch(() => {});
    if (customer) await prisma.user.deleteMany({ where: { id: customer.id } }).catch(() => {});
    if (adminUser) await prisma.adminUser.deleteMany({ where: { id: adminUser.id } }).catch(() => {});
    if (origGlobal) {
      await prisma.globalSetting.update({
        where: { id: 1 },
        data: {
          max_active_bookings_per_user: origGlobal.max_active_bookings_per_user,
          max_pax_per_booking: origGlobal.max_pax_per_booking,
          line_button_url: origGlobal.line_button_url,
          official_line_url: origGlobal.official_line_url,
          equipment_discount_enabled: origGlobal.equipment_discount_enabled,
          equipment_discount2_enabled: origGlobal.equipment_discount2_enabled,
          weekday_hourly_price: origGlobal.weekday_hourly_price,
          weekday_unlimited_price: origGlobal.weekday_unlimited_price,
          weekend_hourly_price: origGlobal.weekend_hourly_price,
          weekend_unlimited_price: origGlobal.weekend_unlimited_price,
          business_hours_json: origGlobal.business_hours_json,
          default_session_capacity: origGlobal.default_session_capacity
        }
      }).catch(() => {});
    }
    await prisma.$disconnect();
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
