// frontend/tests/round42_seating_ux.spec.js
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
  console.log('--- Starting Round 42 Seating UX Playwright Test ---');
  await ensureFreshDbSeeded(prisma);
  await cleanOperationalData(prisma);

  const now = new Date();
  const todayStr = toTaipeiDateString(now);
  const todayDate = dateOnly(todayStr);
  const tomorrowDt = new Date(todayDate.getTime() + 86400000);
  const tomorrowStr = tomorrowDt.toISOString().slice(0, 10);
  const ts = Date.now().toString().slice(-6);

  let layout = null;
  let prevPublishedIds = [];
  let prevGlobalLayoutEnabled = true;
  let prevTodayDaily = null;
  const createdSessionIds = [];
  const createdUserIds = [];
  const createdLogIds = [];

  const browser = await chromium.launch({ headless: HEADLESS });

  try {
    const gs = await prisma.globalSetting.findUnique({ where: { id: 1 } });
    if (gs) {
      prevGlobalLayoutEnabled = gs.seat_layout_enabled;
      if (!gs.seat_layout_enabled) {
        await prisma.globalSetting.update({ where: { id: 1 }, data: { seat_layout_enabled: true } });
      }
    }

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
        name: `R42測試空間-${ts}`,
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
        arrangement: 'one_side',
        cx: 180,
        cy: 200,
        w: 60,
        h: 160,
        sort_order: 0
      }
    });
    const tableA2 = await prisma.seatTable.create({
      data: {
        layout_id: layout.id,
        zone_id: zone.id,
        label: 'A2',
        shape: 'rect',
        arrangement: 'one_side',
        cx: 420,
        cy: 200,
        w: 60,
        h: 160,
        sort_order: 1
      }
    });
    await prisma.seat.createMany({
      data: [
        { layout_id: layout.id, table_id: tableA1.id, zone_id: zone.id, code: 'A1-1', lx: 40, ly: -35, side: 'R', side_mode: 'auto', is_active: true, sort_order: 0 },
        { layout_id: layout.id, table_id: tableA1.id, zone_id: zone.id, code: 'A1-2', lx: 40, ly: 35, side: 'R', side_mode: 'auto', is_active: true, sort_order: 1 },
        { layout_id: layout.id, table_id: tableA2.id, zone_id: zone.id, code: 'A2-1', lx: 40, ly: -35, side: 'R', side_mode: 'auto', is_active: true, sort_order: 0 },
        { layout_id: layout.id, table_id: tableA2.id, zone_id: zone.id, code: 'A2-2', lx: 40, ly: 35, side: 'R', side_mode: 'auto', is_active: true, sort_order: 1 }
      ]
    });

    prevTodayDaily = await prisma.dailySetting.findUnique({ where: { date: todayDate } });
    await prisma.dailySetting.upsert({
      where: { date: todayDate },
      update: { is_self_service: true, allow_unlimited: true, hourly_price: 200, unlimited_price: 600 },
      create: { date: todayDate, is_self_service: true, allow_unlimited: true, hourly_price: 200, unlimited_price: 600 }
    });

    await prisma.session.deleteMany({ where: { session_date: todayDate } });
    const sessionDefs = [
      ['10:00', '11:00'],
      ['11:00', '12:00'],
      ['14:00', '15:00'],
      ['22:00', '23:00'],
      ['23:00', '23:55']
    ];
    const sessionsByStart = {};
    for (const [st, et] of sessionDefs) {
      const s = await prisma.session.create({
        data: { session_date: todayDate, start_time: st, end_time: et, max_capacity: 10 }
      });
      createdSessionIds.push(s.id);
      sessionsByStart[st] = s;
    }

    const uOvertime = await prisma.user.create({
      data: { line_user_id: `r42_over_${ts}`, name: '王超時', phone: `094201${ts.slice(-4)}` } // check-secrets: fake-data
    });
    const uNoShowTest = await prisma.user.create({
      data: { line_user_id: `r42_ns_${ts}`, name: '王遲到', phone: `094202${ts.slice(-4)}` } // check-secrets: fake-data
    });
    const uPendingStay = await prisma.user.create({
      data: { line_user_id: `r42_pend_${ts}`, name: '陳待位', phone: `094203${ts.slice(-4)}` } // check-secrets: fake-data
    });
    const uFullA2 = await prisma.user.create({
      data: { line_user_id: `r42_a2_${ts}`, name: '張佔位', phone: `094204${ts.slice(-4)}` } // check-secrets: fake-data
    });
    createdUserIds.push(uOvertime.id, uNoShowTest.id, uPendingStay.id, uFullA2.id);

    const refOvertime = `R42-OVER-${ts}`;
    const refNoShowTest = `R42-NS-${ts}`;
    const refPendingStay = `R42-PEND-${ts}`;
    const refFullA2 = `R42-A2-${ts}`;

    // 1. Checked-in overtime guest on A1-1 (billing_start_at 95m ago on 60m session => always overtime)
    const dt95mAgo = new Date(Date.now() - 95 * 60000);
    await prisma.reservation.create({
      data: {
        booking_ref: refOvertime,
        session_id: sessionsByStart['10:00'].id,
        user_id: uOvertime.id,
        pax: 1,
        status: 'confirmed',
        attendance: 'checked_in',
        checked_in_at: dt95mAgo,
        assigned_seats: ['A1-1'],
        seat_source: 'staff',
        is_seat_locked: true,
        amount_due: 200
      }
    });
    await prisma.bookingPerson.create({
      data: {
        booking_ref: refOvertime,
        person_no: 1,
        seat_code: 'A1-1',
        status: 'active',
        billing_start_at: dt95mAgo,
        timer_started_at: dt95mAgo
      }
    });

    // 2. Pending booking on A1-2 for Item 1 & Item 5 (reported_pending_verify)
    await prisma.reservation.create({
      data: {
        booking_ref: refNoShowTest,
        session_id: sessionsByStart['22:00'].id,
        user_id: uNoShowTest.id,
        pax: 1,
        status: 'confirmed',
        assigned_seats: ['A1-2'],
        seat_source: 'staff',
        is_seat_locked: true,
        is_self_service: true,
        amount_due: 200,
        total_amount: 200
      }
    });
    await prisma.bookingPrepay.create({
      data: {
        booking_ref: refNoShowTest,
        user_id: uNoShowTest.id,
        status: 'reported_pending_verify',
        total_amount: 200,
        amount_due: 200
      }
    });

    // 3. Second pending booking (unseated / WAIT-1) so mobile pending filter has a card after uNoShowTest checks in
    await prisma.reservation.create({
      data: {
        booking_ref: refPendingStay,
        session_id: sessionsByStart['23:00'].id,
        user_id: uPendingStay.id,
        pax: 1,
        status: 'confirmed',
        assigned_seats: ['WAIT-1'],
        amount_due: 200,
        total_amount: 200
      }
    });

    // 4. Kiosk access logs for today
    const logBase = new Date(`${todayStr}T09:00:00+08:00`).getTime();
    const l1 = await prisma.kioskAccessLog.create({
      data: {
        device_id: 1,
        at: new Date(logBase + 60000),
        method: 'phone',
        result: 'UNVERIFIED',
        open_door: false,
        booking_ref: refNoShowTest,
        user_id: uNoShowTest.id,
        hint: `***${ts.slice(-3)}`,
        event_id: `r42-log1-${ts}`
      }
    });
    const l2 = await prisma.kioskAccessLog.create({
      data: {
        device_id: 1,
        at: new Date(logBase),
        method: 'qr',
        result: 'FIRST_CHECKIN',
        open_door: true,
        booking_ref: refOvertime,
        user_id: uOvertime.id,
        hint: 'QR99',
        event_id: `r42-log2-${ts}`
      }
    });
    createdLogIds.push(l1.id, l2.id);

    // ==================== PHASE 1: Desktop (1440x900) Item 1 + Item 5 + 30s ETag check ====================
    const desktopCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const dPage = await desktopCtx.newPage();
    const liveStatuses = [];
    dPage.on('response', (res) => {
      if (res.url().includes('/api/floor/live')) {
        liveStatuses.push(res.status());
      }
    });

    await adminLogin(dPage);
    await dPage.goto(`${BASE_URL}/admin/seating`, { waitUntil: 'networkidle' });

    // Switch to list tab
    await dPage.locator('button:has-text("名單"):visible').first().click();
    await dPage.waitForTimeout(300);

    // Item 1: Confirm mark no-show -> cancel -> confirm -> no-show accordion -> revert to check-in
    const noShowCard = dPage.locator(`[data-booking-ref="${refNoShowTest}"]`).first();
    await noShowCard.waitFor({ state: 'visible', timeout: 10000 });
    await noShowCard.locator('button[aria-label="更多操作"]').click();
    await dPage.locator('button:has-text("標記未到"):visible').click();

    await dPage.locator('h4:has-text("標記王遲到未到？")').waitFor({ state: 'visible', timeout: 5000 });
    await dPage.screenshot({ path: path.join(SCREENSHOT_DIR, 'round42_shot1_no_show_confirm.png'), fullPage: false });

    // Cancel ("先不要")
    await dPage.locator('button:has-text("先不要"):visible').click();
    await dPage.waitForTimeout(200);
    assert.equal(await noShowCard.isVisible(), true, 'Booking must stay in pending when cancelled');

    // Re-open & confirm
    await noShowCard.locator('button[aria-label="更多操作"]').click();
    await dPage.locator('button:has-text("標記未到"):visible').click();
    await dPage.locator('div[role="dialog"] button:has-text("標記未到"):visible').click();
    await dPage.waitForTimeout(600);

    // Verify in no-show accordion
    const noShowAcc = dPage.locator('[data-testid="no-show-accordion"]');
    assert.ok((await noShowAcc.innerText()).includes('未到 1 組'), 'Should show 未到 1 組');
    await noShowAcc.locator('button').first().click();
    const revertBtn = dPage.locator(`[data-testid="revert-no-show-btn-${refNoShowTest}"]`);
    await revertBtn.waitFor({ state: 'visible', timeout: 5000 });
    await dPage.screenshot({ path: path.join(SCREENSHOT_DIR, 'round42_shot2_no_show_accordion.png'), fullPage: false });

    // Revert to check-in -> opens CheckInPanel -> seat A1-2 & start timer -> appears in checked-in
    await revertBtn.click();
    await dPage.locator('text=報到並帶位').first().waitFor({ state: 'visible', timeout: 5000 });
    await dPage.locator('div[role="dialog"] button:has-text("入座並開始計時"):visible').click();
    await dPage.waitForTimeout(600);
    await dPage.locator(`[data-booking-ref="${refNoShowTest}"]`).first().waitFor({ state: 'visible', timeout: 5000 });
    console.log('Item 1 passed on desktop.');

    // Item 5: Kiosk quick tool button on self-service day + logs + search
    const kioskBtn = dPage.locator('[data-testid="seating-kiosk-btn"]:visible');
    await kioskBtn.waitFor({ state: 'visible', timeout: 5000 });
    await kioskBtn.click();
    await dPage.locator('[data-testid="kiosk-recent-logs"]').waitFor({ state: 'visible', timeout: 5000 });
    assert.ok((await dPage.locator('[data-testid="kiosk-recent-logs"]').innerText()).includes('款項核對中'));

    await dPage.locator('[data-testid="kiosk-quick-search-input"]').fill('王遲到');
    await dPage.locator(`[data-testid="kiosk-quick-pick-${refNoShowTest}"]`).click();
    await dPage.locator('[data-testid="kiosk-quick-booking-reason"]').waitFor({ state: 'visible', timeout: 5000 });
    const reasonText = await dPage.locator('[data-testid="kiosk-quick-booking-reason"]').innerText();
    assert.ok(reasonText.includes('已回報末五碼，等對帳'), `Expected reported reason, got: ${reasonText}`);
    await dPage.screenshot({ path: path.join(SCREENSHOT_DIR, 'round42_shot7_kiosk_quick_panel.png'), fullPage: false });
    await dPage.locator('div[role="dialog"] button[aria-label="關閉"], div[role="dialog"] button:has-text("×"), div[role="dialog"] button:has-text("關閉")').first().click().catch(async () => {
      await dPage.keyboard.press('Escape');
    });
    await dPage.waitForTimeout(300);
    console.log('Item 5 passed on desktop.');

    // Item 4 ETag 30-second observation (idle polling every 8s)
    liveStatuses.length = 0;
    await dPage.waitForTimeout(30000); // wait 30s (polling every 8s)
    const count200 = liveStatuses.filter(s => s === 200).length;
    const count304 = liveStatuses.filter(s => s === 304).length;
    console.log(`30s /api/floor/live status counts => total=${liveStatuses.length}, 200=${count200}, 304=${count304}`);
    assert.ok(count304 >= 2, `Expected at least 2 304 responses in idle polling, got ${JSON.stringify(liveStatuses)}`);
    await desktopCtx.close();

    // ==================== PHASE 2: Mobile (390x844) Item 2 ====================
    const mobileCtx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const mPage = await mobileCtx.newPage();
    await adminLogin(mPage);
    await mPage.goto(`${BASE_URL}/admin/seating`, { waitUntil: 'networkidle' });

    // Start on floor tab on mobile
    await mPage.locator('button:has-text("平面圖"):visible').first().click();
    await mPage.waitForTimeout(400);

    // Expand "需要注意 1" drawer -> see overtime -> screenshot -> click opens timer modal
    const mobToggle = mPage.locator('[data-testid="mobile-alerts-toggle"]:visible');
    await mobToggle.waitFor({ state: 'visible', timeout: 8000 });
    await mobToggle.click();
    await mPage.locator('[data-testid="mobile-alerts-list"]').waitFor({ state: 'visible', timeout: 5000 });
    assert.ok((await mPage.locator('[data-testid="mobile-alerts-list"]').innerText()).includes('超時'));
    await mPage.screenshot({ path: path.join(SCREENSHOT_DIR, 'round42_shot3_mobile_alerts.png'), fullPage: false });

    // Click the overtime alert -> opens timer detail modal
    await mPage.locator('[data-testid="mobile-alerts-list"] >> text=超時').first().click();
    await mPage.locator('[data-testid="timer-checkout-btn"]').waitFor({ state: 'visible', timeout: 5000 });
    await mPage.keyboard.press('Escape');
    await mPage.waitForTimeout(250);
    // Collapse alerts drawer so table cards show cleanly
    await mobToggle.click();
    await mPage.waitForTimeout(200);

    // Check table cards count before filter (A1 + A2 = 2 cards)
    const beforeCards = await mPage.locator('[id^="table-card-"]:visible').count();
    assert.equal(beforeCards, 2, `Expected 2 table cards before filter, got ${beforeCards}`);

    // Click "空位" filter chip -> only A2 has empty seats!
    await mPage.locator('button:has-text("空位"):visible').first().click();
    await mPage.waitForTimeout(300);
    const afterEmptyCards = await mPage.locator('[id^="table-card-"]:visible').count();
    assert.equal(afterEmptyCards, 1, `Expected 1 table card (A2) under 空位 filter, got ${afterEmptyCards}`);
    await mPage.screenshot({ path: path.join(SCREENSHOT_DIR, 'round42_shot4_mobile_empty_filter.png'), fullPage: false });

    // Switch to List tab -> click "待入座" filter chip -> only 待入座 section visible
    await mPage.locator('button:has-text("名單"):visible').first().click();
    await mPage.waitForTimeout(250);
    await mPage.locator('button:has-text("待入座"):visible').first().click();
    await mPage.waitForTimeout(250);
    assert.equal(await mPage.locator('h2:has-text("待入座"):visible').count(), 1);
    assert.equal(await mPage.locator('h2:has-text("使用中"):visible').count(), 0);
    console.log('Item 2 passed on mobile.');
    await mobileCtx.close();

    // ==================== PHASE 3: Item 4 Waitlist Fallback + Item 3 Offline Lock ====================
    // Occupy A2-1 and A2-2 so all 4 physical seats are checked-in
    const dt10mAgo = new Date(Date.now() - 10 * 60000);
    await prisma.reservation.create({
      data: {
        booking_ref: refFullA2,
        session_id: sessionsByStart['10:00'].id,
        user_id: uFullA2.id,
        pax: 2,
        status: 'confirmed',
        attendance: 'checked_in',
        checked_in_at: dt10mAgo,
        assigned_seats: ['A2-1', 'A2-2'],
        seat_source: 'staff',
        is_seat_locked: true,
        amount_due: 400
      }
    });
    await prisma.bookingPerson.createMany({
      data: [
        { booking_ref: refFullA2, person_no: 1, seat_code: 'A2-1', status: 'active', billing_start_at: dt10mAgo, timer_started_at: dt10mAgo },
        { booking_ref: refFullA2, person_no: 2, seat_code: 'A2-2', status: 'active', billing_start_at: dt10mAgo, timer_started_at: dt10mAgo }
      ]
    });

    const ctx3 = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page3 = await ctx3.newPage();
    await adminLogin(page3);
    await page3.goto(`${BASE_URL}/admin/seating`, { waitUntil: 'networkidle' });

    // Item 4: Open ForceAddModal when all seats full -> INSUFFICIENT_SEATS -> click 放入等待區
    await page3.locator('button:has-text("現場加人"):visible').first().click();
    await page3.locator('input[placeholder*="王先生"]').fill('林候位');
    await page3.locator('button:has-text("下一步：安排座位"):visible').click();
    await page3.locator('text=所選時段的座位不夠').waitFor({ state: 'visible', timeout: 8000 });
    const fallbackWaitBtn = page3.locator('[data-testid="force-add-fallback-wait-btn"]');
    await fallbackWaitBtn.waitFor({ state: 'visible', timeout: 5000 });
    await page3.screenshot({ path: path.join(SCREENSHOT_DIR, 'round42_shot6_waitlist_fallback.png'), fullPage: false });

    await fallbackWaitBtn.click();
    await page3.locator('text=已放入等待區').waitFor({ state: 'visible', timeout: 8000 });
    console.log('Item 4 waitlist fallback passed.');

    // Item 3a: Offline detection & button disabling
    await page3.locator('button:has-text("名單"):visible').first().click();
    await page3.waitForTimeout(300);
    await page3.locator(`[data-booking-ref="${refOvertime}"]`).first().click();
    await page3.locator('button:has-text("全組暫停"):visible').waitFor({ state: 'visible', timeout: 5000 });

    await page3.route('**/api/floor/live**', r => r.abort());
    await page3.locator('[data-testid="floor-offline-banner"]').waitFor({ state: 'visible', timeout: 25000 });
    const offlineBannerText = await page3.locator('[data-testid="floor-offline-banner"]').innerText();
    assert.ok(/連線中斷，資料停在 \d{2}:\d{2}。恢復後會自動更新。/.test(offlineBannerText), `Unexpected offline banner: ${offlineBannerText}`);
    const allPauseBtn = page3.locator('button:has-text("全組暫停"):visible');
    assert.equal(await allPauseBtn.isDisabled(), true, 'Pause button must be disabled when offline');
    assert.ok((await page3.locator('text=（離線）').first().isVisible()), 'Offline timer suffix must be visible');
    await page3.screenshot({ path: path.join(SCREENSHOT_DIR, 'round42_shot5_offline_banner.png'), fullPage: false });

    await page3.unroute('**/api/floor/live**');
    await page3.locator('[data-testid="floor-offline-banner"]').waitFor({ state: 'hidden', timeout: 15000 });
    assert.equal(await allPauseBtn.isDisabled(), false, 'Pause button must re-enable after recovery');
    console.log('Item 3a offline recovery passed.');
    await ctx3.close();

    // ==================== PHASE 4: Item 3b Midnight Rollover with page.clock ====================
    const ctx4 = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page4 = await ctx4.newPage();
    let mockNowIso = `${todayStr}T23:58:00+08:00`;
    await page4.clock.install({ time: new Date(`${todayStr}T23:58:00+08:00`) });

    await page4.route('**/api/floor/live**', async (route) => {
      const resp = await route.fetch();
      if (resp.status() === 304) {
        await route.fulfill({
          status: 304,
          headers: { ...resp.headers(), 'x-server-now': mockNowIso }
        });
        return;
      }
      const json = await resp.json();
      json.server_now = mockNowIso;
      await route.fulfill({
        status: resp.status(),
        headers: { ...resp.headers(), 'x-server-now': mockNowIso },
        body: JSON.stringify(json)
      });
    });

    await adminLogin(page4);
    await page4.goto(`${BASE_URL}/admin/seating`, { waitUntil: 'networkidle' });
    const dateBtn = page4.locator('[data-testid="seating-date-toggle"]');
    await dateBtn.waitFor({ state: 'visible', timeout: 8000 });
    assert.ok((await dateBtn.innerText()).includes(todayStr), `Expected initial date ${todayStr}`);

    mockNowIso = `${tomorrowStr}T00:01:00+08:00`;
    await page4.clock.fastForward('03:30');
    await page4.waitForTimeout(400);
    assert.ok((await dateBtn.innerText()).includes(tomorrowStr), `Expected auto-switched date ${tomorrowStr}, got ${await dateBtn.innerText()}`);
    console.log('Item 3b midnight auto-switch passed.');
    await ctx4.close();

    console.log('ALL Round 42 E2E checks passed!');
  } finally {
    await browser.close().catch(() => {});
    if (createdLogIds.length > 0) {
      await prisma.kioskAccessLog.deleteMany({ where: { id: { in: createdLogIds } } }).catch(() => {});
    }
    await cleanOperationalData(prisma).catch(() => {});
    for (const sId of createdSessionIds) {
      await prisma.session.deleteMany({ where: { id: sId } }).catch(() => {});
    }
    if (prevTodayDaily) {
      await prisma.dailySetting.upsert({
        where: { date: todayDate },
        update: {
          is_self_service: prevTodayDaily.is_self_service,
          allow_unlimited: prevTodayDaily.allow_unlimited,
          hourly_price: prevTodayDaily.hourly_price,
          unlimited_price: prevTodayDaily.unlimited_price
        },
        create: prevTodayDaily
      }).catch(() => {});
    } else {
      await prisma.dailySetting.deleteMany({ where: { date: todayDate } }).catch(() => {});
    }
    if (createdUserIds.length > 0) {
      await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } }).catch(() => {});
    }
    if (layout?.id) {
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
    if (!prevGlobalLayoutEnabled) {
      await prisma.globalSetting.update({ where: { id: 1 }, data: { seat_layout_enabled: false } }).catch(() => {});
    }
    await prisma.$disconnect();
  }
}

run().catch((err) => {
  console.error('Round 42 E2E Failed:', err);
  process.exit(1);
});
