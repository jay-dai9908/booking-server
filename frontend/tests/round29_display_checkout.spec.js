// frontend/tests/round29_display_checkout.spec.js
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import jsQR from 'jsqr';

const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const dotenv = require('../../backend/node_modules/dotenv/lib/main.js');
dotenv.config({ path: path.resolve(__dirname, '../../backend/.env') });

const bcrypt = require('../../backend/node_modules/bcryptjs/index.js');
const { PrismaClient } = require('../../backend/node_modules/@prisma/client/index.js');
const { ensureFreshDbSeeded } = await import('./helpers/seedFreshDb.js');
const { toTaipeiDateString, dateOnly } = await import('../../shared/time.js');
const { buildTransferPayload } = await import('../../shared/twqr.js');

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

function buildDemoLayoutData() {
  return {
    name: 'R29結帳同步測試版面',
    canvas_w: 720,
    canvas_h: 1167,
    kiosk_map_rotation: 90,
    elements_json: [
      { id: 'wall-1', type: 'wall', points: [[0, 1160], [0, 0], [720, 110], [720, 1160]] },
      { id: 'win-1', type: 'window', points: [[0, 1160], [330, 1160]] },
      { id: 'win-2', type: 'window', points: [[420, 1160], [720, 1160]] },
      { id: 'door-1', type: 'door', cx: 375, cy: 1160, w: 90, h: 14, rotation: 0, label: '入口', kiosk: { entrance: true } },
      { id: 'fx-counter', type: 'counter', cx: 185, cy: 1060, w: 50, h: 200, rotation: 0, label: '櫃檯', kiosk: { show: 'icon_name', icon: 'counter', color: 'brown' } }
    ]
  };
}

async function decodeElementQrPng(page, locator) {
  const boxEl = locator.first();
  await boxEl.waitFor({ state: 'visible', timeout: 10000 });
  const pngBuffer = await boxEl.screenshot();
  const dataUrl = `data:image/png;base64,${pngBuffer.toString('base64')}`;

  const rawRgba = await page.evaluate(async (srcUrl) => {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const cvs = document.createElement('canvas');
        cvs.width = img.width;
        cvs.height = img.height;
        const ctx = cvs.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, cvs.width, cvs.height);
        ctx.drawImage(img, 0, 0);
        const imgData = ctx.getImageData(0, 0, cvs.width, cvs.height);
        resolve({
          data: Array.from(imgData.data),
          width: cvs.width,
          height: cvs.height
        });
      };
      img.onerror = () => reject(new Error('Failed to load QR screenshot image'));
      img.src = srcUrl;
    });
  }, dataUrl);

  const decoded = jsQR(Uint8ClampedArray.from(rawRgba.data), rawRgba.width, rawRgba.height, {
    inversionAttempts: 'attemptBoth'
  });
  return decoded ? decoded.data : null;
}

