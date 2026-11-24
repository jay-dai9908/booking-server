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

test('Round 37 Item 1: board unit_rate & daily_cap snapshots, swapped cap, legacy null behavior, and onsite addBoard', async (t) => {
  const runId = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const testDate = dateOnly('2099-07-15');
  const eqId = `r37_i1_eq_${runId}`;
  const createdRefs = [];

  let srv = null;
  let user = null;
  let adminUser = null;
  let createdLayoutId = null;
  let dailySettingCreated = false;
  let globalOrig = null;
  const sessionIds = [];

  t.after(async () => {
    if (srv) await srv.close().catch(() => {});
    if (globalOrig) {
      await prisma.globalSetting.update({
        where: { id: globalOrig.id },
        data: {
          equipment_discount_enabled: globalOrig.equipment_discount_enabled,
          equipment_discount_buy_hours: globalOrig.equipment_discount_buy_hours,
          equipment_discount_free_hours: globalOrig.equipment_discount_free_hours
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
    await prisma.equipmentConfig.deleteMany({ where: { id: eqId } }).catch(() => {});
    if (sessionIds.length > 0) {
      await prisma.session.deleteMany({ where: { id: { in: sessionIds } } }).catch(() => {});
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
  if (globalOrig) {
    await prisma.globalSetting.update({
      where: { id: globalOrig.id },
      data: {
        equipment_discount_enabled: true,
        equipment_discount_buy_hours: 3,
        equipment_discount_free_hours: 1
      }
    });
  }

  user = await prisma.user.create({
    data: {
      line_user_id: `r37_i1_user_${runId}`,
      name: 'R37板子封頂客',
      phone: `09971${String(Date.now()).slice(-5)}` // check-secrets: fake-data
    }
  });
  const customerToken = generateToken({
    id: user.id,
    typ: 'customer',
    role: 'customer',
    isTemp: false
  });

  const adminPass = `r37_i1_adm_${runId}`;
  adminUser = await prisma.adminUser.create({
    data: {
      password: adminPass,
      name: `R37板子店員_${runId}`,
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
    ['17:00', '18:00'],
    ['18:00', '19:00'],
    ['19:00', '20:00'],
    ['20:00', '21:00'],
    ['21:00', '22:00'],
    ['22:00', '23:00'],
    ['23:00', '23:40']
  ];
  const sessions = [];
  for (const [st, et] of slotTimes) {
    const s = await prisma.session.create({
      data: { session_date: testDate, start_time: st, end_time: et, max_capacity: 20 }
    });
    sessions.push(s);
    sessionIds.push(s.id);
  }

  await prisma.equipmentConfig.create({
    data: {
      id: eqId,
      name: `R37測試板_${runId}`,
      hourly_rate: 60,
      daily_cap: 300,
      total_stock: 10,
      visibility_status: 'ACTIVE',
      min_contiguous_hours: 2
    }
  });

  // 1 & 2. Online weekday booking with 6h board (14:00-20:00): rate 60, cap 300.
  // Update config to rate 80, cap 500 BEFORE check-in & swap!
  const first6Ids = sessions.slice(0, 6).map(s => s.id);
  const onlineRes = await fetch(`${srv.baseUrl}/api/reservations`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: `token=${customerToken}`
    },
    body: JSON.stringify({
      session_ids: first6Ids,
      pax: 1,
      equipments: [{ equipment_id: eqId, quantity: 1 }]
    })
  });
  const onlineData = await onlineRes.json();
  assert.equal(onlineRes.status, 201, `online create failed: ${JSON.stringify(onlineData)}`);
  const onlineRef = onlineData.reservation?.booking_ref || onlineData.booking_ref;
  assert.ok(onlineRef);
  createdRefs.push(onlineRef);

  // Change config to rate=80, cap=500 AFTER booking was created
  await prisma.equipmentConfig.update({
    where: { id: eqId },
    data: { hourly_rate: 80, daily_cap: 500 }
  });

  const checkInRes = await fetch(`${srv.baseUrl}/api/floor/${onlineRef}/check-in`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
    body: JSON.stringify({})
  });
  assert.equal(checkInRes.status, 200);

  const afterCheckInEqs = await prisma.bookingEquipment.findMany({ where: { booking_ref: onlineRef } });
  assert.equal(afterCheckInEqs.length, 1);
  assert.equal(afterCheckInEqs[0].unit_rate, 60);
  assert.equal(afterCheckInEqs[0].daily_cap_snapshot, 300);

  const billBeforeSwap = await getBookingBill(onlineRef);
  assert.equal(billBeforeSwap.bill.summary.board_total, 300);

  // Swap after 2h (at 16:00) to same board model (while config is 80/500) -> still capped at 300
  const swapRes = await fetch(`${srv.baseUrl}/api/floor/${onlineRef}/boards/${afterCheckInEqs[0].unit_group}/swap`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
    body: JSON.stringify({
      to_equipment_id: eqId,
      boundary_at: '2099-07-15T16:00:00+08:00',
      now: '2099-07-15T16:05:00+08:00'
    })
  });
  const swapData = await swapRes.json();
  assert.equal(swapRes.status, 200, `swap failed: ${JSON.stringify(swapData)}`);

  // Reset discount off temporarily? Let's verify both with discount (5h*60=300) and by setting unit_rate=100 vs discount off or checking segments
  const swappedEqs = await prisma.bookingEquipment.findMany({
    where: { booking_ref: onlineRef },
    orderBy: { segment_no: 'asc' }
  });
  assert.equal(swappedEqs.length, 2);
  assert.equal(swappedEqs[0].unit_rate, 60);
  assert.equal(swappedEqs[1].unit_rate, 60);
  assert.equal(swappedEqs[1].daily_cap_snapshot, 300);

  // Simulate higher hours on swapped segments without discount to prove cap=300 is actually capping
  await prisma.globalSetting.update({
    where: { id: globalOrig.id },
    data: { equipment_discount_enabled: false }
  });
  const billSwappedNoDiscount = await getBookingBill(onlineRef);
  // 6h * 60 = 360 -> capped at 300!
  assert.equal(billSwappedNoDiscount.bill.summary.board_total, 300);

  // 3. Legacy data: both daily_cap_snapshot=null and swapped -> uncapped (360)
  const legacyRef = `R37-I1-LEG-${runId}`;
  createdRefs.push(legacyRef);
  await prisma.reservation.create({
    data: {
      booking_ref: legacyRef,
      session_id: sessions[0].id,
      user_id: user.id,
      pax: 1,
      status: 'confirmed',
      attendance: 'checked_in',
      checked_in_at: new Date('2099-07-15T14:00:00+08:00'),
      assigned_seats: ['A1-1']
    }
  });
  const legPerson = await prisma.bookingPerson.create({
    data: { booking_ref: legacyRef, person_no: 1, seat_code: 'A1-1', status: 'active' }
  });
  await prisma.bookingEquipment.createMany({
    data: [
      {
        booking_ref: legacyRef,
        person_id: legPerson.id,
        equipment_id: eqId,
        equipment_name_snapshot: 'Legacy',
        unit_group: `leg-ug-${runId}`,
        segment_no: 1,
        quantity: 1,
        rental_hours: 6,
        unit_rate: 60,
        daily_cap_snapshot: null,
        is_price_fixed: true,
        start_at: new Date('2099-07-15T14:00:00+08:00'),
        end_at: new Date('2099-07-15T16:00:00+08:00'),
        ended_reason: 'swapped',
        subtotal_price: 0,
        covered_sessions: ['14:00-15:00', '15:00-16:00']
      },
      {
        booking_ref: legacyRef,
        person_id: legPerson.id,
        equipment_id: eqId,
        equipment_name_snapshot: 'Legacy',
        unit_group: `leg-ug-${runId}`,
        segment_no: 2,
        quantity: 1,
        rental_hours: 6,
        unit_rate: 60,
        daily_cap_snapshot: null,
        is_price_fixed: true,
        start_at: new Date('2099-07-15T16:00:00+08:00'),
        planned_end_at: new Date('2099-07-15T20:00:00+08:00'),
        subtotal_price: 0,
        covered_sessions: ['16:00-17:00', '17:00-18:00', '18:00-19:00', '19:00-20:00']
      }
    ]
  });
  const billLegacy = await getBookingBill(legacyRef);
  assert.equal(billLegacy.bill.summary.board_total, 360);

  // Restore discount enabled & config rate=60, cap=300 for onsite addBoard test
  await prisma.globalSetting.update({
    where: { id: globalOrig.id },
    data: {
      equipment_discount_enabled: true,
      equipment_discount_buy_hours: 3,
      equipment_discount_free_hours: 1
    }
  });
  await prisma.equipmentConfig.update({
    where: { id: eqId },
    data: { hourly_rate: 60, daily_cap: 300 }
  });

  // 4 & 5. Onsite addBoard at 19:40 -> 23:40 (4h, rate 60, buy-3-get-1 => 180) and omit from_at with now=19:40
  const onsiteRef = `R37-I1-ADD-${runId}`;
  createdRefs.push(onsiteRef);
  for (const sess of sessions.slice(5)) {
    await prisma.reservation.create({
      data: {
        booking_ref: onsiteRef,
        session_id: sess.id,
        user_id: user.id,
        pax: 1,
        status: 'confirmed',
        attendance: 'checked_in',
        checked_in_at: new Date('2099-07-15T19:00:00+08:00'),
        assigned_seats: ['A2-1']
      }
    });
  }
  await prisma.bookingPerson.create({
    data: { booking_ref: onsiteRef, person_no: 1, seat_code: 'A2-1', status: 'active' }
  });

  const addRes = await fetch(`${srv.baseUrl}/api/floor/${onsiteRef}/boards`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
    body: JSON.stringify({
      person_no: 1,
      equipment_id: eqId,
      to_at: '2099-07-15T23:40:00+08:00',
      now: '2099-07-15T19:40:00+08:00'
    })
  });
  const addData = await addRes.json();
  assert.equal(addRes.status, 200, `addBoard failed: ${JSON.stringify(addData)}`);
  assert.equal(addData.booking_equipment.is_price_fixed, false);
  assert.equal(new Date(addData.booking_equipment.start_at).toISOString(), new Date('2099-07-15T19:40:00+08:00').toISOString());

  const billOnsite = await getBookingBill(onsiteRef);
  assert.equal(billOnsite.bill.summary.board_total, 180);
});
