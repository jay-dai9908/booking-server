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

async function run() {
  console.log('--- Starting Round 43 Settings Persist & Admin UX Playwright Test ---');
  await ensureFreshDbSeeded(prisma);
  await cleanOperationalData(prisma);

  const now = new Date();
  const todayStr = toTaipeiDateString(now);
  const todayDate = dateOnly(todayStr);
  const futureDt = new Date(Date.now() + 10 * 86400000);
  const futureStr = toTaipeiDateString(futureDt);
  const futureDate = dateOnly(futureStr);
  const runId = Date.now().toString().slice(-6);
  const bookingRef = `R43E2E-${runId}`;

  let testUser = null;
  let todaySession = null;
  let origGlobal = null;
  const createdPlanIds = [];

  const launchOptions = { headless: HEADLESS };
  if (process.env.PLAYWRIGHT_CHROMIUM_PATH) {
    launchOptions.executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH;
  }

  const browser = await chromium.launch(launchOptions);
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();

  try {
    await prisma.passPlan.deleteMany({ where: { name: '測試十次卡' } }).catch(() => {});
    origGlobal = await prisma.globalSetting.findUnique({ where: { id: 1 } });
    await prisma.globalSetting.update({
      where: { id: 1 },
      data: {
        board_swap_grace_minutes: 10,
        cash_float_amount: 2000,
        auto_print_receipt: true,
        payment_methods_json: [
          { key: 'cash', label: '現金', enabled: true },
          { key: 'linepay', label: 'LINE Pay', enabled: true },
          { key: 'transfer', label: '銀行轉帳', enabled: true }
        ]
      }
    });
    // Seed future DailySetting D (hourly: 120, unlimited: 600) + today booking for CheckoutWorkbench PayMethodGrid check
    await prisma.dailySetting.upsert({
      where: { date: futureDate },
      update: { hourly_price: 120, unlimited_price: 600, allow_unlimited: true },
      create: { date: futureDate, hourly_price: 120, unlimited_price: 600, allow_unlimited: true }
    });

    testUser = await prisma.user.create({
      data: {
        line_user_id: `r43_e2e_${runId}`,
        name: 'R43結帳測試客',
        phone: '0911222343'
      }
    });

    todaySession = await prisma.session.upsert({
      where: { session_date_start_time: { session_date: todayDate, start_time: '14:00' } },
      update: {},
      create: { session_date: todayDate, start_time: '14:00', end_time: '18:00', max_capacity: 20 }
    });

    await prisma.reservation.create({
      data: {
        booking_ref: bookingRef,
        session_id: todaySession.id,
        user_id: testUser.id,
        pax: 1,
        status: 'confirmed',
        assigned_seats: ['A1-1'],
        attendance: 'checked_in',
        checked_in_at: new Date(),
        checkout_details: {
          version: 2,
          rev: 0,
          split_mode: 'proportional',
          persons: [{ person_no: 1, seat_code: 'A1-1', mode: 'hourly' }],
          order_addons: [],
          order_promos: []
        }
      }
    });
    await prisma.bookingPerson.create({
      data: {
        booking_ref: bookingRef,
        person_no: 1,
        seat_code: 'A1-1',
        status: 'active',
        billing_start_at: new Date(),
        timer_started_at: new Date()
      }
    });

    await adminLogin(page);

    // =====================================================
    // Item 1: Billing/timer/print fields persist after reload
    // =====================================================
    await page.goto(`${BASE_URL}/admin/settings`, { waitUntil: 'networkidle' });
    await page.locator('[data-testid="board-swap-grace-input"]').waitFor({ state: 'visible', timeout: 10000 });

    await page.locator('[data-testid="board-swap-grace-input"]').fill('5');
    await page.locator('[data-testid="cash-float-input"]').fill('3000');
    const autoReceiptCheckbox = page
      .locator('div', { hasText: '完成結帳就列印' })
      .locator('input[type="checkbox"]')
      .first();
    if (await autoReceiptCheckbox.isChecked()) {
      await autoReceiptCheckbox.uncheck();
    }

    await page.locator('[data-testid="save-billing-settings-btn"]').click();
    await page.locator('text=系統設定已成功儲存並立即生效').waitFor({ state: 'visible', timeout: 10000 });

    await page.reload({ waitUntil: 'networkidle' });
    await page.locator('[data-testid="board-swap-grace-input"]').waitFor({ state: 'visible', timeout: 10000 });

    assert.equal(await page.locator('[data-testid="board-swap-grace-input"]').inputValue(), '5');
    assert.equal(await page.locator('[data-testid="cash-float-input"]').inputValue(), '3000');
    const autoReceiptAfterReload = await page
      .locator('div', { hasText: '完成結帳就列印' })
      .locator('input[type="checkbox"]')
      .first()
      .isChecked();
    assert.equal(autoReceiptAfterReload, false);

    await page.locator('[data-testid="checkout-timer-settings-card"]').scrollIntoViewIfNeeded();
    await page.waitForTimeout(200);
    await page.locator('[data-testid="checkout-timer-settings-card"]').screenshot({
      path: path.join(SCREENSHOT_DIR, 'round43_shot1_billing_persist.png')
    });

    // =====================================================
    // Item 2: Diff-only save & single source of truth links
    // =====================================================
    let capturedPutPayload = null;
    page.on('request', (req) => {
      if (req.method() === 'PUT' && req.url().includes('/api/daily-settings/global')) {
        try {
          capturedPutPayload = req.postDataJSON();
        } catch (e) {}
      }
    });

    const noticeInput = page.locator('textarea[placeholder*="留空將顯示系統預設備註提醒"]').first();
    await noticeInput.waitFor({ state: 'visible', timeout: 5000 });
    const newNotice = `R43單欄修改備註_${runId}`;
    await noticeInput.fill(newNotice);
    await page.locator('[data-testid="save-billing-settings-btn"]').click();
    await page.locator('text=系統設定已成功儲存並立即生效').waitFor({ state: 'visible', timeout: 10000 });

    assert.ok(capturedPutPayload, 'Should have sent PUT /api/daily-settings/global');
    assert.deepEqual(Object.keys(capturedPutPayload), ['price_notice_text'], `Expected only price_notice_text in PUT payload, got: ${JSON.stringify(capturedPutPayload)}`);

    // Read-only equipment rules in SettingsPage
    const eqReadonlyCard = page.locator('[data-testid="settings-equipment-rules-card"]');
    await eqReadonlyCard.scrollIntoViewIfNeeded();
    await eqReadonlyCard.waitFor({ state: 'visible', timeout: 5000 });
    await page.waitForTimeout(200);
    await eqReadonlyCard.screenshot({
      path: path.join(SCREENSHOT_DIR, 'round43_shot2_settings_readonly_equipment.png')
    });

    // Navigate to SessionsPage -> Global prices & Kiosk rules read-only
    await page.goto(`${BASE_URL}/admin/sessions`, { waitUntil: 'networkidle' });
    await page.locator('[data-testid="sessions-global-prices-card"]').waitFor({ state: 'visible', timeout: 10000 });
    assert.equal(await page.locator('[data-testid="sessions-display-settings-card"]').count(), 0);
    await page.locator('[data-testid="sessions-global-prices-card"]').scrollIntoViewIfNeeded();
    await page.waitForTimeout(200);
    await page.locator('[data-testid="sessions-global-prices-card"]').screenshot({
      path: path.join(SCREENSHOT_DIR, 'round43_shot3_sessions_readonly.png')
    });

    // =====================================================
    // Item 3: Batch daily settings keep blank price unchanged + confirm modal
    // =====================================================
    await page.locator('button:has-text("自訂起訖日期")').click();
    const batchDateInputs = page.locator('form input[type="date"]');
    await batchDateInputs.nth(0).fill(futureStr);
    await batchDateInputs.nth(1).fill(futureStr);

    await page.locator('[data-testid="batch-hourly-input"]').fill('');
    await page.locator('[data-testid="batch-unlimited-input"]').fill('700');
    await page.locator('[data-testid="batch-allow-unlimited-unchanged"]').click();

    await page.locator('[data-testid="batch-submit-btn"]').click();
    const confirmModal = page.locator('[data-testid="batch-confirm-modal"]');
    await confirmModal.waitFor({ state: 'visible', timeout: 5000 });
    await page.waitForTimeout(200);
    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, 'round43_shot4_batch_confirm.png'),
      fullPage: false
    });

    await page.locator('[data-testid="batch-confirm-submit-btn"]').click();
    await confirmModal.waitFor({ state: 'hidden', timeout: 10000 });
    await page.waitForTimeout(300);

    // Re-open single-day view for futureStr & inspect Single Day Override inputs
    const listDateInput = page.locator('input[type="date"]').first();
    await listDateInput.fill(futureStr);
    await page.waitForTimeout(600);
    const singleDayCard = page.locator('form', { has: page.locator('button:has-text("儲存單日覆蓋")') });
    const singleDayNums = singleDayCard.locator('input[type="number"]');
    assert.equal(await singleDayNums.nth(0).inputValue(), '120', 'Hourly price must stay 120 when left blank in batch');
    assert.equal(await singleDayNums.nth(1).inputValue(), '700', 'Unlimited price must be updated to 700');

    // =====================================================
    // Item 4: PassPlan Create + List + Edit on CouponsPage
    // =====================================================
    await page.goto(`${BASE_URL}/admin/coupons`, { waitUntil: 'networkidle' });
    await page.locator('button:has-text("卡券方案")').first().click();
    await page.locator('button:has-text("新增卡券方案")').first().click();

    const planModal = page.locator('form', { has: page.locator('button:has-text("確認建立方案")') });
    await planModal.waitFor({ state: 'visible', timeout: 5000 });

    await planModal.locator('input[type="text"]').first().fill('測試十次卡');
    await planModal.locator('select').first().selectOption('PUNCH_CARD');
    const modalNums = planModal.locator('input[type="number"]');
    await modalNums.nth(0).fill('1500');
    await modalNums.nth(1).fill('2000');
    await modalNums.nth(2).fill('10');
    await planModal.locator('input[placeholder*="小時 / 次"]').fill('次');

    await planModal.locator('button[type="submit"]').click();
    await planModal.waitFor({ state: 'hidden', timeout: 10000 });

    const createdCard = page.locator('div.bg-white.rounded-2xl', { has: page.locator('h4:text-is("測試十次卡")') }).first();
    await createdCard.waitFor({ state: 'visible', timeout: 10000 });
    const cardText = await createdCard.innerText();
    assert.ok(cardText.includes('NT$ 1500 / 10 次'), `Expected "NT$ 1500 / 10 次" in card: ${cardText}`);

    await page.waitForTimeout(200);
    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, 'round43_shot5_pass_plans.png'),
      fullPage: false
    });

    // Track created plan ID for cleanup
    const createdPlans = await prisma.passPlan.findMany({ where: { name: '測試十次卡' } });
    createdPlans.forEach((p) => createdPlanIds.push(p.id));

    // Edit price -> 1800 and check notice text
    await createdCard.locator('button:has-text("編輯")').last().click();
    const editModal = page.locator('form', { has: page.locator('button:has-text("儲存變更")') });
    await editModal.waitFor({ state: 'visible', timeout: 5000 });
    await editModal.locator('text=修改只影響之後發出的卡券').waitFor({ state: 'visible', timeout: 5000 });
    await editModal.locator('input[type="number"]').nth(0).fill('1800');
    await editModal.locator('button[type="submit"]').click();
    await editModal.waitFor({ state: 'hidden', timeout: 10000 });

    await page.locator('div.bg-white.rounded-2xl', { has: page.locator('h4:text-is("測試十次卡")') }).locator('text=NT$ 1800 / 10 次').first().waitFor({ state: 'visible', timeout: 10000 });

    // =====================================================
    // Item 5: Custom Payment Method -> Save -> Reload -> Checkout PayMethodGrid
    // =====================================================
    await page.goto(`${BASE_URL}/admin/settings`, { waitUntil: 'networkidle' });
    await page.locator('[data-testid="new-payment-method-input"]').waitFor({ state: 'visible', timeout: 10000 });
    await page.locator('[data-testid="new-payment-method-input"]').fill('測試支付');
    await page.locator('[data-testid="add-payment-method-btn"]').click();

    await page.locator('[data-testid="save-billing-settings-btn"]').click();
    await page.locator('text=系統設定已成功儲存並立即生效').waitFor({ state: 'visible', timeout: 10000 });

    await page.reload({ waitUntil: 'networkidle' });
    await page.locator('[data-testid="payment-methods-list"]').waitFor({ state: 'visible', timeout: 10000 });
    await page.locator('[data-testid="counter-payment-methods-note"]').scrollIntoViewIfNeeded();
    await page.waitForTimeout(200);
    assert.ok(
      await page.locator('[data-testid="payment-method-label-custom_1"]').inputValue() === '測試支付',
      'Custom payment method 測試支付 should persist after reload'
    );

    const pmContainer = page.locator('div.space-y-3', { has: page.locator('[data-testid="payment-methods-list"]') }).first();
    await pmContainer.screenshot({
      path: path.join(SCREENSHOT_DIR, 'round43_shot6_payment_methods.png')
    });

    // Also verify ShopAdminPage payment tab note
    await page.goto(`${BASE_URL}/admin/shop`, { waitUntil: 'networkidle' });
    await page.locator('button:has-text("中信帳號池與金流")').first().click();
    await page.locator('text=這裡是顧客線上預購付訂金的方式').waitFor({ state: 'visible', timeout: 8000 });

    // Verify PayMethodGrid in CheckoutWorkbench shows 測試支付
    await page.goto(`${BASE_URL}/admin/reservations`, { waitUntil: 'networkidle' });
    const resCard = page.locator(`[data-testid="reservation-card-${bookingRef}"]:visible`).first();
    await resCard.waitFor({ state: 'visible', timeout: 10000 });
    await resCard.click();

    const goCheckoutBtn = page.locator('button:has-text("結帳明細"), button:has-text("前往結帳")').first();
    await goCheckoutBtn.waitFor({ state: 'visible', timeout: 8000 });
    await goCheckoutBtn.click();

    const collectBtn = page.locator('[data-testid="workbench-collect-btn"]:visible').last();
    await collectBtn.waitFor({ state: 'visible', timeout: 8000 });
    await collectBtn.click();

    await page.locator('[data-testid="pay-method-custom_1"]:visible').waitFor({ state: 'visible', timeout: 10000 });
    const customBtnText = await page.locator('[data-testid="pay-method-custom_1"]:visible').innerText();
    assert.ok(customBtnText.includes('測試支付'), `Expected custom_1 button label 測試支付, got: ${customBtnText}`);

    console.log('--- Round 43 Settings Persist & Admin UX Playwright Test PASSED ---');
  } finally {
    await browser.close().catch(() => {});
    if (origGlobal) {
      await prisma.globalSetting.update({
        where: { id: 1 },
        data: {
          board_swap_grace_minutes: origGlobal.board_swap_grace_minutes ?? 10,
          cash_float_amount: origGlobal.cash_float_amount ?? 2000,
          auto_print_receipt: origGlobal.auto_print_receipt ?? true,
          price_notice_text: origGlobal.price_notice_text,
          payment_methods_json: origGlobal.payment_methods_json
        }
      }).catch(() => {});
    }
    if (createdPlanIds.length > 0) {
      await prisma.passPlan.deleteMany({ where: { id: { in: createdPlanIds } } }).catch(() => {});
    }
    await cleanOperationalData(prisma);
    await ensureFreshDbSeeded(prisma);
    if (testUser?.id) {
      await prisma.user.deleteMany({ where: { id: testUser.id } }).catch(() => {});
    }
    await prisma.$disconnect().catch(() => {});
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
