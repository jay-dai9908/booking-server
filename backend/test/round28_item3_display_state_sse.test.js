import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import bcrypt from 'bcryptjs';
import prisma from '../src/prismaClient.js';
import { dateOnly, toTaipeiDateString } from '../../shared/time.js';
import { getLiveFloorData } from '../src/services/floor/liveService.js';
import { invalidateDisplayAuthCache } from '../src/middlewares/displayAuth.js';
import { resetDisplayBusForTests } from '../src/services/display/displayBus.js';
import { clearDisplayLoginFailures } from '../src/controllers/displayDeviceController.js';
import { startDisplayTestServer } from './helpers/displayTestServer.js';

function openSseClient(url) {
  return new Promise((resolve, reject) => {
    const events = [];
    let buffer = '';
    let settled = false;

    const req = http.get(url, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`SSE status ${res.statusCode}`));
        return;
      }

      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        buffer += chunk;
        const parts = buffer.split('\n\n');
        buffer = parts.pop() || '';
        for (const part of parts) {
          const lines = part.split('\n');
          let evName = 'message';
          let dataStr = '';
          for (const ln of lines) {
            if (ln.startsWith('event:')) evName = ln.slice(6).trim();
            else if (ln.startsWith('data:')) dataStr += ln.slice(5).trim();
          }
          if (dataStr) {
            try {
              events.push({ event: evName, data: JSON.parse(dataStr) });
            } catch {
              events.push({ event: evName, data: dataStr });
            }
          }
        }
      });

      const handle = {
        events,
        res,
        waitForEvent(predicate, timeoutMs = 4000) {
          return new Promise((resEv, rejEv) => {
            const start = Date.now();
            const check = () => {
              const found = events.find(predicate);
              if (found) return resEv(found);
              if (Date.now() - start > timeoutMs) {
                return rejEv(new Error(`Timeout waiting for SSE event after ${timeoutMs}ms; got ${events.map((e) => e.event).join(',')}`));
              }
              setTimeout(check, 50);
            };
            check();
          });
        },
        waitForClose(timeoutMs = 3000) {
          return new Promise((resCl, rejCl) => {
            if (res.complete) return resCl();
            const timer = setTimeout(() => rejCl(new Error('Timeout waiting for SSE close')), timeoutMs);
            res.once('end', () => { clearTimeout(timer); resCl(); });
            res.once('close', () => { clearTimeout(timer); resCl(); });
          });
        },
        close() {
          req.destroy();
        }
      };

      if (!settled) {
        settled = true;
        resolve(handle);
      }
    });

    req.on('error', (err) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    });
  });
}

