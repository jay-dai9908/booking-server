import test from 'node:test';
import assert from 'node:assert/strict';
import prisma from '../src/prismaClient.js';
import { dateOnly } from '../../shared/time.js';
import { computeBill } from '../../shared/billing.js';
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

test('Round 40 Item 1: group pause skips already-ended and unstarted persons, and end preserves earlier timer_ended_at', async () => {
  const ts = Date.now();
  const testDateStr = '2099-11-10';
  const testDate = dateOnly(testDateStr);
  let layoutId = null;
  let session1 = null;
  let user = null;
  const bookingRef = `R40-1-${ts}`;

  try {
    layoutId = await ensureTestPublishedLayout(prisma, {
      name: 'R40 Item1 Layout',
      effectiveFrom: '2020-01-01',
      effectiveDate: testDateStr,
      codePrefix: 'A',
      seatCount: 8
    });

    await prisma.session.deleteMany({ where: { session_date: testDate } });
    session1 = await prisma.session.create({
      data: { session_date: testDate, start_time: '13:00', end_time: '16:00', max_capacity: 10 }
    });
    user = await prisma.user.create({
      data: { line_user_id: `r40_1_${ts}`, name: 'R40測試三人', phone: `09401${String(ts).slice(-5)}` } // check-secrets: fake-data
    });

    const ctx = await loadAllocatorContext(prisma, testDate);
    const seats = (ctx.layout?.seats || []).filter((s) => s.is_active).slice(0, 3).map((s) => s.code);
    assert.equal(seats.length, 3);

    await prisma.reservation.create({
      data: {
        booking_ref: bookingRef,
        session_id: session1.id,
        user_id: user.id,
        pax: 3,
        status: 'confirmed',
        assigned_seats: seats,
        is_seat_locked: false,
        seat_source: 'auto'
      }
    });

    const t1300 = '2099-11-10T13:00:00+08:00';
    const t1500 = '2099-11-10T15:00:00+08:00';
    const t1510 = '2099-11-10T15:10:00+08:00';
    const t1530 = '2099-11-10T15:30:00+08:00';

    const ci = createMockReqRes({
      params: { booking_ref: bookingRef },
      body: { seats, start_timer: true, now: t1300 }
    });
    await checkIn(ci.req, ci.res);
    assert.equal(ci.res.getStatusCode(), 200);

    // Person 1 leaves at 15:00
    const leave1 = createMockReqRes({
      params: { booking_ref: bookingRef },
      body: { action: 'end', person_nos: [1], now: t1500 }
    });
    await handleTimer(leave1.req, leave1.res);
    assert.equal(leave1.res.getStatusCode(), 200);

    // 15:10 pause 'all' -> Person 1 skipped, Persons 2 & 3 paused
    const pauseAll = createMockReqRes({
      params: { booking_ref: bookingRef },
      body: { action: 'pause', person_nos: 'all', now: t1510 }
    });
    await handleTimer(pauseAll.req, pauseAll.res);
    assert.equal(pauseAll.res.getStatusCode(), 200);

    const personsAfterPause = await prisma.bookingPerson.findMany({
      where: { booking_ref: bookingRef },
      include: { pauses: true },
      orderBy: { person_no: 'asc' }
    });
    assert.equal(personsAfterPause[0].pauses.length, 0);
    assert.equal(personsAfterPause[0].paused_at, null);
    assert.equal(personsAfterPause[1].pauses.length, 1);
    assert.equal(personsAfterPause[2].pauses.length, 1);

    // Pausing only already-departed Person 1 -> 409 NOTHING_TO_PAUSE
    const pause1Only = createMockReqRes({
      params: { booking_ref: bookingRef },
      body: { action: 'pause', person_nos: [1], now: t1510 }
    });
    await handleTimer(pause1Only.req, pause1Only.res);
    assert.equal(pause1Only.res.getStatusCode(), 409);
    assert.equal(pause1Only.res.getBody()?.code, 'NOTHING_TO_PAUSE');

    // 15:30 end 'all' -> Person 1 stays 15:00 & paused_seconds=0; Persons 2 & 3 at 15:30 & paused_seconds=1200
    const endAll = createMockReqRes({
      params: { booking_ref: bookingRef },
      body: { action: 'end', person_nos: 'all', now: t1530 }
    });
    await handleTimer(endAll.req, endAll.res);
    assert.equal(endAll.res.getStatusCode(), 200);

    const finalPersons = await prisma.bookingPerson.findMany({
      where: { booking_ref: bookingRef },
      orderBy: { person_no: 'asc' }
    });
    assert.equal(finalPersons[0].timer_ended_at.toISOString(), new Date(t1500).toISOString());
    assert.equal(finalPersons[0].paused_seconds, 0);
    assert.equal(finalPersons[1].timer_ended_at.toISOString(), new Date(t1530).toISOString());
    assert.equal(finalPersons[1].paused_seconds, 1200);
    assert.equal(finalPersons[2].timer_ended_at.toISOString(), new Date(t1530).toISOString());
    assert.equal(finalPersons[2].paused_seconds, 1200);

    // Verify computeBill keeps person 1 actual_minutes = 120
    const bill = computeBill({
      booking: {
        booking_ref: bookingRef,
        pax: 3,
        booked_hours: 3,
        sessions: [{ start_at: t1300, end_at: '2099-11-10T16:00:00+08:00' }],
        early_leave_mode: 'actual'
      },
      persons: finalPersons.map((p) => ({
        person_no: p.person_no,
        status: p.status,
        timer: {
          billing_start_at: p.billing_start_at,
          timer_started_at: p.timer_started_at,
          timer_ended_at: p.timer_ended_at,
          paused_at: p.paused_at,
          paused_seconds: p.paused_seconds
        }
      })),
      pricing: { hourly_price: 150, unlimited_price: 750, allow_unlimited: true, discount: {} },
      now: new Date(t1530)
    });
    const billP1 = bill.persons.find((p) => p.person_no === 1);
    assert.equal(billP1.entry.actual_minutes, 120);
  } finally {
    await prisma.timerPause.deleteMany({ where: { person: { booking_ref: bookingRef } } }).catch(() => {});
    await prisma.bookingPerson.deleteMany({ where: { booking_ref: bookingRef } }).catch(() => {});
    await prisma.reservation.deleteMany({ where: { booking_ref: bookingRef } }).catch(() => {});
    if (session1) await prisma.session.deleteMany({ where: { id: session1.id } }).catch(() => {});
    if (user) await prisma.user.deleteMany({ where: { id: user.id } }).catch(() => {});
    await cleanupTestPublishedLayout(prisma, layoutId).catch(() => {});
  }
});
