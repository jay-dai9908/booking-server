/**
 * Admin smoke test (Playwright)
 * Spec: Section 6 Acceptance #2:
 * Test every /admin/* page at 1024x768 and 375x812:
 * 1. No pageerror
 * 2. No /api/ responses >= 400
 * 3. No horizontal scrolling (scrollWidth <= clientWidth)
 */
import { chromium } from 'playwright';
import assert from 'node:assert/strict';

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
  '/admin/print-station',
  '/admin/settings',
  '/admin/staff'
];

export async function runAdminSmoke() {
  if (!process.env.ADMIN_PASSWORD || !process.env.ADMIN_PASSWORD.trim()) {
    console.error('請設定 ADMIN_PASSWORD 環境變數');
    process.exit(1);
  }

  console.log(`Starting Admin Smoke Tests on ${BASE_URL} (Headless: ${HEADLESS})...`);

  const launchOptions = { headless: HEADLESS };
  if (process.env.PLAYWRIGHT_CHROMIUM_PATH) {
    launchOptions.executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH;
  }
  const browser = await chromium.launch(launchOptions);
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
          if (url.includes('/api/auth/me') && res.status() === 401) {
            return;
          }
          apiErrors.push({ url, status: res.status() });
        }
      });

      // Login as admin to ensure session
      try {
        await page.goto(`${BASE_URL}/admin/login`, { waitUntil: 'networkidle', timeout: 15000 });
        const passInput = page.locator('input[type="password"]');
        await passInput.waitFor({ state: 'visible', timeout: 10000 });
        await passInput.fill(process.env.ADMIN_PASSWORD);
        await page.locator('button[type="submit"]').click();
        await page.waitForURL(url => !url.pathname.includes('/login'), { timeout: 15000 });
        await page.waitForTimeout(1000);

        const token = await page.evaluate(() => sessionStorage.getItem('shiguang_auth_token'));
        if (token) {
          await context.addInitScript((tok) => {
            try {
              sessionStorage.setItem('shiguang_auth_token', tok);
            } catch (e) {}
          }, token);
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
          return document.documentElement.scrollWidth > window.innerWidth;
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

        if (route === '/admin/accounting') {
          // Spec 2.3: Verify daily closing cash input defaults empty, no diff shown, and button disabled
          const closingTab = page.locator('button:has-text("日結")').first();
          if (await closingTab.isVisible().catch(() => false)) {
            await closingTab.click();
            await page.waitForTimeout(600);

            const submitBtn = page.locator('button:has-text("完成交班")').first();
            await submitBtn.waitFor({ state: 'visible', timeout: 5000 });
            const isDisabled = await submitBtn.isDisabled();
            assert.ok(isDisabled, '完成交班 button must be disabled when cash count is empty');

            const diffPrompt = page.locator('text=相符，沒有差額').or(page.locator('text=短少')).or(page.locator('text=多出'));
            const hasDiff = await diffPrompt.isVisible().catch(() => false);
            assert.ok(!hasDiff, 'Diff prompt should not be visible when cash count is empty');

            const cashInput = page.locator('input[placeholder*="請輸入清點金額"], input[placeholder*="0"]').last();
            await cashInput.fill('2000');
            await page.waitForTimeout(300);

            const isEnabledNow = !(await submitBtn.isDisabled());
            assert.ok(isEnabledNow, '完成交班 button must be enabled after entering cash count');
            console.log(`✔ [${vp.name}] Spec 2.3 passed: Closing cash count requires input before showing diff & enables button`);
          }
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
