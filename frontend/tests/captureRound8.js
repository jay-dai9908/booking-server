import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { PrismaClient } = require('../../backend/node_modules/@prisma/client/index.js');
const prisma = new PrismaClient({
  datasources: { db: { url: process.env.TEST_DATABASE_URL || 'postgresql://user:password@localhost:5432/booking_db_test?schema=public' } }
});

const BASE_URL = process.env.BASE_URL || 'http://localhost:5173';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'gathering.light2609';
const OUT_DIR = path.resolve(process.cwd(), 'test-results/round8-screenshots');

async function main() {
  if (!fs.existsSync(OUT_DIR)) {
    fs.mkdirSync(OUT_DIR, { recursive: true });
  }

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 375, height: 812 }
  });
  const page = await context.newPage();

  // 1. Admin Login
  console.log('Logging in as admin on mobile (375x812)...');
  await page.goto(`${BASE_URL}/admin/login`, { waitUntil: 'networkidle' });
  await page.locator('input[type="password"]').fill(ADMIN_PASSWORD);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL(url => !url.pathname.includes('/login'), { timeout: 15000 });
  await page.waitForTimeout(1000);

  const token = await page.evaluate(() => sessionStorage.getItem('shiguang_auth_token'));
  if (token) {
    await context.addInitScript((tok) => {
      try { sessionStorage.setItem('shiguang_auth_token', tok); } catch (e) {}
    }, token);
  }

  const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Taipei' });
  const todayUtc = new Date(`${todayStr}T00:00:00.000Z`);
  const tomorrowStr = new Date(Date.now() + 86400000).toLocaleDateString('en-CA', { timeZone: 'Asia/Taipei' });
  const tomorrowUtc = new Date(`${tomorrowStr}T00:00:00.000Z`);

  // Ensure test sessions
  const s1 = await prisma.session.upsert({
    where: { session_date_start_time: { session_date: todayUtc, start_time: '14:00' } },
    update: { max_capacity: 20, end_time: '23:59' },
    create: { session_date: todayUtc, start_time: '14:00', end_time: '23:59', max_capacity: 20 }
  });
  const s2 = await prisma.session.upsert({
    where: { session_date_start_time: { session_date: tomorrowUtc, start_time: '19:00' } },
    update: { max_capacity: 20, end_time: '20:00' },
    create: { session_date: tomorrowUtc, start_time: '19:00', end_time: '20:00', max_capacity: 20 }
  });

  const testUser = await prisma.user.upsert({
    where: { line_user_id: 'test_round8_user' },
    update: { name: '陳渝忻', phone: '0912345678' },
    create: { line_user_id: 'test_round8_user', name: '陳渝忻', phone: '0912345678' }
  });
  const testUser2 = await prisma.user.upsert({
    where: { line_user_id: 'test_round8_user2' },
    update: { name: '林小美', phone: '0988777666' },
    create: { line_user_id: 'test_round8_user2', name: '林小美', phone: '0988777666' }
  });

  // Ensure published layout has A1, B1 tables
  let pubLayout = await prisma.seatLayout.findFirst({
    where: { status: 'published' },
    include: { tables: true, seats: true, zones: true }
  });
  if (!pubLayout) {
    pubLayout = await prisma.seatLayout.create({
      data: {
        name: '店內格局',
        status: 'published',
        effective_from: todayUtc,
        capacity: 16,
        canvas_w: 1000,
        canvas_h: 625,
        published_by_name: '店長',
        published_at: new Date()
      }
    });
  }

  // --- SCREENSHOT 1: 發布確認面板 ---
  console.log('Setting up for Screenshot 1: Publish confirm panel...');
  const refSeated = 'BK-SHOT-SEATED';
  const refPending = 'BK-SHOT-PENDING';
  await prisma.payment.deleteMany({ where: { booking_ref: { in: [refSeated, refPending] } } });
  await prisma.timerPause.deleteMany({ where: { person: { booking_ref: { in: [refSeated, refPending] } } } });
  await prisma.bookingPerson.deleteMany({ where: { booking_ref: { in: [refSeated, refPending] } } });
  await prisma.reservation.deleteMany({ where: { booking_ref: { in: [refSeated, refPending] } } });

  // Seated booking on B1-1
  await prisma.reservation.create({
    data: {
      booking_ref: refSeated,
      user_id: testUser.id,
      session_id: s1.id,
      pax: 2,
      status: 'confirmed',
      attendance: 'checked_in',
      checked_in_at: new Date(Date.now() - 3600000),
      assigned_seats: ['B1-1', 'B1-2'],
      total_amount: 600
    }
  });
  await prisma.bookingPerson.createMany({
    data: [
      { booking_ref: refSeated, person_no: 1, seat_code: 'B1-1', status: 'active', timer_started_at: new Date(Date.now() - 3600000) },
      { booking_ref: refSeated, person_no: 2, seat_code: 'B1-2', status: 'active', timer_started_at: new Date(Date.now() - 3600000) }
    ]
  });

  // Pending booking on B1-1 at 19:00
  await prisma.reservation.create({
    data: {
      booking_ref: refPending,
      user_id: testUser2.id,
      session_id: s2.id,
      pax: 2,
      status: 'confirmed',
      attendance: null,
      assigned_seats: ['B1-1', 'B1-2'],
      total_amount: 600
    }
  });

  // Create a draft layout that excludes B1
  const draftLayout = await prisma.seatLayout.create({
    data: {
      name: '新微調格局（草稿）',
      status: 'draft',
      capacity: 8,
      canvas_w: 1000,
      canvas_h: 625,
      rules_json: { max_wait_capacity: 4 }
    }
  });
  const draftZone = await prisma.seatZone.create({
    data: { layout_id: draftLayout.id, name: '主區', sort_order: 0 }
  });
  const draftTable = await prisma.seatTable.create({
    data: { layout_id: draftLayout.id, zone_id: draftZone.id, label: 'A1', cx: 300, cy: 300, w: 100, h: 100, sort_order: 0 }
  });
  for (let i = 1; i <= 4; i++) {
    await prisma.seat.create({
      data: {
        layout_id: draftLayout.id,
        zone_id: draftZone.id,
        table_id: draftTable.id,
        code: `A1-${i}`,
        lx: i * 20,
        ly: 0,
        sort_order: i,
        is_active: true
      }
    });
  }

  // Go to SeatLayoutPage with draft layout
  await page.goto(`${BASE_URL}/admin/seat-layout?id=${draftLayout.id}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1000);

  // Click 發布生效 button
  const publishBtn = page.locator('button:has-text("發布生效")').first();
  await publishBtn.waitFor({ state: 'visible', timeout: 8000 });
  await publishBtn.click();

  // Wait for dialog: "發布座位版面生效確認"
  const dialogHeading = page.locator('h4:has-text("發布座位版面生效確認")');
  await dialogHeading.waitFor({ state: 'visible', timeout: 8000 });
  await page.locator('text=需要換座位的在場客人').waitFor({ state: 'visible', timeout: 8000 });
  await page.locator('text=會自動改排的預約').waitFor({ state: 'visible', timeout: 8000 });
  await page.waitForTimeout(600);

  const shot1Path = path.join(OUT_DIR, '01-publish-confirm-panel.png');
  await page.screenshot({ path: shot1Path, fullPage: false });
  console.log(`Saved screenshot 1 to ${shot1Path}`);

  // --- SCREENSHOT 2: 今日帶位「座位已更新」提示 ---
  console.log('Setting up for Screenshot 2: Reseat hint banner...');
  // Pre-seed the reseat hint in sessionStorage
  await page.evaluate(({ ref }) => {
    try {
      sessionStorage.setItem('sg_reseated_c_hints', JSON.stringify({
        [ref]: { from: 'B1-1、B1-2', to: 'A1-1、A1-2' }
      }));
    } catch (e) {}
  }, { ref: refSeated });

  await page.goto(`${BASE_URL}/admin/seating`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);

  // Make sure we are on the list tab if tabs exist
  const listTab = page.locator('button:visible:has-text("名單")').first();
  if (await listTab.isVisible().catch(() => false)) {
    await listTab.click();
    await page.waitForTimeout(400);
  }

  // Check if "座位已更新" hint banner appears
  const reseatBanner = page.locator(`[data-testid="reseat-hint-banner-${refSeated}"]`);
  await reseatBanner.waitFor({ state: 'visible', timeout: 8000 });
  await page.waitForTimeout(400);

  const shot2Path = path.join(OUT_DIR, '02-reseat-hint-banner.png');
  await page.screenshot({ path: shot2Path, fullPage: false });
  console.log(`Saved screenshot 2 to ${shot2Path}`);

  // --- SCREENSHOT 3: 計時面板的離場和全組離場 ---
  console.log('Setting up for Screenshot 3: Timer panel departure options...');
  // Click on the reseated card or "計時" button to open timer sheet
  const card = page.locator(`[data-booking-ref="${refSeated}"]`).first();
  await card.click();
  await page.waitForTimeout(800);

  // In timer sheet, find person 1's "⋯" button
  const moreBtn = page.locator('[data-testid="person-more-btn-1"]').first();
  await moreBtn.waitFor({ state: 'visible', timeout: 5000 });
  await moreBtn.click();
  await page.waitForTimeout(400);

  // Ensure "離場" menu item and "全組離場" button visible
  const leaveItem = page.locator('[data-testid="person-leave-btn-1"]');
  await leaveItem.waitFor({ state: 'visible', timeout: 5000 });
  const allLeaveBtn = page.locator('[data-testid="all-leave-btn"]');
  await allLeaveBtn.waitFor({ state: 'visible', timeout: 5000 });

  const shot3Path = path.join(OUT_DIR, '03-timer-panel-departure.png');
  await page.screenshot({ path: shot3Path, fullPage: false });
  console.log(`Saved screenshot 3 to ${shot3Path}`);

  // Close timer sheet
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(400);

  // --- SCREENSHOT 4: 已結清的訂單出現在已離場 ---
  console.log('Setting up for Screenshot 4: Paid booking in departed section...');
  const refPaid = 'BK-SHOT-PAID';
  await prisma.payment.deleteMany({ where: { booking_ref: refPaid } });
  await prisma.timerPause.deleteMany({ where: { person: { booking_ref: refPaid } } });
  await prisma.bookingPerson.deleteMany({ where: { booking_ref: refPaid } });
  await prisma.reservation.deleteMany({ where: { booking_ref: refPaid } });

  const nowDt = new Date();
  await prisma.reservation.create({
    data: {
      booking_ref: refPaid,
      user_id: testUser.id,
      session_id: s1.id,
      pax: 2,
      status: 'confirmed',
      attendance: 'completed',
      checked_in_at: new Date(nowDt.getTime() - 7200000),
      is_paid: true,
      billing_status: 'paid',
      assigned_seats: ['A1-3', 'A1-4'],
      total_amount: 600,
      amount_received: 600
    }
  });
  await prisma.bookingPerson.createMany({
    data: [
      { booking_ref: refPaid, person_no: 1, seat_code: 'A1-3', status: 'active', timer_started_at: new Date(nowDt.getTime() - 7200000), timer_ended_at: new Date(nowDt.getTime() - 1800000) },
      { booking_ref: refPaid, person_no: 2, seat_code: 'A1-4', status: 'active', timer_started_at: new Date(nowDt.getTime() - 7200000), timer_ended_at: new Date(nowDt.getTime() - 1800000) }
    ]
  });
  await prisma.payment.create({
    data: {
      payment_no: 'PAY-SHOT-001',
      batch_no: 'BATCH-SHOT-001',
      booking_ref: refPaid,
      amount: 600,
      method: 'cash',
      kind: 'charge',
      status: 'valid',
      breakdown_json: {},
      staff_name: '店長',
      device_label: '櫃檯',
      person_nos: [1, 2]
    }
  });

  await page.goto(`${BASE_URL}/admin/seating`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);

  // Make sure we are on the list tab
  const tabList = page.locator('button:visible:has-text("名單")').first();
  if (await tabList.isVisible().catch(() => false)) {
    await tabList.click();
    await page.waitForTimeout(400);
  }

  // Find and expand "已離場" accordion
  const accordionBtn = page.locator('button:has-text("已離場")').first();
  await accordionBtn.waitFor({ state: 'visible', timeout: 8000 });
  await accordionBtn.scrollIntoViewIfNeeded();
  await accordionBtn.click();
  await page.waitForTimeout(600);

  const departedCard = page.locator(`[data-booking-ref="${refPaid}"]`).first();
  await departedCard.waitFor({ state: 'visible', timeout: 8000 });
  await page.waitForTimeout(400);

  const shot4Path = path.join(OUT_DIR, '04-paid-booking-departed.png');
  await page.screenshot({ path: shot4Path, fullPage: false });
  console.log(`Saved screenshot 4 to ${shot4Path}`);

  // Cleanup test layout and bookings
  await prisma.payment.deleteMany({ where: { booking_ref: { in: [refSeated, refPending, refPaid] } } });
  await prisma.timerPause.deleteMany({ where: { person: { booking_ref: { in: [refSeated, refPending, refPaid] } } } });
  await prisma.bookingPerson.deleteMany({ where: { booking_ref: { in: [refSeated, refPending, refPaid] } } });
  await prisma.reservation.deleteMany({ where: { booking_ref: { in: [refSeated, refPending, refPaid] } } });
  await prisma.seat.deleteMany({ where: { layout_id: draftLayout.id } });
  await prisma.seatTable.deleteMany({ where: { layout_id: draftLayout.id } });
  await prisma.seatZone.deleteMany({ where: { layout_id: draftLayout.id } });
  await prisma.seatLayout.deleteMany({ where: { id: draftLayout.id } });

  await browser.close();
  console.log('🎉 ALL 4 MOBILE SCREENSHOTS CAPTURED SUCCESSFULLY!');
}

main().catch(async (e) => {
  console.error('Screenshot capture failed:', e);
  process.exit(1);
}).finally(() => prisma.$disconnect());
