import test from 'node:test';
import assert from 'node:assert/strict';
import prisma from '../src/prismaClient.js';
import { dateOnly, toTaipeiDateString } from '../../shared/time.js';
import { ensureTestPublishedLayout, cleanupTestPublishedLayout } from './helpers/seedTestLayout.js';
import { loadAllocatorContext } from '../src/services/seating/layoutService.js';
import { checkIn } from '../src/controllers/floorController.js';
import { updateAttendance } from '../src/controllers/reservationController.js';
import { getBookingBill } from '../src/services/billing/billService.js';

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

test('Round 41 Item 1: cancel check-in clears person_id on boards, closes pauses, guards states/dates, and is concurrency safe', async () => {
  const ts = Date.now();
  const realNow = new Date();
  const todayStr = toTaipeiDateString(realNow);
  const todayDate = dateOnly(todayStr);

  let layoutId = null;
  let s1 = null;
  let user = null;
  const eqId = `r41-i1-eq-${ts}`;
  const createdRefs = [];

  try {
    layoutId = await ensureTestPublishedLayout(prisma, {
      name: 'R41 Item1 Layout',
      effectiveFrom: '2020-01-01',
      effectiveDate: todayStr,
      codePrefix: 'A',
      seatCount: 8
    });

    await prisma.dailySetting.deleteMany({ where: { date: todayDate } });
    await prisma.dailySetting.create({
      data: { date: todayDate, allow_unlimited: false, hourly_price: 100 }
    });

    await prisma.equipmentConfig.create({
      data: {
        id: eqId,
        name: '中板',
        visibility_status: 'ACTIVE',
        total_stock: 10,
        hourly_rate: 50,
        min_contiguous_hours: 1,
        allow_exceed_pax: true,
        sort_order: 99
      }
    });

    await prisma.session.deleteMany({ where: { session_date: todayDate } });
    s1 = await prisma.session.create({
      data: { session_date: todayDate, start_time: '14:00', end_time: '16:00', max_capacity: 20 }
    });

    user = await prisma.user.create({
      data: { line_user_id: `r41_1_${ts}`, name: 'R41取消報到', phone: `09411${String(ts).slice(-5)}` } // check-secrets: fake-data
    });

    const ctx = await loadAllocatorContext(prisma, todayDate);
    const activeSeats = (ctx.layout?.seats || []).filter((s) => s.is_active).map((s) => s.code);
    assert.ok(activeSeats.length >= 6);

    // Case 1 & 2: 2 pax check-in with board on person 2 -> cancel check-in -> person_id=null -> re-check-in on person 1
    const ref1 = `R41-1-A-${ts}`;
    createdRefs.push(ref1);
    await prisma.reservation.create({
      data: {
        booking_ref: ref1,
        session_id: s1.id,
        user_id: user.id,
        pax: 2,
        status: 'confirmed',
        is_walk_in: false,
        assigned_seats: activeSeats.slice(0, 2)
      }
    });
    const eqRow = await prisma.bookingEquipment.create({
      data: {
        booking_ref: ref1,
        equipment_id: eqId,
        equipment_name_snapshot: '中板',
        quantity: 1,
        unit_group: `ug-r41-1-${ts}`,
        segment_no: 1,
        unit_rate: 50,
        rental_hours: 2,
        subtotal_price: 100,
        covered_sessions: ['14:00-16:00']
      }
    });
    await prisma.boardPause.create({
      data: {
        unit_group: eqRow.unit_group,
        source: 'person',
        started_at: new Date(`${todayStr}T14:10:00+08:00`)
      }
    });

    const ci1 = createMockReqRes({
      params: { booking_ref: ref1 },
      body: {
        seats: activeSeats.slice(0, 2),
        start_timer: true,
        board_assignments: [{ unit_group: eqRow.unit_group, person_no: 2 }]
      }
    });
    await checkIn(ci1.req, ci1.res);
    assert.equal(ci1.res.getStatusCode(), 200);

    const eqAssigned = await prisma.bookingEquipment.findUnique({ where: { id: eqRow.id } });
    assert.ok(eqAssigned.person_id != null, 'person_id should be linked after check-in');

    // Cancel check-in
    const cancel1 = createMockReqRes({
      params: { id: ref1 },
      body: { attendance: null }
    });
    await updateAttendance(cancel1.req, cancel1.res);
    assert.equal(cancel1.res.getStatusCode(), 200);

    const eqAfterCancel = await prisma.bookingEquipment.findUnique({ where: { id: eqRow.id } });
    assert.equal(eqAfterCancel.person_id, null);
    assert.equal(await prisma.bookingPerson.count({ where: { booking_ref: ref1 } }), 0);
    const openPersonPause = await prisma.boardPause.findFirst({
      where: { unit_group: eqRow.unit_group, source: 'person', ended_at: null }
    });
    assert.equal(openPersonPause, null);

    // Re-check-in assigning board to Person 1 -> board fee goes to Person 1
    const ci2 = createMockReqRes({
      params: { booking_ref: ref1 },
      body: {
        seats: activeSeats.slice(0, 2),
        start_timer: true,
        board_assignments: [{ unit_group: eqRow.unit_group, person_no: 1 }]
      }
    });
    await checkIn(ci2.req, ci2.res);
    assert.equal(ci2.res.getStatusCode(), 200);

    const billAfterReCheck = await getBookingBill(ref1);
    const bp1 = billAfterReCheck.bill.persons.find(p => p.person_no === 1);
    const bp2 = billAfterReCheck.bill.persons.find(p => p.person_no === 2);
    assert.equal(bp1.board.amount, 100);
    assert.equal(bp2.board.amount, 0);

    // Case 3: attendance === 'completed' -> cancel check-in returns 409
    const refComp = `R41-1-COMP-${ts}`;
    createdRefs.push(refComp);
    await prisma.reservation.create({
      data: {
        booking_ref: refComp,
        session_id: s1.id,
        user_id: user.id,
        pax: 1,
        status: 'confirmed',
        attendance: 'completed',
        assigned_seats: [activeSeats[2]]
      }
    });
    const cancelComp = createMockReqRes({ params: { id: refComp }, body: { attendance: null } });
    await updateAttendance(cancelComp.req, cancelComp.res);
    assert.equal(cancelComp.res.getStatusCode(), 409);
    assert.equal((await prisma.reservation.findFirst({ where: { booking_ref: refComp } })).attendance, 'completed');

    // Case 4: no_show -> revert to null works; checked_in -> no_show returns 409
    const refNs = `R41-1-NS-${ts}`;
    createdRefs.push(refNs);
    await prisma.reservation.create({
      data: {
        booking_ref: refNs,
        session_id: s1.id,
        user_id: user.id,
        pax: 1,
        status: 'confirmed',
        attendance: null,
        assigned_seats: [activeSeats[3]]
      }
    });
    const setNs = createMockReqRes({ params: { id: refNs }, body: { attendance: 'no_show' } });
    await updateAttendance(setNs.req, setNs.res);
    assert.equal(setNs.res.getStatusCode(), 200);

    const revertNs = createMockReqRes({ params: { id: refNs }, body: { attendance: null } });
    await updateAttendance(revertNs.req, revertNs.res);
    assert.equal(revertNs.res.getStatusCode(), 200);
    assert.equal((await prisma.reservation.findFirst({ where: { booking_ref: refNs } })).attendance, null);

    // Checked-in cannot switch directly to no_show
    const badNs = createMockReqRes({ params: { id: ref1 }, body: { attendance: 'no_show' } });
    await updateAttendance(badNs.req, badNs.res);
    assert.equal(badNs.res.getStatusCode(), 409);

    // Case 5: Concurrent Promise.all cancel check-in on ref1 -> no errors, consistent state
    const c1 = createMockReqRes({ params: { id: ref1 }, body: { attendance: null } });
    const c2 = createMockReqRes({ params: { id: ref1 }, body: { attendance: null } });
    await Promise.all([updateAttendance(c1.req, c1.res), updateAttendance(c2.req, c2.res)]);
    const statuses = [c1.res.getStatusCode(), c2.res.getStatusCode()].sort((a, b) => a - b);
    assert.deepEqual(statuses, [200, 409]);
    assert.equal((await prisma.reservation.findFirst({ where: { booking_ref: ref1 } })).attendance, null);
    assert.equal(await prisma.bookingPerson.count({ where: { booking_ref: ref1 } }), 0);
    assert.equal((await prisma.bookingEquipment.findUnique({ where: { id: eqRow.id } })).person_id, null);
  } finally {
    await prisma.boardPause.deleteMany({ where: { unit_group: `ug-r41-1-${ts}` } }).catch(() => {});
    await prisma.bookingEquipment.deleteMany({ where: { booking_ref: { in: createdRefs } } }).catch(() => {});
    await prisma.timerPause.deleteMany({ where: { person: { booking_ref: { in: createdRefs } } } }).catch(() => {});
    await prisma.bookingPerson.deleteMany({ where: { booking_ref: { in: createdRefs } } }).catch(() => {});
    await prisma.reservation.deleteMany({ where: { booking_ref: { in: createdRefs } } }).catch(() => {});
    await prisma.equipmentConfig.deleteMany({ where: { id: eqId } }).catch(() => {});
    await prisma.dailySetting.deleteMany({ where: { date: todayDate } }).catch(() => {});
    if (s1) await prisma.session.deleteMany({ where: { id: s1.id } }).catch(() => {});
    if (user) await prisma.user.deleteMany({ where: { id: user.id } }).catch(() => {});
    await cleanupTestPublishedLayout(prisma, layoutId).catch(() => {});
  }
});
