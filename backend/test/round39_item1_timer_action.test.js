import test from 'node:test';
import assert from 'node:assert/strict';
import prisma from '../src/prismaClient.js';
import { dateOnly } from '../../shared/time.js';
import { ensureTestPublishedLayout, cleanupTestPublishedLayout } from './helpers/seedTestLayout.js';
import { adminCreateReservation } from '../src/controllers/reservationController.js';
import { checkIn, handleTimer } from '../src/controllers/floorController.js';

function createMockReqRes({ body = {}, params = {}, query = {}, user = { id: 1, name: 'R39店員' } } = {}) {
  const req = { body, params, query, user, headers: {}, ip: '127.0.0.1' };
  let statusCode = 200;
  let bodyData = null;
  const res = {
    status(c) { statusCode = c; return res; },
    json(d) { bodyData = d; return res; },
    getStatusCode() { return statusCode; },
    getBody() { return bodyData; }
  };
  return { req, res };
}

test('Round 39 Item 1: handleTimer rejects unknown actions with 400 and end+all completes booking', async () => {
  const ts = Date.now();
  const testDateStr = '2099-11-01';
  const testDate = dateOnly(testDateStr);
  let bookingRef = null;
  let user = null;
  let session = null;
  let layoutId = null;

  try {
    layoutId = await ensureTestPublishedLayout(prisma, {
      name: 'R39 Item1 Layout',
      effectiveFrom: '2020-01-01',
      effectiveDate: testDateStr,
      codePrefix: 'E',
      seatCount: 8
    });

    await prisma.session.deleteMany({ where: { session_date: testDate } });
    session = await prisma.session.create({
      data: { session_date: testDate, start_time: '14:00', end_time: '16:00', max_capacity: 10 }
    });

    user = await prisma.user.create({
      data: { line_user_id: `manual_r39_1_${ts}`, name: 'R39離場測試', phone: `0991${String(ts).slice(-6)}` }
    });

    const createCall = createMockReqRes({
      body: {
        name: user.name,
        phone: user.phone,
        pax: 2,
        session_ids: [session.id],
        is_walk_in: false,
        auto_check_in: false
      }
    });
    await adminCreateReservation(createCall.req, createCall.res);
    assert.equal(createCall.res.getStatusCode(), 201);
    const createdRes = createCall.res.getBody().reservation;
    bookingRef = createdRes.booking_ref;
    const assignedSeats = createdRes.assigned_seats;
    assert.equal(assignedSeats.length, 2);

    const ciCall = createMockReqRes({
      params: { booking_ref: bookingRef },
      body: { seats: assignedSeats, start_timer: true }
    });
    await checkIn(ciCall.req, ciCall.res);
    assert.equal(ciCall.res.getStatusCode(), 200);

    // Unknown action 'leave' -> 400 UNKNOWN_TIMER_ACTION without touching DB
    const leaveCall = createMockReqRes({
      params: { booking_ref: bookingRef },
      body: { action: 'leave', person_nos: [1, 2] }
    });
    await handleTimer(leaveCall.req, leaveCall.res);
    assert.equal(leaveCall.res.getStatusCode(), 400);
    assert.equal(leaveCall.res.getBody().code, 'UNKNOWN_TIMER_ACTION');

    const personsAfterLeave = await prisma.bookingPerson.findMany({
      where: { booking_ref: bookingRef },
      orderBy: { person_no: 'asc' }
    });
    assert.equal(personsAfterLeave.length, 2);
    assert.equal(personsAfterLeave[0].timer_ended_at, null);
    assert.equal(personsAfterLeave[1].timer_ended_at, null);

    const resAfterLeave = await prisma.reservation.findFirst({ where: { booking_ref: bookingRef } });
    assert.equal(resAfterLeave.attendance, 'checked_in');

    // action: 'end', person_nos: 'all' -> 200 & completed
    const endCall = createMockReqRes({
      params: { booking_ref: bookingRef },
      body: { action: 'end', person_nos: 'all' }
    });
    await handleTimer(endCall.req, endCall.res);
    assert.equal(endCall.res.getStatusCode(), 200);

    const personsAfterEnd = await prisma.bookingPerson.findMany({
      where: { booking_ref: bookingRef },
      orderBy: { person_no: 'asc' }
    });
    assert.ok(personsAfterEnd[0].timer_ended_at);
    assert.ok(personsAfterEnd[1].timer_ended_at);

    const resAfterEnd = await prisma.reservation.findFirst({ where: { booking_ref: bookingRef } });
    assert.equal(resAfterEnd.attendance, 'completed');
  } finally {
    if (bookingRef) {
      await prisma.timerPause.deleteMany({ where: { person: { booking_ref: bookingRef } } }).catch(() => {});
      await prisma.bookingPerson.deleteMany({ where: { booking_ref: bookingRef } }).catch(() => {});
      await prisma.reservation.deleteMany({ where: { booking_ref: bookingRef } }).catch(() => {});
    }
    if (session) await prisma.session.deleteMany({ where: { id: session.id } }).catch(() => {});
    if (user) await prisma.user.deleteMany({ where: { id: user.id } }).catch(() => {});
    await cleanupTestPublishedLayout(prisma, layoutId).catch(() => {});
  }
});
