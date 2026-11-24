import test from 'node:test';
import assert from 'node:assert/strict';
import prisma from '../src/prismaClient.js';
import { dateOnly } from '../../shared/time.js';
import { ensureTestPublishedLayout, cleanupTestPublishedLayout } from './helpers/seedTestLayout.js';
import { assertNoSeatCollisions } from '../src/services/seating/allocator.js';
import { getActiveLayoutForDate } from '../src/services/seating/layoutService.js';
import { checkIn } from '../src/controllers/floorController.js';
import { postCollect } from '../src/controllers/billingController.js';
import { getBookingBill } from '../src/services/billing/billService.js';
import { extendReservation } from '../src/controllers/reservationController.js';

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

test('Round 41 Item 3: extendReservation validates contiguity/date/dup, clones fields, caps paid pending supplement, and serializes concurrency', async () => {
  const ts = Date.now();
  const d1Str = '2099-11-22';
  const d2Str = '2099-11-23';
  const d1 = dateOnly(d1Str);
  const d2 = dateOnly(d2Str);

  let layoutId = null;
  let s14, s15, s16, s17, sNextDay;
  let user = null;
  const createdRefs = [];

  try {
    layoutId = await ensureTestPublishedLayout(prisma, {
      name: 'R41 Item3 Layout',
      effectiveFrom: '2020-01-01',
      effectiveDate: d1Str,
      codePrefix: 'A',
      seatCount: 4
    });

    await prisma.dailySetting.deleteMany({ where: { date: { in: [d1, d2] } } });
    await prisma.dailySetting.createMany({
      data: [
        { date: d1, allow_unlimited: true, hourly_price: 200, unlimited_price: 600 },
        { date: d2, allow_unlimited: true, hourly_price: 200, unlimited_price: 600 }
      ]
    });

    await prisma.session.deleteMany({ where: { session_date: { in: [d1, d2] } } });
    s14 = await prisma.session.create({ data: { session_date: d1, start_time: '14:00', end_time: '15:00', max_capacity: 10 } });
    s15 = await prisma.session.create({ data: { session_date: d1, start_time: '15:00', end_time: '16:00', max_capacity: 10 } });
    s16 = await prisma.session.create({ data: { session_date: d1, start_time: '16:00', end_time: '17:00', max_capacity: 10 } });
    s17 = await prisma.session.create({ data: { session_date: d1, start_time: '17:00', end_time: '18:00', max_capacity: 10 } });
    sNextDay = await prisma.session.create({ data: { session_date: d2, start_time: '14:00', end_time: '15:00', max_capacity: 10 } });

    user = await prisma.user.create({
      data: { line_user_id: `r41_3_${ts}`, name: 'R41加時客', phone: `09414${String(ts).slice(-5)}` } // check-secrets: fake-data
    });

    // Case 1: 2 pax 14:00-16:00, P1 paid 400 -> extend 16:00-17:00 -> P1 pending 200, P2 entry 600, cached fields match
    const refA = `R41-3-A-${ts}`;
    createdRefs.push(refA);
    await prisma.reservation.createMany({
      data: [s14, s15].map(s => ({
        booking_ref: refA,
        session_id: s.id,
        user_id: user.id,
        pax: 2,
        status: 'confirmed',
        assigned_seats: ['A1-1', 'A1-2']
      }))
    });
    const ciA = createMockReqRes({
      params: { booking_ref: refA },
      body: { seats: ['A1-1', 'A1-2'], start_timer: true, now: `${d1Str}T14:00:00+08:00` }
    });
    await checkIn(ciA.req, ciA.res);
    assert.equal(ciA.res.getStatusCode(), 200);

    const colP1 = createMockReqRes({
      params: { booking_ref: refA },
      body: {
        client_batch_id: `batch-p1-${ts}`,
        person_nos: [1],
        expected_amount: 400,
        expected_net_amount: 400,
        method: 'cash',
        cash_received: 400,
        print: false
      }
    });
    await postCollect(colP1.req, colP1.res);
    assert.equal(colP1.res.getStatusCode(), 200);

    // Reject cross-day extend -> 400
    const badCrossDay = createMockReqRes({
      params: { booking_ref: refA },
      body: { session_ids: [sNextDay.id], extendMode: 'keep_seat' }
    });
    await extendReservation(badCrossDay.req, badCrossDay.res);
    assert.equal(badCrossDay.res.getStatusCode(), 400);

    // Reject non-contiguous extend (17:00-18:00 skipping 16:00-17:00) -> 400
    const badGap = createMockReqRes({
      params: { booking_ref: refA },
      body: { session_ids: [s17.id], extendMode: 'keep_seat' }
    });
    await extendReservation(badGap.req, badGap.res);
    assert.equal(badGap.res.getStatusCode(), 400);

    // Valid extend 16:00-17:00
    const extA = createMockReqRes({
      params: { booking_ref: refA },
      body: { session_ids: [s16.id], extendMode: 'keep_seat' }
    });
    await extendReservation(extA.req, extA.res);
    assert.equal(extA.res.getStatusCode(), 201);

    const billA = await getBookingBill(refA);
    const p1A = billA.bill.persons.find(p => p.person_no === 1);
    const p2A = billA.bill.persons.find(p => p.person_no === 2);
    assert.equal(p1A.pending_supplement, 200);
    assert.equal(p2A.entry.amount, 600);

    const rowsA = await prisma.reservation.findMany({
      where: { booking_ref: refA },
      orderBy: { session_id: 'asc' }
    });
    assert.equal(rowsA.length, 3);
    assert.equal(rowsA[2].billing_status, rowsA[0].billing_status);
    assert.equal(rowsA[2].amount_due, rowsA[0].amount_due);
    assert.equal(rowsA[2].paid_persons, rowsA[0].paid_persons);

    // Duplicate session 16:00-17:00 -> 409, no extra row
    const dupExt = createMockReqRes({
      params: { booking_ref: refA },
      body: { session_ids: [s16.id], extendMode: 'keep_seat' }
    });
    await extendReservation(dupExt.req, dupExt.res);
    assert.equal(dupExt.res.getStatusCode(), 409);
    assert.equal(await prisma.reservation.count({ where: { booking_ref: refA } }), 3);

    // Case 2: P1 paid 400 (2h), extend 16:00-18:00 (2h -> 400+400=800, capped at unlimited 600 -> pending 200)
    const refCap = `R41-3-CAP-${ts}`;
    createdRefs.push(refCap);
    await prisma.reservation.createMany({
      data: [s14, s15].map(s => ({
        booking_ref: refCap,
        session_id: s.id,
        user_id: user.id,
        pax: 1,
        status: 'confirmed',
        assigned_seats: ['A1-3']
      }))
    });
    const ciCap = createMockReqRes({
      params: { booking_ref: refCap },
      body: { seats: ['A1-3'], start_timer: true, now: `${d1Str}T14:00:00+08:00` }
    });
    await checkIn(ciCap.req, ciCap.res);
    assert.equal(ciCap.res.getStatusCode(), 200);

    const colCap = createMockReqRes({
      params: { booking_ref: refCap },
      body: {
        client_batch_id: `batch-cap-${ts}`,
        person_nos: [1],
        expected_amount: 400,
        expected_net_amount: 400,
        method: 'cash',
        cash_received: 400,
        print: false
      }
    });
    await postCollect(colCap.req, colCap.res);
    assert.equal(colCap.res.getStatusCode(), 200);

    const extCap = createMockReqRes({
      params: { booking_ref: refCap },
      body: { session_ids: [s16.id, s17.id], extendMode: 'keep_seat' }
    });
    await extendReservation(extCap.req, extCap.res);
    assert.equal(extCap.res.getStatusCode(), 201);
    const billCap = await getBookingBill(refCap);
    assert.equal(billCap.bill.persons.find(p => p.person_no === 1).pending_supplement, 200);

    // Case 3: Concurrent extend by 2 bookings into sD2_2 where only 1 physical seat remains free -> one 201, one 400, zero collision
    const sD2_1 = sNextDay;
    const sD2_2 = await prisma.session.create({ data: { session_date: d2, start_time: '15:00', end_time: '16:00', max_capacity: 50 } });
    const d2Layout = await getActiveLayoutForDate(prisma, d2);
    const d2ActiveSeats = (d2Layout?.seats || []).filter(s => s.is_active).map(s => s.code);
    const d2Cap = (d2Layout?.capacity && d2Layout.capacity > 0) ? d2Layout.capacity : (d2ActiveSeats.length || 16);
    const blkPax = Math.max(1, d2Cap - 1);
    const refD2Blk = `R41-3-D2BLK-${ts}`;
    const refC1 = `R41-3-C1-${ts}`;
    const refC2 = `R41-3-C2-${ts}`;
    createdRefs.push(refD2Blk, refC1, refC2);
    await prisma.reservation.createMany({
      data: [
        {
          booking_ref: refD2Blk,
          session_id: sD2_2.id,
          user_id: user.id,
          pax: blkPax,
          status: 'confirmed',
          is_seat_locked: true,
          seat_source: 'staff',
          assigned_seats: d2ActiveSeats.slice(0, blkPax)
        },
        {
          booking_ref: refC1,
          session_id: sD2_1.id,
          user_id: user.id,
          pax: 1,
          status: 'confirmed',
          assigned_seats: [d2ActiveSeats[0]]
        },
        {
          booking_ref: refC2,
          session_id: sD2_1.id,
          user_id: user.id,
          pax: 1,
          status: 'confirmed',
          assigned_seats: [d2ActiveSeats[1]]
        }
      ]
    });
    const rC1 = createMockReqRes({ params: { booking_ref: refC1 }, body: { session_ids: [sD2_2.id], extendMode: 'system_allocate' } });
    const rC2 = createMockReqRes({ params: { booking_ref: refC2 }, body: { session_ids: [sD2_2.id], extendMode: 'system_allocate' } });
    await Promise.all([extendReservation(rC1.req, rC1.res), extendReservation(rC2.req, rC2.res)]);
    const concStatuses = [rC1.res.getStatusCode(), rC2.res.getStatusCode()].sort((a, b) => a - b);
    assert.deepEqual(concStatuses, [201, 400]);
    await assertNoSeatCollisions(prisma, [sD2_2.id]);
    await prisma.reservation.deleteMany({ where: { booking_ref: { in: [refD2Blk, refC1, refC2] } } });
    await prisma.session.deleteMany({ where: { id: sD2_2.id } });
  } finally {
    await prisma.payment.deleteMany({ where: { booking_ref: { in: createdRefs } } }).catch(() => {});
    await prisma.timerPause.deleteMany({ where: { person: { booking_ref: { in: createdRefs } } } }).catch(() => {});
    await prisma.bookingPerson.deleteMany({ where: { booking_ref: { in: createdRefs } } }).catch(() => {});
    await prisma.reservation.deleteMany({ where: { booking_ref: { in: createdRefs } } }).catch(() => {});
    await prisma.dailySetting.deleteMany({ where: { date: { in: [d1, d2] } } }).catch(() => {});
    for (const s of [s14, s15, s16, s17, sNextDay]) {
      if (s) await prisma.session.deleteMany({ where: { id: s.id } }).catch(() => {});
    }
    if (user) await prisma.user.deleteMany({ where: { id: user.id } }).catch(() => {});
    await cleanupTestPublishedLayout(prisma, layoutId).catch(() => {});
  }
});