async function run() {
  console.log('--- Starting Round 29 Display Checkout & TWQR & Staff Message E2E ---');
  await ensureFreshDbSeeded(prisma);

  const todayStr = toTaipeiDateString(new Date());
  const todayDateObj = dateOnly(todayStr);
  const nowMs = Date.now();
  const displayPw = `DispR29_${nowMs}`;

  let createdLayoutId = null;
  let createdDeviceId = null;
  let createdUserId = null;
  let createdEqId = null;
  let createdSessionId = null;
  const createdBookingRefs = [];
  let prevGlobalSetting = null;
  let prevDisplaySetting = null;

  try {
    prevGlobalSetting = await prisma.globalSetting.findUnique({ where: { id: 1 } });
    prevDisplaySetting = await prisma.displaySetting.findUnique({ where: { id: 1 } });

    // Ensure initial GlobalSetting.payment_methods_json has cash, transfer, linepay enabled; card disabled (NO easycard!)
    const initialMethods = [
      { key: 'cash', label: '現金', enabled: true },
      { key: 'transfer', label: '轉帳', enabled: true },
      { key: 'linepay', label: 'LINE Pay', enabled: true },
      { key: 'card', label: '信用卡', enabled: false }
    ];
    await prisma.globalSetting.upsert({
      where: { id: 1 },
      update: { payment_methods_json: initialMethods },
      create: { id: 1, payment_methods_json: initialMethods }
    });

    // Seed DisplaySetting open 24h on 'timers' with empty TWQR initially
    const activeSchedule = {
      self: { mode: 'always', before: 15, after: 15, on: '09:45', off: '23:55', content: 'timers_self' },
      weekday: { mode: 'always', before: 15, after: 15, on: '09:45', off: '23:55', content: 'timers' },
      holiday: { mode: 'always', before: 15, after: 15, on: '09:45', off: '23:55', content: 'timers' },
      closed: { mode: 'never', before: 0, after: 0, on: '', off: '', content: 'off' }
    };
    await prisma.displaySetting.upsert({
      where: { id: 1 },
      update: {
        schedule: activeSchedule,
        special_dates: [],
        fallback_to_slides: false,
        checkout_sync: true,
        checkout_wake: true,
        checkout_per_person: true,
        thanks_seconds: 4,
        idle_minutes: 5,
        message_minutes: 3,
        twqr_mode: 'acct',
        twqr_bank_code: '',
        twqr_account: '',
        twqr_payload: '',
        twqr_use_raw_image: false,
        twqr_raw_image: null,
        twqr_logo_enabled: true,
        twqr_logo_image: null
      },
      create: {
        id: 1,
        schedule: activeSchedule,
        special_dates: [],
        fallback_to_slides: false,
        checkout_sync: true,
        checkout_wake: true,
        checkout_per_person: true,
        thanks_seconds: 4,
        idle_minutes: 5,
        message_minutes: 3,
        twqr_mode: 'acct',
        twqr_bank_code: '',
        twqr_account: '',
        twqr_payload: '',
        twqr_use_raw_image: false,
        twqr_raw_image: null,
        twqr_logo_enabled: true,
        twqr_logo_image: null
      }
    });

    // Ensure today has open normal dailySetting (not self service)
    await prisma.dailySetting.upsert({
      where: { date: todayDateObj },
      update: { is_self_service: false, allow_unlimited: true },
      create: { date: todayDateObj, is_self_service: false, allow_unlimited: true }
    });

    // Seed published SeatLayout + A1 table
    const layoutDef = buildDemoLayoutData();
    const layout = await prisma.seatLayout.create({
      data: {
        name: layoutDef.name,
        status: 'published',
        effective_from: todayDateObj,
        published_at: new Date(),
        canvas_w: layoutDef.canvas_w,
        canvas_h: layoutDef.canvas_h,
        kiosk_map_rotation: layoutDef.kiosk_map_rotation,
        elements_json: layoutDef.elements_json
      }
    });
    createdLayoutId = layout.id;

    const zone = await prisma.seatZone.create({
      data: { layout_id: layout.id, name: 'A區', sort_order: 1 }
    });
    const tbl = await prisma.seatTable.create({
      data: { layout_id: layout.id, zone_id: zone.id, label: 'A1', cx: 235, cy: 250, w: 70, h: 140, sort_order: 0 }
    });
    for (const [sIdx, [code, lx, ly]] of [['A1-1', -45, -35], ['A1-2', -45, 35], ['A1-3', 45, -35], ['A1-4', 45, 35]].entries()) {
      await prisma.seat.create({
        data: { layout_id: layout.id, zone_id: zone.id, table_id: tbl.id, code, lx, ly, sort_order: sIdx, is_active: true }
      });
    }

    // Create active session covering now
    await prisma.session.deleteMany({ where: { session_date: todayDateObj } });
    const ses = await prisma.session.create({
      data: {
        session_date: todayDateObj,
        start_time: '00:00',
        end_time: '23:59',
        max_capacity: 20
      }
    });
    createdSessionId = ses.id;

    // Seed customer + equipment + 2-person seated reservation
    const sStart = new Date(nowMs - 80 * 60000);
    const customer = await prisma.user.create({
      data: {
        name: '林測試',
        phone: `0999${String(nowMs).slice(-6)}`,
        line_user_id: `r29_priv_${nowMs}`
      }
    });
    createdUserId = customer.id;

    const eq = await prisma.equipmentConfig.create({
      data: {
        id: `r29_eq_${nowMs}`,
        name: '智能板',
        total_stock: 4,
        hourly_rate: 80,
        self_hourly_rate: 80,
        visibility_status: 'VISIBLE',
        sort_order: 1
      }
    });
    createdEqId = eq.id;

    const bookingRef = `BK-R29-${String(nowMs).slice(-5)}`;
    createdBookingRefs.push(bookingRef);

    await prisma.reservation.create({
      data: {
        booking_ref: bookingRef,
        session_id: ses.id,
        user_id: customer.id,
        status: 'confirmed',
        attendance: 'checked_in',
        pax: 2,
        assigned_seats: ['A1-1', 'A1-2'],
        checked_in_at: sStart,
        is_unlimited: false,
        checkout_details: {
          persons: [
            { person_no: 1, mode: 'hourly', hours_override: 2 },
            { person_no: 2, mode: 'hourly', hours_override: 2 }
          ]
        }
      }
    });

    const person1 = await prisma.bookingPerson.create({
      data: {
        booking_ref: bookingRef,
        person_no: 1,
        seat_code: 'A1-1',
        status: 'active',
        billing_start_at: sStart,
        timer_started_at: sStart,
        paused_seconds: 0
      }
    });
    await prisma.bookingPerson.create({
      data: {
        booking_ref: bookingRef,
        person_no: 2,
        seat_code: 'A1-2',
        status: 'active',
        billing_start_at: sStart,
        timer_started_at: sStart,
        paused_seconds: 0
      }
    });

    await prisma.bookingEquipment.create({
      data: {
        booking_ref: bookingRef,
        equipment_id: eq.id,
        equipment_name_snapshot: '智能板',
        person_id: person1.id,
        quantity: 1,
        rental_hours: 2,
        subtotal_price: 160,
        unit_group: crypto.randomUUID(),
        segment_no: 1,
        unit_rate: 80,
        start_at: sStart,
        planned_end_at: new Date(sStart.getTime() + 120 * 60000)
      }
    });

    // Seed display device
    const dispDev = await prisma.displayDevice.create({
      data: {
        name: `R29顯示屏_${String(nowMs).slice(-4)}`,
        password_hash: bcrypt.hashSync(displayPw, 8),
        token_version: 1
      }
    });
    createdDeviceId = dispDev.id;

    // Launch browser with 2 contexts
    const browser = await chromium.launch({ headless: HEADLESS });
    const displayCtx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
    const staffCtx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const displayPage = await displayCtx.newPage();
    const staffPage = await staffCtx.newPage();
    displayPage.on('pageerror', (err) => console.error('[displayPage error]', err.message));
    staffPage.on('pageerror', (err) => console.error('[staffPage error]', err.message));
    staffPage.on('response', (res) => {
      if (res.url().includes('/display/checkout') || res.url().includes('/billing/')) {
        if (res.status() >= 400 || res.url().includes('/display/checkout')) {
          console.log(`[staffPage API] ${res.request().method()} ${res.url()} -> ${res.status()}`);
        }
      }
    });

    // 1. Staff login first & force-clear any stale in-memory displayBus checkout/message
    console.log('1. Logging into /admin/login & clearing stale displayBus state...');
    await staffPage.goto(`${BASE_URL}/admin/login`, { waitUntil: 'networkidle' });
    await staffPage.locator('input[type="password"]').fill(ADMIN_PASSWORD);
    await staffPage.locator('button[type="submit"]').click();
    await staffPage.locator('aside a[href="/admin/seating"]').waitFor({ state: 'visible', timeout: 10000 });
    await staffPage.locator('aside a[href="/admin/seating"]').click();
    await staffPage.waitForURL('**/admin/seating', { timeout: 10000 });

    await staffPage.evaluate(async () => {
      await fetch('http://localhost:3001/api/display/admin/settings', {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ checkout_sync: false })
      });
      await fetch('http://localhost:3001/api/display/admin/settings', {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ checkout_sync: true })
      });
      await fetch('http://localhost:3001/api/display/message', {
        method: 'DELETE',
        credentials: 'include'
      });
    });

    // 2. Display screen login
    console.log('2. Logging into /display...');
    await displayPage.goto(`${BASE_URL}/display`, { waitUntil: 'networkidle' });
    await displayPage.locator('[data-testid="display-login-screen"]').waitFor({ state: 'visible', timeout: 10000 });
    await displayPage.locator('[data-testid="display-login-password"]').fill(displayPw);
    await displayPage.locator('[data-testid="display-login-submit"]').click();
    await displayPage.locator('[data-testid="display-floor-map"]').waitFor({ state: 'visible', timeout: 15000 });
    console.log('   ✔ Display logged in and showing floor map');

    // =========================================================================
    // 3. Item 3: Staff Message Push
    // =========================================================================
    console.log('3. Testing Item 3 staff message push...');
    await staffPage.locator('[data-testid="seating-push-display-msg-btn"]').click();
    await staffPage.locator('[data-testid="display-msg-input"]').fill('廁所暫時清潔中，請稍候 3 分鐘');
    await staffPage.locator('[data-testid="display-msg-submit-btn"]').click();

    await displayPage.locator('[data-testid="display-staff-notice-bar"]').waitFor({ state: 'visible', timeout: 2500 });
    const noticeText = await displayPage.locator('[data-testid="display-staff-notice-text"]').textContent();
    assert.ok(noticeText.includes('廁所暫時清潔中，請稍候 3 分鐘'), `Unexpected staff notice text: ${noticeText}`);
    console.log('   ✔ Staff notice bar appeared on /display within 2.5s');

    const shot5 = path.join(SCREENSHOT_DIR, 'round29_shot5_staff_message.png');
    await displayPage.screenshot({ path: shot5 });
    console.log(`   ✔ Saved Screenshot 5: ${shot5}`);

    // =========================================================================
    // 4. Item 1: Open CheckoutWorkbench -> Sync <= 2s, notice bar hidden
    // =========================================================================
    console.log('4. Testing CheckoutWorkbench open sync + notice bar hidden...');
    await staffPage.locator('[data-testid="tab-list"]:visible').first().click();
    const bookingRow = staffPage.locator(`[data-booking-ref="${bookingRef}"]`).first();
    await bookingRow.waitFor({ state: 'visible', timeout: 10000 });
    await bookingRow.getByRole('button', { name: '結帳' }).click();

    await displayPage.locator('[data-testid="display-checkout-view"]').waitFor({ state: 'visible', timeout: 2500 });
    const noticeVisibleDuringCo = await displayPage.locator('[data-testid="display-staff-notice-bar"]').isVisible();
    assert.equal(noticeVisibleDuringCo, false, 'Staff notice bar must be hidden while checkout is active');

    // Verify dynamic payment methods list (no 悠遊卡, no disabled 信用卡)
    const methodsListText = await displayPage.locator('[data-testid="display-pay-methods-list"]').textContent();
    assert.ok(methodsListText.includes('現金') && methodsListText.includes('轉帳') && methodsListText.includes('LINE Pay'), `Unexpected methods: ${methodsListText}`);
    assert.ok(!methodsListText.includes('悠遊卡') && !methodsListText.includes('信用卡'), `Disabled/removed methods appeared: ${methodsListText}`);

    // Verify zero customer PII leaked on display checkout screen
    const checkoutFullText = await displayPage.locator('[data-testid="display-checkout-view"]').textContent();
    assert.ok(!checkoutFullText.includes('林測試'), 'Customer name must NEVER appear on /display');
    assert.ok(!checkoutFullText.includes(bookingRef), 'Booking ref must NEVER appear on /display');

    const shot1 = path.join(SCREENSHOT_DIR, 'round29_shot1_checkout_together.png');
    await displayPage.screenshot({ path: shot1 });
    console.log(`   ✔ Saved Screenshot 1: ${shot1}`);

    // Toggle sync switch OFF -> display returns & staff notice reappears!
    console.log('5. Testing sync toggle OFF/ON & workbench close without paying...');
    await staffPage.locator('[data-testid="checkout-display-sync-toggle"]').click();
    await displayPage.locator('[data-testid="display-floor-map"]').waitFor({ state: 'visible', timeout: 2500 });
    await displayPage.locator('[data-testid="display-staff-notice-bar"]').waitFor({ state: 'visible', timeout: 2500 });

    // Toggle back ON -> checkout returns
    await staffPage.locator('[data-testid="checkout-display-sync-toggle"]').click();
    await displayPage.locator('[data-testid="display-checkout-view"]').waitFor({ state: 'visible', timeout: 2500 });

    // Close workbench without paying -> returns to floor map & notice bar reappears
    await staffPage.locator('[data-testid="workbench-close-btn"]').click();
    await displayPage.locator('[data-testid="display-floor-map"]').waitFor({ state: 'visible', timeout: 2500 });
    await displayPage.locator('[data-testid="display-staff-notice-bar"]').waitFor({ state: 'visible', timeout: 2500 });
    console.log('   ✔ Closing workbench returned /display to floor map & restored staff notice');

    // Clear staff message -> disappears <= 2.5s
    await staffPage.locator('[data-testid="seating-clear-display-msg-btn"]').click();
    await displayPage.locator('[data-testid="display-staff-notice-bar"]').waitFor({ state: 'hidden', timeout: 2500 });
    console.log('   ✔ Cleared staff message disappeared <= 2.5s');

    // =========================================================================
    // 6. Item 2A: Transfer selected while TWQR NOT configured
    // =========================================================================
    console.log('6. Testing transfer when TWQR is not yet configured...');
    await bookingRow.getByRole('button', { name: '結帳' }).click();
    await displayPage.locator('[data-testid="display-checkout-view"]').waitFor({ state: 'visible', timeout: 2500 });
    await staffPage.locator('[data-testid="workbench-collect-btn"]').last().click();
    await staffPage.locator('[data-testid="pay-method-transfer"]').click();

    await displayPage.getByText('還沒有設定收款條碼').waitFor({ state: 'visible', timeout: 2500 });
    const fallbackText = await displayPage.locator('[data-testid="display-checkout-view"]').textContent();
    assert.ok(fallbackText.includes('請改用'), `Expected fallback payment hint, got: ${fallbackText}`);
    console.log('   ✔ Unconfigured TWQR shows honest fallback message');

    await staffPage.keyboard.press('Escape').catch(() => {});
    await staffPage.locator('[data-testid="workbench-close-btn"]').click();
    await displayPage.locator('[data-testid="display-floor-map"]').waitFor({ state: 'visible', timeout: 2500 });

    // =========================================================================
    // 7. Item 2B: Configure TWQR on /admin/display + Verify Cash Change + TWQR jsQR decode
    // =========================================================================
    console.log('7. Configuring fake test TWQR on /admin/display (bank 822, account 000123456789)...');
    await staffPage.goto(`${BASE_URL}/admin/display`, { waitUntil: 'networkidle' });
    await staffPage.locator('[data-testid="twqr-mode-acct"]').check();
    await staffPage.locator('[data-testid="twqr-bank-code-input"]').fill('822');
    await staffPage.locator('[data-testid="twqr-account-input"]').fill('000123456789');

    const maskedPreview = await staffPage.locator('[data-testid="twqr-masked-code"]').textContent();
    assert.ok(maskedPreview.includes('•') && maskedPreview.includes('6789'), `Expected masked preview with last4, got: ${maskedPreview}`);
    assert.ok(!maskedPreview.includes('000123456789'), 'Full account number must NOT appear plaintext in masked preview');

    await staffPage.locator('[data-testid="display-save-settings-btn"]').click();
    await staffPage.locator('[data-testid="display-admin-notice"]').waitFor({ state: 'visible', timeout: 8000 });

    // Back to /admin/seating -> Cash Change + Transfer TWQR
    await staffPage.goto(`${BASE_URL}/admin/seating`, { waitUntil: 'networkidle' });
    const bookingRow2 = staffPage.locator(`[data-booking-ref="${bookingRef}"]`).first();
    await bookingRow2.waitFor({ state: 'visible', timeout: 10000 });
    await bookingRow2.getByRole('button', { name: '結帳' }).click();
    await displayPage.locator('[data-testid="display-checkout-view"]').waitFor({ state: 'visible', timeout: 2500 });

    await staffPage.locator('[data-testid="workbench-collect-btn"]').last().click();
    await staffPage.locator('[data-testid="pay-method-cash"]').click();
    await staffPage.locator('[data-testid="cashpad-received-input"]').last().fill('2000');

    await displayPage.locator('[data-testid="display-cash-change"]').waitFor({ state: 'visible', timeout: 2500 });
    const cashChangeText = await displayPage.locator('[data-testid="display-cash-change"]').textContent();
    assert.ok(cashChangeText.includes('找您'), `Expected cash change box, got: ${cashChangeText}`);

    const shot3 = path.join(SCREENSHOT_DIR, 'round29_shot3_checkout_cash_change.png');
    await displayPage.screenshot({ path: shot3 });
    console.log(`   ✔ Saved Screenshot 3: ${shot3}`);

    // Switch to transfer -> verify TWQR box & logo + decode QR with jsQR!
    console.log('8. Switching to transfer -> verifying TWQR barcode & decoding PNG with jsQR...');
    await staffPage.locator('[data-testid="pay-method-transfer"]').click();
    await displayPage.locator('[data-testid="display-twqr-box"]').waitFor({ state: 'visible', timeout: 3000 });
    await displayPage.locator('[data-testid="display-qr-logo"]').waitFor({ state: 'visible', timeout: 3000 });

    const transferViewText = await displayPage.locator('[data-testid="display-checkout-view"]').textContent();
    assert.ok(transferViewText.includes('支援 TWQR 的銀行 App'), 'Missing TWQR caption');
    assert.ok(!transferViewText.includes('請輸入上方金額'), 'TWQR view MUST NOT contain 請輸入上方金額');

    const expectedTwqrPayload = buildTransferPayload('822', '000123456789');
    const decodedWithLogo = await decodeElementQrPng(displayPage, displayPage.locator('[data-testid="display-twqr-box"]'));
    console.log(`   [jsQR w/ logo] decoded: ${decodedWithLogo}`);
    assert.equal(decodedWithLogo, expectedTwqrPayload, 'QR code WITH logo must decode via jsQR to exact TWQR payload!');

    const shot4 = path.join(SCREENSHOT_DIR, 'round29_shot4_checkout_twqr.png');
    await displayPage.screenshot({ path: shot4 });
    console.log(`   ✔ Saved Screenshot 4: ${shot4}`);

    // Disable TWQR logo briefly and verify decode WITHOUT logo too
    await staffPage.evaluate(async () => {
      const res = await fetch('http://localhost:3001/api/display/admin/settings', {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ twqr_logo_enabled: false })
      });
      if (!res.ok) throw new Error(`Failed to toggle twqr_logo_enabled: ${res.status}`);
    });
    // Re-trigger method sync so updated twqr payload/logo flag pushes
    await staffPage.locator('[data-testid="pay-method-cash"]').click();
    await displayPage.locator('[data-testid="display-pay-state"]').getByText('現金付款').waitFor({ state: 'visible', timeout: 2500 }).catch(() => {});
    await staffPage.locator('[data-testid="pay-method-transfer"]').click();
    await displayPage.locator('[data-testid="display-twqr-box"]').waitFor({ state: 'visible', timeout: 3000 });
    await displayPage.locator('[data-testid="display-qr-logo"]').waitFor({ state: 'hidden', timeout: 3000 });

    const decodedNoLogo = await decodeElementQrPng(displayPage, displayPage.locator('[data-testid="display-twqr-box"]'));
    console.log(`   [jsQR w/o logo] decoded: ${decodedNoLogo}`);
    assert.equal(decodedNoLogo, expectedTwqrPayload, 'QR code WITHOUT logo must decode via jsQR to exact TWQR payload!');

    // =========================================================================
    // 9. Dynamic GlobalSetting.payment_methods_json toggle (linepay OFF, card ON)
    // =========================================================================
    console.log('9. Toggling GlobalSetting.payment_methods_json (linepay OFF, card ON)...');
    const updatedMethods = [
      { key: 'cash', label: '現金', enabled: true },
      { key: 'transfer', label: '轉帳', enabled: true },
      { key: 'linepay', label: 'LINE Pay', enabled: false },
      { key: 'card', label: '信用卡', enabled: true }
    ];
    await staffPage.evaluate(async (methods) => {
      const res = await fetch('http://localhost:3001/api/daily-settings/global', {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ payment_methods_json: methods })
      });
      if (!res.ok) throw new Error(`Failed to update global settings: ${res.status}`);
    }, updatedMethods);

    // Reload staff page & reopen workbench -> unselected methods must reflect change
    await staffPage.goto(`${BASE_URL}/admin/seating`, { waitUntil: 'networkidle' });
    const bookingRow3 = staffPage.locator(`[data-booking-ref="${bookingRef}"]`).first();
    await bookingRow3.waitFor({ state: 'visible', timeout: 10000 });
    await bookingRow3.getByRole('button', { name: '結帳' }).click();

    await displayPage.locator('[data-testid="display-pay-methods-list"]').waitFor({ state: 'visible', timeout: 3000 });
    const updatedListText = await displayPage.locator('[data-testid="display-pay-methods-list"]').textContent();
    assert.ok(!updatedListText.includes('LINE Pay'), `Disabled LINE Pay should disappear: ${updatedListText}`);
    assert.ok(updatedListText.includes('信用卡'), `Newly enabled 信用卡 should appear: ${updatedListText}`);
    assert.ok(!updatedListText.includes('悠遊卡'), `Unconfigured 悠遊卡 must NEVER appear: ${updatedListText}`);

    await staffPage.locator('[data-testid="workbench-collect-btn"]').last().click();
    await staffPage.locator('[data-testid="pay-method-card"]').click();
    await displayPage.getByText('請依店員指示').waitFor({ state: 'visible', timeout: 2500 });
    const cardStateLabel = await displayPage.locator('[data-testid="display-pay-state"]').textContent();
    assert.ok(cardStateLabel.includes('信用卡'), `Expected 信用卡 custom method label, got: ${cardStateLabel}`);
    console.log('   ✔ Dynamic GlobalSetting payment method toggle + custom method prompt verified');

    // Close modal & switch to 分開收款
    await staffPage.keyboard.press('Escape');

    // =========================================================================
    // 10. Split Checkout (分開收款) + Partial Paid + Thanks Screen
    // =========================================================================
    console.log('10. Testing split checkout (pay person 1 -> thanks -> person 2 w/ 已付) ...');
    await staffPage.getByRole('button', { name: '分開收款' }).last().click();
    // Unselect person 2 so only person 1 is selected
    await staffPage.locator('[data-testid="split-person-card-2"]').click();
    await staffPage.waitForTimeout(350);

    await staffPage.locator('[data-testid="pay-method-cash"]').click();
    await staffPage.getByRole('button', { name: /確認收款 NT\$/ }).click();

    // Verify DisplayThanksView ("謝謝光臨") appears immediately
    await displayPage.locator('[data-testid="display-thanks-view"]').waitFor({ state: 'visible', timeout: 3000 });
    console.log('   ✔ Paid person 1 -> DisplayThanksView visible');

    // Click "結第 2 位" -> /display shows split view with person 1 marked 已付 & dimmed!
    await staffPage.getByRole('button', { name: '結第 2 位' }).click();
    await displayPage.locator('[data-testid="display-checkout-view"]').waitFor({ state: 'visible', timeout: 3000 });
    const person1Text = await displayPage.locator('[data-testid="display-checkout-person-1"]').textContent();
    assert.ok(person1Text.includes('已付'), `Expected 已付 badge on person 1, got: ${person1Text}`);
    const p1Opacity = await displayPage.locator('[data-testid="display-checkout-person-1"]').evaluate(el => getComputedStyle(el).opacity);
    assert.ok(parseFloat(p1Opacity) < 0.6, `Expected person 1 dimmed opacity < 0.6, got ${p1Opacity}`);

    const shot2 = path.join(SCREENSHOT_DIR, 'round29_shot2_checkout_split_paid.png');
    await displayPage.screenshot({ path: shot2 });
    console.log(`   ✔ Saved Screenshot 2: ${shot2}`);

    // Collect person 2 -> DisplayThanksView -> auto-returns to floor map after thanks_seconds (4s)
    await staffPage.locator('[data-testid="pay-method-cash"]').click();
    await staffPage.getByRole('button', { name: /確認收款 NT\$/ }).click();
    await displayPage.locator('[data-testid="display-thanks-view"]').waitFor({ state: 'visible', timeout: 3000 });

    await displayPage.locator('[data-testid="display-floor-map"]').waitFor({ state: 'visible', timeout: 8000 });
    console.log('   ✔ Final collect showed thanks screen and auto-returned to floor map!');

    await browser.close();
    console.log('✅ Round 29 Display Checkout & TWQR & Staff Message E2E PASSED!');
  } finally {
    if (prevGlobalSetting) {
      await prisma.globalSetting.update({
        where: { id: 1 },
        data: { payment_methods_json: prevGlobalSetting.payment_methods_json }
      }).catch(() => {});
    }
    if (prevDisplaySetting) {
      const { id: _id, updated_at: _u, ...restDs } = prevDisplaySetting;
      await prisma.displaySetting.update({
        where: { id: 1 },
        data: restDs
      }).catch(() => {});
    }
    await prisma.accountingEvent.deleteMany({
      where: {
        OR: [
          { event_type: { in: ['display_message_push', 'display_message_clear'] } },
          ...(createdBookingRefs.length > 0 ? [{ booking_ref: { in: createdBookingRefs } }] : [])
        ]
      }
    }).catch(() => {});
    if (createdBookingRefs.length > 0) {
      await prisma.payment.deleteMany({ where: { booking_ref: { in: createdBookingRefs } } }).catch(() => {});
      await prisma.bookingEquipment.deleteMany({ where: { booking_ref: { in: createdBookingRefs } } }).catch(() => {});
      await prisma.bookingPerson.deleteMany({ where: { booking_ref: { in: createdBookingRefs } } }).catch(() => {});
      await prisma.reservation.deleteMany({ where: { booking_ref: { in: createdBookingRefs } } }).catch(() => {});
    }
    if (createdEqId) {
      await prisma.equipmentConfig.delete({ where: { id: createdEqId } }).catch(() => {});
    }
    if (createdUserId) {
      await prisma.user.delete({ where: { id: createdUserId } }).catch(() => {});
    }
    if (createdSessionId) {
      await prisma.session.delete({ where: { id: createdSessionId } }).catch(() => {});
    }
    if (createdLayoutId) {
      await prisma.seat.deleteMany({ where: { layout_id: createdLayoutId } }).catch(() => {});
      await prisma.seatTable.deleteMany({ where: { layout_id: createdLayoutId } }).catch(() => {});
      await prisma.seatZone.deleteMany({ where: { layout_id: createdLayoutId } }).catch(() => {});
      await prisma.seatLayout.delete({ where: { id: createdLayoutId } }).catch(() => {});
    }
    if (createdDeviceId) {
      await prisma.displayDevice.delete({ where: { id: createdDeviceId } }).catch(() => {});
    }
    await prisma.$disconnect();
  }
}

run().catch((err) => {
  console.error('❌ Round 29 Display Checkout Playwright E2E Failed:', err);
  process.exit(1);
});
