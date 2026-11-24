// frontend/tests/round39_floor_conflict.spec.js
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const dotenv = require('../../backend/node_modules/dotenv/lib/main.js');
dotenv.config({ path: path.resolve(__dirname, '../../backend/.env') });

const { PrismaClient } = require('../../backend/node_modules/@prisma/client/index.js');
const { ensureFreshDbSeeded, cleanOperationalData } = await import('./helpers/seedFreshDb.js');
const { toTaipeiDateString, dateOnly } = await import('../../shared/time.js');

const testDbUrl =
  process.env.TEST_DATABASE_URL ||
  'postgresql://user:password@localhost:5432/booking_db_test?schema=public';
const prisma = new PrismaClient({ datasources: { db: { url: testDbUrl.trim() } } });

const BASE_URL = process.env.BASE_URL || 'http://localhost:5173';
const HEADLESS = process.env.HEADLESS !== 'false';
if (!process.env.ADMIN_PASSWORD?.trim()) {
  console.error('請設定 ADMIN_PASSWORD 環境變數');
  process.exit(1);
}
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD.trim();

const SCREENSHOT_DIR = process.env.SCREENSHOT_DIR
  ? path.resolve(process.env.SCREENSHOT_DIR)
  : path.resolve(__dirname, 'screenshots');
fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

async function adminLogin(page) {
  await page.goto(`${BASE_URL}/admin/login`, { waitUntil: 'networkidle' });
  const pwdInput = page.locator('input[type="password"]');
  await pwdInput.waitFor({ state: 'visible', timeout: 10000 });
  await pwdInput.fill(ADMIN_PASSWORD);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL(url => url.pathname.includes('/admin/sessions'), {
    timeout: 15000
  });
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(300);
}

async function createCheckedInBooking({
  ref,
  userId,
  sessionId,
  pax,
  assignedSeats,
  personDefs,
  nowDate
}) {
  await prisma.reservation.create({
    data: {
      booking_ref: ref,
      session_id: sessionId,
      user_id: userId,
      pax,
      status: 'confirmed',
      attendance: 'checked_in',
      checked_in_at: new Date(nowDate.getTime() - 20 * 60 * 1000),
      is_seat_locked: true,
      seat_source: 'staff',
      assigned_seats: assignedSeats
    }
  });
  for (const pd of personDefs) {
    await prisma.bookingPerson.create({
      data: {
        booking_ref: ref,
        person_no: pd.person_no,
        seat_code: pd.seat_code ?? null,
        status: pd.status || 'active',
        billing_start_at: pd.billing_start_at === undefined ? new Date(nowDate.getTime() - 20 * 60 * 1000) : pd.billing_start_at,
        timer_started_at: pd.timer_started_at === undefined ? new Date(nowDate.getTime() - 20 * 60 * 1000) : pd.timer_started_at
      }
    });
  }
}

