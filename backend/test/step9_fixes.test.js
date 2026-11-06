import test from 'node:test';
import assert from 'node:assert/strict';
import prisma from '../src/prismaClient.js';
import { checkIn, moveSeat, addPerson, swapBoard } from '../src/controllers/floorController.js';
import { getLiveFloorData } from '../src/services/floor/liveService.js';
import { buildBillInput } from '../src/services/billing/billInput.js';
import { computeBill } from '../../shared/billing.js';
import { buildReceipt } from '../../shared/receipts.js';
import { dateOnly } from '../../shared/time.js';
import { getActiveLayoutForDate } from '../src/services/seating/layoutService.js';

function createMockReqRes({ body = {}, params = {}, query = {}, user = { name: '店長', id: 1 } }) {
  const req = { body, params, query, user, headers: {} };
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

test('Step 9 Fixes Verification Suite', async (t) => {
  const testDate = dateOnly('2026-11-25');

  const user = await prisma.user.upsert({
    where: { line_user_id: 'test_step9_user' },
    update: { name: '測試客' },
    create: { line_user_id: 'test_step9_user', name: '測試客', phone: '0922000000' }
  });

  const session1 = await prisma.session.upsert({
    where: { session_date_start_time: { session_date: testDate, start_time: '14:00' } },
    update: { end_time: '15:00', max_capacity: 16 },
    create: { session_date: testDate, start_time: '14:00', end_time: '15:00', max_capacity: 16 }
  });

  const session2 = await prisma.session.upsert({
    where: { session_date_start_time: { session_date: testDate, start_time: '15:00' } },
    update: { end_time: '16:00', max_capacity: 16 },
    create: { session_date: testDate, start_time: '15:00', end_time: '16:00', max_capacity: 16 }
  });

  // Suite setup cleanup
  await prisma.bookingEquipment.deleteMany({ where: { booking_ref: { startsWith: 'BK-TEST-' } } });
  await prisma.bookingPerson.deleteMany({ where: { booking_ref: { startsWith: 'BK-TEST-' } } });
  await prisma.reservation.deleteMany({ where: { session_id: { in: [session1.id, session2.id] } } });

  await t.test('Bug 1: buildBillInput preserves fixed_total: 0 for 0-dollar smart board', () => {
    const input = buildBillInput({
      bookingRef: 'BK-TEST-FREE-BOARD',
      reservations: [{
        pax: 1,
        session: { session_date: testDate, start_time: '14:00', end_time: '16:00' }
      }],
      bookingEquipments: [{
        id: 999,
        unit_group: 'u-free',
        equipment_id: 'bring_own',
        subtotal_price: 0,
        rental_hours: 2,
        segment_no: 1,
        ended_reason: null
      }],
      globalSetting: {},
      pricing: { hourly_price: 150, unlimited_price: 750 }
    });

    const board = input.boards.find(b => b.unit_group === 'u-free');
    assert.equal(board.fixed_total, 0, 'fixed_total must be 0, not undefined');
    const bill = computeBill(input);
    assert.equal(bill.summary.board_total, 0, 'Board total should be 0');
  });

  await t.test('Bug 2: Split payment receipt status line shows 整單已結清 when all persons paid', () => {
    const payment2 = {
      payment_no: 'R-0002',
      booking_ref: 'BK-TEST-SPLIT',
      created_at: new Date().toISOString(),
      staff_name: '店長',
      amount: 450,
      method: 'cash',
      person_nos: [2],
      breakdown_json: {
        persons: [{
          label: '第 2 位',
          person_no: 2,
          seat_code: '1-2',
          entry: { hours: 3, amount: 450 }
        }],
        order: {
          persons_total: 2,
          persons_paid_after: 2
        }
      }
    };

    const booking = {
      booking_ref: 'BK-TEST-SPLIT',
      pax: 2,
      paid_persons: 2,
      start_time: '14:00',
      end_time: '17:00',
      session_date: '2026-11-25'
    };

    const commands = buildReceipt(payment2, booking, { isFullOrder: false });
    const statusLine = commands.find(c => c.text?.includes('已結清') || c.text?.includes('整單'));
    assert.ok(statusLine, 'Status line must be present');
    assert.ok(statusLine.text.includes('已結清 2/2'), `Expected '已結清 2/2', got: ${statusLine.text}`);
  });

  await t.test('Bug 3: addPerson with duplicate seat in same booking is rejected with 400', async () => {
    const bRef = 'BK-TEST-ADD-DUP';
    await prisma.bookingPerson.deleteMany({ where: { booking_ref: bRef } });
    await prisma.reservation.deleteMany({ where: { booking_ref: bRef } });

    await prisma.reservation.create({
      data: {
        booking_ref: bRef,
        user_id: user.id,
        session_id: session1.id,
        pax: 1,
        status: 'confirmed',
        attendance: 'checked_in',
        is_seat_locked: true,
        seat_source: 'staff',
        assigned_seats: ['A1-1'],
        total_amount: 150
      }
    });

    const { req, res } = createMockReqRes({
      params: { booking_ref: bRef },
      body: { seat_code: 'A1-1' }
    });

    await addPerson(req, res);
    assert.equal(res.getStatusCode(), 400, 'Expected 400 for duplicate seat within reservation');
    await prisma.bookingPerson.deleteMany({ where: { booking_ref: bRef } });
    await prisma.reservation.deleteMany({ where: { booking_ref: bRef } });
  });

  await t.test('Bug 4: moveSeat within same booking in non-swap mode to already assigned seat is rejected with 400', async () => {
    const bRef = 'BK-TEST-MOVE-DUP';
    await prisma.bookingPerson.deleteMany({ where: { booking_ref: bRef } });
    await prisma.reservation.deleteMany({ where: { booking_ref: bRef } });

    await prisma.reservation.create({
      data: {
        booking_ref: bRef,
        user_id: user.id,
        session_id: session1.id,
        pax: 2,
        status: 'confirmed',
        attendance: 'checked_in',
        is_seat_locked: true,
        seat_source: 'staff',
        assigned_seats: ['A1-1', 'A1-2'],
        total_amount: 300
      }
    });

    const { req, res } = createMockReqRes({
      params: { booking_ref: bRef },
      body: { from_seat: 'A1-1', to_seat: 'A1-2', mode: 'move' }
    });

    await moveSeat(req, res);
    assert.equal(res.getStatusCode(), 400, 'Expected 400 for internal duplicate seat move');
    await prisma.bookingPerson.deleteMany({ where: { booking_ref: bRef } });
    await prisma.reservation.deleteMany({ where: { booking_ref: bRef } });
  });

  await t.test('Bug 5: moveSeat across multiple sessions reseats all conflicting bookings', async () => {
    const bMain = 'BK-TEST-MULTI-MAIN';
    const bConf1 = 'BK-TEST-MULTI-CONF1';
    const bConf2 = 'BK-TEST-MULTI-CONF2';

    await prisma.bookingPerson.deleteMany({ where: { booking_ref: { in: [bMain, bConf1, bConf2] } } });
    await prisma.reservation.deleteMany({ where: { session_id: { in: [session1.id, session2.id] } } });

    // Main booking has 2 sessions on A1-1
    await prisma.reservation.create({
      data: {
        booking_ref: bMain,
        user_id: user.id,
        session_id: session1.id,
        pax: 1,
        status: 'confirmed',
        attendance: 'checked_in',
        is_seat_locked: true,
        seat_source: 'staff',
        assigned_seats: ['A1-1'],
        total_amount: 300
      }
    });
    await prisma.reservation.create({
      data: {
        booking_ref: bMain,
        user_id: user.id,
        session_id: session2.id,
        pax: 1,
        status: 'confirmed',
        attendance: 'confirmed',
        is_seat_locked: false,
        seat_source: 'staff',
        assigned_seats: ['A1-1'],
        total_amount: 300
      }
    });

    // Conf1 occupies B1-1 in session 1
    await prisma.reservation.create({
      data: {
        booking_ref: bConf1,
        user_id: user.id,
        session_id: session1.id,
        pax: 1,
        status: 'confirmed',
        attendance: 'confirmed',
        is_seat_locked: false,
        seat_source: 'auto',
        assigned_seats: ['B1-1'],
        total_amount: 150
      }
    });

    // Conf2 occupies B1-1 in session 2
    await prisma.reservation.create({
      data: {
        booking_ref: bConf2,
        user_id: user.id,
        session_id: session2.id,
        pax: 1,
        status: 'confirmed',
        attendance: 'confirmed',
        is_seat_locked: false,
        seat_source: 'auto',
        assigned_seats: ['B1-1'],
        total_amount: 150
      }
    });

    // Main moves from A1-1 to B1-1
    const { req, res } = createMockReqRes({
      params: { booking_ref: bMain },
      body: { from_seat: 'A1-1', to_seat: 'B1-1', mode: 'move' }
    });

    await moveSeat(req, res);
    assert.equal(res.getStatusCode(), 200);

    // Verify collisions
    const collisions = await prisma.$queryRawUnsafe(`
      select session_id, seat, count(distinct booking_ref)::int as count
      from "Reservation", unnest(assigned_seats) seat
      where status <> 'cancelled' and seat not like 'WAIT-%'
      and session_id in (${session1.id}, ${session2.id})
      group by 1, 2 having count(distinct booking_ref) > 1;
    `);
    assert.equal(collisions.length, 0, `Collisions found: ${JSON.stringify(collisions)}`);
  });

  await t.test('Bug 6: moveSeat internal swap between seats of same booking', async () => {
    const bRef = 'BK-TEST-INTERNAL-SWAP';
    await prisma.bookingPerson.deleteMany({ where: { booking_ref: bRef } });
    await prisma.reservation.deleteMany({ where: { booking_ref: bRef } });

    await prisma.reservation.create({
      data: {
        booking_ref: bRef,
        user_id: user.id,
        session_id: session1.id,
        pax: 2,
        status: 'confirmed',
        attendance: 'checked_in',
        is_seat_locked: true,
        seat_source: 'staff',
        assigned_seats: ['A1-1', 'A1-2'],
        total_amount: 300
      }
    });

    await prisma.bookingPerson.createMany({
      data: [
        { booking_ref: bRef, person_no: 1, seat_code: 'A1-1', status: 'active' },
        { booking_ref: bRef, person_no: 2, seat_code: 'A1-2', status: 'active' }
      ]
    });

    const { req, res } = createMockReqRes({
      params: { booking_ref: bRef },
      body: { from_seat: 'A1-1', to_seat: 'A1-2', mode: 'swap' }
    });

    await moveSeat(req, res);
    assert.equal(res.getStatusCode(), 200);

    const r = await prisma.reservation.findFirst({ where: { booking_ref: bRef } });
    assert.deepEqual(r.assigned_seats, ['A1-2', 'A1-1']);

    const p1 = await prisma.bookingPerson.findFirst({ where: { booking_ref: bRef, person_no: 1 } });
    const p2 = await prisma.bookingPerson.findFirst({ where: { booking_ref: bRef, person_no: 2 } });
    assert.equal(p1.seat_code, 'A1-2');
    assert.equal(p2.seat_code, 'A1-1');
  });

  await t.test('Bug 7: swapBoard new segment has end_at: null and counts in_use', async () => {
    const bRef = 'BK-TEST-SWAP-INUSE';
    await prisma.bookingEquipment.deleteMany({ where: { booking_ref: bRef } });
    await prisma.bookingPerson.deleteMany({ where: { booking_ref: bRef } });
    await prisma.reservation.deleteMany({ where: { booking_ref: bRef } });

    const sStartDt = new Date('2026-11-25T14:00:00+08:00');
    const sEndDt = new Date('2026-11-25T16:00:00+08:00');

    await prisma.reservation.create({
      data: {
        booking_ref: bRef,
        user_id: user.id,
        session_id: session1.id,
        pax: 1,
        status: 'confirmed',
        attendance: 'checked_in',
        is_seat_locked: true,
        seat_source: 'staff',
        assigned_seats: ['A1-1'],
        total_amount: 300
      }
    });

    await prisma.bookingPerson.create({
      data: { booking_ref: bRef, person_no: 1, seat_code: 'A1-1', status: 'active' }
    });

    const uGroup = 'u-swap-inuse';
    await prisma.bookingEquipment.create({
      data: {
        booking_ref: bRef,
        equipment_id: 'pegboard_s',
        equipment_name_snapshot: '小智能板 50x50',
        quantity: 1,
        rental_hours: 2,
        subtotal_price: 150,
        covered_sessions: [String(session1.id), String(session2.id)],
        unit_group: uGroup,
        segment_no: 1,
        start_at: sStartDt,
        planned_end_at: sEndDt,
        unit_rate: 80
      }
    });

    const { req, res } = createMockReqRes({
      params: { booking_ref: bRef },
      body: {
        unit_group: uGroup,
        to_equipment_id: 'pegboard_m',
        boundary_at: '2026-11-25T14:30:00+08:00',
        now: '2026-11-25T14:40:00+08:00'
      }
    });

    await swapBoard(req, res);
    assert.equal(res.getStatusCode(), 200);

    const segs = await prisma.bookingEquipment.findMany({
      where: { booking_ref: bRef, unit_group: uGroup },
      orderBy: { segment_no: 'asc' }
    });
    assert.equal(segs.length, 2);
    const newSeg = segs[1];
    assert.equal(newSeg.end_at, null, 'Active segment end_at must be null while in-use');
    assert.equal(newSeg.ended_reason, null);

    const liveData = await getLiveFloorData('2026-11-25');
    const medUsage = liveData.board_usage.find(bu => bu.equipment_id === 'pegboard_m');
    assert.ok(medUsage, 'pegboard_m usage must exist');
    assert.ok(medUsage.in_use >= 1, `Expected pegboard_m in_use >= 1, got ${medUsage.in_use}`);
  });

  await t.test('Bug 8: Paid reservation cannot be cancelled by admin (returns 409)', async () => {
    const { cancelReservation } = await import('../src/controllers/reservationController.js');
    const bRef = 'BK-TEST-CANCEL-PAID';
    await prisma.reservation.deleteMany({ where: { booking_ref: bRef } });

    await prisma.reservation.create({
      data: {
        booking_ref: bRef,
        user_id: user.id,
        session_id: session1.id,
        pax: 1,
        status: 'confirmed',
        attendance: 'checked_in',
        is_paid: true,
        amount_due: 150,
        amount_received: 150,
        assigned_seats: ['A1-1'],
        total_amount: 150
      }
    });

    const { req, res } = createMockReqRes({
      params: { id: bRef },
      user: { id: 1, role: 'admin', isSuperAdmin: true, permissions: ['all'] }
    });

    await cancelReservation(req, res);
    assert.equal(res.getStatusCode(), 409, 'Expected 409 when cancelling paid reservation');
  });

  await t.test('Bug 9: getActiveLayoutForDate with dateOnly avoids UTC day-early skew', async () => {
    const layout = await getActiveLayoutForDate(prisma, '2026-11-25');
    assert.ok(layout, 'Layout must be found');
    assert.ok(layout.seats && layout.seats.length > 0, 'Layout must have seats');
  });

  // Teardown cleanup
  await prisma.bookingEquipment.deleteMany({ where: { booking_ref: { startsWith: 'BK-TEST-' } } });
  await prisma.bookingPerson.deleteMany({ where: { booking_ref: { startsWith: 'BK-TEST-' } } });
  await prisma.reservation.deleteMany({ where: { booking_ref: { startsWith: 'BK-TEST-' } } });
  await prisma.reservation.deleteMany({ where: { session_id: { in: [session1.id, session2.id] } } });
});

