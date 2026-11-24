import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import express from 'express';
import cookieParser from 'cookie-parser';
import prisma from '../src/prismaClient.js';
import authRoutes from '../src/routes/auth.js';
import reservationRoutes from '../src/routes/reservations.js';
import floorRoutes from '../src/routes/floor.js';
import { generateToken } from '../src/middlewares/authMiddleware.js';
import { getBookingBill } from '../src/services/billing/billService.js';
import { ensureTestPublishedLayout, cleanupTestPublishedLayout } from './helpers/seedTestLayout.js';
import { dateOnly } from '../../shared/time.js';

function startLocalApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/auth', authRoutes);
  app.use('/api/reservations', reservationRoutes);
  app.use('/api/floor', floorRoutes);
  const server = http.createServer(app);
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', (err) => {
      if (err) return reject(err);
      resolve({
        baseUrl: `http://127.0.0.1:${server.address().port}`,
        close: () => new Promise((r) => server.close(r))
      });
    });
  });
}

test('Round 37 Item 3: returnBoard bills until actual return time, validates boundaries, preview rolls back cleanly, and legacy returned stays on planned_end_at', async (t) => {
  const runId = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const testDate = dateOnly('2099-09-10');
  const eqSmallId = `r37_i3_sm_${runId}`;
  const eqLargeId = `r37_i3_lg_${runId}`;
  const createdRefs = [];
  const createdSessionIds = [];

  let srv = null;
  let user = null;
  let adminUser = null;
  let createdLayoutId = null;
  let dailySettingCreated = false;
  let globalOrig = null;

  t.after(async () => {
    if (srv) await srv.close().catch(() => {});
    if (globalOrig) {
      await prisma.globalSetting.update({
        where: { id: globalOrig.id },
        data: {
          equipment_discount_enabled: globalOrig.equipment_discount_enabled,
          equipment_discount_buy_hours: globalOrig.equipment_discount_buy_hours,
          equipment_discount_free_hours: globalOrig.equipment_discount_free_hours,
          board_swap_grace_minutes: globalOrig.board_swap_grace_minutes
        }
      }).catch(() => {});
    }
    if (createdRefs.length > 0) {
      const eqs = await prisma.bookingEquipment.findMany({
        where: { booking_ref: { in: createdRefs } },
        select: { unit_group: true }
      }).catch(() => []);
      const ugs = eqs.map(e => e.unit_group).filter(Boolean);
      if (ugs.length > 0) {
        await prisma.boardPause.deleteMany({ where: { unit_group: { in: ugs } } }).catch(() => {});
      }
      await prisma.bookingEquipment.deleteMany({ where: { booking_ref: { in: createdRefs } } }).catch(() => {});
      await prisma.bookingPerson.deleteMany({ where: { booking_ref: { in: createdRefs } } }).catch(() => {});
      await prisma.reservation.deleteMany({ where: { booking_ref: { in: createdRefs } } }).catch(() => {});
    }
    await prisma.equipmentConfig.deleteMany({ where: { id: { in: [eqSmallId, eqLargeId] } } }).catch(() => {});
    if (createdSessionIds.length > 0) {
      await prisma.session.deleteMany({ where: { id: { in: createdSessionIds } } }).catch(() => {});
    }
    if (dailySettingCreated) {
      await prisma.dailySetting.delete({ where: { date: testDate } }).catch(() => {});
    }
    if (user?.id) await prisma.user.delete({ where: { id: user.id } }).catch(() => {});
    if (adminUser?.id) await prisma.adminUser.delete({ where: { id: adminUser.id } }).catch(() => {});
    await cleanupTestPublishedLayout(prisma, createdLayoutId);
  });

  createdLayoutId = await ensureTestPublishedLayout(prisma);
  srv = await startLocalApp();

  globalOrig = await prisma.globalSetting.findFirst();
  await prisma.globalSetting.update({
    where: { id: globalOrig.id },
    data: {
      equipment_discount_enabled: true,
      equipment_discount_buy_hours: 3,
      equipment_discount_free_hours: 1,
      board_swap_grace_minutes: 10
    }
  });

  user = await prisma.user.create({
    data: {
      line_user_id: `r37_i3_user_${runId}`,
      name: 'R37歸還板子客',
      phone: `09973${String(Date.now()).slice(-5)}` // check-secrets: fake-data
    }
  });
  const customerToken = generateToken({
    id: user.id,
    typ: 'customer',
    role: 'customer',
    isTemp: false
  });

  const adminPass = `r37_i3_adm_${runId}`;
  adminUser = await prisma.adminUser.create({
    data: {
      password: adminPass,
      name: `R37歸還店員_${runId}`,
      role: 'superadmin',
      permissions: ['all'],
      is_active: true
    }
  });
  const loginRes = await fetch(`${srv.baseUrl}/api/auth/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: adminPass })
  });
  assert.equal(loginRes.status, 200);
  const adminCookie = loginRes.headers.get('set-cookie').split(';')[0];

  const existingDaily = await prisma.dailySetting.findUnique({ where: { date: testDate } });
  if (!existingDaily) {
    await prisma.dailySetting.create({
      data: { date: testDate, hourly_price: 150, unlimited_price: 750, allow_unlimited: true, is_self_service: false }
    });
    dailySettingCreated = true;
  }

  const slotTimes = [
    ['14:00', '15:00'],
    ['15:00', '16:00'],
    ['16:00', '17:00'],
    ['17:00', '18:00']
  ];
  const sessions = [];
  for (const [st, et] of slotTimes) {
    const s = await prisma.session.create({
      data: { session_date: testDate, start_time: st, end_time: et, max_capacity: 20 }
    });
    sessions.push(s);
    createdSessionIds.push(s.id);
  }

  await prisma.equipmentConfig.createMany({
    data: [
      { id: eqSmallId, name: `R37小板_${runId}`, hourly_rate: 60, total_stock: 10, visibility_status: 'ACTIVE', min_contiguous_hours: 2 },
      { id: eqLargeId, name: `R37大板_${runId}`, hourly_rate: 120, total_stock: 10, visibility_status: 'ACTIVE', min_contiguous_hours: 2 }
    ]
  });

  // 1. Onsite addBoard 14:00-18:00, preview return at 16:00, verify rollback, then actually return at 16:00 -> 120
  const onsiteRef = `R37-I3-ON-${runId}`;
  createdRefs.push(onsiteRef);
  for (const sess of sessions) {
    await prisma.reservation.create({
      data: {
        booking_ref: onsiteRef,
        session_id: sess.id,
        user_id: user.id,
        pax: 1,
        status: 'confirmed',
        attendance: 'checked_in',
        checked_in_at: new Date('2099-09-10T14:00:00+08:00'),
        assigned_seats: ['A1-1']
      }
    });
  }
  await prisma.bookingPerson.create({
    data: {
      booking_ref: onsiteRef,
      person_no: 1,
      seat_code: 'A1-1',
      status: 'active',
      timer_started_at: new Date('2099-09-10T14:00:00+08:00'),
      timer_ended_at: new Date('2099-09-10T18:00:00+08:00')
    }
  });

  const addRes = await fetch(`${srv.baseUrl}/api/floor/${onsiteRef}/boards`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
    body: JSON.stringify({
      person_no: 1,
      equipment_id: eqSmallId,
      from_at: '14:00',
      to_at: '18:00'
    })
  });
  const addData = await addRes.json();
  assert.equal(addRes.status, 200);
  const onsiteUg = addData.booking_equipment.unit_group;

  // Reject invalid return time 16:07 -> 422
  const badRetRes = await fetch(`${srv.baseUrl}/api/floor/${onsiteRef}/boards/${onsiteUg}/return`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
    body: JSON.stringify({
      at: '2099-09-10T16:07:00+08:00',
      now: '2099-09-10T16:07:00+08:00'
    })
  });
  assert.equal(badRetRes.status, 422);

  // Preview swap + preview return must NOT mutate DB segments, pauses, or AccountingEvent count
  const segCountBefore = await prisma.bookingEquipment.count({ where: { booking_ref: onsiteRef } });
  const pauseCountBefore = await prisma.boardPause.count({ where: { unit_group: onsiteUg } });
  const eventCountBefore = await prisma.accountingEvent.count({ where: { booking_ref: onsiteRef } });

  const prevSwapRes = await fetch(`${srv.baseUrl}/api/floor/${onsiteRef}/boards/${onsiteUg}/preview`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
    body: JSON.stringify({
      action: 'swap',
      to_equipment_id: eqLargeId,
      at: '2099-09-10T16:00:00+08:00',
      now: '2099-09-10T16:05:00+08:00'
    })
  });
  const prevSwapData = await prevSwapRes.json();
  assert.equal(prevSwapRes.status, 200);
  // 2h small (120) + 2h large (240) - 1h * 60 = 300
  assert.equal(prevSwapData.board_amount_before, 180);
  assert.equal(prevSwapData.board_amount_after, 300);

  const prevRetRes = await fetch(`${srv.baseUrl}/api/floor/${onsiteRef}/boards/${onsiteUg}/preview`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
    body: JSON.stringify({
      action: 'return',
      at: '2099-09-10T16:00:00+08:00',
      now: '2099-09-10T16:05:00+08:00'
    })
  });
  const prevRetData = await prevRetRes.json();
  assert.equal(prevRetRes.status, 200);
  assert.equal(prevRetData.board_amount_after, 120);

  assert.equal(await prisma.bookingEquipment.count({ where: { booking_ref: onsiteRef } }), segCountBefore);
  assert.equal(await prisma.boardPause.count({ where: { unit_group: onsiteUg } }), pauseCountBefore);
  assert.equal(await prisma.accountingEvent.count({ where: { booking_ref: onsiteRef } }), eventCountBefore);

  // Confirm return at 16:00 -> board is 120 (matches preview), entry remains 4 * 150 = 600
  const retRes = await fetch(`${srv.baseUrl}/api/floor/${onsiteRef}/boards/${onsiteUg}/return`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
    body: JSON.stringify({
      at: '2099-09-10T16:00:00+08:00',
      now: '2099-09-10T16:05:00+08:00'
    })
  });
  const retData = await retRes.json();
  assert.equal(retRes.status, 200);
  assert.equal(retData.bill.summary.board_total, prevRetData.board_amount_after);
  assert.equal(retData.bill.summary.board_total, 120);
  assert.equal(retData.bill.persons[0].entry.amount, 600);

  // 2. Online booking 14:00-18:00 with board -> return at 16:00 -> 120 (identical to onsite)
  const onlineRes = await fetch(`${srv.baseUrl}/api/reservations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: `token=${customerToken}` },
    body: JSON.stringify({
      session_ids: sessions.map(s => s.id),
      pax: 1,
      equipments: [{ equipment_id: eqSmallId, quantity: 1 }]
    })
  });
  const onlineData = await onlineRes.json();
  assert.equal(onlineRes.status, 201);
  const onlineRef = onlineData.reservation.booking_ref;
  createdRefs.push(onlineRef);

  await fetch(`${srv.baseUrl}/api/floor/${onlineRef}/check-in`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
    body: JSON.stringify({})
  });
  const onlineEqs = await prisma.bookingEquipment.findMany({ where: { booking_ref: onlineRef } });
  const onlineUg = onlineEqs[0].unit_group;

  // Omit `at` with test `now = 16:12` -> suggested 16:30 -> board 2.5h * 60 = 150
  const autoRetRes = await fetch(`${srv.baseUrl}/api/floor/${onlineRef}/boards/${onlineUg}/return`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
    body: JSON.stringify({
      now: '2099-09-10T16:12:00+08:00'
    })
  });
  const autoRetData = await autoRetRes.json();
  assert.equal(autoRetRes.status, 200);
  assert.equal(autoRetData.bill.summary.board_total, 150);
  const updatedOnlineSeg = await prisma.bookingEquipment.findFirst({ where: { booking_ref: onlineRef } });
  assert.equal(new Date(updatedOnlineSeg.end_at).toISOString(), new Date('2099-09-10T16:30:00+08:00').toISOString());
  assert.equal(updatedOnlineSeg.bill_until_return, true);

  // 3. Legacy returned segment (bill_until_return: false with planned_end_at: 18:00) still bills to 18:00 -> 180
  const legacyRef = `R37-I3-LEG-${runId}`;
  createdRefs.push(legacyRef);
  await prisma.reservation.create({
    data: {
      booking_ref: legacyRef,
      session_id: sessions[0].id,
      user_id: user.id,
      pax: 1,
      status: 'confirmed',
      attendance: 'checked_in',
      checked_in_at: new Date('2099-09-10T14:00:00+08:00'),
      assigned_seats: ['A3-1']
    }
  });
  const legP = await prisma.bookingPerson.create({
    data: { booking_ref: legacyRef, person_no: 1, seat_code: 'A3-1', status: 'active' }
  });
  await prisma.bookingEquipment.create({
    data: {
      booking_ref: legacyRef,
      person_id: legP.id,
      equipment_id: eqSmallId,
      equipment_name_snapshot: 'LegacyBoard',
      unit_group: `leg-ret-${runId}`,
      segment_no: 1,
      quantity: 1,
      rental_hours: 4,
      unit_rate: 60,
      subtotal_price: 180,
      start_at: new Date('2099-09-10T14:00:00+08:00'),
      end_at: new Date('2099-09-10T16:00:00+08:00'),
      planned_end_at: new Date('2099-09-10T18:00:00+08:00'),
      ended_reason: 'returned',
      bill_until_return: false,
      covered_sessions: ['14:00-15:00', '15:00-16:00']
    }
  });
  const legBill = await getBookingBill(legacyRef);
  assert.equal(legBill.bill.summary.board_total, 180);
});
