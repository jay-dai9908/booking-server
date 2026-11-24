import test from 'node:test';
import assert from 'node:assert/strict';
import prisma from '../src/prismaClient.js';
import { dateOnly } from '../../shared/time.js';
import { ensureTestPublishedLayout, cleanupTestPublishedLayout } from './helpers/seedTestLayout.js';
import { loadAllocatorContext } from '../src/services/seating/layoutService.js';
import { adminCreateReservation } from '../src/controllers/reservationController.js';
import { checkIn, moveSeat, seatPerson } from '../src/controllers/floorController.js';

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

test('Round 39 Item 4: moveSeat rejects null from_seat and seatPerson assigns seats to unseated guests', async () => {
  const ts = Date.now();
  const testDateStr = '2099-11-04';
  const testDate = dateOnly(testDateStr);
  let layoutId = null;
  let session = null;
  let userA = null;
  let userB = null;
  const createdRefs = [];

  try {
    layoutId = await ensureTestPublishedLayout(prisma, {
      name: 'R39 Item4 Layout',
      effectiveFrom: '2020-01-01',
      effectiveDate: testDateStr,
      codePrefix: 'A',
      seatCount: 8
    });

    await prisma.session.deleteMany({ where: { session_date: testDate } });
    session = await prisma.session.create({
      data: { session_date: testDate, start_time: '14:00', end_time: '16:00', max_capacity: 12 }
    });

    const ctx = await loadAllocatorContext(prisma, testDate);
    const activeSeats = (ctx.layout?.seats || []).filter(s => s.is_active).map(s => s.code);
    assert.ok(activeSeats.length >= 4, 'Need at least 4 active seats');
    const [seat1, seat2, seat3, seat4] = activeSeats;

    userA = await prisma.user.create({
      data: { line_user_id: `manual_r39_4a_${ts}`, name: 'R39分批組', phone: `0997${String(ts).slice(-6)}` }
    });
    userB = await prisma.user.create({
      data: { line_user_id: `manual_r39_4b_${ts}`, name: 'R39佔座組', phone: `0998${String(ts).slice(-6)}` }
    });

    // 1. 4 pax booking, check in only 2 seats [seat1, seat2]
    const createA = createMockReqRes({
      body: { name: userA.name, phone: userA.phone, pax: 4, session_ids: [session.id], is_walk_in: false }
    });
    await adminCreateReservation(createA.req, createA.res);
    assert.equal(createA.res.getStatusCode(), 201);
    const refA = createA.res.getBody().reservation.booking_ref;
    createdRefs.push(refA);

    const ciA = createMockReqRes({
      params: { booking_ref: refA },
      body: { seats: [seat1, seat2], start_timer: true, now: `${testDateStr}T14:00:00+08:00` }
    });
    await checkIn(ciA.req, ciA.res);
    assert.equal(ciA.res.getStatusCode(), 200);

    // Mark person 4 as removed with seat_code: null
    await prisma.bookingPerson.updateMany({
      where: { booking_ref: refA, person_no: 4 },
      data: { status: 'removed', seat_code: null }
    });

    // 2. moveSeat with from_seat: null -> 400 FROM_SEAT_REQUIRED, DB unchanged
    const badMove = createMockReqRes({
      params: { booking_ref: refA },
      body: { from_seat: null, to_seat: seat3, mode: 'move' }
    });
    await moveSeat(badMove.req, badMove.res);
    assert.equal(badMove.res.getStatusCode(), 400);
    assert.equal(badMove.res.getBody().code, 'FROM_SEAT_REQUIRED');

    const p3Before = await prisma.bookingPerson.findFirst({ where: { booking_ref: refA, person_no: 3 } });
    const p4Before = await prisma.bookingPerson.findFirst({ where: { booking_ref: refA, person_no: 4 } });
    assert.equal(p3Before.seat_code, null);
    assert.equal(p4Before.seat_code, null);

    // 3. seatPerson for person 3 to seat3 -> 200
    const seatP3 = createMockReqRes({
      params: { booking_ref: refA, person_no: '3' },
      body: { seat_code: seat3, start_timer: true, now: `${testDateStr}T14:15:00+08:00` }
    });
    await seatPerson(seatP3.req, seatP3.res);
    assert.equal(seatP3.res.getStatusCode(), 200);

    const p3After = await prisma.bookingPerson.findFirst({ where: { booking_ref: refA, person_no: 3 } });
    const p4After = await prisma.bookingPerson.findFirst({ where: { booking_ref: refA, person_no: 4 } });
    const resAfter = await prisma.reservation.findFirst({ where: { booking_ref: refA } });
    assert.equal(p3After.seat_code, seat3);
    assert.equal(p4After.seat_code, null);
    assert.deepEqual(resAfter.assigned_seats, [seat1, seat2, seat3]);

    // 4. Re-seating person 3 when already seated -> 409
    const reSeatP3 = createMockReqRes({
      params: { booking_ref: refA, person_no: '3' },
      body: { seat_code: seat4 }
    });
    await seatPerson(reSeatP3.req, reSeatP3.res);
    assert.equal(reSeatP3.res.getStatusCode(), 409);

    // 5. seat4 occupied by another checked-in group B -> seatPerson on seat4 returns 409 SEAT_OCCUPIED
    const createB = createMockReqRes({
      body: { name: userB.name, phone: userB.phone, pax: 1, session_ids: [session.id], is_walk_in: false }
    });
    await adminCreateReservation(createB.req, createB.res);
    assert.equal(createB.res.getStatusCode(), 201);
    const refB = createB.res.getBody().reservation.booking_ref;
    createdRefs.push(refB);

    const ciB = createMockReqRes({
      params: { booking_ref: refB },
      body: { seats: [seat4], start_timer: true }
    });
    await checkIn(ciB.req, ciB.res);
    assert.equal(ciB.res.getStatusCode(), 200);

    // Create a 5th person or seat unassigned person in B? Actually create removed-less unseated in A? Test with person 3 in another 2-pax booking C or unseat? Better: update A's person 4? Wait: person 4 is removed; add pax via DB or test with C:
    const pUnseated = await prisma.bookingPerson.create({
      data: { booking_ref: refA, person_no: 5, status: 'active', seat_code: null }
    });
    assert.ok(pUnseated.id);
    const seatBlocked = createMockReqRes({
      params: { booking_ref: refA, person_no: '5' },
      body: { seat_code: seat4 }
    });
    await seatPerson(seatBlocked.req, seatBlocked.res);
    assert.equal(seatBlocked.res.getStatusCode(), 409);
    assert.equal(seatBlocked.res.getBody().code, 'SEAT_OCCUPIED');
  } finally {
    for (const ref of createdRefs) {
      await prisma.timerPause.deleteMany({ where: { person: { booking_ref: ref } } }).catch(() => {});
      await prisma.bookingPerson.deleteMany({ where: { booking_ref: ref } }).catch(() => {});
      await prisma.reservation.deleteMany({ where: { booking_ref: ref } }).catch(() => {});
    }
    if (session) await prisma.session.deleteMany({ where: { id: session.id } }).catch(() => {});
    if (userA) await prisma.user.deleteMany({ where: { id: userA.id } }).catch(() => {});
    if (userB) await prisma.user.deleteMany({ where: { id: userB.id } }).catch(() => {});
    await cleanupTestPublishedLayout(prisma, layoutId).catch(() => {});
  }
});
