import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { ensureFreshDbSeeded } from './helpers/seedFreshDb.js';
import { toTaipeiDateString, dateOnly } from '../../shared/time.js';

const require = createRequire(import.meta.url);
const testDbUrl = process.env.TEST_DATABASE_URL || 'postgresql://user:password@localhost:5432/booking_db_test?schema=public';
let PrismaClient;
try {
  ({ PrismaClient } = require('@prisma/client'));
} catch (e) {
  ({ PrismaClient } = require('../../backend/node_modules/@prisma/client/index.js'));
}
const prisma = new PrismaClient({ datasources: { db: { url: testDbUrl.trim() } } });

const BASE_URL = process.env.BASE_URL || 'http://localhost:5173';
const HEADLESS = process.env.HEADLESS !== 'false';
if (!process.env.ADMIN_PASSWORD?.trim()) {
  console.error('請設定 ADMIN_PASSWORD 環境變數');
  process.exit(1);
}
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD.trim();

const SCREENSHOT_DIR = path.resolve(process.cwd(), 'test-results', 'round13-screenshots');
if (!fs.existsSync(SCREENSHOT_DIR)) {
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
}

async function run() {
  console.log('--- Starting Round 13 Floor & Seat Panel Playwright Test ---');
  await ensureFreshDbSeeded(prisma);

  const todayStr = toTaipeiDateString(new Date());
  const todayDate = dateOnly(todayStr);
  const ts = Date.now();

  // 1. Create sessions for today
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
    ['20:00', '21:00']
  ];
  const sessions = [];
  for (const [st, et] of slotHours) {
    const s = await prisma.session.create({
      data: {
        session_date: todayDate,
        start_time: st,
        end_time: et,
        max_capacity: 16
      }
    });
    sessions.push(s);
  }

  // 2. Create User 1 (Pending: 待入座客)
  const userPending = await prisma.user.create({
    data: {
      line_user_id: `user_pending_${ts}`,
      name: '待入座客',
      phone: '0912345678'
    }
  });

  // Create User 2 (In-use: 計時客)
  const userInUse = await prisma.user.create({
    data: {
      line_user_id: `user_inuse_${ts}`,
      name: '計時客',
      phone: '0987654321'
    }
  });

  // Create User 3 (Paid: 已結清客)
  const userPaid = await prisma.user.create({
    data: {
      line_user_id: `user_paid_${ts}`,
      name: '已付客',
      phone: '0933444555'
    }
  });

  // Create User 4 (Prepaid Pending: 線上預付客)
  const userPrepaid = await prisma.user.create({
    data: {
      line_user_id: `user_prepaid_${ts}`,
      name: '預付客',
      phone: '0955666777'
    }
  });

  const refPending = `BK-PND-${ts.toString().slice(-6)}`;
  const refInUse = `BK-USE-${ts.toString().slice(-6)}`;
  const refPaid = `BK-PAD-${ts.toString().slice(-6)}`;
  const refPrepaid = `BK-PRE-${ts.toString().slice(-6)}`;

  // Deactivate seat B2-4 to test inactive seat state
  await prisma.seat.updateMany({
    where: { code: 'B2-4' },
    data: { is_active: false }
  });

  // 3. Create Reservations
  // Pending booking: 16:00 to 18:00 (sessions 6 and 7), assigned A1-1, A1-2
  for (const s of [sessions[6], sessions[7]]) {
    await prisma.reservation.create({
      data: {
        booking_ref: refPending,
        session_id: s.id,
        user_id: userPending.id,
        pax: 2,
        status: 'confirmed',
        attendance: null,
        is_paid: false,
        assigned_seats: ['A1-1', 'A1-2'],
        total_amount: 600
      }
    });
  }

  // In-use booking: 14:00 to 18:00 (sessions 4 to 7), assigned A1-3, A1-4
  for (const s of [sessions[4], sessions[5], sessions[6], sessions[7]]) {
    await prisma.reservation.create({
      data: {
        booking_ref: refInUse,
        session_id: s.id,
        user_id: userInUse.id,
        pax: 2,
        status: 'confirmed',
        attendance: 'checked_in',
        checked_in_at: new Date(Date.now() - 60 * 60 * 1000),
        is_paid: false,
        assigned_seats: ['A1-3', 'A1-4'],
        total_amount: 1200
      }
    });
  }

  // Paid booking: 14:00 to 21:00 (sessions 4 to 10), assigned B1-1, B1-2
  for (const s of sessions.slice(4)) {
    await prisma.reservation.create({
      data: {
        booking_ref: refPaid,
        session_id: s.id,
        user_id: userPaid.id,
        pax: 2,
        status: 'confirmed',
        attendance: 'checked_in',
        checked_in_at: new Date(Date.now() - 60 * 60 * 1000),
        is_paid: true,
        assigned_seats: ['B1-1', 'B1-2'],
        total_amount: 1200
      }
    });
  }

  // Prepaid pending booking: 16:00 to 21:00 (sessions 6 to 10), assigned B2-1
  for (const s of sessions.slice(6)) {
    await prisma.reservation.create({
      data: {
        booking_ref: refPrepaid,
        session_id: s.id,
        user_id: userPrepaid.id,
        pax: 1,
        status: 'confirmed',
        attendance: null,
        is_paid: true,
        assigned_seats: ['B2-1'],
        total_amount: 300
      }
    });
  }

  // Booking persons for In-Use booking
  await prisma.bookingPerson.createMany({
    data: [
      {
        booking_ref: refInUse,
        person_no: 1,
        seat_code: 'A1-3',
        status: 'active',
        billing_start_at: new Date(Date.now() - 60 * 60 * 1000),
        timer_started_at: new Date(Date.now() - 60 * 60 * 1000)
      },
      {
        booking_ref: refInUse,
        person_no: 2,
        seat_code: 'A1-4',
        status: 'active',
        billing_start_at: new Date(Date.now() - 60 * 60 * 1000),
        timer_started_at: new Date(Date.now() - 60 * 60 * 1000)
      },
      {
        booking_ref: refPaid,
        person_no: 1,
        seat_code: 'B1-1',
        status: 'active',
        billing_start_at: new Date(Date.now() - 60 * 60 * 1000),
        timer_started_at: new Date(Date.now() - 60 * 60 * 1000)
      },
      {
        booking_ref: refPaid,
        person_no: 2,
        seat_code: 'B1-2',
        status: 'active',
        billing_start_at: new Date(Date.now() - 60 * 60 * 1000),
        timer_started_at: new Date(Date.now() - 60 * 60 * 1000)
      }
    ]
  });

  // Payment for Paid booking (created_at 18:10 cash)
  await prisma.payment.create({
    data: {
      payment_no: `PAY-R13-${ts}`,
      batch_no: `B-R13-${ts}`,
      booking_ref: refPaid,
      amount: 1200,
      cash_received: 1200,
      change_given: 0,
      method: 'cash',
      kind: 'charge',
      status: 'valid',
      person_nos: [1, 2],
      staff_name: '測試櫃檯',
      device_label: '櫃檯平板',
      breakdown_json: {},
      created_at: new Date(`${todayStr}T18:10:00+08:00`)
    }
  });

  const launchOptions = { headless: HEADLESS };
  if (process.env.PLAYWRIGHT_CHROMIUM_PATH) {
    launchOptions.executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH;
  }

  const browser = await chromium.launch(launchOptions);
  // Viewport 1024x768 (Tablet mode)
  const context = await browser.newContext({
    viewport: { width: 1024, height: 768 }
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
    await page.waitForTimeout(600);

    // 2. Navigate to Seating Page
    console.log('Navigating to /admin/seating...');
    await page.goto(`${BASE_URL}/admin/seating`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(600);

    // Switch to Floor Tab if needed
    const floorTab = page.locator('button:has-text("平面圖")').first();
    if (await floorTab.isVisible()) {
      await floorTab.click();
      await page.waitForTimeout(500);
    }

    // 3. Verification of Item 3: Tablet Floor Plan
    console.log('Verifying Item 3: Tablet Floor Plan...');
    const floorPlanContainer = page.locator('[data-testid="floor-plan-container"]');
    await floorPlanContainer.waitFor({ state: 'visible', timeout: 10000 });

    // Check seat tile A1-3: size 58px and guest name visible
    const seatTileA13 = page.locator('[data-seat-code="A1-3"]').first();
    await seatTileA13.waitFor({ state: 'visible', timeout: 10000 });
    const box = await seatTileA13.boundingBox();
    assert.ok(box, 'Seat tile A1-3 should have bounding box');
    console.log(`Seat tile A1-3 width: ${box.width}px, height: ${box.height}px`);
    assert.ok(
      Math.abs(box.width - 58) <= 2,
      `Expected seat tile width to be 58px (got ${box.width})`
    );

    // Guest name '計時客' must be visible inside floor plan
    const guestNameEl = seatTileA13.getByText('計時客', { exact: true });
    await guestNameEl.waitFor({ state: 'visible', timeout: 5000 });
    console.log('Guest name is visible on tablet floor plan!');

    // Screenshot 1: 平板平面圖（預設縮放）
    const shotPath1 = path.join(SCREENSHOT_DIR, 'tablet-floor-plan.png');
    await page.screenshot({ path: shotPath1 });
    console.log(`Screenshot 1 saved: ${shotPath1}`);

    // Round 13b Item 2 Verification: 平板預設畫面中，任兩個座位格的外框不重疊
    console.log('Verifying Round 13b Item 2: Seat tiles do not overlap in tablet default view...');
    const allSeatTiles = await page.locator('[data-testid="floor-plan-container"] [data-seat-code]').all();
    assert.ok(allSeatTiles.length >= 2, 'There should be multiple seat tiles rendered on floor plan');

    const tileBoxes = [];
    for (const t of allSeatTiles) {
      const code = await t.getAttribute('data-seat-code');
      const b = await t.boundingBox();
      if (b && b.width > 0 && b.height > 0) {
        tileBoxes.push({ code, box: b });
      }
    }

    for (let i = 0; i < tileBoxes.length; i++) {
      for (let j = i + 1; j < tileBoxes.length; j++) {
        const a = tileBoxes[i];
        const b = tileBoxes[j];
        const overlapX = Math.max(0, Math.min(a.box.x + a.box.width, b.box.x + b.box.width) - Math.max(a.box.x, b.box.x));
        const overlapY = Math.max(0, Math.min(a.box.y + a.box.height, b.box.y + b.box.height) - Math.max(a.box.y, b.box.y));
        const overlaps = overlapX > 0.5 && overlapY > 0.5;
        assert.ok(
          !overlaps,
          `Seat tiles ${a.code} and ${b.code} must not overlap! (overlapX=${overlapX.toFixed(1)}, overlapY=${overlapY.toFixed(1)})`
        );
      }
    }
    console.log(`Verified all ${tileBoxes.length} seat tiles do not overlap in tablet default view!`);

    // Verify "置中" button resets zoom to 1
    const centerBtn = page.locator('[data-testid="floor-plan-center-btn"]');
    await centerBtn.click();
    await page.waitForTimeout(200);
    const currentZoom = await floorPlanContainer.getAttribute('data-zoom');
    assert.equal(currentZoom, '1', 'Center button must reset zoom to 1');
    console.log('Center button successfully reset zoom to 1');

    // 4. Verification of Item 2 (In-Use Seat Action Panel)
    console.log('Verifying Item 2: Clicking in-use seat A1-3...');
    await seatTileA13.click();
    await page.waitForTimeout(500);

    // Panel opens as right-side slide-over
    const panelContent = page.locator('[data-testid="seat-action-panel-content"]');
    await panelContent.waitFor({ state: 'visible', timeout: 5000 });

    // Check in-use controls
    await page.locator('[data-testid="seat-panel-checkout-btn"]').waitFor({ state: 'visible', timeout: 5000 });
    await page.locator('[data-testid="seat-panel-timer-toggle-btn"]').waitFor({ state: 'visible', timeout: 5000 });

    // Verify panel width on 1024x768 screen is < 512px (half screen width) and matches 380px
    const panelDialog = page.locator('[role="dialog"] > div');
    const panelBox = await panelDialog.boundingBox();
    assert.ok(panelBox, 'Panel must have bounding box');
    console.log(`Panel bounding width: ${panelBox.width}px`);
    assert.ok(
      panelBox.width < 512,
      `Panel width (${panelBox.width}px) must be less than half of tablet width (512px)`
    );
    assert.ok(
      Math.abs(panelBox.width - 380) <= 5,
      `Panel width should be ~380px, got ${panelBox.width}`
    );

    // Screenshot 2: 平板點座位後的右側面板（計時中）
    const shotPath2 = path.join(SCREENSHOT_DIR, 'tablet-seat-panel-in-use.png');
    await page.screenshot({ path: shotPath2 });
    console.log(`Screenshot 2 saved: ${shotPath2}`);

    // Close panel
    await page.locator('[aria-label="關閉"]').click();
    await page.waitForTimeout(400);

    // 5. Verification of Item 2 (Pending Seat Action Panel)
    console.log('Verifying Item 2: Clicking pending seat A1-1...');
    const seatTileA11 = page.locator('[data-seat-code="A1-1"]').first();
    await seatTileA11.waitFor({ state: 'visible', timeout: 5000 });
    await seatTileA11.click();
    await page.waitForTimeout(500);

    // Panel opens for pending reservation
    const checkinBtn = page.locator('[data-testid="seat-panel-checkin-btn"]');
    await checkinBtn.waitFor({ state: 'visible', timeout: 5000 });
    console.log('Found "報到並帶位" button on pending seat panel!');

    // Verify "暫停計時" is NOT shown
    const pauseBtn = page.locator('[data-testid="seat-panel-timer-toggle-btn"]');
    assert.equal(await pauseBtn.count(), 0, '"暫停計時" should NOT appear for pending bookings');
    // Screenshot 3: 平板點座位後的右側面板（待入座）
    const shotPath3 = path.join(SCREENSHOT_DIR, 'tablet-seat-panel-pending.png');
    await page.screenshot({ path: shotPath3 });
    console.log(`Screenshot 3 saved: ${shotPath3}`);

    // Close panel
    await page.locator('[aria-label="關閉"]').click();
    await page.waitForTimeout(400);

    // 6. Verification of Item 3: Filter chip dimming (opacity: .35)
    console.log('Verifying Item 3: Filter chip dimming...');
    // Click "待入座" filter chip
    await page.locator('button:has-text("待入座")').first().click();
    await page.waitForTimeout(300);

    // Pending seat A1-1 parent container should have opacity: 1
    const a11Wrapper = page.locator('[data-seat-code="A1-1"]').first().locator('..');
    const a11Opacity = await a11Wrapper.evaluate(el => window.getComputedStyle(el).opacity);
    assert.equal(a11Opacity, '1', 'Matching pending seat must have opacity 1');

    // In-use seat A1-3 parent container should have opacity: 0.35
    const a13Wrapper = page.locator('[data-seat-code="A1-3"]').first().locator('..');
    const a13Opacity = await a13Wrapper.evaluate(el => window.getComputedStyle(el).opacity);
    assert.equal(a13Opacity, '0.35', 'Non-matching in-use seat must be dimmed with opacity 0.35');
    console.log('Confirmed filter chip "待入座" dims non-matching seats to opacity 0.35');

    // Reset filter to "全部"
    await page.locator('button:has-text("全部")').first().click();
    await page.waitForTimeout(300);

    // 7. Verification of Item 2: Inactive Seat Action Panel
    console.log('Verifying Item 2: Clicking inactive seat B2-4...');
    const seatTileB24 = page.locator('[data-seat-code="B2-4"]').first();
    await seatTileB24.waitFor({ state: 'visible', timeout: 5000 });
    await seatTileB24.click();
    await page.waitForTimeout(500);

    // Verify inactive seat panel subtitle and link
    const inactiveSubtitle = page.locator('text=這個座位已暫停使用').first();
    await inactiveSubtitle.waitFor({ state: 'visible', timeout: 5000 });
    const seatSettingLink = page.locator('a:has-text("到座位設定")').first();
    await seatSettingLink.waitFor({ state: 'visible', timeout: 5000 });
    assert.equal(await seatSettingLink.getAttribute('href'), '/admin/seat-layout');
    console.log('Confirmed inactive seat B2-4 displays "這個座位已暫停使用" and link to seat settings');

    // Close panel
    await page.locator('[aria-label="關閉"]').click();
    await page.waitForTimeout(400);

    // 8. Verification of Item 2: Prepaid Pending Reservation has "報到並帶位"
    console.log('Verifying Item 2: Prepaid pending reservation on B2-1 has checkin button...');
    const seatTileB21 = page.locator('[data-seat-code="B2-1"]').first();
    await seatTileB21.waitFor({ state: 'visible', timeout: 5000 });
    await seatTileB21.click();
    await page.waitForTimeout(500);

    const prepaidCheckinBtn = page.locator('[data-testid="seat-panel-checkin-btn"]');
    await prepaidCheckinBtn.waitFor({ state: 'visible', timeout: 5000 });
    console.log('Confirmed prepaid pending booking shows "報到並帶位" button');

    // Close panel
    await page.locator('[aria-label="關閉"]').click();
    await page.waitForTimeout(400);

    // 9. Verification of Item 2: Paid In-Use Seat Action Panel
    console.log('Verifying Item 2: Paid in-use seat B1-1 shows leave, supplement, refund...');
    const seatTileB11 = page.locator('[data-seat-code="B1-1"]').first();
    await seatTileB11.waitFor({ state: 'visible', timeout: 5000 });
    await seatTileB11.click();
    await page.waitForTimeout(500);

    await page.locator('[data-testid="seat-panel-leave-btn"]').waitFor({ state: 'visible', timeout: 5000 });
    await page.locator('[data-testid="seat-panel-supplement-btn"]').waitFor({ state: 'visible', timeout: 5000 });
    await page.locator('[data-testid="seat-panel-refund-btn"]').waitFor({ state: 'visible', timeout: 5000 });
    const paidSubtitle = await page.locator('[role="dialog"] p').first().textContent();
    assert.ok(paidSubtitle.includes('已付 · 現金 18:10'), `Expected subtitle to include '已付 · 現金 18:10', got: ${paidSubtitle}`);

    // Close panel
    await page.locator('[aria-label="關閉"]').click();
    await page.waitForTimeout(400);

    // Round 13b Item 3 Verification: Wire time slot chips & slot indicator subtitle
    console.log('Verifying Round 13b Item 3: Time slot selector chip updates subtitle...');
    const slot19Chip = page.locator('button:has-text("19:00")').first();
    if (await slot19Chip.isVisible()) {
      await slot19Chip.click();
      await page.waitForTimeout(300);
      const slotSubtitle = page.locator('text=顯示 19:00 的座位').first();
      await slotSubtitle.waitFor({ state: 'visible', timeout: 5000 });
      console.log('Confirmed slot chip 19:00 shows subtitle "顯示 19:00 的座位"');

      // Click "現在" chip to restore
      const nowChip = page.locator('button:has-text("現在")').first();
      await nowChip.click();
      await page.waitForTimeout(300);
      assert.equal(await page.locator('text=顯示 19:00 的座位').count(), 0, 'Subtitle must disappear when "現在" is selected');
      console.log('Confirmed selecting "現在" clears slot subtitle');
    }

    // Screenshot 2: 手機平面圖
    console.log('Capturing Screenshot 2: mobile floor plan...');
    const mobileContext = await browser.newContext({
      viewport: { width: 390, height: 844 }
    });
    const mobilePage = await mobileContext.newPage();
    try {
      await mobilePage.goto(`${BASE_URL}/admin/login`, { waitUntil: 'networkidle' });
      const mPass = mobilePage.locator('input[type="password"]');
      await mPass.waitFor({ state: 'visible', timeout: 10000 });
      await mPass.fill(ADMIN_PASSWORD);
      await mobilePage.locator('button[type="submit"]').click();
      await mobilePage.waitForURL((url) => !url.pathname.includes('/login'), { timeout: 10000 });
      await mobilePage.waitForTimeout(400);

      await mobilePage.goto(`${BASE_URL}/admin/seating`, { waitUntil: 'networkidle' });
      await mobilePage.waitForTimeout(600);

      const mFloorTab = mobilePage.locator('button:has-text("平面圖")').first();
      if (await mFloorTab.isVisible()) {
        await mFloorTab.click();
        await mobilePage.waitForTimeout(400);
      }

      const shotPathMobile = path.join(SCREENSHOT_DIR, 'mobile-floor-plan.png');
      await mobilePage.screenshot({ path: shotPathMobile });
      console.log(`Screenshot 2 saved: ${shotPathMobile}`);
    } finally {
      await mobileContext.close();
    }

    console.log('--- All Round 13 Playwright Verifications Passed! ---');
  } finally {
    await context.close();
    await browser.close();

    // Clean up created reservations & users
    await prisma.bookingPerson.deleteMany({ where: { booking_ref: { in: [refPending, refInUse, refPaid, refPrepaid] } } });
    await prisma.payment.deleteMany({ where: { booking_ref: { in: [refPending, refInUse, refPaid, refPrepaid] } } });
    await prisma.reservation.deleteMany({ where: { booking_ref: { in: [refPending, refInUse, refPaid, refPrepaid] } } });
    await prisma.user.deleteMany({ where: { id: { in: [userPending.id, userInUse.id, userPaid.id, userPrepaid.id] } } });
    await prisma.seat.updateMany({ where: { code: 'B2-4' }, data: { is_active: true } });
    await prisma.$disconnect().catch(() => {});
  }
}

run().catch((err) => {
  console.error('Playwright Test Failed:', err);
  process.exit(1);
});
