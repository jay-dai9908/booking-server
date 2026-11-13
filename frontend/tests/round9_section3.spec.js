import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PrismaClient } from '../../backend/node_modules/@prisma/client/index.js';
import jwt from '../../backend/node_modules/jsonwebtoken/index.js';
import { ensureFreshDbSeeded } from './helpers/seedFreshDb.js';

const BASE_URL = process.env.BASE_URL || 'http://localhost:5173';
const HEADLESS = process.env.HEADLESS !== 'false';
const SCREENSHOT_DIR = path.resolve('test-results/round9-screenshots');

if (!fs.existsSync(SCREENSHOT_DIR)) {
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
}

const testDbUrl = process.env.TEST_DATABASE_URL || 'postgresql://user:password@localhost:5432/booking_db_test?schema=public';
const prisma = new PrismaClient({ datasources: { db: { url: testDbUrl.trim() } } });

const INSTAGRAM_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 300.0';
const MOBILE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1';
const LINE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Safari/604.1 Line/13.2.0';

async function run() {
  console.log('--- Starting Round 9 Section 3 Playwright Tests ---');
  await ensureFreshDbSeeded(prisma);

  const officialLineUrl = 'https://line.me/R/ti/p/@shiguang_test';
  const customHintText = '會打開拾光製所的官方 LINE，從選單點『預約』就能登入';

  // Configure GlobalSetting with official_line_url and guest_line_hint_text
  await prisma.globalSetting.upsert({
    where: { id: 1 },
    update: {
      official_line_url: officialLineUrl,
      guest_line_hint_text: customHintText,
    },
    create: {
      id: 1,
      official_line_url: officialLineUrl,
      guest_line_hint_text: customHintText,
    },
  });

  const launchOptions = { headless: HEADLESS };
  if (process.env.PLAYWRIGHT_CHROMIUM_PATH) {
    launchOptions.executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH;
  }

  const browser = await chromium.launch(launchOptions);

  try {
    // -------------------------------------------------------------
    // Test 1: Instagram in-app browser UA on unauthenticated pages
    // -------------------------------------------------------------
    console.log('Testing Instagram in-app browser on unauthenticated pages...');
    const igContext = await browser.newContext({
      viewport: { width: 375, height: 812 },
      userAgent: INSTAGRAM_UA,
      isMobile: true,
      hasTouch: true,
    });
    const igPage = await igContext.newPage();

    // 1. Home page ('/')
    await igPage.goto(`${BASE_URL}/`, { waitUntil: 'networkidle' });
    const homeLineBtn = igPage.locator('a:has-text("加入官方 LINE 預約"), button:has-text("加入官方 LINE 預約")').first();
    await homeLineBtn.waitFor({ state: 'visible', timeout: 8000 });

    const homeHref = await homeLineBtn.getAttribute('href');
    const homeTarget = await homeLineBtn.getAttribute('target');
    assert.strictEqual(homeHref, officialLineUrl, 'Home LINE button href must be official_line_url');
    assert.strictEqual(homeTarget, '_blank', 'Home LINE button target must be _blank');

    // Sub-hint text
    const homeHint = igPage.locator(`text=${customHintText}`).first();
    await homeHint.waitFor({ state: 'visible', timeout: 5000 });

    // Capture required screenshot: section3-line-btn-ig.png
    const igScreenshotPath = path.join(SCREENSHOT_DIR, 'section3-line-btn-ig.png');
    await igPage.screenshot({ path: igScreenshotPath });
    console.log(`Saved screenshot to ${igScreenshotPath}`);

    // 2. Preview page ('/preview')
    await igPage.goto(`${BASE_URL}/preview`, { waitUntil: 'networkidle' });
    const previewLineBtn = igPage.locator('a:has-text("加入官方 LINE 預約"), button:has-text("加入官方 LINE 預約")').first();
    await previewLineBtn.waitFor({ state: 'visible', timeout: 8000 });

    const previewHref = await previewLineBtn.getAttribute('href');
    const previewTarget = await previewLineBtn.getAttribute('target');
    assert.strictEqual(previewHref, officialLineUrl, 'Preview LINE button href must be official_line_url');
    assert.strictEqual(previewTarget, '_blank', 'Preview LINE button target must be _blank');

    const previewHint = igPage.locator(`text=${customHintText}`).first();
    await previewHint.waitFor({ state: 'visible', timeout: 5000 });

    // 3. Shop page ('/shop')
    await igPage.goto(`${BASE_URL}/shop`, { waitUntil: 'networkidle' });
    const shopLineBtn = igPage.locator('a:has-text("加入官方 LINE 預約"), button:has-text("加入官方 LINE 預約")').first();
    await shopLineBtn.waitFor({ state: 'visible', timeout: 8000 });

    const shopHref = await shopLineBtn.getAttribute('href');
    const shopTarget = await shopLineBtn.getAttribute('target');
    assert.strictEqual(shopHref, officialLineUrl, 'Shop LINE button href must be official_line_url');
    assert.strictEqual(shopTarget, '_blank', 'Shop LINE button target must be _blank');

    await igContext.close();
    console.log('PASS: Instagram UA verified on /, /preview, /shop');

    // -------------------------------------------------------------
    // Test 2: Standard mobile browser on unauthenticated pages
    // -------------------------------------------------------------
    console.log('Testing standard mobile browser...');
    const mobileContext = await browser.newContext({
      viewport: { width: 375, height: 812 },
      userAgent: MOBILE_UA,
      isMobile: true,
      hasTouch: true,
    });
    const mobilePage = await mobileContext.newPage();

    await mobilePage.goto(`${BASE_URL}/preview`, { waitUntil: 'networkidle' });
    const mobLineBtn = mobilePage.locator('a:has-text("加入官方 LINE 預約"), button:has-text("加入官方 LINE 預約")').first();
    await mobLineBtn.waitFor({ state: 'visible', timeout: 8000 });
    assert.strictEqual(await mobLineBtn.getAttribute('href'), officialLineUrl);
    assert.strictEqual(await mobLineBtn.getAttribute('target'), '_blank');

    await mobileContext.close();
    console.log('PASS: Standard mobile browser verified');

    // -------------------------------------------------------------
    // Test 3: Authenticated customer is unaffected
    // -------------------------------------------------------------
    console.log('Testing authenticated customer is unaffected...');
    let customer = await prisma.user.findFirst();
    if (!customer) {
      customer = await prisma.user.create({
        data: {
          line_user_id: `line_sec3_${Date.now()}`,
          name: 'Section3 Customer',
          phone: '0912345678',
        },
      });
    }
    let customerToken = null;
    try {
      const loginRes = await fetch(`${process.env.API_BASE_URL || 'http://localhost:3001'}/api/auth/test-login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: customer.id, role: 'customer' })
      });
      if (loginRes.ok) {
        const data = await loginRes.json();
        customerToken = data.token;
      }
    } catch (e) {}

    if (!customerToken) {
      if (!process.env.JWT_SECRET?.trim()) {
        console.error('請設定 JWT_SECRET 環境變數');
        process.exit(1);
      }
      customerToken = jwt.sign(
        { id: customer.id, role: 'customer', name: customer.name || 'Test' },
        process.env.JWT_SECRET.trim(),
        { expiresIn: '1h' }
      );
    }

    await prisma.globalSetting.update({
      where: { id: 1 },
      data: { require_line_login_every_time: false },
    });

    const authContext = await browser.newContext({
      viewport: { width: 375, height: 812 },
    });
    await authContext.addInitScript((token) => {
      localStorage.setItem('shiguang_auth_token', token);
      sessionStorage.setItem('shiguang_auth_token', token);
      sessionStorage.setItem('shiguang_line_fresh_login', '1');
    }, customerToken);

    const authPage = await authContext.newPage();
    authPage.on('console', (msg) => console.log('[authPage]', msg.type(), msg.text()));
    authPage.on('response', (res) => {
      if (res.url().includes('/auth/me')) {
        console.log('[authPage response /auth/me]', res.status());
      }
    });
    await authPage.goto(`${BASE_URL}/shop`, { waitUntil: 'networkidle' });

    // In authenticated shop, bottom tab bar is visible, guest login button should not be present
    const tabBar = authPage.locator('nav').first();
    await tabBar.waitFor({ state: 'visible', timeout: 8000 });
    const guestBtnInAuth = authPage.locator('a:has-text("加入官方 LINE 預約"), button:has-text("加入官方 LINE 預約")');
    assert.strictEqual(await guestBtnInAuth.count(), 0, 'Guest line button should not appear for authenticated customer in shop');

    await authContext.close();
    console.log('PASS: Authenticated customer is unaffected');

    // -------------------------------------------------------------
    // Test 3b: /preorder (LINE entry) shows direct login button even when official_line_url is set,
    // while /shop in external browser still guides to official LINE
    // -------------------------------------------------------------
    console.log('Testing /preorder vs /shop unauthenticated button behavior...');
    const shopPreviewContext = await browser.newContext({
      viewport: { width: 390, height: 844 },
      userAgent: MOBILE_UA,
      isMobile: true,
      hasTouch: true,
    });
    const shopPreviewPage = await shopPreviewContext.newPage();
    await shopPreviewPage.goto(`${BASE_URL}/shop`, { waitUntil: 'networkidle' });
    const shopPlusBtn = shopPreviewPage.locator('button[aria-label^="增加"]').first();
    await shopPlusBtn.waitFor({ state: 'visible', timeout: 8000 });
    await shopPlusBtn.click();
    const shopCheckoutOaBtn = shopPreviewPage.locator('[aria-label="結帳與金額列"] a:has-text("加入官方 LINE 預約"), [aria-label="結帳與金額列"] button:has-text("加入官方 LINE 預約")').first();
    await shopCheckoutOaBtn.waitFor({ state: 'visible', timeout: 5000 });
    assert.strictEqual(await shopCheckoutOaBtn.getAttribute('href'), officialLineUrl, '/shop in external browser must still link to official_line_url after adding item');
    await shopPreviewContext.close();

    const preorderContext = await browser.newContext({
      viewport: { width: 390, height: 844 },
      userAgent: LINE_UA,
      isMobile: true,
      hasTouch: true,
    });
    const preorderPage = await preorderContext.newPage();
    await preorderPage.goto(`${BASE_URL}/preorder`, { waitUntil: 'networkidle' });

    // Empty cart -> login button ("使用 LINE 登入預購") without OA link or hint
    const emptyPreorderBtn = preorderPage.locator('[data-testid="guest-line-login-button"]').first();
    await emptyPreorderBtn.waitFor({ state: 'visible', timeout: 8000 });
    assert.strictEqual((await emptyPreorderBtn.innerText()).trim(), '使用 LINE 登入預購');
    assert.ok(!(await emptyPreorderBtn.getAttribute('href')), '/preorder empty cart login button must not link to official_line_url');
    assert.strictEqual(await preorderPage.locator(`text=${customHintText}`).count(), 0, '/preorder must not show official LINE redirect hint');

    // Add 1 item -> BottomActionBar shows "登入進行購買" without OA link or hint
    const preorderPlusBtn = preorderPage.locator('button[aria-label^="增加"]').first();
    await preorderPlusBtn.click();
    const buyLoginBtn = preorderPage.locator('[aria-label="結帳與金額列"] button:has-text("登入進行購買")').first();
    await buyLoginBtn.waitFor({ state: 'visible', timeout: 5000 });
    assert.ok(!(await buyLoginBtn.getAttribute('href')), '/preorder purchase button must not link to official_line_url');
    assert.strictEqual(await preorderPage.locator(`text=${customHintText}`).count(), 0, '/preorder cart bar must not show official LINE redirect hint');

    await preorderPage.waitForTimeout(200);
    await preorderPage.screenshot({ path: path.join(SCREENSHOT_DIR, 'preorder-line-login-mobile.png') });

    // Clicking "登入進行購買" initiates LINE OAuth with preorder_ state (not official_line_url)
    let interceptedLineOAuthUrl = '';
    await preorderPage.route('https://access.line.me/**', (route) => {
      interceptedLineOAuthUrl = route.request().url();
      route.fulfill({ status: 200, contentType: 'text/html', body: '<html><body>LINE OAuth Redirect Mock</body></html>' });
    });
    await buyLoginBtn.click();
    await preorderPage.waitForTimeout(300);
    if (interceptedLineOAuthUrl) {
      assert.ok(interceptedLineOAuthUrl.includes('state=preorder_'), `Expected LINE OAuth URL with state=preorder_, got ${interceptedLineOAuthUrl}`);
    }

    await preorderContext.close();
    console.log('PASS: /preorder login-to-purchase & /shop OA preview verified');

    // -------------------------------------------------------------
    // Test 4: Unset official_line_url falls back with console.warn
    // -------------------------------------------------------------
    console.log('Testing fallback when official_line_url is unset...');
    await prisma.globalSetting.update({
      where: { id: 1 },
      data: { official_line_url: null },
    });

    const fallbackContext = await browser.newContext({
      viewport: { width: 375, height: 812 },
    });
    const fallbackPage = await fallbackContext.newPage();

    const consoleWarnings = [];
    fallbackPage.on('console', (msg) => {
      if (msg.type() === 'warning') {
        consoleWarnings.push(msg.text());
      }
    });

    await fallbackPage.goto(`${BASE_URL}/preview`, { waitUntil: 'networkidle' });
    const fallbackBtn = fallbackPage.locator('button:has-text("加入官方 LINE 預約"), a:has-text("加入官方 LINE 預約")').first();
    await fallbackBtn.waitFor({ state: 'visible', timeout: 8000 });

    // Without official_line_url, href should be absent or button
    const fallbackHref = await fallbackBtn.getAttribute('href');
    assert.ok(!fallbackHref, 'Fallback button should not have an external href when unset');

    await fallbackBtn.click();
    await fallbackPage.waitForTimeout(500);

    const hasWarn = consoleWarnings.some((w) => w.includes('official_line_url is not configured, falling back to LINE Login'));
    assert.ok(hasWarn, 'Must log warning when official_line_url is unset');

    await fallbackContext.close();
    console.log('PASS: Fallback to LINE OAuth with warning verified');

    // Restore official_line_url for other test runs
    await prisma.globalSetting.update({
      where: { id: 1 },
      data: { official_line_url: officialLineUrl },
    });

    console.log('--- Round 9 Section 3 Playwright Tests Finished Successfully ---');
  } finally {
    await browser.close();
    await prisma.$disconnect();
  }
}

run().catch((err) => {
  console.error('Test run failed:', err);
  process.exit(1);
});
