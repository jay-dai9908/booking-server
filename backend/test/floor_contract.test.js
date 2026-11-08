import test from 'node:test';
import assert from 'node:assert/strict';
import prisma from '../src/prismaClient.js';
import { handleTimer, moveSeat, checkIn } from '../src/controllers/floorController.js';
import { getLiveFloorData } from '../src/services/floor/liveService.js';
import { dateOnly } from '../../shared/time.js';

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

test('Floor Contract Tests (Section 3.1 & 3.2)', async (t) => {
  const testDateStr = '2026-11-20';
  const testDate = dateOnly(testDateStr);

  // Setup user and session
  const user = await prisma.user.upsert({
    where: { line_user_id: 'test_floor_contract_user' },
    update: { name: '契約測試客' },
    create: { line_user_id: 'test_floor_contract_user', name: '契約測試客', phone: '0988000111' }
  });

  const session = await prisma.session.upsert({
    where: {
      session_date_start_time: {
        session_date: testDate,
        start_time: '14:00'
      }
    },
    update: { end_time: '15:00', max_capacity: 20 },
    create: {
      session_date: testDate,
      start_time: '14:00',
      end_time: '15:00',
      max_capacity: 20
    }
  });

  const bookingRef = 'BK-TEST-CONTRACT-01';

  // Cleanup old test data
  await prisma.timerPause.deleteMany({ where: { person: { booking_ref: bookingRef } } });
  await prisma.bookingPerson.deleteMany({ where: { booking_ref: bookingRef } });
  await prisma.reservation.deleteMany({ where: { booking_ref: bookingRef } });

  // Create 2-person reservation
  await prisma.reservation.create({
    data: {
      booking_ref: bookingRef,
      session_id: session.id,
      user_id: user.id,
      pax: 2,
      assigned_seats: ['A1-1', 'A1-2'],
      attendance: 'checked_in',
      checked_in_at: new Date()
    }
  });

  // Verify getLiveFloorData detects needs_seating when no persons exist
  const liveDataBeforePersons = await getLiveFloorData(testDateStr);
  const foundBookingBefore = liveDataBeforePersons.bookings.find(b => b.booking_ref === bookingRef);
  assert.ok(foundBookingBefore, 'Booking should be returned in live floor data');
  assert.strictEqual(foundBookingBefore.needs_seating, true, 'needs_seating must be true when checked in without persons');

  // Now create 2 BookingPersons
  const now = new Date();
  const p1 = await prisma.bookingPerson.create({
    data: {
      booking_ref: bookingRef,
      person_no: 1,
      seat_code: 'A1-1',
      status: 'active',
      timer_started_at: now,
      billing_start_at: now
    }
  });

  const p2 = await prisma.bookingPerson.create({
    data: {
      booking_ref: bookingRef,
      person_no: 2,
      seat_code: 'A1-2',
      status: 'active',
      timer_started_at: now,
      billing_start_at: now
    }
  });

  // Verify getLiveFloorData sets needs_seating: false now
  const liveDataAfterPersons = await getLiveFloorData(testDateStr);
  const foundBookingAfter = liveDataAfterPersons.bookings.find(b => b.booking_ref === bookingRef);
  assert.strictEqual(foundBookingAfter.needs_seating, false, 'needs_seating must be false once persons are seated');
  assert.strictEqual(foundBookingAfter.persons.length, 2, 'Should have 2 persons');

  await t.test('1. Pause person 1 only: person 2 must NOT be paused', async () => {
    const { req, res } = createMockReqRes({
      params: { booking_ref: bookingRef },
      body: { action: 'pause', person_nos: [1], reason: '外出用餐' }
    });

    await handleTimer(req, res);
    assert.strictEqual(res.getStatusCode(), 200);

    const updatedP1 = await prisma.bookingPerson.findUnique({ where: { id: p1.id } });
    const updatedP2 = await prisma.bookingPerson.findUnique({ where: { id: p2.id } });

    assert.ok(updatedP1.paused_at != null, 'Person 1 must have paused_at set');
    assert.strictEqual(updatedP2.paused_at, null, 'Person 2 must NOT be paused');
  });

  await t.test('2. Resume person 1', async () => {
    const { req, res } = createMockReqRes({
      params: { booking_ref: bookingRef },
      body: { action: 'resume', person_nos: [1] }
    });

    await handleTimer(req, res);
    assert.strictEqual(res.getStatusCode(), 200);

    const updatedP1 = await prisma.bookingPerson.findUnique({ where: { id: p1.id } });
    assert.strictEqual(updatedP1.paused_at, null, 'Person 1 paused_at must be cleared');
  });

  await t.test('3. Move seat to WAIT-1 without layout error', async () => {
    const { req, res } = createMockReqRes({
      params: { booking_ref: bookingRef },
      body: { from_seat: 'A1-1', to_seat: 'WAIT-1', mode: 'move' }
    });

    await moveSeat(req, res);
    assert.strictEqual(res.getStatusCode(), 200);

    const updatedRes = await prisma.reservation.findFirst({ where: { booking_ref: bookingRef } });
    assert.ok(updatedRes.assigned_seats.includes('WAIT-1'), 'Assigned seats should now include WAIT-1');
    assert.ok(!updatedRes.assigned_seats.includes('A1-1'), 'Assigned seats should no longer include A1-1');

    const updatedP1 = await prisma.bookingPerson.findUnique({ where: { id: p1.id } });
    assert.strictEqual(updatedP1.seat_code, 'WAIT-1', 'Person 1 seat_code should be WAIT-1');
  });

  await t.test('4. isForceWait creates reservation with attendance null (pending)', async () => {
    const { adminCreateReservation } = await import('../src/controllers/reservationController.js');
    let createdBookingRef = null;
    try {
      const { req, res } = createMockReqRes({
        body: {
          session_ids: [session.id],
          pax: 1,
          name: '候位客',
          phone: '0911222333',
          isForceWait: true
        }
      });

      await adminCreateReservation(req, res);
      assert.strictEqual(res.getStatusCode(), 201);
      const createdData = res.getResponseData();
      createdBookingRef = createdData.reservation?.booking_ref || createdData.booking_ref;
      assert.ok(createdBookingRef);

      const savedRes = await prisma.reservation.findFirst({ where: { booking_ref: createdBookingRef } });
      assert.strictEqual(savedRes.attendance, null, 'isForceWait should keep attendance as null (pending)');
      assert.ok(savedRes.assigned_seats.some(s => s.startsWith('WAIT-')), 'Assigned seat should be WAIT-n');
    } finally {
      if (createdBookingRef) {
        await prisma.reservation.deleteMany({ where: { booking_ref: createdBookingRef } });
      }
    }
  });

  // Cleanup
  await prisma.timerPause.deleteMany({ where: { person: { booking_ref: bookingRef } } });
  await prisma.bookingPerson.deleteMany({ where: { booking_ref: bookingRef } });
  await prisma.reservation.deleteMany({ where: { booking_ref: bookingRef } });
});
