// frontend/tests/round28_store_display.spec.js
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const dotenv = require('../../backend/node_modules/dotenv/lib/main.js');
dotenv.config({ path: path.resolve(__dirname, '../../backend/.env') });

const bcrypt = require('../../backend/node_modules/bcryptjs/index.js');
const { PrismaClient } = require('../../backend/node_modules/@prisma/client/index.js');
const { ensureFreshDbSeeded } = await import('./helpers/seedFreshDb.js');
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

function formatTaipeiHHmm(ms) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Taipei',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).formatToParts(new Date(ms));
  const map = Object.fromEntries(parts.map(p => [p.type, p.value]));
  const hr = map.hour === '24' ? '00' : map.hour;
  return `${hr}:${map.minute}`;
}

function buildDemoLayoutData() {
  return {
    name: 'R28顯示屏測試版面',
    canvas_w: 720,
    canvas_h: 1167,
    kiosk_map_rotation: 90,
    elements_json: [
      { id: 'wall-1', type: 'wall', points: [[0, 1160], [0, 0], [720, 110], [720, 1160]] },
      { id: 'win-1', type: 'window', points: [[0, 1160], [330, 1160]] },
      { id: 'win-2', type: 'window', points: [[420, 1160], [720, 1160]] },
      { id: 'door-1', type: 'door', cx: 375, cy: 1160, w: 90, h: 14, rotation: 0, label: '入口', kiosk: { entrance: true } },
      { id: 'pillar-1', type: 'pillar', cx: 17.5, cy: 602, w: 35, h: 116, rotation: 0, label: '柱' },
      { id: 'pillar-2', type: 'pillar', cx: 702.5, cy: 602, w: 35, h: 116, rotation: 0, label: '柱' },
      { id: 'fx-counter', type: 'counter', cx: 185, cy: 1060, w: 50, h: 200, rotation: 0, label: '櫃檯', kiosk: { show: 'icon_name', icon: 'counter', color: 'brown' } },
      { id: 'fx-iron', type: 'fixture', cx: 80, cy: 1136, w: 160, h: 48, rotation: 0, label: '燙豆區', kiosk: { show: 'icon_name', icon: 'iron', color: 'coral' } },
      { id: 'fx-beads', type: 'fixture', cx: 24, cy: 770, w: 40, h: 180, rotation: 0, label: '拼豆牆', kiosk: { show: 'name', color: 'honey', pattern: 'beads' } },
      { id: 'fx-sofa', type: 'fixture', cx: 620, cy: 1121, w: 170, h: 68, rotation: 0, label: '沙發', kiosk: { show: 'icon_name', icon: 'sofa', color: 'blue' } }
    ]
  };
}

async function create1920x1080PngBuffer(page) {
  const b64 = await page.evaluate(() => {
    const cvs = document.createElement('canvas');
    cvs.width = 1920;
    cvs.height = 1080;
    const ctx = cvs.getContext('2d');
    ctx.fillStyle = '#F7E3DA';
    ctx.fillRect(0, 0, 1920, 1080);
    ctx.fillStyle = '#FFFDF9';
    ctx.fillRect(80, 80, 1760, 920);
    ctx.fillStyle = '#8B5B43';
    ctx.font = 'bold 96px sans-serif';
    ctx.fillText('拾光製所 半自助日輪播測試圖', 220, 460);
    ctx.fillStyle = '#6F645B';
    ctx.font = '48px sans-serif';
    ctx.fillText('1920 x 1080 · DisplaySlide Upload Sync', 220, 580);
    return cvs.toDataURL('image/png').split(',')[1];
  });
  return Buffer.from(b64, 'base64');
}

