import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { PrismaClient } from '../../backend/node_modules/@prisma/client/index.js';
import { ensureFreshDbSeeded } from './helpers/seedFreshDb.js';
import { toTaipeiDateString } from '../../shared/time.js';

const BASE_URL = process.env.BASE_URL || 'http://localhost:5173';
const HEADLESS = process.env.HEADLESS !== 'false';

const testDbUrl = process.env.TEST_DATABASE_URL || 'postgresql://user:password@localhost:5432/booking_db_test?schema=public';
const prisma = new PrismaClient({ datasources: { db: { url: testDbUrl.trim() } } });

async function run() {
  console.log('--- Starting Round 10 Checkout Draft Playwright Test ---');
  await ensureFreshDbSeeded(prisma);

  const todayStr = toTaipeiDateString(new Date());
  const todayDate = new Date(`${todayStr}T00:00:00.000Z`);

  // Ensure sessions for today
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

  const testRef = `BK-R10-${Date.now().toString().slice(-6)}`;
  const testUser = await prisma.user.create({
    data: {
      line_user_id: `line_r10_${Date.now()}`,
      name: '結帳測試員',
      phone: '0988776655',
    }
  });

  // 2 hours: 13:00-14:00 and 14:00-15:00, 2 pax
  const bookSessions = [createdSessions[3], createdSessions[4]];
  for (const sess of bookSessions) {
    await prisma.reservation.create({
      data: {
        booking_ref: testRef,
        session: { connect: { id: sess.id } },
        user: { connect: { id: testUser.id } },
        pax: 2,
        status: 'confirmed',
        assigned_seats: ['A1-1', 'A1-2'],
        attendance: 'seated',
        checked_in_at: new Date(),
        checkout_details: {
          version: 2,
          rev: 0,
          split_mode: 'proportional',
          persons: [
            { person_no: 1, seat_code: 'A1-1', mode: 'hourly' },
            { person_no: 2, seat_code: 'A1-2', mode: 'hourly' }
          ]
        }
      }
    });
  }

  // Create booking persons
  await prisma.bookingPerson.createMany({
    data: [
      {
        booking_ref: testRef,
        person_no: 1,
        seat_code: 'A1-1',
        status: 'active',
        billing_start_at: new Date(),
        timer_started_at: new Date()
      },
      {
        booking_ref: testRef,
        person_no: 2,
        seat_code: 'A1-2',
        status: 'active',
        billing_start_at: new Date(),
        timer_started_at: new Date()
      }
    ]
  });

  const launchOptions = { headless: HEADLESS };
  if (process.env.PLAYWRIGHT_CHROMIUM_PATH) {
    launchOptions.executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH;
  }

  const browser = await chromium.launch(launchOptions);
  const context = await browser.newContext({
    viewport: { width: 375, height: 812 },
  });
  const page = await context.newPage();

  try {
    // 1. Admin login
    console.log('Logging in as admin...');
    await page.goto(`${BASE_URL}/admin/login`, { waitUntil: 'networkidle' });
    const passInput = page.locator('input[type="password"]');
    await passInput.waitFor({ state: 'visible', timeout: 15000 });
    await passInput.fill(process.env.ADMIN_PASSWORD || 'gathering.light2609');
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

    // Track PUT /draft requests
    let putDraftCount = 0;
    page.on('request', (req) => {
      if (req.method() === 'PUT' && req.url().includes('/billing/') && req.url().includes('/draft')) {
        putDraftCount++;
        console.log(`[Network] Intercepted PUT /draft request #${putDraftCount}`);
      }
    });

    // -------------------------------------------------------------
    // Acceptance criterion 1: 連按 3 次「＋」，畫面立刻更新，而且這段時間沒有任何 draft 請求
    // -------------------------------------------------------------
    console.log('Testing rapid 3 clicks on stepper "+" on Person 1...');
    const plusBtn1 = page.locator('[data-testid="stepper-plus-1"]').first();
    await plusBtn1.waitFor({ state: 'visible', timeout: 5000 });

    putDraftCount = 0;
    // Click 3 times rapidly
    await plusBtn1.click();
    await plusBtn1.click();
    await plusBtn1.click();

    // Verify screen updated immediately (<100ms) to 5 hours (2 + 3 = 5)
    const intHours1El = page.locator('[data-testid="int-hours-1"]').first();
    await intHours1El.waitFor({ state: 'visible', timeout: 200 });
    const text1 = await intHours1El.innerText();
    console.log(`Person 1 integer hours after 3 rapid clicks: ${text1}`);
    assert.ok(text1.includes('5'), `Expected integer hours to reflect 5 immediately, got ${text1}`);

    // Verify no draft request was sent immediately during rapid clicking
    assert.strictEqual(putDraftCount, 0, 'No draft requests should be sent during rapid clicking period');
    console.log('PASS: 3 clicks updated UI immediately with 0 draft requests during clicking');

    // Wait 1300ms for debounce to complete syncing
    await page.waitForTimeout(1300);
    assert.ok(putDraftCount >= 1, 'Draft should sync after debounce');

    // -------------------------------------------------------------
    // Acceptance criterion 2: 改了時數後 200ms 內關閉，重新打開，時數仍然是改過的值
    // -------------------------------------------------------------
    console.log('Testing Person 2 hour modification and closing within 200ms...');
    const plusBtn2 = page.locator('[data-testid="stepper-plus-2"]').first();
    await plusBtn2.waitFor({ state: 'visible', timeout: 5000 });

    // Click "+" on Person 2 (changes from 2 to 3 hours)
    await plusBtn2.click();

    // Within 200ms, click close button!
    const closeBtn = page.locator('[data-testid="workbench-close-btn"]');
    await closeBtn.click();

    // Modal closes immediately
    await workbenchTitle.waitFor({ state: 'hidden', timeout: 3000 });
    console.log('Workbench closed within 200ms of editing');

    // Wait 1000ms for background flush to finish
    await page.waitForTimeout(1200);

    // Re-open checkout workbench
    console.log('Re-opening workbench to verify changes persisted...');
    await checkoutBtn.waitFor({ state: 'visible', timeout: 5000 });
    await checkoutBtn.click();
    await workbenchTitle.waitFor({ state: 'visible', timeout: 10000 });

    // Verify Person 2 hours is still the modified value (3 hours)
    const intHours2El = page.locator('[data-testid="int-hours-2"]').first();
    await intHours2El.waitFor({ state: 'visible', timeout: 5000 });
    const text2 = await intHours2El.innerText();
    console.log(`Person 2 integer hours after re-open: ${text2}`);
    assert.ok(text2.includes('3'), `Person 2 hours must be 3 after re-opening, got ${text2}`);

    // Also verify Person 1 hours is still 5
    const recheckedText1 = await intHours1El.innerText();
    console.log(`Person 1 integer hours after re-open: ${recheckedText1}`);
    assert.ok(recheckedText1.includes('5'), `Person 1 hours must still be 5, got ${recheckedText1}`);

    console.log('PASS: Hours modification was persisted when closed within 200ms!');
    console.log('--- Round 10 Checkout Draft Playwright Test Finished Successfully ---');
  } finally {
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