test('Round 28 Item 3: Display state timer parity, privacy scan, heartbeat, and SSE stream/push/logout', async () => {
  const srv = await startDisplayTestServer();
  const BASE = srv.baseUrl;
  const ts = Date.now();
  const now = new Date();
  const todayStr = toTaipeiDateString(now);
  const todayDate = dateOnly(todayStr);

  const created = {
    staffId: null,
    deviceId: null,
    userId: null,
    layoutId: null,
    sessionIds: [],
    bookingRefs: []
  };

  try {
    clearDisplayLoginFailures();
    invalidateDisplayAuthCache();
    resetDisplayBusForTests();

    // Backup any existing published layout for today? Only create one if none exists, or create a clean published one and clean up
    const existingLayouts = await prisma.seatLayout.findMany({ where: { status: 'published' } });

    const staffPass = `sse_admin_${ts}`;
    const staff = await prisma.adminUser.create({
      data: { name: 'SSE Admin', password: staffPass, role: 'staff', permissions: ['settings', 'reservations', 'seating'], is_active: true }
    });
    created.staffId = staff.id;

    const loginAdminRes = await fetch(`${BASE}/api/auth/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: staffPass })
    });
    const adminToken = (await loginAdminRes.json()).token;

    // Create DisplayDevice
    const devPass = `disp_sse_${ts}`;
    const dev = await prisma.displayDevice.create({
      data: { name: `SSE Display ${ts}`, password_hash: await bcrypt.hash(devPass, 10), token_version: 1 }
    });
    created.deviceId = dev.id;

    const dispLoginRes = await fetch(`${BASE}/api/display/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device_id: dev.id, password: devPass })
    });
    assert.equal(dispLoginRes.status, 200);
    const displayToken = (await dispLoginRes.json()).token;

    // Ensure layout exists with seats D1-1..D1-6
    let layoutIdToUse;
    if (existingLayouts.length === 0) {
      const lay = await prisma.seatLayout.create({
        data: {
          name: `R28 Layout ${ts}`,
          status: 'published',
          effective_from: dateOnly('2020-01-01'),
          published_at: new Date(),
          elements_json: [
            { id: 'door-1', type: 'door', cx: 100, cy: 100, w: 60, h: 12, kiosk: { entrance: true } },
            { id: 'cnt-1', type: 'counter', label: '櫃檯', cx: 200, cy: 200, w: 80, h: 60 }
          ]
        }
      });
      created.layoutId = lay.id;
      const zone = await prisma.seatZone.create({ data: { layout_id: lay.id, name: '前區', sort_order: 1 } });
      const table = await prisma.seatTable.create({ data: { layout_id: lay.id, zone_id: zone.id, label: 'D1', cx: 400, cy: 300, w: 80, h: 160 } });
      for (let i = 1; i <= 6; i++) {
        await prisma.seat.create({
          data: { layout_id: lay.id, zone_id: zone.id, table_id: table.id, code: `D1-${i}`, lx: i % 2 ? -40 : 40, ly: i * 30, is_active: true }
        });
      }
      layoutIdToUse = lay.id;
    } else {
      layoutIdToUse = existingLayouts[0].id;
    }

    const layoutFull = await prisma.seatLayout.findUnique({
      where: { id: layoutIdToUse },
      include: { seats: { where: { is_active: true }, orderBy: { id: 'asc' } } }
    });
    const seatCodes = layoutFull.seats.map((s) => s.code);
    assert.ok(seatCodes.length >= 5, 'Need at least 5 active seats for state parity test');

    // Ensure today has sessions (10:00-12:00, 12:00-14:00, 14:00-16:00, 16:00-18:00)
    const slots = [
      ['10:00', '12:00'],
      ['12:00', '14:00'],
      ['14:00', '16:00'],
      ['16:00', '18:00']
    ];
    const sessions = [];
    for (const [st, et] of slots) {
      const s = await prisma.session.upsert({
        where: { session_date_start_time: { session_date: todayDate, start_time: st } },
        update: {},
        create: { session_date: todayDate, start_time: st, end_time: et, max_capacity: 20 }
      });
      sessions.push(s);
    }

    // Create PII-rich customer user
    const piiName = '秘密顧客陳大明';
    const piiPhone = '0912345678';
    const piiLineId = `U_secret_line_${ts}`;
    const user = await prisma.user.create({
      data: { line_user_id: piiLineId, name: piiName, phone: piiPhone, line_display_name: 'LineNickSecret' }
    });
    created.userId = user.id;

    // Ensure EquipmentConfig pegboard exists
    await prisma.equipmentConfig.upsert({
      where: { id: 'pegboard_s' },
      update: {},
      create: { id: 'pegboard_s', name: '小板', hourly_rate: 80, total_stock: 5, visibility_status: 'ACTIVE' }
    });

    // Build 5 scenarios:
    // 1. hourly running (seatCodes[0])
    // 2. unlimited (seatCodes[1])
    // 3. paused (seatCodes[2])
    // 4. booked not checked in (seatCodes[3])
    // 5. checked-in with smart board (seatCodes[4])
    const refRunning = `BK-R28-RUN-${ts}`;
    const refUnl = `BK-R28-UNL-${ts}`;
    const refPaused = `BK-R28-PAU-${ts}`;
    const refBooked = `BK-R28-BKD-${ts}`;
    const refBoard = `BK-R28-BRD-${ts}`;
    created.bookingRefs.push(refRunning, refUnl, refPaused, refBooked, refBoard);

    const t1 = new Date(now.getTime() - 45 * 60000);

    // 1. Running
    await prisma.reservation.create({
      data: {
        booking_ref: refRunning, session_id: sessions[0].id, user_id: user.id, pax: 1,
        assigned_seats: [seatCodes[0]], attendance: 'checked_in', checked_in_at: t1, is_unlimited: false
      }
    });
    await prisma.bookingPerson.create({
      data: { booking_ref: refRunning, person_no: 1, seat_code: seatCodes[0], status: 'active', billing_start_at: t1, timer_started_at: t1 }
    });

    // 2. Unlimited
    await prisma.reservation.create({
      data: {
        booking_ref: refUnl, session_id: sessions[0].id, user_id: user.id, pax: 1,
        assigned_seats: [seatCodes[1]], attendance: 'checked_in', checked_in_at: t1, is_unlimited: true
      }
    });
    await prisma.bookingPerson.create({
      data: { booking_ref: refUnl, person_no: 1, seat_code: seatCodes[1], status: 'active', billing_start_at: t1, timer_started_at: t1 }
    });

    // 3. Paused (15 mins ended pause = 900s)
    await prisma.reservation.create({
      data: {
        booking_ref: refPaused, session_id: sessions[0].id, user_id: user.id, pax: 1,
        assigned_seats: [seatCodes[2]], attendance: 'checked_in', checked_in_at: t1, is_unlimited: false
      }
    });
    await prisma.bookingPerson.create({
      data: { booking_ref: refPaused, person_no: 1, seat_code: seatCodes[2], status: 'active', billing_start_at: t1, timer_started_at: t1, paused_seconds: 900 }
    });

    // 4. Booked (future session or late session that hasn't ended yet; use a dynamic end time 2h from now if needed)
    const futureHour = (now.getUTCHours() + 8 + 2) % 24;
    const futureSession = futureHour >= 22
      ? sessions[3]
      : await prisma.session.upsert({
          where: { session_date_start_time: { session_date: todayDate, start_time: '22:00' } },
          update: {},
          create: { session_date: todayDate, start_time: '22:00', end_time: '23:59', max_capacity: 20 }
        });
    await prisma.reservation.create({
      data: {
        booking_ref: refBooked, session_id: futureSession.id, user_id: user.id, pax: 1,
        assigned_seats: [seatCodes[3]], attendance: null, is_unlimited: false
      }
    });

    // 5. Checked-in with smart board (expiring in 10 mins)
    await prisma.reservation.create({
      data: {
        booking_ref: refBoard, session_id: sessions[0].id, user_id: user.id, pax: 1,
        assigned_seats: [seatCodes[4]], attendance: 'checked_in', checked_in_at: t1, is_unlimited: false,
        amount_due: 8888
      }
    });
    const bpBoard = await prisma.bookingPerson.create({
      data: { booking_ref: refBoard, person_no: 1, seat_code: seatCodes[4], status: 'active', billing_start_at: t1, timer_started_at: t1 }
    });
    await prisma.bookingEquipment.create({
      data: {
        booking_ref: refBoard,
        equipment_id: 'pegboard_s',
        equipment_name_snapshot: '小板',
        quantity: 1,
        rental_hours: 2,
        subtotal_price: 160,
        person_id: bpBoard.id,
        unit_group: `ug-${ts}`,
        segment_no: 1,
        start_at: t1,
        planned_end_at: new Date(now.getTime() + 10 * 60000)
      }
    });

    // A. Fetch GET /api/display/state and compare against getLiveFloorData
    const stateRes = await fetch(`${BASE}/api/display/state`, {
      headers: { Authorization: `Bearer ${displayToken}` }
    });
    assert.equal(stateRes.status, 200);
    const state = await stateRes.json();

    const liveData = await getLiveFloorData(todayStr, new Date(state.server_now));

    const findSeat = (code) => state.seats.find((s) => s.code === code);
    const findLivePerson = (ref) => liveData.bookings.find((b) => b.booking_ref === ref)?.persons?.[0];

    // Parity checks
    const sRun = findSeat(seatCodes[0]);
    const lpRun = findLivePerson(refRunning);
    assert.equal(sRun.state, 'running');
    assert.equal(sRun.mode, 'hourly');
    assert.equal(sRun.origin_at, lpRun.timer.billing_start_at);
    assert.equal(sRun.paused_seconds, lpRun.timer.paused_seconds);
    assert.equal(sRun.has_board, false);

    const sUnl = findSeat(seatCodes[1]);
    const lpUnl = findLivePerson(refUnl);
    assert.equal(sUnl.state, 'unlimited');
    assert.equal(sUnl.mode, 'unlimited');
    assert.equal(sUnl.origin_at, lpUnl.timer.billing_start_at);

    const sPau = findSeat(seatCodes[2]);
    const lpPau = findLivePerson(refPaused);
    assert.equal(sPau.state, 'paused');
    assert.equal(sPau.paused_seconds, 900);
    assert.equal(sPau.paused_seconds, lpPau.timer.paused_seconds);

    const sBkd = findSeat(seatCodes[3]);
    assert.equal(sBkd.state, 'booked');
    assert.equal(sBkd.has_board, false);

    const sBrd = findSeat(seatCodes[4]);
    assert.equal(sBrd.state, 'running');
    assert.equal(sBrd.has_board, true);
    assert.ok(state.cards.expiring_boards.some((b) => b.name === '小板'));

    // B. Privacy scan across entire JSON payload
    const rawJson = JSON.stringify(state);
    assert.equal(rawJson.includes(piiName), false, 'Privacy violation: customer name leaked');
    assert.equal(rawJson.includes('LineNickSecret'), false, 'Privacy violation: LINE display name leaked');
    assert.equal(rawJson.includes(piiPhone), false, 'Privacy violation: phone leaked');
    assert.equal(rawJson.includes('0912***678'), false, 'Privacy violation: masked phone leaked');
    assert.equal(rawJson.includes(piiLineId), false, 'Privacy violation: line_user_id leaked');
    assert.equal(rawJson.includes('BK-R28-'), false, 'Privacy violation: booking_ref leaked');
    assert.equal(rawJson.includes('8888'), false, 'Privacy violation: customer amount_due leaked');
    assert.equal(/09\d{2}[-*\s]?\d{3}[-*\s]?\d{3}/.test(rawJson), false, 'Privacy violation: phone-like string found');
    assert.equal(/"booking_ref"|"phone_masked"|"line_user_id"|"amount_due"|"amount_received"/.test(rawJson), false);

    // C. Heartbeat updates last_seen_at & current_view
    const hbRes = await fetch(`${BASE}/api/display/heartbeat`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${displayToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ current_view: 'timers' })
    });
    assert.equal(hbRes.status, 200);
    const devAfterHb = await prisma.displayDevice.findUnique({ where: { id: dev.id } });
    assert.equal(devAfterHb.current_view, 'timers');
    assert.ok(devAfterHb.last_seen_at);

    // D. SSE Stream: initial state -> check-in push <= 3s -> reload -> logout
    const sse = await openSseClient(`${BASE}/api/display/stream?token=${encodeURIComponent(displayToken)}`);
    try {
      const firstEv = await sse.waitForEvent((e) => e.event === 'state');
      assert.ok(firstEv.data?.server_now);
      assert.equal(firstEv.data.seats.find((s) => s.code === seatCodes[3])?.state, 'booked');

      // Clear initial events, then perform check-in on refBooked -> should push new state within 3s
      sse.events.length = 0;
      const checkInRes = await fetch(`${BASE}/api/floor/${refBooked}/check-in`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ seats: [seatCodes[3]], start_timer: true })
      });
      assert.equal(checkInRes.status, 200);

      const pushedEv = await sse.waitForEvent((e) => e.event === 'state', 3000);
      assert.equal(pushedEv.data.seats.find((s) => s.code === seatCodes[3])?.state, 'running');

      // Admin reload command -> receives reload event
      const relRes = await fetch(`${BASE}/api/display/admin/devices/${dev.id}/reload`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${adminToken}` }
      });
      assert.equal(relRes.status, 200);
      await sse.waitForEvent((e) => e.event === 'reload', 2000);

      // Admin logout -> receives logout event and stream closes
      const loRes = await fetch(`${BASE}/api/display/admin/devices/${dev.id}/logout`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${adminToken}` }
      });
      assert.equal(loRes.status, 200);
      await sse.waitForEvent((e) => e.event === 'logout', 2000);
      await sse.waitForClose(2000);
    } finally {
      sse.close();
    }
  } finally {
    resetDisplayBusForTests();
    clearDisplayLoginFailures();
    await prisma.bookingEquipment.deleteMany({ where: { booking_ref: { in: created.bookingRefs } } });
    await prisma.bookingPerson.deleteMany({ where: { booking_ref: { in: created.bookingRefs } } });
    await prisma.reservation.deleteMany({ where: { booking_ref: { in: created.bookingRefs } } });
    if (created.userId) await prisma.user.deleteMany({ where: { id: created.userId } });
    if (created.deviceId) await prisma.displayDevice.deleteMany({ where: { id: created.deviceId } });
    if (created.staffId) await prisma.adminUser.deleteMany({ where: { id: created.staffId } });
    if (created.layoutId) await prisma.seatLayout.deleteMany({ where: { id: created.layoutId } });
    await srv.close();
  }
});
