/**
 * Layout Edge & Boundary Automated Verification (Playwright)
 * Spec: admin-fix-prompt-5.md Section 6.7, Section 1.3
 *
 * Viewports: 360x780, 390x844, 768x1024
 * Checks:
 * 1. document.documentElement.scrollWidth <= window.innerWidth (no horizontal scroll)
 * 2. Margin >= 12px from viewport edges for non-full-width elements
 * 3. Buttons have single-line height / no wrapped button text
 * 4. No undefined, NaN, null, or blank time strings in rendered content
 * 5. Brand two-line header on mobile ("拾光製所" + page subtitle)
 */
import { chromium } from 'playwright';
import assert from 'node:assert/strict';

const BASE_URL = process.env.BASE_URL || 'http://localhost:5173';
const HEADLESS = process.env.HEADLESS !== 'false';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'gathering.light2609';

const VIEWPORTS = [
  { name: 'phone-narrow', width: 360, height: 780, isMobile: true },
  { name: 'phone-standard', width: 390, height: 844, isMobile: true },
  { name: 'tablet', width: 768, height: 1024, isMobile: false }
];

const CUSTOMER_PAGES = [
  { route: '/preview', expectedSubtitle: '拼豆時段預覽' },
  { route: '/booking', expectedSubtitle: '預約時段' },
  { route: '/history', expectedSubtitle: '我的會員' },
  { route: '/shop', expectedSubtitle: '商品預購' },
  { route: '/register', expectedSubtitle: '綁定會員' }
];

const ADMIN_PAGES = [
  { route: '/admin/seating', expectedTitle: '今日帶位' },
  { route: '/admin/reservations', expectedTitle: '預約訂單總覽' },
  { route: '/admin/sessions', expectedTitle: '營業時段設定' },
  { route: '/admin/accounting', expectedTitle: '帳務管理' },
  { route: '/admin/members', expectedTitle: '會員管理' },
  { route: '/admin/weekly', expectedTitle: '周營業狀況' },
  { route: '/admin/seat-layout', expectedTitle: '座位設定' },
  { route: '/admin/print-station', expectedTitle: '列印站' },
  { route: '/admin/settings', expectedTitle: '系統設定' },
  { route: '/admin/staff', expectedTitle: '員工管理' },
  { route: '/admin/shop', expectedTitle: '商品管理' },
  { route: '/admin/coupons', expectedTitle: '票券核銷' },
  { route: '/admin/equipment', expectedTitle: '設備租借' }
];

const FORBIDDEN_TEXT_PATTERNS = [
  /\bundefined\b/,
  /\bNaN\b/,
  /\bnull\b/,
  /·\s*到/,
  /未定\s*·\s*1\s*小時/,
  /undefined\s*到/
];