async function run() {
  console.log('--- Starting Round 28 Store Display Playwright E2E ---');
  await ensureFreshDbSeeded(prisma);

  const todayStr = toTaipeiDateString(new Date());
  const todayDateObj = dateOnly(todayStr);
  const nowMs = Date.now();
  const initialDisplayPw = `DispInit_${nowMs}`;
  const updatedDisplayPw = `DispNext_${nowMs}`;

  let createdLayoutId = null;
  let createdDeviceId = null;
  let createdUserId = null;
  let createdEqId = null;
  let createdSessionId = null;
  let createdBookedSessionId = null;
  const createdBookingRefs = [];

  try {
    // 1. Seed a published layout matching the store floor
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

    const tablesDef = [
      { label: 'A1', cx: 235, cy: 250, w: 70, h: 140, seats: [['A1-1', -45, -35], ['A1-2', -45, 35], ['A1-3', 45, -35], ['A1-4', 45, 35]] },
      { label: 'A2', cx: 235, cy: 390, w: 70, h: 140, seats: [['A2-1', -45, -35], ['A2-2', -45, 35], ['A2-3', 45, -35], ['A2-4', 45, 35]] },
      { label: 'A3', cx: 490, cy: 250, w: 70, h: 140, seats: [['A3-1', -45, -35], ['A3-2', -45, 35], ['A3-3', 45, -35], ['A3-4', 45, 35]] },
      { label: 'B1', cx: 350, cy: 600, w: 140, h: 70, seats: [['B1-1', -35, -45], ['B1-2', 35, -45], ['B1-3', -35, 45], ['B1-4', 35, 45]] },
      { label: 'C1', cx: 686, cy: 780, w: 60, h: 250, seats: [['C1-1', -45, -92], ['C1-2', -45, -31], ['C1-3', -45, 31], ['C1-4', -45, 92]] }
    ];

    for (let tIdx = 0; tIdx < tablesDef.length; tIdx++) {
      const td = tablesDef[tIdx];
      const tbl = await prisma.seatTable.create({
        data: {
          layout_id: layout.id,
          zone_id: zone.id,
          label: td.label,
          cx: td.cx,
          cy: td.cy,
          w: td.w,
          h: td.h,
          sort_order: tIdx
        }
      });
      for (let sIdx = 0; sIdx < td.seats.length; sIdx++) {
        const [code, lx, ly] = td.seats[sIdx];
        await prisma.seat.create({
          data: {
            layout_id: layout.id,
            zone_id: zone.id,
            table_id: tbl.id,
            code,
            lx,
            ly,
            is_active: true,
            sort_order: sIdx
          }
        });
      }
    }

    // 2. Seed DisplayDevice, DisplaySetting, KioskSetting, Session, DailySetting
    await prisma.displayDevice.deleteMany({});
    const dev = await prisma.displayDevice.create({
      data: {
        name: '店內顯示屏',
        password_hash: await bcrypt.hash(initialDisplayPw, 10),
        token_version: 1
      }
    });
    createdDeviceId = dev.id;

    await prisma.kioskSetting.upsert({
      where: { id: 1 },
      update: { line_url: 'https://lin.ee/shiguang', line_id: '@shiguang' },
      create: { id: 1, line_url: 'https://lin.ee/shiguang', line_id: '@shiguang' }
    });

    const baseSchedule = {
      self: { mode: 'always', before: 30, after: 30, on: '09:30', off: '21:30', content: 'slides_self' },
      weekday: { mode: 'always', before: 15, after: 15, on: '09:45', off: '21:15', content: 'timers' },
      holiday: { mode: 'always', before: 15, after: 30, on: '09:45', off: '21:30', content: 'timers' },
      closed: { mode: 'never', before: 0, after: 0, on: '', off: '', content: 'off' }
    };

    await prisma.displaySetting.upsert({
      where: { id: 1 },
      update: {
        schedule: baseSchedule,
        special_dates: [],
        map_rotation: 90,
        here_element: 'fx-counter',
        time_mode: 'remain',
        soon_minutes: 10,
        fallback_to_slides: true,
        cards: { seats: true, soon: true, price: true },
        card_seconds: 12,
        announcements: [
          '新色到貨：霧面奶茶色系 12 色，色豆架第 3 排',
          '作品熨燙約需 20 分鐘，完成後店員會到座位通知'
        ],
        announcement_seconds: 10,
        show_line_mini: true,
        line_title: '有問題請加 LINE',
        notices: [
          '用預約紀錄的進場條碼或預約電話進門',
          '今天沒有店員，作品完成請放在熨燙區托盤',
          '離開前請把豆子倒回原本的格子',
          '飲料請放在桌邊杯架，避免打翻',
          '想延長時間，請直接在 LINE 預約'
        ],
        closing_warn: true,
        closing_minutes: 30,
        shift_minutes: 3,
        slide_seconds: 8
      },
      create: {
        id: 1,
        schedule: baseSchedule,
        special_dates: [],
        map_rotation: 90,
        here_element: 'fx-counter',
        time_mode: 'remain',
        soon_minutes: 10,
        fallback_to_slides: true,
        cards: { seats: true, soon: true, price: true },
        card_seconds: 12,
        announcements: [
          '新色到貨：霧面奶茶色系 12 色，色豆架第 3 排',
          '作品熨燙約需 20 分鐘，完成後店員會到座位通知'
        ],
        announcement_seconds: 10,
        show_line_mini: true,
        line_title: '有問題請加 LINE',
        notices: [
          '用預約紀錄的進場條碼或預約電話進門',
          '今天沒有店員，作品完成請放在熨燙區托盤',
          '離開前請把豆子倒回原本的格子',
          '飲料請放在桌邊杯架，避免打翻',
          '想延長時間，請直接在 LINE 預約'
        ],
        closing_warn: true,
        closing_minutes: 30,
        shift_minutes: 3,
        slide_seconds: 8
      }
    });

    await prisma.dailySetting.upsert({
      where: { date: todayDateObj },
      update: { is_self_service: false, allow_unlimited: true },
      create: { date: todayDateObj, is_self_service: false, allow_unlimited: true }
    });

    await prisma.session.deleteMany({ where: { session_date: todayDateObj } });
    const mainSession = await prisma.session.create({
      data: {
        session_date: todayDateObj,
        start_time: '00:00',
        end_time: '23:59',
        max_capacity: 20
      }
    });
    createdSessionId = mainSession.id;

    // 3. Seed EquipmentConfig + Bookings representing all seat statuses + board badge
    const eqCfg = await prisma.equipmentConfig.create({
      data: {
        id: `r28_small_${nowMs}`,
        name: '小板',
        hourly_rate: 80,
        self_hourly_rate: 80,
        total_stock: 5,
        visibility_status: 'VISIBLE',
        sort_order: 1
      }
    });
    createdEqId = eqCfg.id;

    const secretCustomerName = '王小秘密測試員';
    const secretCustomerPhone = '0987654321';
    const user = await prisma.user.create({
      data: {
        name: secretCustomerName,
        phone: secretCustomerPhone,
        line_user_id: `r28_priv_${nowMs}`
      }
    });
    createdUserId = user.id;

    // Group 1: running (A1-1, A1-2) 3h booked, 80m elapsed -> 1:40 left, with board
    const refRun = `BK-R28R-${String(nowMs).slice(-4)}`;
    createdBookingRefs.push(refRun);
    await prisma.reservation.create({
      data: {
        booking_ref: refRun,
        session_id: mainSession.id,
        user_id: user.id,
        status: 'confirmed',
        attendance: 'checked_in',
        pax: 2,
        assigned_seats: ['A1-1', 'A1-2'],
        checked_in_at: new Date(nowMs - 80 * 60000),
        is_unlimited: false,
        checkout_details: {
          persons: [
            { person_no: 1, mode: 'hourly', hours_override: 3 },
            { person_no: 2, mode: 'hourly', hours_override: 3 }
          ]
        }
      }
    });
    await prisma.bookingPerson.createMany({
      data: [
        {
          booking_ref: refRun,
          person_no: 1,
          seat_code: 'A1-1',
          status: 'active',
          billing_start_at: new Date(nowMs - 80 * 60000),
          timer_started_at: new Date(nowMs - 80 * 60000),
          paused_seconds: 0
        },
        {
          booking_ref: refRun,
          person_no: 2,
          seat_code: 'A1-2',
          status: 'active',
          billing_start_at: new Date(nowMs - 80 * 60000),
          timer_started_at: new Date(nowMs - 80 * 60000),
          paused_seconds: 0
        }
      ]
    });
    await prisma.bookingEquipment.create({
      data: {
        booking_ref: refRun,
        equipment_id: eqCfg.id,
        equipment_name_snapshot: '小板',
        quantity: 1,
        rental_hours: 3,
        subtotal_price: 240,
        unit_group: crypto.randomUUID(),
        segment_no: 1,
        unit_rate: 80,
        start_at: new Date(nowMs - 80 * 60000),
        planned_end_at: new Date(nowMs + 20 * 60000)
      }
    });

    // Group 2: unlimited (A2-1, A2-2) 140m elapsed -> 2:20
    const refUnl = `BK-R28U-${String(nowMs).slice(-4)}`;
    createdBookingRefs.push(refUnl);
    await prisma.reservation.create({
      data: {
        booking_ref: refUnl,
        session_id: mainSession.id,
        user_id: user.id,
        status: 'confirmed',
        attendance: 'checked_in',
        pax: 2,
        assigned_seats: ['A2-1', 'A2-2'],
        checked_in_at: new Date(nowMs - 140 * 60000),
        is_unlimited: true
      }
    });
    await prisma.bookingPerson.createMany({
      data: [
        {
          booking_ref: refUnl,
          person_no: 1,
          seat_code: 'A2-1',
          status: 'active',
          billing_start_at: new Date(nowMs - 140 * 60000),
          timer_started_at: new Date(nowMs - 140 * 60000),
          paused_seconds: 0
        },
        {
          booking_ref: refUnl,
          person_no: 2,
          seat_code: 'A2-2',
          status: 'active',
          billing_start_at: new Date(nowMs - 140 * 60000),
          timer_started_at: new Date(nowMs - 140 * 60000),
          paused_seconds: 0
        }
      ]
    });

    // Group 3: paused (A3-3) 4h booked, 200m elapsed, 15m paused -> 0:55 left
    const refPaused = `BK-R28P-${String(nowMs).slice(-4)}`;
    createdBookingRefs.push(refPaused);
    await prisma.reservation.create({
      data: {
        booking_ref: refPaused,
        session_id: mainSession.id,
        user_id: user.id,
        status: 'confirmed',
        attendance: 'checked_in',
        pax: 1,
        assigned_seats: ['A3-3'],
        checked_in_at: new Date(nowMs - 200 * 60000),
        is_unlimited: false,
        checkout_details: { persons: [{ person_no: 1, mode: 'hourly', hours_override: 4 }] }
      }
    });
    await prisma.bookingPerson.create({
      data: {
        booking_ref: refPaused,
        person_no: 1,
        seat_code: 'A3-3',
        status: 'active',
        billing_start_at: new Date(nowMs - 200 * 60000),
        timer_started_at: new Date(nowMs - 200 * 60000),
        paused_seconds: 15 * 60
      }
    });

    // Soon (A3-1: 55m elapsed of 1h -> 5m left)
    const refSoon = `BK-R28S-${String(nowMs).slice(-4)}`;
    createdBookingRefs.push(refSoon);
    await prisma.reservation.create({
      data: {
        booking_ref: refSoon,
        session_id: mainSession.id,
        user_id: user.id,
        status: 'confirmed',
        attendance: 'checked_in',
        pax: 1,
        assigned_seats: ['A3-1'],
        checked_in_at: new Date(nowMs - 55 * 60000),
        is_unlimited: false,
        checkout_details: { persons: [{ person_no: 1, mode: 'hourly', hours_override: 1 }] }
      }
    });
    await prisma.bookingPerson.create({
      data: {
        booking_ref: refSoon,
        person_no: 1,
        seat_code: 'A3-1',
        status: 'active',
        billing_start_at: new Date(nowMs - 55 * 60000),
        timer_started_at: new Date(nowMs - 55 * 60000),
        paused_seconds: 0
      }
    });

    // Overtime (C1-2: 80m elapsed of 1h -> +0:20)
    const refOver = `BK-R28O-${String(nowMs).slice(-4)}`;
    createdBookingRefs.push(refOver);
    await prisma.reservation.create({
      data: {
        booking_ref: refOver,
        session_id: mainSession.id,
        user_id: user.id,
        status: 'confirmed',
        attendance: 'checked_in',
        pax: 1,
        assigned_seats: ['C1-2'],
        checked_in_at: new Date(nowMs - 80 * 60000),
        is_unlimited: false,
        checkout_details: { persons: [{ person_no: 1, mode: 'hourly', hours_override: 1 }] }
      }
    });
    await prisma.bookingPerson.create({
      data: {
        booking_ref: refOver,
        person_no: 1,
        seat_code: 'C1-2',
        status: 'active',
        billing_start_at: new Date(nowMs - 80 * 60000),
        timer_started_at: new Date(nowMs - 80 * 60000),
        paused_seconds: 0
      }
    });

    // Booked (not checked in: B1-1, B1-2) starting 40m from now
    const bookedStartHHmm = formatTaipeiHHmm(nowMs + 40 * 60000);
    const bookedEndHHmm = formatTaipeiHHmm(nowMs + 160 * 60000);
    const bookedSession = await prisma.session.create({
      data: {
        session_date: todayDateObj,
        start_time: bookedStartHHmm,
        end_time: bookedEndHHmm,
        max_capacity: 20
      }
    });
    createdBookedSessionId = bookedSession.id;

    const refBooked = `BK-R28B-${String(nowMs).slice(-4)}`;
    createdBookingRefs.push(refBooked);
    await prisma.reservation.create({
      data: {
        booking_ref: refBooked,
        session_id: bookedSession.id,
        user_id: user.id,
        status: 'confirmed',
        pax: 2,
        assigned_seats: ['B1-1', 'B1-2'],
        checked_in_at: null,
        is_unlimited: false
      }
    });

    // =========================================================================
    // Launch Browser: Display Context (1920x1080) + Admin Context (1280x1200)
    // =========================================================================
    const browser = await chromium.launch({ headless: HEADLESS });

    const displayCtx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
    const displayPage = await displayCtx.newPage();

    console.log('1. Testing /display login & localStorage persistence...');
    await displayPage.goto(`${BASE_URL}/display`, { waitUntil: 'networkidle' });
    await displayPage.locator('[data-testid="display-login-screen"]').waitFor({ state: 'visible', timeout: 10000 });
    await displayPage.locator('[data-testid="display-login-password"]').fill(initialDisplayPw);
    await displayPage.locator('[data-testid="display-login-submit"]').click();
    await displayPage.locator('[data-testid="display-active-screen"]').waitFor({ state: 'visible', timeout: 10000 });

    const storedToken = await displayPage.evaluate(() => localStorage.getItem('sg_display_token'));
    assert.ok(storedToken && storedToken.length > 20, 'Display token stored in localStorage');

    // Reload /display and verify auto-enter without login screen
    await displayPage.reload({ waitUntil: 'networkidle' });
    await displayPage.locator('[data-testid="display-active-screen"]').waitFor({ state: 'visible', timeout: 10000 });
    console.log('   ✔ Login persistence verified after reload');

    // Verify zero PII on /display
    const displayText = await displayPage.locator('[data-testid="display-active-screen"]').innerText();
    assert.ok(!displayText.includes(secretCustomerName), 'Customer name must not appear on /display');
    assert.ok(!displayText.includes(secretCustomerPhone), 'Customer phone must not appear on /display');
    assert.ok(!displayText.includes('BK-R28'), 'Booking ref must not appear on /display');

    // Verify zero interactive buttons inside active display screen
    const clickableCount = await displayPage.locator('[data-testid="display-active-screen"] button, [data-testid="display-active-screen"] a, [data-testid="display-active-screen"] input').count();
    assert.equal(clickableCount, 0, 'Active display screen must have 0 interactive controls');

    // Verify topbar baseline alignment (date text baseline == 拾光製所 baseline)
    await displayPage.waitForTimeout(800);
    const baselineDiff = await displayPage.evaluate(() => {
      const probe = (el) => {
        const i = document.createElement('i');
        i.style.cssText = 'display:inline-block;width:0;height:0;vertical-align:baseline';
        el.appendChild(i);
        const y = i.getBoundingClientRect().top;
        i.remove();
        return y;
      };
      const b = document.querySelector('[data-testid="display-brand-name"]');
      const d = document.querySelector('[data-testid="display-date-text"]');
      return Math.abs(probe(b) - probe(d));
    });
    assert.ok(baselineDiff <= 2.5, `Topbar date baseline diff ${baselineDiff}px should align with 拾光製所`);
    console.log(`   ✔ Topbar baseline diff: ${baselineDiff.toFixed(2)}px`);

    // Verify map seats, board badge, entrance & here markers
    await displayPage.locator('[data-testid="display-seat-A1-1"]').waitFor({ state: 'visible' });
    await displayPage.locator('[data-testid="display-seat-board-A1-1"]').waitFor({ state: 'visible' });
    await displayPage.locator('[data-testid="display-entrance-tag"]').waitFor({ state: 'visible' });
    await displayPage.locator('[data-testid="display-here-tag"]').waitFor({ state: 'visible' });

    // Screenshot 1: 假日平面圖
    const shot1 = path.join(SCREENSHOT_DIR, 'round28_shot1_holiday_map.png');
    await displayPage.screenshot({ path: shot1 });
    console.log(`   ✔ Saved Screenshot 1: ${shot1}`);

    // =========================================================================
    // 2. Admin /admin/display login + sidebar navigation + Screenshot 7
    // =========================================================================
    const adminCtx = await browser.newContext({ viewport: { width: 1280, height: 1200 } });
    const adminPage = await adminCtx.newPage();

    console.log('2. Testing /admin/display UI & sidebar link...');
    await adminPage.goto(`${BASE_URL}/admin/login`, { waitUntil: 'networkidle' });
    await adminPage.locator('input[type="password"]').fill(ADMIN_PASSWORD);
    await adminPage.click('button[type="submit"]');
    await adminPage.waitForURL((u) => !u.pathname.includes('/login'), { timeout: 10000 });

    const navLink = adminPage.locator('aside a[href="/admin/display"]');
    await navLink.waitFor({ state: 'visible', timeout: 8000 });
    assert.match(await navLink.innerText(), /店內顯示屏/);
    await navLink.click();
    await adminPage.waitForURL('**/admin/display', { timeout: 10000 });
    await adminPage.locator('[data-testid="display-admin-page"]').waitFor({ state: 'visible', timeout: 10000 });
    await adminPage.waitForTimeout(500);

    // Screenshot 7: Admin /admin/display page
    const shot7 = path.join(SCREENSHOT_DIR, 'round28_shot7_admin_display.png');
    await adminPage.screenshot({ path: shot7, fullPage: true });
    console.log(`   ✔ Saved Screenshot 7: ${shot7}`);

    // =========================================================================
    // 3. Test rotation sync <= 35s & announcement sync <= 35s
    // =========================================================================
    console.log('3. Testing rotation sync & announcement sync <= 35s...');
    const beforeEntBox = await displayPage.locator('[data-testid="display-entrance-tag"]').boundingBox();
    await adminPage.locator('[data-testid="display-rot-btn-270"]').click();
    const uniqueAnn = `R28同步測試公告_${String(nowMs).slice(-4)}`;
    await adminPage.locator('[data-testid="display-announcements-textarea"]').fill(uniqueAnn);
    await adminPage.locator('[data-testid="display-save-settings-btn"]').click();
    await adminPage.locator('[data-testid="display-admin-notice"]').waitFor({ state: 'visible', timeout: 8000 });

    await displayPage.waitForFunction(
      (expectedAnn) => {
        const annEl = document.querySelector('[data-testid="display-announcement-text"]');
        return annEl && annEl.textContent.includes(expectedAnn);
      },
      uniqueAnn,
      { timeout: 35000 }
    );
    const afterEntBox = await displayPage.locator('[data-testid="display-entrance-tag"]').boundingBox();
    assert.ok(
      Math.abs(beforeEntBox.x - afterEntBox.x) > 50 || Math.abs(beforeEntBox.y - afterEntBox.y) > 50,
      'Entrance tag position must change after 90° -> 270° rotation'
    );
    console.log('   ✔ Rotation sync & announcement sync verified within 35s');

    // Restore rotation back to 90° for remaining screenshots
    await adminPage.locator('[data-testid="display-rot-btn-90"]').click();
    await adminPage.locator('[data-testid="display-save-settings-btn"]').click();
    await adminPage.waitForTimeout(500);

    // =========================================================================
    // 4. Screenshot 2: Closing Warning (打烊前提醒)
    // =========================================================================
    console.log('4. Testing closing warning banner & Screenshot 2...');
    const closeSoonMs = Date.now() + 18 * 60000;
    const closeSoonHHmm = formatTaipeiHHmm(closeSoonMs);
    await prisma.session.updateMany({
      where: { session_date: todayDateObj },
      data: { end_time: closeSoonHHmm }
    });
    // Trigger settings save so SSE immediately pushes fresh state
    await adminPage.locator('[data-testid="display-save-settings-btn"]').click();
    await displayPage.locator('[data-testid="display-ticker-closing"]').waitFor({ state: 'visible', timeout: 35000 });
    const shot2 = path.join(SCREENSHOT_DIR, 'round28_shot2_closing_warn.png');
    await displayPage.screenshot({ path: shot2 });
    console.log(`   ✔ Saved Screenshot 2: ${shot2}`);

    // Restore session end_time
    await prisma.session.update({
      where: { id: mainSession.id },
      data: { end_time: '23:59' }
    });
    await prisma.session.update({
      where: { id: bookedSession.id },
      data: { end_time: bookedEndHHmm }
    });

    // =========================================================================
    // 5. Slide upload sync + Screenshot 3 (半自助日輪播)
    // =========================================================================
    console.log('5. Testing slide upload sync & Screenshot 3...');
    const pngBuffer = await create1920x1080PngBuffer(adminPage);
    await adminPage.locator('[data-testid="display-slide-file-self"]').setInputFiles({
      name: 'self-slide.png',
      mimeType: 'image/png',
      buffer: pngBuffer
    });
    await adminPage.locator('[data-testid="display-slide-upload-self"]').click();
    await adminPage.locator('[data-testid="display-slides-self"] img').waitFor({ state: 'visible', timeout: 10000 });

    await prisma.dailySetting.update({
      where: { date: todayDateObj },
      data: { is_self_service: true }
    });
    await adminPage.locator('[data-testid="display-save-settings-btn"]').click();
    await displayPage.locator('[data-testid="display-layout-slides-self"]').waitFor({ state: 'visible', timeout: 35000 });
    await displayPage.locator('[data-testid="display-slide-image-self"] img').waitFor({ state: 'visible', timeout: 10000 });
    await displayPage.waitForTimeout(500);

    const shot3 = path.join(SCREENSHOT_DIR, 'round28_shot3_self_slides.png');
    await displayPage.screenshot({ path: shot3 });
    console.log(`   ✔ Saved Screenshot 3: ${shot3}`);

    // =========================================================================
    // 6. Screenshot 4: 平面圖＋LINE (timers_self)
    // =========================================================================
    console.log('6. Capturing Screenshot 4 (平面圖＋LINE)...');
    await prisma.displaySetting.update({
      where: { id: 1 },
      data: {
        schedule: {
          ...baseSchedule,
          self: { ...baseSchedule.self, content: 'timers_self' }
        }
      }
    });
    await adminPage.locator(`[data-testid="device-reload-btn-${createdDeviceId}"]`).click().catch(() => {});
    // Save settings from API/reload to push SSE
    await displayPage.reload({ waitUntil: 'networkidle' });
    await displayPage.locator('[data-testid="display-layout-timers-self"]').waitFor({ state: 'visible', timeout: 15000 });
    await displayPage.waitForTimeout(500);
    const shot4 = path.join(SCREENSHOT_DIR, 'round28_shot4_floor_line.png');
    await displayPage.screenshot({ path: shot4 });
    console.log(`   ✔ Saved Screenshot 4: ${shot4}`);

    // =========================================================================
    // 7. Screenshot 5: 一般輪播 (slides_gen)
    // =========================================================================
    console.log('7. Capturing Screenshot 5 (一般輪播)...');
    await prisma.dailySetting.update({
      where: { date: todayDateObj },
      data: { is_self_service: false }
    });
    await prisma.displaySetting.update({
      where: { id: 1 },
      data: {
        schedule: {
          ...baseSchedule,
          weekday: { ...baseSchedule.weekday, content: 'slides_gen' },
          holiday: { ...baseSchedule.holiday, content: 'slides_gen' }
        }
      }
    });
    await displayPage.reload({ waitUntil: 'networkidle' });
    await displayPage.locator('[data-testid="display-layout-slides-gen"]').waitFor({ state: 'visible', timeout: 15000 });
    await displayPage.waitForTimeout(500);
    const shot5 = path.join(SCREENSHOT_DIR, 'round28_shot5_general_slides.png');
    await displayPage.screenshot({ path: shot5 });
    console.log(`   ✔ Saved Screenshot 5: ${shot5}`);

    // =========================================================================
    // 8. Screenshot 6: 關閉時段全黑 (off)
    // =========================================================================
    console.log('8. Capturing Screenshot 6 (關閉時段全黑)...');
    await prisma.displaySetting.update({
      where: { id: 1 },
      data: {
        schedule: {
          ...baseSchedule,
          weekday: { mode: 'never', before: 0, after: 0, on: '', off: '', content: 'off' },
          holiday: { mode: 'never', before: 0, after: 0, on: '', off: '', content: 'off' }
        }
      }
    });
    await displayPage.reload({ waitUntil: 'networkidle' });
    await displayPage.locator('[data-testid="display-off-screen"]').waitFor({ state: 'visible', timeout: 15000 });
    const shot6 = path.join(SCREENSHOT_DIR, 'round28_shot6_off_black.png');
    await displayPage.screenshot({ path: shot6 });
    console.log(`   ✔ Saved Screenshot 6: ${shot6}`);

    // =========================================================================
    // 9. Password reset logout <= 10s
    // =========================================================================
    console.log('9. Testing password reset logout <= 10s...');
    await adminPage.reload({ waitUntil: 'networkidle' });
    await adminPage.locator(`[data-testid="device-pw-toggle-${createdDeviceId}"]`).click();
    await adminPage.locator(`[data-testid="device-pw-input-${createdDeviceId}"]`).fill(updatedDisplayPw);
    await adminPage.locator(`[data-testid="device-pw-save-${createdDeviceId}"]`).click();

    await displayPage.locator('[data-testid="display-login-screen"]').waitFor({ state: 'visible', timeout: 10000 });
    console.log('   ✔ Display logged out within 10s after password change');

    // Login again with new password
    await displayPage.locator('[data-testid="display-login-password"]').fill(updatedDisplayPw);
    await displayPage.locator('[data-testid="display-login-submit"]').click();
    await displayPage.locator('[data-testid="display-off-screen"], [data-testid="display-active-screen"]').first().waitFor({ state: 'visible', timeout: 10000 });
    console.log('   ✔ Re-login with new password succeeded');

    await browser.close();
    console.log('✅ Round 28 Store Display Playwright E2E PASSED!');
  } finally {
    await prisma.displaySlide.deleteMany({}).catch(() => {});
    if (createdBookingRefs.length > 0) {
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
    if (createdBookedSessionId) {
      await prisma.session.delete({ where: { id: createdBookedSessionId } }).catch(() => {});
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
  console.error('❌ Round 28 Store Display Playwright E2E Failed:', err);
  process.exit(1);
});
