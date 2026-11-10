import { chromium } from 'playwright';
import { PrismaClient } from '../../backend/node_modules/@prisma/client/index.js';
import { ensureFreshDbSeeded } from './helpers/seedFreshDb.js';

const BASE_URL = process.env.BASE_URL || 'http://localhost:5173';
const testDbUrl = process.env.TEST_DATABASE_URL || 'postgresql://user:password@localhost:5432/booking_db_test?schema=public';
const prisma = new PrismaClient({ datasources: { db: { url: testDbUrl.trim() } } });

if (!process.env.ADMIN_PASSWORD?.trim()) {
  console.error('請設定 ADMIN_PASSWORD 環境變數');
  process.exit(1);
}
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD.trim();

async function takeScreenshots() {
  console.log('--- Capturing Round 17 Screenshots ---');
  await ensureFreshDbSeeded(prisma);

  const { toTaipeiDateString, dateOnly } = await import('../../shared/time.js');
  const today = new Date();
  const dateStr = toTaipeiDateString(today);
  const dbDate = dateOnly(dateStr);
  const sessions = await prisma.session.findMany({
    where: { session_date: dbDate },
    orderBy: { start_time: 'asc' }
  });

  if (sessions.length > 0) {
    const s1 = sessions[0];
    const s2 = sessions[1] || sessions[0];

    // Seed pending reservation for mobile check-in
    await prisma.reservation.create({
      data: {
        booking_ref: 'R17-PENDING-01',
        session_id: s1.id,
        user_id: 1,
        pax: 2,
        status: 'confirmed',
        attendance: 'pending',
        assigned_seats: ['A1-1', 'A1-2'],
        total_amount: 600,
        amount_received: 0,
        billing_status: 'unpaid'
      }
    });
    await prisma.bookingPerson.createMany({
      data: [
        { booking_ref: 'R17-PENDING-01', person_no: 1, status: 'active' },
        { booking_ref: 'R17-PENDING-01', person_no: 2, status: 'active' }
      ]
    });

    // Seed active checked-in reservation for timeline
    await prisma.reservation.create({
      data: {
        booking_ref: 'R17-ACTIVE-01',
        session_id: s1.id,
        user_id: 1,
        pax: 2,
        status: 'confirmed',
        attendance: 'checked_in',
        checked_in_at: new Date(),
        assigned_seats: ['B1-1', 'B1-2'],
        total_amount: 600,
        amount_received: 0,
        billing_status: 'unpaid'
      }
    });
    await prisma.bookingPerson.createMany({
      data: [
        { booking_ref: 'R17-ACTIVE-01', person_no: 1, seat_code: 'B1-1', status: 'active', timer_started_at: new Date() },
        { booking_ref: 'R17-ACTIVE-01', person_no: 2, seat_code: 'B1-2', status: 'active', timer_started_at: new Date() }
      ]
    });
  }

  const launchOptions = { headless: true };
  if (process.env.PLAYWRIGHT_CHROMIUM_PATH) {
    launchOptions.executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH;
  }
  const browser = await chromium.launch(launchOptions);

  try {
    // 1. Tablet context (820x1180) for Screenshot 1 & 3
    const tabletContext = await browser.newContext({
      viewport: { width: 820, height: 1180 },
      deviceScaleFactor: 2
    });
    const tabletPage = await tabletContext.newPage();

    // Login on tablet
    await tabletPage.goto(`${BASE_URL}/admin/login`);
    await tabletPage.waitForLoadState('networkidle');
    const pwdInput = tabletPage.locator('input[type="password"]');
    if (await pwdInput.isVisible()) {
      await pwdInput.fill(ADMIN_PASSWORD);
      await tabletPage.locator('button[type="submit"]').click();
      await tabletPage.waitForURL('**/admin/sessions');
      await tabletPage.waitForLoadState('networkidle');
    }

    // --- Screenshot 1: 排位規則分頁（平板） ---
    await tabletPage.goto(`${BASE_URL}/admin/seat-layout`);
    await tabletPage.waitForLoadState('networkidle');
    await tabletPage.waitForTimeout(1000);

    // Switch to rules tab
    const rulesTabBtn = tabletPage.locator('button:has-text("排位規則與試算")');
    if (await rulesTabBtn.isVisible()) {
      await rulesTabBtn.click();
      await tabletPage.waitForTimeout(1500);
    }

    // Expand advanced weights for completeness
    const advancedBtn = tabletPage.locator('button:has-text("進階：分數")');
    if (await advancedBtn.isVisible()) {
      await advancedBtn.click();
      await tabletPage.waitForTimeout(500);
    }

    await tabletPage.screenshot({ path: 'screenshot_round17_rules_tablet.png', fullPage: false });
    console.log('Saved screenshot_round17_rules_tablet.png');

    // --- Screenshot 3: 時間軸圖例（平板） ---
    await tabletPage.goto(`${BASE_URL}/admin/seating`);
    await tabletPage.waitForLoadState('networkidle');
    await tabletPage.waitForTimeout(1000);

    // Switch to timeline tab (visible button)
    const timelineTabBtn = tabletPage.locator('button[role="tab"]:has-text("時間軸"):visible').first();
    if (await timelineTabBtn.isVisible()) {
      await timelineTabBtn.click();
      await tabletPage.waitForTimeout(1500);
    }

    await tabletPage.screenshot({ path: 'screenshot_round17_timeline_legend_tablet.png', fullPage: false });
    console.log('Saved screenshot_round17_timeline_legend_tablet.png');

    await tabletContext.close();

    // 2. Mobile context (390x844) for Screenshot 2: 報到並帶位的提示（手機）
    const mobileContext = await browser.newContext({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 2
    });
    const mobilePage = await mobileContext.newPage();

    // Login on mobile
    await mobilePage.goto(`${BASE_URL}/admin/login`);
    await mobilePage.waitForLoadState('networkidle');
    const mPwdInput = mobilePage.locator('input[type="password"]');
    if (await mPwdInput.isVisible()) {
      await mPwdInput.fill(ADMIN_PASSWORD);
      await mobilePage.locator('button[type="submit"]').click();
      await mobilePage.waitForURL('**/admin/sessions');
      await mobilePage.waitForLoadState('networkidle');
    }

    await mobilePage.goto(`${BASE_URL}/admin/seating`);
    await mobilePage.waitForLoadState('networkidle');
    await mobilePage.waitForTimeout(1000);

    // Switch to list tab if needed
    const listTabBtn = mobilePage.locator('button[role="tab"]:has-text("名單"):visible').first();
    if (await listTabBtn.isVisible()) {
      await listTabBtn.click();
      await mobilePage.waitForTimeout(500);
    }

    // Click "帶位" on the pending card
    const checkInBtn = mobilePage.locator('button:has-text("帶位")').first();
    if (await checkInBtn.isVisible()) {
      await checkInBtn.click();
      await mobilePage.waitForTimeout(1000);
    }

    // In CheckInPanel, click A1-2 to toggle off, triggering partial seating hint: "先帶位 1 位，另 1 位稍後再帶位"
    const seatBtn = mobilePage.locator('button:has-text("A1-2")').first();
    if (await seatBtn.isVisible()) {
      await seatBtn.click();
      await mobilePage.waitForTimeout(500);
    }

    await mobilePage.screenshot({ path: 'screenshot_round17_checkin_hints_mobile.png', fullPage: false });
    console.log('Saved screenshot_round17_checkin_hints_mobile.png');

    await mobileContext.close();

  } finally {
    await browser.close();
    await prisma.$disconnect();
  }
}

takeScreenshots().catch(err => {
  console.error(err);
  process.exit(1);
});