export async function runLayoutEdgesTest() {
  console.log(`Starting Layout Edges Verification on ${BASE_URL}...`);
  const launchOptions = { headless: HEADLESS };
  if (process.env.PLAYWRIGHT_CHROMIUM_PATH) {
    launchOptions.executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH;
  }

  const browser = await chromium.launch(launchOptions);
  let failures = [];

  try {
    for (const vp of VIEWPORTS) {
      console.log(`\n========================================`);
      console.log(` Testing Viewport: ${vp.name} (${vp.width}x${vp.height})`);
      console.log(`========================================`);

      const context = await browser.newContext({
        viewport: { width: vp.width, height: vp.height }
      });
      const page = await context.newPage();

      // Listen for unhandled errors
      page.on('pageerror', (err) => {
        console.error(`  [Page Error] ${err.message}`);
      });

      // 1. Customer Pages Verification
      console.log(`\n--- [${vp.name}] Customer Pages ---`);
      for (const item of CUSTOMER_PAGES) {
        try {
          await page.goto(`${BASE_URL}${item.route}`, { waitUntil: 'domcontentloaded', timeout: 20000 });
          await page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => {});
          await page.waitForTimeout(600);

          // a. Horizontal Scroll check
          const scrollInfo = await page.evaluate(() => ({
            scrollWidth: document.documentElement.scrollWidth,
            innerWidth: window.innerWidth,
            bodyScrollWidth: document.body.scrollWidth
          }));

          if (scrollInfo.scrollWidth > scrollInfo.innerWidth + 1) {
            failures.push(`[${vp.name}] ${item.route}: Horizontal scroll detected (scrollWidth=${scrollInfo.scrollWidth}, innerWidth=${scrollInfo.innerWidth})`);
          }

          // b. Forbidden strings check
          const bodyText = await page.evaluate(() => document.body.innerText || '');
          for (const pattern of FORBIDDEN_TEXT_PATTERNS) {
            if (pattern.test(bodyText)) {
              failures.push(`[${vp.name}] ${item.route}: Found forbidden text matching ${pattern}`);
            }
          }

          // c. Button text wrapping & heights
          const buttonViolations = await page.evaluate(() => {
            const badButtons = [];
            const buttons = document.querySelectorAll('button');
            buttons.forEach((btn) => {
              if (btn.offsetParent === null) return; // hidden
              const rect = btn.getBoundingClientRect();
              // A single-line button shouldn't be taller than 60px unless it's a card-like selector
              const isCardButton = btn.classList.contains('flex-col') || btn.classList.contains('items-start') || btn.classList.contains('grid') || Boolean(btn.closest('[role="region"]'));
              if (!isCardButton && rect.height > 60) {
                badButtons.push({
                  text: (btn.innerText || '').slice(0, 30),
                  height: rect.height
                });
              }
            });
            return badButtons;
          });

          if (buttonViolations.length > 0) {
            failures.push(`[${vp.name}] ${item.route}: Button wrapping detected: ${JSON.stringify(buttonViolations)}`);
          }

          // d. Header check (Section 1.1 & 1.3)
          if (vp.isMobile) {
            const headerCheck = await page.evaluate(() => {
              const spans = Array.from(document.querySelectorAll('header span'));
              const brand = spans.find(s => s.classList.contains('font-display') || (s.innerText && s.innerText.includes('拾光製所')));
              const subtitle = document.querySelector('header span.text-sg-muted') || document.querySelector('header .text-sg-muted');
              return {
                brandText: brand ? brand.innerText.trim() : null,
                subtitleText: subtitle ? subtitle.innerText.trim() : null
              };
            });

            if (headerCheck.brandText && !headerCheck.brandText.includes('拾光製所')) {
              failures.push(`[${vp.name}] ${item.route}: Header brand is "${headerCheck.brandText}", expected "拾光製所"`);
            }
            if (item.expectedSubtitle && headerCheck.subtitleText && !headerCheck.subtitleText.includes(item.expectedSubtitle)) {
              failures.push(`[${vp.name}] ${item.route}: Header subtitle is "${headerCheck.subtitleText}", expected "${item.expectedSubtitle}"`);
            }
          }

          console.log(`  ✔ Customer ${item.route} verified`);
        } catch (err) {
          failures.push(`[${vp.name}] ${item.route} crashed: ${err.message}`);
        }
      }

      // 2. Admin Login
      await page.goto(`${BASE_URL}/admin/login`, { waitUntil: 'networkidle', timeout: 15000 });
      const passInput = page.locator('input[type="password"]');
      if (await passInput.isVisible({ timeout: 5000 })) {
        await passInput.fill(ADMIN_PASSWORD);
        await page.locator('button[type="submit"]').click();
        await page.waitForURL(url => !url.pathname.includes('/login'), { timeout: 15000 });
        await page.waitForTimeout(600);
      }
      assert.ok(!page.url().includes('/login'), `Admin login failed on viewport ${vp.name}; URL is ${page.url()}`);

      const token = await page.evaluate(() => sessionStorage.getItem('shiguang_auth_token'));
      if (token) {
        await context.addInitScript((tok) => {
          try {
            sessionStorage.setItem('shiguang_auth_token', tok);
          } catch (e) {}
        }, token);
      }

      // 3. Admin Pages Verification
      console.log(`\n--- [${vp.name}] Admin Pages ---`);
      for (const item of ADMIN_PAGES) {
        try {
          await page.goto(`${BASE_URL}${item.route}`, { waitUntil: 'domcontentloaded', timeout: 20000 });
          await page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => {});
          await page.waitForTimeout(600);
          if (page.url().includes('/login')) {
            failures.push(`[${vp.name}] ${item.route}: Redirected to /login (session lost)`);
            continue;
          }

          // a. Horizontal scroll check
          const scrollInfo = await page.evaluate(() => ({
            scrollWidth: document.documentElement.scrollWidth,
            innerWidth: window.innerWidth,
            bodyScrollWidth: document.body.scrollWidth
          }));

          if (scrollInfo.scrollWidth > scrollInfo.innerWidth + 1) {
            failures.push(`[${vp.name}] ${item.route}: Horizontal scroll detected (scrollWidth=${scrollInfo.scrollWidth}, innerWidth=${scrollInfo.innerWidth})`);
          }

          // b. Forbidden strings check
          const bodyText = await page.evaluate(() => document.body.innerText || '');
          for (const pattern of FORBIDDEN_TEXT_PATTERNS) {
            if (pattern.test(bodyText)) {
              failures.push(`[${vp.name}] ${item.route}: Found forbidden text matching ${pattern}`);
            }
          }

          // c. Button text wrapping
          const buttonViolations = await page.evaluate(() => {
            const badButtons = [];
            const buttons = document.querySelectorAll('button');
            buttons.forEach((btn) => {
              if (btn.offsetParent === null) return;
              const rect = btn.getBoundingClientRect();
              const isCardButton = btn.classList.contains('flex-col') || btn.classList.contains('items-start');
              if (!isCardButton && rect.height > 60) {
                badButtons.push({
                  text: (btn.innerText || '').slice(0, 30),
                  height: rect.height
                });
              }
            });
            return badButtons;
          });

          if (buttonViolations.length > 0) {
            failures.push(`[${vp.name}] ${item.route}: Button wrapping detected: ${JSON.stringify(buttonViolations)}`);
          }

          // d. Page Edge Margins (Section 6.1: elements >= 12px from edge unless full-width)
          const marginViolations = await page.evaluate((isNarrowMobile) => {
            const badElements = [];
            const vw = window.innerWidth;
            // Query main content cards and buttons
            const elements = document.querySelectorAll('main .rounded-2xl, main .rounded-3xl, main [role="tablist"]');
            elements.forEach((el) => {
              if (el.offsetParent === null) return;
              // Ignore full-width / table horizontal scrolls
              if (el.classList.contains('overflow-x-auto') || el.classList.contains('no-scrollbar') || el.closest('.overflow-x-auto')) return;
              const rect = el.getBoundingClientRect();
              if (rect.width < 50 || rect.height < 20) return;
              if (rect.left < 11 || rect.right > vw - 11) {
                badElements.push({
                  tag: el.tagName,
                  classes: el.className.slice(0, 50),
                  left: Math.round(rect.left),
                  right: Math.round(rect.right),
                  vw
                });
              }
            });
            return badElements.slice(0, 3);
          }, vp.isMobile);

          if (marginViolations.length > 0) {
            failures.push(`[${vp.name}] ${item.route}: Elements too close to edge (<12px): ${JSON.stringify(marginViolations)}`);
          }

          console.log(`  ✔ Admin ${item.route} verified`);
        } catch (err) {
          failures.push(`[${vp.name}] ${item.route} crashed: ${err.message}`);
        }
      }

      await context.close();
    }

    if (failures.length > 0) {
      console.error('\n❌ Layout edge verification detected failures:');
      failures.forEach((f, idx) => console.error(`  ${idx + 1}. ${f}`));
      assert.fail(`Layout edge verification failed with ${failures.length} errors`);
    } else {
      console.log('\n🎉 ALL LAYOUT EDGE & MARGIN CHECKS PASSED (360px, 390px, 768px)!');
    }
  } finally {
    await browser.close();
  }
}

// Allow direct run
if (process.argv[1]?.endsWith('layout-edges.spec.js')) {
  runLayoutEdgesTest().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
