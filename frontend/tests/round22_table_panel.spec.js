import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { ensureFreshDbSeeded, cleanOperationalData } from './helpers/seedFreshDb.js';
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

// Target Mobile Viewport
const MOBILE_VIEWPORT = { width: 390, height: 844 };

async function run() {
  console.log('--- Starting Round 22 TablePanel & Dash Playwright Test ---');
  await ensureFreshDbSeeded(prisma);

  const todayStr = toTaipeiDateString(new Date());
  const todayDate = dateOnly(todayStr);

  // 1. Create a 10-table (> 8 tables) layout to test MiniMap smart zoom
  // Zone A: Tables A1..A5, Zone B: Tables B1..B5 (total 10 tables, 40 seats)
  const testLayout = await prisma.seatLayout.create({
    data: {
      name: 'Round 22 Playwright Layout',
      status: 'published',
      effective_from: todayDate,
      canvas_w: 1000,
      canvas_h: 625,
      capacity: 40,
      elements_json: [
        { id: 'w1', type: 'wall', points: [[20, 20], [980, 20], [980, 605], [20, 605], [20, 20]] },
        { id: 'd1', type: 'door', x: 20, y: 100, w: 10, h: 60, label: '大門' },
        { id: 'c1', type: 'counter', x: 80, y: 50, w: 120, h: 50, rotation: 0, label: '服務櫃檯' }
      ]
    }
  });

  const zoneA = await prisma.seatZone.create({
    data: { layout_id: testLayout.id, name: '前區', sort_order: 0 }
  });
  const zoneB = await prisma.seatZone.create({
    data: { layout_id: testLayout.id, name: '後區', sort_order: 1 }
  });

  const tableDefs = [
    // Zone A (5 tables)
    { zone_id: zoneA.id, label: 'A1', cx: 150, cy: 150, w: 70, h: 140, sort_order: 0 },
    { zone_id: zoneA.id, label: 'A2', cx: 150, cy: 330, w: 70, h: 140, sort_order: 1 },
    { zone_id: zoneA.id, label: 'A3', cx: 150, cy: 510, w: 70, h: 140, sort_order: 2 },
    { zone_id: zoneA.id, label: 'A4', cx: 320, cy: 150, w: 70, h: 140, sort_order: 3 },
    { zone_id: zoneA.id, label: 'A5', cx: 320, cy: 330, w: 70, h: 140, sort_order: 4 },
    // Zone B (5 tables)
    { zone_id: zoneB.id, label: 'B1', cx: 620, cy: 150, w: 70, h: 140, sort_order: 0 },
    { zone_id: zoneB.id, label: 'B2', cx: 620, cy: 330, w: 70, h: 140, sort_order: 1 },
    { zone_id: zoneB.id, label: 'B3', cx: 620, cy: 510, w: 70, h: 140, sort_order: 2 },
    { zone_id: zoneB.id, label: 'B4', cx: 800, cy: 150, w: 70, h: 140, sort_order: 3 },
    { zone_id: zoneB.id, label: 'B5', cx: 800, cy: 330, w: 70, h: 140, sort_order: 4 }
  ];

  const createdTables = [];
  for (const td of tableDefs) {
    const tbl = await prisma.seatTable.create({
      data: {
        layout_id: testLayout.id,
        zone_id: td.zone_id,
        label: td.label,
        shape: 'rect',
        arrangement: 'two_sides',
        cx: td.cx,
        cy: td.cy,
        w: td.w,
        h: td.h,
        rotation: 0,
        sort_order: td.sort_order
      }
    });
    createdTables.push(tbl);

    // 4 seats per table: two_sides (L: -45, R: 45)
    const seatDefs = [
      { code: `${td.label}-1`, lx: -45, ly: -35, sort_order: 0 },
      { code: `${td.label}-2`, lx: -45, ly: 35, sort_order: 1 },
      { code: `${td.label}-3`, lx: 45, ly: -35, sort_order: 2 },
      { code: `${td.label}-4`, lx: 45, ly: 35, sort_order: 3 }
    ];

    for (const sd of seatDefs) {
      await prisma.seat.create({
        data: {
          layout_id: testLayout.id,
          table_id: tbl.id,
          zone_id: td.zone_id,
          code: sd.code,
          lx: sd.lx,
          ly: sd.ly,
          side_mode: 'auto',
          priority: 'normal',
          is_active: true,
          sort_order: sd.sort_order
        }
      });
    }
  }

  const tableA1 = createdTables.find(t => t.label === 'A1');

  // 2. Setup Sessions for today
  await prisma.session.deleteMany({ where: { session_date: todayDate } });
  const allSessions = [];
  for (let hour = 10; hour < 22; hour++) {
    const st = `${String(hour).padStart(2, '0')}:00`;
    const et = `${String(hour + 1).padStart(2, '0')}:00`;
    const sess = await prisma.session.create({
      data: {
        session_date: todayDate,
        start_time: st,
        end_time: et,
        max_capacity: 40
      }
    });
    allSessions.push(sess);
  }

  // 3. Setup Users & 2 Checked-in Reservations sitting at Table A1
  // Group 1: 2 persons on A1-1, A1-2
  // Group 2: 1 person on A1-3
  // Free seat remaining on Table A1: A1-4
  const user1 = await prisma.user.create({
    data: {
      line_user_id: `r22_user_g1_${Date.now()}`,
      name: '王小明',
      phone: '0912345678'
    }
  });

  const user2 = await prisma.user.create({
    data: {
      line_user_id: `r22_user_g2_${Date.now()}`,
      name: '李小華',
      phone: '0987654321'
    }
  });

  const refG1 = 'BK-R22-G1';
  const refG2 = 'BK-R22-G2';
  const checkInTime = new Date();

  // Create reservations covering first two sessions
  for (const sess of allSessions.slice(0, 3)) {
    await prisma.reservation.create({
      data: {
        booking_ref: refG1,
        user_id: user1.id,
        session_id: sess.id,
        pax: 2,
        status: 'confirmed',
        attendance: 'checked_in',
        checked_in_at: checkInTime,
        assigned_seats: ['A1-1', 'A1-2'],
        total_amount: 600,
        amount_received: 0,
        billing_status: 'unpaid'
      }
    });

    await prisma.reservation.create({
      data: {
        booking_ref: refG2,
        user_id: user2.id,
        session_id: sess.id,
        pax: 1,
        status: 'confirmed',
        attendance: 'checked_in',
        checked_in_at: checkInTime,
        assigned_seats: ['A1-3'],
        total_amount: 300,
        amount_received: 0,
        billing_status: 'unpaid'
      }
    });
  }

  // BookingPersons
  await prisma.bookingPerson.createMany({
    data: [
      { booking_ref: refG1, person_no: 1, seat_code: 'A1-1', status: 'active', timer_started_at: checkInTime },
      { booking_ref: refG1, person_no: 2, seat_code: 'A1-2', status: 'active', timer_started_at: checkInTime },
      { booking_ref: refG2, person_no: 1, seat_code: 'A1-3', status: 'active', timer_started_at: checkInTime }
    ]
  });

  const launchOptions = { headless: HEADLESS };
  if (process.env.PLAYWRIGHT_CHROMIUM_PATH) {
    launchOptions.executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH;
  }
  const browser = await chromium.launch(launchOptions);

  try {
    const context = await browser.newContext({
      viewport: MOBILE_VIEWPORT,
      deviceScaleFactor: 2
    });
    const page = await context.newPage();
    page.on('console', msg => console.log('[PAGE]', msg.type(), msg.text()));
    page.on('pageerror', err => console.error('[PAGE ERROR]', err));

    await page.addInitScript(() => {
      localStorage.setItem('shiguang_seating_tab', 'floor');
    });

    // 1. Login as admin
    console.log('Logging in as admin...');
    await page.goto(`${BASE_URL}/admin/login`, { waitUntil: 'networkidle' });
    const pwInput = page.locator('input[type="password"]');
    await pwInput.waitFor({ state: 'visible', timeout: 10000 });
    await pwInput.fill(ADMIN_PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForURL(url => !url.pathname.includes('/login'), { timeout: 10000 });
    await page.waitForTimeout(600);

    // 2. Navigate to /admin/seating
    console.log('Navigating to /admin/seating...');
    await page.goto(`${BASE_URL}/admin/seating`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(800);

    // Explicitly click mobile floor tab
    const floorTabMobile = page.locator('button[data-testid="tab-floor"]').last();
    if (await floorTabMobile.isVisible()) {
      await floorTabMobile.click();
      await page.waitForTimeout(600);
    }

    // --- SCREENSHOT 1: 縮圖放大後 (screenshot_round22_minimap_zoom_mobile.png) ---
    console.log('Capturing Screenshot 1: MiniMap Zoomed In...');
    const tableA1InMap = page.locator('[data-minimap-table="A1"]');
    await tableA1InMap.waitFor({ state: 'visible', timeout: 10000 });
    await tableA1InMap.click();
    await page.waitForTimeout(500);

    // Verify zoom: Table labels A1 & A2 are now visible in MiniMap SVG
    const svgLabelA1 = page.locator('svg text:has-text("A1")').first();
    await svgLabelA1.waitFor({ state: 'visible', timeout: 5000 });

    const shot1Path = path.resolve(process.cwd(), 'screenshot_round22_minimap_zoom_mobile.png');
    await page.screenshot({ path: shot1Path });
    console.log(`Saved: ${shot1Path}`);

    // --- SCREENSHOT 2: 桌卡用虛線框出同一組 (screenshot_round22_table_dashed_mobile.png) ---
    console.log('Capturing Screenshot 2: TableCard with Group Dashed Borders...');
    const tableCardA1 = page.locator(`#table-card-${tableA1.id}`);
    await tableCardA1.waitFor({ state: 'visible', timeout: 10000 });
    await tableCardA1.scrollIntoViewIfNeeded();
    await page.waitForTimeout(500);

    // Verify SVG overlay dashed group boundaries exist in TableCard
    const dashedBoxes = tableCardA1.locator('svg [data-group-box="true"]');
    const boxCount = await dashedBoxes.count();
    assert.ok(boxCount >= 2, `Expected at least 2 group dashed bounding boxes, got ${boxCount}`);

    const shot2Path = path.resolve(process.cwd(), 'screenshot_round22_table_dashed_mobile.png');
    await page.screenshot({ path: shot2Path });
    console.log(`Saved: ${shot2Path}`);

    // --- SCREENSHOT 3: 整桌面板：同桌兩組 (screenshot_round22_table_panel_mobile.png) ---
    console.log('Opening TablePanel by clicking Table Title button A1 ›...');
    const titleBtn = page.locator(`[data-testid="table-title-btn-${tableA1.id}"]`);
    await titleBtn.waitFor({ state: 'visible', timeout: 10000 });
    await titleBtn.click();
    await page.waitForTimeout(600);

    // Verify TablePanel header
    const panelHeader = page.locator('[data-testid="table-panel-title"]:has-text("A1 · 使用中 3 / 4 位")');
    await panelHeader.waitFor({ state: 'visible', timeout: 10000 });

    // Verify both groups appear
    const group1Card = page.locator('[data-testid="group-card-1"]');
    const group2Card = page.locator('[data-testid="group-card-2"]');
    await group1Card.waitFor({ state: 'visible', timeout: 5000 });
    await group2Card.waitFor({ state: 'visible', timeout: 5000 });

    const group1Title = page.locator('text=第 1 組');
    const group2Title = page.locator('text=第 2 組');
    await group1Title.waitFor({ state: 'visible', timeout: 5000 });
    await group2Title.waitFor({ state: 'visible', timeout: 5000 });

    // Verify person rows inside group cards are rendered
    const g1SeatA11 = group1Card.locator('span:has-text("A1-1")');
    const g1SeatA12 = group1Card.locator('span:has-text("A1-2")');
    const g2SeatA13 = group2Card.locator('span:has-text("A1-3")');
    await g1SeatA11.waitFor({ state: 'visible', timeout: 5000 });
    await g1SeatA12.waitFor({ state: 'visible', timeout: 5000 });
    await g2SeatA13.waitFor({ state: 'visible', timeout: 5000 });

    // Verify bottom button: 新的一組坐這桌 · 空 1 位
    const forceAddBtn = page.locator('[data-testid="force-add-table-btn"]');
    await forceAddBtn.waitFor({ state: 'visible', timeout: 5000 });

    const shot3Path = path.resolve(process.cwd(), 'screenshot_round22_table_panel_mobile.png');
    await page.screenshot({ path: shot3Path });
    console.log(`Saved: ${shot3Path}`);

    // --- PLAYWRIGHT SPEC REQUIREMENT: 點「為這組加人」、驗證 pax 變成 +1 ---
    console.log('Testing: click "＋ 為這組加人" and verify pax increases by 1...');
    // In Group 2 (李小華, currently 1 pax), click "＋ 為這組加人"
    const addPersonBtn2 = page.locator('[data-testid="add-person-btn-2"]');
    await addPersonBtn2.waitFor({ state: 'visible', timeout: 5000 });

    // Wait for response from /floor/BK-R22-G2/persons
    const [personAddResponse] = await Promise.all([
      page.waitForResponse(res => res.url().includes('/floor/BK-R22-G2/persons') && res.status() === 200),
      addPersonBtn2.click()
    ]);
    assert.ok(personAddResponse.ok(), 'Add person API call succeeded');

    // Verify TablePanel header updates to 4 / 4 位
    const updatedPanelHeader = page.locator('[data-testid="table-panel-title"]:has-text("A1 · 使用中 4 / 4 位")');
    await updatedPanelHeader.waitFor({ state: 'visible', timeout: 10000 });

    // Verify Group 2 now displays 2 位
    const group2Pax = page.locator('[data-testid="group-pax-2"]:has-text("2 位")');
    await group2Pax.waitFor({ state: 'visible', timeout: 5000 });

    // Verify database record has updated pax to 2
    const updatedResG2 = await prisma.reservation.findFirst({
      where: { booking_ref: refG2 }
    });
    assert.equal(updatedResG2.pax, 2, 'Reservation pax in DB should be updated to 2');

    console.log('--- All Round 22 Playwright Verifications Passed Successfully! ---');
  } finally {
    await browser.close();

    // Clean up all test data to preserve 0 operational rows
    await prisma.bookingPerson.deleteMany({ where: { booking_ref: { in: [refG1, refG2] } } });
    await prisma.reservation.deleteMany({ where: { booking_ref: { in: [refG1, refG2] } } });
    await prisma.session.deleteMany({ where: { session_date: todayDate } });
    await prisma.seat.deleteMany({ where: { layout_id: testLayout.id } });
    await prisma.seatTable.deleteMany({ where: { layout_id: testLayout.id } });
    await prisma.seatZone.deleteMany({ where: { layout_id: testLayout.id } });
    await prisma.seatLayout.deleteMany({ where: { id: testLayout.id } });
    await prisma.user.deleteMany({ where: { id: { in: [user1.id, user2.id] } } });

    await cleanOperationalData(prisma);
    await prisma.$disconnect().catch(() => {});
  }
}

run().catch(err => {
  console.error('Playwright Test Failed:', err);
  process.exit(1);
});
