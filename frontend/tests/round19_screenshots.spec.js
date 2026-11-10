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
  console.log('--- Capturing Round 19 Screenshots (Mobile 390x844) ---');
  await ensureFreshDbSeeded(prisma);

  const todayStr = toTaipeiDateString(new Date());
  const todayDate = dateOnly(todayStr);

  // 1. Ensure sessions exist for today
  let session = await prisma.session.findFirst({
    where: { session_date: todayDate, start_time: '13:00' }
  });
  if (!session) {
    session = await prisma.session.create({
      data: {
        session_date: todayDate,
        start_time: '13:00',
        end_time: '17:00',
        max_capacity: 20
      }
    });
  }

  const runId = Math.random().toString(36).slice(2, 7);
  const testRef = `BK-R19-CAP-${runId}`;
  const testUser = await prisma.user.create({
    data: {
      line_user_id: `line_cap_${runId}`,
      name: '拾光預約客',
      phone: '0912345678'
    }
  });

  const reservation = await prisma.reservation.create({
    data: {
      booking_ref: testRef,
      user_id: testUser.id,
      session_id: session.id,
      pax: 2,
      status: 'confirmed',
      attendance: 'seated',
      checked_in_at: new Date(),
      assigned_seats: ['A1-1', 'A1-2'],
      checkout_details: {
        version: 2,
        rev: 1,
        persons: [
          { person_no: 1, hours_override: 3 },
          { person_no: 2, hours_override: 3 }
        ]
      }
    }
  });

  await prisma.bookingPerson.createMany({
    data: [
      { booking_ref: testRef, person_no: 1, seat_code: 'A1-1', status: 'active', billing_start_at: new Date(), timer_started_at: new Date() },
      { booking_ref: testRef, person_no: 2, seat_code: 'A1-2', status: 'active', billing_start_at: new Date(), timer_started_at: new Date() }
    ]
  });

  // Create a payment for Person 1 so Person 1 is paid (allowing refund and supplement)
  await prisma.payment.create({
    data: {
      payment_no: `R-261110-9${runId.slice(0, 3)}`,
      batch_no: `B-CAP-${runId}`,
      booking_ref: testRef,
      kind: 'charge',
      status: 'valid',
      method: 'linepay',
      amount: 450,
      person_nos: [1],
      breakdown_json: {
        persons: [
          {
            person_no: 1,
            total: 450,
            entry: { mode: 'hourly', hours: 3, amount: 450 },
            board: { amount: 0, units: [] },
            addons: [],
            shares: [],
            promos: []
          }
        ],
        pricing: { hourly: 150, unlimited: 750 }
      },
      staff_name: '店長',
      staff_id: 1,
      device_label: '櫃檯'
    }
  });

  const launchOptions = { headless: HEADLESS };
  if (process.env.PLAYWRIGHT_CHROMIUM_PATH) {
    launchOptions.executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH;
  }
  const browser = await chromium.launch(launchOptions);

  try {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 2
    });
    const page = await context.newPage();
    page.on('console', msg => console.log('[PAGE]', msg.type(), msg.text()));
    page.on('response', async res => {
      if (res.status() >= 400) {
        let body = '';
        try { body = await res.text(); } catch {}
        console.log(`[HTTP ${res.status()}] ${res.url()} => ${body}`);
      }
    });

    // Login as admin
    await page.goto(`${BASE_URL}/admin/login`, { waitUntil: 'networkidle' });
    const pwInput = page.locator('input[type="password"]');
    await pwInput.waitFor({ state: 'visible', timeout: 10000 });
    await pwInput.fill(ADMIN_PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForTimeout(1000);

    // Go to Reservations Page
    await page.goto(`${BASE_URL}/admin/reservations`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(800);

    const card = page.locator(`[data-testid="reservation-card-${testRef}"]`).first();
    await card.waitFor({ state: 'visible', timeout: 10000 });
    await card.click();
    await page.waitForTimeout(600);

    // Open workbench from details modal
    const checkoutModalBtn = page.locator('button:has-text("結帳明細"), button:has-text("前往結帳")').first();
    await checkoutModalBtn.waitFor({ state: 'visible', timeout: 5000 });
    await checkoutModalBtn.click();
    await page.waitForTimeout(1500);
    await page.screenshot({ path: 'frontend/test-results/debug-screen.png' });

    // If SplitCollectView didn't auto-open, click split button
    const splitTitle = page.locator('text=分開收款與帳務作業');
    if (!(await splitTitle.isVisible().catch(() => false))) {
      const splitBtn = page.locator('button:has-text("分開收款"):visible').first();
      if (await splitBtn.isVisible().catch(() => false)) {
        await splitBtn.click();
        await page.waitForTimeout(800);
      }
    }

    // Person 1 is paid, click refund button
    const refundBtn = page.locator('[data-testid="split-person-refund-btn"]').first();
    await refundBtn.waitFor({ state: 'visible', timeout: 10000 });
    await refundBtn.click();
    await page.waitForTimeout(600);

    // Screenshot 1: Refund Panel (390x844)
    await page.screenshot({
      path: 'screenshot_round19_refund_panel_mobile.png',
      fullPage: false
    });
    console.log('Saved screenshot_round19_refund_panel_mobile.png');

    // Close refund panel
    const cancelRefundBtn = page.locator('button:has-text("取消"):visible').last();
    if (await cancelRefundBtn.isVisible()) {
      await cancelRefundBtn.click();
      await page.waitForTimeout(400);
    }

    // Now open supplement panel: Click supplement button on Person 1
    const suppBtn = page.locator('[data-testid="split-person-supplement-btn"]').first();
    await suppBtn.waitFor({ state: 'visible', timeout: 10000 });
    await suppBtn.click();
    await page.waitForTimeout(600);

    // Screenshot 2: Supplement Panel (390x844)
    await page.screenshot({
      path: 'screenshot_round19_supplement_panel_mobile.png',
      fullPage: false
    });
    console.log('Saved screenshot_round19_supplement_panel_mobile.png');

    console.log('Both Round 19 screenshots captured successfully!');
  } finally {
    await browser.close();
    // Cleanup
    await prisma.payment.deleteMany({ where: { booking_ref: testRef } }).catch(() => {});
    await prisma.bookingPerson.deleteMany({ where: { booking_ref: testRef } }).catch(() => {});
    await prisma.reservation.deleteMany({ where: { booking_ref: testRef } }).catch(() => {});
    await prisma.user.deleteMany({ where: { id: testUser.id } }).catch(() => {});
    await prisma.$disconnect();
  }
}

capture().catch((err) => {
  console.error('Screenshot capture failed:', err);
  process.exit(1);
});
