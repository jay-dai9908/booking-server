import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const BASE_URL = process.env.BASE_URL || 'http://localhost:5173';
const SCREENSHOT_DIR = path.resolve('test-results/emergency-hotfix');

if (!fs.existsSync(SCREENSHOT_DIR)) {
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
}

async function run() {
  console.log('--- Starting Emergency Hotfix Playwright Test ---');
  const browser = await chromium.launch({ headless: true });

  const lineUA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Safari/604.1 Line/13.4.1';
  const igUA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 270.0.0.0';

  // 1. LINE UA on '/'
  console.log('Testing LINE UA on /...');
  const lineContext = await browser.newContext({
    viewport: { width: 390, height: 844 },
    userAgent: lineUA,
  });
  const linePage = await lineContext.newPage();
  await linePage.goto(`${BASE_URL}/`, { waitUntil: 'networkidle' });

  // Verify button text
  const lineBtn = linePage.locator('[data-testid="guest-line-login-button"]');
  await lineBtn.waitFor({ state: 'visible', timeout: 10000 });
  const lineBtnText = (await lineBtn.innerText()).trim();
  console.log('LINE page button text:', lineBtnText);
  assert.equal(lineBtnText, '使用 LINE 登入預約');

  // Verify hint text is NOT displayed
  const lineHint = linePage.locator('[data-testid="guest-line-hint-text"]');
  const hasHint = await lineHint.isVisible();
  console.log('LINE page has hint:', hasHint);
  assert.equal(hasHint, false, 'LINE page should not show hint text');

  // Screenshot 1: LINE in '/' (390x844)
  const lineScreenshotPath = path.join(SCREENSHOT_DIR, 'home-in-line.png');
  await linePage.screenshot({ path: lineScreenshotPath });
  console.log('Saved screenshot:', lineScreenshotPath);

  // Click button and verify it attempts navigation to access.line.me, NOT lin.ee
  let targetUrl = '';
  const [navRequest] = await Promise.all([
    linePage.waitForRequest((req) => req.url().includes('line.me'), { timeout: 10000 }).catch(() => null),
    lineBtn.click(),
  ]);
  if (navRequest) {
    targetUrl = navRequest.url();
  } else {
    targetUrl = linePage.url();
  }
  console.log('Navigation target URL:', targetUrl);
  assert.ok(targetUrl.includes('access.line.me'), `Expected access.line.me, got: ${targetUrl}`);
  assert.ok(!targetUrl.includes('lin.ee'), `Should not navigate to lin.ee, got: ${targetUrl}`);

  await lineContext.close();

  // 2. Instagram UA on '/preview'
  console.log('Testing Instagram UA on /preview...');
  const igContext = await browser.newContext({
    viewport: { width: 390, height: 844 },
    userAgent: igUA,
  });
  const igPage = await igContext.newPage();
  await igPage.goto(`${BASE_URL}/preview`, { waitUntil: 'networkidle' });

  // Verify button text & official_line_url
  const igBtn = igPage.locator('[data-testid="guest-line-login-button"]');
  await igBtn.waitFor({ state: 'visible', timeout: 10000 });
  const igBtnText = (await igBtn.innerText()).trim();
  console.log('IG page button text:', igBtnText);
  assert.equal(igBtnText, '加入官方 LINE 預約');

  // Verify hint text is displayed
  const igHint = igPage.locator('[data-testid="guest-line-hint-text"]');
  await igHint.waitFor({ state: 'visible', timeout: 5000 });
  const hintVisible = await igHint.isVisible();
  assert.equal(hintVisible, true, 'IG preview page should show hint text');

  // Verify official_line_url link
  const href = await igBtn.getAttribute('href');
  console.log('IG button href:', href);
  assert.ok(href && (href.includes('lin.ee') || href.includes('line.me')), `Expected official LINE URL, got ${href}`);

  // Screenshot 2: Instagram in '/preview' (390x844)
  const igScreenshotPath = path.join(SCREENSHOT_DIR, 'preview-in-instagram.png');
  await igPage.screenshot({ path: igScreenshotPath });
  console.log('Saved screenshot:', igScreenshotPath);

  // Test "先看看空位" scrolls to date section without page reload / navigation
  const scrollBtn = igPage.locator('[data-testid="preview-scroll-to-slots-button"]');
  await scrollBtn.waitFor({ state: 'visible', timeout: 5000 });

  const initialScrollY = await igPage.evaluate(() => window.scrollY);
  console.log('Initial scroll Y:', initialScrollY);

  await scrollBtn.click();
  // Wait for smooth scroll
  await igPage.waitForTimeout(1000);

  const newScrollY = await igPage.evaluate(() => window.scrollY);
  console.log('New scroll Y after clicking "先看看空位":', newScrollY);
  assert.ok(newScrollY > initialScrollY, `Expected scrollY to increase, was ${initialScrollY} -> ${newScrollY}`);

  // Ensure URL is still /preview (no page change)
  assert.ok(igPage.url().endsWith('/preview'), 'Should stay on /preview');

  await igContext.close();
  await browser.close();
  console.log('--- ALL PLAYWRIGHT HOTFIX TESTS PASSED ---');
}

run().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
