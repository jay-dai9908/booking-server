import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PrismaClient } from '../../backend/node_modules/@prisma/client/index.js';
import jwt from '../../backend/node_modules/jsonwebtoken/index.js';
import { ensureFreshDbSeeded } from './helpers/seedFreshDb.js';
import { toTaipeiDateString } from '../../shared/time.js';

const BASE_URL = process.env.BASE_URL || 'http://localhost:5173';
const API_BASE = process.env.API_BASE || 'http://localhost:3001/api';
const HEADLESS = process.env.HEADLESS !== 'false';
const SCREENSHOT_DIR = path.resolve('test-results/round9-screenshots');

if (!fs.existsSync(SCREENSHOT_DIR)) {
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
}

const testDbUrl = process.env.TEST_DATABASE_URL || 'postgresql://user:password@localhost:5432/booking_db_test?schema=public';
const prisma = new PrismaClient({ datasources: { db: { url: testDbUrl.trim() } } });

async function run() {
  console.log('--- Starting Round 9 Section 1 Playwright Tests ---');
  await ensureFreshDbSeeded(prisma);

  // Generate customer token
  const customerToken = jwt.sign(
    { id: 1, role: 'customer', name: '測試客', phone: '0912345678' },
    process.env.JWT_SECRET || 'super_secret_jwt_key_for_booking_system',
    { expiresIn: '1d' }
  );

  const launchOptions = { headless: HEADLESS };
  if (process.env.PLAYWRIGHT_CHROMIUM_PATH) {
    launchOptions.executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH;
  }
  const browser = await chromium.launch(launchOptions);

  // Mobile viewport: 375x812
  const context = await browser.newContext({
    viewport: { width: 375, height: 812 },
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148'
  });

  await context.addInitScript((tok) => {
    try {
      sessionStorage.setItem('shiguang_auth_token', tok);
    } catch (e) {}
  }, customerToken);

  const page = await context.newPage();

  const pageErrors = [];
  page.on('pageerror', (err) => {
    console.error('Page error:', err.message || err);
    pageErrors.push(err.message || String(err));
  });

  try {
    // 1. Prepare today's sessions: 13:00 to 21:00 (8 slots: 13:00, 14:00, 15:00, 16:00, 17:00, 18:00, 19:00, 20:00)
    const todayStr = toTaipeiDateString(new Date());
    const todayDate = new Date(`${todayStr}T00:00:00.000Z`);

    // Clean existing sessions for today and create 13:00-21:00 sessions
    await prisma.session.deleteMany({ where: { session_date: todayDate } });
    const slotTimes = [
      ['13:00', '14:00'],
      ['14:00', '15:00'],
      ['15:00', '16:00'],
      ['16:00', '17:00'],
      ['17:00', '18:00'],
      ['18:00', '19:00'],
      ['19:00', '20:00'],
      ['20:00', '21:00']
    ];
    for (const [st, et] of slotTimes) {
      await prisma.session.create({
        data: {
          session_date: todayDate,
          start_time: st,
          end_time: et,
          max_capacity: 20
        }
      });
    }

    // Set initial draft for unlimited booking 13:00 to 21:00
    const draft = {
      date: todayStr,
      mode: 'unlimited',
      arrival: 0,
      leave: 8,
      pax: 1,
      units: [],
      customerNote: '',
      promo: null,
      savedAt: Date.now()
    };

    await context.addInitScript((draftData) => {
      try {
        sessionStorage.setItem('shiguang_booking_draft', JSON.stringify(draftData));
      } catch (e) {}
    }, draft);

    console.log('Navigating to /booking?step=2...');
    await page.goto(`${BASE_URL}/booking?step=2`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1000);

    // Verify description text
    const descLocator = page.locator('text=只有需要的人租就好，同一時間最多 1 台；可以分段租不同尺寸');
    await descLocator.waitFor({ state: 'visible', timeout: 5000 });
    console.log('✔ Description text verified');

    // Find small board and medium board
    // Small board card: click + to add small board
    console.log('Adding small board...');
    const smallAddBtn = page.locator('button[aria-label="增加小板"]');
    await smallAddBtn.waitFor({ state: 'visible', timeout: 5000 });
    await smallAddBtn.click();
    await page.waitForTimeout(500);

    // The small board defaults to from=0, to=8 (13:00 to 21:00)
    // Let's use keyboard ArrowLeft on handle-end to move from 21:00 to 17:00 (index 8 to 4)
    const rightHandle = page.locator('[data-testid="handle-end"]').first();
    await rightHandle.waitFor({ state: 'visible', timeout: 5000 });
    await rightHandle.focus();
    for (let i = 0; i < 4; i++) {
      await page.keyboard.press('ArrowLeft');
      await page.waitForTimeout(100);
    }
    await page.waitForTimeout(400);

    // Now small board is 13:00 to 17:00. Remaining free slots: 17:00 to 21:00.
    // Now click + on medium board
    console.log('Adding medium board...');
    const medAddBtn = page.locator('button[aria-label="增加中板"]');
    assert.ok(!(await medAddBtn.isDisabled()), 'Medium board + button should be enabled when free slots exist');
    await medAddBtn.click();
    await page.waitForTimeout(600);

    // Verify medium board defaults to 17:00 到 21:00
    const medTimeText = page.locator('text=17:00 到 21:00');
    await medTimeText.waitFor({ state: 'visible', timeout: 5000 });
    console.log('✔ Medium board defaulted to 17:00 到 21:00');

    // Now all slots 13:00-21:00 are covered by small board (13-17) and medium board (17-21).
    // Verify that adding any board is now disabled with "每個時段都已經有板子了"
    const fullHint = page.locator('text=每個時段都已經有板子了').first();
    await fullHint.waitFor({ state: 'visible', timeout: 5000 });
    console.log('✔ Full slots hint "每個時段都已經有板子了" verified');

    // Take mobile screenshot for Section 1 consecutive boards
    const shot1Path = path.join(SCREENSHOT_DIR, 'section1-consecutive-boards.png');
    await page.screenshot({ path: shot1Path });
    console.log(`Saved screenshot: ${shot1Path}`);

    // Test "剩下的時間不到 2 小時" hint:
    // Move medium board end handle from 21:00 back to 20:00 (1 hour remaining: 20:00 to 21:00)
    const medSliders = page.locator('[data-testid="handle-end"]');
    const medEndHandle = medSliders.nth(1);
    if (await medEndHandle.isVisible()) {
      await medEndHandle.focus();
      await page.keyboard.press('ArrowLeft');
      await page.waitForTimeout(400);

      const shortHint = page.locator('text=剩下的時間不到 2 小時').first();
      await shortHint.waitFor({ state: 'visible', timeout: 5000 });
      console.log('✔ Remaining time < 2h hint "剩下的時間不到 2 小時" verified');

      // Move back to 21:00
      await page.keyboard.press('ArrowRight');
      await page.waitForTimeout(400);
    }

    // Now proceed to Step 3 (Confirmation page)
    console.log('Clicking "下一步" to StepConfirm...');
    const nextBtn = page.locator('button:has-text("下一步")');
    await nextBtn.click();
    await page.waitForTimeout(1000);

    // Verify StepConfirm displays actual usage hours and discount note:
    // 13:00 到 17:00 · 4 小時
    // 買三送一，以 3 小時計
    const confirmTimeSmall = page.locator('text=13:00 到 17:00 · 4 小時');
    await confirmTimeSmall.waitFor({ state: 'visible', timeout: 5000 });
    console.log('✔ Confirmation page shows actual hours: 13:00 到 17:00 · 4 小時');

    const confirmDiscountNote = page.locator('text=買三送一，以 3 小時計').first();
    await confirmDiscountNote.waitFor({ state: 'visible', timeout: 5000 });
    console.log('✔ Confirmation page shows discount note: 買三送一，以 3 小時計');

    // Take mobile screenshot for Section 1 confirmation page
    const shot2Path = path.join(SCREENSHOT_DIR, 'section1-confirm-hours.png');
    await page.screenshot({ path: shot2Path });
    console.log(`Saved screenshot: ${shot2Path}`);

    // Submit booking and verify reservation details
    console.log('Submitting booking...');
    const submitBtn = page.locator('button:has-text("送出預約")');
    await submitBtn.click();
    await page.waitForTimeout(2000);

    // Verify completed page
    const doneText = page.locator('text=預約完成');
    await doneText.waitFor({ state: 'visible', timeout: 10000 });
    console.log('✔ Booking completed page reached');

    // Verify equipment line on StepDone shows actual usage hours
    const doneSmall = page.locator('text=13:00 到 17:00 · 4 小時');
    await doneSmall.waitFor({ state: 'visible', timeout: 5000 });
    console.log('✔ Done page shows actual hours: 13:00 到 17:00 · 4 小時');

    console.log('All Section 1 Playwright tests passed successfully!');
  } finally {
    await browser.close();
    await ensureFreshDbSeeded(prisma);
    await prisma.$disconnect();
  }
}

run().catch((err) => {
  console.error('Section 1 Playwright test failed:', err);
  process.exit(1);
});
