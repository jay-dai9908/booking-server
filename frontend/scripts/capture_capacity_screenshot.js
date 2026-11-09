import { chromium } from 'playwright';
import path from 'path';
import fs from 'fs';

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2
  });
  const page = await context.newPage();

  // 1. Login
  await page.goto('http://localhost:5173/admin/login', { waitUntil: 'networkidle' });
  const passInput = page.locator('input[type="password"]');
  await passInput.fill('gathering.light2609');
  await page.locator('button[type="submit"]').click();
  await page.waitForURL(url => !url.pathname.includes('/login'), { timeout: 15000 });
  await page.waitForTimeout(1000);

  // 2. Go to /admin/sessions
  await page.goto('http://localhost:5173/admin/sessions', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);

  // 3. Find the capacity input
  const capacityInput = page.locator('input[data-testid="session-capacity-input"]');
  await capacityInput.waitFor({ state: 'visible', timeout: 5000 });

  // Type a capacity that exceeds seatCount (e.g. 20)
  await capacityInput.fill('20');
  await page.waitForTimeout(500);

  // Wait for the warning message
  const warning = page.locator('p[data-testid="capacity-exceed-warning"]');
  await warning.waitFor({ state: 'visible', timeout: 5000 });

  // Scroll so the input and warning are nicely in view (centered in viewport)
  await page.evaluate(() => {
    const el = document.querySelector('input[data-testid="session-capacity-input"]');
    if (el) {
      el.scrollIntoView({ behavior: 'instant', block: 'center' });
    }
  });
  await page.waitForTimeout(500);

  const outDir = path.resolve('frontend/test-results/capacity-decoupling');
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }
  const screenshotPath = path.join(outDir, 'sessions-page-capacity-warning.png');
  await page.screenshot({ path: screenshotPath, fullPage: false });
  console.log('Screenshot saved to:', screenshotPath);

  await browser.close();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
