import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { ensureFreshDbSeeded, cleanOperationalData } from './helpers/seedFreshDb.js';
import { toTaipeiDateString, dateOnly } from '../../shared/time.js';

const require = createRequire(import.meta.url);
const testDbUrl = process.env.TEST_DATABASE_URL || 'postgresql://user:password@localhost:5432/booking_db_test?schema=public';
let PrismaClient;
try {
  ({ PrismaClient } = require('@prisma/client'));
} catch {
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
const MOBILE_VIEWPORT = { width: 390, height: 844 };

function pad2(n) {
  return String(n).padStart(2, '0');
}

async function run() {
  console.log('--- Starting Round 23 Seat Panel Playwright Test ---');
  await ensureFreshDbSeeded(prisma);

  const now = new Date();
  const todayStr = toTaipeiDateString(now);
  const todayDate = dateOnly(todayStr);

  // Pick a 4-hour block overlapping NOW so timeline & "現在" line display clearly
  const taipeiHour = Number(
    new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Taipei', hour: '2-digit', hour12: false }).format(now)
  );
  const startHour = Math.max(0, Math.min(19, taipeiHour - 2));
  const sessionHours = [0, 1, 2, 3].map(offset => [
    `${pad2(startHour + offset)}:00`,
    `${pad2(startHour + offset + 1)}:00`
  ]);

  const ts = Date.now();
  const bookingRef = `BK-R23-${ts.toString().slice(-6)}`;

  let testLayout = null;
  let testUser = null;
  const createdSessions = [];

  try {
    // 1. Setup 4-seat layout A1-1..A1-4
    testLayout = await prisma.seatLayout.create({
      data: {
        name: `Round 23 Layout ${ts}`,
        status: 'published',
        effective_from: todayDate,
        canvas_w: 600,
        canvas_h: 400,
        capacity: 4
      }
    });
    const zone = await prisma.seatZone.create({
      data: { layout_id: testLayout.id, name: '主區', sort_order: 0 }
    });
    const tableA1 = await prisma.seatTable.create({
      data: {
        layout_id: testLayout.id,
        zone_id: zone.id,
        label: 'A1',
        shape: 'rect',
        arrangement: 'two_sides',
        cx: 220,
        cy: 180,
        w: 90,
        h: 160,
        rotation: 0,
        sort_order: 0
      }
    });
    const seatDefs = [
      { code: 'A1-1', lx: -45, ly: -35, sort_order: 0 },
      { code: 'A1-2', lx: -45, ly: 35, sort_order: 1 },
      { code: 'A1-3', lx: 45, ly: -35, sort_order: 2 },
      { code: 'A1-4', lx: 45, ly: 35, sort_order: 3 }
    ];
    for (const sd of seatDefs) {
      await prisma.seat.create({
        data: {
          layout_id: testLayout.id,
          table_id: tableA1.id,
          zone_id: zone.id,
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

    // 2. Sessions
    for (const [st, et] of sessionHours) {
      let s = await prisma.session.findUnique({
        where: { session_date_start_time: { session_date: todayDate, start_time: st } }
      });
      if (!s) {
        s = await prisma.session.create({
          data: { session_date: todayDate, start_time: st, end_time: et, max_capacity: 12 }
        });
      }
      createdSessions.push(s);
    }

    // 3. Test user + equipment configs
    testUser = await prisma.user.create({
      data: {
        line_user_id: `r23_pw_user_${ts}`,
        name: '時間軸客人',
        phone: '0912000111'
      }
    });

    await prisma.equipmentConfig.upsert({
      where: { id: 'pegboard_s' },
      update: { name: '小板 (52×52)', hourly_rate: 90, total_stock: 10, visibility_status: 'ACTIVE' },
      create: { id: 'pegboard_s', name: '小板 (52×52)', hourly_rate: 90, total_stock: 10, visibility_status: 'ACTIVE' }
    });
    await prisma.equipmentConfig.upsert({
      where: { id: 'pegboard_m' },
      update: { name: '中板 (78×78)', hourly_rate: 120, total_stock: 10, visibility_status: 'ACTIVE' },
      create: { id: 'pegboard_m', name: '中板 (78×78)', hourly_rate: 120, total_stock: 10, visibility_status: 'ACTIVE' }
    });

    const bStart = new Date(`${todayStr}T${sessionHours[0][0]}:00+08:00`);
    const p1PauseStart = new Date(bStart.getTime() + 45 * 60000);
    const p1PauseEnd = new Date(bStart.getTime() + 57 * 60000);
    const p2StartedAt = new Date(now.getTime() - 3 * 60000);

    for (const sess of createdSessions) {
      await prisma.reservation.create({
        data: {
          booking_ref: bookingRef,
          user_id: testUser.id,
          session_id: sess.id,
          pax: 2,
          status: 'confirmed',
          attendance: 'checked_in',
          checked_in_at: bStart,
          assigned_seats: ['A1-1', 'A1-2'],
          total_amount: 1200,
          amount_received: 0,
          billing_status: 'unpaid'
        }
      });
    }

    const p1 = await prisma.bookingPerson.create({
      data: {
        booking_ref: bookingRef,
        person_no: 1,
        seat_code: 'A1-1',
        status: 'active',
        billing_start_at: bStart,
        timer_started_at: bStart,
        paused_seconds: 12 * 60
      }
    });
    await prisma.timerPause.create({
      data: {
        person_id: p1.id,
        started_at: p1PauseStart,
        ended_at: p1PauseEnd,
        reason: '休息',
        staff_name: '店長'
      }
    });

    // Person 2: newly seated (3 mins ago) -> shows 「這位不玩了」
    await prisma.bookingPerson.create({
      data: {
        booking_ref: bookingRef,
        person_no: 2,
        seat_code: 'A1-2',
        status: 'active',
        billing_start_at: p2StartedAt,
        timer_started_at: p2StartedAt
      }
    });

    // Note: Do NOT seed BookingEquipment directly via Prisma; all boards in this test go through UI/API (addBoardRental -> pause -> resume -> swap -> return).

    // 4. Launch Playwright in mobile viewport (390x844)
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

      await page.addInitScript(() => {
        localStorage.setItem('shiguang_seating_tab', 'floor');
      });

      await page.goto(`${BASE_URL}/admin/login`, { waitUntil: 'networkidle' });
      await page.locator('input[type="password"]').fill(ADMIN_PASSWORD);
      await page.click('button[type="submit"]');
      await page.waitForURL(url => !url.pathname.includes('/login'), { timeout: 10000 });
      await page.waitForTimeout(600);

      await page.goto(`${BASE_URL}/admin/seating`, { waitUntil: 'networkidle' });
      await page.waitForTimeout(600);
      const floorTabMobile = page.locator('button[data-testid="tab-floor"]').last();
      if (await floorTabMobile.isVisible()) {
        await floorTabMobile.click();
      }

      // 4-step board UI flow on A1-1 (390x844): 加租 -> 單獨暫停 -> 繼續 -> 換板 -> 歸還
      const tableCardA1 = page.locator(`#table-card-${tableA1.id}`);
      await tableCardA1.waitFor({ state: 'visible', timeout: 10000 });
      const seatA11 = tableCardA1.locator('button[data-seat-code="A1-1"]');
      await seatA11.waitFor({ state: 'visible', timeout: 10000 });
      await seatA11.click();

      const panelContent = page.locator('[data-testid="seat-action-panel-content"]');
      await panelContent.waitFor({ state: 'visible', timeout: 5000 });

      // Step 1: Click 加租智能板 -> pick 小板 -> 確認加租
      const addBoardBtn = panelContent.locator('[data-testid="seat-panel-add-board-btn"]');
      await addBoardBtn.waitFor({ state: 'visible', timeout: 5000 });
      await addBoardBtn.click();

      const smallBoardChoice = page.locator('[data-testid="board-choice-pegboard_s"]');
      await smallBoardChoice.waitFor({ state: 'visible', timeout: 5000 });
      await smallBoardChoice.click();

      const firstFromChip = page.locator('[data-testid="add-board-from-chips"] button').first();
      if (await firstFromChip.isVisible()) {
        await firstFromChip.click();
      }

      const confirmAddBoardBtn = page.locator('[data-testid="confirm-add-board-btn"]');
      const [addResp] = await Promise.all([
        page.waitForResponse(r => r.url().includes(`/floor/${bookingRef}/boards`) && r.request().method() === 'POST'),
        confirmAddBoardBtn.click()
      ]);
      assert.equal(addResp.status(), 200, 'addBoardRental POST should return 200');
      assert.equal(await page.locator('.text-red-700, .bg-red-50').count(), 0, 'Expected no error banners after add board');
      await page.waitForTimeout(350);

      // Reopen A1-1 SeatActionPanel -> Step 2: 智能板單獨暫停 -> screenshot -> 繼續使用智能板
      await seatA11.click();
      await panelContent.waitFor({ state: 'visible', timeout: 5000 });
      await panelContent.locator('text=小板').first().waitFor({ state: 'visible', timeout: 5000 });

      const boardPauseBtn = panelContent.locator('[data-testid="seat-panel-board-pause-btn"]');
      await boardPauseBtn.waitFor({ state: 'visible', timeout: 5000 });
      const [pauseResp] = await Promise.all([
        page.waitForResponse(r => r.url().includes(`/floor/${bookingRef}/boards/`) && r.url().endsWith('/pause') && r.request().method() === 'POST'),
        boardPauseBtn.click()
      ]);
      assert.equal(pauseResp.status(), 200, 'pauseBoard POST should return 200');
      await panelContent.locator('[data-testid="seat-panel-board-pause-btn"]:has-text("繼續使用智能板")').waitFor({ state: 'visible', timeout: 5000 });
      assert.equal(await page.locator('.text-red-700, .bg-red-50').count(), 0, 'Expected no error banners while paused');

      await page.waitForTimeout(250);
      const shot1 = path.resolve(process.cwd(), 'seat_panel_add_board_paused_mobile.png');
      await page.screenshot({ path: shot1 });
      console.log(`Saved Screenshot 1: ${shot1}`);

      const [resumeResp] = await Promise.all([
        page.waitForResponse(r => r.url().includes(`/floor/${bookingRef}/boards/`) && r.url().endsWith('/resume') && r.request().method() === 'POST'),
        boardPauseBtn.click()
      ]);
      assert.equal(resumeResp.status(), 200, 'resumeBoard POST should return 200');
      await panelContent.locator('[data-testid="seat-panel-board-pause-btn"]:has-text("智能板單獨暫停")').waitFor({ state: 'visible', timeout: 5000 });
      assert.equal(await page.locator('.text-red-700, .bg-red-50').count(), 0, 'Expected no error banners after resume');

      // Step 3: 換板 (小板 -> 中板 -> 確認換板)
      const swapBoardBtn = panelContent.locator('[data-testid="seat-panel-swap-board-btn"]');
      await swapBoardBtn.waitFor({ state: 'visible', timeout: 5000 });
      await swapBoardBtn.click();

      const swapDialog = page.locator('[role="dialog"]:has-text("換板")');
      await swapDialog.waitFor({ state: 'visible', timeout: 5000 });
      await swapDialog.locator('button:has-text("中板")').first().click();

      const [swapResp] = await Promise.all([
        page.waitForResponse(r => r.url().includes(`/floor/${bookingRef}/boards/`) && r.url().endsWith('/swap') && r.request().method() === 'POST'),
        swapDialog.locator('button:has-text("確認換板")').click()
      ]);
      assert.equal(swapResp.status(), 200, 'swapBoard POST should return 200');
      assert.equal(await page.locator('.text-red-700, .bg-red-50').count(), 0, 'Expected no error banners after swap board');
      await page.waitForTimeout(350);

      // Reopen A1-1 SeatActionPanel -> verify 中板 shown -> Step 4: 不用了，歸還 (twice to confirm)
      await seatA11.click();
      await panelContent.waitFor({ state: 'visible', timeout: 5000 });
      await panelContent.locator('text=中板').first().waitFor({ state: 'visible', timeout: 5000 });

      const returnBoardBtn = panelContent.locator('[data-testid="seat-panel-board-return-btn"]');
      await returnBoardBtn.waitFor({ state: 'visible', timeout: 5000 });
      await returnBoardBtn.click();
      await panelContent.locator('[data-testid="seat-panel-board-return-btn"]:has-text("確定歸還")').waitFor({ state: 'visible', timeout: 5000 });

      const [returnResp] = await Promise.all([
        page.waitForResponse(r => r.url().includes(`/floor/${bookingRef}/boards/`) && r.url().endsWith('/return') && r.request().method() === 'POST'),
        returnBoardBtn.click()
      ]);
      assert.equal(returnResp.status(), 200, 'returnBoard POST should return 200');
      assert.equal(await page.locator('.text-red-700, .bg-red-50').count(), 0, 'Expected no error banners after return board');
      await page.waitForTimeout(300);

      // Close A1-1 panel if still open
      const closeBtn = page.locator('[role="dialog"] [aria-label="關閉"]').first();
      if (await closeBtn.isVisible()) {
        await closeBtn.click();
        await panelContent.waitFor({ state: 'hidden', timeout: 5000 });
      }

      // Click newly seated guest A1-2 -> click 「這位不玩了」 -> verify button styles & screenshot confirm dialog -> click 「確定移除這位」
      const seatA12 = tableCardA1.locator('button[data-seat-code="A1-2"]');
      await seatA12.waitFor({ state: 'visible', timeout: 10000 });
      await seatA12.click();
      await panelContent.waitFor({ state: 'visible', timeout: 5000 });

      const removeBtn = page.locator('[data-testid="seat-panel-remove-person-btn"]');
      await removeBtn.waitFor({ state: 'visible', timeout: 5000 });
      await removeBtn.click();

      const dialog = page.locator('[data-testid="remove-person-confirm-dialog"]');
      await dialog.waitFor({ state: 'visible', timeout: 5000 });
      await page.locator('[data-testid="remove-person-confirm-message"]').waitFor({ state: 'visible', timeout: 5000 });
      const confirmBtn = page.locator('[data-testid="remove-person-confirm-btn"]');
      const leaveBtn = page.locator('[data-testid="remove-person-leave-btn"]');
      const cancelBtn = page.locator('[data-testid="remove-person-cancel-btn"]');
      await confirmBtn.waitFor({ state: 'visible', timeout: 5000 });
      await leaveBtn.waitFor({ state: 'visible', timeout: 5000 });
      await cancelBtn.waitFor({ state: 'visible', timeout: 5000 });

      // Assert Round 23b Item 4 button visual hierarchy
      const cancelBg = await cancelBtn.evaluate(el => getComputedStyle(el).backgroundColor);
      assert.ok(cancelBg === 'rgba(0, 0, 0, 0)' || cancelBg === 'transparent', `Expected 先不要 to have transparent background, got ${cancelBg}`);

      const shot2 = path.resolve(process.cwd(), 'remove_person_confirm_dialog_mobile.png');
      await page.screenshot({ path: shot2 });
      console.log(`Saved Screenshot 2: ${shot2}`);

      // Copy screenshots to artifact dir if writable
      const artifactDir = process.env.ARTIFACT_DIR || '';
      if (artifactDir && fs.existsSync(artifactDir)) {
        fs.copyFileSync(shot1, path.join(artifactDir, 'seat_panel_add_board_paused_mobile.png'));
        fs.copyFileSync(shot2, path.join(artifactDir, 'remove_person_confirm_dialog_mobile.png'));
      }
      const [removeResp] = await Promise.all([
        page.waitForResponse(r => r.url().includes(`/floor/${bookingRef}/persons/2`) && r.request().method() === 'DELETE'),
        confirmBtn.click()
      ]);
      assert.equal(removeResp.status(), 200, 'removePerson DELETE should return 200');

      await dialog.waitFor({ state: 'hidden', timeout: 5000 });
      await page.waitForTimeout(400);

      // Verify A1-2 seat turned empty (tile no longer shows guest name; clickable A1-2 is empty state!)
      const tileA12Text = await tableCardA1.locator('button[data-seat-code="A1-2"]').innerText();
      assert.ok(!tileA12Text.includes('時間軸客人'), `Expected seat A1-2 to be empty, got: ${tileA12Text}`);

      // Clicking A1-2 opens empty panel subtitle "空位"
      await tableCardA1.locator('button[data-seat-code="A1-2"]').click();
      await page.locator('[role="dialog"] p:has-text("空位")').waitFor({ state: 'visible', timeout: 5000 });

      // Double-check DB: pax decremented to 1, assigned_seats only ['A1-1']
      const updatedRes = await prisma.reservation.findFirst({ where: { booking_ref: bookingRef } });
      assert.equal(updatedRes.pax, 1);
      assert.deepEqual(updatedRes.assigned_seats, ['A1-1']);

      // Close open seat dialog, scroll to top, and verify mobile date picker (DateStrip + MonthCalendar + switching)
      await page.keyboard.press('Escape');
      await page.locator('[role="dialog"]').waitFor({ state: 'hidden', timeout: 5000 });
      await page.evaluate(() => window.scrollTo(0, 0));

      const dateToggle = page.locator('[data-testid="seating-date-toggle"]');
      await dateToggle.waitFor({ state: 'visible', timeout: 5000 });
      assert.ok((await dateToggle.innerText()).includes(todayStr), 'Toggle should initially show todayStr');
      await dateToggle.click();

      const datePickerCard = page.locator('[data-testid="seating-date-picker-card"]');
      await datePickerCard.waitFor({ state: 'visible', timeout: 5000 });

      const stripButtons = datePickerCard.locator('[aria-label="選擇日期"] button');
      const stripCount = await stripButtons.count();
      assert.ok(stripCount >= 30, `Expected DateStrip to render multi-month scrollable days (>=30), got ${stripCount}`);

      await page.waitForTimeout(250);
      await page.screenshot({ path: path.resolve('screenshot_round23_datepicker_strip_mobile.png') });

      // Expand full month calendar
      await datePickerCard.locator('button:has-text("整月")').click();
      const monthGridButtons = datePickerCard.locator('.grid-cols-7 button:not([disabled])');
      await monthGridButtons.first().waitFor({ state: 'visible', timeout: 5000 });
      const monthBtnCount = await monthGridButtons.count();
      assert.ok(monthBtnCount >= 28, `Expected MonthCalendar to render >= 28 day buttons, got ${monthBtnCount}`);

      await page.waitForTimeout(200);
      await page.screenshot({ path: path.resolve('screenshot_round23_datepicker_month_mobile.png') });

      // Pick another day in MonthCalendar and verify /api/floor/live?date= fetch + "回到今天"
      const todayDayText = String(Number(todayStr.slice(8, 10)));
      let targetDayBtn = null;
      for (let i = 0; i < monthBtnCount; i++) {
        const btn = monthGridButtons.nth(i);
        const label = (await btn.innerText()).trim();
        if (/^\d+$/.test(label) && label !== todayDayText) {
          targetDayBtn = btn;
          break;
        }
      }
      assert.ok(targetDayBtn, 'Expected to find a clickable non-today day button in MonthCalendar');

      const [switchResp] = await Promise.all([
        page.waitForResponse(r => r.url().includes('/api/floor/live?date=') && r.request().method() === 'GET'),
        targetDayBtn.click()
      ]);
      assert.equal(switchResp.status(), 200, 'Switching date should fetch /api/floor/live?date=... with 200');
      const switchedText = (await dateToggle.innerText()).trim();
      assert.ok(!switchedText.includes(todayStr), `Expected date toggle to update away from ${todayStr}, got ${switchedText}`);

      const backTodayBtn = page.locator('[data-testid="seating-back-today-btn"]');
      await backTodayBtn.waitFor({ state: 'visible', timeout: 5000 });

      const [resetResp] = await Promise.all([
        page.waitForResponse(r => r.url().includes(`/api/floor/live?date=${todayStr}`) && r.request().method() === 'GET'),
        backTodayBtn.click()
      ]);
      assert.equal(resetResp.status(), 200, 'Clicking 回到今天 should fetch today live floor with 200');
      assert.ok((await dateToggle.innerText()).includes(todayStr), 'Toggle should reset back to todayStr');

      console.log('--- Round 23 Playwright Test Passed! ---');
    } finally {
      await browser.close();
    }
  } finally {
    const eqRows = await prisma.bookingEquipment.findMany({
      where: { booking_ref: bookingRef },
      select: { unit_group: true }
    }).catch(() => []);
    const uGroups = [...new Set(eqRows.map(e => e.unit_group).filter(Boolean))];
    if (uGroups.length) {
      await prisma.boardPause.deleteMany({ where: { unit_group: { in: uGroups } } }).catch(() => {});
    }
    await prisma.bookingEquipment.deleteMany({ where: { booking_ref: bookingRef } }).catch(() => {});
    await prisma.timerPause.deleteMany({ where: { person: { booking_ref: bookingRef } } }).catch(() => {});
    await prisma.bookingPerson.deleteMany({ where: { booking_ref: bookingRef } }).catch(() => {});
    await prisma.reservation.deleteMany({ where: { booking_ref: bookingRef } }).catch(() => {});
    for (const s of createdSessions) {
      await prisma.session.deleteMany({ where: { id: s.id } }).catch(() => {});
    }
    if (testLayout) {
      await prisma.seat.deleteMany({ where: { layout_id: testLayout.id } }).catch(() => {});
      await prisma.seatTable.deleteMany({ where: { layout_id: testLayout.id } }).catch(() => {});
      await prisma.seatZone.deleteMany({ where: { layout_id: testLayout.id } }).catch(() => {});
      await prisma.seatLayout.deleteMany({ where: { id: testLayout.id } }).catch(() => {});
    }
    if (testUser) {
      await prisma.user.deleteMany({ where: { id: testUser.id } }).catch(() => {});
    }
    await cleanOperationalData(prisma);
    await prisma.$disconnect().catch(() => {});
  }
}

run().catch(err => {
  console.error('Round 23 Playwright Test Failed:', err);
  process.exit(1);
});
