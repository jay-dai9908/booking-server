import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PrismaClient } from '../../backend/node_modules/@prisma/client/index.js';
import { ensureFreshDbSeeded } from './helpers/seedFreshDb.js';
import { toTaipeiDateString } from '../../shared/time.js';

const BASE_URL = process.env.BASE_URL || 'http://localhost:5173';
const HEADLESS = process.env.HEADLESS !== 'false';
const SCREENSHOT_DIR = path.resolve('test-results/round9-screenshots');

if (!fs.existsSync(SCREENSHOT_DIR)) {
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
}

const testDbUrl = process.env.TEST_DATABASE_URL || 'postgresql://user:password@localhost:5432/booking_db_test?schema=public';
const prisma = new PrismaClient({ datasources: { db: { url: testDbUrl.trim() } } });

if (!process.env.ADMIN_PASSWORD?.trim()) {
  console.error('請設定 ADMIN_PASSWORD 環境變數');
  process.exit(1);
}
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD.trim();

async function run() {
  console.log('--- Starting Round 9 Section 4 Playwright Tests ---');
  await ensureFreshDbSeeded(prisma);
  await prisma.globalSetting.update({
    where: { id: 1 },
    data: { weekend_hourly_price: 150, weekend_unlimited_price: 750 }
  });

  const todayStr = toTaipeiDateString(new Date());
  const todayDate = new Date(`${todayStr}T00:00:00.000Z`);

  // Ensure sessions for today 10:00-21:00
  await prisma.session.deleteMany({ where: { session_date: todayDate } });
  const slotHours = [
    ['10:00', '11:00'],
    ['11:00', '12:00'],
    ['12:00', '13:00'],
    ['13:00', '14:00'],
    ['14:00', '15:00'],
    ['15:00', '16:00'],
    ['16:00', '17:00'],
    ['17:00', '18:00'],
    ['18:00', '19:00'],
    ['19:00', '20:00'],
    ['20:00', '21:00'],
  ];
  const createdSessions = [];
  for (const [st, et] of slotHours) {
    const s = await prisma.session.create({
      data: {
        session_date: todayDate,
        start_time: st,
        end_time: et,
        max_capacity: 20
      }
    });
    createdSessions.push(s);
  }

  // Create an admin user or super admin
  const testRef = `BK-SEC4-${Date.now().toString().slice(-6)}`;
  const testUser = await prisma.user.create({
    data: {
      line_user_id: `line_sec4_${Date.now()}`,
      name: '時數測試員',
      phone: '0912345678',
    }
  });

  // Book 2 hours: 13:00-14:00 and 14:00-15:00 (index 3 and 4)
  const bookSessions = [createdSessions[3], createdSessions[4]];
  for (const sess of bookSessions) {
    await prisma.reservation.create({
      data: {
        booking_ref: testRef,
        session: { connect: { id: sess.id } },
        user: { connect: { id: testUser.id } },
        pax: 1,
        status: 'confirmed',
        assigned_seats: ['A1-1'],
        attendance: 'seated',
        checked_in_at: new Date(),
        checkout_details: {
          version: 2,
          rev: 0,
          split_mode: 'proportional',
          persons: [
            {
              person_no: 1,
              seat_code: 'A1-1',
              mode: 'hourly'
            }
          ]
        }
      }
    });
  }

  // Create booking person
  await prisma.bookingPerson.create({
    data: {
      booking_ref: testRef,
      person_no: 1,
      seat_code: 'A1-1',
      status: 'active',
      billing_start_at: new Date(),
      timer_started_at: new Date()
    }
  });

  const launchOptions = { headless: HEADLESS };
  if (process.env.PLAYWRIGHT_CHROMIUM_PATH) {
    launchOptions.executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH;
  }

  const browser = await chromium.launch(launchOptions);
  const context = await browser.newContext({
    viewport: { width: 375, height: 812 }, // Mobile viewport 375x812
  });
  const page = await context.newPage();

  try {
    // 1. Admin login
    console.log('Logging in as admin...');
    await page.goto(`${BASE_URL}/admin/login`, { waitUntil: 'networkidle' });
    const passInput = page.locator('input[type="password"]');
    await passInput.waitFor({ state: 'visible', timeout: 15000 });
    await passInput.fill(ADMIN_PASSWORD);
    await page.locator('button[type="submit"]').click();
    await page.waitForURL((url) => !url.pathname.includes('/login'), { timeout: 15000 });
    await page.waitForTimeout(500);

    // 2. Open accounting page to open CheckoutWorkbench
    console.log(`Navigating to /admin/accounting to open workbench for ${testRef}...`);
    await page.goto(`${BASE_URL}/admin/accounting`, { waitUntil: 'networkidle' });

    const unpaidTab = page.locator('[data-testid="tab-unpaid"]:visible, button:has-text("未結"):visible').first();
    await unpaidTab.click();
    await page.waitForTimeout(500);

    const checkoutBtn = page.locator(`[data-testid="checkout-btn-${testRef}"], button:has-text("結帳")`).first();
    await checkoutBtn.waitFor({ state: 'visible', timeout: 10000 });
    await checkoutBtn.click();

    // Verify workbench opened
    const workbenchTitle = page.locator('text=每位時數與金額');
    await workbenchTitle.waitFor({ state: 'visible', timeout: 10000 });

    // Track PUT /draft requests and responses
    let putDraftCount = 0;
    page.on('request', (req) => {
      if (req.method() === 'PUT' && req.url().includes('/billing/') && req.url().includes('/draft')) {
        putDraftCount++;
        console.log(`[Network] Intercepted PUT /draft request #${putDraftCount}`);
      }
    });
    page.on('response', async (res) => {
      if (res.request().method() === 'PUT' && res.url().includes('/draft')) {
        const body = await res.text().catch(() => '');
        console.log(`[Network] PUT /draft response status: ${res.status()}, body: ${body.slice(0, 150)}`);
      }
    });
    page.on('pageerror', err => console.log('[Page Error]', err));
    page.on('console', msg => console.log('[Page Console]', msg.type(), msg.text()));

    // -------------------------------------------------------------
    // Test 1: Rapid 5 clicks on stepper '+' -> immediate UI update (<100ms) & exactly 1 PUT /draft after 1000ms
    // -------------------------------------------------------------
    console.log('Testing rapid 5 clicks on stepper "+" with debounce...');
    const plusBtn = page.locator('[data-testid="stepper-plus-1"], button:has-text("+")').first();
    await plusBtn.waitFor({ state: 'visible', timeout: 5000 });

    putDraftCount = 0;
    const t0 = Date.now();
    // Click 5 times rapidly
    for (let i = 0; i < 5; i++) {
      await plusBtn.click();
    }
    const elapsedClick = Date.now() - t0;
    console.log(`Clicked 5 times in ${elapsedClick}ms`);

    // Verify amount updated immediately in UI (within 100ms of clicks)
    const intHoursEl = page.locator('[data-testid="int-hours-1"]').first();
    await intHoursEl.waitFor({ state: 'visible', timeout: 100 });
    const intHoursText = await intHoursEl.innerText();
    console.log(`Current integer hours text: ${intHoursText}`);
    // Base was 2, 5 clicks + 2 = 7 hours
    assert.ok(intHoursText.includes('7'), `Expected integer hours to reflect 7 immediately, got ${intHoursText}`);

    // Verify PUT request has NOT fired immediately (< 500ms)
    assert.strictEqual(putDraftCount, 0, 'PUT /draft must NOT fire immediately before 1000ms debounce');

    // Wait 1300ms for debounce timer to fire
    await page.waitForTimeout(1300);
    assert.strictEqual(putDraftCount, 1, `Expected exactly 1 PUT /draft call after debounce, got ${putDraftCount}`);
    console.log('PASS: 5 rapid clicks updated UI immediately and triggered exactly 1 debounced PUT /draft');

    // -------------------------------------------------------------
    // Test 2: Select integer 3 hours + overtime chip +1.5 -> total 4.5h, NT$675
    // -------------------------------------------------------------
    console.log('Testing integer 3 hours + "+1.5" chip selection...');
    const minusBtn = page.locator('[data-testid="stepper-minus-1"]').first();
    // Currently at 7. Click minus 4 times to reach 3.
    for (let i = 0; i < 4; i++) {
      await minusBtn.click();
    }
    const int3Text = await intHoursEl.innerText();
    assert.ok(int3Text.includes('3'), `Expected integer hours to be 3, got ${int3Text}`);

    // Click overtime chip +1.5
    const chip15 = page.locator('[data-testid="ot-chip-1-1.5"], button:has-text("+1.5")').first();
    await chip15.waitFor({ state: 'visible', timeout: 5000 });
    await chip15.click();

    // Verify summary display: "共 4.5 小時 · NT$675" (4.5 * 150 = 675)
    const summaryEl = page.locator('[data-testid="hours-summary-1"]').first();
    await summaryEl.waitFor({ state: 'visible', timeout: 3000 });
    const summaryText = await summaryEl.innerText();
    console.log(`Hours summary: ${summaryText}`);
    assert.ok(summaryText.includes('4.5 小時'), `Summary must include 4.5 小時, got ${summaryText}`);
    assert.ok(summaryText.includes('675'), `Summary must include NT$675, got ${summaryText}`);

    // Verify manual mode indicator and "改回自動" link
    const manualPill = page.locator('text=手動').first();
    await manualPill.waitFor({ state: 'visible', timeout: 3000 });
    const resetAutoBtn = page.locator('[data-testid="reset-auto-1"], button:has-text("改回自動")').first();
    await resetAutoBtn.waitFor({ state: 'visible', timeout: 3000 });

    // Capture required screenshot: section4-workbench-hours.png
    const screenshotPath = path.join(SCREENSHOT_DIR, 'section4-workbench-hours.png');
    await page.screenshot({ path: screenshotPath });
    console.log(`Saved screenshot to ${screenshotPath}`);

    // -------------------------------------------------------------
    // Test 3: Edit and immediately click "收款" without waiting -> flushes draft, no "金額剛剛有變動"
    // -------------------------------------------------------------
    console.log('Testing immediate click on 收款 without waiting for debounce...');
    // Click stepper + once (changes to 4 + 1.5 = 5.5 hours, NT$825)
    await plusBtn.click();
    // Immediately click "收款" button without any wait!
    const collectBtn = page.locator('[data-testid="workbench-collect-btn"]:visible');
    await collectBtn.click();

    // Collection modal opens with capped amount (5.5 * 150 = 825, capped at unlimited_price 750)
    const modalDue = page.locator('text=收款 NT$750').first();
    await modalDue.waitFor({ state: 'visible', timeout: 5000 });

    // Verify that NO warning dialog "金額剛剛有變動" appears
    const changeWarn = page.locator('text=金額剛剛有變動');
    assert.strictEqual(await changeWarn.count(), 0, 'Must NOT show "金額剛剛有變動" modal when draft is flushed before opening');

    console.log('PASS: Flushed draft before collect modal; amount matches exactly without warning');

    console.log('--- Round 9 Section 4 Playwright Tests Finished Successfully ---');
  } finally {
    // Cleanup created test reservation
    await prisma.timerPause.deleteMany({ where: { person: { booking_ref: testRef } } }).catch(() => {});
    await prisma.bookingPerson.deleteMany({ where: { booking_ref: testRef } }).catch(() => {});
    await prisma.reservation.deleteMany({ where: { booking_ref: testRef } }).catch(() => {});
    await browser.close();
    await prisma.$disconnect();
  }
}

run().catch((err) => {
  console.error('Test run failed:', err);
  process.exit(1);
});
