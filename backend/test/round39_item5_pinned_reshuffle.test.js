import test from 'node:test';
import assert from 'node:assert/strict';
import prisma from '../src/prismaClient.js';
import { dateOnly } from '../../shared/time.js';
import { ensureTestPublishedLayout, cleanupTestPublishedLayout } from './helpers/seedTestLayout.js';
import { loadAllocatorContext } from '../src/services/seating/layoutService.js';
import { allocateSeats } from '../src/utils/SeatAllocator.js';
import {
  createReservation,
  moveSeat as legacyMoveSeat,
  applyMovableSeatUpdates
} from '../src/controllers/reservationController.js';
import { checkIn } from '../src/controllers/floorController.js';

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

test('Round 39 Item 5: pinned reshuffle protection (SEAT_PINNED, SEAT_RACE, lockDaySeats concurrency)', async () => {
  const ts = Date.now();
  const testDateStr = '2099-11-05';
  const testDate = dateOnly(testDateStr);
  let layoutId = null;
  const createdRefs = [];
  const createdUserIds = [];
  let createdSessionIds = [];

  try {
    layoutId = await ensureTestPublishedLayout(prisma, {
      name: 'R39 Item5 Layout',
      effectiveFrom: '2020-01-01',
      effectiveDate: testDateStr,
      codePrefix: 'A',
      seatCount: 16
    });

    // Clean up any stale BookingPerson/Reservation from interrupted runs on same testDate
    const staleRes = await prisma.reservation.findMany({ where: { booking_ref: { startsWith: 'R39-5-' } }, select: { booking_ref: true } });
    if (staleRes.length > 0) {
      const staleRefs = staleRes.map((r) => r.booking_ref);
      await prisma.timerPause.deleteMany({ where: { person: { booking_ref: { in: staleRefs } } } }).catch(() => {});
      await prisma.bookingPerson.deleteMany({ where: { booking_ref: { in: staleRefs } } }).catch(() => {});
      await prisma.reservation.deleteMany({ where: { booking_ref: { in: staleRefs } } }).catch(() => {});
    }
    await prisma.session.deleteMany({ where: { session_date: testDate } });
    const s1 = await prisma.session.create({
      data: { session_date: testDate, start_time: '14:00', end_time: '16:00', max_capacity: 20 }
    });
    const s2 = await prisma.session.create({
      data: { session_date: testDate, start_time: '16:00', end_time: '18:00', max_capacity: 20 }
    });
    createdSessionIds = [s1.id, s2.id];

    const ctx = await loadAllocatorContext(prisma, testDate);
    const activeSeats = (ctx.layout?.seats || [])
      .filter((s) => s.is_active)
      .sort((a, b) => (a.table_id - b.table_id) || ((a.sort_order ?? 0) - (b.sort_order ?? 0)) || a.code.localeCompare(b.code));
    assert.ok(activeSeats.length >= 6, 'Need at least 6 active seats');

    const seatA = activeSeats[0].code;
    const seatC = activeSeats[1].code;
    const seatMoveB = activeSeats[2].code;
    const seatExtra = activeSeats[3].code;

    const makeUser = async (suffix, name) => {
      const u = await prisma.user.create({
        data: {
          line_user_id: `manual_r39_5_${suffix}_${ts}`,
          name,
          phone: `0955${String(ts).slice(-4)}${String(createdUserIds.length).padStart(2, '0')}`
        }
      });
      createdUserIds.push(u.id);
      return u;
    };

    const userA = await makeUser('a', '王固定A');
    const userB = await makeUser('b', '林移動B');
    const userC = await makeUser('c', '陳未鎖C');
    const userD = await makeUser('d', '張競態D');

    // Case 1 & Case 2: legacy moveSeat vs pinned A (409 SEAT_PINNED) and unpinned C (200 reshuffled)
    const refA = `R39-5-A-${ts}`;
    const refB = `R39-5-B-${ts}`;
    const refC = `R39-5-C-${ts}`;
    createdRefs.push(refA, refB, refC);

    await prisma.reservation.create({
      data: {
        booking_ref: refA,
        session_id: s1.id,
        user_id: userA.id,
        pax: 1,
        status: 'confirmed',
        attendance: 'checked_in',
        checked_in_at: new Date(),
        is_seat_locked: true,
        seat_source: 'staff',
        assigned_seats: [seatA]
      }
    });
    await prisma.bookingPerson.create({
      data: { booking_ref: refA, person_no: 1, seat_code: seatA, status: 'active' }
    });

    const rowB = await prisma.reservation.create({
      data: {
        booking_ref: refB,
        session_id: s1.id,
        user_id: userB.id,
        pax: 1,
        status: 'confirmed',
        attendance: null,
        is_seat_locked: false,
        seat_source: 'auto',
        assigned_seats: [seatMoveB]
      }
    });

    await prisma.reservation.create({
      data: {
        booking_ref: refC,
        session_id: s1.id,
        user_id: userC.id,
        pax: 1,
        status: 'confirmed',
        attendance: null,
        is_seat_locked: false,
        seat_source: 'auto',
        assigned_seats: [seatC]
      }
    });

    // 1. Legacy moveSeat moves B onto pinned A's seat -> 409 SEAT_PINNED; A untouched
    const moveOnA = createMockReqRes({
      body: { id: rowB.id, assigned_seats: [seatA] }
    });
    await legacyMoveSeat(moveOnA.req, moveOnA.res);
    assert.equal(moveOnA.res.getStatusCode(), 409);
    assert.equal(moveOnA.res.getBody()?.code, 'SEAT_PINNED');

    const aAfterFail = await prisma.reservation.findFirst({ where: { booking_ref: refA } });
    assert.deepEqual(aAfterFail.assigned_seats, [seatA]);
    assert.equal(aAfterFail.is_seat_locked, true);
    const bAfterFail = await prisma.reservation.findFirst({ where: { booking_ref: refB } });
    assert.deepEqual(bAfterFail.assigned_seats, [seatMoveB]);

    // Direct check: applyMovableSeatUpdates rejects pinned booking with 409 SEAT_RACE
    await assert.rejects(
      async () => {
        await prisma.$transaction(async (tx) => {
          await applyMovableSeatUpdates(tx, [{ booking_ref: refA, assigned_seats: [seatExtra] }]);
        });
      },
      (err) => err?.status === 409 && err?.code === 'SEAT_RACE'
    );

    // 2. Legacy moveSeat moves B onto unpinned C's seat -> 200, C reseated away from seatA & seatC
    const moveOnC = createMockReqRes({
      body: { id: rowB.id, assigned_seats: [seatC] }
    });
    await legacyMoveSeat(moveOnC.req, moveOnC.res);
    assert.equal(moveOnC.res.getStatusCode(), 200, `Expected 200, got ${JSON.stringify(moveOnC.res.getBody())}`);

    const cAfterMove = await prisma.reservation.findFirst({ where: { booking_ref: refC } });
    assert.equal(cAfterMove.assigned_seats.length, 1);
    assert.notEqual(cAfterMove.assigned_seats[0], seatA);
    assert.notEqual(cAfterMove.assigned_seats[0], seatC);

    // Case 3: Concurrent race between online createReservation (300ms test hook delay) displacing D & floor checkIn pinning D
    // Find two empty contiguous seats for new 2-pax booking + D occupying one of them, plus one isolated empty seat for targetB1
    const allSeatsInOrder = activeSeats.map((s) => s.code);
    // Clean s1 for controlled race setup
    await prisma.bookingPerson.deleteMany({ where: { booking_ref: { in: createdRefs } } });
    await prisma.reservation.deleteMany({ where: { session_id: s1.id } });
    createdRefs.length = 0;

    // Leave pair [allSeatsInOrder[0], allSeatsInOrder[1]] and isolated single seat allSeatsInOrder[last] free;
    // Pin all middle seats so allocateSeats(pax: 2, forceSplit: false) MUST displace D from pair[0] -> isolatedSeat.
    const pairSeat0 = allSeatsInOrder[0];
    const isolatedSeat = allSeatsInOrder[allSeatsInOrder.length - 1];
    const blockerSeats = allSeatsInOrder.slice(2, -1);

    const refD = `R39-5-D-${ts}`;
    createdRefs.push(refD);
    await prisma.reservation.create({
      data: {
        booking_ref: refD,
        session_id: s1.id,
        user_id: userD.id,
        pax: 1,
        status: 'confirmed',
        attendance: null,
        is_seat_locked: false,
        seat_source: 'auto',
        assigned_seats: [pairSeat0]
      }
    });

    if (blockerSeats.length > 0) {
      const refBlock = `R39-5-BLK-${ts}`;
      createdRefs.push(refBlock);
      await prisma.reservation.create({
        data: {
          booking_ref: refBlock,
          session_id: s1.id,
          user_id: userA.id,
          pax: blockerSeats.length,
          status: 'confirmed',
          attendance: 'checked_in',
          checked_in_at: new Date(),
          is_seat_locked: true,
          seat_source: 'staff',
          assigned_seats: blockerSeats
        }
      });
    }

    // Confirm allocator plans to displace refD
    const preRows = await prisma.reservation.findMany({ where: { session_id: s1.id, status: 'confirmed' } });
    const dryAlloc = allocateSeats(preRows, { booking_ref: 'NEW_RES', pax: 2, session_ids: [s1.id] }, false, ctx);
    assert.equal(dryAlloc.success, true, 'Dry-run allocateSeats must succeed');

    const userOnline = await makeUser('onl', '線上客');
    const onlineReqRes = createMockReqRes({
      user: { id: userOnline.id, name: userOnline.name },
      body: {
        userId: userOnline.id,
        session_ids: [s1.id],
        pax: 2,
        __testDelayAfterAllocMs: 300
      }
    });
    const checkInReqRes = createMockReqRes({
      params: { booking_ref: refD },
      body: { seats: [isolatedSeat], start_timer: false }
    });

    await Promise.all([
      createReservation(onlineReqRes.req, onlineReqRes.res),
      new Promise((r) => setTimeout(r, 50)).then(() => checkIn(checkInReqRes.req, checkInReqRes.res))
    ]);

    assert.equal(
      onlineReqRes.res.getStatusCode(),
      201,
      `Concurrent online createReservation failed: ${JSON.stringify(onlineReqRes.res.getBody())}`
    );
    const createdOnlineRef = onlineReqRes.res.getBody()?.booking_ref;
    if (createdOnlineRef) createdRefs.push(createdOnlineRef);

    assert.equal(
      checkInReqRes.res.getStatusCode(),
      200,
      `Concurrent floor checkIn failed: ${JSON.stringify(checkInReqRes.res.getBody())}`
    );

    const dFinal = await prisma.reservation.findFirst({ where: { booking_ref: refD } });
    assert.deepEqual(dFinal.assigned_seats, [isolatedSeat]);
    assert.equal(dFinal.is_seat_locked, true);
    assert.equal(dFinal.attendance, 'checked_in');
    assert.equal(dFinal.seat_source, 'staff');

    // Case 4: 20 concurrent interleaved checkIns & createReservations on s2 -> < 10s, zero 40P01 deadlocks
    const checkInRefs = [];
    for (let i = 0; i < 10; i++) {
      const bRef = `R39-5-CON-${i}-${ts}`;
      const u = await makeUser(`ci_${i}`, `併發報到${i}`);
      createdRefs.push(bRef);
      checkInRefs.push({ bRef, seat: allSeatsInOrder[i] });
      await prisma.reservation.create({
        data: {
          booking_ref: bRef,
          session_id: s2.id,
          user_id: u.id,
          pax: 1,
          status: 'confirmed',
          attendance: null,
          is_seat_locked: false,
          seat_source: 'auto',
          assigned_seats: [allSeatsInOrder[i]]
        }
      });
    }

    const t0 = Date.now();
    const tasks = [];
    for (let i = 0; i < 10; i++) {
      const { bRef, seat } = checkInRefs[i];
      const ci = createMockReqRes({
        params: { booking_ref: bRef },
        body: { seats: [seat], start_timer: false }
      });
      tasks.push(checkIn(ci.req, ci.res).then(() => ({ kind: 'checkIn', status: ci.res.getStatusCode(), body: ci.res.getBody() })));

      // Create booking on s1's next free/wait or s2 when capacity allows (forceWait avoids layout capacity errors while still hitting Session + lockDaySeats!)
      const uOnline = await makeUser(`onl2_${i}`, `併發預約${i}`);
      const cr = createMockReqRes({
        user: { id: uOnline.id, name: uOnline.name },
        body: {
          userId: uOnline.id,
          session_ids: [s2.id],
          pax: 1,
          forceSplit: true,
          forceWait: i >= 6 // mix normal auto allocation (i < 6 fits in 16 seats) & wait
        }
      });
      tasks.push(
        createReservation(cr.req, cr.res).then(() => {
          if (cr.res.getBody()?.booking_ref) createdRefs.push(cr.res.getBody().booking_ref);
          return { kind: 'createReservation', status: cr.res.getStatusCode(), body: cr.res.getBody() };
        })
      );
    }

    const results = await Promise.all(tasks);
    const elapsedMs = Date.now() - t0;
    assert.ok(elapsedMs < 10000, `20 interleaved locks took ${elapsedMs}ms (expected < 10000ms)`);

    for (const r of results) {
      assert.ok(
        r.status === 200 || r.status === 201,
        `Unexpected interleaved failure (${r.kind}): status=${r.status} body=${JSON.stringify(r.body)}`
      );
    }
  } finally {
    const sessRes = createdSessionIds.length > 0
      ? await prisma.reservation.findMany({ where: { session_id: { in: createdSessionIds } }, select: { booking_ref: true } }).catch(() => [])
      : [];
    const allRefs = [...new Set([...createdRefs, ...sessRes.map((r) => r.booking_ref)])];
    if (allRefs.length > 0) {
      await prisma.timerPause.deleteMany({ where: { person: { booking_ref: { in: allRefs } } } }).catch(() => {});
      await prisma.bookingPerson.deleteMany({ where: { booking_ref: { in: allRefs } } }).catch(() => {});
      await prisma.bookingEquipment.deleteMany({ where: { booking_ref: { in: allRefs } } }).catch(() => {});
      await prisma.payment.deleteMany({ where: { booking_ref: { in: allRefs } } }).catch(() => {});
      await prisma.reservation.deleteMany({ where: { booking_ref: { in: allRefs } } }).catch(() => {});
    }
    if (createdSessionIds.length > 0) {
      await prisma.reservation.deleteMany({ where: { session_id: { in: createdSessionIds } } }).catch(() => {});
      await prisma.session.deleteMany({ where: { id: { in: createdSessionIds } } }).catch(() => {});
    }
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } }).catch(() => {});
    await cleanupTestPublishedLayout(prisma, layoutId);
  }
});
