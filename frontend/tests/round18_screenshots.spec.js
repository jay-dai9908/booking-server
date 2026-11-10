import { chromium } from 'playwright';
import { PrismaClient } from '../../backend/node_modules/@prisma/client/index.js';
import { ensureFreshDbSeeded } from './helpers/seedFreshDb.js';
import { toTaipeiDateString, dateOnly } from '../../shared/time.js';

const BASE_URL = process.env.BASE_URL || 'http://localhost:5173';
const HEADLESS = process.env.HEADLESS !== 'false';

const testDbUrl = process.env.TEST_DATABASE_URL || 'postgresql://user:password@localhost:5432/booking_db_test?schema=public';
const prisma = new PrismaClient({ datasources: { db: { url: testDbUrl.trim() } } });

if (!process.env.ADMIN_PASSWORD?.trim()) {
  console.error('請設定 ADMIN_PASSWORD 環境變數');
  process.exit(1);
}
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD.trim();

async function capture() {
  console.log('--- Capturing Round 18 Screenshots (Mobile 390x844) ---');
  await ensureFreshDbSeeded(prisma);

  const todayStr = toTaipeiDateString(new Date());
  const todayDate = dateOnly(todayStr);

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

  const testRef = `BK-R18-${Date.now().toString().slice(-6)}`;
  const testUser = await prisma.user.create({
    data: {
      line_user_id: `line_r18_${Date.now()}`,
      name: '林小美',
      phone: '0912345678',
    }
  });

  // 2 hours: 13:00-15:00, 2 pax
  const bookSessions = [createdSessions[3], createdSessions[4]];
  for (const sess of bookSessions) {
    await prisma.reservation.create({
      data: {
        booking_ref: testRef,
        session_id: sess.id,
        user_id: testUser.id,
        pax: 2,
        status: 'confirmed',
        assigned_seats: ['A1-1', 'A1-2'],
        attendance: 'seated',
        checked_in_at: new Date(),
        checkout_details: {
          version: 2,
          rev: 0,
          split_mode: 'proportional',
          manual_discount: 80,
          persons: [
            { person_no: 1, seat_code: 'A1-1', mode: 'hourly' },
            { person_no: 2, seat_code: 'A1-2', mode: 'hourly' }
          ]
        }
      }
    });
  }

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

  try {
    // ----------------------------------------------------
    // Screenshot 1: Mobile Checkout Workbench (390x844)
    // ----------------------------------------------------
    console.log('Capturing Screenshot 1: Mobile Checkout Workbench...');
    const context1 = await browser.newContext({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 2,
    });
    const page1 = await context1.newPage();

    // Login as admin
    await page1.goto(`${BASE_URL}/admin/login`, { waitUntil: 'networkidle' });
    const passInput = page1.locator('input[type="password"]');
    await passInput.waitFor({ state: 'visible', timeout: 15000 });
    await passInput.fill(ADMIN_PASSWORD);
    await page1.locator('button[type="submit"]').click();
    await page1.waitForURL((url) => !url.pathname.includes('/login'), { timeout: 15000 });
    await page1.waitForTimeout(800);
    await page1.waitForLoadState('networkidle');

    // Open Accounting Page
    console.log('Navigating to /admin/accounting...');
    await page1.goto(`${BASE_URL}/admin/accounting`, { waitUntil: 'networkidle' });
    await page1.waitForTimeout(800);

    const unpaidTab = page1.locator('[data-testid="tab-unpaid"]:visible, button:has-text("未結"):visible').first();
    if (await unpaidTab.isVisible()) {
      await unpaidTab.click();
      await page1.waitForTimeout(500);
    }

    const checkoutBtn = page1.locator(`[data-testid="checkout-btn-${testRef}"], button:has-text("結帳")`).first();
    await checkoutBtn.waitFor({ state: 'visible', timeout: 10000 });
    await checkoutBtn.click();

    // Wait for mobile workbench items to render
    await page1.waitForSelector('[data-testid^="mobile-person-row-"]', { timeout: 10000 });
    await page1.waitForSelector('[data-testid="mobile-addons-discounts-row"]', { timeout: 10000 });
    await page1.waitForTimeout(600);

    await page1.screenshot({
      path: 'screenshot_round18_workbench_mobile.png',
      fullPage: false,
    });
    console.log('Saved screenshot_round18_workbench_mobile.png');
    await context1.close();

    // ----------------------------------------------------
    // Screenshot 2: Preview Page After Clicking "先看看空位" (390x844)
    // ----------------------------------------------------
    console.log('Capturing Screenshot 2: Preview Page After Clicking 先看看空位...');
    const context2 = await browser.newContext({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 2,
    });
    const page2 = await context2.newPage();

    await page2.goto(`${BASE_URL}/preview`, { waitUntil: 'networkidle' });
    await page2.waitForTimeout(600);

    const scrollBtn = page2.locator('[data-testid="preview-scroll-to-slots-button"]');
    await scrollBtn.waitFor({ state: 'visible', timeout: 10000 });
    await scrollBtn.click();

    // Wait for smooth scroll to finish
    await page2.waitForTimeout(1200);

    await page2.screenshot({
      path: 'screenshot_round18_preview_scroll_mobile.png',
      fullPage: false,
    });
    console.log('Saved screenshot_round18_preview_scroll_mobile.png');
    await context2.close();

    console.log('Both Round 18 screenshots captured successfully!');
  } finally {
    await browser.close();
    await prisma.$disconnect();
  }
}

capture().catch((err) => {
  console.error('Failed to capture Round 18 screenshots:', err);
  process.exit(1);
});
