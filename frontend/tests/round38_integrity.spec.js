// frontend/tests/round38_integrity.spec.js
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
const { ensureFreshDbSeeded } = await import('./helpers/seedFreshDb.js');
const { toTaipeiDateString } = await import('../../shared/time.js');

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
  await page.waitForURL(url => url.pathname.includes('/admin/sessions'), {
    timeout: 15000
  });
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(400);
}

async function run() {
  console.log('--- Starting Round 38 Accounting Integrity Playwright Test ---');
  await ensureFreshDbSeeded(prisma);

  const runId = Date.now().toString().slice(-6);
  const nowMs = Date.now();
  const todayStr = toTaipeiDateString(new Date(nowMs));
  const todayDate = new Date(`${todayStr}T00:00:00.000Z`);

  let user = null;
  let passPlan = null;
  let shopOrder = null;
  let createdSessionId = null;
  const bookingRef = `BK-R38-UI-${runId}`;
  const createdPassCodes = [];
  let savedGlobal = null;
  let browser = null;

  try {
    savedGlobal = await prisma.globalSetting.findUnique({ where: { id: 1 } });
    await prisma.globalSetting.upsert({
      where: { id: 1 },
      update: {
        print_enabled: true,
        auto_print_receipt: true,
        auto_print_summary: false,
        seat_layout_enabled: true,
        payment_methods_json: [
          { key: 'cash', label: '現金', enabled: true },
          { key: 'linepay', label: 'LINE Pay', enabled: true },
          { key: 'transfer', label: '銀行轉帳', enabled: true },
          { key: 'card', label: '信用卡', enabled: true }
        ]
      },
      create: {
        id: 1,
        print_enabled: true,
        auto_print_receipt: true,
        auto_print_summary: false,
        seat_layout_enabled: true
      }
    });

    user = await prisma.user.create({
      data: {
        line_user_id: `manual_r38_e2e_${runId}`,
        name: `R38測試顧客_${runId}`,
        phone: `0900${runId}` // check-secrets: fake-data
      }
    });

    passPlan = await prisma.passPlan.create({
      data: {
        code: `R38_E2E_PLAN_${runId}`,
        name: 'R38門市五次卡',
        pass_type: 'PUNCH_CARD',
        price: 1000,
        total_quota: 5,
        checkout_effect: 'entry_full',
        valid_days: 90,
        day_restriction: 'ALL',
        is_active: true
      }
    });

    // Ensure published layout has seat A1-1
    const activeLayout = await prisma.seatLayout.findFirst({ where: { status: 'published' } });
    let seatCode = 'A1-1';
    if (activeLayout) {
      const anySeat = await prisma.seat.findFirst({ where: { layout_id: activeLayout.id, is_active: true } });
      if (anySeat) seatCode = anySeat.code;
    }

    // Create today session & checked-in booking for Item 5 print test
    const existingSess = await prisma.session.findFirst({
      where: { session_date: todayDate, start_time: '14:00' }
    });
    const sessionRow = existingSess || await prisma.session.create({
      data: { session_date: todayDate, start_time: '14:00', end_time: '16:00', max_capacity: 20 }
    });
    if (!existingSess) createdSessionId = sessionRow.id;

    await prisma.reservation.create({
      data: {
        booking_ref: bookingRef,
        session_id: sessionRow.id,
        user_id: user.id,
        pax: 1,
        status: 'confirmed',
        attendance: 'checked_in',
        checked_in_at: new Date(nowMs - 3600000),
        assigned_seats: [seatCode],
        checkout_details: { version: 2, rev: 0, persons: [{ person_no: 1, mode: 'hourly' }], order_addons: [], order_promos: [] }
      }
    });
    await prisma.bookingPerson.create({
      data: {
        booking_ref: bookingRef,
        person_no: 1,
        seat_code: seatCode,
        status: 'active',
        billing_start_at: new Date(nowMs - 3600000),
        timer_started_at: new Date(nowMs - 3600000)
      }
    });

    // Create Shop Order for Item 3 UI test (total 1000, deposit 300)
    const orderRef = `PO-R38-UI-${runId}`;
    shopOrder = await prisma.productOrder.create({
      data: {
        order_ref: orderRef,
        user_id: user.id,
        total_amount: 1000,
        deposit_required: 300,
        paid_amount: 0,
        balance_amount: 1000,
        payment_method_code: 'transfer',
        remittance_last5: '98765',
        remittance_reported_at: new Date(),
        payment_status: 'reported_pending_verify',
        order_status: 'arrived'
      }
    });

    browser = await chromium.launch({ headless: HEADLESS });
    const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
    const page = await context.newPage();

    // Stub window.print with a page-level counter before navigating anywhere
    await page.addInitScript(() => {
      window.__r38PrintCount = 0;
      window.print = () => {
        window.__r38PrintCount = (window.__r38PrintCount || 0) + 1;
      };
    });

    await adminLogin(page);

    // =========================================================================
    // Test 1 (Item 2): Pass grant in 'sale' mode -> verify Accounting Ledger
    // =========================================================================
    console.log('Step 1: Testing pass sale in MemberDetailsModal...');
    await page.goto(`${BASE_URL}/admin/members?userId=${user.id}`, { waitUntil: 'networkidle' });
    const passTabBtn = page.locator('button:has-text("卡券 ("):visible').first();
    await passTabBtn.waitFor({ state: 'visible', timeout: 10000 });
    await passTabBtn.click();

    const openGrantBtn = page.locator('button:has-text("發放卡券"):visible').first();
    await openGrantBtn.waitFor({ state: 'visible', timeout: 8000 });
    await openGrantBtn.click();

    await page.locator('[data-testid="grant-mode-sale"]').waitFor({ state: 'visible', timeout: 8000 });
    await page.locator('[data-testid="grant-mode-sale"]').click();
    await page.locator('select').filter({ hasText: passPlan.name }).selectOption(String(passPlan.id));
    await page.locator('[data-testid="grant-sale-amount"]').fill('1000');
    await page.locator('[data-testid="grant-sale-method"]').selectOption('cash');
    await page.locator('[data-testid="grant-cash-received"]').fill('1000');
    await page.waitForTimeout(300);

    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'round38_shot1_pass_sale_form.png') });

    const grantRespPromise = page.waitForResponse(
      r => r.url().includes('/api/passes/admin/grant') && r.request().method() === 'POST'
    );
    await page.locator('button:has-text("確認收款並發卡"):visible').click();
    const grantResp = await grantRespPromise;
    assert.equal(grantResp.status(), 200, 'Expected POST /passes/admin/grant 200');
    const grantJson = await grantResp.json();
    const soldPassCode = grantJson?.pass?.pass_code;
    assert.ok(soldPassCode, 'Expected created pass_code');
    createdPassCodes.push(soldPassCode);

    // =========================================================================
    // Test 2 (Item 3): Shop Verify (300) + Collect Balance (700) + Pickup disabled check
    // =========================================================================
    console.log('Step 2: Testing Shop Admin verify & balance collection...');
    await page.goto(`${BASE_URL}/admin/shop`, { waitUntil: 'networkidle' });

    const pickupBtn = page.locator(`[data-testid="shop-pickup-btn-${shopOrder.id}"]:visible`);
    await pickupBtn.waitFor({ state: 'visible', timeout: 10000 });
    assert.equal(await pickupBtn.isDisabled(), true, 'Pickup must be disabled when balance_amount > 0');

    await page.locator(`[data-testid="shop-verify-btn-${shopOrder.id}"]:visible`).click();
    await page.locator('[data-testid="shop-verify-modal"]').waitFor({ state: 'visible', timeout: 8000 });
    const balText = await page.locator('[data-testid="shop-verify-balance-info"]').textContent();
    assert.ok(balText.includes('已收 NT$0') && balText.includes('尚欠 NT$1000'), `Unexpected verify info: ${balText}`);
    await page.locator('[data-testid="shop-verify-amount"]').fill('300');
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'round38_shot2_shop_verify_modal.png') });

    const verifyRespPromise = page.waitForResponse(
      r => r.url().includes(`/api/shop/admin/orders/${shopOrder.id}/verify-payment`) && r.request().method() === 'PATCH'
    );
    await page.locator('[data-testid="shop-verify-confirm-btn"]').click();
    assert.equal((await verifyRespPromise).status(), 200);
    await page.waitForTimeout(400);

    // Pickup still disabled while balance=700; 收尾款 button now visible
    assert.equal(await pickupBtn.isDisabled(), true, 'Pickup must remain disabled when balance=700');
    await page.locator(`[data-testid="shop-collect-btn-${shopOrder.id}"]:visible`).click();
    await page.locator('[data-testid="shop-collect-modal"]').waitFor({ state: 'visible', timeout: 8000 });
    await page.locator('[data-testid="shop-collect-method"]').selectOption('cash');
    await page.locator('[data-testid="shop-collect-amount"]').fill('700');
    await page.locator('[data-testid="shop-collect-cash-received"]').fill('1000');
    await page.waitForTimeout(200);
    const changeText = await page.locator('[data-testid="shop-collect-change"]').textContent();
    assert.ok(changeText.includes('300'), `Expected change 300, got: ${changeText}`);
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'round38_shot3_shop_collect_modal.png') });

    const collectShopRespPromise = page.waitForResponse(
      r => r.url().includes(`/api/shop/admin/orders/${shopOrder.id}/collect`) && r.request().method() === 'POST'
    );
    await page.locator('[data-testid="shop-collect-confirm-btn"]').click();
    assert.equal((await collectShopRespPromise).status(), 200);
    await page.waitForTimeout(500);

    assert.equal(await pickupBtn.isDisabled(), false, 'Pickup must be enabled once balance is 0');

    // =========================================================================
    // Test 3 (Item 5): Collect on CheckoutWorkbench -> window.print count stays 0!
    // Then click '用這台印' -> count=1 -> click again -> 409 message & count stays 1
    // =========================================================================
    console.log('Step 3: Testing local print claim and no-auto-print...');
    await page.goto(`${BASE_URL}/admin/reservations`, { waitUntil: 'networkidle' });
    await page.locator('input[type="month"]').first().fill(todayStr.slice(0, 7));
    await page.locator('input[placeholder="搜尋訂單編號、姓名或電話..."]').first().fill(bookingRef);
    await page.waitForTimeout(500);
    const resCheckoutBtn = page.locator(`[data-testid="reservation-card-${bookingRef}"] button:has-text("結帳"):visible, tr:has-text("${bookingRef.slice(-4)}") button:has-text("結帳"):visible`).first();
    await resCheckoutBtn.waitFor({ state: 'visible', timeout: 10000 });
    await resCheckoutBtn.click();
    const goCheckoutBtn = page.locator('button:has-text("前往結帳"):visible').first();
    await goCheckoutBtn.waitFor({ state: 'visible', timeout: 8000 });
    await Promise.all([
      page.waitForResponse(r => r.url().includes(`/api/billing/${bookingRef}`) && r.request().method() === 'GET'),
      goCheckoutBtn.click()
    ]);

    const wbCollectBtn = page.locator('[data-testid="workbench-collect-btn"]:visible').first();
    await wbCollectBtn.waitFor({ state: 'visible', timeout: 10000 });
    await wbCollectBtn.click();

    const splitDialog = page.locator('div[role="dialog"]').last();
    const confirmPayBtn = splitDialog.locator('button:has-text("確認收款"):visible');
    await confirmPayBtn.waitFor({ state: 'visible', timeout: 8000 });

    const countBeforeCollect = await page.evaluate(() => window.__r38PrintCount || 0);
    assert.equal(countBeforeCollect, 0);

    await confirmPayBtn.click();
    await page.locator('[data-testid="payment-complete-view"]').waitFor({ state: 'visible', timeout: 10000 });
    await page.waitForTimeout(600);

    const countAfterCollect = await page.evaluate(() => window.__r38PrintCount || 0);
    assert.equal(countAfterCollect, 0, 'window.print must NOT auto-fire after collecting payment');

    // Click '用這台印' -> claims -> prints -> reports /local -> window.__r38PrintCount === 1
    const localReportPromise = page.waitForResponse(
      r => r.url().includes('/api/print/jobs/') && r.url().endsWith('/local') && r.request().method() === 'POST'
    );
    await page.locator('button:has-text("用這台印"):visible').click();
    const localRep = await localReportPromise;
    assert.equal(localRep.status(), 200);
    await page.waitForTimeout(200);

    const countAfterLocalPrint = await page.evaluate(() => window.__r38PrintCount || 0);
    assert.equal(countAfterLocalPrint, 1, 'Expected window.print count === 1 after 用這台印');

    // Click '用這台印' a second time -> 409 message shown, count remains 1
    const secondClaimPromise = page.waitForResponse(
      r => r.url().includes('/api/print/jobs/') && r.url().endsWith('/local-claim') && r.request().method() === 'POST'
    );
    await page.locator('button:has-text("用這台印"):visible').click();
    const secondClaim = await secondClaimPromise;
    assert.equal(secondClaim.status(), 409);
    await page.locator('text=列印站已經在印或已印出').waitFor({ state: 'visible', timeout: 5000 });

    const countAfterDupClick = await page.evaluate(() => window.__r38PrintCount || 0);
    assert.equal(countAfterDupClick, 1, 'Duplicate local print must not re-fire window.print');

    // =========================================================================
    // Test 4 (Item 2 + 5 UI): AccountingPage payments source label & print status
    // =========================================================================
    console.log('Step 4: Checking AccountingPage ledger sources & local print status...');
    await page.goto(`${BASE_URL}/admin/accounting`, { waitUntil: 'networkidle' });
    const payTabBtn = page.locator('button:has-text("收款明細"):visible').first();
    await payTabBtn.waitFor({ state: 'visible', timeout: 10000 });
    await payTabBtn.click();
    await page.waitForTimeout(600);

    await page.locator(`text=卡券販售 · *${soldPassCode.slice(-4)}`).first().waitFor({ state: 'visible', timeout: 8000 });
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'round38_shot4_accounting_sources.png') });

    const printJobsTabBtn = page.locator('button:has-text("列印紀錄"):visible').first();
    await printJobsTabBtn.click();
    await page.waitForTimeout(600);
    await page.locator('text=已印出（本機）').first().waitFor({ state: 'visible', timeout: 8000 });

    console.log('--- Round 38 Accounting Integrity Playwright Test PASSED ---');
  } finally {
    if (browser) await browser.close().catch(() => {});

    const allRefs = [bookingRef];
    if (shopOrder?.order_ref) allRefs.push(shopOrder.order_ref);
    for (const pc of createdPassCodes) allRefs.push(pc);

    await prisma.printJob.deleteMany({ where: { booking_ref: { in: allRefs } } }).catch(() => {});
    await prisma.payment.deleteMany({ where: { booking_ref: { in: allRefs } } }).catch(() => {});
    if (shopOrder) await prisma.productOrder.deleteMany({ where: { id: shopOrder.id } }).catch(() => {});
    for (const pc of createdPassCodes) {
      await prisma.userPass.deleteMany({ where: { pass_code: pc } }).catch(() => {});
    }
    await prisma.bookingPerson.deleteMany({ where: { booking_ref: bookingRef } }).catch(() => {});
    await prisma.bookingEquipment.deleteMany({ where: { booking_ref: bookingRef } }).catch(() => {});
    await prisma.reservation.deleteMany({ where: { booking_ref: bookingRef } }).catch(() => {});
    if (createdSessionId) await prisma.session.deleteMany({ where: { id: createdSessionId } }).catch(() => {});
    if (passPlan) await prisma.passPlan.deleteMany({ where: { id: passPlan.id } }).catch(() => {});
    if (user) await prisma.user.deleteMany({ where: { id: user.id } }).catch(() => {});
    if (savedGlobal) {
      await prisma.globalSetting.update({
        where: { id: 1 },
        data: {
          print_enabled: savedGlobal.print_enabled,
          auto_print_receipt: savedGlobal.auto_print_receipt,
          auto_print_summary: savedGlobal.auto_print_summary,
          seat_layout_enabled: savedGlobal.seat_layout_enabled,
          payment_methods_json: savedGlobal.payment_methods_json
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
