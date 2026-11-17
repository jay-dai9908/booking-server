import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { ensureFreshDbSeeded } from './helpers/seedFreshDb.js';
import { toTaipeiDateString, dateOnly } from '../../shared/time.js';
import { wrapPairKey } from '../../backend/src/services/kiosk/sgk1.js';
import { processKioskAccess } from '../../backend/src/services/kiosk/accessService.js';
import { getReservationEntryPass } from '../../backend/src/services/kiosk/entryService.js';

const require = createRequire(import.meta.url);
const jwt = require('../../backend/node_modules/jsonwebtoken/index.js');
const { PrismaClient } = require('../../backend/node_modules/@prisma/client/index.js');

const testDbUrl =
  process.env.TEST_DATABASE_URL ||
  'postgresql://user:password@localhost:5432/booking_db_test?schema=public';
const prisma = new PrismaClient({ datasources: { db: { url: testDbUrl.trim() } } });

const BASE_URL = process.env.BASE_URL || 'http://localhost:5173';
const API_BASE = process.env.API_BASE || 'http://localhost:3001/api';
const HEADLESS = process.env.HEADLESS !== 'false';
if (!process.env.ADMIN_PASSWORD?.trim()) {
  console.error('請設定 ADMIN_PASSWORD 環境變數');
}
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD?.trim();
const JWT_SECRET = process.env.JWT_SECRET?.trim();

const SCREENSHOT_DIR = process.env.SCREENSHOT_DIR
  ? path.resolve(process.env.SCREENSHOT_DIR)
  : path.resolve('tests/screenshots');
fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

