import test from 'node:test';
import assert from 'node:assert/strict';
import prisma from '../src/prismaClient.js';
import { dateOnly } from '../../shared/time.js';
import { ensureTestPublishedLayout, cleanupTestPublishedLayout } from './helpers/seedTestLayout.js';
import { loadAllocatorContext } from '../src/services/seating/layoutService.js';
import {
  checkIn,
  addBoardRental,
  returnBoard,
  handleTimer,
  removePerson
} from '../src/controllers/floorController.js';
import {
  getBillingDetails,
  postCollect,
  postVoid
} from '../src/controllers/billingController.js';

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

test('Round 40 Item 4: board added after payment settles on return/end, idempotent, cleared on void', async () => {
  const ts = Date.now();
  const testDateStr = '2099-11-16';
  const testDate = dateOnly(testDateStr);
  let layoutId = null;
  let s1 = null;
  let s2 = null;
  let user = null;
  const eqId = `r40-med-${ts}`;
  const createdRefs = [];

  try {
    layoutId = await ensureTestPublishedLayout(prisma, {
      name: 'R40 Item4 Layout',
      effectiveFrom: '2020-01-01',
      effectiveDate: testDateStr,
      codePrefix: 'A',
      seatCount: 8
    });

    await prisma.dailySetting.deleteMany({ where: { date: testDate } });
    await prisma.dailySetting.create({
      data: {
        date: testDate,
        allow_unlimited: false,
        hourly_price: 100,
        unlimited_price: null
      }
    });

    await prisma.equipmentConfig.create({
      data: {
        id: eqId,
        name: '中板',
        visibility_status: 'ACTIVE',
        total_stock: 10,
        hourly_rate: 50,
        daily_cap: null,
        min_contiguous_hours: 1,
        allow_exceed_pax: true,
        sort_order: 99
      }
    });

    await prisma.session.deleteMany({ where: { session_date: testDate } });
    s1 = await prisma.session.create({
      data: { session_date: testDate, start_time: '15:00', end_time: '17:00', max_capacity: 10 }
    });
    s2 = await prisma.session.create({
      data: { session_date: testDate, start_time: '17:00', end_time: '19:00', max_capacity: 10 }
    });

    user = await prisma.user.create({
      data: { line_user_id: `r40_4_${ts}`, name: 'R40付款後加板', phone: `09404${String(ts).slice(-5)}` } // check-secrets: fake-data
    });

    const ctx = await loadAllocatorContext(prisma, testDate);
    const activeSeats = (ctx.layout?.seats || []).filter((s) => s.is_active).map((s) => s.code);
    assert.ok(activeSeats.length >= 6);

    const t1500 = '2099-11-16T15:00:00+08:00';
    const t1600 = '2099-11-16T16:00:00+08:00';
    const t1700 = '2099-11-16T17:00:00+08:00';
    const t1900 = '2099-11-16T19:00:00+08:00';

    // Booking 1: 3 persons, 15:00-19:00 (4h * 100 = NT$400 each)
    const ref1 = `R40-4-A-${ts}`;
    createdRefs.push(ref1);
    await prisma.reservation.createMany({
      data: [s1, s2].map(sess => ({
        booking_ref: ref1,
        session_id: sess.id,
        user_id: user.id,
        pax: 3,
        status: 'confirmed',
        is_walk_in: false,
        assigned_seats: activeSeats.slice(0, 3)
      }))
    });

    const ci1 = createMockReqRes({
      params: { booking_ref: ref1 },
      body: { seats: activeSeats.slice(0, 3), start_timer: true, now: t1500 }
    });
    await checkIn(ci1.req, ci1.res);
    assert.equal(ci1.res.getStatusCode(), 200);

    // Collect payment for Person 1 ONLY (NT$400)
    const col1 = createMockReqRes({
      params: { booking_ref: ref1 },
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
    await postCollect(col1.req, col1.res);
    assert.equal(col1.res.getStatusCode(), 200);
    const p1PaymentId = col1.res.getBody().payments?.[0]?.id;
    assert.ok(p1PaymentId, 'Person 1 payment id should exist');

    // Case 1: Person 1 (paid) adds medium board 15:00-19:00 -> marked added_after_payment, NOT pending yet
    const addP1 = createMockReqRes({
      params: { booking_ref: ref1 },
      body: { person_no: 1, equipment_id: eqId, from_at: t1500, to_at: t1900, now: t1500 }
    });
    await addBoardRental(addP1.req, addP1.res);
    assert.equal(addP1.res.getStatusCode(), 200);

    const p1Eq = await prisma.bookingEquipment.findFirst({
      where: { booking_ref: ref1 },
      orderBy: { id: 'desc' }
    });
    assert.equal(p1Eq.added_after_payment, true);
    assert.equal(p1Eq.end_at, null);
    assert.ok(p1Eq.unit_group);

    const billBeforeRet = createMockReqRes({ params: { booking_ref: ref1 } });
    await getBillingDetails(billBeforeRet.req, billBeforeRet.res);
    assert.equal(billBeforeRet.res.getStatusCode(), 200);
    const p1BillBefore = billBeforeRet.res.getBody().bill.persons.find(p => p.person_no === 1);
    assert.equal(p1BillBefore.total, 400);
    assert.equal(p1BillBefore.pending_supplement, 0);
    assert.equal(p1BillBefore.active_after_payment_boards.length, 1);
    assert.equal(p1BillBefore.active_after_payment_boards[0].unit_group, p1Eq.unit_group);

    // 19:00 returnBoard -> 4h medium board (buy 3 get 1 -> 3 * 50 = NT$150) pending_supplement, idempotent
    const ret1 = createMockReqRes({
      params: { booking_ref: ref1, unit_group: p1Eq.unit_group },
      body: { now: t1900 }
    });
    await returnBoard(ret1.req, ret1.res);
    assert.equal(ret1.res.getStatusCode(), 200);

    const p1BillAfter = ret1.res.getBody().bill.persons.find(p => p.person_no === 1);
    assert.equal(p1BillAfter.total, 400);
    assert.equal(p1BillAfter.pending_supplement, 150);
    assert.equal((p1BillAfter.active_after_payment_boards || []).length, 0);

    // Call returnBoard a 2nd time -> idempotent, still 1 supplement item & NT$150
    const ret1Again = createMockReqRes({
      params: { booking_ref: ref1, unit_group: p1Eq.unit_group },
      body: { now: t1900 }
    });
    await returnBoard(ret1Again.req, ret1Again.res);
    assert.equal(ret1Again.res.getStatusCode(), 200);

    const billAfterRet2 = createMockReqRes({ params: { booking_ref: ref1 } });
    await getBillingDetails(billAfterRet2.req, billAfterRet2.res);
    const p1PendingItems = (billAfterRet2.res.getBody().draft?.pending_supplements || []).filter(
      it => it.source_key === `board:${p1Eq.unit_group}`
    );
    assert.equal(p1PendingItems.length, 1);
    assert.equal(p1PendingItems[0].amount, 150);

    // Case 4: Unpaid Person 2 adds board -> added_after_payment = false, billed directly on Person 2
    const addP2 = createMockReqRes({
      params: { booking_ref: ref1 },
      body: { person_no: 2, equipment_id: eqId, from_at: t1500, to_at: t1700, now: t1500 }
    });
    await addBoardRental(addP2.req, addP2.res);
    assert.equal(addP2.res.getStatusCode(), 200);
    const p2Person = await prisma.bookingPerson.findUnique({
      where: { booking_ref_person_no: { booking_ref: ref1, person_no: 2 } }
    });
    const p2Eq = await prisma.bookingEquipment.findFirst({
      where: { booking_ref: ref1, person_id: p2Person.id }
    });
    assert.equal(p2Eq.added_after_payment, false);

    // Case 5: Removed Person 3 -> 409 PERSON_INACTIVE
    const remP3 = createMockReqRes({
      params: { booking_ref: ref1, person_no: '3' },
      body: { now: t1500 }
    });
    await removePerson(remP3.req, remP3.res);
    assert.equal(remP3.res.getStatusCode(), 200);

    const addP3 = createMockReqRes({
      params: { booking_ref: ref1 },
      body: { person_no: 3, equipment_id: eqId, from_at: t1500, to_at: t1700, now: t1500 }
    });
    await addBoardRental(addP3.req, addP3.res);
    assert.equal(addP3.res.getStatusCode(), 409);
    assert.equal(addP3.res.getBody().code, 'PERSON_INACTIVE');

    // Case 6: Void Person 1 payment -> removes unpaid board:<ug> supplement, resets added_after_payment=false
    const voidP1 = createMockReqRes({
      params: { id: String(p1PaymentId) },
      body: { reason: '測試作廢還原加租板' }
    });
    await postVoid(voidP1.req, voidP1.res);
    assert.equal(voidP1.res.getStatusCode(), 200);

    const p1EqAfterVoid = await prisma.bookingEquipment.findUnique({ where: { id: p1Eq.id } });
    assert.equal(p1EqAfterVoid.added_after_payment, false);

    const billAfterVoid = createMockReqRes({ params: { booking_ref: ref1 } });
    await getBillingDetails(billAfterVoid.req, billAfterVoid.res);
    const bodyVoid = billAfterVoid.res.getBody();
    assert.equal((bodyVoid.draft?.pending_supplements || []).filter(i => i.source_key === `board:${p1Eq.unit_group}`).length, 0);
    const p1BillVoid = bodyVoid.bill.persons.find(p => p.person_no === 1);
    assert.equal(p1BillVoid.pending_supplement, 0);
    assert.equal(p1BillVoid.board.amount, 150);
    assert.equal(p1BillVoid.total, 550);

    // Booking 2: Case 2 (現在結算 / settle early at 17:00) & Case 3 (提前離場 / handleTimer end at 16:00)
    const ref2 = `R40-4-B-${ts}`;
    createdRefs.push(ref2);
    await prisma.reservation.createMany({
      data: [s1, s2].map(sess => ({
        booking_ref: ref2,
        session_id: sess.id,
        user_id: user.id,
        pax: 2,
        status: 'confirmed',
        is_walk_in: false,
        assigned_seats: activeSeats.slice(3, 5)
      }))
    });

    const ci2 = createMockReqRes({
      params: { booking_ref: ref2 },
      body: { seats: activeSeats.slice(3, 5), start_timer: true, now: t1500 }
    });
    await checkIn(ci2.req, ci2.res);
    assert.equal(ci2.res.getStatusCode(), 200);

    // Whole booking paid before adding boards
    const col2 = createMockReqRes({
      params: { booking_ref: ref2 },
      body: {
        client_batch_id: `batch-b2-${ts}`,
        person_nos: [1, 2],
        expected_amount: 800,
        expected_net_amount: 800,
        method: 'cash',
        cash_received: 800,
        print: false
      }
    });
    await postCollect(col2.req, col2.res);
    assert.equal(col2.res.getStatusCode(), 200);

    // Case 2: Person 1 adds board 15:00..19:00, settled at 17:00 -> 2h * 50 = NT$100
    const addB2P1 = createMockReqRes({
      params: { booking_ref: ref2 },
      body: { person_no: 1, equipment_id: eqId, from_at: t1500, to_at: t1900, now: t1500 }
    });
    await addBoardRental(addB2P1.req, addB2P1.res);
    assert.equal(addB2P1.res.getStatusCode(), 200);

    const b2p1 = await prisma.bookingPerson.findUnique({
      where: { booking_ref_person_no: { booking_ref: ref2, person_no: 1 } }
    });
    const b2p1Eq = await prisma.bookingEquipment.findFirst({
      where: { booking_ref: ref2, person_id: b2p1.id }
    });

    const retB2P1 = createMockReqRes({
      params: { booking_ref: ref2, unit_group: b2p1Eq.unit_group },
      body: { now: t1700 }
    });
    await returnBoard(retB2P1.req, retB2P1.res);
    assert.equal(retB2P1.res.getStatusCode(), 200);
    const b2p1Updated = await prisma.bookingEquipment.findUnique({ where: { id: b2p1Eq.id } });
    assert.equal(b2p1Updated.end_at.toISOString(), new Date(t1700).toISOString());
    assert.equal(retB2P1.res.getBody().bill.persons.find(p => p.person_no === 1).pending_supplement, 100);

    // Case 3: Person 2 adds board 15:00..19:00, leaves early at 16:00 -> end settles at 16:00 = NT$50
    const addB2P2 = createMockReqRes({
      params: { booking_ref: ref2 },
      body: { person_no: 2, equipment_id: eqId, from_at: t1500, to_at: t1900, now: t1500 }
    });
    await addBoardRental(addB2P2.req, addB2P2.res);
    assert.equal(addB2P2.res.getStatusCode(), 200);

    const endB2P2 = createMockReqRes({
      params: { booking_ref: ref2 },
      body: { action: 'end', person_nos: [2], now: t1600 }
    });
    await handleTimer(endB2P2.req, endB2P2.res);
    assert.equal(endB2P2.res.getStatusCode(), 200);

    const billB2End = createMockReqRes({ params: { booking_ref: ref2 } });
    await getBillingDetails(billB2End.req, billB2End.res);
    const b2p2Bill = billB2End.res.getBody().bill.persons.find(p => p.person_no === 2);
    assert.equal(b2p2Bill.pending_supplement, 50);
    assert.equal((b2p2Bill.active_after_payment_boards || []).length, 0);
  } finally {
    await prisma.payment.deleteMany({ where: { booking_ref: { in: createdRefs } } }).catch(() => {});
    await prisma.bookingEquipment.deleteMany({ where: { booking_ref: { in: createdRefs } } }).catch(() => {});
    await prisma.timerPause.deleteMany({ where: { person: { booking_ref: { in: createdRefs } } } }).catch(() => {});
    await prisma.bookingPerson.deleteMany({ where: { booking_ref: { in: createdRefs } } }).catch(() => {});
    await prisma.reservation.deleteMany({ where: { booking_ref: { in: createdRefs } } }).catch(() => {});
    await prisma.equipmentConfig.deleteMany({ where: { id: eqId } }).catch(() => {});
    await prisma.dailySetting.deleteMany({ where: { date: testDate } }).catch(() => {});
    if (s1) await prisma.session.deleteMany({ where: { id: s1.id } }).catch(() => {});
    if (s2) await prisma.session.deleteMany({ where: { id: s2.id } }).catch(() => {});
    if (user) await prisma.user.deleteMany({ where: { id: user.id } }).catch(() => {});
    await cleanupTestPublishedLayout(prisma, layoutId).catch(() => {});
  }
});
