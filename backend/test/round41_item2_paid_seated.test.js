import test from 'node:test';
import assert from 'node:assert/strict';
import prisma from '../src/prismaClient.js';
import { dateOnly } from '../../shared/time.js';
import { ensureTestPublishedLayout, cleanupTestPublishedLayout } from './helpers/seedTestLayout.js';
import { getLiveFloorData } from '../src/services/floor/liveService.js';
import { checkIn, handleTimer } from '../src/controllers/floorController.js';
import { postCollect } from '../src/controllers/billingController.js';
import { getBookingBill } from '../src/services/billing/billService.js';
import { markPastCheckedInAsCompleted } from '../src/cronJobs.js';
import { backfillPersonLeftAt } from '../scripts/backfill-person-left-at.mjs';
import { buildSeatStates } from '../../frontend/src/utils/admin/floorSelectors.js';

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

test('Round 41 Item 2: paid guest stays paid_seated until explicit leave, alerts after 30m, midnight cron completes, backfill is idempotent', async () => {
  const ts = Date.now();
  const prevDateStr = '2099-11-19';
  const prevDate = dateOnly(prevDateStr);
  const testDateStr = '2099-11-20';
  const testDate = dateOnly(testDateStr);

  let layoutId = null;
  let sPrev = null;
  let s1 = null;
  let s2 = null;
  let userA = null;
  let userB = null;
  const createdRefs = [];

  try {
    layoutId = await ensureTestPublishedLayout(prisma, {
      name: 'R41 Item2 Layout',
      effectiveFrom: '2020-01-01',
      effectiveDate: prevDateStr,
      codePrefix: 'A',
      seatCount: 4
    });

    await prisma.dailySetting.deleteMany({ where: { date: { in: [prevDate, testDate] } } });
    await prisma.dailySetting.createMany({
      data: [
        { date: prevDate, allow_unlimited: false, hourly_price: 100 },
        { date: testDate, allow_unlimited: false, hourly_price: 100 }
      ]
    });

    await prisma.session.deleteMany({ where: { session_date: { in: [prevDate, testDate] } } });
    sPrev = await prisma.session.create({
      data: { session_date: prevDate, start_time: '14:00', end_time: '16:00', max_capacity: 10 }
    });
    s1 = await prisma.session.create({
      data: { session_date: testDate, start_time: '14:00', end_time: '16:00', max_capacity: 10 }
    });
    s2 = await prisma.session.create({
      data: { session_date: testDate, start_time: '16:00', end_time: '18:00', max_capacity: 10 }
    });

    userA = await prisma.user.create({
      data: { line_user_id: `r41_2a_${ts}`, name: '王在座', phone: `09412${String(ts).slice(-5)}` } // check-secrets: fake-data
    });
    userB = await prisma.user.create({
      data: { line_user_id: `r41_2b_${ts}`, name: '李下一組', phone: `09413${String(ts).slice(-5)}` } // check-secrets: fake-data
    });

    const t1400 = `${testDateStr}T14:00:00+08:00`;
    const t1530 = `${testDateStr}T15:30:00+08:00`;
    const t1610 = `${testDateStr}T16:10:00+08:00`;
    const t1635 = `${testDateStr}T16:35:00+08:00`;

    // 1. Booking A checks in 14:00-16:00 on A1-1 and pays at 15:30 ("客人還沒走")
    const refA = `R41-2-A-${ts}`;
    createdRefs.push(refA);
    await prisma.reservation.create({
      data: {
        booking_ref: refA,
        session_id: s1.id,
        user_id: userA.id,
        pax: 1,
        status: 'confirmed',
        is_walk_in: false,
        assigned_seats: ['A1-1']
      }
    });
    const ciA = createMockReqRes({
      params: { booking_ref: refA },
      body: { seats: ['A1-1'], start_timer: true, now: t1400 }
    });
    await checkIn(ciA.req, ciA.res);
    assert.equal(ciA.res.getStatusCode(), 200);

    const colA = createMockReqRes({
      params: { booking_ref: refA },
      body: {
        client_batch_id: `batch-r41-2-${ts}`,
        person_nos: [1],
        expected_amount: 200,
        expected_net_amount: 200,
        method: 'cash',
        cash_received: 200,
        print: false
      }
    });
    await postCollect(colA.req, colA.res);
    assert.equal(colA.res.getStatusCode(), 200);
    const paidPersonSnap = await prisma.bookingPerson.findUnique({
      where: { booking_ref_person_no: { booking_ref: refA, person_no: 1 } }
    });
    const paymentEndedIso = paidPersonSnap.timer_ended_at.toISOString();
    assert.equal(paidPersonSnap.left_at, null);

    // At 16:10, A1-1 stays paid_seated; B trying to check in to A1-1 returns 409 SEAT_OCCUPIED
    const live1610 = await getLiveFloorData(testDateStr, new Date(t1610));
    const states1610 = buildSeatStates(live1610.layout, live1610.bookings, live1610.server_now);
    assert.equal(states1610['A1-1']?.state, 'paid_seated');

    const refB = `R41-2-B-${ts}`;
    createdRefs.push(refB);
    await prisma.reservation.create({
      data: {
        booking_ref: refB,
        session_id: s2.id,
        user_id: userB.id,
        pax: 1,
        status: 'confirmed',
        is_walk_in: false,
        assigned_seats: ['A1-1']
      }
    });
    const ciB = createMockReqRes({
      params: { booking_ref: refB },
      body: { seats: ['A1-1'], start_timer: true, now: t1610 }
    });
    await checkIn(ciB.req, ciB.res);
    assert.equal(ciB.res.getStatusCode(), 409);
    assert.equal(ciB.res.getBody().code, 'SEAT_OCCUPIED');

    // At 16:35 (>30m past 16:00), live alerts include paid_seated_overtime
    const live1635 = await getLiveFloorData(testDateStr, new Date(t1635));
    const overAlert = live1635.alerts.find(a => a.booking_ref === refA && a.type === 'paid_seated_overtime');
    assert.ok(overAlert, 'Should emit paid_seated_overtime alert after 30 minutes');
    assert.ok(overAlert.title.includes('超過預約 35 分還在座'), `Unexpected alert title: ${overAlert.title}`);

    // Click end/leave all for A at 16:35 -> left_at set, timer_ended_at preserved, bill unchanged, A1-1 becomes empty
    const billBeforeEnd = await getBookingBill(refA);
    const endA = createMockReqRes({
      params: { booking_ref: refA },
      body: { action: 'end', person_nos: 'all', now: t1635 }
    });
    await handleTimer(endA.req, endA.res);
    assert.equal(endA.res.getStatusCode(), 200);

    const leftPersonSnap = await prisma.bookingPerson.findUnique({
      where: { booking_ref_person_no: { booking_ref: refA, person_no: 1 } }
    });
    assert.equal(leftPersonSnap.left_at.toISOString(), new Date(t1635).toISOString());
    assert.equal(leftPersonSnap.timer_ended_at.toISOString(), paymentEndedIso);

    const billAfterEnd = await getBookingBill(refA);
    assert.equal(billAfterEnd.bill.summary.amount_due, billBeforeEnd.bill.summary.amount_due);

    const liveAfterLeave = await getLiveFloorData(testDateStr, new Date(t1635));
    const statesAfterLeave = buildSeatStates(liveAfterLeave.layout, liveAfterLeave.bookings, liveAfterLeave.server_now);
    assert.equal(statesAfterLeave['A1-1']?.state, 'reserved');
    assert.equal(statesAfterLeave['A1-1']?.bookingRef, refB);

    // Cancel refB and confirm seat A1-1 is empty, or verify check-in on refB now succeeds
    const ciBAfterLeave = createMockReqRes({
      params: { booking_ref: refB },
      body: { seats: ['A1-1'], start_timer: true, now: t1635 }
    });
    await checkIn(ciBAfterLeave.req, ciBAfterLeave.res);
    assert.equal(ciBAfterLeave.res.getStatusCode(), 200);

    await prisma.bookingPerson.deleteMany({ where: { booking_ref: refB } });
    await prisma.reservation.deleteMany({ where: { booking_ref: refB } });
    const liveNoB = await getLiveFloorData(testDateStr, new Date(t1635));
    const statesNoB = buildSeatStates(liveNoB.layout, liveNoB.bookings, liveNoB.server_now);
    assert.equal(statesNoB['A1-1']?.state, 'empty');

    // 2. Midnight cron completes yesterday's checked_in paid booking without touching amounts
    const refPrev = `R41-2-CRON-${ts}`;
    createdRefs.push(refPrev);
    await prisma.reservation.create({
      data: {
        booking_ref: refPrev,
        session_id: sPrev.id,
        user_id: userA.id,
        pax: 1,
        status: 'confirmed',
        attendance: 'checked_in',
        is_paid: true,
        billing_status: 'paid',
        total_amount: 200,
        amount_due: 200,
        amount_received: 200,
        assigned_seats: ['A1-2']
      }
    });
    await prisma.bookingPerson.create({
      data: {
        booking_ref: refPrev,
        person_no: 1,
        seat_code: 'A1-2',
        status: 'active',
        timer_started_at: new Date(`${prevDateStr}T14:00:00+08:00`),
        timer_ended_at: new Date(`${prevDateStr}T15:15:00+08:00`),
        left_at: null
      }
    });
    const cronRes = await markPastCheckedInAsCompleted(new Date(`${testDateStr}T00:00:05+08:00`));
    assert.ok(cronRes.bookingCount >= 1);
    const prevAfterCron = await prisma.reservation.findFirst({ where: { booking_ref: refPrev } });
    assert.equal(prevAfterCron.attendance, 'completed');
    assert.equal(prevAfterCron.amount_received, 200);
    const prevPersonCron = await prisma.bookingPerson.findUnique({
      where: { booking_ref_person_no: { booking_ref: refPrev, person_no: 1 } }
    });
    assert.equal(prevPersonCron.left_at.toISOString(), new Date(`${prevDateStr}T15:15:00+08:00`).toISOString());

    // 3. Backfill script: dry-run reports eligible without writing, --apply writes, 2nd run updates 0
    const refBackfill = `R41-2-BF-${ts}`;
    createdRefs.push(refBackfill);
    await prisma.reservation.create({
      data: {
        booking_ref: refBackfill,
        session_id: s1.id,
        user_id: userB.id,
        pax: 1,
        status: 'confirmed',
        attendance: 'completed',
        assigned_seats: ['A1-3']
      }
    });
    await prisma.bookingPerson.create({
      data: {
        booking_ref: refBackfill,
        person_no: 1,
        seat_code: 'A1-3',
        status: 'active',
        timer_started_at: new Date(t1400),
        timer_ended_at: new Date(t1530),
        left_at: null
      }
    });

    const dryRes = await backfillPersonLeftAt({ dryRun: true, client: prisma, now: new Date(t1635) });
    assert.ok(dryRes.sample.some(s => s.booking_ref === refBackfill));
    assert.equal(dryRes.updated, 0);
    assert.equal((await prisma.bookingPerson.findUnique({ where: { booking_ref_person_no: { booking_ref: refBackfill, person_no: 1 } } })).left_at, null);

    const applyRes = await backfillPersonLeftAt({ dryRun: false, client: prisma, now: new Date(t1635) });
    assert.ok(applyRes.updated >= 1);
    assert.equal(
      (await prisma.bookingPerson.findUnique({ where: { booking_ref_person_no: { booking_ref: refBackfill, person_no: 1 } } })).left_at.toISOString(),
      new Date(t1530).toISOString()
    );

    const secondRes = await backfillPersonLeftAt({ dryRun: false, client: prisma, now: new Date(t1635) });
    assert.equal(secondRes.sample.some(s => s.booking_ref === refBackfill), false);
    assert.equal(secondRes.updated, 0);
  } finally {
    await prisma.payment.deleteMany({ where: { booking_ref: { in: createdRefs } } }).catch(() => {});
    await prisma.timerPause.deleteMany({ where: { person: { booking_ref: { in: createdRefs } } } }).catch(() => {});
    await prisma.bookingPerson.deleteMany({ where: { booking_ref: { in: createdRefs } } }).catch(() => {});
    await prisma.reservation.deleteMany({ where: { booking_ref: { in: createdRefs } } }).catch(() => {});
    await prisma.dailySetting.deleteMany({ where: { date: { in: [prevDate, testDate] } } }).catch(() => {});
    if (sPrev) await prisma.session.deleteMany({ where: { id: sPrev.id } }).catch(() => {});
    if (s1) await prisma.session.deleteMany({ where: { id: s1.id } }).catch(() => {});
    if (s2) await prisma.session.deleteMany({ where: { id: s2.id } }).catch(() => {});
    if (userA) await prisma.user.deleteMany({ where: { id: userA.id } }).catch(() => {});
    if (userB) await prisma.user.deleteMany({ where: { id: userB.id } }).catch(() => {});
    await cleanupTestPublishedLayout(prisma, layoutId).catch(() => {});
  }
});
