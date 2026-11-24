import test from 'node:test';
import assert from 'node:assert/strict';
import prisma from '../src/prismaClient.js';
import { dateOnly } from '../../shared/time.js';
import { ensureTestPublishedLayout, cleanupTestPublishedLayout } from './helpers/seedTestLayout.js';
import { loadAllocatorContext } from '../src/services/seating/layoutService.js';
import { checkIn, handleTimer, reassignBoard } from '../src/controllers/floorController.js';

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

test('Round 40 Item 2: handleTimer advisory lock prevents duplicate pauses, resume closes all pauses, and reassignBoard checks active person', async () => {
  const ts = Date.now();
  const testDateStr = '2099-11-11';
  const testDate = dateOnly(testDateStr);
  let layoutId = null;
  let session1 = null;
  let user = null;
  let eqConfig = null;
  const bookingRef = `R40-2-${ts}`;
  const eqId = `r40_2_eq_${ts}`;

  try {
    layoutId = await ensureTestPublishedLayout(prisma, {
      name: 'R40 Item2 Layout',
      effectiveFrom: '2020-01-01',
      effectiveDate: testDateStr,
      codePrefix: 'A',
      seatCount: 8
    });

    await prisma.bookingEquipment.deleteMany({ where: { booking_ref: { startsWith: 'R40-2-' } } }).catch(() => {});
    await prisma.timerPause.deleteMany({ where: { person: { booking_ref: { startsWith: 'R40-2-' } } } }).catch(() => {});
    await prisma.bookingPerson.deleteMany({ where: { booking_ref: { startsWith: 'R40-2-' } } }).catch(() => {});
    await prisma.reservation.deleteMany({ where: { booking_ref: { startsWith: 'R40-2-' } } }).catch(() => {});
    await prisma.session.deleteMany({ where: { session_date: testDate } });
    session1 = await prisma.session.create({
      data: { session_date: testDate, start_time: '13:00', end_time: '16:00', max_capacity: 10 }
    });
    user = await prisma.user.create({
      data: { line_user_id: `r40_2_${ts}`, name: 'R40鎖定測試', phone: `09402${String(ts).slice(-5)}` } // check-secrets: fake-data
    });
    eqConfig = await prisma.equipmentConfig.create({
      data: { id: eqId, name: '小板', hourly_rate: 50, total_stock: 5, visibility_status: 'ACTIVE' }
    });

    const ctx = await loadAllocatorContext(prisma, testDate);
    const seats = (ctx.layout?.seats || []).filter((s) => s.is_active).slice(0, 2).map((s) => s.code);

    await prisma.reservation.create({
      data: {
        booking_ref: bookingRef,
        session_id: session1.id,
        user_id: user.id,
        pax: 2,
        status: 'confirmed',
        assigned_seats: seats,
        is_seat_locked: false,
        seat_source: 'auto'
      }
    });

    const t1300 = '2099-11-11T13:00:00+08:00';
    const t1305 = '2099-11-11T13:05:00+08:00';
    const t1320 = '2099-11-11T13:20:00+08:00';

    const ci = createMockReqRes({
      params: { booking_ref: bookingRef },
      body: { seats, start_timer: true, now: t1300 }
    });
    await checkIn(ci.req, ci.res);
    assert.equal(ci.res.getStatusCode(), 200);

    // 1. Concurrent double pause on person 1
    const p1ReqA = createMockReqRes({
      params: { booking_ref: bookingRef },
      body: { action: 'pause', person_nos: [1], now: t1305 }
    });
    const p1ReqB = createMockReqRes({
      params: { booking_ref: bookingRef },
      body: { action: 'pause', person_nos: [1], now: t1305 }
    });
    await Promise.all([
      handleTimer(p1ReqA.req, p1ReqA.res),
      handleTimer(p1ReqB.req, p1ReqB.res)
    ]);

    const statuses = [p1ReqA.res.getStatusCode(), p1ReqB.res.getStatusCode()].sort((a, b) => a - b);
    assert.deepEqual(statuses, [200, 409]);

    const person1 = await prisma.bookingPerson.findUnique({
      where: { booking_ref_person_no: { booking_ref: bookingRef, person_no: 1 } },
      include: { pauses: true }
    });
    assert.ok(person1.paused_at);
    assert.equal(person1.pauses.filter((pa) => !pa.ended_at).length, 1);

    // 2. Resume clears pauses
    const resReq = createMockReqRes({
      params: { booking_ref: bookingRef },
      body: { action: 'resume', person_nos: [1], now: t1320 }
    });
    await handleTimer(resReq.req, resReq.res);
    assert.equal(resReq.res.getStatusCode(), 200);

    const openAfterResume = await prisma.timerPause.count({
      where: { person_id: person1.id, ended_at: null }
    });
    assert.equal(openAfterResume, 0);

    // 3. Legacy two unclosed pauses (13:00, 13:05) -> 13:20 resume closes both and adds 1200s from earliest (13:00 -> 13:20)
    await prisma.bookingPerson.update({
      where: { id: person1.id },
      data: { paused_at: new Date(t1300), paused_seconds: 0 }
    });
    await prisma.timerPause.createMany({
      data: [
        { person_id: person1.id, started_at: new Date(t1300), reason: 'legacy1', staff_name: 'tester' },
        { person_id: person1.id, started_at: new Date(t1305), reason: 'legacy2', staff_name: 'tester' }
      ]
    });

    const resLegacy = createMockReqRes({
      params: { booking_ref: bookingRef },
      body: { action: 'resume', person_nos: [1], now: t1320 }
    });
    await handleTimer(resLegacy.req, resLegacy.res);
    assert.equal(resLegacy.res.getStatusCode(), 200);

    const p1AfterLegacy = await prisma.bookingPerson.findUnique({
      where: { id: person1.id },
      include: { pauses: true }
    });
    assert.equal(p1AfterLegacy.pauses.filter((pa) => !pa.ended_at).length, 0);
    assert.equal(p1AfterLegacy.paused_seconds, 1200);
    assert.equal(p1AfterLegacy.paused_at, null);

    // 4. reassignBoard rejects removed person 2 with 404 & leaves person_id unchanged
    await prisma.bookingPerson.update({
      where: { booking_ref_person_no: { booking_ref: bookingRef, person_no: 2 } },
      data: { status: 'removed', seat_code: null }
    });
    const ug = `UG-R40-2-${ts}`;
    await prisma.bookingEquipment.create({
      data: {
        booking_ref: bookingRef,
        equipment_id: eqId,
        equipment_name_snapshot: '小板',
        quantity: 1,
        unit_group: ug,
        person_id: person1.id,
        unit_rate: 50,
        rental_hours: 2,
        subtotal_price: 100
      }
    });

    const badReassign = createMockReqRes({
      params: { booking_ref: bookingRef, unit_group: ug },
      body: { person_no: 2 }
    });
    await reassignBoard(badReassign.req, badReassign.res);
    assert.equal(badReassign.res.getStatusCode(), 404);

    const eqRow = await prisma.bookingEquipment.findFirst({ where: { booking_ref: bookingRef, unit_group: ug } });
    assert.equal(eqRow.person_id, person1.id);

    // Valid reassign writes board_reassigned audit log
    const goodReassign = createMockReqRes({
      params: { booking_ref: bookingRef, unit_group: ug },
      body: { person_no: 1 }
    });
    await reassignBoard(goodReassign.req, goodReassign.res);
    assert.equal(goodReassign.res.getStatusCode(), 200);
    const evt = await prisma.accountingEvent.findFirst({
      where: { booking_ref: bookingRef, event_type: 'board_reassigned', category: 'seating' }
    });
    assert.ok(evt);
    assert.ok(evt.summary.includes('第 1 位'));
  } finally {
    await prisma.bookingEquipment.deleteMany({ where: { booking_ref: bookingRef } }).catch(() => {});
    await prisma.timerPause.deleteMany({ where: { person: { booking_ref: bookingRef } } }).catch(() => {});
    await prisma.bookingPerson.deleteMany({ where: { booking_ref: bookingRef } }).catch(() => {});
    await prisma.reservation.deleteMany({ where: { booking_ref: bookingRef } }).catch(() => {});
    if (eqConfig) await prisma.equipmentConfig.deleteMany({ where: { id: eqId } }).catch(() => {});
    if (session1) await prisma.session.deleteMany({ where: { id: session1.id } }).catch(() => {});
    if (user) await prisma.user.deleteMany({ where: { id: user.id } }).catch(() => {});
    await cleanupTestPublishedLayout(prisma, layoutId).catch(() => {});
  }
});
