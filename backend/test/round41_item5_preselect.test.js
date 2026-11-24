import test from 'node:test';
import assert from 'node:assert/strict';
import prisma from '../src/prismaClient.js';
import { dateOnly } from '../../shared/time.js';
import { ensureTestPublishedLayout, cleanupTestPublishedLayout } from './helpers/seedTestLayout.js';
import { getActiveLayoutForDate } from '../src/services/seating/layoutService.js';
import { assertNoSeatCollisions } from '../src/services/seating/allocator.js';
import { adminCreateReservation } from '../src/controllers/reservationController.js';
import { checkIn } from '../src/controllers/floorController.js';

function createMockReqRes({ body = {}, params = {}, query = {}, user = { id: 1, name: 'R41店員' } } = {}) {
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

test('Round 41 Item 5: adminCreateReservation honors assigned_seats, rejects 409/422, reseats unpinned, and auto-fills remaining pax', async () => {
  const ts = Date.now();
  const dStr = '2099-11-25';
  const d = dateOnly(dStr);
  let layoutId = null;
  let s14, s15;
  const createdRefs = [];

  try {
    layoutId = await ensureTestPublishedLayout(prisma, {
      name: `R41 Item5 Layout ${ts}`,
      effectiveFrom: dStr,
      effectiveDate: dStr,
      codePrefix: 'A1-',
      seatCount: 6,
      alwaysCreate: true
    });
    const layout = await getActiveLayoutForDate(prisma, d);
    const activeSeats = (layout?.seats || []).filter(s => s.is_active).map(s => s.code);
    assert.ok(activeSeats.length >= 4, 'Expected at least 4 active seats');
    const firstTable = activeSeats.slice(0, 2);
    const targetPick = activeSeats.slice(2, 4);

    await prisma.dailySetting.deleteMany({ where: { date: d } });
    await prisma.dailySetting.create({
      data: { date: d, allow_unlimited: true, hourly_price: 200, unlimited_price: 600 }
    });
    await prisma.session.deleteMany({ where: { session_date: d } });
    s14 = await prisma.session.create({ data: { session_date: d, start_time: '14:00', end_time: '15:00', max_capacity: 16 } });
    s15 = await prisma.session.create({ data: { session_date: d, start_time: '15:00', end_time: '16:00', max_capacity: 16 } });

    // Validation: duplicate or exceeding pax or nonexistent seat -> 422
    const badDup = createMockReqRes({
      body: { name: 'R41檢核', pax: 2, session_ids: [s14.id], assigned_seats: [targetPick[0], targetPick[0]], is_walk_in: true }
    });
    await adminCreateReservation(badDup.req, badDup.res);
    assert.equal(badDup.res.getStatusCode(), 422);

    const badTooMany = createMockReqRes({
      body: { name: 'R41檢核', pax: 1, session_ids: [s14.id], assigned_seats: targetPick, is_walk_in: true }
    });
    await adminCreateReservation(badTooMany.req, badTooMany.res);
    assert.equal(badTooMany.res.getStatusCode(), 422);

    const badSeat = createMockReqRes({
      body: { name: 'R41檢核', pax: 1, session_ids: [s14.id], assigned_seats: ['NO-SUCH-SEAT'], is_walk_in: true }
    });
    await adminCreateReservation(badSeat.req, badSeat.res);
    assert.equal(badSeat.res.getStatusCode(), 422);

    // 1. Auto-allocate first without preselection (picks firstTable), vs preselection picks targetPick
    const pickReq = createMockReqRes({
      body: {
        name: 'R41預選客',
        phone: `09412${String(ts).slice(-5)}`, // check-secrets: fake-data
        pax: 2,
        session_ids: [s14.id, s15.id],
        is_walk_in: true,
        assigned_seats: targetPick
      }
    });
    await adminCreateReservation(pickReq.req, pickReq.res);
    assert.equal(pickReq.res.getStatusCode(), 201);
    const pickBody = pickReq.res.getBody().reservation;
    createdRefs.push(pickBody.booking_ref);
    assert.deepEqual(pickBody.assigned_seats, targetPick);
    assert.equal(pickBody.allocation_reason, '店員指定座位');

    // Check in pickBody so targetPick[0] becomes seated occupant -> next preselection onto targetPick[0] must fail 409 SEAT_CONFLICT
    const ciPick = createMockReqRes({
      params: { booking_ref: pickBody.booking_ref },
      body: { seats: targetPick, start_timer: true, now: `${dStr}T14:00:00+08:00` }
    });
    await checkIn(ciPick.req, ciPick.res);
    assert.equal(ciPick.res.getStatusCode(), 200);

    const beforeConflictCount = await prisma.reservation.count({ where: { session_id: s14.id } });
    const conflictReq = createMockReqRes({
      body: {
        name: 'R41撞位客',
        pax: 1,
        session_ids: [s14.id],
        is_walk_in: true,
        assigned_seats: [targetPick[0]]
      }
    });
    await adminCreateReservation(conflictReq.req, conflictReq.res);
    assert.equal(conflictReq.res.getStatusCode(), 409);
    assert.equal(conflictReq.res.getBody().code, 'SEAT_CONFLICT');
    const afterConflictCount = await prisma.reservation.count({ where: { session_id: s14.id } });
    assert.equal(afterConflictCount, beforeConflictCount, 'Must not create any Reservation row on 409');

    // Clean up pickBody to free seats for partial preselection + unpinned displacement check
    const pickRow = await prisma.reservation.findFirst({ where: { booking_ref: pickBody.booking_ref }, select: { user_id: true } });
    await prisma.bookingPerson.deleteMany({ where: { booking_ref: pickBody.booking_ref } });
    await prisma.reservation.deleteMany({ where: { booking_ref: pickBody.booking_ref } });

    // Create an unpinned reservation sitting on targetPick[0] -> preselection must displace it cleanly
    const unpinnedUser = await prisma.user.create({
      data: { line_user_id: `r41_5_unp_${ts}`, name: 'R41未固定', phone: `09413${String(ts).slice(-5)}` } // check-secrets: fake-data
    });
    if (pickRow?.user_id) await prisma.user.deleteMany({ where: { id: pickRow.user_id } }).catch(() => {});
    const unpinnedRef = `R41-5-UNP-${ts}`;
    createdRefs.push(unpinnedRef);
    await prisma.reservation.create({
      data: {
        booking_ref: unpinnedRef,
        session_id: s14.id,
        user_id: unpinnedUser.id,
        pax: 1,
        status: 'confirmed',
        assigned_seats: [targetPick[0]],
        seat_source: 'auto',
        is_seat_locked: false
      }
    });

    // 3. Partial preselect: 3 pax with 2 preselected seats -> first 2 match targetPick, 3rd auto-allocated; unpinned displaced!
    const partialReq = createMockReqRes({
      body: {
        name: 'R41三人兩選',
        pax: 3,
        session_ids: [s14.id],
        is_walk_in: true,
        forceSplit: true,
        assigned_seats: targetPick
      }
    });
    await adminCreateReservation(partialReq.req, partialReq.res);
    assert.equal(partialReq.res.getStatusCode(), 201);
    const partialBody = partialReq.res.getBody().reservation;
    createdRefs.push(partialBody.booking_ref);
    assert.equal(partialBody.assigned_seats.length, 3);
    assert.deepEqual(partialBody.assigned_seats.slice(0, 2), targetPick);
    assert.ok(!targetPick.includes(partialBody.assigned_seats[2]) && firstTable.length > 0);
    assert.equal(new Set(partialBody.assigned_seats).size, 3);

    const movedUnpinned = await prisma.reservation.findFirst({ where: { booking_ref: unpinnedRef } });
    assert.ok(!movedUnpinned.assigned_seats.includes(targetPick[0]), 'Unpinned reservation must be moved off preselected seat');
    await assertNoSeatCollisions(prisma, [s14.id]);
  } finally {
    await prisma.payment.deleteMany({ where: { booking_ref: { in: createdRefs } } }).catch(() => {});
    await prisma.timerPause.deleteMany({ where: { person: { booking_ref: { in: createdRefs } } } }).catch(() => {});
    await prisma.bookingPerson.deleteMany({ where: { booking_ref: { in: createdRefs } } }).catch(() => {});
    const resUsers = await prisma.reservation.findMany({ where: { booking_ref: { in: createdRefs } }, select: { user_id: true } }).catch(() => []);
    const userIdsToDel = [...new Set(resUsers.map(r => r.user_id).filter(Boolean))];
    await prisma.reservation.deleteMany({ where: { booking_ref: { in: createdRefs } } }).catch(() => {});
    await prisma.dailySetting.deleteMany({ where: { date: d } }).catch(() => {});
    for (const s of [s14, s15]) {
      if (s) await prisma.session.deleteMany({ where: { id: s.id } }).catch(() => {});
    }
    if (userIdsToDel.length > 0) await prisma.user.deleteMany({ where: { id: { in: userIdsToDel } } }).catch(() => {});
    await cleanupTestPublishedLayout(prisma, layoutId).catch(() => {});
  }
});
