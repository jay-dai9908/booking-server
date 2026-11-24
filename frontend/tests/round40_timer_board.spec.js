// frontend/tests/round40_timer_board.spec.js
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
  await page.waitForURL(url => url.pathname.includes('/admin/sessions'), { timeout: 15000 });
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(300);
}

async function run() {
  console.log('--- Starting Round 40 Timer & Board Playwright Test ---');
  await ensureFreshDbSeeded(prisma);
  await cleanOperationalData(prisma);

  const now = new Date();
  const todayStr = toTaipeiDateString(now);
  const todayDate = dateOnly(todayStr);
  const ts = Date.now().toString().slice(-6);

  let layout = null;
  let prevPublishedIds = [];
  let s1 = null;
  let medEq = null;
  const createdUserIds = [];

  try {
    const existingLayouts = await prisma.seatLayout.findMany({
      where: { status: 'published' },
      select: { id: true }
    });
    prevPublishedIds = existingLayouts.map(l => l.id);
    if (prevPublishedIds.length > 0) {
      await prisma.seatLayout.updateMany({
        where: { id: { in: prevPublishedIds } },
        data: { status: 'archived' }
      });
    }

    layout = await prisma.seatLayout.create({
      data: {
        name: `R40測試空間-${ts}`,
        status: 'published',
        effective_from: dateOnly('2020-01-01'),
        canvas_w: 640,
        canvas_h: 420,
        capacity: 4
      }
    });
    const zone = await prisma.seatZone.create({
      data: { layout_id: layout.id, name: 'A區', sort_order: 0 }
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

    await prisma.dailySetting.deleteMany({ where: { date: todayDate } });
    await prisma.dailySetting.create({
      data: {
        date: todayDate,
        allow_unlimited: false,
        hourly_price: 100,
        unlimited_price: null
      }
    });

    const existingMed = await prisma.equipmentConfig.findFirst({
      where: { visibility_status: 'ACTIVE', name: { contains: '中板' } }
    });
    if (!existingMed) {
      medEq = await prisma.equipmentConfig.create({
        data: {
          id: `r40-e2e-med-${ts}`,
          name: '中板',
          visibility_status: 'ACTIVE',
          total_stock: 10,
          hourly_rate: 50,
          daily_cap: null,
          min_contiguous_hours: 1,
          allow_exceed_pax: true,
          sort_order: 98
        }
      });
    }
    const targetMedEq = existingMed || medEq;

    s1 = await prisma.session.create({
      data: {
        session_date: todayDate,
        start_time: '00:00',
        end_time: '23:59',
        max_capacity: 20
      }
    });

    const user1 = await prisma.user.create({
      data: {
        line_user_id: `r40_u1_${ts}`,
        name: '王待時',
        phone: `09401${ts.slice(-5)}` // check-secrets: fake-data
      }
    });
    const user2 = await prisma.user.create({
      data: {
        line_user_id: `r40_u2_${ts}`,
        name: '陳換板',
        phone: `09402${ts.slice(-5)}` // check-secrets: fake-data
      }
    });
    createdUserIds.push(user1.id, user2.id);

    // Booking 1 (Item 1, 3, 5): 2 pax checked in with timer NOT started yet
    const refStart = `R40-E2E-1-${ts}`;
    await prisma.reservation.create({
      data: {
        booking_ref: refStart,
        session_id: s1.id,
        user_id: user1.id,
        pax: 2,
        status: 'confirmed',
        attendance: 'checked_in',
        checked_in_at: now,
        is_seat_locked: true,
        seat_source: 'staff',
        assigned_seats: ['A1-3', 'A1-4']
      }
    });
    await prisma.bookingPerson.createMany({
      data: [
        { booking_ref: refStart, person_no: 1, seat_code: 'A1-3', status: 'active', billing_start_at: new Date(`${todayStr}T14:00:00+08:00`), timer_started_at: null },
        { booking_ref: refStart, person_no: 2, seat_code: 'A1-4', status: 'active', billing_start_at: new Date(`${todayStr}T14:00:00+08:00`), timer_started_at: null }
      ]
    });

    // Booking 2 (Item 4): 2 pax on A1-1, A1-2; Person 1 ALREADY paid (amount 400) + post-payment board started 4h ago (until now)
    const refBoard = `R40-E2E-2-${ts}`;
    const fourHoursAgo = new Date(Date.now() - 4 * 3600000);
    await prisma.reservation.create({
      data: {
        booking_ref: refBoard,
        session_id: s1.id,
        user_id: user2.id,
        pax: 2,
        status: 'confirmed',
        attendance: 'checked_in',
        checked_in_at: fourHoursAgo,
        is_seat_locked: true,
        seat_source: 'staff',
        assigned_seats: ['A1-1', 'A1-2'],
        billing_status: 'partial'
      }
    });
    const bp2_1 = await prisma.bookingPerson.create({
      data: {
        booking_ref: refBoard,
        person_no: 1,
        seat_code: 'A1-1',
        status: 'active',
        billing_start_at: fourHoursAgo,
        timer_started_at: fourHoursAgo,
        timer_ended_at: fourHoursAgo
      }
    });
    await prisma.bookingPerson.create({
      data: {
        booking_ref: refBoard,
        person_no: 2,
        seat_code: 'A1-2',
        status: 'active',
        billing_start_at: now,
        timer_started_at: now
      }
    });
    await prisma.payment.create({
      data: {
        payment_no: `PAY-R40E2E-${ts}`,
        batch_no: `BAT-R40E2E-${ts}`,
        booking_ref: refBoard,
        kind: 'charge',
        status: 'valid',
        method: 'cash',
        amount: 400,
        person_nos: [1],
        staff_name: 'R40E2E',
        device_label: 'POS',
        breakdown_json: {
          persons: [{ person_no: 1, total: 400 }]
        }
      }
    });
    const boardUg = `ug-r40-e2e-${ts}`;
    await prisma.bookingEquipment.create({
      data: {
        booking_ref: refBoard,
        person_id: bp2_1.id,
        equipment_id: targetMedEq.id,
        equipment_name_snapshot: targetMedEq.name,
        quantity: 1,
        unit_group: boardUg,
        segment_no: 1,
        start_at: fourHoursAgo,
        end_at: null,
        planned_end_at: new Date(`${todayStr}T23:59:00+08:00`),
        unit_rate: 50,
        daily_cap_snapshot: null,
        is_price_fixed: false,
        added_after_payment: true,
        rental_hours: 4,
        subtotal_price: 0,
        covered_sessions: ['00:00-23:59']
      }
    });

    const browser = await chromium.launch({ headless: HEADLESS });
    const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
    const page = await context.newPage();

    try {
      await adminLogin(page);
      await page.goto(`${BASE_URL}/admin/seating`, { waitUntil: 'networkidle' });
      await page.waitForTimeout(400);
      await page.locator('button[data-testid="tab-list"]:visible').first().click();
      await page.waitForTimeout(250);

      // SHOT 1: Start Timer button when start_timer was false (Item 3)
      const card1 = page.locator(`[data-booking-ref="${refStart}"]`);
      await card1.waitFor({ state: 'visible', timeout: 8000 });
      await card1.click();
      await page.locator('[data-testid="person-start-btn-1"]').waitFor({ state: 'visible', timeout: 5000 });

      const shot1 = path.join(SCREENSHOT_DIR, 'round40_shot1_start_timer.png');
      await page.screenshot({ path: shot1 });
      console.log(`Saved Shot 1: ${shot1}`);

      await page.locator('[data-testid="all-start-timer-btn"]').click();
      await page.waitForTimeout(500);
      await page.locator('text=計時中').first().waitFor({ state: 'visible', timeout: 5000 });

      // Test Item 1: Group Pause then Resume
      await page.locator('button:has-text("全組暫停")').click();
      await page.waitForTimeout(400);
      await page.locator('button:has-text("全組繼續")').click();
      await page.waitForTimeout(400);

      // Close modal via close button or Escape
      await page.keyboard.press('Escape');
      await page.waitForTimeout(300);

      // SHOT 2: Floor plan TablePanel board menu check (Item 4) - TableCard shows below lg (<1024px)
      await page.setViewportSize({ width: 412, height: 915 });
      await page.waitForTimeout(300);
      await page.locator('button[data-testid="tab-floor"]:visible').first().click();
      await page.waitForTimeout(300);
      await page.locator(`[data-testid="table-title-btn-${tableA1.id}"]:visible`).first().click();
      await page.locator('[data-testid="table-panel-more-btn-2"]:visible').first().waitFor({ state: 'visible', timeout: 5000 });

      // Person 2 has NO board -> no 換板, yes 加租板
      await page.locator('[data-testid="table-panel-more-btn-2"]:visible').first().click();
      await page.locator('[data-testid="table-panel-add-board-btn-2"]:visible').first().waitFor({ state: 'visible', timeout: 3000 });
      assert.equal(await page.locator('[data-testid="table-panel-swap-board-btn-2"]:visible').count(), 0, 'Person 2 should NOT have 換板');

      // Person 1 HAS board -> yes 換板, yes 加租板
      await page.locator('[data-testid="table-panel-more-btn-1"]:visible').first().click();
      await page.locator('[data-testid="table-panel-swap-board-btn-1"]:visible').first().waitFor({ state: 'visible', timeout: 3000 });
      await page.waitForTimeout(250);

      const shot2 = path.join(SCREENSHOT_DIR, 'round40_shot2_table_panel_board_menu.png');
      await page.screenshot({ path: shot2 });
      console.log(`Saved Shot 2: ${shot2}`);

      await page.locator('[data-testid="table-panel-swap-board-btn-1"]:visible').first().click();
      await page.locator('text=/A1-1 第 1 位 · 目前/').waitFor({ state: 'visible', timeout: 5000 });
      await page.keyboard.press('Escape');
      await page.waitForTimeout(300);

      // Reopen TablePanel and verify Add Board modal notice for paid Person 1
      await page.locator(`[data-testid="table-title-btn-${tableA1.id}"]:visible`).first().click();
      await page.locator('[data-testid="table-panel-more-btn-1"]:visible').first().click();
      await page.locator('[data-testid="table-panel-add-board-btn-1"]:visible').first().click();
      await page.locator('[data-testid="add-board-after-payment-notice"]').waitFor({ state: 'visible', timeout: 5000 });
      await page.keyboard.press('Escape');
      await page.waitForTimeout(300);

      // Restore desktop viewport for Shot 3 & Shot 4
      await page.setViewportSize({ width: 1280, height: 860 });
      await page.waitForTimeout(300);

      // SHOT 3: Open Checkout Workbench from SeatingPage -> SplitCollectView -> 現在結算 -> 待補收 -> collect supplement
      await page.locator('button[data-testid="tab-list"]:visible').first().click();
      await page.waitForTimeout(300);
      await page.locator(`[data-booking-ref="${refBoard}"] button:has-text("結帳")`).first().click();
      const splitSettleBtn = page.locator(`[data-testid="split-settle-board-now-btn-${boardUg}"]`);
      await splitSettleBtn.waitFor({ state: 'visible', timeout: 8000 });
      await splitSettleBtn.click();
      await page.locator('text=會以現在時間結算並歸還這台智能板').waitFor({ state: 'visible', timeout: 5000 });
      await page.locator('[role="dialog"] button:has-text("確認")').last().click();
      const pendingBadge1 = page.locator('[data-testid="pending-supplement-badge-1"]');
      await pendingBadge1.waitFor({ state: 'visible', timeout: 8000 });

      const shot3 = path.join(SCREENSHOT_DIR, 'round40_shot3_after_pay_pending_supplement.png');
      await page.screenshot({ path: shot3 });
      console.log(`Saved Shot 3: ${shot3}`);

      // Click 補收 inside SplitCollectView and collect pending supplement
      await page.locator('[data-testid="split-person-supplement-btn"]').first().click();
      await page.locator('text=結清待補收項目').waitFor({ state: 'visible', timeout: 5000 });
      const supCashWrap = page.locator('[data-testid="supplement-cashpad"]');
      await supCashWrap.waitFor({ state: 'visible', timeout: 5000 });
      await supCashWrap.locator('[data-testid="cashpad-received-input"]').fill('200');
      await page.locator('[data-testid="confirm-supplement-btn"]').click();
      await page.waitForTimeout(700);
      const reopenSplit = page.locator('button:has-text("分開收款"):visible').first();
      await reopenSplit.waitFor({ state: 'visible', timeout: 8000 });
      assert.equal(await page.locator('[data-testid="supplement-btn-1"]').count(), 0, 'Pending supplement button must disappear from CheckoutWorkbench');
      await reopenSplit.click();
      await page.locator('[data-testid="split-person-supplement-btn"]').first().waitFor({ state: 'visible', timeout: 8000 });
      assert.equal(await page.locator('[data-testid="pending-supplement-badge-1"]').count(), 0, 'Pending supplement badge must disappear from SplitCollectView');

      // SHOT 4: Undo leave all (Item 5)
      await page.goto(`${BASE_URL}/admin/seating`, { waitUntil: 'networkidle' });
      await page.waitForTimeout(400);
      await page.locator('button[data-testid="tab-list"]:visible').first().click();
      await page.waitForTimeout(250);
      await page.locator(`[data-booking-ref="${refStart}"]`).click();
      await page.locator('[data-testid="all-leave-btn"]').click();
      await page.locator('[role="dialog"] button:has-text("全組離場")').last().click();
      await page.waitForTimeout(500);
      await page.locator('[role="dialog"] button[aria-label="Close"], [role="dialog"] button:has-text("關閉")').first().click().catch(async () => {
        await page.keyboard.press('Escape').catch(() => {});
      });
      await page.waitForTimeout(300);

      // Open 已離場 accordion
      await page.locator('button:has-text("已離場")').first().click();
      const undoBtn = page.locator(`[data-testid="undo-leave-all-btn-${refStart}"]`);
      await undoBtn.waitFor({ state: 'visible', timeout: 5000 });
      await undoBtn.click();
      await page.locator('text=把這組放回計時中？離場這段時間會照算。').waitFor({ state: 'visible', timeout: 5000 });
      await page.locator('[role="dialog"] button:has-text("確認")').last().click();
      await page.locator('text=已取消全組離場').waitFor({ state: 'visible', timeout: 5000 });
      await page.locator(`[data-booking-ref="${refStart}"]`).first().waitFor({ state: 'visible', timeout: 5000 });

      const shot4 = path.join(SCREENSHOT_DIR, 'round40_shot4_undo_leave_all.png');
      await page.screenshot({ path: shot4 });
      console.log(`Saved Shot 4: ${shot4}`);

      console.log('--- Round 40 Playwright Verification Passed ---');
    } finally {
      await browser.close();
    }
  } finally {
    await cleanOperationalData(prisma).catch(() => {});
    if (s1) await prisma.session.deleteMany({ where: { id: s1.id } }).catch(() => {});
    if (medEq) await prisma.equipmentConfig.deleteMany({ where: { id: medEq.id } }).catch(() => {});
    if (layout) {
      await prisma.seat.deleteMany({ where: { layout_id: layout.id } }).catch(() => {});
      await prisma.seatTable.deleteMany({ where: { layout_id: layout.id } }).catch(() => {});
      await prisma.seatZone.deleteMany({ where: { layout_id: layout.id } }).catch(() => {});
      await prisma.seatLayout.deleteMany({ where: { id: layout.id } }).catch(() => {});
    }
    if (prevPublishedIds.length > 0) {
      await prisma.seatLayout.updateMany({
        where: { id: { in: prevPublishedIds } },
        data: { status: 'published' }
      }).catch(() => {});
    }
    if (createdUserIds.length > 0) {
      await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } }).catch(() => {});
    }
    await prisma.$disconnect();
  }
}

run().catch((err) => {
  console.error('Round 40 Playwright test failed:', err);
  process.exit(1);
});
