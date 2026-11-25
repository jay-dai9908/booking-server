import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import cookieParser from 'cookie-parser';
import prisma from '../src/prismaClient.js';
import { generateToken } from '../src/middlewares/authMiddleware.js';
import reservationRoutes from '../src/routes/reservations.js';
import accountingRoutes from '../src/routes/accounting.js';
import { dateOnly, toTaipeiDateString } from '../../shared/time.js';
import { ensureTestPublishedLayout, cleanupTestPublishedLayout } from './helpers/seedTestLayout.js';
import { processKioskAccess } from '../src/services/kiosk/accessService.js';
import { voidPayment } from '../src/services/billing/billService.js';

function startLocalApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/reservations', reservationRoutes);
  app.use('/api/accounting', accountingRoutes);

  const server = http.createServer(app);
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', (err) => {
      if (err) return reject(err);
      const port = server.address().port;
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        close: () => new Promise((res) => server.close(res))
      });
    });
  });
}

test('Round 45 Item 1: prepay received_amount verify (shortfall/exact/overpaid), overpaid-refunded, mismatch audit, void reset, and DB pagination', async () => {
  const runId = `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const futureDateObj = new Date(Date.now() + 14 * 86400000);
  const futureStr = toTaipeiDateString(futureDateObj);
  const targetDate = dateOnly(futureStr);
  const bankCode = `r45_bank_${runId}`;

  let srv = null;
  let staffUser = null;
  let customer = null;
  const createdSessionIds = [];
  const createdRefs = [];
  let createdLayoutIds = [];

  try {
    createdLayoutIds = await ensureTestPublishedLayout(prisma);
    srv = await startLocalApp();

    staffUser = await prisma.adminUser.create({
      data: {
        password: `R45I1_${runId}_Pass!`,
        name: `R45對帳測試_${runId}`,
        permissions: ['reservations', 'accounting', 'seating'],
        is_active: true
      }
    });
    const adminToken = generateToken({
      id: staffUser.id,
      role: 'admin',
      name: staffUser.name,
      permissions: ['reservations', 'accounting', 'seating'],
      token_version: staffUser.token_version
    });
    const adminHeaders = {
      Authorization: `Bearer ${adminToken}`,
      'Content-Type': 'application/json'
    };

    customer = await prisma.user.create({
      data: {
        line_user_id: `r45_i1_cust_${runId}`,
        name: 'R45半自助測試客',
        phone: `09451${String(Date.now()).slice(-5)}`
      }
    });
    const custToken = generateToken({
      id: customer.id,
      typ: 'customer',
      line_user_id: customer.line_user_id,
      role: 'customer',
      name: customer.name
    });
    const custHeaders = {
      Authorization: `Bearer ${custToken}`,
      'Content-Type': 'application/json'
    };

    await prisma.paymentMethodConfig.create({
      data: {
        code: bankCode,
        name: 'R45測試銀行轉帳',
        method_type: 'MULTI_BANK',
        is_enabled: true,
        sort_order: 99,
        bank_accounts_json: [{ bank_name: '測試銀行', bank_code: '999', account_number: '9990000000001' }]
      }
    });

    await prisma.dailySetting.upsert({
      where: { date: targetDate },
      update: {
        is_self_service: true,
        unlimited_price: 550,
        hourly_price: 150,
        allow_unlimited: true
      },
      create: {
        date: targetDate,
        is_self_service: true,
        unlimited_price: 550,
        hourly_price: 150,
        allow_unlimited: true
      }
    });

    const slots = [
      ['13:00', '14:00'],
      ['14:00', '15:00'],
      ['15:00', '16:00'],
      ['16:00', '17:00'],
      ['17:00', '18:00'],
      ['18:00', '19:00'],
      ['19:00', '20:00'],
      ['20:00', '21:00']
    ];
    for (const [st, et] of slots) {
      const s = await prisma.session.upsert({
        where: { session_date_start_time: { session_date: targetDate, start_time: st } },
        update: { max_capacity: 40 },
        create: { session_date: targetDate, start_time: st, end_time: et, max_capacity: 40 }
      });
      createdSessionIds.push(s.id);
    }

    const createSelfBooking = async () => {
      const res = await fetch(`${srv.baseUrl}/api/reservations`, {
        method: 'POST',
        headers: custHeaders,
        body: JSON.stringify({
          session_ids: createdSessionIds,
          pax: 2,
          isUnlimited: true,
          self_service_ack: true,
          prepay: {
            pass_uses: [],
            transfer: { payment_method_code: bankCode },
            expected_transfer_amount: 1100
          }
        })
      });
      const body = await res.json();
      assert.equal(res.status, 201, `createSelfBooking failed: ${JSON.stringify(body)}`);
      const bRef = body.reservation.booking_ref;
      createdRefs.push(bRef);
      return bRef;
    };

    // -------------------------------------------------------------------------
    // Case A: Shortfall verify (1000 -> mismatch, 0 Payment, prepay_short, kiosk UNVERIFIED) ->補 100 -> verified
    // -------------------------------------------------------------------------
    const refShort = await createSelfBooking();

    // Missing received_amount -> 422
    const vMissing = await fetch(`${srv.baseUrl}/api/reservations/admin/prepays/${refShort}/verify`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({})
    });
    assert.equal(vMissing.status, 422);

    // Report 1000 (< 1100)
    const v1 = await fetch(`${srv.baseUrl}/api/reservations/admin/prepays/${refShort}/verify`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ received_amount: 1000 })
    });
    assert.equal(v1.status, 200);
    const v1Body = await v1.json();
    assert.equal(v1Body.status, 'mismatch');
    assert.equal(v1Body.received_amount, 1000);
    assert.equal(v1Body.shortfall, 100);

    assert.equal(await prisma.payment.count({ where: { booking_ref: refShort, status: 'valid' } }), 0);
    const shortEv = await prisma.accountingEvent.findFirst({
      where: { booking_ref: refShort, event_type: 'prepay_short' }
    });
    assert.ok(shortEv, 'prepay_short audit event must be logged');
    assert.equal(shortEv.category, 'prepay');

    const kioskDeny = await processKioskAccess(prisma, {
      method: 'phone',
      payload: customer.phone,
      now: new Date(`${futureStr}T13:05:00+08:00`)
    });
    assert.equal(kioskDeny.result, 'UNVERIFIED');
    assert.equal(kioskDeny.open_door, false);

    // Customer pays remaining 100 -> cumulative = 1100 -> settles!
    const v2 = await fetch(`${srv.baseUrl}/api/reservations/admin/prepays/${refShort}/verify`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ received_amount: 100 })
    });
    assert.equal(v2.status, 200);
    const prepayShortDone = await prisma.bookingPrepay.findUnique({ where: { booking_ref: refShort } });
    assert.equal(prepayShortDone.status, 'verified');
    assert.equal(prepayShortDone.received_amount, 1100);
    const shortPayments = await prisma.payment.findMany({ where: { booking_ref: refShort, status: 'valid' } });
    assert.equal(shortPayments.reduce((s, p) => s + p.amount, 0), 1100);

    // -------------------------------------------------------------------------
    // Case B: Overpaid 1200 on 1100 -> Payment=1100, overpaid=100, summary +1100 only, overpaid-refunded
    // -------------------------------------------------------------------------
    const todayStr = toTaipeiDateString(new Date());
    const sumBeforeRes = await fetch(`${srv.baseUrl}/api/accounting/summary?start_date=${todayStr}&end_date=${todayStr}`, {
      headers: adminHeaders
    });
    const sumBefore = await sumBeforeRes.json();

    const refOver = await createSelfBooking();
    const vOver = await fetch(`${srv.baseUrl}/api/reservations/admin/prepays/${refOver}/verify`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ received_amount: 1200 })
    });
    assert.equal(vOver.status, 200);
    const prepayOver = await prisma.bookingPrepay.findUnique({ where: { booking_ref: refOver } });
    assert.equal(prepayOver.status, 'verified');
    assert.equal(prepayOver.received_amount, 1200);
    assert.equal(prepayOver.overpaid_amount, 100);

    const overPayments = await prisma.payment.findMany({ where: { booking_ref: refOver, status: 'valid' } });
    assert.equal(overPayments.length, 1);
    assert.equal(overPayments[0].amount, 1100, 'Payment must record exact amount_due 1100, not overpaid 1200');
    assert.ok(await prisma.accountingEvent.findFirst({ where: { booking_ref: refOver, event_type: 'prepay_overpaid' } }));

    const sumAfterRes = await fetch(`${srv.baseUrl}/api/accounting/summary?start_date=${todayStr}&end_date=${todayStr}`, {
      headers: adminHeaders
    });
    const sumAfter = await sumAfterRes.json();
    assert.equal(sumAfter.net_revenue - sumBefore.net_revenue, 1100, 'net_revenue must exclude overpaid 100');

    const refOverBtn = await fetch(`${srv.baseUrl}/api/reservations/admin/prepays/${refOver}/overpaid-refunded`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ note: '已轉回' })
    });
    assert.equal(refOverBtn.status, 200);
    const refundEv = await prisma.accountingEvent.findFirst({
      where: { booking_ref: refOver, event_type: 'prepay_overpaid_refunded' }
    });
    assert.ok(refundEv);
    assert.equal(refundEv.amount, -100);

    // Repeating overpaid-refunded -> 409
    const refOverAgain = await fetch(`${srv.baseUrl}/api/reservations/admin/prepays/${refOver}/overpaid-refunded`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ note: '重複按' })
    });
    assert.equal(refOverAgain.status, 409);

    // -------------------------------------------------------------------------
    // Case C: Mismatch button logs prepay_mismatch with note reason
    // -------------------------------------------------------------------------
    const refMis = await createSelfBooking();
    const misRes = await fetch(`${srv.baseUrl}/api/reservations/admin/prepays/${refMis}/mismatch`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ note: '只收到 900' })
    });
    assert.equal(misRes.status, 200);
    const misEv = await prisma.accountingEvent.findFirst({
      where: { booking_ref: refMis, event_type: 'prepay_mismatch' }
    });
    assert.ok(misEv);
    assert.equal(misEv.reason, '只收到 900');

    // -------------------------------------------------------------------------
    // Case D: Void verified payment -> status back to reported_pending_verify, received_amount = null, both audit events, re-verify succeeds
    // -------------------------------------------------------------------------
    await voidPayment(
      shortPayments[0].id,
      '作廢重對測試',
      { id: staffUser.id, name: staffUser.name },
      { device_label: 'r45-test' }
    );
    const prepayReopened = await prisma.bookingPrepay.findUnique({ where: { booking_ref: refShort } });
    assert.equal(prepayReopened.status, 'reported_pending_verify');
    assert.equal(prepayReopened.received_amount, null);
    assert.equal(prepayReopened.overpaid_amount, null);
    assert.ok(await prisma.accountingEvent.findFirst({ where: { booking_ref: refShort, event_type: 'prepay_reopened' } }));
    assert.ok(await prisma.accountingEvent.findFirst({ where: { booking_ref: refShort, event_type: 'prepay_received_reset' } }));

    const vRe = await fetch(`${srv.baseUrl}/api/reservations/admin/prepays/${refShort}/verify`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ received_amount: 1100 })
    });
    assert.equal(vRe.status, 200);
    const prepayAfterRe = await prisma.bookingPrepay.findUnique({ where: { booking_ref: refShort } });
    assert.equal(prepayAfterRe.received_amount, 1100);

    // -------------------------------------------------------------------------
    // Case E: 45 records DB pagination (page=1 -> 30, page=2 -> 15, total=45, counts accurate)
    // -------------------------------------------------------------------------
    // Clean the 3 bookings above so counts are strictly the 45 seeded rows
    await prisma.payment.deleteMany({ where: { booking_ref: { in: createdRefs } } });
    await prisma.bookingPrepay.deleteMany({ where: { booking_ref: { in: createdRefs } } });
    await prisma.bookingPerson.deleteMany({ where: { booking_ref: { in: createdRefs } } });
    await prisma.reservation.deleteMany({ where: { booking_ref: { in: createdRefs } } });
    createdRefs.length = 0;

    const bulkStatuses = [];
    for (let i = 0; i < 45; i += 1) {
      const st = i < 20 ? 'reported_pending_verify' : i < 35 ? 'pending_payment' : 'verified';
      const bRef = `R45P-${runId}-${String(i).padStart(2, '0')}`;
      createdRefs.push(bRef);
      bulkStatuses.push({ bRef, st, i });
    }
    await prisma.bookingPrepay.createMany({
      data: bulkStatuses.map(({ bRef, st, i }) => ({
        booking_ref: bRef,
        user_id: customer.id,
        total_amount: 1100,
        amount_due: 1100,
        status: st,
        deadline_at: new Date(Date.now() + (i + 1) * 60000)
      }))
    });

    const p1Res = await fetch(`${srv.baseUrl}/api/reservations/admin/prepays?status=all&page=1&limit=30`, { headers: adminHeaders });
    assert.equal(p1Res.status, 200);
    const p1Body = await p1Res.json();
    assert.equal(p1Body.total, 45);
    assert.equal(p1Body.total_pages, 2);
    assert.equal(p1Body.items.length, 30);
    assert.equal(p1Body.counts.reported_pending_verify, 20);
    assert.equal(p1Body.counts.pending_payment, 15);
    assert.equal(p1Body.counts.verified, 10);

    const p2Res = await fetch(`${srv.baseUrl}/api/reservations/admin/prepays?status=all&page=2&limit=30`, { headers: adminHeaders });
    const p2Body = await p2Res.json();
    assert.equal(p2Body.items.length, 15);
  } finally {
    await srv?.close().catch(() => {});
    if (createdRefs.length > 0) {
      await prisma.payment.deleteMany({ where: { booking_ref: { in: createdRefs } } }).catch(() => {});
      await prisma.bookingPrepay.deleteMany({ where: { booking_ref: { in: createdRefs } } }).catch(() => {});
      await prisma.bookingPerson.deleteMany({ where: { booking_ref: { in: createdRefs } } }).catch(() => {});
      await prisma.reservation.deleteMany({ where: { booking_ref: { in: createdRefs } } }).catch(() => {});
    }
    if (createdSessionIds.length > 0) {
      await prisma.session.deleteMany({ where: { id: { in: createdSessionIds } } }).catch(() => {});
    }
    await prisma.dailySetting.deleteMany({ where: { date: targetDate } }).catch(() => {});
    await prisma.paymentMethodConfig.deleteMany({ where: { code: bankCode } }).catch(() => {});
    if (customer?.id) {
      await prisma.user.deleteMany({ where: { id: customer.id } }).catch(() => {});
    }
    if (staffUser?.id) {
      await prisma.adminUser.deleteMany({ where: { id: staffUser.id } }).catch(() => {});
    }
    await cleanupTestPublishedLayout(prisma, createdLayoutIds).catch(() => {});
  }
});