async function run() {
  console.log('--- Starting Round 26 Entry Pass Playwright Test ---');
  await ensureFreshDbSeeded(prisma);

  const todayStr = toTaipeiDateString(new Date());
  const todayDateObj = dateOnly(todayStr);

  let createdLayoutId = null;
  let customerUser = null;
  let device = null;
  let bookingRef = null;
  let sessionId = null;

  try {
    // 0. Ensure published layout with active seats
    const activeLayouts = await prisma.seatLayout.findMany({
      where: { status: 'published' },
      include: { tables: { include: { seats: true } } }
    });
    if (activeLayouts.length === 0) {
      const l = await prisma.seatLayout.create({
        data: {
          name: `R26-Entry-Layout-${Date.now()}`,
          status: 'published',
          effective_from: dateOnly('2020-01-01'),
          capacity: 16,
          tables: {
            create: {
              label: 'A 桌',
              shape: 'rect',
              cx: 150,
              cy: 150,
              w: 80,
              h: 120,
              seats: {
                create: Array.from({ length: 16 }, (_, i) => ({
                  code: `A1-${i + 1}`,
                  seat_no: i + 1,
                  offset_x: (i % 4) * 30,
                  offset_y: Math.floor(i / 4) * 30,
                  is_active: true
                }))
              }
            }
          }
        }
      });
      createdLayoutId = l.id;
    }

    // 1. Configure today as self-service day
    await prisma.dailySetting.upsert({
      where: { date: todayDateObj },
      update: {
        is_self_service: true,
        iron_mode: 'today',
        iron_date: null
      },
      create: {
        date: todayDateObj,
        is_self_service: true,
        iron_mode: 'today',
        iron_date: null
      }
    });

    // Configure KioskSetting
    await prisma.kioskSetting.upsert({
      where: { id: 1 },
      update: {
        early_minutes: 30,
        after_close_minutes: 60,
        prepay_deadline_hour: 12,
        max_unpaid_self_bookings: 10
      },
      create: {
        id: 1,
        early_minutes: 30,
        after_close_minutes: 60,
        prepay_deadline_hour: 12,
        max_unpaid_self_bookings: 10
      }
    });

    // Create session covering current time in Taipei (10:00 to 23:00)
    const startTimeStr = '10:00';
    const endTimeStr = '23:00';

    const sess = await prisma.session.upsert({
      where: {
        session_date_start_time: {
          session_date: todayDateObj,
          start_time: startTimeStr
        }
      },
      update: {
        end_time: endTimeStr,
        max_capacity: 16
      },
      create: {
        session_date: todayDateObj,
        start_time: startTimeStr,
        end_time: endTimeStr,
        max_capacity: 16
      }
    });
    sessionId = sess.id;

    // Create paired KioskDevice for kiosk simulator access
    const pairKey = crypto.randomBytes(32);
    device = await prisma.kioskDevice.create({
      data: {
        name: '門口測試機-Playwright',
        key_wrapped: wrapPairKey(pairKey, JWT_SECRET),
        is_active: true,
        status_json: { wifi: 'good', scanner: 'ok', uptime_s: 7200, boot_reason: 'power_on' },
        have_json: { backup_code_rev: 0, setup_pin_rev: 0 },
        last_seen_at: new Date()
      }
    });

    // Create customer user
    customerUser = await prisma.user.upsert({
      where: { line_user_id: 'r26_e2e_customer' },
      update: { name: 'E2E報到顧客', phone: '0912345678', is_blacklisted: false },
      create: { line_user_id: 'r26_e2e_customer', name: 'E2E報到顧客', phone: '0912345678' }
    });

    // 2. Prepare today's confirmed & paid self-service reservation
    bookingRef = crypto.randomUUID();
    await prisma.reservation.create({
      data: {
        booking_ref: bookingRef,
        session_id: sess.id,
        user_id: customerUser.id,
        pax: 1,
        total_amount: 550,
        billing_status: 'paid',
        is_paid: true,
        status: 'confirmed',
        attendance: 'booked',
        is_self_service: true,
        assigned_seats: ['A1-1'],
        is_seat_locked: false
      }
    });

    await prisma.bookingPrepay.create({
      data: {
        booking_ref: bookingRef,
        user_id: customerUser.id,
        total_amount: 550,
        status: 'verified',
        amount_due: 0,
        deadline_at: new Date(Date.now() + 86400000),
        settled_at: new Date()
      }
    });

    // Generate Customer JWT token
    const customerToken = jwt.sign(
      { id: customerUser.id, role: 'customer', name: customerUser.name, phone: customerUser.phone },
      JWT_SECRET,
      { expiresIn: '1d' }
    );

    // Launch Playwright Browser
    const launchOptions = { headless: HEADLESS };
    if (process.env.PLAYWRIGHT_CHROMIUM_PATH) {
      launchOptions.executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH;
    }
    const browser = await chromium.launch(launchOptions);

    // =========================================================================
    // 1. MOBILE CUSTOMER CONTEXT (390x844) -> Open Barcode View (P4d)
    // =========================================================================
    const mobileContext = await browser.newContext({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 2,
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148'
    });
    await mobileContext.addInitScript((tok) => {
      try {
        sessionStorage.setItem('shiguang_auth_token', tok);
      } catch {}
    }, customerToken);

    const custPage = await mobileContext.newPage();
    custPage.on('console', (msg) => console.log('[Browser Console]', msg.type(), msg.text()));
    custPage.on('pageerror', (err) => console.log('[Browser Error]', err.message));

    console.log('Navigating to /history?tab=bookings...');
    await custPage.goto(`${BASE_URL}/history?tab=bookings`, { waitUntil: 'networkidle' });
    const bodyText = await custPage.locator('body').innerText();
    console.log('[Page Text Content]:', bodyText.slice(0, 500));

    // Verify EntryPassCard is in 'open' state with QR canvas and countdown
    const openCard = custPage.locator(`[data-testid="entry-pass-open-${bookingRef}"]`);
    await openCard.waitFor({ state: 'visible', timeout: 10000 });
    const qrCanvas = custPage.locator('[data-testid="entry-pass-qr-canvas"]');
    await qrCanvas.waitFor({ state: 'visible', timeout: 8000 });
    await custPage.locator('text=進場條碼').waitFor({ state: 'visible', timeout: 5000 });
    await custPage.locator('[data-testid="entry-pass-countdown"]').waitFor({ state: 'visible', timeout: 5000 });
    await custPage.waitForTimeout(500);

    // Screenshot 1: Mobile entry pass barcode (P4d)
    const shot1 = path.join(SCREENSHOT_DIR, 'round26_shot1_entry_barcode.png');
    await custPage.screenshot({ path: shot1 });
    console.log(`Saved Screenshot 1 (Mobile Entry Barcode P4d): ${shot1}`);

    // =========================================================================
    // 2. SIMULATE KIOSK SCAN VIA ACCESS SERVICE
    // =========================================================================
    // Obtain dynamic QR code for this booking
    const passData = await getReservationEntryPass(prisma, {
      bookingRef,
      userId: customerUser.id,
      now: new Date()
    });
    assert.ok(passData.code, 'Entry pass should provide dynamic code in open state');
    console.log(`Simulating Kiosk scan of dynamic code: ${passData.code}`);

    const accessOutcome = await processKioskAccess(prisma, {
      device,
      method: 'qr',
      payload: passData.code,
      now: new Date()
    });
    assert.equal(accessOutcome.result, 'FIRST_CHECKIN');
    assert.equal(accessOutcome.open_door, true);
    console.log('Kiosk scan succeeded: FIRST_CHECKIN, open_door: true');

    // =========================================================================
    // 3. VERIFY CUSTOMER PAGE TRANSITIONS TO CHECKED-IN (P4e) WITHIN 10 SECONDS
    // =========================================================================
    console.log('Waiting for customer page to auto-poll and transition to "已進場"...');
    const inCard = custPage.locator(`[data-testid="entry-pass-in-${bookingRef}"]`);
    await inCard.waitFor({ state: 'visible', timeout: 10000 });
    await custPage.locator('text=已進場').waitFor({ state: 'visible', timeout: 5000 });
    const seatDisplay = custPage.locator('[data-testid="entry-pass-assigned-seats"]');
    await seatDisplay.waitFor({ state: 'visible', timeout: 5000 });
    const seatText = await seatDisplay.innerText();
    console.log(`Customer page updated to checked-in! Assigned seat: ${seatText}`);
    assert.ok(seatText.includes('A1-1'), `Seat text should include A1-1, got: ${seatText}`);
    await custPage.waitForTimeout(500);

    // Screenshot 2: Mobile checked-in view (P4e)
    const shot2 = path.join(SCREENSHOT_DIR, 'round26_shot2_checked_in.png');
    await custPage.screenshot({ path: shot2 });
    console.log(`Saved Screenshot 2 (Mobile Checked-In P4e): ${shot2}`);

    // =========================================================================
    // 4. DESKTOP ADMIN CONTEXT (1280x800) -> Kiosk Page (/admin/kiosk, A3)
    // =========================================================================
    const adminContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const adminPage = await adminContext.newPage();

    console.log('Navigating admin to /admin/login...');
    await adminPage.goto(`${BASE_URL}/admin/login`, { waitUntil: 'networkidle' });
    await adminPage.locator('input[type="password"]').fill(ADMIN_PASSWORD);
    await adminPage.click('button[type="submit"]');
    await adminPage.waitForURL((u) => !u.pathname.includes('/login'), { timeout: 10000 });
    await adminPage.waitForTimeout(1000);

    console.log('Navigating admin to /admin/kiosk...');
    await adminPage.goto(`${BASE_URL}/admin/kiosk`, { waitUntil: 'networkidle' });

    // Verify Admin Kiosk management elements
    await adminPage.locator('h1', { hasText: '門口報到機' }).waitFor({ state: 'visible', timeout: 10000 });
    await adminPage.locator('h2', { hasText: '進場規則' }).waitFor({ state: 'visible', timeout: 5000 });
    await adminPage.locator('h2', { hasText: '備用開門密碼' }).waitFor({ state: 'visible', timeout: 5000 });
    await adminPage.locator('h2', { hasText: '設定模式密碼' }).waitFor({ state: 'visible', timeout: 5000 });
    await adminPage.locator('h2', { hasText: '客服資訊' }).waitFor({ state: 'visible', timeout: 5000 });
    await adminPage.locator('h2', { hasText: '進出紀錄' }).waitFor({ state: 'visible', timeout: 5000 });
    await adminPage.waitForTimeout(600);

    // Screenshot 3: Desktop Admin Kiosk page (A3)
    const shot3 = path.join(SCREENSHOT_DIR, 'round26_shot3_admin_kiosk.png');
    await adminPage.screenshot({ path: shot3 });
    console.log(`Saved Screenshot 3 (Desktop Admin Kiosk Page A3): ${shot3}`);

    await browser.close();
    console.log('--- All Round 26 Playwright test steps completed successfully! ---');
  } finally {
    // Clean up test data
    if (bookingRef) {
      await prisma.kioskAccessLog.deleteMany({ where: { booking_ref: bookingRef } });
      await prisma.payment.deleteMany({ where: { booking_ref: bookingRef } });
      await prisma.bookingPerson.deleteMany({ where: { booking_ref: bookingRef } });
      await prisma.bookingEquipment.deleteMany({ where: { booking_ref: bookingRef } });
      await prisma.bookingPrepay.deleteMany({ where: { booking_ref: bookingRef } });
      await prisma.reservation.deleteMany({ where: { booking_ref: bookingRef } });
    }
    if (customerUser?.id) {
      await prisma.userLoginLog.deleteMany({ where: { user_id: customerUser.id } });
      await prisma.user.delete({ where: { id: customerUser.id } }).catch(() => {});
    }
    await prisma.dailySetting.deleteMany({ where: { date: todayDateObj } });
    if (device?.id) {
      await prisma.kioskAccessLog.deleteMany({ where: { device_id: device.id } });
      await prisma.kioskDevice.delete({ where: { id: device.id } }).catch(() => {});
    }
    if (sessionId) {
      await prisma.session.delete({ where: { id: sessionId } }).catch(() => {});
    }
    if (createdLayoutId) {
      await prisma.seatLayout.delete({ where: { id: createdLayoutId } }).catch(() => {});
    }
    await prisma.$disconnect();
  }
}

run().catch((err) => {
  console.error('Playwright Test Failed:', err);
  process.exit(1);
});
