// frontend/tests/round37_fixes.spec.js
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
const { ensureFreshDbSeeded } = await import('./helpers/seedFreshDb.js');
const { toTaipeiDateString } = await import('../../shared/time.js');

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
  await page.waitForURL(url => !url.pathname.includes('/login'), { timeout: 15000 });
  await page.waitForLoadState('networkidle');
}

async function run() {
  console.log('--- Starting Round 37 Bill Calc Fixes Playwright Test ---');
  await ensureFreshDbSeeded(prisma);

  const runId = Date.now().toString().slice(-6);
  const nowMs = Date.now();
  const todayStr = toTaipeiDateString(new Date(nowMs));
  const todayDate = new Date(`${todayStr}T00:00:00.000Z`);

  // Find a Saturday date in the future for Scenario 2 (DailySetting unlimited_price = 800)
  const satMs = (() => {
    let d = new Date(`${todayStr}T12:00:00Z`);
    for (let i = 1; i <= 14; i++) {
      d = new Date(d.getTime() + 86400000);
      if (d.getUTCDay() === 6) return d.getTime();
    }
    return d.getTime();
  })();
  const satStr = toTaipeiDateString(new Date(satMs));
  const satDate = new Date(`${satStr}T00:00:00.000Z`);

  const refFloor = `BK-R37F-${runId}`;
  const refSat = `BK-R37S-${runId}`;
  const refTimer = `BK-R37T-${runId}`;
  const refConflict = `BK-R37C-${runId}`;
  const createdRefs = [refFloor, refSat, refTimer, refConflict];
  const createdSessionIds = [];
  const createdAddonIds = [];

  let user = null;
  let browser = null;

  try {
    // Ensure AddonItem presets Keychain & Magnet exist for conflict test
    for (const [idx, item] of [[0, { name: '鑰匙圈', price: 100 }], [1, { name: '磁鐵', price: 80 }]]) {
      const existing = await prisma.addonItem.findFirst({ where: { name: item.name } });
      if (!existing) {
        const created = await prisma.addonItem.create({
          data: { name: item.name, price: item.price, is_active: true, sort_order: 90 + idx }
        });
        createdAddonIds.push(created.id);
      } else if (!existing.is_active) {
        await prisma.addonItem.update({ where: { id: existing.id }, data: { is_active: true } });
      }
    }

    user = await prisma.user.create({
      data: {
        line_user_id: `r37_e2e_${runId}`,
        name: `R37測試客_${runId}`,
        phone: `09978${runId.slice(-5)}` // check-secrets: fake-data
      }
    });

    // Today sessions 10:00 - 14:00 (4h)
    const todaySlots = [
      ['10:00', '11:00'],
      ['11:00', '12:00'],
      ['12:00', '13:00'],
      ['13:00', '14:00']
    ];
    const todaySessions = [];
    for (const [st, et] of todaySlots) {
      let s = await prisma.session.findFirst({
        where: { session_date: todayDate, start_time: st }
      });
      if (!s) {
        s = await prisma.session.create({
          data: { session_date: todayDate, start_time: st, end_time: et, max_capacity: 20 }
        });
        createdSessionIds.push(s.id);
      }
      todaySessions.push(s);
    }

    // Saturday DailySetting unlimited_price = 800 & sessions 10:00-13:00
    const prevSatSetting = await prisma.dailySetting.findUnique({ where: { date: satDate } });
    await prisma.dailySetting.upsert({
      where: { date: satDate },
      update: { hourly_price: 180, unlimited_price: 800, allow_unlimited: true, is_self_service: false },
      create: { date: satDate, hourly_price: 180, unlimited_price: 800, allow_unlimited: true, is_self_service: false }
    });
    let satSess1 = await prisma.session.findFirst({ where: { session_date: satDate, start_time: '10:00' } });
    if (!satSess1) {
      satSess1 = await prisma.session.create({
        data: { session_date: satDate, start_time: '10:00', end_time: '11:00', max_capacity: 20 }
      });
      createdSessionIds.push(satSess1.id);
    }
    let satSess2 = await prisma.session.findFirst({ where: { session_date: satDate, start_time: '11:00' } });
    if (!satSess2) {
      satSess2 = await prisma.session.create({
        data: { session_date: satDate, start_time: '11:00', end_time: '12:00', max_capacity: 20 }
      });
      createdSessionIds.push(satSess2.id);
    }

    // Booking 1: Today floor (checked in on A1-1, with one small board started 2h5m ago relative to nowMs)
    const boardStartDt = new Date(nowMs - 125 * 60 * 1000);
    const boardPlanEndDt = new Date(boardStartDt.getTime() + 4 * 3600 * 1000);
    for (const sess of todaySessions) {
      await prisma.reservation.create({
        data: {
          booking_ref: refFloor,
          session_id: sess.id,
          user_id: user.id,
          pax: 1,
          status: 'confirmed',
          attendance: 'checked_in',
          checked_in_at: new Date(`${todayStr}T10:00:00+08:00`),
          assigned_seats: ['A1-1'],
          checkout_details: { version: 2, rev: 0, persons: [{ person_no: 1, mode: 'hourly' }], order_addons: [], order_promos: [] }
        }
      });
    }
    const floorPerson = await prisma.bookingPerson.create({
      data: {
        booking_ref: refFloor,
        person_no: 1,
        seat_code: 'A1-1',
        status: 'active',
        timer_started_at: new Date(`${todayStr}T10:00:00+08:00`)
      }
    });
    const smallEq = await prisma.equipmentConfig.findFirst({ where: { id: { not: 'bring_own' }, visibility_status: 'ACTIVE' } });
    const floorBoard = await prisma.bookingEquipment.create({
      data: {
        booking_ref: refFloor,
        person_id: floorPerson.id,
        equipment_id: smallEq.id,
        equipment_name_snapshot: smallEq.name,
        unit_group: `r37-ug-${runId}`,
        segment_no: 1,
        quantity: 1,
        rental_hours: 4,
        unit_rate: smallEq.hourly_rate,
        daily_cap_snapshot: smallEq.daily_cap ?? null,
        is_price_fixed: true,
        subtotal_price: 0,
        start_at: boardStartDt,
        planned_end_at: boardPlanEndDt,
        covered_sessions: todaySessions.map(s => `${s.start_time}-${s.end_time}`)
      }
    });

    // Booking 1b: Today second seat A2-1 (no board) for testing add-board default HH:MM time
    for (const sess of todaySessions) {
      await prisma.reservation.create({
        data: {
          booking_ref: refConflict,
          session_id: sess.id,
          user_id: user.id,
          pax: 1,
          status: 'confirmed',
          attendance: 'checked_in',
          checked_in_at: new Date(`${todayStr}T10:00:00+08:00`),
          assigned_seats: ['A2-1'],
          checkout_details: { version: 2, rev: 0, persons: [{ person_no: 1, mode: 'hourly' }], order_addons: [], order_promos: [], note: '' }
        }
      });
    }
    await prisma.bookingPerson.create({
      data: {
        booking_ref: refConflict,
        person_no: 1,
        seat_code: 'A2-1',
        status: 'active',
        timer_started_at: new Date(`${todayStr}T10:00:00+08:00`)
      }
    });

    // Booking 2: Saturday booking with pricing_snapshot unlimited=800
    for (const sess of [satSess1, satSess2]) {
      await prisma.reservation.create({
        data: {
          booking_ref: refSat,
          session_id: sess.id,
          user_id: user.id,
          pax: 1,
          status: 'confirmed',
          assigned_seats: ['A3-1'],
          pricing_snapshot: { hourly: 180, unlimited: 800, allow_unlimited: true, is_weekend: true, captured_at: new Date().toISOString() },
          checkout_details: { version: 2, rev: 0, persons: [{ person_no: 1, mode: 'hourly' }], order_addons: [], order_promos: [] }
        }
      });
    }
    await prisma.bookingPerson.create({
      data: { booking_ref: refSat, person_no: 1, seat_code: 'A3-1', status: 'active' }
    });

    // Booking 3: Timer 3 hours 25 minutes on a 3h booking (10:00-13:00 -> timer 10:00 to 13:25)
    for (const sess of todaySessions.slice(0, 3)) {
      await prisma.reservation.create({
        data: {
          booking_ref: refTimer,
          session_id: sess.id,
          user_id: user.id,
          pax: 1,
          status: 'confirmed',
          attendance: 'checked_in',
          checked_in_at: new Date(`${todayStr}T10:00:00+08:00`),
          assigned_seats: ['A4-1'],
          pricing_snapshot: { hourly: 150, unlimited: 750, allow_unlimited: true, is_weekend: false, captured_at: new Date().toISOString() },
          checkout_details: { version: 2, rev: 0, persons: [{ person_no: 1, mode: 'hourly' }], order_addons: [], order_promos: [] }
        }
      });
    }
    await prisma.bookingPerson.create({
      data: {
        booking_ref: refTimer,
        person_no: 1,
        seat_code: 'A4-1',
        status: 'active',
        timer_started_at: new Date(`${todayStr}T10:00:00+08:00`),
        timer_ended_at: new Date(`${todayStr}T13:25:00+08:00`)
      }
    });

    browser = await chromium.launch({ headless: HEADLESS });
    const contextA = await browser.newContext({ viewport: { width: 900, height: 860 } });
    await contextA.addInitScript(() => {
      localStorage.setItem('shiguang_seating_tab', 'floor');
    });
    const pageA = await contextA.newPage();

    await adminLogin(pageA);

    // --- Scenario 1 & 3 on SeatingPage with server_now fixed to today 11:40 (between 10:00-14:00) ---
    await pageA.route('**/api/floor/live*', async (route) => {
      const response = await route.fetch();
      const json = await response.json();
      json.server_now = `${todayStr}T11:40:00+08:00`;
      await route.fulfill({ response, json });
    });

    await pageA.goto(`${BASE_URL}/admin/seating`, { waitUntil: 'networkidle' });
    const floorTabBtn = pageA.locator('button[data-testid="tab-floor"]').last();
    if (await floorTabBtn.isVisible().catch(() => false)) {
      await floorTabBtn.click();
    }
    await pageA.locator('button[data-seat-code="A2-1"]:visible').first().waitFor({ state: 'visible', timeout: 10000 });

    // Scenario 1: Open Add Board modal on A2-1 -> default start time is 11:40
    await pageA.locator('button[data-seat-code="A2-1"]:visible').first().click();
    await pageA.locator('[data-testid="seat-panel-add-board-btn"]').click();
    const fromTimeInput = pageA.locator('[data-testid="add-board-from-time"]');
    await fromTimeInput.waitFor({ state: 'visible', timeout: 5000 });
    assert.equal(await fromTimeInput.inputValue(), '11:40');
    await pageA.waitForTimeout(300);
    const shot1 = path.join(SCREENSHOT_DIR, 'round37_shot1_add_board_time.png');
    await pageA.screenshot({ path: shot1 });
    console.log('Saved Shot 1:', shot1);
    await pageA.locator('button:has-text("取消")').first().click();

    // Unroute mock for Scenario 3 so real server_now and backend swapBoundaryOptions align
    await pageA.unroute('**/api/floor/live*');
    await pageA.reload({ waitUntil: 'networkidle' });
    await pageA.locator('button[data-seat-code="A1-1"]:visible').first().waitFor({ state: 'visible', timeout: 10000 });

    // Scenario 3: A1-1 -> 換板 -> 不用了，歸還 -> verify /preview matches returned bill
    await pageA.locator('button[data-seat-code="A1-1"]:visible').first().click();
    await pageA.locator('[data-testid="seat-panel-swap-board-btn"]').click();
    const swapDialog = pageA.locator('[role="dialog"]:has-text("換板")');
    await swapDialog.waitFor({ state: 'visible', timeout: 5000 });

    const [prevResp] = await Promise.all([
      pageA.waitForResponse(r => r.url().includes(`/boards/${floorBoard.unit_group}/preview`) && r.status() === 200),
      swapDialog.locator('button:has-text("不用了，歸還")').click()
    ]);
    const prevJson = await prevResp.json();
    await pageA.locator('[data-testid="board-swap-preview-amounts"]').waitFor({ state: 'visible', timeout: 5000 });
    await pageA.waitForTimeout(250);
    const shot3 = path.join(SCREENSHOT_DIR, 'round37_shot3_board_return_preview.png');
    await pageA.screenshot({ path: shot3 });
    console.log('Saved Shot 3:', shot3);

    const [retResp] = await Promise.all([
      pageA.waitForResponse(r => r.url().includes(`/boards/${floorBoard.unit_group}/return`) && r.status() === 200),
      swapDialog.locator('button:has-text("確認歸還")').click()
    ]);
    const retJson = await retResp.json();
    assert.equal(retJson.bill.summary.board_total, prevJson.board_amount_after);

    await pageA.setViewportSize({ width: 1280, height: 860 });

    const openWorkbench = async (page, bookingRef, monthYmd) => {
      await page.goto(`${BASE_URL}/admin/reservations`, { waitUntil: 'networkidle' });
      if (monthYmd) {
        await page.locator('input[type="month"]').first().fill(monthYmd);
      }
      await page.locator('input[placeholder="搜尋訂單編號、姓名或電話..."]').first().fill(bookingRef);
      await page.waitForTimeout(500);
      const rowBtn = page.locator(`[data-testid="reservation-card-${bookingRef}"] button:has-text("結帳"):visible, tr:has-text("${bookingRef.slice(-4)}") button:has-text("結帳"):visible`).first();
      await rowBtn.waitFor({ state: 'visible', timeout: 10000 });
      await rowBtn.click();
      const goBtn = page.locator('button:has-text("前往結帳"):visible').first();
      await goBtn.waitFor({ state: 'visible', timeout: 5000 });
      await Promise.all([
        page.waitForResponse(r => r.url().includes(`/api/billing/${bookingRef}`) && r.request().method() === 'GET'),
        goBtn.click()
      ]);
      await page.locator('tr:has-text("第 1 位"):visible').first().waitFor({ state: 'visible', timeout: 10000 });
      await page.locator('[data-testid="workbench-net-due"]:visible').first().waitFor({ state: 'visible', timeout: 10000 });
    };

    // Scenario 3 completion check on CheckoutWorkbench: returned board total equals preview
    await openWorkbench(pageA, refFloor, todayStr.slice(0, 7));
    const wbBoardText = await pageA.locator('body').innerText();
    assert.ok(wbBoardText.includes(`NT$${prevJson.board_amount_after}`), `Expected board total NT$${prevJson.board_amount_after} in workbench`);

    // --- Scenario 2: Saturday unlimited_price = 800 on CheckoutWorkbench ---
    await openWorkbench(pageA, refSat, satStr.slice(0, 7));
    await pageA.locator('tr:has-text("第 1 位"):visible td').first().click();
    const unlBtn = pageA.locator('[data-testid="toggle-unlimited-btn-1"]:visible').first();
    await unlBtn.waitFor({ state: 'visible', timeout: 5000 });
    const unlText = await unlBtn.innerText();
    assert.ok(unlText.includes('改為不限時') && unlText.includes('NT$800'), `Expected 改為不限時 (NT$800) on toggle button, got: ${unlText}`);
    await unlBtn.click();
    await pageA.waitForTimeout(300);
    const unlAfterText = await unlBtn.innerText();
    assert.ok(unlAfterText.includes('目前：不限時') && unlAfterText.includes('NT$800'), `Expected 目前：不限時 NT$800 after click, got: ${unlAfterText}`);
    const dueAfterUnl = await pageA.locator('[data-testid="workbench-net-due"]:visible').first().innerText();
    assert.equal(dueAfterUnl.trim(), 'NT$800');
    const shot2 = path.join(SCREENSHOT_DIR, 'round37_shot2_unlimited_price.png');
    await pageA.screenshot({ path: shot2 });
    console.log('Saved Shot 2:', shot2);

    // --- Scenario 4: Hours adjuster for 3h25m timed guest (3 小時 +0.5, 計時 3:25) ---
    await openWorkbench(pageA, refTimer, todayStr.slice(0, 7));
    await pageA.locator('[data-testid="int-hours-1"]:visible').first().waitFor({ state: 'visible', timeout: 10000 });
    assert.equal((await pageA.locator('[data-testid="int-hours-1"]:visible').first().innerText()).trim(), '3 小時');
    const chip05Class = await pageA.locator('[data-testid="ot-chip-1-0.5"]:visible').first().getAttribute('class');
    assert.ok(chip05Class.includes('bg-sg-brown'), `Expected +0.5 chip selected, got class: ${chip05Class}`);
    const timerLabel = await pageA.locator('[data-testid="hours-timer-1"]:visible').first().innerText();
    assert.ok(timerLabel.includes('計時 3:25'), `Expected 計時 3:25, got: ${timerLabel}`);
    assert.equal((await pageA.locator('[data-testid="workbench-net-due"]:visible').first().innerText()).trim(), 'NT$525');
    await pageA.waitForTimeout(250);
    const shot4 = path.join(SCREENSHOT_DIR, 'round37_shot4_hours_adjuster.png');
    await pageA.screenshot({ path: shot4 });
    console.log('Saved Shot 4:', shot4);

    // --- Scenario 5: Two tabs draft conflict on refConflict ---
    const contextB = await browser.newContext({ viewport: { width: 1280, height: 860 } });
    const pageB = await contextB.newPage();
    await adminLogin(pageB);

    await openWorkbench(pageA, refConflict, todayStr.slice(0, 7));
    await pageA.locator('[data-testid="addon-preset-鑰匙圈"]:visible').first().waitFor({ state: 'visible', timeout: 10000 });

    await openWorkbench(pageB, refConflict, todayStr.slice(0, 7));
    await pageB.locator('[data-testid="addon-preset-磁鐵"]:visible').first().waitFor({ state: 'visible', timeout: 10000 });

    // Tab A adds 鑰匙圈 on 整單共同 and saves (PUT /draft 200)
    await pageA.locator('button:has-text("整單共同"):visible').first().click();
    const [putAResp] = await Promise.all([
      pageA.waitForResponse(r => r.url().includes(`/billing/${refConflict}/draft`) && r.request().method() === 'PUT'),
      pageA.locator('[data-testid="addon-preset-鑰匙圈"]:visible').first().click()
    ]);
    assert.equal(putAResp.status(), 200);

    // Tab B (still on rev 0) adds 磁鐵 on 整單共同 -> PUT /draft 409 -> shows conflict modal
    await pageB.locator('button:has-text("整單共同"):visible').first().click();
    const [putBResp] = await Promise.all([
      pageB.waitForResponse(r => r.url().includes(`/billing/${refConflict}/draft`) && r.request().method() === 'PUT'),
      pageB.locator('[data-testid="addon-preset-磁鐵"]:visible').first().click()
    ]);
    assert.equal(putBResp.status(), 409);

    const conflictDialog = pageB.locator('[data-testid="draft-conflict-modal"]');
    await conflictDialog.waitFor({ state: 'visible', timeout: 5000 });
    assert.ok((await pageB.locator('[data-testid="draft-conflict-both-parts"]').innerText()).includes('整單加購'));
    await pageB.waitForTimeout(250);
    const shot5 = path.join(SCREENSHOT_DIR, 'round37_shot5_draft_conflict.png');
    await pageB.screenshot({ path: shot5 });
    console.log('Saved Shot 5:', shot5);

    // Choose "把我的修改加上去" -> both 鑰匙圈 & 磁鐵 appear!
    const [mergeResp] = await Promise.all([
      pageB.waitForResponse(r => r.url().includes(`/billing/${refConflict}/draft`) && r.request().method() === 'PUT'),
      pageB.locator('[data-testid="conflict-merge-mine-btn"]').click()
    ]);
    assert.equal(mergeResp.status(), 200);
    await conflictDialog.waitFor({ state: 'hidden', timeout: 5000 });
    const bodyTextAfterMerge = await pageB.locator('body').innerText();
    assert.ok(bodyTextAfterMerge.includes('鑰匙圈') && bodyTextAfterMerge.includes('磁鐵'), 'Both 鑰匙圈 and 磁鐵 must remain after merge');

    // Create a second conflict -> Tab A updates note & saves; Tab B updates note -> chooses "用對方的版本"
    await openWorkbench(pageA, refConflict, todayStr.slice(0, 7));
    const noteInputA = pageA.locator('textarea[placeholder*="特別包場"]:visible').first();
    await noteInputA.waitFor({ state: 'visible', timeout: 5000 });
    await Promise.all([
      pageA.waitForResponse(r => r.url().includes(`/billing/${refConflict}/draft`) && r.request().method() === 'PUT'),
      noteInputA.fill('A店員備註')
    ]);

    const noteInputB = pageB.locator('textarea[placeholder*="特別包場"]:visible').first();
    const [putB2] = await Promise.all([
      pageB.waitForResponse(r => r.url().includes(`/billing/${refConflict}/draft`) && r.request().method() === 'PUT'),
      noteInputB.fill('B未存備註')
    ]);
    assert.equal(putB2.status(), 409);
    await conflictDialog.waitFor({ state: 'visible', timeout: 5000 });
    await pageB.locator('[data-testid="conflict-use-theirs-btn"]').click();
    await conflictDialog.waitFor({ state: 'hidden', timeout: 5000 });
    assert.equal(await noteInputB.inputValue(), 'A店員備註');

    await contextB.close();
    await contextA.close();

    // Restore Saturday DailySetting if needed
    if (prevSatSetting) {
      await prisma.dailySetting.update({
        where: { date: satDate },
        data: {
          hourly_price: prevSatSetting.hourly_price,
          unlimited_price: prevSatSetting.unlimited_price,
          allow_unlimited: prevSatSetting.allow_unlimited,
          is_self_service: prevSatSetting.is_self_service
        }
      });
    } else {
      await prisma.dailySetting.deleteMany({ where: { date: satDate } });
    }

    console.log('✅ Round 37 Bill Calc Fixes Playwright Test PASSED!');
  } finally {
    if (browser) await browser.close().catch(() => {});
    await prisma.bookingEquipment.deleteMany({ where: { booking_ref: { in: createdRefs } } }).catch(() => {});
    await prisma.bookingPerson.deleteMany({ where: { booking_ref: { in: createdRefs } } }).catch(() => {});
    await prisma.reservation.deleteMany({ where: { booking_ref: { in: createdRefs } } }).catch(() => {});
    if (createdAddonIds.length > 0) {
      await prisma.addonItem.deleteMany({ where: { id: { in: createdAddonIds } } }).catch(() => {});
    }
    if (createdSessionIds.length > 0) {
      await prisma.session.deleteMany({ where: { id: { in: createdSessionIds } } }).catch(() => {});
    }
    if (user?.id) await prisma.user.delete({ where: { id: user.id } }).catch(() => {});
    await prisma.$disconnect();
  }
}

run().catch((err) => {
  console.error('❌ Round 37 Playwright Test failed:', err);
  process.exit(1);
});
