import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import cookieParser from 'cookie-parser';
import prisma from '../src/prismaClient.js';
import { generateToken } from '../src/middlewares/authMiddleware.js';
import billingRoutes from '../src/routes/billing.js';
import checkoutRoutes from '../src/routes/checkout.js';
import passRoutes from '../src/routes/passes.js';
import { dateOnly } from '../../shared/time.js';

function startLocalApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/billing', billingRoutes);
  app.use('/api/checkout', checkoutRoutes);
  app.use('/api/passes', passRoutes);

  const server = http.createServer(app);
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', (err) => {
      if (err) return reject(err);
      const port = server.address().port;
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        close: () => new Promise((res) => server.close(res)),
      });
    });
  });
}

test('Round 33 Item 2: MONEY_WRITE, COUPON_WRITE, and PASS_GRANT permission enforcement', async (t) => {
  const runId = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const bookingRefA = `R33I2A_${runId}`;
  const bookingRefB = `R33I2B_${runId}`;
  const promoCodeStr = `R33PROMO_${runId}`.toUpperCase();

  let srv = null;
  let origGlobalSetting = null;
  let customer = null;
  let session = null;
  let passPlan = null;
  const createdAdmins = [];
  const createdPromoIds = [];

  t.after(async () => {
    if (srv) await srv.close().catch(() => {});

    for (const ref of [bookingRefA, bookingRefB]) {
      await prisma.printJob.deleteMany({ where: { booking_ref: ref } }).catch(() => {});
      await prisma.payment.deleteMany({ where: { booking_ref: ref } }).catch(() => {});
      await prisma.bookingPerson.deleteMany({ where: { booking_ref: ref } }).catch(() => {});
      await prisma.reservation.deleteMany({ where: { booking_ref: ref } }).catch(() => {});
    }
    if (customer?.id) {
      await prisma.userPass.deleteMany({ where: { user_id: customer.id } }).catch(() => {});
    }
    if (passPlan?.id) {
      await prisma.passPlan.delete({ where: { id: passPlan.id } }).catch(() => {});
    }
    if (createdPromoIds.length > 0) {
      await prisma.promoCode.deleteMany({ where: { id: { in: createdPromoIds } } }).catch(() => {});
    }
    await prisma.promoCode.deleteMany({ where: { code: promoCodeStr } }).catch(() => {});
    if (session?.id) {
      await prisma.session.delete({ where: { id: session.id } }).catch(() => {});
    }
    if (customer?.id) {
      await prisma.user.delete({ where: { id: customer.id } }).catch(() => {});
    }
    if (createdAdmins.length > 0) {
      await prisma.adminUser.deleteMany({ where: { id: { in: createdAdmins.map((a) => a.id) } } }).catch(() => {});
    }
    if (origGlobalSetting) {
      await prisma.globalSetting.update({
        where: { id: 1 },
        data: {
          weekday_hourly_price: origGlobalSetting.weekday_hourly_price,
          weekday_unlimited_price: origGlobalSetting.weekday_unlimited_price,
          billing_grace_minutes: origGlobalSetting.billing_grace_minutes,
          billing_block_minutes: origGlobalSetting.billing_block_minutes,
        },
      }).catch(() => {});
    }
  });

  origGlobalSetting = await prisma.globalSetting.findUnique({ where: { id: 1 } });
  await prisma.globalSetting.upsert({
    where: { id: 1 },
    update: {
      weekday_hourly_price: 100,
      weekday_unlimited_price: 550,
      billing_grace_minutes: 10,
      billing_block_minutes: 30,
    },
    create: {
      id: 1,
      weekday_hourly_price: 100,
      weekday_unlimited_price: 550,
      billing_grace_minutes: 10,
      billing_block_minutes: 30,
    },
  });

  customer = await prisma.user.create({
    data: {
      line_user_id: `r33_i2_cust_${runId}`,
      name: 'R33 Test Customer',
      phone: '0900000332',
    },
  });

  // 2099-05-06 is a Wednesday (weekday -> 100/hr * 5h = 500 per person)
  session = await prisma.session.create({
    data: {
      session_date: dateOnly('2099-05-06'),
      start_time: '13:00',
      end_time: '18:00',
      max_capacity: 20,
    },
  });

  await prisma.reservation.create({
    data: {
      booking_ref: bookingRefA,
      user_id: customer.id,
      session_id: session.id,
      pax: 2,
      assigned_seats: ['A1-1', 'A1-2'],
      status: 'confirmed',
    },
  });
  await prisma.bookingPerson.createMany({
    data: [
      { booking_ref: bookingRefA, person_no: 1, seat_code: 'A1-1', status: 'active' },
      { booking_ref: bookingRefA, person_no: 2, seat_code: 'A1-2', status: 'active' },
    ],
  });

  await prisma.reservation.create({
    data: {
      booking_ref: bookingRefB,
      user_id: customer.id,
      session_id: session.id,
      pax: 1,
      assigned_seats: ['A1-3'],
      status: 'confirmed',
    },
  });
  await prisma.bookingPerson.create({
    data: { booking_ref: bookingRefB, person_no: 1, seat_code: 'A1-3', status: 'active' },
  });

  passPlan = await prisma.passPlan.create({
    data: {
      code: `R33PLAN_${runId}`,
      name: `R33 Test Plan ${runId}`,
      pass_type: 'PUNCH_CARD',
      total_quota: 5,
      valid_days: 30,
      price: 500,
      is_active: true,
    },
  });

  const permRoles = ['seating', 'weekly', 'equipment', 'coupons', 'accounting', 'reservations', 'members'];
  const tokens = {};
  for (const perm of permRoles) {
    const staff = await prisma.adminUser.create({
      data: {
        name: `r33_${perm}_${runId}`,
        password: `r33_pw_${perm}_${runId}`,
        role: 'staff',
        permissions: [perm],
        is_active: true,
      },
    });
    createdAdmins.push(staff);
    tokens[perm] = generateToken({
      id: staff.id,
      role: 'admin',
      isSuperAdmin: false,
      token_version: staff.token_version,
    });
  }

  srv = await startLocalApp();
  const baseUrl = srv.baseUrl;
  const authHeaders = (perm) => ({
    'Content-Type': 'application/json',
    Authorization: `Bearer ${tokens[perm]}`,
  });

  // 1. Seating staff CAN read bill, save draft, and collect payment (daily checkout untouched)
  const billInitRes = await fetch(`${baseUrl}/api/billing/${bookingRefA}`, { headers: authHeaders('seating') });
  assert.equal(billInitRes.status, 200);
  const billInitBody = await billInitRes.json();

  const draftRes = await fetch(`${baseUrl}/api/billing/${bookingRefA}/draft`, {
    method: 'PUT',
    headers: authHeaders('seating'),
    body: JSON.stringify({
      base_rev: billInitBody.draft_rev || 0,
      draft: billInitBody.draft || {},
    }),
  });
  assert.equal(draftRes.status, 200);

  const collectARes = await fetch(`${baseUrl}/api/billing/${bookingRefA}/collect`, {
    method: 'POST',
    headers: authHeaders('seating'),
    body: JSON.stringify({ person_nos: [1], method: 'cash', print: false }),
  });
  assert.equal(collectARes.status, 200);
  const collectABody = await collectARes.json();
  assert.equal(collectABody.bill.summary.amount_received, 500);
  const paymentAId = collectABody.payments[0].id;

  const collectBRes = await fetch(`${baseUrl}/api/billing/${bookingRefB}/collect`, {
    method: 'POST',
    headers: authHeaders('seating'),
    body: JSON.stringify({ person_nos: [1], method: 'cash', print: false }),
  });
  assert.equal(collectBRes.status, 200);
  const paymentBId = (await collectBRes.json()).payments[0].id;

  const eventsBeforeA = await prisma.accountingEvent.count({ where: { booking_ref: bookingRefA } });

  // 2. seating, weekly, equipment, coupons get 403 PERMISSION_REQUIRED on refund/waive/mark-unpaid/void
  for (const perm of ['seating', 'weekly', 'equipment', 'coupons']) {
    const rRefund = await fetch(`${baseUrl}/api/billing/${bookingRefA}/refund`, {
      method: 'POST',
      headers: authHeaders(perm),
      body: JSON.stringify({ person_no: 1, amount: 100, method: 'cash', reason: 'unauth', print: false }),
    });
    assert.equal(rRefund.status, 403, `Expected 403 on refund for ${perm}`);
    const bRefund = await rRefund.json();
    assert.equal(bRefund.code, 'PERMISSION_REQUIRED');
    assert.deepEqual(bRefund.required, ['accounting', 'reservations']);
    assert.equal(bRefund.error, '需要「帳務管理」或「預約訂單總覽」權限');

    const rWaive = await fetch(`${baseUrl}/api/billing/${bookingRefA}/waive`, {
      method: 'POST',
      headers: authHeaders(perm),
      body: JSON.stringify({ person_nos: [2], reason: 'unauth', print: false }),
    });
    assert.equal(rWaive.status, 403, `Expected 403 on waive for ${perm}`);
    assert.equal((await rWaive.json()).code, 'PERMISSION_REQUIRED');

    const rUnpaid = await fetch(`${baseUrl}/api/billing/${bookingRefA}/mark-unpaid`, {
      method: 'POST',
      headers: authHeaders(perm),
      body: JSON.stringify({ reason: 'unauth' }),
    });
    assert.equal(rUnpaid.status, 403, `Expected 403 on mark-unpaid for ${perm}`);
    assert.equal((await rUnpaid.json()).code, 'PERMISSION_REQUIRED');

    const rVoid = await fetch(`${baseUrl}/api/billing/payments/${paymentAId}/void`, {
      method: 'POST',
      headers: authHeaders(perm),
      body: JSON.stringify({ reason: 'unauth' }),
    });
    assert.equal(rVoid.status, 403, `Expected 403 on void for ${perm}`);
    assert.equal((await rVoid.json()).code, 'PERMISSION_REQUIRED');
  }

  // Verify DB state and AccountingEvent unchanged after all 403 attempts
  assert.equal(await prisma.accountingEvent.count({ where: { booking_ref: bookingRefA } }), eventsBeforeA);
  const validPaymentsA = await prisma.payment.findMany({ where: { booking_ref: bookingRefA, status: 'valid' } });
  assert.equal(validPaymentsA.length, 1);
  assert.equal(validPaymentsA[0].amount, 500);

  // 3. accounting & reservations succeed on MONEY_WRITE
  const acctRefundRes = await fetch(`${baseUrl}/api/billing/${bookingRefA}/refund`, {
    method: 'POST',
    headers: authHeaders('accounting'),
    body: JSON.stringify({ person_no: 1, amount: 100, method: 'cash', reason: '部分退費', print: false }),
  });
  assert.equal(acctRefundRes.status, 200);
  const acctRefundBody = await acctRefundRes.json();
  assert.equal(acctRefundBody.bill.summary.amount_received, 400);

  const resvWaiveRes = await fetch(`${baseUrl}/api/billing/${bookingRefA}/waive`, {
    method: 'POST',
    headers: authHeaders('reservations'),
    body: JSON.stringify({ person_nos: [2], reason: '免收測試', print: false }),
  });
  assert.equal(resvWaiveRes.status, 200);

  // Use bookingRefB (no prior refund) for mark-unpaid, void, and reservations refund
  const resvUnpaidRes = await fetch(`${baseUrl}/api/billing/${bookingRefB}/mark-unpaid`, {
    method: 'POST',
    headers: authHeaders('reservations'),
    body: JSON.stringify({ reason: '標記未結清測試' }),
  });
  assert.equal(resvUnpaidRes.status, 200);

  const reCollect1 = await fetch(`${baseUrl}/api/billing/${bookingRefB}/collect`, {
    method: 'POST',
    headers: authHeaders('seating'),
    body: JSON.stringify({ person_nos: [1], method: 'cash', print: false }),
  });
  assert.equal(reCollect1.status, 200);
  const reCollect1PayId = (await reCollect1.json()).payments[0].id;

  const acctVoidBRes = await fetch(`${baseUrl}/api/billing/payments/${reCollect1PayId}/void`, {
    method: 'POST',
    headers: authHeaders('accounting'),
    body: JSON.stringify({ reason: '帳務權限作廢' }),
  });
  assert.equal(acctVoidBRes.status, 200);

  const reCollect2 = await fetch(`${baseUrl}/api/billing/${bookingRefB}/collect`, {
    method: 'POST',
    headers: authHeaders('seating'),
    body: JSON.stringify({ person_nos: [1], method: 'cash', print: false }),
  });
  assert.equal(reCollect2.status, 200);

  const resvRefundBRes = await fetch(`${baseUrl}/api/billing/${bookingRefB}/refund`, {
    method: 'POST',
    headers: authHeaders('reservations'),
    body: JSON.stringify({ person_no: 1, amount: 100, method: 'cash', reason: '預約權限退款', print: false }),
  });
  assert.equal(resvRefundBRes.status, 200);
  assert.equal((await resvRefundBRes.json()).bill.summary.amount_received, 400);

  // 4. Promo codes: all 6 checkout roles can GET; only coupons can POST/PUT/DELETE
  for (const perm of ['seating', 'weekly', 'equipment', 'coupons', 'accounting', 'reservations']) {
    const rGetPromos = await fetch(`${baseUrl}/api/checkout/promo-codes`, { headers: authHeaders(perm) });
    assert.equal(rGetPromos.status, 200, `Expected GET /promo-codes 200 for ${perm}`);
  }

  for (const perm of ['seating', 'weekly', 'equipment', 'accounting', 'reservations']) {
    const rCreatePromo = await fetch(`${baseUrl}/api/checkout/promo-codes`, {
      method: 'POST',
      headers: authHeaders(perm),
      body: JSON.stringify({ code: promoCodeStr, name: 'Unauth Promo', discount_type: 'fixed_order', discount_value: 50 }),
    });
    assert.equal(rCreatePromo.status, 403, `Expected POST /promo-codes 403 for ${perm}`);
    const body = await rCreatePromo.json();
    assert.equal(body.code, 'PERMISSION_REQUIRED');
    assert.deepEqual(body.required, ['coupons']);
  }

  const createPromoRes = await fetch(`${baseUrl}/api/checkout/promo-codes`, {
    method: 'POST',
    headers: authHeaders('coupons'),
    body: JSON.stringify({
      code: promoCodeStr,
      name: 'R33 Valid Promo',
      discount_type: 'fixed_order',
      discount_value: 30,
      channel: 'pos',
    }),
  });
  assert.ok(createPromoRes.ok, `Expected coupons POST /promo-codes success, got ${createPromoRes.status}`);
  const createdPromo = await createPromoRes.json();
  const promoId = createdPromo.promo?.id || createdPromo.id;
  assert.ok(promoId);
  createdPromoIds.push(promoId);

  for (const perm of ['accounting', 'reservations']) {
    const rPutPromo = await fetch(`${baseUrl}/api/checkout/promo-codes/${promoId}`, {
      method: 'PUT',
      headers: authHeaders(perm),
      body: JSON.stringify({ name: 'Hijacked' }),
    });
    assert.equal(rPutPromo.status, 403);
    const rDelPromo = await fetch(`${baseUrl}/api/checkout/promo-codes/${promoId}`, {
      method: 'DELETE',
      headers: authHeaders(perm),
    });
    assert.equal(rDelPromo.status, 403);
  }

  const putPromoRes = await fetch(`${baseUrl}/api/checkout/promo-codes/${promoId}`, {
    method: 'PUT',
    headers: authHeaders('coupons'),
    body: JSON.stringify({ name: 'R33 Updated Promo' }),
  });
  assert.equal(putPromoRes.status, 200);

  const delPromoRes = await fetch(`${baseUrl}/api/checkout/promo-codes/${promoId}`, {
    method: 'DELETE',
    headers: authHeaders('coupons'),
  });
  assert.equal(delPromoRes.status, 200);

  // 5. Pass grant: only coupons succeeds; reservations & members get 403
  for (const perm of ['reservations', 'members', 'seating', 'accounting']) {
    const rGrant = await fetch(`${baseUrl}/api/passes/admin/grant`, {
      method: 'POST',
      headers: authHeaders(perm),
      body: JSON.stringify({ user_id: customer.id, plan_id: passPlan.id }),
    });
    assert.equal(rGrant.status, 403, `Expected POST /passes/admin/grant 403 for ${perm}`);
    const body = await rGrant.json();
    assert.equal(body.code, 'PERMISSION_REQUIRED');
    assert.deepEqual(body.required, ['coupons']);
  }

  const grantOkRes = await fetch(`${baseUrl}/api/passes/admin/grant`, {
    method: 'POST',
    headers: authHeaders('coupons'),
    body: JSON.stringify({ user_id: customer.id, plan_id: passPlan.id }),
  });
  assert.ok(grantOkRes.ok, `Expected coupons POST /passes/admin/grant success, got ${grantOkRes.status}`);
});