async function run() {
  console.log('--- Starting Round 39 Floor Conflict & Seating Fixes Playwright Test ---');
  await ensureFreshDbSeeded(prisma);
  await cleanOperationalData(prisma);

  const now = new Date();
  const todayStr = toTaipeiDateString(now);
  const todayDate = dateOnly(todayStr);
  const ts = Date.now().toString().slice(-6);

  let layout = null;
  let s1 = null;
  let s2 = null;
  const createdUserIds = [];

  try {
    // Seed 4-seat layout A1-1..A1-4
    await prisma.seatLayout.updateMany({
      where: { status: 'published' },
      data: { status: 'archived' }
    });
    layout = await prisma.seatLayout.create({
      data: {
        name: `R39 Playwright Layout ${ts}`,
        status: 'published',
        effective_from: dateOnly('2020-01-01'),
        canvas_w: 640,
        canvas_h: 420,
        capacity: 4
      }
    });
    const zone = await prisma.seatZone.create({
      data: { layout_id: layout.id, name: '主區', sort_order: 0 }
    });
    const tableA1 = await prisma.seatTable.create({
      data: {
        layout_id: layout.id,
        zone_id: zone.id,
        label: 'A1',
        shape: 'rect',
        arrangement: 'two_sides',
        cx: 240,
        cy: 190,
        w: 90,
        h: 160,
        rotation: 0,
        sort_order: 0
      }
    });
    const seats = [
      { code: 'A1-1', lx: -45, ly: -35, side: 'L', sort_order: 0 },
      { code: 'A1-2', lx: -45, ly: 35, side: 'L', sort_order: 1 },
      { code: 'A1-3', lx: 45, ly: -35, side: 'R', sort_order: 2 },
      { code: 'A1-4', lx: 45, ly: 35, side: 'R', sort_order: 3 }
    ];
    for (const s of seats) {
      await prisma.seat.create({
        data: {
          layout_id: layout.id,
          zone_id: zone.id,
          table_id: tableA1.id,
          code: s.code,
          lx: s.lx,
          ly: s.ly,
          side: s.side,
          side_mode: 'auto',
          priority: 'normal',
          is_active: true,
          sort_order: s.sort_order
        }
      });
    }

    await prisma.session.deleteMany({ where: { session_date: todayDate } });
    s1 = await prisma.session.create({
      data: { session_date: todayDate, start_time: '10:00', end_time: '12:00', max_capacity: 10 }
    });
    s2 = await prisma.session.create({
      data: { session_date: todayDate, start_time: '14:00', end_time: '16:00', max_capacity: 10 }
    });

    const makeUser = async (suffix, name) => {
      const u = await prisma.user.create({
        data: {
          line_user_id: `r39_pw_${suffix}_${ts}`,
          name,
          phone: `0939${ts}${String(createdUserIds.length).padStart(2, '0')}`.slice(0, 10)
        }
      });
      createdUserIds.push(u.id);
      return u;
    };

    const userG = await makeUser('g', '王一組');
    const userA = await makeUser('a', '陳在座A');
    const userB = await makeUser('b', '林後組B');
    const userC = await makeUser('c', '黃對調C');
    const userD = await makeUser('d', '李衝突D');
    const userM3 = await makeUser('m3', '張三人組');
    const userP4 = await makeUser('p4', '吳四人未排');

    // Scenario 1: TablePanel 全組離場雙步確認
    const refG = `BK-R39-G1-${ts}`;
    await createCheckedInBooking({
      ref: refG,
      userId: userG.id,
      sessionId: s1.id,
      pax: 1,
      assignedSeats: ['A1-1'],
      personDefs: [{ person_no: 1, seat_code: 'A1-1' }],
      nowDate: now
    });

    const browser = await chromium.launch({ headless: HEADLESS });
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await context.newPage();

    try {
      await adminLogin(page);
      await page.goto(`${BASE_URL}/admin/seating`, { waitUntil: 'networkidle' });
      await page.waitForTimeout(500);
      await page.locator('button[data-testid="tab-floor"]:visible').first().click();
      await page.waitForTimeout(300);

      // Open TablePanel via mobile table title button A1
      await page.locator(`[data-testid="table-title-btn-${tableA1.id}"]`).waitFor({ state: 'visible', timeout: 8000 });
      await page.locator(`[data-testid="table-title-btn-${tableA1.id}"]`).click();
      const tablePanel = page.locator('[data-testid="table-management-panel"]');
      await tablePanel.waitFor({ state: 'visible', timeout: 8000 });

      let timerPostCount = 0;
      const timerListener = (req) => {
        if (req.url().includes(`/floor/${refG}/timer`) && req.method() === 'POST') {
          timerPostCount++;
        }
      };
      page.on('request', timerListener);

      await tablePanel.locator('button:has-text("全組離場")').first().click();
      await page.locator('text=全組離場？').waitFor({ state: 'visible', timeout: 5000 });
      await page.locator('button:has-text("先不要")').click();
      await page.waitForTimeout(250);
      assert.equal(timerPostCount, 0, 'Cancel on confirm must NOT send timer end request');

      // Second click -> confirm
      await tablePanel.locator('button:has-text("全組離場")').first().click();
      await page.locator('text=全組離場？').waitFor({ state: 'visible', timeout: 5000 });
      const [endResp] = await Promise.all([
        page.waitForResponse(r => r.url().includes(`/floor/${refG}/timer`) && r.request().method() === 'POST'),
        page.locator('[role="dialog"] button:has-text("全組離場")').last().click()
      ]);
      assert.equal(endResp.status(), 200, 'Group leave confirm should return 200');
      page.off('request', timerListener);

      // Switch to desktop viewport for Scenarios 2-4
      await page.setViewportSize({ width: 1280, height: 800 });

      // Clean Scenario 1 before Scenario 2
      await cleanOperationalData(prisma);

      // Scenario 2: Cross-session occupied checkIn + swap label + seat conflict alert/badge
      const refA = `BK-R39-A-${ts}`;
      const refB = `BK-R39-B-${ts}`;
      const refC = `BK-R39-C-${ts}`;
      await createCheckedInBooking({
        ref: refA,
        userId: userA.id,
        sessionId: s1.id,
        pax: 1,
        assignedSeats: ['A1-1'],
        personDefs: [{ person_no: 1, seat_code: 'A1-1' }],
        nowDate: now
      });
      await prisma.reservation.create({
        data: {
          booking_ref: refB,
          session_id: s2.id,
          user_id: userB.id,
          pax: 1,
          status: 'confirmed',
          attendance: null,
          assigned_seats: ['A1-2']
        }
      });
      await createCheckedInBooking({
        ref: refC,
        userId: userC.id,
        sessionId: s2.id,
        pax: 1,
        assigned_seats: ['A1-3'],
        personDefs: [{ person_no: 1, seat_code: 'A1-3' }],
        nowDate: now
      });

      await page.reload({ waitUntil: 'networkidle' });
      await page.waitForTimeout(400);
      await page.locator('button[data-testid="tab-list"]:visible').first().click();
      await page.waitForTimeout(250);

      // Click Check-in button for B (林後組B)
      await page.locator(`[data-booking-ref="${refB}"] button:has-text("報到並帶位")`).click();
      await page.locator('text=系統建議座位：').waitFor({ state: 'visible', timeout: 8000 });

      const a11BtnInCheckIn = page.locator('button:has-text("A1-1"):has-text("有人")').first();
      await a11BtnInCheckIn.waitFor({ state: 'visible', timeout: 5000 });
      assert.equal(await a11BtnInCheckIn.isDisabled(), true, 'A1-1 should be disabled when occupied cross-session');

      const shot1 = path.join(SCREENSHOT_DIR, 'round39_shot1_occupied_checkin.png');
      await page.screenshot({ path: shot1 });
      console.log(`Saved Shot 1: ${shot1}`);

      // Close CheckInPanel -> open C 計時明細 -> 換位 shows 對調 for A1-1
      await page.keyboard.press('Escape');
      await page.waitForTimeout(250);
      await page.locator(`[data-booking-ref="${refC}"]`).click();
      await page.locator('[data-testid="person-timeline-bar-1"]').waitFor({ state: 'visible', timeout: 5000 });
      await page.locator('[data-testid="person-more-btn-1"]').click();
      await page.locator('[data-testid="person-move-seat-btn-1"]').click();
      await page.locator('text=更換座位').waitFor({ state: 'visible', timeout: 5000 });
      const moveOptA11 = page.locator('[data-testid="move-seat-option-A1-1"]');
      await moveOptA11.locator('text=對調').waitFor({ state: 'visible', timeout: 3000 });
      await page.locator('[role="dialog"] button[aria-label="Close"], [role="dialog"] button:has-text("關閉")').first().click().catch(async () => {
        await page.keyboard.press('Escape');
      });

      // Seed direct DB double-occupancy conflict on A1-1 (Booking D checked in on s2 same physical seat A1-1)
      const refD = `BK-R39-D-${ts}`;
      await createCheckedInBooking({
        ref: refD,
        userId: userD.id,
        sessionId: s2.id,
        pax: 1,
        assignedSeats: ['A1-1'],
        personDefs: [{ person_no: 1, seat_code: 'A1-1' }],
        nowDate: now
      });

      await page.reload({ waitUntil: 'networkidle' });
      await page.waitForTimeout(400);
      await page.locator('button[data-testid="tab-floor"]:visible').first().click();
      await page.waitForTimeout(250);

      await page.locator('text=座位衝突：').first().waitFor({ state: 'visible', timeout: 8000 });
      await page.locator('[data-testid="floor-plan-container"] [data-testid="seat-conflict-badge-A1-1"]').waitFor({ state: 'visible', timeout: 8000 });

      const shot2 = path.join(SCREENSHOT_DIR, 'round39_shot2_floor_conflict.png');
      await page.screenshot({ path: shot2 });
      console.log(`Saved Shot 2: ${shot2}`);

      // Clean Scenario 2 before Scenario 3
      await cleanOperationalData(prisma);

      // Scenario 3: Remove person 1 -> click A1-2 opens person 2 & 計時明細 hides person 1 + shows removed note
      const refM3 = `BK-R39-M3-${ts}`;
      await createCheckedInBooking({
        ref: refM3,
        userId: userM3.id,
        sessionId: s1.id,
        pax: 3,
        assignedSeats: ['A1-1', 'A1-2', 'A1-3'],
        personDefs: [
          { person_no: 1, seat_code: 'A1-1' },
          { person_no: 2, seat_code: 'A1-2' },
          { person_no: 3, seat_code: 'A1-3' }
        ],
        nowDate: now
      });

      // Seed 3-pax group with person 1 marked removed ('這位不玩了')
      await prisma.bookingPerson.updateMany({
        where: { booking_ref: refM3, person_no: 1 },
        data: { status: 'removed', seat_code: null }
      });
      await prisma.reservation.updateMany({
        where: { booking_ref: refM3 },
        data: { pax: 2, assigned_seats: ['A1-2', 'A1-3'] }
      });

      await page.reload({ waitUntil: 'networkidle' });
      await page.waitForTimeout(400);
      await page.locator('button[data-testid="tab-list"]:visible').first().click();
      await page.waitForTimeout(250);

      // Open 計時明細 of M3 -> only 2 & 3 shown + removed-persons-note
      await page.locator(`[data-booking-ref="${refM3}"]`).click();
      await page.locator('[data-testid="person-timeline-bar-2"]').waitFor({ state: 'visible', timeout: 5000 });
      assert.equal(await page.locator('[data-testid="person-timeline-bar-1"]').count(), 0, 'Removed person 1 must not be listed');
      assert.equal(await page.locator('[data-testid="person-timeline-bar-3"]').count(), 1, 'Active person 3 must be listed');
      const removedNote = await page.locator('[data-testid="removed-persons-note"]').innerText();
      assert.ok(removedNote.includes('已移除 1 位（這位不玩了）'), `Unexpected removed note: ${removedNote}`);

      const shot3 = path.join(SCREENSHOT_DIR, 'round39_shot3_removed_person_timer.png');
      await page.screenshot({ path: shot3 });
      console.log(`Saved Shot 3: ${shot3}`);

      // Close modal & switch to floor tab -> click seat A1-2 SeatTile -> must show 第 2 位
      await page.keyboard.press('Escape');
      await page.waitForTimeout(250);
      await page.locator('button[data-testid="tab-floor"]:visible').first().click();
      await page.waitForTimeout(250);
      await page.locator('[data-testid="floor-plan-container"] button:has-text("A1-2")').first().click();
      await page.locator('[data-testid="seat-action-panel-content"]').waitFor({ state: 'visible', timeout: 5000 });
      await page.locator('text=/第 2 位/').first().waitFor({ state: 'visible', timeout: 5000 });

      // Clean Scenario 3 before Scenario 4
      await cleanOperationalData(prisma);

      // Scenario 4: 4-pax booking checked in on 2 seats (A1-1, A1-2) -> assign A1-3 via 「帶位」
      const refP4 = `BK-R39-P4-${ts}`;
      await createCheckedInBooking({
        ref: refP4,
        userId: userP4.id,
        sessionId: s1.id,
        pax: 4,
        assignedSeats: ['A1-1', 'A1-2'],
        personDefs: [
          { person_no: 1, seat_code: 'A1-1' },
          { person_no: 2, seat_code: 'A1-2' },
          { person_no: 3, seat_code: null, billing_start_at: null, timer_started_at: null },
          { person_no: 4, seat_code: null, billing_start_at: null, timer_started_at: null }
        ],
        nowDate: now
      });

      await page.reload({ waitUntil: 'networkidle' });
      await page.waitForTimeout(400);
      await page.locator('button[data-testid="tab-list"]:visible').first().click();
      await page.waitForTimeout(250);

      await page.locator(`[data-booking-ref="${refP4}"]`).click();
      await page.locator('[data-testid="person-timeline-bar-3"]').waitFor({ state: 'visible', timeout: 5000 });
      await page.locator('text=第 3 位 · 未帶位').waitFor({ state: 'visible', timeout: 3000 });

      await page.locator('[data-testid="person-more-btn-3"]').click();
      const seatBtn3 = page.locator('[data-testid="person-move-seat-btn-3"]');
      assert.equal((await seatBtn3.innerText()).trim(), '帶位', 'Unseated person menu action should say 帶位');
      await seatBtn3.click();

      await page.locator('text=為客人帶位').waitFor({ state: 'visible', timeout: 5000 });
      // A1-1 and A1-2 are already seated in same group -> disabled in assign mode
      assert.equal(await page.locator('[data-testid="move-seat-option-A1-1"]').isDisabled(), true, 'A1-1 should be disabled in assign mode');
      assert.equal(await page.locator('[data-testid="move-seat-option-A1-3"]').isDisabled(), false, 'A1-3 should be enabled in assign mode');

      const shot4 = path.join(SCREENSHOT_DIR, 'round39_shot4_seat_person_picker.png');
      await page.screenshot({ path: shot4 });
      console.log(`Saved Shot 4: ${shot4}`);

      const [seatResp] = await Promise.all([
        page.waitForResponse(r => r.url().includes(`/floor/${refP4}/persons/3/seat`) && r.request().method() === 'POST'),
        page.locator('[data-testid="move-seat-option-A1-3"]').click()
      ]);
      assert.equal(seatResp.status(), 200, 'Assigning seat A1-3 to person 3 should return 200');
      await page.waitForTimeout(350);

      await page.keyboard.press('Escape');
      await page.waitForTimeout(250);
      await page.locator('button[data-testid="tab-floor"]:visible').first().click();
      await page.waitForTimeout(250);
      await page.locator('[data-testid="floor-plan-container"] button:has-text("A1-3")').first().click();
      await page.locator('[data-testid="seat-action-panel-content"]').waitFor({ state: 'visible', timeout: 5000 });
      await page.locator('text=/第 3 位/').first().waitFor({ state: 'visible', timeout: 5000 });

      console.log('--- Round 39 Playwright Verification Passed ---');
    } finally {
      await browser.close();
    }
  } finally {
    await cleanOperationalData(prisma).catch(() => {});
    if (s1) await prisma.session.deleteMany({ where: { id: s1.id } }).catch(() => {});
    if (s2) await prisma.session.deleteMany({ where: { id: s2.id } }).catch(() => {});
    if (layout) {
      await prisma.seat.deleteMany({ where: { layout_id: layout.id } }).catch(() => {});
      await prisma.seatTable.deleteMany({ where: { layout_id: layout.id } }).catch(() => {});
      await prisma.seatZone.deleteMany({ where: { layout_id: layout.id } }).catch(() => {});
      await prisma.seatLayout.deleteMany({ where: { id: layout.id } }).catch(() => {});
    }
    if (createdUserIds.length > 0) {
      await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } }).catch(() => {});
    }
    await prisma.$disconnect();
  }
}

run().catch((err) => {
  console.error('Round 39 Playwright test failed:', err);
  process.exit(1);
});
