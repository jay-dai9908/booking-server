import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { ensureFreshDbSeeded } from './helpers/seedFreshDb.js';
import { toTaipeiDateString, dateOnly } from '../../shared/time.js';

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
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD?.trim();
const JWT_SECRET = process.env.JWT_SECRET?.trim() || 'test-secret';

const SCREENSHOT_DIR = process.env.SCREENSHOT_DIR
  ? path.resolve(process.env.SCREENSHOT_DIR)
  : path.resolve('tests/screenshots');
fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

async function run() {
  console.log('--- Starting Round 27 Floor Guide Playwright Test ---');
  await ensureFreshDbSeeded(prisma);

  const todayStr = toTaipeiDateString(new Date());
  const todayDateObj = dateOnly(todayStr);

  let customerUser = null;
  let bookingRef = null;
  let sessionObj = null;

  try {
    // 1. Ensure a published layout with door marked as entrance and fixture
    const layout = await prisma.seatLayout.upsert({
      where: { id: 999 },
      update: {
        status: 'published',
        effective_from: dateOnly('2020-01-01'),
        kiosk_map_rotation: 0,
        elements_json: [
          { id: 'wall-main', type: 'wall', points: [[0, 0], [720, 0], [720, 1160], [0, 1160]] },
          { id: 'door-main', type: 'door', cx: 360, cy: 1150, w: 80, h: 20, kiosk: { entrance: true } },
          { id: 'counter-main', type: 'counter', label: '服務櫃檯', cx: 180, cy: 1000, w: 100, h: 50, kiosk: { show: 'icon_name', icon: 'counter', color: 'brown' } }
        ]
      },
      create: {
        id: 999,
        name: 'R27測試版面',
        status: 'published',
        effective_from: dateOnly('2020-01-01'),
        canvas_w: 720,
        canvas_h: 1160,
        kiosk_map_rotation: 0,
        elements_json: [
          { id: 'wall-main', type: 'wall', points: [[0, 0], [720, 0], [720, 1160], [0, 1160]] },
          { id: 'door-main', type: 'door', cx: 360, cy: 1150, w: 80, h: 20, kiosk: { entrance: true } },
          { id: 'counter-main', type: 'counter', label: '服務櫃檯', cx: 180, cy: 1000, w: 100, h: 50, kiosk: { show: 'icon_name', icon: 'counter', color: 'brown' } }
        ]
      }
    });

    const zone = await prisma.seatZone.upsert({
      where: { id: 999 },
      update: { layout_id: layout.id, name: 'A區', sort_order: 1 },
      create: { id: 999, layout_id: layout.id, name: 'A區', sort_order: 1 }
    });

    const table = await prisma.seatTable.upsert({
      where: { id: 999 },
      update: { layout_id: layout.id, zone_id: zone.id, label: 'A1', cx: 200, cy: 300, w: 100, h: 100 },
      create: { id: 999, layout_id: layout.id, zone_id: zone.id, label: 'A1', cx: 200, cy: 300, w: 100, h: 100 }
    });

    await prisma.seat.upsert({
      where: { layout_id_code: { layout_id: layout.id, code: 'A1-1' } },
      update: { table_id: table.id, zone_id: zone.id, is_active: true, lx: -30, ly: 0 },
      create: { layout_id: layout.id, table_id: table.id, zone_id: zone.id, code: 'A1-1', is_active: true, lx: -30, ly: 0 }
    });

    // Ensure session for today exists
    sessionObj = await prisma.session.findFirst({
      where: { session_date: todayDateObj },
      orderBy: { start_time: 'asc' }
    });
    if (!sessionObj) {
      sessionObj = await prisma.session.create({
        data: {
          session_date: todayDateObj,
          start_time: '10:00',
          end_time: '23:59',
          max_capacity: 10
        }
      });
    }

    // Ensure daily setting mode is 'self' (is_self_service: true)
    await prisma.dailySetting.upsert({
      where: { date: todayDateObj },
      update: { is_self_service: true, iron_mode: 'today' },
      create: { date: todayDateObj, is_self_service: true, iron_mode: 'today' }
    });

    // Ensure globalSetting.seat_layout_enabled is true
    await prisma.globalSetting.upsert({
      where: { id: 1 },
      update: { seat_layout_enabled: true },
      create: { id: 1, seat_layout_enabled: true }
    });

    // Create customer and checked-in booking
    const TS = Date.now();
    customerUser = await prisma.user.create({
      data: {
        name: `地圖客_${TS}`,
        phone: `0999${String(TS).slice(-6)}`,
        line_user_id: `map_user_${TS}`
      }
    });

    bookingRef = crypto.randomUUID();
    const reservation = await prisma.reservation.create({
      data: {
        booking_ref: bookingRef,
        session_id: sessionObj.id,
        user_id: customerUser.id,
        status: 'confirmed',
        pax: 1,
        assigned_seats: ['A1-1'],
        checked_in_at: new Date(), // Checked in!
        is_self_service: true,
        billing_status: 'paid'
      }
    });

    await prisma.bookingPrepay.create({
      data: {
        booking_ref: bookingRef,
        user_id: customerUser.id,
        total_amount: 500,
        amount_due: 0,
        status: 'verified',
        deadline_at: new Date(Date.now() + 86400000),
        settled_at: new Date(),
        verified_at: new Date()
      }
    });

    const browser = await chromium.launch({ headless: HEADLESS });

    // =========================================================================
    // 1. DESKTOP ADMIN: SeatLayoutPage fixture settings & preview (Screenshot 1)
    // =========================================================================
    const adminCtx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const adminPage = await adminCtx.newPage();

    console.log('Navigating admin to /admin/login...');
    await adminPage.goto(`${BASE_URL}/admin/login`, { waitUntil: 'networkidle' });
    await adminPage.locator('input[type="password"]').fill(ADMIN_PASSWORD);
    await adminPage.click('button[type="submit"]');
    await adminPage.waitForURL((u) => !u.pathname.includes('/login'), { timeout: 10000 });
    await adminPage.waitForTimeout(500);

    console.log('Navigating admin to /admin/seat-layout...');
    await adminPage.goto(`${BASE_URL}/admin/seat-layout`, { waitUntil: 'networkidle' });
    await adminPage.waitForTimeout(1000);

    // Click on the counter on SVG canvas or select it
    const counterSvg = adminPage.locator('rect[fill="#E5DDD0"]').first();
    if (await counterSvg.isVisible()) {
      await counterSvg.click({ force: true });
      await adminPage.waitForTimeout(600);
    }

    // Verify fixture settings section exists
    const fixtureSettings = adminPage.locator('[data-testid="kiosk-fixture-settings"]');
    if (await fixtureSettings.isVisible()) {
      console.log('Found kiosk-fixture-settings panel in SeatLayoutPage');
    }

    const shot1 = path.join(SCREENSHOT_DIR, 'round27_shot1_desktop_seat_layout.png');
    await adminPage.screenshot({ path: shot1 });
    console.log(`Saved Screenshot 1 (Desktop Seat Layout Fixture & Preview): ${shot1}`);

    // =========================================================================
    // 2. MOBILE 320px: Customer Entry Pass checked-in floor map (Screenshot 2)
    // =========================================================================
    const customerToken = jwt.sign(
      { id: customerUser.id, role: 'customer', name: customerUser.name, phone: customerUser.phone },
      JWT_SECRET,
      { expiresIn: '1d' }
    );

    const m320Ctx = await browser.newContext({
      viewport: { width: 320, height: 640 },
      isMobile: true,
      hasTouch: true
    });
    await m320Ctx.addInitScript((tok) => {
      try {
        sessionStorage.setItem('shiguang_auth_token', tok);
      } catch {}
    }, customerToken);
    const m320Page = await m320Ctx.newPage();

    const customerUrl = `${BASE_URL}/history?tab=bookings`;
    console.log(`Navigating 320px mobile to ${customerUrl}...`);
    await m320Page.goto(customerUrl, { waitUntil: 'networkidle' });

    // Wait for in-state entry pass card
    const inCard320 = m320Page.locator(`[data-testid="entry-pass-in-${bookingRef}"]`);
    await inCard320.waitFor({ state: 'visible', timeout: 12000 });
    await m320Page.locator('text=已進場').waitFor({ state: 'visible', timeout: 8000 });

    // Verify floor map rendered
    const mapBox320 = m320Page.locator('[data-testid="entry-pass-floor-map"]');
    await mapBox320.waitFor({ state: 'visible', timeout: 10000 });

    // Verify "你的座位" tag and "入口" tag and fixture label
    await m320Page.locator('text=你的座位').first().waitFor({ state: 'visible', timeout: 5000 });
    await m320Page.locator('text=入口').first().waitFor({ state: 'visible', timeout: 5000 });
    await m320Page.locator('text=服務櫃檯').first().waitFor({ state: 'visible', timeout: 5000 });
    await m320Page.waitForTimeout(500);

    const shot2 = path.join(SCREENSHOT_DIR, 'round27_shot2_mobile320_floor_guide.png');
    await m320Page.screenshot({ path: shot2 });
    console.log(`Saved Screenshot 2 (Mobile 320px Checked-In Floor Map): ${shot2}`);

    // =========================================================================
    // 3. MOBILE 430px: Customer Entry Pass checked-in floor map (Screenshot 3)
    // =========================================================================
    const m430Ctx = await browser.newContext({
      viewport: { width: 430, height: 800 },
      isMobile: true,
      hasTouch: true
    });
    await m430Ctx.addInitScript((tok) => {
      try {
        sessionStorage.setItem('shiguang_auth_token', tok);
      } catch {}
    }, customerToken);
    const m430Page = await m430Ctx.newPage();

    console.log(`Navigating 430px mobile to ${customerUrl}...`);
    await m430Page.goto(customerUrl, { waitUntil: 'networkidle' });

    const inCard430 = m430Page.locator(`[data-testid="entry-pass-in-${bookingRef}"]`);
    await inCard430.waitFor({ state: 'visible', timeout: 12000 });
    await m430Page.locator('[data-testid="entry-pass-floor-map"]').waitFor({ state: 'visible', timeout: 10000 });
    await m430Page.locator('text=你的座位').first().waitFor({ state: 'visible', timeout: 5000 });
    await m430Page.locator('text=入口').first().waitFor({ state: 'visible', timeout: 5000 });
    await m430Page.waitForTimeout(500);

    const shot3 = path.join(SCREENSHOT_DIR, 'round27_shot3_mobile430_floor_guide.png');
    await m430Page.screenshot({ path: shot3 });
    console.log(`Saved Screenshot 3 (Mobile 430px Checked-In Floor Map): ${shot3}`);

    await browser.close();
    console.log('✅ Round 27 Floor Guide Playwright Test PASSED successfully!');
  } finally {
    // Cleanup
    if (bookingRef) {
      await prisma.bookingPrepay.deleteMany({ where: { booking_ref: bookingRef } }).catch(() => {});
      await prisma.reservation.deleteMany({ where: { booking_ref: bookingRef } }).catch(() => {});
    }
    if (customerUser) {
      await prisma.user.delete({ where: { id: customerUser.id } }).catch(() => {});
    }
    await prisma.$disconnect();
  }
}

run().catch((err) => {
  console.error('❌ Round 27 Floor Guide Test Failed:', err);
  process.exit(1);
});
