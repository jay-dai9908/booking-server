import test from 'node:test';
import assert from 'node:assert/strict';
import prisma from '../src/prismaClient.js';
import { dateOnly } from '../../shared/time.js';
import { ensureTestPublishedLayout, cleanupTestPublishedLayout } from './helpers/seedTestLayout.js';
import { adminCreateReservation } from '../src/controllers/reservationController.js';
import { checkIn, removePerson, handleTimer } from '../src/controllers/floorController.js';

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

test('Round 39 Item 3: handleTimer returns 409 PERSON_REMOVED when targeting a removed person', async () => {
  const ts = Date.now();
  const testDateStr = '2099-11-03';
  const testDate = dateOnly(testDateStr);
  let layoutId = null;
  let session = null;
  let user = null;
  let bookingRef = null;

  try {
    layoutId = await ensureTestPublishedLayout(prisma, {
      name: 'R39 Item3 Layout',
      effectiveFrom: '2020-01-01',
      effectiveDate: testDateStr,
      codePrefix: 'A',
      seatCount: 8
    });

    await prisma.session.deleteMany({ where: { session_date: testDate } });
    session = await prisma.session.create({
      data: { session_date: testDate, start_time: '14:00', end_time: '16:00', max_capacity: 10 }
    });

    user = await prisma.user.create({
      data: { line_user_id: `manual_r39_3_${ts}`, name: 'R39移除測試', phone: `0996${String(ts).slice(-6)}` }
    });

    const createCall = createMockReqRes({
      body: { name: user.name, phone: user.phone, pax: 3, session_ids: [session.id], is_walk_in: false }
    });
    await adminCreateReservation(createCall.req, createCall.res);
    assert.equal(createCall.res.getStatusCode(), 201);
    const createdRes = createCall.res.getBody().reservation;
    bookingRef = createdRes.booking_ref;

    const ciCall = createMockReqRes({
      params: { booking_ref: bookingRef },
      body: { seats: createdRes.assigned_seats, start_timer: true, now: `${testDateStr}T14:00:00+08:00` }
    });
    await checkIn(ciCall.req, ciCall.res);
    assert.equal(ciCall.res.getStatusCode(), 200);

    // Remove person 1 within 15 mins
    const remCall = createMockReqRes({
      params: { booking_ref: bookingRef, person_no: '1' },
      body: { now: `${testDateStr}T14:05:00+08:00` }
    });
    await removePerson(remCall.req, remCall.res);
    assert.equal(remCall.res.getStatusCode(), 200);

    // Calling handleTimer on removed person 1 -> 409 PERSON_REMOVED
    const restartRemoved = createMockReqRes({
      params: { booking_ref: bookingRef },
      body: { action: 'restart', person_nos: [1] }
    });
    await handleTimer(restartRemoved.req, restartRemoved.res);
    assert.equal(restartRemoved.res.getStatusCode(), 409);
    assert.equal(restartRemoved.res.getBody().code, 'PERSON_REMOVED');

    // Calling handleTimer action 'pause', person_nos 'all' still succeeds on active persons 2 & 3
    const pauseAll = createMockReqRes({
      params: { booking_ref: bookingRef },
      body: { action: 'pause', person_nos: 'all' }
    });
    await handleTimer(pauseAll.req, pauseAll.res);
    assert.equal(pauseAll.res.getStatusCode(), 200);
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
