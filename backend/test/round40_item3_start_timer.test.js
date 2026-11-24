import test from 'node:test';
import assert from 'node:assert/strict';
import prisma from '../src/prismaClient.js';
import { dateOnly } from '../../shared/time.js';
import { ensureTestPublishedLayout, cleanupTestPublishedLayout } from './helpers/seedTestLayout.js';
import { loadAllocatorContext } from '../src/services/seating/layoutService.js';
import { checkIn, handleTimer } from '../src/controllers/floorController.js';

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

test('Round 40 Item 3: start timer action sets timer_started_at and billing_start_at cleanly', async () => {
  const ts = Date.now();
  const testDateStr = '2099-11-12';
  const testDate = dateOnly(testDateStr);
  let layoutId = null;
  let session1 = null;
  let user = null;
  const createdRefs = [];

  try {
    layoutId = await ensureTestPublishedLayout(prisma, {
      name: 'R40 Item3 Layout',
      effectiveFrom: '2020-01-01',
      effectiveDate: testDateStr,
      codePrefix: 'A',
      seatCount: 8
    });

    await prisma.session.deleteMany({ where: { session_date: testDate } });
    session1 = await prisma.session.create({
      data: { session_date: testDate, start_time: '14:00', end_time: '16:00', max_capacity: 10 }
    });
    user = await prisma.user.create({
      data: { line_user_id: `r40_3_${ts}`, name: 'R40開始計時', phone: `09403${String(ts).slice(-5)}` } // check-secrets: fake-data
    });

    const ctx = await loadAllocatorContext(prisma, testDate);
    const activeSeats = (ctx.layout?.seats || []).filter((s) => s.is_active).map((s) => s.code);
    assert.ok(activeSeats.length >= 6);

    const t1400 = '2099-11-12T14:00:00+08:00';
    const t1405 = '2099-11-12T14:05:00+08:00';
    const t1420 = '2099-11-12T14:20:00+08:00';
    const t1430 = '2099-11-12T14:30:00+08:00';

    // 1. Regular 2-pax booking checked in at 14:05 with start_timer: false -> 14:20 start all
    const refReg = `R40-3-REG-${ts}`;
    createdRefs.push(refReg);
    await prisma.reservation.create({
      data: {
        booking_ref: refReg,
        session_id: session1.id,
        user_id: user.id,
        pax: 2,
        status: 'confirmed',
        is_walk_in: false,
        assigned_seats: activeSeats.slice(0, 2)
      }
    });

    const ciReg = createMockReqRes({
      params: { booking_ref: refReg },
      body: { seats: activeSeats.slice(0, 2), start_timer: false, now: t1405 }
    });
    await checkIn(ciReg.req, ciReg.res);
    assert.equal(ciReg.res.getStatusCode(), 200);

    const startReg = createMockReqRes({
      params: { booking_ref: refReg },
      body: { action: 'start', person_nos: 'all', now: t1420 }
    });
    await handleTimer(startReg.req, startReg.res);
    assert.equal(startReg.res.getStatusCode(), 200);

    const regPersons = await prisma.bookingPerson.findMany({
      where: { booking_ref: refReg },
      orderBy: { person_no: 'asc' }
    });
    for (const p of regPersons) {
      assert.equal(p.timer_started_at.toISOString(), new Date(t1420).toISOString());
      assert.equal(p.billing_start_at.toISOString(), new Date(t1400).toISOString());
    }

    const startEvt = await prisma.accountingEvent.findFirst({
      where: { booking_ref: refReg, event_type: 'timer_started' }
    });
    assert.ok(startEvt);

    // 3. Re-sending start -> 409 NOTHING_TO_START, timestamps unchanged
    const startAgain = createMockReqRes({
      params: { booking_ref: refReg },
      body: { action: 'start', person_nos: 'all', now: t1430 }
    });
    await handleTimer(startAgain.req, startAgain.res);
    assert.equal(startAgain.res.getStatusCode(), 409);
    assert.equal(startAgain.res.getBody()?.code, 'NOTHING_TO_START');

    const regPersonsAfter = await prisma.bookingPerson.findMany({
      where: { booking_ref: refReg },
      orderBy: { person_no: 'asc' }
    });
    assert.equal(regPersonsAfter[0].timer_started_at.toISOString(), new Date(t1420).toISOString());

    // 2. Walk-in 1-pax checked in with start_timer: false -> 14:20 start -> billing_start_at = 14:20
    const refWalkIn = `R40-3-WI-${ts}`;
    createdRefs.push(refWalkIn);
    await prisma.reservation.create({
      data: {
        booking_ref: refWalkIn,
        session_id: session1.id,
        user_id: user.id,
        pax: 1,
        status: 'confirmed',
        is_walk_in: true,
        assigned_seats: [activeSeats[2]]
      }
    });

    const ciWi = createMockReqRes({
      params: { booking_ref: refWalkIn },
      body: { seats: [activeSeats[2]], start_timer: false, now: t1405 }
    });
    await checkIn(ciWi.req, ciWi.res);
    assert.equal(ciWi.res.getStatusCode(), 200);

    const startWi = createMockReqRes({
      params: { booking_ref: refWalkIn },
      body: { action: 'start', person_nos: 'all', now: t1420 }
    });
    await handleTimer(startWi.req, startWi.res);
    assert.equal(startWi.res.getStatusCode(), 200);

    const wiPerson = await prisma.bookingPerson.findUnique({
      where: { booking_ref_person_no: { booking_ref: refWalkIn, person_no: 1 } }
    });
    assert.equal(wiPerson.timer_started_at.toISOString(), new Date(t1420).toISOString());
    assert.equal(wiPerson.billing_start_at.toISOString(), new Date(t1420).toISOString());

    // 4. Booking where person 2 already paid -> start 'all' starts only person 1
    const refPaid = `R40-3-PAID-${ts}`;
    createdRefs.push(refPaid);
    await prisma.reservation.create({
      data: {
        booking_ref: refPaid,
        session_id: session1.id,
        user_id: user.id,
        pax: 2,
        status: 'confirmed',
        is_walk_in: false,
        assigned_seats: activeSeats.slice(3, 5)
      }
    });
    await prisma.payment.create({
      data: {
        payment_no: `PAY-R40-3-${ts}`,
        batch_no: `BAT-R40-3-${ts}`,
        booking_ref: refPaid,
        kind: 'charge',
        status: 'valid',
        method: 'cash',
        amount: 300,
        person_nos: [2],
        staff_name: 'tester',
        device_label: 'POS',
        breakdown_json: {}
      }
    });

    const ciPaid = createMockReqRes({
      params: { booking_ref: refPaid },
      body: { seats: activeSeats.slice(3, 5), start_timer: false, now: t1405 }
    });
    await checkIn(ciPaid.req, ciPaid.res);
    assert.equal(ciPaid.res.getStatusCode(), 200);

    const startPaid = createMockReqRes({
      params: { booking_ref: refPaid },
      body: { action: 'start', person_nos: 'all', now: t1420 }
    });
    await handleTimer(startPaid.req, startPaid.res);
    assert.equal(startPaid.res.getStatusCode(), 200);

    const paidPersons = await prisma.bookingPerson.findMany({
      where: { booking_ref: refPaid },
      orderBy: { person_no: 'asc' }
    });
    assert.equal(paidPersons[0].timer_started_at.toISOString(), new Date(t1420).toISOString());
    assert.equal(paidPersons[1].timer_started_at, null);
  } finally {
    await prisma.payment.deleteMany({ where: { booking_ref: { in: createdRefs } } }).catch(() => {});
    await prisma.timerPause.deleteMany({ where: { person: { booking_ref: { in: createdRefs } } } }).catch(() => {});
    await prisma.bookingPerson.deleteMany({ where: { booking_ref: { in: createdRefs } } }).catch(() => {});
    await prisma.reservation.deleteMany({ where: { booking_ref: { in: createdRefs } } }).catch(() => {});
    if (session1) await prisma.session.deleteMany({ where: { id: session1.id } }).catch(() => {});
    if (user) await prisma.user.deleteMany({ where: { id: user.id } }).catch(() => {});
    await cleanupTestPublishedLayout(prisma, layoutId).catch(() => {});
  }
});
