import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { PrismaClient } from '../../backend/node_modules/@prisma/client/index.js';
import { ensureFreshDbSeeded } from './helpers/seedFreshDb.js';
import { toTaipeiDateString } from '../../shared/time.js';

const BASE_URL = process.env.BASE_URL || 'http://localhost:5173';
const HEADLESS = process.env.HEADLESS !== 'false';

const testDbUrl = process.env.TEST_DATABASE_URL || 'postgresql://user:password@localhost:5432/booking_db_test?schema=public';
const prisma = new PrismaClient({ datasources: { db: { url: testDbUrl.trim() } } });

if (!process.env.ADMIN_PASSWORD?.trim()) {
  console.error('請設定 ADMIN_PASSWORD 環境變數');
  process.exit(1);
}
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD.trim();

async function run() {
  console.log('--- Starting Round 14 Mark Unpaid Playwright Test ---');
  await ensureFreshDbSeeded(prisma);

  const todayStr = toTaipeiDateString(new Date());
  const todayDate = new Date(`${todayStr}T00:00:00.000Z`);

  // Ensure sessions for today
  await prisma.session.deleteMany({ where: { session_date: todayDate } });
  const session = await prisma.session.create({
    data: {
      session_date: todayDate,
      start_time: '14:00',
      end_time: '16:00',
      max_capacity: 20
    }
  });

  const testRef = `BK-R14-${Date.now().toString().slice(-6)}`;
  const testUser = await prisma.user.create({
    data: {
      line_user_id: `line_r14_${Date.now()}`,
      name: '未結帳測試員',
      phone: '0977665544',
    }
  });

  // Create confirmed, checked-in, paid reservation
  await prisma.reservation.create({
    data: {
      booking_ref: testRef,
      session: { connect: { id: session.id } },
      user: { connect: { id: testUser.id } },
      pax: 1,
      status: 'confirmed',
      assigned_seats: ['A1-1'],
      attendance: 'checked_in',
      checked_in_at: new Date(),
      is_paid: true,
      paid_persons: 1,
      billing_status: 'paid',
      checkout_details: {
        version: 2,
        rev: 0,
        split_mode: 'proportional',
        persons: [
          { person_no: 1, seat_code: 'A1-1', mode: 'hourly' }
        ]
      }
    }
  });

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

  // Create valid payment so order is fully paid
  await prisma.payment.create({
    data: {
      booking_ref: testRef,
      payment_no: `R-${Date.now().toString().slice(-4)}`,
      batch_no: `B-${Date.now()}`,
      kind: 'charge',
      status: 'valid',
      method: 'cash',
      amount: 300,
      cash_received: 300,
      change_given: 0,
      person_nos: [1],
      staff_name: '門市人員',
      device_label: '櫃檯',
      breakdown_json: {
        persons: [
          {
            person_no: 1,
            seat_code: 'A1-1',
            entry: { amount: 300, hours: 2 },
            board: { amount: 0 },
            addons: [],
            total: 300
          }
        ]
      }
    }
  });

  const initialEventsCount = await prisma.accountingEvent.count({
    where: { booking_ref: testRef }
  });
  console.log(`Initial accounting events count for ${testRef}: ${initialEventsCount}`);

  // Create second paid reservation to test ReservationDetailsModal "標記未結帳"
  const testRef2 = `BK-R14-2-${Date.now().toString().slice(-6)}`;
  await prisma.reservation.create({
    data: {
      booking_ref: testRef2,
      session: { connect: { id: session.id } },
      user: { connect: { id: testUser.id } },
      pax: 1,
      status: 'confirmed',
      assigned_seats: ['A1-2'],
      attendance: 'checked_in',
      checked_in_at: new Date(),
      is_paid: true,
      paid_persons: 1,
      billing_status: 'paid',
      checkout_details: {
        version: 2,
        rev: 0,
        split_mode: 'proportional',
        persons: [{ person_no: 1, seat_code: 'A1-2', mode: 'hourly' }]
      }
    }
  });

  await prisma.bookingPerson.create({
    data: {
      booking_ref: testRef2,
      person_no: 1,
      seat_code: 'A1-2',
      status: 'active',
      billing_start_at: new Date(),
      timer_started_at: new Date()
    }
  });

  await prisma.payment.create({
    data: {
      booking_ref: testRef2,
      payment_no: `R-${(Date.now() + 1).toString().slice(-4)}`,
      batch_no: `B-${Date.now()}-2`,
      kind: 'charge',
      status: 'valid',
      method: 'cash',
      amount: 300,
      cash_received: 300,
      change_given: 0,
      person_nos: [1],
      staff_name: '門市人員',
      device_label: '櫃檯',
      breakdown_json: {
        persons: [{ person_no: 1, seat_code: 'A1-2', entry: { amount: 300, hours: 2 }, board: { amount: 0 }, addons: [], total: 300 }]
      }
    }
  });

  const launchOptions = { headless: HEADLESS };
  if (process.env.PLAYWRIGHT_CHROMIUM_PATH) {
    launchOptions.executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH;
  }

  const browser = await chromium.launch(launchOptions);
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
  });
  const page = await context.newPage();
  page.on('console', msg => console.log('BROWSER CONSOLE:', msg.text()));
  page.on('pageerror', err => console.log('BROWSER PAGEERROR:', err.message));
  page.on('response', res => {
    if (res.url().includes('/billing/')) {
      console.log('BILLING RESPONSE:', res.status(), res.url());
    }
  });

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

    // 2. Open reservations page to find our booking
    console.log(`Navigating to /admin/reservations to check ${testRef}...`);
    await page.goto(`${BASE_URL}/admin/reservations`, { waitUntil: 'networkidle' });

    const card = page.locator(`[data-testid="reservation-card-${testRef}"]`).first();
    await card.waitFor({ state: 'visible', timeout: 10000 });
    await card.click();

    // Verify reservation details modal opened
    const detailsTitle = page.locator('h2:has-text("訂單詳細資訊")');
    await detailsTitle.waitFor({ state: 'visible', timeout: 10000 });

    // Open workbench from details modal
    console.log('Opening Checkout Workbench from details modal...');
    const checkoutModalBtn = page.locator('button:has-text("結帳明細"), button:has-text("前往結帳")').first();
    await checkoutModalBtn.waitFor({ state: 'visible', timeout: 5000 });
    await checkoutModalBtn.click();

    // Verify workbench opened and status pill says 已結清
    const statusPill = page.locator('[data-testid="workbench-status-pill"]').first();
    await statusPill.waitFor({ state: 'visible', timeout: 10000 });
    // Wait for bill data to finish loading and populate paid status
    await page.waitForFunction(() => {
      const el = document.querySelector('[data-testid="workbench-status-pill"]');
      return el && (el.innerText.includes('已結清') || el.innerText.includes('已結'));
    }, { timeout: 10000 });
    const initialStatusText = await statusPill.innerText();
    console.log(`Workbench opened, status pill: ${initialStatusText}`);
    assert.ok(initialStatusText.includes('已結清') || initialStatusText.includes('已結'), 'Initial status should be paid/settled');

    // 3. Click 「⋯」 more button
    console.log('Clicking "⋯" more button...');
    const moreBtn = page.locator('[data-testid="workbench-more-btn"]:visible, [data-testid="workbench-more-btn-desktop"]:visible').first();
    await moreBtn.waitFor({ state: 'visible', timeout: 5000 });
    await moreBtn.click();

    // 4. Click 「標記未結帳」
    console.log('Clicking "標記未結帳"...');
    const markUnpaidBtn = page.locator('[data-testid="workbench-mark-unpaid-btn"]:visible, [data-testid="workbench-mark-unpaid-btn-desktop"]:visible').first();
    await markUnpaidBtn.waitFor({ state: 'visible', timeout: 5000 });
    await markUnpaidBtn.click();

    // 5. ConfirmPanel opens with title "標記未結帳？"
    console.log('Verifying ConfirmPanel "標記未結帳？"...');
    const modalTitle = page.locator('h4:has-text("標記未結帳？")');
    await modalTitle.waitFor({ state: 'visible', timeout: 5000 });

    // Select reason "收錯訂單"
    console.log('Selecting reason "收錯訂單"...');
    const reasonChip = page.locator('button:has-text("收錯訂單")').first();
    await reasonChip.waitFor({ state: 'visible', timeout: 5000 });
    await reasonChip.click();

    // Click confirm button
    console.log('Clicking confirm button...');
    const confirmBtn = page.locator('button:has-text("確認")').first();
    await confirmBtn.click();

    // 6. Verify toast and updated status pill
    console.log('Verifying toast "已標記未結帳" and status pill change...');
    const toast = page.locator('text=已標記未結帳');
    await toast.waitFor({ state: 'visible', timeout: 8000 });
    console.log('PASS: Toast "已標記未結帳" appeared');

    // Verify status pill changed to "未結帳"
    await page.waitForTimeout(500);
    const updatedStatusText = await statusPill.innerText();
    console.log(`Updated status pill: ${updatedStatusText}`);
    assert.ok(updatedStatusText.includes('未結帳'), 'Status pill should update to 未結帳');

    // 7. Verify AccountingEvent record added in DB
    const finalEventsCount = await prisma.accountingEvent.count({
      where: { booking_ref: testRef }
    });
    console.log(`Final accounting events count for ${testRef}: ${finalEventsCount}`);
    assert.ok(finalEventsCount >= initialEventsCount + 1, 'AccountingEvent count should increase');

    const markedUnpaidEvent = await prisma.accountingEvent.findFirst({
      where: { booking_ref: testRef, event_type: 'marked_unpaid' },
      orderBy: { created_at: 'desc' }
    });
    assert.ok(markedUnpaidEvent, 'marked_unpaid accounting event must exist');
    console.log(`Marked unpaid event: ${markedUnpaidEvent.event_type}, summary: ${markedUnpaidEvent.summary}`);
    assert.ok(markedUnpaidEvent.summary.includes('收錯訂單'), 'Event summary should mention 收錯訂單');

    // 8. Test ReservationDetailsModal "標記未結帳" on testRef2
    console.log(`Testing ReservationDetailsModal "標記未結帳" on ${testRef2}...`);
    // Close workbench if still open
    const closeWorkbenchBtn = page.locator('button[aria-label="關閉"], button:has-text("✕")').first();
    if (await closeWorkbenchBtn.isVisible()) {
      await closeWorkbenchBtn.click();
      await page.waitForTimeout(300);
    }

    // Refresh reservations list
    await page.goto(`${BASE_URL}/admin/reservations`, { waitUntil: 'networkidle' });
    const card2 = page.locator(`[data-testid="reservation-card-${testRef2}"]`).first();
    await card2.waitFor({ state: 'visible', timeout: 10000 });
    await card2.click();

    // Verify modal status pill initially says 已結清
    const modalStatusPill = page.locator('[data-testid="reservation-status-pill"]').first();
    await modalStatusPill.waitFor({ state: 'visible', timeout: 5000 });
    const modalInitialStatus = await modalStatusPill.innerText();
    console.log(`ReservationDetailsModal opened, status pill: ${modalInitialStatus}`);
    assert.ok(modalInitialStatus.includes('已結清') || modalInitialStatus.includes('已結'), 'Modal initial status should be paid');

    // Click modal more menu
    console.log('Clicking details modal "⋯" more button...');
    const modalMoreBtn = page.locator('[data-testid="reservation-more-btn"]').first();
    await modalMoreBtn.waitFor({ state: 'visible', timeout: 5000 });
    await modalMoreBtn.click();

    // Click 標記未結帳
    const modalMarkUnpaidBtn = page.locator('[data-testid="reservation-mark-unpaid-btn"]').first();
    await modalMarkUnpaidBtn.waitFor({ state: 'visible', timeout: 5000 });
    await modalMarkUnpaidBtn.click();

    // ConfirmPanel opens
    const modalConfirmTitle = page.locator('h4:has-text("標記未結帳？")');
    await modalConfirmTitle.waitFor({ state: 'visible', timeout: 5000 });

    // Select reason
    const chip2 = page.locator('button:has-text("收錯訂單")').first();
    await chip2.click();

    const confirmBtn2 = page.locator('button:has-text("確認")').first();
    await confirmBtn2.click();

    // Verify toast
    const toast2 = page.locator('text=已標記未結帳');
    await toast2.waitFor({ state: 'visible', timeout: 8000 });
    console.log('PASS: Details modal mark-unpaid toast appeared');

    // Verify status pill updated to 未結帳
    await page.waitForTimeout(500);
    const modalUpdatedStatus = await modalStatusPill.innerText();
    console.log(`ReservationDetailsModal updated status pill: ${modalUpdatedStatus}`);
    assert.ok(modalUpdatedStatus.includes('未結帳'), 'Modal status pill should update to 未結帳');

    // Verify AccountingEvent for testRef2
    const event2 = await prisma.accountingEvent.findFirst({
      where: { booking_ref: testRef2, event_type: 'marked_unpaid' },
      orderBy: { created_at: 'desc' }
    });
    assert.ok(event2, 'marked_unpaid event for testRef2 must exist');
    console.log(`Marked unpaid event for testRef2: ${event2.event_type}, summary: ${event2.summary}`);

    console.log('--- Round 14 Mark Unpaid Playwright Test Passed Successfully! ---');
  } finally {
    await browser.close();
    await prisma.$disconnect();
  }
}

run().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
