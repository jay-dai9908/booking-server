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

async function run() {
  console.log('--- Starting Round 48 Item 1 Shop Payment E2E ---');
  await ensureFreshDbSeeded(prisma);
  await cleanOperationalData(prisma);

  const runId = Date.now().toString().slice(-6);
  const prodCode = `R48_E2E_ITEM_${runId}`;
  const multiCode = `r48_multi_${runId}`;
  const onsiteCode = `r48_onsite_${runId}`;
  const poolAcct = `00000048${runId}`;
  const acct2 = '00000000000202';

  let customer = null;
  let product = null;
  let createdPoolMethod = false;
  const createdPoolIds = [];
  const origGlobal = await prisma.globalSetting.findUnique({ where: { id: 1 } });

  const launchOptions = { headless: HEADLESS };
  if (process.env.PLAYWRIGHT_CHROMIUM_PATH) {
    launchOptions.executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH;
  }
  const browser = await chromium.launch(launchOptions);
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });

  try {
    await prisma.globalSetting.upsert({
      where: { id: 1 },
      update: { shop_enabled: true, show_shop_button: true },
      create: { id: 1, shop_enabled: true, show_shop_button: true }
    });

    customer = await prisma.user.create({
      data: {
        name: 'R48商城E2E客',
        phone: `0988${runId}`,
        line_user_id: `r48_shop_e2e_${runId}`
      }
    });
    const token = jwt.sign(
      { id: customer.id, typ: 'customer', line_user_id: customer.line_user_id, role: 'customer', name: customer.name },
      JWT_SECRET,
      { expiresIn: '2h' }
    );
    await context.addInitScript((tok) => {
      try {
        sessionStorage.setItem('shiguang_auth_token', tok);
        sessionStorage.removeItem('shiguang_shop_draft_cart');
        localStorage.removeItem('shiguang_shop_draft_cart');
      } catch {}
    }, token);

    product = await prisma.product.create({
      data: {
        code: prodCode,
        name: 'R48質感拼豆組',
        category: 'tools_3d',
        price: 450,
        deposit_amount: 450,
        is_preorder: true,
        visibility_status: 'ACTIVE'
      }
    });

    const exCtbc = await prisma.paymentMethodConfig.findUnique({ where: { code: 'ctbc_pool' } });
    if (!exCtbc) {
      await prisma.paymentMethodConfig.create({
        data: { code: 'ctbc_pool', name: '中信專屬轉帳帳號', method_type: 'POOL_ACCOUNT', is_enabled: true, sort_order: 1 }
      });
      createdPoolMethod = true;
    } else {
      await prisma.paymentMethodConfig.update({ where: { code: 'ctbc_pool' }, data: { is_enabled: true, method_type: 'POOL_ACCOUNT' } });
    }

    await prisma.paymentMethodConfig.createMany({
      data: [
        {
          code: multiCode,
          name: '一般銀行匯款測試',
          method_type: 'MULTI_BANK',
          is_enabled: true,
          require_last5: true,
          sort_order: 2,
          bank_accounts_json: [
            { bank_name: '第一測試行', bank_code: '007', account: '00000000000201' },
            { bank_name: '第二測試行', bank_code: '013', account: acct2 }
          ]
        },
        {
          code: onsiteCode,
          name: '到店付款測試',
          method_type: 'ONSITE',
          is_enabled: true,
          require_last5: false,
          sort_order: 3
        }
      ]
    });

    const pRow = await prisma.oneTimeAccountPool.create({
      data: {
        payment_method_code: 'ctbc_pool',
        bank_code: '822',
        bank_name: '測試專屬銀',
        account_number: poolAcct,
        status: 'AVAILABLE'
      }
    });
    createdPoolIds.push(pRow.id);

    const page = await context.newPage();

    // Helper: add product in /preorder checkout
    const addProductAndCheckout = async () => {
      await page.goto(`${BASE_URL}/preorder`, { waitUntil: 'networkidle' });
      const plusBtn = page.locator('button[aria-label="加入 R48質感拼豆組"], button[aria-label="增加 R48質感拼豆組"]').first();
      await plusBtn.waitFor({ state: 'visible', timeout: 10000 });
      await plusBtn.click();
      await page.locator('button:has-text("去結帳")').click();
      await page.waitForURL('**/preorder?view=checkout', { timeout: 10000 });
      await page.locator('text=付款方式').waitFor({ state: 'visible', timeout: 10000 });
    };

    // 1. ONSITE order -> Done view has 到店付款，不用先匯款 and NO fake bank/last5
    await addProductAndCheckout();
    await page.locator('label', { hasText: '到店付款測試' }).click();
    await page.locator('button:has-text("送出預購")').click();
    await page.waitForURL('**/preorder?view=done**', { timeout: 12000 });
    await page.locator('text=到店付款，不用先匯款').waitFor({ state: 'visible', timeout: 8000 });
    const onsiteBody = await page.locator('body').innerText();
    const badFakePrefix = '9012';
    assert.equal(onsiteBody.includes(badFakePrefix), false, 'Should not contain 9012');
    assert.equal(onsiteBody.includes('匯款訂金'), false, 'Should not contain 匯款訂金');
    assert.equal(onsiteBody.includes('末五碼'), false, 'Should not contain 末五碼');
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'round48_shot1_shop_onsite_done.png'), fullPage: true });
    console.log('Shot 1 saved: shop ONSITE done page.');

    // 2. MULTI_BANK order choosing 2nd account -> shown on Done page AND HistoryPage
    await addProductAndCheckout();
    await page.locator('label', { hasText: '一般銀行匯款測試' }).click();
    await page.locator('label', { hasText: acct2 }).click();
    await page.locator('button:has-text("送出預購")').click();
    await page.waitForURL('**/preorder?view=done**', { timeout: 12000 });
    await page.locator(`text=${acct2}`).waitFor({ state: 'visible', timeout: 8000 });
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'round48_shot2_shop_multibank_done.png'), fullPage: true });
    console.log('Shot 2 saved: shop MULTI_BANK done page.');

    await page.locator('button:has-text("查看我的預購")').click();
    await page.waitForURL('**/history?tab=orders', { timeout: 10000 });
    await page.locator(`text=${acct2}`).first().waitFor({ state: 'visible', timeout: 8000 });

    // 3. Pool account exhausted race -> stay on checkout with cart intact and show error
    await addProductAndCheckout();
    await page.locator('label', { has: page.locator('input[value="ctbc_pool"]') }).click();
    await prisma.oneTimeAccountPool.updateMany({
      where: { payment_method_code: 'ctbc_pool', status: 'AVAILABLE' },
      data: { status: 'VOID' }
    });
    await page.locator('button:has-text("送出預購")').click();
    await page.locator('text=剛好發完了').waitFor({ state: 'visible', timeout: 8000 });
    assert.ok(page.url().includes('view=checkout'), 'Must remain on checkout view');
    await page.locator('text=R48質感拼豆組 ×1').waitFor({ state: 'visible', timeout: 5000 });
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'round48_shot3_shop_pool_exhausted.png'), fullPage: true });
    console.log('Shot 3 saved: shop pool exhausted stays on checkout.');
    console.log('Round 48 Item 1 Shop Payment E2E PASSED!');
  } finally {
    await browser.close();
    await cleanOperationalData(prisma);
    await prisma.paymentMethodConfig.deleteMany({ where: { code: { in: [multiCode, onsiteCode] } } }).catch(() => {});
    if (createdPoolMethod) {
      await prisma.paymentMethodConfig.deleteMany({ where: { code: 'ctbc_pool' } }).catch(() => {});
    }
    if (createdPoolIds.length > 0) {
      await prisma.oneTimeAccountPool.deleteMany({ where: { id: { in: createdPoolIds } } }).catch(() => {});
    }
    if (product) await prisma.product.deleteMany({ where: { id: product.id } }).catch(() => {});
    if (customer) await prisma.user.deleteMany({ where: { id: customer.id } }).catch(() => {});
    if (origGlobal) {
      await prisma.globalSetting.update({
        where: { id: 1 },
        data: { shop_enabled: origGlobal.shop_enabled, show_shop_button: origGlobal.show_shop_button }
      }).catch(() => {});
    }
    await prisma.$disconnect();
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
