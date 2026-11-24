import { chromium } from 'playwright';
import assert from 'node:assert/strict';

const BASE_URL = process.env.BASE_URL || 'http://localhost:5173';
const HEADLESS = process.env.HEADLESS !== 'false';

async function run() {
  console.log('--- Starting Round 32 Item 1 LINE OAuth State Playwright Test ---');

  const launchOptions = { headless: HEADLESS };
  if (process.env.PLAYWRIGHT_CHROMIUM_PATH) {
    launchOptions.executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH;
  }

  const browser = await chromium.launch(launchOptions);
  try {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await context.newPage();

    console.log('1. Opening /?code=fake&state=fake without sg_line_state cookie...');
    await page.goto(`${BASE_URL}/?code=fake&state=fake`, { waitUntil: 'networkidle' });

    const retryBtn = page.locator('[data-testid="retry-line-login-btn"]');
    await retryBtn.waitFor({ state: 'visible', timeout: 8000 });
    const retryBtnText = await retryBtn.innerText();
    assert.ok(retryBtnText.includes('再按一次 LINE 登入'), `Unexpected button text: ${retryBtnText}`);

    const alertBanner = page.locator('[role="alert"]');
    await alertBanner.waitFor({ state: 'visible', timeout: 5000 });
    const alertText = await alertBanner.innerText();
    assert.ok(alertText.includes('請再按一次 LINE 登入'), `Expected LINE_STATE_INVALID message, got: ${alertText}`);

    const currentPath = new URL(page.url()).pathname;
    assert.equal(currentPath, '/', `Expected to stay on /, got ${currentPath}`);

    const tokenInStorage = await page.evaluate(() => sessionStorage.getItem('shiguang_auth_token'));
    assert.equal(tokenInStorage, null, 'Expected user to remain logged out');

    await context.close();
    console.log('✅ Round 32 Item 1 LINE OAuth State Playwright Test PASSED!');
  } finally {
    await browser.close();
  }
}

run().catch((err) => {
  console.error('❌ Round 32 Item 1 LINE OAuth State Playwright Test Failed:', err);
  process.exit(1);
});
