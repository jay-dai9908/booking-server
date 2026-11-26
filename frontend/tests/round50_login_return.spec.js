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
const JWT_SECRET = process.env.JWT_SECRET.trim();
const SCREENSHOT_DIR = process.env.SCREENSHOT_DIR
  ? path.resolve(process.env.SCREENSHOT_DIR)
  : path.resolve(__dirname, 'screenshots');
fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

async function run() {
  console.log('--- Starting Round 50 Login Return & Register Privacy E2E ---');
  await ensureFreshDbSeeded(prisma);
  await cleanOperationalData(prisma);

  const runId = Date.now().toString().slice(-6);
  const lineUserId = `r50_reg_${runId}`;
  const phone = `0961${runId}`;
  let createdUser = null;

  const launchOptions = { headless: HEADLESS };
  if (process.env.PLAYWRIGHT_CHROMIUM_PATH) {
    launchOptions.executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH;
  }
  const browser = await chromium.launch(launchOptions);

  try {
    // 1. Unauthenticated guarded route /history?tab=orders -> redirects to /?next=%2Fhistory%3Ftab%3Dorders
    const guestCtx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const guestPage = await guestCtx.newPage();
    await guestPage.goto(`${BASE_URL}/history?tab=orders`, { waitUntil: 'networkidle' });
    await guestPage.waitForFunction(
      () => window.location.pathname === '/' && new URLSearchParams(window.location.search).get('next') === '/history?tab=orders',
      null,
      { timeout: 8000 }
    );

    // 2. Customer hitting /?next=%2Fhistory%3Ftab%3Dorders redirects straight to /history?tab=orders
    createdUser = await prisma.user.create({
      data: {
        name: 'R50回跳測試客',
        phone: `0962${runId}`,
        line_user_id: `r50_ret_${runId}`
      }
    });
    const custToken = jwt.sign(
      { id: createdUser.id, typ: 'customer', line_user_id: createdUser.line_user_id, role: 'customer', name: createdUser.name },
      JWT_SECRET,
      { expiresIn: '2h' }
    );
    await guestCtx.addCookies([{ name: 'token', value: custToken, domain: 'localhost', path: '/' }]);
    await guestPage.goto(`${BASE_URL}/?next=${encodeURIComponent('/history?tab=orders')}`, { waitUntil: 'networkidle' });
    await guestPage.waitForFunction(
      () => window.location.pathname === '/history' && new URLSearchParams(window.location.search).get('tab') === 'orders',
      null,
      { timeout: 8000 }
    );
    await guestCtx.close();

    // 3. Temp user on /register?next=%2Fshop -> privacy sheet + submit phone -> /shop
    const tempToken = jwt.sign(
      { line_user_id: lineUserId, line_display_name: 'R50新客', isTemp: true, typ: 'line_temp' },
      JWT_SECRET,
      { expiresIn: '30m' }
    );
    const regCtx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await regCtx.addCookies([{ name: 'token', value: tempToken, domain: 'localhost', path: '/' }]);
    const regPage = await regCtx.newPage();
    await regPage.goto(`${BASE_URL}/register?next=${encodeURIComponent('/shop')}`, { waitUntil: 'networkidle' });

    await regPage.getByTestId('open-privacy-notice-btn').click();
    await regPage.getByText('個人資料蒐集告知').waitFor({ state: 'visible', timeout: 5000 });
    await regPage.getByTestId('privacy-notice-content').waitFor({ state: 'visible', timeout: 5000 });
    await regPage.waitForTimeout(350);
    await regPage.screenshot({ path: path.join(SCREENSHOT_DIR, 'round50_shot1_register_privacy.png') });
    await regPage.keyboard.press('Escape');
    await regPage.waitForTimeout(350);

    // 4. Simulate 401 TEMP_SESSION_EXPIRED on /api/auth/register -> Chinese error + re-login button
    await regPage.route('**/api/auth/register', async (route) => {
      await route.fulfill({
        status: 401,
        contentType: 'application/json',
        body: JSON.stringify({ code: 'TEMP_SESSION_EXPIRED', error: '登入工作階段已過期，請重新用 LINE 登入' })
      });
    });
    await regPage.locator('input[placeholder="例如：小美"]').fill('R50小美');
    await regPage.locator('input[type="tel"]').fill(phone);
    await regPage.getByRole('button', { name: '完成綁定，開始預約' }).click();
    await regPage.getByRole('button', { name: '重新用 LINE 登入' }).waitFor({ state: 'visible', timeout: 5000 });
    await regPage.screenshot({ path: path.join(SCREENSHOT_DIR, 'round50_shot2_register_401_relogin.png') });

    // Remove route mock -> real register -> click 開始預約 -> lands on /shop
    await regPage.unroute('**/api/auth/register');
    await regPage.getByRole('button', { name: '完成綁定，開始預約' }).click();
    await regPage.getByRole('button', { name: '開始預約' }).waitFor({ state: 'visible', timeout: 10000 });
    await regPage.getByRole('button', { name: '開始預約' }).click();
    await regPage.waitForFunction(() => window.location.pathname === '/shop', null, { timeout: 10000 });
    const registered = await prisma.user.findUnique({ where: { line_user_id: lineUserId } });
    assert.ok(registered, 'Temp user must be registered in DB');

    await regCtx.close();
    console.log('--- Round 50 Login Return & Register Privacy E2E Passed ---');
  } finally {
    await browser.close();
    await prisma.user.deleteMany({ where: { line_user_id: { in: [lineUserId, `r50_ret_${runId}`] } } });
    await cleanOperationalData(prisma);
    await prisma.$disconnect();
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
