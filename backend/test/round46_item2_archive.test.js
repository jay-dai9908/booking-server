import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import prisma from '../src/prismaClient.js';
import { dateOnly, toTaipeiDateString } from '../../shared/time.js';
import {
  getSessions,
  createBulkSessions,
  deleteSession,
  deleteSessionsByDate
} from '../src/controllers/sessionController.js';
import {
  createReservation,
  adminCreateReservation,
  getAdminReservations,
  getAdminReservationDetails,
  archiveReservationRecord,
  deleteReservationRecord,
  extendReservation
} from '../src/controllers/reservationController.js';
import { getPaymentsList } from '../src/controllers/accountingController.js';
import { postPrepayQuoteHandler } from '../src/controllers/prepayController.js';

function createMockReqRes({
  body = {},
  params = {},
  query = {},
  user = null
} = {}) {
  const req = { body, params, query, user, headers: { 'x-device-label': 'R46測試裝置' }, ip: '127.0.0.1' };
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

test('Round 46 Item 2: reservation archive vs payment-guarded delete, and session close vs delete', async () => {
  const ts = Date.now();
  const dateStr = toTaipeiDateString(new Date(Date.now() + 45 * 86400000));
  const sessionDate = dateOnly(dateStr);
  const adminUser = { id: 9462, name: 'R46封存店長', role: 'admin', isSuperAdmin: true, permissions: ['all'], isVerifiedAdmin: true };

  const createdUserIds = [];
  const createdSessionIds = [];
  const createdRefs = [];

  try {
    const cust = await prisma.user.create({
      data: {
        line_user_id: `U_R46_I2_${ts}`,
        name: 'R46封存顧客',
        phone: '0922333444'
      }
    });
    createdUserIds.push(cust.id);

    const custUser = { id: cust.id, role: 'customer', typ: 'customer', isTemp: false };

    const s1 = await prisma.session.create({
      data: { session_date: sessionDate, start_time: '10:00', end_time: '11:00', max_capacity: 16 }
    });
    const s2 = await prisma.session.create({
      data: { session_date: sessionDate, start_time: '11:00', end_time: '12:00', max_capacity: 16 }
    });
    const tEmpty = await prisma.session.create({
      data: { session_date: sessionDate, start_time: '12:00', end_time: '13:00', max_capacity: 16 }
    });
    createdSessionIds.push(s1.id, s2.id, tEmpty.id);

    // Cancelled reservation R on s1 with payment + refund records
    const refR = `R46-R-${crypto.randomUUID().slice(0, 8)}`;
    createdRefs.push(refR);
    await prisma.reservation.create({
      data: {
        booking_ref: refR,
        session_id: s1.id,
        user_id: cust.id,
        pax: 2,
        status: 'cancelled',
        cancelled_at: new Date(),
        cancelled_by: '測試人員',
        has_refund: true,
        amount_due: 0,
        amount_received: 0,
        billing_status: 'paid'
      }
    });
    await prisma.payment.create({
      data: {
        payment_no: `PAY-R46C-${ts}`,
        batch_no: `BATCH-R46C-${ts}`,
        source: 'booking',
        source_ref: refR,
        booking_ref: refR,
        kind: 'charge',
        amount: 300,
        method: 'cash',
        breakdown_json: { items: [{ type: 'seating', amount: 300 }] },
        staff_name: '測試收銀',
        device_label: '櫃檯桌機',
        status: 'valid'
      }
    });
    await prisma.payment.create({
      data: {
        payment_no: `PAY-R46F-${ts}`,
        batch_no: `BATCH-R46F-${ts}`,
        source: 'booking',
        source_ref: refR,
        booking_ref: refR,
        kind: 'refund',
        amount: 300,
        method: 'cash',
        breakdown_json: { refund: true },
        reason: '測試全額退款',
        staff_name: '測試收銀',
        device_label: '櫃檯桌機',
        status: 'valid'
      }
    });

    // Active confirmed reservation C on s2 (to test archive 409 & extend 409 into closed s1)
    const refC = `R46-C-${crypto.randomUUID().slice(0, 8)}`;
    createdRefs.push(refC);
    await prisma.reservation.create({
      data: {
        booking_ref: refC,
        session_id: s2.id,
        user_id: cust.id,
        pax: 2,
        status: 'confirmed'
      }
    });

    // Confirmed reservation cannot be archived -> 409
    const rArchActive = createMockReqRes({
      params: { id: refC },
      user: adminUser
    });
    await archiveReservationRecord(rArchActive.req, rArchActive.res);
    assert.equal(rArchActive.res.getStatusCode(), 409);

    // 1. Delete s1 -> s1 becomes closed (not hard-deleted), R and Payments survive, payments list keeps R's date
    const rDelS1 = createMockReqRes({ params: { id: String(s1.id) }, user: adminUser });
    await deleteSession(rDelS1.req, rDelS1.res);
    assert.equal(rDelS1.res.getStatusCode(), 200);
    assert.equal(rDelS1.res.getBody().action, 'closed');

    const s1Db = await prisma.session.findUnique({ where: { id: s1.id } });
    assert.ok(s1Db && s1Db.closed_at, 's1 must be closed rather than deleted');
    const rStillThere = await prisma.reservation.findMany({ where: { booking_ref: refR } });
    assert.equal(rStillThere.length, 1);

    const todayStr = toTaipeiDateString(new Date());
    const rPayList = createMockReqRes({
      query: { date_from: todayStr, date_to: todayStr, q: refR },
      user: adminUser
    });
    await getPaymentsList(rPayList.req, rPayList.res);
    assert.equal(rPayList.res.getStatusCode(), 200);
    const matchingPays = rPayList.res.getBody().payments.filter((p) => p.booking_ref === refR);
    assert.equal(matchingPays.length, 2);
    assert.ok(matchingPays[0].session_date, 'Payment list must preserve session_date of closed session');

    // 2. Customer GET /sessions hides closed s1; admin with include_closed=1 sees s1 with closed_at
    const rCustSess = createMockReqRes({ query: { date: dateStr } });
    await getSessions(rCustSess.req, rCustSess.res);
    assert.equal(rCustSess.res.getStatusCode(), 200);
    assert.ok(!rCustSess.res.getBody().some((s) => s.id === s1.id), 'Customer must not see closed session s1');

    const rAdminSess = createMockReqRes({ query: { date: dateStr, include_closed: '1' }, user: adminUser });
    await getSessions(rAdminSess.req, rAdminSess.res);
    assert.equal(rAdminSess.res.getStatusCode(), 200);
    const adminS1 = rAdminSess.res.getBody().find((s) => s.id === s1.id);
    assert.ok(adminS1 && adminS1.closed_at, 'Admin include_closed must see closed_at on s1');

    // Booking / Admin create / Extend / Prepay quote on closed s1 -> 409 '這個時段已關閉'
    const rBookClosed = createMockReqRes({
      body: { session_ids: [s1.id], pax: 1 },
      user: custUser
    });
    await createReservation(rBookClosed.req, rBookClosed.res);
    assert.equal(rBookClosed.res.getStatusCode(), 409);
    assert.equal(rBookClosed.res.getBody().error, '這個時段已關閉');

    const rAdminBookClosed = createMockReqRes({
      body: { session_ids: [s1.id], pax: 1, name: '手動測試', phone: '0900111222' },
      user: adminUser
    });
    await adminCreateReservation(rAdminBookClosed.req, rAdminBookClosed.res);
    assert.equal(rAdminBookClosed.res.getStatusCode(), 409);
    assert.equal(rAdminBookClosed.res.getBody().error, '這個時段已關閉');

    const rExtendClosed = createMockReqRes({
      params: { booking_ref: refC },
      body: { session_ids: [s1.id] },
      user: adminUser
    });
    await extendReservation(rExtendClosed.req, rExtendClosed.res);
    assert.equal(rExtendClosed.res.getStatusCode(), 409);
    assert.equal(rExtendClosed.res.getBody().error, '這個時段已關閉');

    const rQuoteClosed = createMockReqRes({
      body: { session_ids: [s1.id], pax: 1 },
      user: custUser
    });
    await postPrepayQuoteHandler(rQuoteClosed.req, rQuoteClosed.res);
    assert.equal(rQuoteClosed.res.getStatusCode(), 409);
    assert.equal(rQuoteClosed.res.getBody().error, '這個時段已關閉');

    // 3. Re-creating same date & time reopens s1 + logs session_reopened + allows booking
    const rReopen = createMockReqRes({
      body: { session_date: dateStr, start_time: '10:00', end_time: '11:00', max_capacity: 16 },
      user: adminUser
    });
    await createBulkSessions(rReopen.req, rReopen.res);
    assert.equal(rReopen.res.getStatusCode(), 201);
    const s1Reopened = await prisma.session.findUnique({ where: { id: s1.id } });
    assert.equal(s1Reopened.closed_at, null);

    const reopenEv = await prisma.accountingEvent.findFirst({
      where: { event_type: 'session_reopened', target_type: 'session', target_ref: String(s1.id) },
      orderBy: { id: 'desc' }
    });
    assert.ok(reopenEv, 'session_reopened event must be logged');

    const rCustSessAfter = createMockReqRes({ query: { date: dateStr } });
    await getSessions(rCustSessAfter.req, rCustSessAfter.res);
    assert.ok(rCustSessAfter.res.getBody().some((s) => s.id === s1.id), 'Reopened s1 visible to customers');

    // 4. Empty session tEmpty is hard-deleted by deleteSession; test deleteSessionsByDate counts too
    const rDelEmpty = createMockReqRes({ params: { id: String(tEmpty.id) }, user: adminUser });
    await deleteSession(rDelEmpty.req, rDelEmpty.res);
    assert.equal(rDelEmpty.res.getStatusCode(), 200);
    assert.equal(rDelEmpty.res.getBody().action, 'deleted');
    assert.equal(await prisma.session.findUnique({ where: { id: tEmpty.id } }), null);

    const tBulkEmpty = await prisma.session.create({
      data: { session_date: sessionDate, start_time: '13:00', end_time: '14:00', max_capacity: 16 }
    });
    createdSessionIds.push(tBulkEmpty.id);
    const rDelDate = createMockReqRes({ params: { date: dateStr }, user: adminUser });
    await deleteSessionsByDate(rDelDate.req, rDelDate.res);
    assert.equal(rDelDate.res.getStatusCode(), 200);
    assert.equal(rDelDate.res.getBody().deletedCount, 1); // tBulkEmpty deleted
    assert.equal(rDelDate.res.getBody().closedCount, 1); // s1 closed again
    assert.equal(rDelDate.res.getBody().keptCount, 1); // s2 kept due to refC

    // 5. Hard deleting R (has Payments) -> 409; archiving R -> 200 & hidden from default list, visible in archived filter
    const rDetailsR = createMockReqRes({ params: { booking_ref: refR }, user: adminUser });
    await getAdminReservationDetails(rDetailsR.req, rDetailsR.res);
    assert.equal(rDetailsR.res.getStatusCode(), 200);
    assert.equal(rDetailsR.res.getBody().can_permanent_delete, false);

    const rDelR = createMockReqRes({ params: { id: refR }, user: adminUser });
    await deleteReservationRecord(rDelR.req, rDelR.res);
    assert.equal(rDelR.res.getStatusCode(), 409);
    assert.equal(rDelR.res.getBody().error, '有收款紀錄，只能封存');

    const rArchR = createMockReqRes({ params: { id: refR }, user: adminUser });
    await archiveReservationRecord(rArchR.req, rArchR.res);
    assert.equal(rArchR.res.getStatusCode(), 200);

    const rListDefault = createMockReqRes({
      query: { scope: 'day', date: dateStr, status: 'all' },
      user: adminUser
    });
    await getAdminReservations(rListDefault.req, rListDefault.res);
    assert.equal(rListDefault.res.getStatusCode(), 200);
    assert.ok(!rListDefault.res.getBody().data.some((r) => r.booking_ref === refR), 'Archived R hidden from default list');

    const rListArchived = createMockReqRes({
      query: { scope: 'day', date: dateStr, status: 'archived' },
      user: adminUser
    });
    await getAdminReservations(rListArchived.req, rListArchived.res);
    assert.equal(rListArchived.res.getStatusCode(), 200);
    assert.ok(rListArchived.res.getBody().data.some((r) => r.booking_ref === refR), 'Archived R visible in archived filter');

    // 6. Cancelled reservation Q with zero Payments/BookingPrepays -> permanent delete succeeds & logs before_json
    const refQ = `R46-Q-${crypto.randomUUID().slice(0, 8)}`;
    createdRefs.push(refQ);
    await prisma.reservation.create({
      data: {
        booking_ref: refQ,
        session_id: s1.id,
        user_id: cust.id,
        pax: 3,
        status: 'cancelled',
        cancelled_at: new Date(),
        cancelled_by: '測試人員'
      }
    });

    const rDetailsQ = createMockReqRes({ params: { booking_ref: refQ }, user: adminUser });
    await getAdminReservationDetails(rDetailsQ.req, rDetailsQ.res);
    assert.equal(rDetailsQ.res.getStatusCode(), 200);
    assert.equal(rDetailsQ.res.getBody().can_permanent_delete, true);

    const rDelQ = createMockReqRes({ params: { id: refQ }, user: adminUser });
    await deleteReservationRecord(rDelQ.req, rDelQ.res);
    assert.equal(rDelQ.res.getStatusCode(), 200);
    assert.equal(await prisma.reservation.count({ where: { booking_ref: refQ } }), 0);

    const delQEv = await prisma.accountingEvent.findFirst({
      where: { event_type: 'reservation_deleted', booking_ref: refQ },
      orderBy: { id: 'desc' }
    });
    assert.ok(delQEv);
    assert.equal(delQEv.category, 'status');
    assert.equal(delQEv.before_json?.session_date, dateStr);
    assert.equal(delQEv.before_json?.pax, 3);
    assert.equal(delQEv.before_json?.user_id, cust.id);
  } finally {
    if (createdRefs.length > 0) {
      await prisma.payment.deleteMany({ where: { booking_ref: { in: createdRefs } } });
      await prisma.bookingPrepay.deleteMany({ where: { booking_ref: { in: createdRefs } } });
      await prisma.bookingEquipment.deleteMany({ where: { booking_ref: { in: createdRefs } } });
      await prisma.bookingPerson.deleteMany({ where: { booking_ref: { in: createdRefs } } });
      await prisma.reservation.deleteMany({ where: { booking_ref: { in: createdRefs } } });
    }
    if (createdSessionIds.length > 0) {
      await prisma.session.deleteMany({ where: { id: { in: createdSessionIds } } });
    }
    if (createdUserIds.length > 0) {
      await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    }
  }
});
