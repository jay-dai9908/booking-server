import test from 'node:test';
import assert from 'node:assert/strict';
import prisma from '../src/prismaClient.js';
import { dateOnly } from '../../shared/time.js';
import { ensureTestPublishedLayout, cleanupTestPublishedLayout } from './helpers/seedTestLayout.js';
import { loadAllocatorContext } from '../src/services/seating/layoutService.js';
import { adminCreateReservation } from '../src/controllers/reservationController.js';
import { checkIn, handleTimer, addPerson } from '../src/controllers/floorController.js';

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

test('Round 39 Item 2: seated occupants block cross-session checkIn, addPerson, and walk-in auto allocation', async () => {
  const ts = Date.now();
  const testDateStr = '2099-11-02';
  const testDate = dateOnly(testDateStr);
  let layoutId = null;
  let s1 = null;
  let s2 = null;
  let userA = null;
  let userB = null;
  let userC = null;
  const createdRefs = [];

  try {
    layoutId = await ensureTestPublishedLayout(prisma, {
      name: 'R39 Item2 Layout',
      effectiveFrom: '2020-01-01',
      effectiveDate: testDateStr,
      codePrefix: 'A',
      seatCount: 8
    });

    await prisma.session.deleteMany({ where: { session_date: testDate } });
    s1 = await prisma.session.create({
      data: { session_date: testDate, start_time: '14:00', end_time: '16:00', max_capacity: 10 }
    });
    s2 = await prisma.session.create({
      data: { session_date: testDate, start_time: '16:00', end_time: '18:00', max_capacity: 10 }
    });

    userA = await prisma.user.create({
      data: { line_user_id: `manual_r39_2a_${ts}`, name: 'R39在座A', phone: `0992${String(ts).slice(-6)}` }
    });
    userB = await prisma.user.create({
      data: { line_user_id: `manual_r39_2b_${ts}`, name: 'R39後組B', phone: `0993${String(ts).slice(-6)}` }
    });
    userC = await prisma.user.create({
      data: { line_user_id: `manual_r39_2c_${ts}`, name: 'R39臨時C', phone: `0994${String(ts).slice(-6)}` }
    });

    const ctx = await loadAllocatorContext(prisma, testDate);
    const activeSeatCodes = (ctx.layout?.seats || []).filter(s => s.is_active).map(s => s.code);
    assert.ok(activeSeatCodes.length >= 2, 'Need at least 2 active seats');
    const targetSeat = activeSeatCodes[0];

    // 1. Create A (14:00-16:00) and check in at targetSeat
    const createA = createMockReqRes({
      body: { name: userA.name, phone: userA.phone, pax: 1, session_ids: [s1.id], is_walk_in: false }
    });
    await adminCreateReservation(createA.req, createA.res);
    assert.equal(createA.res.getStatusCode(), 201);
    const refA = createA.res.getBody().reservation.booking_ref;
    createdRefs.push(refA);

    const ciA = createMockReqRes({
      params: { booking_ref: refA },
      body: { seats: [targetSeat], start_timer: true, now: `${testDateStr}T14:00:00+08:00` }
    });
    await checkIn(ciA.req, ciA.res);
    assert.equal(ciA.res.getStatusCode(), 200);

    // 2. Create B (16:00-18:00), try checkIn at targetSeat at 16:20 while A still seated -> 409 SEAT_OCCUPIED
    const createB = createMockReqRes({
      body: { name: userB.name, phone: userB.phone, pax: 1, session_ids: [s2.id], is_walk_in: false }
    });
    await adminCreateReservation(createB.req, createB.res);
    assert.equal(createB.res.getStatusCode(), 201);
    const refB = createB.res.getBody().reservation.booking_ref;
    createdRefs.push(refB);

    const ciBBlocked = createMockReqRes({
      params: { booking_ref: refB },
      body: { seats: [targetSeat], start_timer: true, now: `${testDateStr}T16:20:00+08:00` }
    });
    await checkIn(ciBBlocked.req, ciBBlocked.res);
    assert.equal(ciBBlocked.res.getStatusCode(), 409);
    assert.equal(ciBBlocked.res.getBody().code, 'SEAT_OCCUPIED');

    // Verify A's seat was not touched
    const resAAfterBlocked = await prisma.reservation.findFirst({ where: { booking_ref: refA } });
    assert.deepEqual(resAAfterBlocked.assigned_seats, [targetSeat]);

    // 3. After A leaves -> B checkIn at targetSeat succeeds
    const leaveA = createMockReqRes({
      params: { booking_ref: refA },
      body: { action: 'end', person_nos: 'all', now: `${testDateStr}T16:21:00+08:00` }
    });
    await handleTimer(leaveA.req, leaveA.res);
    assert.equal(leaveA.res.getStatusCode(), 200);

    const ciBSuccess = createMockReqRes({
      params: { booking_ref: refB },
      body: { seats: [targetSeat], start_timer: true, now: `${testDateStr}T16:22:00+08:00` }
    });
    await checkIn(ciBSuccess.req, ciBSuccess.res);
    assert.equal(ciBSuccess.res.getStatusCode(), 200);

    // 4. Create C (14:00-16:00) and try addPerson for C at targetSeat while B is seated -> 409 SEAT_OCCUPIED
    const createC = createMockReqRes({
      body: { name: userC.name, phone: userC.phone, pax: 1, session_ids: [s1.id], is_walk_in: false }
    });
    await adminCreateReservation(createC.req, createC.res);
    assert.equal(createC.res.getStatusCode(), 201);
    const refC = createC.res.getBody().reservation.booking_ref;
    createdRefs.push(refC);

    const addBlocked = createMockReqRes({
      params: { booking_ref: refC },
      body: { seat_code: targetSeat }
    });
    await addPerson(addBlocked.req, addBlocked.res);
    assert.equal(addBlocked.res.getStatusCode(), 409);
    assert.equal(addBlocked.res.getBody().code, 'SEAT_OCCUPIED');

    // 5. Walk-in 1 pax on 14:00-16:00 while B is seated on targetSeat (in 16:00-18:00) -> walk-in avoids targetSeat
    const walkInCreate = createMockReqRes({
      body: {
        name: 'R39現場避座',
        phone: `0995${String(ts).slice(-5)}0`,
        pax: 1,
        session_ids: [s1.id],
        isWalkIn: true
      }
    });
    await adminCreateReservation(walkInCreate.req, walkInCreate.res);
    assert.equal(walkInCreate.res.getStatusCode(), 201);
    const walkInRes = walkInCreate.res.getBody().reservation;
    createdRefs.push(walkInRes.booking_ref);
    assert.ok(!walkInRes.assigned_seats.includes(targetSeat), `Expected walk-in seats ${walkInRes.assigned_seats} not to include ${targetSeat}`);

    // Clean up auto-created walk-in user
    const wRow = await prisma.reservation.findFirst({ where: { booking_ref: walkInRes.booking_ref } });
    if (wRow) {
      await prisma.timerPause.deleteMany({ where: { person: { booking_ref: walkInRes.booking_ref } } });
      await prisma.bookingPerson.deleteMany({ where: { booking_ref: walkInRes.booking_ref } });
      await prisma.reservation.deleteMany({ where: { booking_ref: walkInRes.booking_ref } });
      await prisma.user.deleteMany({ where: { id: wRow.user_id } });
    }
  } finally {
    for (const ref of createdRefs) {
      await prisma.timerPause.deleteMany({ where: { person: { booking_ref: ref } } }).catch(() => {});
      await prisma.bookingPerson.deleteMany({ where: { booking_ref: ref } }).catch(() => {});
      await prisma.reservation.deleteMany({ where: { booking_ref: ref } }).catch(() => {});
    }
    if (s1) await prisma.session.deleteMany({ where: { id: s1.id } }).catch(() => {});
    if (s2) await prisma.session.deleteMany({ where: { id: s2.id } }).catch(() => {});
    if (userA) await prisma.user.deleteMany({ where: { id: userA.id } }).catch(() => {});
    if (userB) await prisma.user.deleteMany({ where: { id: userB.id } }).catch(() => {});
    if (userC) await prisma.user.deleteMany({ where: { id: userC.id } }).catch(() => {});
    await cleanupTestPublishedLayout(prisma, layoutId).catch(() => {});
  }
});
