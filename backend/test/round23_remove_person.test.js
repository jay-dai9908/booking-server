import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import prisma from '../src/prismaClient.js';
import { removePerson } from '../src/controllers/floorController.js';
import { getBookingBill } from '../src/services/billing/billService.js';
import { dateOnly } from '../../shared/time.js';

function createMockReqRes({ body = {}, params = {}, query = {}, user = { name: '店長', id: 1 } }) {
  const req = {
    body,
    params,
    query,
    user,
    headers: { 'user-agent': 'NodeTestAgent' },
    ip: '127.0.0.1'
  };
  let statusCode = 200;
  let responseData = null;

  const res = {
    status(code) {
      statusCode = code;
      return res;
    },
    json(data) {
      responseData = data;
      return res;
    },
    getStatusCode() {
      return statusCode;
    },
    getResponseData() {
      return responseData;
    }
  };
  return { req, res };
}

test('Round 23 Item 3: removePerson unit tests', async (t) => {
  const prevNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'test';

  const dateStr = '2026-11-22';
  const dbDate = dateOnly(dateStr);
  const createdSessionIds = [];
  const createdUnitGroups = [];

  await prisma.globalSetting.upsert({
    where: { id: 1 },
    update: {},
    create: { id: 1 }
  });

  await prisma.equipmentConfig.upsert({
    where: { id: 'pegboard_s' },
    update: { name: '小板 (52×52)', hourly_rate: 90, total_stock: 10 },
    create: { id: 'pegboard_s', name: '小板 (52×52)', hourly_rate: 90, total_stock: 10 }
  });

  const testUser = await prisma.user.upsert({
    where: { line_user_id: 'test_user_round23_rm' },
    update: { name: '減人測試客' },
    create: { line_user_id: 'test_user_round23_rm', name: '減人測試客', phone: '0922333444' }
  });

  const s14Existing = await prisma.session.findUnique({
    where: { session_date_start_time: { session_date: dbDate, start_time: '14:00' } }
  });
  const s14 = s14Existing || await prisma.session.create({
    data: { session_date: dbDate, start_time: '14:00', end_time: '16:00', max_capacity: 20 }
  });
  if (!s14Existing) createdSessionIds.push(s14.id);

  async function cleanupTestData() {
    const equips = await prisma.bookingEquipment.findMany({
      where: { booking_ref: { startsWith: 'BK-R23RM-' } },
      select: { unit_group: true }
    });
    const allUgs = [...new Set([...createdUnitGroups, ...equips.map(e => e.unit_group).filter(Boolean)])];
    if (allUgs.length) {
      await prisma.boardPause.deleteMany({ where: { unit_group: { in: allUgs } } });
    }
    await prisma.bookingEquipment.deleteMany({ where: { booking_ref: { startsWith: 'BK-R23RM-' } } });
    await prisma.timerPause.deleteMany({ where: { person: { booking_ref: { startsWith: 'BK-R23RM-' } } } });
    await prisma.payment.deleteMany({ where: { booking_ref: { startsWith: 'BK-R23RM-' } } });
    await prisma.bookingPerson.deleteMany({ where: { booking_ref: { startsWith: 'BK-R23RM-' } } });
    await prisma.reservation.deleteMany({ where: { booking_ref: { startsWith: 'BK-R23RM-' } } });
  }

  await cleanupTestData();

  t.after(async () => {
    process.env.NODE_ENV = prevNodeEnv;
    await cleanupTestData();
    if (createdSessionIds.length) {
      await prisma.session.deleteMany({ where: { id: { in: createdSessionIds } } });
    }
    await prisma.user.deleteMany({ where: { line_user_id: 'test_user_round23_rm' } });
  });

  async function seedBooking(suffix, { pax = 2, timerStartAt, seats = ['1-1', '1-2'], withBoardForP1 = false }) {
    const bRef = `BK-R23RM-${suffix}`;
    const startDt = new Date(`${dateStr}T14:00:00+08:00`);
    const endDt = new Date(`${dateStr}T16:00:00+08:00`);

    await prisma.reservation.create({
      data: {
        user_id: testUser.id,
        session_id: s14.id,
        pax,
        booking_ref: bRef,
        status: 'confirmed',
        attendance: 'checked_in',
        assigned_seats: seats
      }
    });

    const p1 = await prisma.bookingPerson.create({
      data: {
        booking_ref: bRef,
        person_no: 1,
        seat_code: seats[0] || null,
        status: 'active',
        billing_start_at: startDt,
        timer_started_at: timerStartAt
      }
    });

    if (pax >= 2) {
      await prisma.bookingPerson.create({
        data: {
          booking_ref: bRef,
          person_no: 2,
          seat_code: seats[1] || null,
          status: 'active',
          billing_start_at: startDt,
          timer_started_at: timerStartAt
        }
      });
    }

    if (withBoardForP1) {
      const ug = crypto.randomUUID();
      createdUnitGroups.push(ug);
      await prisma.bookingEquipment.create({
        data: {
          booking_ref: bRef,
          equipment_id: 'pegboard_s',
          equipment_name_snapshot: '小板 (52×52)',
          quantity: 1,
          rental_hours: 2,
          subtotal_price: 180,
          covered_sessions: [String(s14.id)],
          person_id: p1.id,
          unit_group: ug,
          segment_no: 1,
          start_at: startDt,
          planned_end_at: endDt,
          unit_rate: 90
        }
      });
    }

    return { bRef, p1 };
  }

  await t.test('1. 計時 10 分鐘時移除第 1 位：成功，人數減 1、座位清空、板子不計費且庫存釋出', async () => {
    const startDt = new Date(`${dateStr}T14:00:00+08:00`);
    const { bRef, p1 } = await seedBooking('OK10M', {
      pax: 2,
      timerStartAt: startDt,
      seats: ['1-1', '1-2'],
      withBoardForP1: true
    });

    const { req, res } = createMockReqRes({
      params: { booking_ref: bRef, person_no: '1' },
      body: { now: `${dateStr}T14:10:00+08:00` }
    });
    await removePerson(req, res);

    assert.equal(res.getStatusCode(), 200);
    assert.equal(res.getResponseData().success, true);

    const updatedRes = await prisma.reservation.findFirst({ where: { booking_ref: bRef } });
    assert.equal(updatedRes.pax, 1, 'pax should decrement from 2 to 1');
    assert.deepEqual(updatedRes.assigned_seats, ['1-2'], 'Removed seat 1-1 must be cleared');

    const removedP1 = await prisma.bookingPerson.findUnique({ where: { id: p1.id } });
    assert.equal(removedP1.status, 'removed');
    assert.equal(removedP1.seat_code, null);

    const eqs = await prisma.bookingEquipment.findMany({ where: { booking_ref: bRef } });
    assert.equal(eqs.length, 1);
    assert.equal(eqs[0].person_id, p1.id, 'Board stays on removed person (never transferred)');
    assert.equal(eqs[0].ended_reason, 'person_removed');
    assert.equal(eqs[0].subtotal_price, 0);
    assert.equal(eqs[0].quantity, 0);
    assert.deepEqual(eqs[0].covered_sessions, []);

    const { bill } = await getBookingBill(bRef, prisma, new Date(`${dateStr}T16:00:00+08:00`));
    assert.equal(bill.persons.length, 1);
    assert.equal(bill.persons[0].person_no, 2);
    assert.equal(bill.persons[0].board.amount, 0, 'Remaining person must NOT be charged for removed person board');
  });

  await t.test('2. 計時 20 分鐘時移除：回 422 已計時超過 15 分鐘', async () => {
    const startDt = new Date(`${dateStr}T14:00:00+08:00`);
    const { bRef } = await seedBooking('OVER15M', {
      pax: 2,
      timerStartAt: startDt,
      seats: ['1-3', '1-4']
    });

    const { req, res } = createMockReqRes({
      params: { booking_ref: bRef, person_no: '2' },
      body: { now: `${dateStr}T14:20:00+08:00` }
    });
    await removePerson(req, res);

    assert.equal(res.getStatusCode(), 422);
    assert.equal(res.getResponseData().error, '已計時超過 15 分鐘，請改用離場');
  });

  await t.test('3. 只剩一位時移除：回 422 這組只剩這一位', async () => {
    const startDt = new Date(`${dateStr}T14:00:00+08:00`);
    const { bRef } = await seedBooking('LAST1', {
      pax: 1,
      timerStartAt: startDt,
      seats: ['1-5']
    });

    const { req, res } = createMockReqRes({
      params: { booking_ref: bRef, person_no: '1' },
      body: { now: `${dateStr}T14:05:00+08:00` }
    });
    await removePerson(req, res);

    assert.equal(res.getStatusCode(), 422);
    assert.equal(res.getResponseData().error, '這組只剩這一位，要取消整組請到訂單管理');
  });

  await t.test('4. 已付款時移除：照舊回 400', async () => {
    const startDt = new Date(`${dateStr}T14:00:00+08:00`);
    const { bRef } = await seedBooking('PAID', {
      pax: 2,
      timerStartAt: startDt,
      seats: ['1-6', '1-7']
    });

    await prisma.payment.create({
      data: {
        payment_no: `R-R23RM-${Date.now()}`,
        batch_no: 'B-R23RM-1',
        booking_ref: bRef,
        kind: 'charge',
        status: 'valid',
        method: 'cash',
        amount: 300,
        person_nos: [2],
        staff_name: '店長',
        device_label: 'POS',
        breakdown_json: {}
      }
    });

    const { req, res } = createMockReqRes({
      params: { booking_ref: bRef, person_no: '2' },
      body: { now: `${dateStr}T14:05:00+08:00` }
    });
    await removePerson(req, res);

    assert.equal(res.getStatusCode(), 400);
  });
});
