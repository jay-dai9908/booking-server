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

const jwt = require('../../backend/node_modules/jsonwebtoken/index.js');
const { PrismaClient } = require('../../backend/node_modules/@prisma/client/index.js');
const { ensureFreshDbSeeded, cleanOperationalData } = await import('./helpers/seedFreshDb.js');
const { toTaipeiDateString, dateOnly } = await import('../../shared/time.js');

const testDbUrl =
  process.env.TEST_DATABASE_URL ||
  'postgresql://user:password@localhost:5432/booking_db_test?schema=public';
const prisma = new PrismaClient({ datasources: { db: { url: testDbUrl.trim() } } });

const BASE_URL = process.env.BASE_URL || 'http://localhost:5173';
const API_URL = process.env.API_URL || 'http://127.0.0.1:3001';
const HEADLESS = process.env.HEADLESS !== 'false';
if (!process.env.ADMIN_PASSWORD?.trim()) {
  console.error('請設定 ADMIN_PASSWORD 環境變數');
  process.exit(1);
}
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD.trim();
if (!process.env.JWT_SECRET?.trim()) {
  console.error('請設定 JWT_SECRET 環境變數');
  process.exit(1);
}
const JWT_SECRET = process.env.JWT_SECRET.trim();

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
  console.log('--- Starting Round 45 Self-Service Prepay & Shop Admin E2E ---');
  await ensureFreshDbSeeded(prisma);
  await prisma.productOrder.deleteMany({}).catch(() => {});
  await cleanOperationalData(prisma);

  const runId = Date.now().toString().slice(-6);
  const futureStr = toTaipeiDateString(new Date(Date.now() + 14 * 86400000));
  const targetDate = dateOnly(futureStr);
  const bankCode = `r45e2e_${runId}`;
  const poolAcct = `99900045${runId.slice(-5)}`;

  const launchOptions = { headless: HEADLESS };
  if (process.env.PLAYWRIGHT_CHROMIUM_PATH) {
    launchOptions.executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH;
  }

  const browser = await chromium.launch(launchOptions);
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();

  const origGlobal = await prisma.globalSetting.findUnique({ where: { id: 1 } });
  const createdSessionIds = [];
  let createdProduct = null;
  let customer = null;
  let createdPoolMethod = false;

  try {
    customer = await prisma.user.create({
      data: {
        line_user_id: `r45_e2e_u_${runId}`,
        name: '林小美',
        phone: `090045${runId.slice(-4)}`
      }
    });
    const custToken = jwt.sign(
      {
        id: customer.id,
        typ: 'customer',
        line_user_id: customer.line_user_id,
        role: 'customer',
        name: customer.name
      },
      JWT_SECRET,
      { expiresIn: '2h' }
    );
    const custHeaders = {
      Authorization: `Bearer ${custToken}`,
      'Content-Type': 'application/json'
    };

    await prisma.paymentMethodConfig.create({
      data: {
        code: bankCode,
        name: 'R45測試銀行轉帳',
        method_type: 'MULTI_BANK',
        is_enabled: true,
        sort_order: 99,
        bank_accounts_json: [{ bank_name: '測試銀行', bank_code: '999', account_number: '9990000000450' }]
      }
    });

    const exPoolMethod = await prisma.paymentMethodConfig.findUnique({ where: { code: 'ctbc_pool' } });
    if (!exPoolMethod) {
      await prisma.paymentMethodConfig.create({
        data: { code: 'ctbc_pool', name: '中信專屬一次帳號', method_type: 'POOL_ACCOUNT', is_enabled: true }
      });
      createdPoolMethod = true;
    }

    await prisma.dailySetting.upsert({
      where: { date: targetDate },
      update: { is_self_service: true, unlimited_price: 550, hourly_price: 150, allow_unlimited: true },
      create: { date: targetDate, is_self_service: true, unlimited_price: 550, hourly_price: 150, allow_unlimited: true }
    });

    const slots = [
      ['13:00', '14:00'],
      ['14:00', '15:00'],
      ['15:00', '16:00'],
      ['16:00', '17:00'],
      ['17:00', '18:00'],
      ['18:00', '19:00'],
      ['19:00', '20:00'],
      ['20:00', '21:00']
    ];
    for (const [st, et] of slots) {
      const s = await prisma.session.upsert({
        where: { session_date_start_time: { session_date: targetDate, start_time: st } },
        update: { max_capacity: 40 },
        create: { session_date: targetDate, start_time: st, end_time: et, max_capacity: 40 }
      });
      createdSessionIds.push(s.id);
    }

    const createSelfBooking = async () => {
      const resp = await fetch(`${API_URL}/api/reservations`, {
        method: 'POST',
        headers: custHeaders,
        body: JSON.stringify({
          session_ids: createdSessionIds,
          pax: 2,
          isUnlimited: true,
          self_service_ack: true,
          prepay: {
            pass_uses: [],
            transfer: { payment_method_code: bankCode },
            expected_transfer_amount: 1100
          }
        })
      });
      const body = await resp.json();
      assert.equal(resp.status, 201, `createSelfBooking failed: ${JSON.stringify(body)}`);
      return body.reservation.booking_ref;
    };

    const refShort = await createSelfBooking();
    const refOverpaid = await createSelfBooking();

    // Report last5 for both prepays so they appear under default reported_pending_verify tab
    for (const ref of [refShort, refOverpaid]) {
      const rResp = await fetch(`${API_URL}/api/reservations/${ref}/prepay/remittance`, {
        method: 'PATCH',
        headers: custHeaders,
        body: JSON.stringify({ remittance_last5: '54321' })
      });
      assert.equal(rResp.status, 200);
    }

    await adminLogin(page);

    // ========================================================
    // Item 1: Prepay shortfall & overpaid verification + 2 shots
    // ========================================================
    await page.goto(`${BASE_URL}/admin/reservations?tab=prepays`, { waitUntil: 'networkidle' });
    const rowShort = page.locator(`[data-testid="prepay-row-${refShort}"]`);
    await rowShort.waitFor({ state: 'visible', timeout: 10000 });

    // Enter 1000 (< 1100) -> shortfall 100
    await page.locator(`[data-testid="prepay-verify-btn-${refShort}"] >> visible=true`).first().click();
    await page.locator('[data-testid="prepay-received-amount-input"]').fill('1000');
    await page.locator('[data-testid="prepay-confirm-submit-btn"]').click();
    await page.waitForLoadState('networkidle');
    await rowShort.locator('text=已收 NT$1,000、還差 NT$100').waitFor({ state: 'visible', timeout: 10000 });

    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'round45_shot1_prepay_shortfall.png'), fullPage: true });
    console.log('Shot 1 saved: prepay shortfall.');

    // Enter remaining 100 -> verified
    await page.locator(`[data-testid="prepay-verify-btn-${refShort}"] >> visible=true`).first().click();
    await page.locator('[data-testid="prepay-received-amount-input"]').fill('100');
    await page.locator('[data-testid="prepay-confirm-submit-btn"]').click();
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(300);

    // Second booking: overpaid 1200 -> overpaid_amount 100, pending refund
    await page.locator(`[data-testid="prepay-verify-btn-${refOverpaid}"] >> visible=true`).first().click();
    await page.locator('[data-testid="prepay-received-amount-input"]').fill('1200');
    await page.locator('[data-testid="prepay-confirm-submit-btn"]').click();
    await page.waitForLoadState('networkidle');

    // Switch filter to verified to view overpaid pending refund card
    await page.locator('[data-testid="prepay-filter-verified"]').click();
    await page.waitForLoadState('networkidle');
    const rowOverpaid = page.locator(`[data-testid="prepay-row-${refOverpaid}"]`);
    await rowOverpaid.waitFor({ state: 'visible', timeout: 10000 });
    await rowOverpaid.locator('text=多收 NT$100，待退還').waitFor({ state: 'visible', timeout: 5000 });
    await page.locator(`[data-testid="prepay-overpaid-refund-btn-${refOverpaid}"] >> visible=true`).first().waitFor({ state: 'visible', timeout: 5000 });

    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'round45_shot2_prepay_overpaid.png'), fullPage: true });
    console.log('Shot 2 saved: prepay overpaid pending refund.');

    // ========================================================
    // Item 2 (Option C) & Item 3: Shop held pool account & cancel refund
    // ========================================================
    createdProduct = await prisma.product.create({
      data: {
        code: `R45_E2E_P_${runId}`,
        name: '拼豆材料組合包',
        price: 2000,
        deposit_amount: 600,
        visibility_status: 'ACTIVE'
      }
    });

    await prisma.oneTimeAccountPool.create({
      data: {
        account_number: poolAcct,
        payment_method_code: 'ctbc_pool',
        status: 'ASSIGNED',
        assigned_order_ref: `PO-20261126-9901`,
        assigned_user_id: customer.id,
        assigned_at: new Date()
      }
    });

    const ordC = await prisma.productOrder.create({
      data: {
        order_ref: `PO-20261126-9901`,
        user_id: customer.id,
        total_amount: 2000,
        deposit_required: 600,
        paid_amount: 0,
        balance_amount: 2000,
        payment_method_code: 'ctbc_pool',
        assigned_pool_account: poolAcct,
        payment_status: 'reported_pending_verify',
        remittance_last5: '67890',
        remittance_reported_at: new Date(),
        order_status: 'preorder_placed',
        payment_deadline: new Date(Date.now() + 24 * 3600000),
        auto_expire: true,
        items: {
          create: {
            product_id: createdProduct.id,
            product_code_snapshot: createdProduct.code,
            product_name_snapshot: createdProduct.name,
            price_snapshot: 2000,
            quantity: 1,
            subtotal: 2000
          }
        }
      }
    });

    const ordD = await prisma.productOrder.create({
      data: {
        order_ref: `PO-20261126-9902`,
        user_id: customer.id,
        total_amount: 2000,
        deposit_required: 600,
        paid_amount: 0,
        balance_amount: 2000,
        payment_method_code: 'bank_transfer',
        payment_status: 'pending_payment',
        order_status: 'preorder_placed',
        payment_deadline: new Date(Date.now() + 24 * 3600000),
        auto_expire: true,
        items: {
          create: {
            product_id: createdProduct.id,
            product_code_snapshot: createdProduct.code,
            product_name_snapshot: createdProduct.name,
            price_snapshot: 2000,
            quantity: 1,
            subtotal: 2000
          }
        }
      }
    });

    await page.goto(`${BASE_URL}/admin/shop`, { waitUntil: 'networkidle' });

    // Order C: verify -> 查無入帳 -> confirm -> status becomes 已對帳・查無入帳
    const rowC = page.locator(`[data-testid="shop-order-row-${ordC.id}"]`);
    await rowC.waitFor({ state: 'visible', timeout: 10000 });
    await page.locator(`[data-testid="shop-verify-btn-${ordC.id}"]`).click();
    await page.locator('[data-testid="shop-verify-not-found-btn"]').click();
    await page.locator('[data-testid="shop-verify-not-found-note"]').fill('網銀查帳無67890入帳');
    await page.locator('[data-testid="shop-verify-not-found-submit"]').click();
    await page.waitForLoadState('networkidle');
    await rowC.locator('text=已對帳・查無入帳').waitFor({ state: 'visible', timeout: 10000 });

    // Cancel Order C via UI modal -> shows 帳號保留中（已回報匯款）
    await page.locator(`[data-testid="shop-cancel-btn-${ordC.id}"]`).click();
    await page.locator('[data-testid="shop-cancel-reason"]').fill('查無入帳取消');
    await page.locator('[data-testid="shop-cancel-submit"]').click();
    await page.waitForLoadState('networkidle');
    await page.locator(`[data-testid="shop-held-pool-badge-${ordC.id}"]`).waitFor({ state: 'visible', timeout: 10000 });
    await page.locator(`[data-testid="shop-release-pool-btn-${ordC.id}"]`).waitFor({ state: 'visible', timeout: 5000 });

    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'round45_shot3_shop_held_pool.png'), fullPage: true });
    console.log('Shot 3 saved: shop held pool account.');

    // Verify Order D with 600 cash, then open Cancel modal & screenshot
    await page.locator(`[data-testid="shop-verify-btn-${ordD.id}"]`).click();
    await page.locator('[data-testid="shop-verify-amount"]').fill('600');
    await page.locator('[data-testid="shop-verify-method"]').selectOption('cash');
    await page.locator('[data-testid="shop-verify-confirm-btn"]').click();
    await page.waitForLoadState('networkidle');

    await page.locator(`[data-testid="shop-cancel-btn-${ordD.id}"]`).click();
    await page.locator('[data-testid="shop-cancel-refund-amount"]').waitFor({ state: 'visible', timeout: 5000 });
    const valStr = await page.locator('[data-testid="shop-cancel-refund-amount"]').inputValue();
    assert.equal(valStr, '600');
    await page.locator('[data-testid="shop-cancel-reason"]').fill('客人改買其他款式');

    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'round45_shot4_shop_cancel_modal.png'), fullPage: true });
    console.log('Shot 4 saved: shop cancel refund modal.');

    await page.locator('[data-testid="shop-cancel-submit"]').click();
    await page.waitForLoadState('networkidle');
    const rowD = page.locator(`[data-testid="shop-order-row-${ordD.id}"]`);
    await rowD.locator('text=已取消').waitFor({ state: 'visible', timeout: 10000 });

    // Check AccountingPage Shop Revenue tab shows 600 refund while overview revenue excludes shop
    await page.goto(`${BASE_URL}/admin/accounting`, { waitUntil: 'networkidle' });
    await page.getByRole('tab', { name: '商城收入' }).click();
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(300);
    const shopRevText = await page.locator('body').innerText();
    assert.ok(shopRevText.includes('600'), 'Expected 600 refund visible on Shop Revenue tab');

    // ========================================================
    // Item 4: Shop order list deadlines, pagination (30/page) & overdue filter
    // ========================================================
    const bulkOrders = [];
    for (let i = 1; i <= 33; i++) {
      const isExp = i >= 32;
      bulkOrders.push({
        order_ref: `PO-20261126-${String(i).padStart(4, '0')}`,
        user_id: customer.id,
        total_amount: 500,
        deposit_required: 200,
        paid_amount: 0,
        balance_amount: 500,
        payment_method_code: 'onsite',
        payment_status: 'pending_payment',
        order_status: 'preorder_placed',
        payment_deadline: new Date(Date.now() + (isExp ? -7200000 : 24 * 3600000)),
        auto_expire: !isExp,
        created_at: new Date(Date.now() + i * 1000)
      });
    }
    await prisma.productOrder.createMany({ data: bulkOrders });

    await page.goto(`${BASE_URL}/admin/shop`, { waitUntil: 'networkidle' });
    await page.locator('[data-testid="shop-orders-pagination"]').waitFor({ state: 'visible', timeout: 10000 });
    const pagText = await page.locator('[data-testid="shop-orders-pagination"]').innerText();
    assert.ok(pagText.includes('第 1 / 2 頁'), `Expected pagination text 第 1 / 2 頁, got: ${pagText}`);
    await page.locator('text=逾期（舊單，不自動取消）').first().waitFor({ state: 'visible', timeout: 5000 });

    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'round45_shot5_shop_orders_deadlines.png'), fullPage: true });
    console.log('Shot 5 saved: shop orders list with deadlines & pagination.');

    // Click Overdue filter -> only the 2 overdue legacy orders remain
    await page.locator('[data-testid="shop-overdue-filter-btn"]').click();
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(300);
    const filteredCount = await page.locator('[data-testid^="shop-order-row-"]').count();
    assert.equal(filteredCount, 2, `Expected 2 overdue orders after filter, got ${filteredCount}`);

    console.log('Round 45 Playwright E2E PASSED all assertions!');
  } finally {
    await browser.close().catch(() => {});
    await prisma.productOrder.deleteMany({}).catch(() => {});
    await cleanOperationalData(prisma).catch(() => {});
    await prisma.oneTimeAccountPool.deleteMany({ where: { account_number: poolAcct } }).catch(() => {});
    if (createdSessionIds.length > 0) {
      await prisma.session.deleteMany({ where: { id: { in: createdSessionIds } } }).catch(() => {});
    }
    await prisma.dailySetting.deleteMany({ where: { date: targetDate } }).catch(() => {});
    await prisma.paymentMethodConfig.deleteMany({ where: { code: bankCode } }).catch(() => {});
    if (createdPoolMethod) {
      await prisma.paymentMethodConfig.deleteMany({ where: { code: 'ctbc_pool' } }).catch(() => {});
    }
    if (createdProduct?.id) {
      await prisma.product.deleteMany({ where: { id: createdProduct.id } }).catch(() => {});
    }
    if (customer?.id) {
      await prisma.user.deleteMany({ where: { id: customer.id } }).catch(() => {});
    }
    if (origGlobal) {
      await prisma.globalSetting.update({
        where: { id: 1 },
        data: {
          shop_enabled: origGlobal.shop_enabled,
          shop_deposit_deadline_days: origGlobal.shop_deposit_deadline_days
        }
      }).catch(() => {});
    }
    await prisma.$disconnect();
  }
}

run().catch((err) => {
  console.error('Round 45 E2E FAILED:', err);
  process.exit(1);
});
