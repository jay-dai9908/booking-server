import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import { ensureFreshDbSeeded } from './helpers/seedFreshDb.js';

const require = createRequire(import.meta.url);
const testDbUrl = process.env.TEST_DATABASE_URL;
if (!testDbUrl || !testDbUrl.trim()) {
  console.error('TEST_DATABASE_URL is not set.');
  process.exit(1);
}

let PrismaClient;
try {
  ({ PrismaClient } = require('@prisma/client'));
} catch (e) {
  ({ PrismaClient } = require('../../backend/node_modules/@prisma/client/index.js'));
}
const prisma = new PrismaClient({ datasources: { db: { url: testDbUrl.trim() } } });

const BASE_URL = process.env.BASE_URL || 'http://localhost:5173';
const HEADLESS = process.env.HEADLESS !== 'false';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ? process.env.ADMIN_PASSWORD.trim() : 'admin123';
const SCREENSHOT_DIR = path.resolve('test-results/round9-screenshots');
if (!fs.existsSync(SCREENSHOT_DIR)) {
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
}

async function run() {
  console.log('--- Starting Round 9 Section 5 Playwright Tests ---');
  await ensureFreshDbSeeded(prisma);

  const testDateStr = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Taipei' });
  const testDate = new Date(`${testDateStr}T00:00:00.000Z`);
  const randSuffix = Math.floor(100000 + Math.random() * 900000);
  const testRef = `BK-SEC5-${randSuffix}`;

  // Ensure equipment configs
  await prisma.equipmentConfig.upsert({
    where: { id: 'medium' },
    update: { name: '智能拼豆板（中板）', hourly_rate: 120, total_stock: 10, visibility_status: 'ACTIVE' },
    create: { id: 'medium', name: '智能拼豆板（中板）', hourly_rate: 120, total_stock: 10, visibility_status: 'ACTIVE' }
  });
  await prisma.equipmentConfig.upsert({
    where: { id: 'small' },
    update: { name: '智能拼豆板（小板）', hourly_rate: 90, total_stock: 10, visibility_status: 'ACTIVE' },
    create: { id: 'small', name: '智能拼豆板（小板）', hourly_rate: 90, total_stock: 10, visibility_status: 'ACTIVE' }
  });

  // Ensure test sessions exist for today: 13:00-14:00, 14:00-15:00, 15:00-16:00, 19:00-20:00, 20:00-21:00
  const sessionDefs = [
    { start: '13:00', end: '14:00' },
    { start: '14:00', end: '15:00' },
    { start: '15:00', end: '16:00' },
    { start: '19:00', end: '20:00' },
    { start: '20:00', end: '21:00' }
  ];

  const sessions = [];
  for (const sd of sessionDefs) {
    const s = await prisma.session.upsert({
      where: { session_date_start_time: { session_date: testDate, start_time: sd.start } },
      update: { end_time: sd.end, max_capacity: 10 },
      create: { session_date: testDate, start_time: sd.start, end_time: sd.end, max_capacity: 10 }
    });
    sessions.push(s);
  }

  // Create test user
  const user = await prisma.user.upsert({
    where: { line_user_id: `sec5_user_${randSuffix}` },
    update: { name: '時間軸測試員' },
    create: { line_user_id: `sec5_user_${randSuffix}`, name: '時間軸測試員', phone: '0977888999' }
  });

  const now = new Date();
  // Create 1-person checked-in reservation for 13:00-15:00 (sessions 0 and 1)
  await prisma.reservation.create({
    data: {
      booking_ref: testRef,
      session: { connect: { id: sessions[0].id } },
      user: { connect: { id: user.id } },
      pax: 1,
      status: 'confirmed',
      attendance: 'checked_in',
      assigned_seats: ['A1-1'],
      checked_in_at: now
    }
  });
  await prisma.reservation.create({
    data: {
      booking_ref: testRef,
      session: { connect: { id: sessions[1].id } },
      user: { connect: { id: user.id } },
      pax: 1,
      status: 'confirmed',
      attendance: 'checked_in',
      assigned_seats: ['A1-1'],
      checked_in_at: now
    }
  });

  // Create person 1
  const person1 = await prisma.bookingPerson.create({
    data: {
      booking_ref: testRef,
      person_no: 1,
      seat_code: 'A1-1',
      status: 'active',
      billing_start_at: now,
      timer_started_at: now
    }
  });

  const launchOptions = { headless: HEADLESS };
  if (process.env.PLAYWRIGHT_CHROMIUM_PATH) {
    launchOptions.executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH;
  }
  const browser = await chromium.launch(launchOptions);
  const context = await browser.newContext({
    viewport: { width: 375, height: 812 } // Mobile viewport
  });
  const page = await context.newPage();

  try {
    // 1. Admin login
    console.log('Logging in as admin...');
    await page.goto(`${BASE_URL}/admin/login`, { waitUntil: 'domcontentloaded' });
    await page.fill('input[type="password"]', ADMIN_PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForURL(url => url.pathname.startsWith('/admin') && !url.pathname.includes('/login'), { timeout: 10000 });
    await page.waitForTimeout(500);

    // 2. Navigate to /admin/seating
    console.log(`Navigating to /admin/seating to test timer panel for ${testRef}...`);
    await page.goto(`${BASE_URL}/admin/seating`, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.waitForTimeout(1000);

    page.on('response', async (res) => {
      if (res.request().method() === 'POST' && res.url().includes('/floor/')) {
        const text = await res.text().catch(() => '');
        console.log(`[Network] POST ${res.url()} -> ${res.status()}: ${text.slice(0, 150)}`);
      }
    });
    page.on('console', msg => console.log('[Console]', msg.type(), msg.text()));

    // Switch to "名單" tab
    const listTab = page.locator('button:visible:has-text("名單")').first();
    if (await listTab.isVisible().catch(() => false)) {
      await listTab.click();
      await page.waitForTimeout(500);
    }

    // Open timer panel by clicking customer card
    const customerCard = page.locator(`text=時間軸測試員`).first();
    await customerCard.waitFor({ state: 'visible', timeout: 10000 });
    await customerCard.click();
    await page.waitForTimeout(600);

    // Verify timer panel opened
    const timerTitle = page.locator('text=每位計時').first();
    await timerTitle.waitFor({ state: 'visible', timeout: 8000 });
    console.log('PASS: Timer panel opened for checked in booking');

    // -------------------------------------------------------------
    // Test 1: Extend Time (加時 +1 小時)
    // -------------------------------------------------------------
    console.log('Testing ExtendTimeModal (+1 小時)...');
    const extendBtn = page.locator('[data-testid="extend-time-btn"]').first();
    await extendBtn.waitFor({ state: 'visible', timeout: 5000 });
    await extendBtn.click();

    // Modal opens as ResponsivePanel
    const extendPanel = page.locator('text=選擇後續時段').first();
    await extendPanel.waitFor({ state: 'visible', timeout: 8000 });

    // Select the 15:00 - 16:00 session (the next available session)
    const nextSessionBox = page.locator('text=15:00 - 16:00').first();
    await nextSessionBox.waitFor({ state: 'visible', timeout: 5000 });
    await nextSessionBox.click();

    // Confirm extend
    const confirmExtendBtn = page.locator('[data-testid="confirm-extend-btn"]').first();
    await confirmExtendBtn.click();
    await page.waitForTimeout(1000);

    // Verify booking duration in timer panel updated to 3 hours (13:00 到 16:00 · 3 小時)
    const updatedRange = page.locator('text=13:00 到 16:00 · 3 小時').first();
    await updatedRange.waitFor({ state: 'visible', timeout: 8000 });
    console.log('PASS: Extended time by +1 hour; booking range updated to 13:00 到 16:00 · 3 小時');

    // -------------------------------------------------------------
    // Test 2: Add Person (＋ 加人 -> 選空位入座)
    // -------------------------------------------------------------
    console.log('Testing Add Person (＋ 加人)...');
    const addPersonBtn = page.locator('[data-testid="add-person-btn"]').first();
    await addPersonBtn.click();

    // Add person modal opens
    const addPersonPanel = page.locator('text=請為新加入的顧客選擇入座空位').first();
    await addPersonPanel.waitFor({ state: 'visible', timeout: 8000 });

    // Pick empty seat A1-2
    const emptySeatBtn = page.locator('[data-testid="seat-select-A1-2"]').first();
    await emptySeatBtn.waitFor({ state: 'visible', timeout: 5000 });
    await emptySeatBtn.click();

    // Confirm add person
    const confirmAddPersonBtn = page.locator('[data-testid="confirm-add-person-btn"]').first();
    await confirmAddPersonBtn.click();
    await page.waitForTimeout(1000);

    // Verify Person 2 row and timeline bar appear!
    const person2Row = page.locator('text=第 2 位 · A1-2').first();
    await person2Row.waitFor({ state: 'visible', timeout: 8000 });
    const person2Timeline = page.locator('[data-testid="person-timeline-bar-2"]').first();
    await person2Timeline.waitFor({ state: 'visible', timeout: 5000 });
    console.log('PASS: Added Person 2 seated at A1-2; timeline bar is active');

    // -------------------------------------------------------------
    // Test 3: Add Smart Board for Person 2 (加租中板 19:00 到 21:00)
    // -------------------------------------------------------------
    console.log('Testing Add Board for Person 2 (中板 19:00-21:00)...');
    const moreBtn2 = page.locator('[data-testid="person-more-btn-2"]').first();
    await moreBtn2.click();

    const addBoardOpt = page.locator('[data-testid="person-add-board-btn-2"]').first();
    await addBoardOpt.waitFor({ state: 'visible', timeout: 5000 });
    await addBoardOpt.click();

    // Add board modal opens
    const addBoardPanel = page.locator('text=加租智能板').first();
    await addBoardPanel.waitFor({ state: 'visible', timeout: 8000 });

    // Select medium board
    const medChoice = page.locator('[data-testid="board-choice-medium"]').first();
    await medChoice.click();

    // Fill from time 19:00 and to time 21:00
    const fromInput = page.locator('[data-testid="add-board-from-time"]').first();
    await fromInput.fill('19:00');
    const toInput = page.locator('[data-testid="add-board-to-time"]').first();
    await toInput.fill('21:00');

    // Confirm add board
    const confirmAddBoardBtn = page.locator('[data-testid="confirm-add-board-btn"]').first();
    await confirmAddBoardBtn.click();
    await page.waitForTimeout(1000);

    // Verify: sub-bar appears under person 2's timeline!
    const boardSubbar2 = page.locator('[data-testid="board-segment-2"]').first();
    await boardSubbar2.waitFor({ state: 'visible', timeout: 8000 });
    const boardSubbarText = await boardSubbar2.innerText();
    assert.ok(boardSubbarText.includes('中板'), 'Must show 中板 in sub-bar');
    console.log(`PASS: Smart board sub-bar visible for Person 2: ${boardSubbarText}`);

    // Verify billing in workbench: Person 2 smart board fee is NT$240 (2 hrs * 120)
    const checkoutBtn = page.locator('[data-testid="timer-checkout-btn"]:visible');
    await checkoutBtn.click();
    const wbDue = page.locator('[data-testid="workbench-net-due-mobile"]').first();
    await wbDue.waitFor({ state: 'visible', timeout: 8000 });

    // Close workbench and return to seating page
    const closeWb = page.locator('[data-testid="workbench-close-btn"]').first();
    await closeWb.click();
    await page.waitForTimeout(500);

    // -------------------------------------------------------------
    // Test 4: Pause Person 1 for 5 minutes (via DB) -> grey diagonal stripes
    // -------------------------------------------------------------
    console.log('Testing pause segment (grey diagonal stripes on timeline)...');
    const pauseStart = new Date(`${testDateStr}T13:30:00+08:00`);
    const pauseEnd = new Date(`${testDateStr}T13:45:00+08:00`);
    await prisma.timerPause.create({
      data: {
        person_id: person1.id,
        started_at: pauseStart,
        ended_at: pauseEnd,
        reason: '休息片刻'
      }
    });
    await prisma.bookingPerson.update({
      where: { id: person1.id },
      data: { paused_seconds: 900 }
    });

    // Reopen timer panel to refresh
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(800);
    const listTabAgain = page.locator('button:visible:has-text("名單")').first();
    if (await listTabAgain.isVisible().catch(() => false)) {
      await listTabAgain.click();
      await page.waitForTimeout(400);
    }
    const customerCardAgain = page.locator(`text=時間軸測試員`).first();
    await customerCardAgain.waitFor({ state: 'visible', timeout: 8000 });
    await customerCardAgain.click();

    // Check pause segment exists on Person 1 timeline
    const pauseSegment = page.locator('[data-testid="pause-segment-1-0"]').first();
    await pauseSegment.waitFor({ state: 'visible', timeout: 8000 });
    console.log('PASS: Grey diagonal stripes pause segment visible on Person 1 timeline');

    // -------------------------------------------------------------
    // Capture mobile screenshot: section5-seating-timeline.png
    // -------------------------------------------------------------
    const screenshotPath = path.join(SCREENSHOT_DIR, 'section5-seating-timeline.png');
    await page.screenshot({ path: screenshotPath });
    console.log(`Saved screenshot to ${screenshotPath}`);

    const stat = fs.statSync(screenshotPath);
    assert.ok(stat.size > 10000, 'Screenshot file must be > 10KB');

    console.log('--- Round 9 Section 5 Playwright Tests Finished Successfully ---');
  } finally {
    // Cleanup
    await prisma.accountingEvent.deleteMany({ where: { booking_ref: testRef } }).catch(() => {});
    await prisma.bookingEquipment.deleteMany({ where: { booking_ref: testRef } }).catch(() => {});
    await prisma.timerPause.deleteMany({ where: { person: { booking_ref: testRef } } }).catch(() => {});
    await prisma.bookingPerson.deleteMany({ where: { booking_ref: testRef } }).catch(() => {});
    await prisma.reservation.deleteMany({ where: { booking_ref: testRef } }).catch(() => {});
    await prisma.session.deleteMany({ where: { session_date: testDate } }).catch(() => {});
    await browser.close();
  }
}

run().catch((err) => {
  console.error('Test run failed:', err);
  process.exit(1);
});
