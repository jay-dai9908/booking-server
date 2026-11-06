/**
 * Admin smoke test (Playwright)
 * Spec: Section 6 Acceptance #2:
 * Test every /admin/* page at 1024x768 and 375x812:
 * 1. No pageerror
 * 2. No /api/ responses >= 400
 * 3. No horizontal scrolling (scrollWidth <= clientWidth)
 */
import { chromium } from 'playwright';

const BASE_URL = process.env.BASE_URL || 'http://localhost:5173';
const HEADLESS = process.env.HEADLESS !== 'false';

const VIEWPORTS = [
  { name: 'tablet', width: 1024, height: 768 },
  { name: 'mobile', width: 375, height: 812 }
];

const ADMIN_ROUTES = [
  '/admin/seating',
  '/admin/sessions',
  '/admin/reservations',
  '/admin/shop',
  '/admin/members',
  '/admin/weekly',
  '/admin/seat-layout',
  '/admin/equipment',
  '/admin/coupons',
  '/admin/accounting',
  '/admin/print-stations',
  '/admin/settings',
  '/admin/staff'
];

export async function runAdminSmoke() {
  console.log(`Starting Admin Smoke Tests on ${BASE_URL} (Headless: ${HEADLESS})...`);

  const browser = await chromium.launch({ headless: HEADLESS });
  let totalErrors = 0;

  try {
    for (const vp of VIEWPORTS) {
      console.log(`\n--- Testing Viewport: ${vp.name} (${vp.width}x${vp.height}) ---`);
      const context = await browser.newContext({
        viewport: { width: vp.width, height: vp.height }
      });

      const page = await context.newPage();

      // Login as admin first or set mock token
      // Listen to page errors
      const pageErrors = [];
      const apiErrors = [];

      page.on('pageerror', (err) => {
        pageErrors.push(err.message || String(err));
      });

      page.on('response', (res) => {
        const url = res.url();
        if (url.includes('/api/') && res.status() >= 400) {
          apiErrors.push({ url, status: res.status() });
        }
      });

      // Login as admin to ensure session
      try {
        await page.goto(`${BASE_URL}/admin/login`, { waitUntil: 'domcontentloaded', timeout: 8000 });
        const usernameInput = page.locator('input[name="username"], input[type="text"]').first();
        const passwordInput = page.locator('input[name="password"], input[type="password"]').first();
        if (await usernameInput.isVisible() && await passwordInput.isVisible()) {
          await usernameInput.fill('admin');
          await passwordInput.fill('admin123');
          await page.keyboard.press('Enter');
          await page.waitForTimeout(1000);
        }
      } catch (e) {
        console.warn(`Admin login skipped or failed: ${e.message}`);
      }

      for (const route of ADMIN_ROUTES) {
        pageErrors.length = 0;
        apiErrors.length = 0;

        const targetUrl = `${BASE_URL}${route}`;
        try {
          await page.goto(targetUrl, { waitUntil: 'networkidle', timeout: 10000 });
        } catch (e) {
          try {
            await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 5000 });
          } catch (err) {
            console.error(`❌ [${vp.name}] Failed to load ${route}: ${err.message}`);
            totalErrors++;
            continue;
          }
        }

        // Check horizontal scroll
        const hasHorizontalScroll = await page.evaluate(() => {
          return document.documentElement.scrollWidth > document.documentElement.clientWidth;
        });

        const hasErrors = pageErrors.length > 0 || apiErrors.length > 0 || hasHorizontalScroll;

        if (hasErrors) {
          console.error(`❌ [${vp.name}] ${route}:`);
          if (pageErrors.length > 0) console.error(`   Page errors:`, pageErrors);
          if (apiErrors.length > 0) console.error(`   API >= 400:`, apiErrors);
          if (hasHorizontalScroll) console.error(`   Horizontal scroll detected!`);
          totalErrors++;
        } else {
          console.log(`✔ [${vp.name}] ${route} passed (no pageerror, no api >= 400, no horizontal scroll)`);
        }
      }

      await context.close();
    }
  } finally {
    await browser.close();
  }

  if (totalErrors > 0) {
    console.error(`\nSmoke tests finished with ${totalErrors} errors.`);
    return false;
  }

  console.log(`\nAll admin smoke tests passed successfully!`);
  return true;
}

if (process.argv[1]?.endsWith('admin-smoke.spec.js')) {
  runAdminSmoke().then(success => {
    process.exit(success ? 0 : 1);
  }).catch(err => {
    console.error(err);
    process.exit(1);
  });
}
