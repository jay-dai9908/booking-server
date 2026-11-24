import test from 'node:test';
import assert from 'node:assert/strict';
import prisma from '../src/prismaClient.js';
import { dateOnly } from '../../shared/time.js';
import { adminCreateReservation, createReservation, extendReservation } from '../src/controllers/reservationController.js';
import { checkIn, handleTimer } from '../src/controllers/floorController.js';
import { getBookingBill } from '../src/services/billing/billService.js';
import { getLiveFloorData } from '../src/services/floor/liveService.js';
import { syncWalkInSeatHolds } from '../src/services/seating/layoutService.js';

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

test('Round 41 Item 4: Walk-in SeatHold extension lifecycle, capacity, billing invariance, alerts, and idempotency', async () => {
  const ts = Date.now();
  const dStr = '2099-11-24';
  const d = dateOnly(dStr);
  let layout = null;
  let s14, s15, s16, s17;
  let onlineUser = null;
  let pinnedUser = null;
  let prevGlobal = null;
  const createdRefs = [];

  try {
    prevGlobal = await prisma.globalSetting.findUnique({ where: { id: 1 } });
    if (prevGlobal) {
      await prisma.globalSetting.update({
        where: { id: 1 },
        data: { billing_grace_minutes: 10, billing_block_minutes: 30, early_leave_mode: 'booked' }
      });
    } else {
      await prisma.globalSetting.create({
        data: { id: 1, billing_grace_minutes: 10, billing_block_minutes: 30, early_leave_mode: 'booked' }
      });
    }

    layout = await prisma.seatLayout.create({
      data: {
        name: `R41 Item4 1-Seat Layout ${ts}`,
        status: 'published',
        effective_from: d,
        canvas_w: 1000,
        canvas_h: 625,
        capacity: 1
      }
    });
    const zone = await prisma.seatZone.create({
      data: { layout_id: layout.id, name: 'A 區', sort_order: 0 }
    });
    const table = await prisma.seatTable.create({
      data: {
        layout_id: layout.id,
        zone_id: zone.id,
        label: 'A1',
        shape: 'long',
        arrangement: 'one_side',
        cx: 250,
        cy: 220,
        w: 60,
        h: 260,
        rotation: 0,
        sort_order: 0
      }
    });
    await prisma.seat.create({
      data: {
        layout_id: layout.id,
        table_id: table.id,
        zone_id: zone.id,
        code: 'A1-1',
        lx: -40,
        ly: 0,
        side: 'L',
        side_mode: 'auto',
        priority: 'normal',
        is_active: true,
        sort_order: 0
      }
    });

    await prisma.dailySetting.deleteMany({ where: { date: d } });
    await prisma.dailySetting.create({
      data: {
        date: d,
        allow_unlimited: true,
        hourly_price: 200,
        unlimited_price: 1000
      }
    });

    await prisma.session.deleteMany({ where: { session_date: d } });
    s14 = await prisma.session.create({ data: { session_date: d, start_time: '14:00', end_time: '15:00', max_capacity: 2 } });
    s15 = await prisma.session.create({ data: { session_date: d, start_time: '15:00', end_time: '16:00', max_capacity: 2 } });
    s16 = await prisma.session.create({ data: { session_date: d, start_time: '16:00', end_time: '17:00', max_capacity: 2 } });
    s17 = await prisma.session.create({ data: { session_date: d, start_time: '17:00', end_time: '18:00', max_capacity: 2 } });

    onlineUser = await prisma.user.create({
      data: { line_user_id: `r41_4_${ts}`, name: 'R41線上客', phone: `09415${String(ts).slice(-5)}` } // check-secrets: fake-data
    });
    pinnedUser = await prisma.user.create({
      data: { line_user_id: `r41_4_pin_${ts}`, name: '陳○○', phone: `09417${String(ts).slice(-5)}` } // check-secrets: fake-data
    });

    // 1. Repro case: 14:40 walk-in (14:00-16:00) on A1-1 -> SeatHold 16:00-17:00 until 16:40; Reservation stays 2 rows; 16:00 online gets WAIT-1
    const walkInReq = createMockReqRes({
      body: {
        name: 'R41臨時客',
        phone: `09416${String(ts).slice(-5)}`, // check-secrets: fake-data
        pax: 1,
        session_ids: [s14.id, s15.id],
        is_walk_in: true
      }
    });
    await adminCreateReservation(walkInReq.req, walkInReq.res);
    assert.equal(walkInReq.res.getStatusCode(), 201);
    const walkInRef = walkInReq.res.getBody().reservation.booking_ref;
    createdRefs.push(walkInRef);

    const ciReq = createMockReqRes({
      params: { booking_ref: walkInRef },
      body: { seats: ['A1-1'], start_timer: true, now: `${dStr}T14:40:00+08:00` }
    });
    await checkIn(ciReq.req, ciReq.res);
    assert.equal(ciReq.res.getStatusCode(), 200);
    assert.equal(ciReq.res.getBody().seat_hold_until, new Date(`${dStr}T16:40:00+08:00`).toISOString());

    const holds1 = await prisma.seatHold.findMany({ where: { booking_ref: walkInRef, status: 'active' } });
    assert.equal(holds1.length, 1);
    assert.equal(holds1[0].session_id, s16.id);
    assert.deepEqual(holds1[0].seat_codes, ['A1-1']);
    assert.equal(new Date(holds1[0].hold_until).toISOString(), new Date(`${dStr}T16:40:00+08:00`).toISOString());

    const walkInRows = await prisma.reservation.findMany({ where: { booking_ref: walkInRef } });
    assert.equal(walkInRows.length, 2, 'Walk-in Reservation rows must remain 2');

    // Online booking 16:00-17:00 (max_capacity 2 - hold 1 = 1 remaining) -> gets WAIT-1
    const online16Req = createMockReqRes({
      user: { id: onlineUser.id, name: onlineUser.name },
      body: { session_ids: [s16.id], pax: 1, forceSplit: true }
    });
    await createReservation(online16Req.req, online16Req.res);
    assert.equal(online16Req.res.getStatusCode(), 201);
    const online16Ref = online16Req.res.getBody().reservation.booking_ref;
    createdRefs.push(online16Ref);
    const online16Rows = await prisma.reservation.findMany({ where: { booking_ref: online16Ref } });
    assert.deepEqual(online16Rows[0].assigned_seats, ['WAIT-1']);

    // Clean up online16 and test Case 2 (max_capacity = 1 -> online rejected; HOLD_OVER_CAPACITY warning check)
    await prisma.reservation.deleteMany({ where: { booking_ref: online16Ref } });
    await prisma.session.update({ where: { id: s16.id }, data: { max_capacity: 1 } });

    const onlineCapFailReq = createMockReqRes({
      user: { id: onlineUser.id, name: onlineUser.name },
      body: { session_ids: [s16.id], pax: 1, forceSplit: true }
    });
    await createReservation(onlineCapFailReq.req, onlineCapFailReq.res);
    assert.equal(onlineCapFailReq.res.getStatusCode(), 409);

    // 10. Idempotency + HOLD_OVER_CAPACITY warning capture when max_capacity=0 or 1 already occupied
    // First check syncWalkInSeatHolds twice when cap=1 (holdPax <= 1 so no warn, verify count stays 1):
    const idemp1 = await prisma.$transaction(tx => syncWalkInSeatHolds(tx, walkInRef, new Date(`${dStr}T14:40:00+08:00`)));
    const idemp2 = await prisma.$transaction(tx => syncWalkInSeatHolds(tx, walkInRef, new Date(`${dStr}T14:40:00+08:00`)));
    assert.equal(idemp1.holds.length, 1);
    assert.equal(idemp2.holds.length, 1);
    assert.equal(idemp1.holds[0].id, idemp2.holds[0].id);

    // Capture HOLD_OVER_CAPACITY warning sample by temporarily reducing s16 max_capacity to 0
    await prisma.session.update({ where: { id: s16.id }, data: { max_capacity: 0 } });
    const capWarnSync = await prisma.$transaction(tx => syncWalkInSeatHolds(tx, walkInRef, new Date(`${dStr}T14:40:00+08:00`)));
    assert.equal(capWarnSync.warnings[0]?.code, 'HOLD_OVER_CAPACITY');
    console.log('SAMPLE_HOLD_OVER_CAPACITY_WARNING:', JSON.stringify(capWarnSync.warnings));
    await prisma.session.update({ where: { id: s16.id }, data: { max_capacity: 2 } });

    // 3. 17:00-18:00 online booking gets A1-1 (hold only reaches 16:40)
    const online17Req = createMockReqRes({
      user: { id: onlineUser.id, name: onlineUser.name },
      body: { session_ids: [s17.id], pax: 1 }
    });
    await createReservation(online17Req.req, online17Req.res);
    assert.equal(online17Req.res.getStatusCode(), 201);
    const online17Ref = online17Req.res.getBody().reservation.booking_ref;
    createdRefs.push(online17Ref);
    const online17Rows = await prisma.reservation.findMany({ where: { booking_ref: online17Ref } });
    assert.deepEqual(online17Rows[0].assigned_seats, ['A1-1']);
    await prisma.reservation.deleteMany({ where: { booking_ref: online17Ref } });

    // Live floor check: sessionBookedMap includes hold + booking exposes billing_end_at & seat_hold_until
    const liveData = await getLiveFloorData(dStr, new Date(`${dStr}T14:45:00+08:00`));
    const liveWalkIn = liveData.bookings.find(b => b.booking_ref === walkInRef);
    assert.equal(liveWalkIn.seat_hold_until, new Date(`${dStr}T16:40:00+08:00`).toISOString());
    assert.equal(liveWalkIn.billing_end_at, new Date(`${dStr}T16:40:00+08:00`).toISOString());
    assert.equal(liveData.sessions.find(s => s.id === s16.id).booked, 1);

    // 4. Billing invariance: 16:40 = 400, 16:50 = 400 (within 10m grace), 17:15 = 500 (35m over -> +1 unit = +100)
    const { bill: bill1640 } = await getBookingBill(walkInRef, prisma, new Date(`${dStr}T16:40:00+08:00`).getTime());
    assert.equal(bill1640.summary.amount_due, 400);
    const { bill: bill1650 } = await getBookingBill(walkInRef, prisma, new Date(`${dStr}T16:50:00+08:00`).getTime());
    assert.equal(bill1650.summary.amount_due, 400);
    const { bill: bill1715 } = await getBookingBill(walkInRef, prisma, new Date(`${dStr}T17:15:00+08:00`).getTime());
    assert.equal(bill1715.summary.amount_due, 500);

    // 8. Extend s16 (before leaving) -> formal Reservation becomes 3 rows, SeatHold on s16 becomes released, bill becomes 600
    const extReq = createMockReqRes({
      params: { booking_ref: walkInRef },
      body: { session_ids: [s16.id], extendMode: 'keep_seat' }
    });
    await extendReservation(extReq.req, extReq.res);
    assert.equal(extReq.res.getStatusCode(), 201);
    const holdS16AfterExtend = await prisma.seatHold.findMany({ where: { booking_ref: walkInRef, session_id: s16.id } });
    assert.ok(holdS16AfterExtend.length >= 1 && holdS16AfterExtend.every(h => h.status === 'released'), 'Original SeatHold on extended session 16:00 must become released');
    const holdS17AfterExtend = await prisma.seatHold.findMany({ where: { booking_ref: walkInRef, session_id: s17.id, status: 'active' } });
    assert.equal(holdS17AfterExtend.length, 1, 'Extending to 3h from 14:40 creates active SeatHold on 17:00 until 17:40');
    const walkInAfterExtend = await prisma.reservation.findMany({ where: { booking_ref: walkInRef } });
    assert.equal(walkInAfterExtend.length, 3);
    const { bill: billExt } = await getBookingBill(walkInRef, prisma, new Date(`${dStr}T17:15:00+08:00`).getTime());
    assert.equal(billExt.summary.amount_due, 600);

    // 5. Leave all at 16:10 -> active SeatHold released & new 16:00 booking gets A1-1
    // Recreate a fresh 14:40 walk-in on 14:00-16:00 (after deleting old walkInRef rows cleanly)
    await prisma.bookingPerson.deleteMany({ where: { booking_ref: walkInRef } });
    await prisma.reservation.deleteMany({ where: { booking_ref: walkInRef } });
    await prisma.seatHold.deleteMany({ where: { booking_ref: walkInRef } });

    const w2Req = createMockReqRes({
      body: { name: 'R41離場測試', phone: `09418${String(ts).slice(-5)}`, pax: 1, session_ids: [s14.id, s15.id], is_walk_in: true } // check-secrets: fake-data
    });
    await adminCreateReservation(w2Req.req, w2Req.res);
    const w2Ref = w2Req.res.getBody().reservation.booking_ref;
    createdRefs.push(w2Ref);
    const ciW2 = createMockReqRes({
      params: { booking_ref: w2Ref },
      body: { seats: ['A1-1'], start_timer: true, now: `${dStr}T14:40:00+08:00` }
    });
    await checkIn(ciW2.req, ciW2.res);
    assert.equal(ciW2.res.getStatusCode(), 200);

    const endW2 = createMockReqRes({
      params: { booking_ref: w2Ref },
      body: { action: 'end', person_nos: 'all', now: `${dStr}T16:10:00+08:00` }
    });
    await handleTimer(endW2.req, endW2.res);
    assert.equal(endW2.res.getStatusCode(), 200);
    const w2HoldsActive = await prisma.seatHold.findMany({ where: { booking_ref: w2Ref, status: 'active' } });
    assert.equal(w2HoldsActive.length, 0);

    const onlineAfterLeaveReq = createMockReqRes({
      user: { id: onlineUser.id, name: onlineUser.name },
      body: { session_ids: [s16.id], pax: 1 }
    });
    await createReservation(onlineAfterLeaveReq.req, onlineAfterLeaveReq.res);
    assert.equal(onlineAfterLeaveReq.res.getStatusCode(), 201);
    const onlineAfterLeaveRef = onlineAfterLeaveReq.res.getBody().reservation.booking_ref;
    createdRefs.push(onlineAfterLeaveRef);
    const afterLeaveRows = await prisma.reservation.findMany({ where: { booking_ref: onlineAfterLeaveRef } });
    assert.deepEqual(afterLeaveRows[0].assigned_seats, ['A1-1']);
    await prisma.reservation.deleteMany({ where: { booking_ref: onlineAfterLeaveRef } });
    await prisma.bookingPerson.deleteMany({ where: { booking_ref: w2Ref } });
    await prisma.reservation.deleteMany({ where: { booking_ref: w2Ref } });
    await prisma.seatHold.deleteMany({ where: { booking_ref: w2Ref } });

    // 6. 14:40 walk-in choosing only 14:00-15:00 (1h) -> SeatHold on 15:00-16:00 until 15:40
    const w1hReq = createMockReqRes({
      body: { name: 'R41單節客', phone: `09419${String(ts).slice(-5)}`, pax: 1, session_ids: [s14.id], is_walk_in: true } // check-secrets: fake-data
    });
    await adminCreateReservation(w1hReq.req, w1hReq.res);
    const w1hRef = w1hReq.res.getBody().reservation.booking_ref;
    createdRefs.push(w1hRef);
    const ci1h = createMockReqRes({
      params: { booking_ref: w1hRef },
      body: { seats: ['A1-1'], start_timer: true, now: `${dStr}T14:40:00+08:00` }
    });
    await checkIn(ci1h.req, ci1h.res);
    assert.equal(ci1h.res.getStatusCode(), 200);
    const holds1h = await prisma.seatHold.findMany({ where: { booking_ref: w1hRef, status: 'active' } });
    assert.equal(holds1h.length, 1);
    assert.equal(holds1h[0].session_id, s15.id);
    assert.equal(new Date(holds1h[0].hold_until).toISOString(), new Date(`${dStr}T15:40:00+08:00`).toISOString());
    await prisma.bookingPerson.deleteMany({ where: { booking_ref: w1hRef } });
    await prisma.reservation.deleteMany({ where: { booking_ref: w1hRef } });
    await prisma.seatHold.deleteMany({ where: { booking_ref: w1hRef } });

    // 7a. On-time 14:00 walk-in (14:00-16:00) -> no SeatHold
    const wOnTimeReq = createMockReqRes({
      body: { name: 'R41準時客', phone: `09410${String(ts).slice(-5)}`, pax: 1, session_ids: [s14.id, s15.id], is_walk_in: true } // check-secrets: fake-data
    });
    await adminCreateReservation(wOnTimeReq.req, wOnTimeReq.res);
    const wOnTimeRef = wOnTimeReq.res.getBody().reservation.booking_ref;
    createdRefs.push(wOnTimeRef);
    const ciOnTime = createMockReqRes({
      params: { booking_ref: wOnTimeRef },
      body: { seats: ['A1-1'], start_timer: true, now: `${dStr}T14:00:00+08:00` }
    });
    await checkIn(ciOnTime.req, ciOnTime.res);
    assert.equal(ciOnTime.res.getStatusCode(), 200);
    assert.equal(await prisma.seatHold.count({ where: { booking_ref: wOnTimeRef, status: 'active' } }), 0);
    await prisma.bookingPerson.deleteMany({ where: { booking_ref: wOnTimeRef } });
    await prisma.reservation.deleteMany({ where: { booking_ref: wOnTimeRef } });

    // 7b. Late normal reservation (is_walk_in: false, 14:00-16:00) checked in at 14:40 -> no SeatHold
    const normLateRef = `R41-NORM-${ts}`;
    createdRefs.push(normLateRef);
    await prisma.reservation.createMany({
      data: [s14, s15].map(s => ({
        booking_ref: normLateRef,
        session_id: s.id,
        user_id: onlineUser.id,
        pax: 1,
        status: 'confirmed',
        is_walk_in: false,
        assigned_seats: ['A1-1']
      }))
    });
    const ciNorm = createMockReqRes({
      params: { booking_ref: normLateRef },
      body: { seats: ['A1-1'], start_timer: true, now: `${dStr}T14:40:00+08:00` }
    });
    await checkIn(ciNorm.req, ciNorm.res);
    assert.equal(ciNorm.res.getStatusCode(), 200);
    assert.equal(await prisma.seatHold.count({ where: { booking_ref: normLateRef, status: 'active' } }), 0);
    await prisma.bookingPerson.deleteMany({ where: { booking_ref: normLateRef } });
    await prisma.reservation.deleteMany({ where: { booking_ref: normLateRef } });

    // 9. Pinned 16:00 booking (陳○○) already fixed on A1-1 -> 14:40 walk-in still creates SeatHold + HOLD_SEAT_PINNED warning + 陳○○ keeps A1-1
    const pinnedRef = `R41-PIN-${ts}`;
    createdRefs.push(pinnedRef);
    await prisma.reservation.create({
      data: {
        booking_ref: pinnedRef,
        session_id: s16.id,
        user_id: pinnedUser.id,
        pax: 1,
        status: 'confirmed',
        is_seat_locked: true,
        seat_source: 'staff',
        assigned_seats: ['A1-1']
      }
    });
    const wPinReq = createMockReqRes({
      body: { name: 'R41衝突測試客', phone: `09411${String(ts).slice(-5)}`, pax: 1, session_ids: [s14.id, s15.id], is_walk_in: true } // check-secrets: fake-data
    });
    await adminCreateReservation(wPinReq.req, wPinReq.res);
    const wPinRef = wPinReq.res.getBody().reservation.booking_ref;
    createdRefs.push(wPinRef);
    const ciPin = createMockReqRes({
      params: { booking_ref: wPinRef },
      body: { seats: ['A1-1'], start_timer: true, now: `${dStr}T14:40:00+08:00` }
    });
    await checkIn(ciPin.req, ciPin.res);
    assert.equal(ciPin.res.getStatusCode(), 200);
    const pinWarnings = ciPin.res.getBody().warnings || [];
    assert.ok(pinWarnings.some(w => w.code === 'HOLD_SEAT_PINNED'));
    console.log('SAMPLE_HOLD_SEAT_PINNED_WARNING:', JSON.stringify(pinWarnings));

    const pinnedAfter = await prisma.reservation.findFirst({ where: { booking_ref: pinnedRef } });
    assert.deepEqual(pinnedAfter.assigned_seats, ['A1-1']);

    const liveWithPin = await getLiveFloorData(dStr, new Date(`${dStr}T14:45:00+08:00`));
    assert.ok(liveWithPin.alerts.some(a => a.type === 'hold_seat_pinned' && a.text.includes('陳○○') && a.text.includes('16:40')));
  } finally {
    if (prevGlobal) {
      await prisma.globalSetting.update({
        where: { id: 1 },
        data: {
          billing_grace_minutes: prevGlobal.billing_grace_minutes,
          billing_block_minutes: prevGlobal.billing_block_minutes,
          early_leave_mode: prevGlobal.early_leave_mode
        }
      }).catch(() => {});
    }
    await prisma.seatHold.deleteMany({ where: { booking_ref: { in: createdRefs } } }).catch(() => {});
    await prisma.payment.deleteMany({ where: { booking_ref: { in: createdRefs } } }).catch(() => {});
    await prisma.timerPause.deleteMany({ where: { person: { booking_ref: { in: createdRefs } } } }).catch(() => {});
    await prisma.bookingPerson.deleteMany({ where: { booking_ref: { in: createdRefs } } }).catch(() => {});
    const resUsers = await prisma.reservation.findMany({ where: { booking_ref: { in: createdRefs } }, select: { user_id: true } }).catch(() => []);
    const userIdsToDel = [...new Set([...resUsers.map(r => r.user_id), onlineUser?.id, pinnedUser?.id].filter(Boolean))];
    await prisma.reservation.deleteMany({ where: { booking_ref: { in: createdRefs } } }).catch(() => {});
    await prisma.dailySetting.deleteMany({ where: { date: d } }).catch(() => {});
    for (const s of [s14, s15, s16, s17]) {
      if (s) await prisma.session.deleteMany({ where: { id: s.id } }).catch(() => {});
    }
    if (userIdsToDel.length > 0) await prisma.user.deleteMany({ where: { id: { in: userIdsToDel } } }).catch(() => {});
    if (layout) await prisma.seatLayout.delete({ where: { id: layout.id } }).catch(() => {});
  }
});
