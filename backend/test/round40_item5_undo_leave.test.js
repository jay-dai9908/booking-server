import test from 'node:test';
import assert from 'node:assert/strict';
import prisma from '../src/prismaClient.js';
import { dateOnly, toTaipeiDateString } from '../../shared/time.js';
import { ensureTestPublishedLayout, cleanupTestPublishedLayout } from './helpers/seedTestLayout.js';
import { loadAllocatorContext } from '../src/services/seating/layoutService.js';
import { checkIn, handleTimer } from '../src/controllers/floorController.js';
import { postCollect } from '../src/controllers/billingController.js';

function createMockReqRes({ body = {}, params = {}, query = {}, user = { id: 1, name: 'R40店員' } } = {}) {
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

test('Round 40 Item 5: undo_leave_all restores group_left persons with lock, seat occupancy, paid, and today guards', async () => {
  const ts = Date.now();
  const realNow = new Date();
  const todayStr = toTaipeiDateString(realNow);
  const tomorrowDt = new Date(realNow.getTime() + 24 * 60 * 60 * 1000);
  const tomorrowStr = toTaipeiDateString(tomorrowDt);
  const todayDate = dateOnly(todayStr);

  let layoutId = null;
  let s1 = null;
  let user = null;
  const createdRefs = [];

  try {
    layoutId = await ensureTestPublishedLayout(prisma, {
      name: 'R40 Item5 Layout',
      effectiveFrom: '2020-01-01',
      effectiveDate: todayStr,
      codePrefix: 'A',
      seatCount: 8
    });

    await prisma.dailySetting.deleteMany({ where: { date: todayDate } });
    await prisma.dailySetting.create({
      data: {
        date: todayDate,
        allow_unlimited: false,
        hourly_price: 100,
        unlimited_price: null
      }
    });

    await prisma.session.deleteMany({ where: { session_date: todayDate } });
    s1 = await prisma.session.create({
      data: { session_date: todayDate, start_time: '13:00', end_time: '16:00', max_capacity: 20 }
    });

    user = await prisma.user.create({
      data: { line_user_id: `r40_5_${ts}`, name: 'R40復原離場', phone: `09405${String(ts).slice(-5)}` } // check-secrets: fake-data
    });

    const ctx = await loadAllocatorContext(prisma, todayDate);
    const activeSeats = (ctx.layout?.seats || []).filter((s) => s.is_active).map((s) => s.code);
    assert.ok(activeSeats.length >= 6);

    const t1300 = `${todayStr}T13:00:00+08:00`;
    const t1400 = `${todayStr}T14:00:00+08:00`;
    const t1500 = `${todayStr}T15:00:00+08:00`;
    const t1505 = `${todayStr}T15:05:00+08:00`;
    const tTomorrow1000 = `${tomorrowStr}T10:00:00+08:00`;

    // Booking A: 3 persons start at 13:00; P1 leaves at 14:00; all leave at 15:00
    const refA = `R40-5-A-${ts}`;
    createdRefs.push(refA);
    await prisma.reservation.create({
      data: {
        booking_ref: refA,
        session_id: s1.id,
        user_id: user.id,
        pax: 3,
        status: 'confirmed',
        is_walk_in: false,
        assigned_seats: activeSeats.slice(0, 3)
      }
    });

    const ciA = createMockReqRes({
      params: { booking_ref: refA },
      body: { seats: activeSeats.slice(0, 3), start_timer: true, now: t1300 }
    });
    await checkIn(ciA.req, ciA.res);
    assert.equal(ciA.res.getStatusCode(), 200);

    const endP1 = createMockReqRes({
      params: { booking_ref: refA },
      body: { action: 'end', person_nos: [1], now: t1400 }
    });
    await handleTimer(endP1.req, endP1.res);
    assert.equal(endP1.res.getStatusCode(), 200);

    const endAllA = createMockReqRes({
      params: { booking_ref: refA },
      body: { action: 'end', person_nos: 'all', now: t1500 }
    });
    await handleTimer(endAllA.req, endAllA.res);
    assert.equal(endAllA.res.getStatusCode(), 200);

    // Undo at 15:05
    const undoA = createMockReqRes({
      params: { booking_ref: refA },
      body: { action: 'undo_leave_all', now: t1505 }
    });
    await handleTimer(undoA.req, undoA.res);
    assert.equal(undoA.res.getStatusCode(), 200);

    const personsA = await prisma.bookingPerson.findMany({
      where: { booking_ref: refA },
      orderBy: { person_no: 'asc' }
    });
    assert.equal(personsA[0].timer_ended_at.toISOString(), new Date(t1400).toISOString());
    assert.equal(personsA[1].timer_ended_at, null);
    assert.equal(personsA[2].timer_ended_at, null);

    const resA = await prisma.reservation.findFirst({ where: { booking_ref: refA } });
    assert.equal(resA.attendance, 'checked_in');

    const groupLeftEvt = await prisma.accountingEvent.findFirst({
      where: { booking_ref: refA, event_type: 'group_left' },
      orderBy: { id: 'desc' }
    });
    const groupUndoneEvt = await prisma.accountingEvent.findFirst({
      where: { booking_ref: refA, event_type: 'group_leave_undone' },
      orderBy: { id: 'desc' }
    });
    assert.ok(groupLeftEvt, 'group_left AccountingEvent should exist');
    assert.deepEqual(groupLeftEvt.after_json?.person_nos, [2, 3]);
    assert.ok(groupUndoneEvt, 'group_leave_undone AccountingEvent should exist');

    // Sending undo_leave_all again fails with 409 (already undone / not completed)
    const undoA2 = createMockReqRes({
      params: { booking_ref: refA },
      body: { action: 'undo_leave_all', now: t1505 }
    });
    await handleTimer(undoA2.req, undoA2.res);
    assert.equal(undoA2.res.getStatusCode(), 409);

    // Booking B: end all -> collect payment -> undo_leave_all -> 409
    const refB = `R40-5-B-${ts}`;
    createdRefs.push(refB);
    await prisma.reservation.create({
      data: {
        booking_ref: refB,
        session_id: s1.id,
        user_id: user.id,
        pax: 1,
        status: 'confirmed',
        is_walk_in: false,
        assigned_seats: [activeSeats[3]]
      }
    });
    const ciB = createMockReqRes({
      params: { booking_ref: refB },
      body: { seats: [activeSeats[3]], start_timer: true, now: t1300 }
    });
    await checkIn(ciB.req, ciB.res);
    assert.equal(ciB.res.getStatusCode(), 200);

    const endAllB = createMockReqRes({
      params: { booking_ref: refB },
      body: { action: 'end', person_nos: 'all', now: t1500 }
    });
    await handleTimer(endAllB.req, endAllB.res);
    assert.equal(endAllB.res.getStatusCode(), 200);

    const colB = createMockReqRes({
      params: { booking_ref: refB },
      body: {
        client_batch_id: `batch-b-${ts}`,
        person_nos: [1],
        expected_amount: 300,
        expected_net_amount: 300,
        method: 'cash',
        cash_received: 300,
        print: false
      }
    });
    await postCollect(colB.req, colB.res);
    assert.equal(colB.res.getStatusCode(), 200);

    const undoB = createMockReqRes({
      params: { booking_ref: refB },
      body: { action: 'undo_leave_all', now: t1505 }
    });
    await handleTimer(undoB.req, undoB.res);
    assert.equal(undoB.res.getStatusCode(), 409);
    const resB = await prisma.reservation.findFirst({ where: { booking_ref: refB } });
    assert.equal(resB.attendance, 'completed');

    // Booking C: end all -> Booking D takes its seat activeSeats[4] -> undo_leave_all -> 409 SEAT_OCCUPIED
    const refC = `R40-5-C-${ts}`;
    const refD = `R40-5-D-${ts}`;
    createdRefs.push(refC, refD);
    await prisma.reservation.createMany({
      data: [
        {
          booking_ref: refC,
          session_id: s1.id,
          user_id: user.id,
          pax: 1,
          status: 'confirmed',
          is_walk_in: false,
          assigned_seats: [activeSeats[4]]
        },
        {
          booking_ref: refD,
          session_id: s1.id,
          user_id: user.id,
          pax: 1,
          status: 'confirmed',
          is_walk_in: false,
          assigned_seats: [activeSeats[4]]
        }
      ]
    });
    const ciC = createMockReqRes({
      params: { booking_ref: refC },
      body: { seats: [activeSeats[4]], start_timer: true, now: t1300 }
    });
    await checkIn(ciC.req, ciC.res);
    assert.equal(ciC.res.getStatusCode(), 200);

    const endAllC = createMockReqRes({
      params: { booking_ref: refC },
      body: { action: 'end', person_nos: 'all', now: t1500 }
    });
    await handleTimer(endAllC.req, endAllC.res);
    assert.equal(endAllC.res.getStatusCode(), 200);

    const ciD = createMockReqRes({
      params: { booking_ref: refD },
      body: { seats: [activeSeats[4]], start_timer: true, now: t1505 }
    });
    await checkIn(ciD.req, ciD.res);
    assert.equal(ciD.res.getStatusCode(), 200);

    const undoC = createMockReqRes({
      params: { booking_ref: refC },
      body: { action: 'undo_leave_all', now: t1505 }
    });
    await handleTimer(undoC.req, undoC.res);
    assert.equal(undoC.res.getStatusCode(), 409);
    assert.equal(undoC.res.getBody().code, 'SEAT_OCCUPIED');

    // Booking A ends all again -> next day 10:00 sends undo_leave_all -> 409 NOT_TODAY
    const endAllA2 = createMockReqRes({
      params: { booking_ref: refA },
      body: { action: 'end', person_nos: 'all', now: t1505 }
    });
    await handleTimer(endAllA2.req, endAllA2.res);
    assert.equal(endAllA2.res.getStatusCode(), 200);

    const undoTomorrow = createMockReqRes({
      params: { booking_ref: refA },
      body: { action: 'undo_leave_all', now: tTomorrow1000 }
    });
    await handleTimer(undoTomorrow.req, undoTomorrow.res);
    assert.equal(undoTomorrow.res.getStatusCode(), 409);

    // Booking E: legacy group without group_left audit log -> falls back to latest second timer_ended_at
    const refE = `R40-5-E-${ts}`;
    createdRefs.push(refE);
    await prisma.reservation.create({
      data: {
        booking_ref: refE,
        session_id: s1.id,
        user_id: user.id,
        pax: 2,
        status: 'confirmed',
        attendance: 'completed',
        is_walk_in: false,
        assigned_seats: [activeSeats[5], activeSeats[6]]
      }
    });
    await prisma.bookingPerson.createMany({
      data: [
        {
          booking_ref: refE,
          person_no: 1,
          seat_code: activeSeats[5],
          status: 'active',
          timer_started_at: new Date(t1300),
          timer_ended_at: new Date(t1400)
        },
        {
          booking_ref: refE,
          person_no: 2,
          seat_code: activeSeats[6],
          status: 'active',
          timer_started_at: new Date(t1300),
          timer_ended_at: new Date(t1500)
        }
      ]
    });
    // End refD first or ensure seats are free (refE uses [5],[6], refA holds [0..2], refD holds [4])
    const undoE = createMockReqRes({
      params: { booking_ref: refE },
      body: { action: 'undo_leave_all', now: t1505 }
    });
    await handleTimer(undoE.req, undoE.res);
    assert.equal(undoE.res.getStatusCode(), 200);

    const personsE = await prisma.bookingPerson.findMany({
      where: { booking_ref: refE },
      orderBy: { person_no: 'asc' }
    });
    assert.equal(personsE[0].timer_ended_at.toISOString(), new Date(t1400).toISOString());
    assert.equal(personsE[1].timer_ended_at, null);
  } finally {
    await prisma.payment.deleteMany({ where: { booking_ref: { in: createdRefs } } }).catch(() => {});
    await prisma.timerPause.deleteMany({ where: { person: { booking_ref: { in: createdRefs } } } }).catch(() => {});
    await prisma.bookingPerson.deleteMany({ where: { booking_ref: { in: createdRefs } } }).catch(() => {});
    await prisma.reservation.deleteMany({ where: { booking_ref: { in: createdRefs } } }).catch(() => {});
    await prisma.dailySetting.deleteMany({ where: { date: todayDate } }).catch(() => {});
    if (s1) await prisma.session.deleteMany({ where: { id: s1.id } }).catch(() => {});
    if (user) await prisma.user.deleteMany({ where: { id: user.id } }).catch(() => {});
    await cleanupTestPublishedLayout(prisma, layoutId).catch(() => {});
  }
});
