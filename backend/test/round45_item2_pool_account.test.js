import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import cookieParser from 'cookie-parser';
import prisma from '../src/prismaClient.js';
import { generateToken } from '../src/middlewares/authMiddleware.js';
import shopRoutes from '../src/routes/shop.js';
import reservationRoutes from '../src/routes/reservations.js';
import {
  assignPoolAccount,
  releasePoolAccount,
  markPoolAccountUsed
} from '../src/services/selfService/poolAccountService.js';
import { dateOnly, toTaipeiDateString } from '../../shared/time.js';
import { ensureTestPublishedLayout, cleanupTestPublishedLayout } from './helpers/seedTestLayout.js';

function startLocalApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/shop', shopRoutes);
  app.use('/api/reservations', reservationRoutes);

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

test('Round 45 Item 2: poolAccountService orderRef required, reuse safety, reported-cancel hold & manual release', async () => {
  await assert.rejects(
    () => releasePoolAccount(prisma, { accountNumber: '9990000000001' }),
    /releasePoolAccount requires orderRef/
  );
  await assert.rejects(
    () => markPoolAccountUsed(prisma, { accountNumber: '9990000000001' }),
    /markPoolAccountUsed requires orderRef/
  );

  const runId = `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const acct1 = `99900001${String(Date.now()).slice(-5)}`;
  const acct2 = `99900002${String(Date.now()).slice(-5)}`;
  const acct3 = `99900003${String(Date.now()).slice(-5)}`;
  const acct4 = `99900004${String(Date.now()).slice(-5)}`;
  const futureStr = toTaipeiDateString(new Date(Date.now() + 15 * 86400000));
  const targetDate = dateOnly(futureStr);
  const poolMethodCode = `r45_pool_${runId}`;

  let srv = null;
  let staffUser = null;
  let customer = null;
  let product = null;
  let session = null;
  let createdPoolMethod = false;
  let createdLayoutId = null;
  const createdOrderRefs = [];
  const createdBookingRefs = [];
  const createdPoolAccounts = [acct1, acct2, acct3, acct4];

  try {
    createdLayoutId = await ensureTestPublishedLayout(prisma);
    srv = await startLocalApp();

    // Ensure ctbc_pool method config exists so release/assign checks work
    const existingPoolMethod = await prisma.paymentMethodConfig.findUnique({ where: { code: poolMethodCode } });
    if (!existingPoolMethod) {
      await prisma.paymentMethodConfig.create({
        data: {
          code: poolMethodCode,
          name: '中信專屬一次帳號',
          method_type: 'POOL_ACCOUNT',
          is_enabled: true
        }
      });
      createdPoolMethod = true;
    }

    // Seed synthetic pool accounts cleanly
    await prisma.oneTimeAccountPool.deleteMany({ where: { account_number: { in: createdPoolAccounts } } });
    for (const acct of [acct1, acct2, acct3, acct4]) {
      await prisma.oneTimeAccountPool.create({
        data: { account_number: acct, payment_method_code: poolMethodCode, status: 'AVAILABLE' }
      });
    }

    staffUser = await prisma.adminUser.create({
      data: {
        password: `R45I2_${runId}_Pass!`,
        name: `R45帳號池測試_${runId}`,
        permissions: ['shop', 'reservations', 'seating'],
        is_active: true
      }
    });
    const adminToken = generateToken({
      id: staffUser.id,
      role: 'admin',
      name: staffUser.name,
      permissions: ['shop', 'reservations', 'seating'],
      token_version: staffUser.token_version
    });
    const adminHeaders = {
      Authorization: `Bearer ${adminToken}`,
      'Content-Type': 'application/json'
    };

    customer = await prisma.user.create({
      data: {
        line_user_id: `r45_i2_cust_${runId}`,
        name: 'R45帳號池客人',
        phone: `09452${String(Date.now()).slice(-5)}`
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

    product = await prisma.product.create({
      data: {
        code: `R45_PROD_${runId}`,
        name: `R45測試商品_${runId}`,
        price: 1000,
        deposit_amount: 500,
        visibility_status: 'ACTIVE'
      }
    });

    // Scenario 1: Order A gets acct1, cancels pending -> released, Order B reuses acct1, stale actions on A cannot touch acct1
    const orderARef = `PO-R45A-${runId}`;
    const orderBRef = `PO-R45B-${runId}`;
    createdOrderRefs.push(orderARef, orderBRef);

    const assignedA = await prisma.$transaction((tx) =>
      assignPoolAccount(tx, { orderRef: orderARef, userId: customer.id, paymentMethodCode: poolMethodCode })
    );
    assert.ok(assignedA && createdPoolAccounts.includes(assignedA.accountNumber));
    const reusedTargetAcct = assignedA.accountNumber;

    const orderA = await prisma.productOrder.create({
      data: {
        order_ref: orderARef,
        user_id: customer.id,
        total_amount: 1000,
        deposit_required: 500,
        paid_amount: 0,
        balance_amount: 1000,
        payment_status: 'pending_payment',
        order_status: 'preorder_placed',
        payment_method_code: poolMethodCode,
        assigned_pool_account: reusedTargetAcct,
        items: {
          create: {
            product_id: product.id,
            product_code_snapshot: product.code,
            product_name_snapshot: product.name,
            price_snapshot: 1000,
            quantity: 1,
            subtotal: 1000
          }
        }
      }
    });

    // Cancel A while pending_payment -> releases reusedTargetAcct
    let res = await fetch(`${srv.baseUrl}/api/shop/admin/orders/${orderA.id}`, {
      method: 'PATCH',
      headers: adminHeaders,
      body: JSON.stringify({ order_status: 'cancelled' })
    });
    assert.equal(res.status, 200);
    let poolRow = await prisma.oneTimeAccountPool.findUnique({ where: { account_number: reusedTargetAcct } });
    assert.equal(poolRow.status, 'AVAILABLE');
    assert.equal(poolRow.assigned_order_ref, null);

    // Manually re-assign reusedTargetAcct to B
    await prisma.oneTimeAccountPool.update({
      where: { account_number: reusedTargetAcct },
      data: { status: 'ASSIGNED', assigned_order_ref: orderBRef, assigned_user_id: customer.id, assigned_at: new Date() }
    });
    await prisma.productOrder.create({
      data: {
        order_ref: orderBRef,
        user_id: customer.id,
        total_amount: 1000,
        deposit_required: 500,
        paid_amount: 0,
        balance_amount: 1000,
        payment_status: 'pending_payment',
        order_status: 'preorder_placed',
        payment_method_code: poolMethodCode,
        assigned_pool_account: reusedTargetAcct,
        items: {
          create: {
            product_id: product.id,
            product_code_snapshot: product.code,
            product_name_snapshot: product.name,
            price_snapshot: 1000,
            quantity: 1,
            subtotal: 1000
          }
        }
      }
    });

    // Trying to verify Order A must fail (409) and NOT touch reusedTargetAcct
    res = await fetch(`${srv.baseUrl}/api/shop/admin/orders/${orderA.id}/verify-payment`, {
      method: 'PATCH',
      headers: adminHeaders,
      body: JSON.stringify({ paid_amount: 500, method: 'transfer', send_line: false })
    });
    assert.equal(res.status, 409);

    // Trying to release-account on Order A also fails (409 because pool account belongs to B)
    res = await fetch(`${srv.baseUrl}/api/shop/admin/orders/${orderA.id}/release-account`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ note: '誤操作測試' })
    });
    assert.equal(res.status, 409);

    poolRow = await prisma.oneTimeAccountPool.findUnique({ where: { account_number: reusedTargetAcct } });
    assert.equal(poolRow.status, 'ASSIGNED');
    assert.equal(poolRow.assigned_order_ref, orderBRef);

    // Scenario 2: Order C reported_pending_verify -> cancelled -> keeps pool account held until manual release
    const orderCRef = `PO-R45C-${runId}`;
    createdOrderRefs.push(orderCRef);
    const holdAcct = reusedTargetAcct === acct1 ? acct2 : acct1;
    await prisma.oneTimeAccountPool.update({
      where: { account_number: holdAcct },
      data: { status: 'ASSIGNED', assigned_order_ref: orderCRef, assigned_user_id: customer.id, assigned_at: new Date() }
    });
    const orderC = await prisma.productOrder.create({
      data: {
        order_ref: orderCRef,
        user_id: customer.id,
        total_amount: 1000,
        deposit_required: 500,
        paid_amount: 0,
        balance_amount: 1000,
        payment_status: 'reported_pending_verify',
        remittance_last5: '12345',
        remittance_reported_at: new Date(),
        order_status: 'preorder_placed',
        payment_method_code: poolMethodCode,
        assigned_pool_account: holdAcct,
        items: {
          create: {
            product_id: product.id,
            product_code_snapshot: product.code,
            product_name_snapshot: product.name,
            price_snapshot: 1000,
            quantity: 1,
            subtotal: 1000
          }
        }
      }
    });

    res = await fetch(`${srv.baseUrl}/api/shop/admin/orders/${orderC.id}`, {
      method: 'PATCH',
      headers: adminHeaders,
      body: JSON.stringify({ order_status: 'cancelled' })
    });
    assert.equal(res.status, 200);
    poolRow = await prisma.oneTimeAccountPool.findUnique({ where: { account_number: holdAcct } });
    assert.equal(poolRow.status, 'ASSIGNED');
    assert.equal(poolRow.assigned_order_ref, orderCRef);

    res = await fetch(`${srv.baseUrl}/api/shop/admin/orders?search=${encodeURIComponent(orderCRef)}`, {
      headers: adminHeaders
    });
    assert.equal(res.status, 200);
    const listData = await res.json();
    const orderCRow = listData.orders.find((o) => o.order_ref === orderCRef);
    assert.equal(orderCRow?.has_held_pool_account, true);

    // Manual release requires non-empty note
    res = await fetch(`${srv.baseUrl}/api/shop/admin/orders/${orderC.id}/release-account`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ note: '   ' })
    });
    assert.equal(res.status, 422);

    // Manual release succeeds & logs last 4 digits only
    res = await fetch(`${srv.baseUrl}/api/shop/admin/orders/${orderC.id}/release-account`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ note: '已核對網銀未收到末五碼 12345' })
    });
    assert.equal(res.status, 200);
    poolRow = await prisma.oneTimeAccountPool.findUnique({ where: { account_number: holdAcct } });
    assert.equal(poolRow.status, 'AVAILABLE');
    assert.equal(poolRow.assigned_order_ref, null);

    const shopReleaseAudit = await prisma.accountingEvent.findFirst({
      where: { booking_ref: orderCRef, event_type: 'pool_account_released' }
    });
    assert.ok(shopReleaseAudit);
    assert.ok(shopReleaseAudit.summary.includes(holdAcct.slice(-4)));
    assert.ok(!shopReleaseAudit.summary.includes(holdAcct));

    // Scenario 3: Self-service prepay E (reported) stays held on cancel & manual release works; prepay F (pending) releases on cancel
    session = await prisma.session.create({
      data: { session_date: targetDate, start_time: '14:00', end_time: '16:00', max_capacity: 20 }
    });
    const refE = `R45E_${runId}`;
    const refF = `R45F_${runId}`;
    createdBookingRefs.push(refE, refF);

    await prisma.oneTimeAccountPool.update({
      where: { account_number: acct3 },
      data: { status: 'ASSIGNED', assigned_order_ref: refE, assigned_user_id: customer.id, assigned_at: new Date() }
    });
    await prisma.reservation.create({
      data: {
        booking_ref: refE,
        user_id: customer.id,
        session_id: session.id,
        pax: 1,
        status: 'confirmed',
        is_self_service: true
      }
    });
    await prisma.bookingPrepay.create({
      data: {
        booking_ref: refE,
        user_id: customer.id,
        total_amount: 500,
        amount_due: 500,
        status: 'reported_pending_verify',
        payment_method_code: poolMethodCode,
        assigned_pool_account: acct3,
        remittance_last5: '54321',
        remittance_reported_at: new Date(),
        deadline_at: new Date(Date.now() + 3600000)
      }
    });

    await prisma.oneTimeAccountPool.update({
      where: { account_number: acct4 },
      data: { status: 'ASSIGNED', assigned_order_ref: refF, assigned_user_id: customer.id, assigned_at: new Date() }
    });
    await prisma.reservation.create({
      data: {
        booking_ref: refF,
        user_id: customer.id,
        session_id: session.id,
        pax: 1,
        status: 'confirmed',
        is_self_service: true
      }
    });
    await prisma.bookingPrepay.create({
      data: {
        booking_ref: refF,
        user_id: customer.id,
        total_amount: 500,
        amount_due: 500,
        status: 'pending_payment',
        payment_method_code: poolMethodCode,
        assigned_pool_account: acct4,
        deadline_at: new Date(Date.now() + 3600000)
      }
    });

    // Admin cancel E (reported) -> keeps acct3 ASSIGNED
    res = await fetch(`${srv.baseUrl}/api/reservations/admin/${refE}/cancel`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ cancel_reason: 'R45測試取消已回報預約' })
    });
    assert.equal(res.status, 200);
    poolRow = await prisma.oneTimeAccountPool.findUnique({ where: { account_number: acct3 } });
    assert.equal(poolRow.status, 'ASSIGNED');
    assert.equal(poolRow.assigned_order_ref, refE);

    // Check admin prepays list marks has_held_pool_account = true on E
    res = await fetch(`${srv.baseUrl}/api/reservations/admin/prepays?status=cancelled`, {
      headers: adminHeaders
    });
    assert.equal(res.status, 200);
    const prepayList = await res.json();
    const prepayERow = prepayList.items.find((i) => i.booking_ref === refE);
    assert.equal(prepayERow?.has_held_pool_account, true);

    // Manual release on prepay E
    res = await fetch(`${srv.baseUrl}/api/reservations/admin/prepays/${refE}/release-account`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ note: '銀行對帳未見 54321 入帳' })
    });
    assert.equal(res.status, 200);
    poolRow = await prisma.oneTimeAccountPool.findUnique({ where: { account_number: acct3 } });
    assert.equal(poolRow.status, 'AVAILABLE');
    assert.equal(poolRow.assigned_order_ref, null);

    const prepayReleaseAudit = await prisma.accountingEvent.findFirst({
      where: { booking_ref: refE, event_type: 'pool_account_released' }
    });
    assert.ok(prepayReleaseAudit);
    assert.ok(prepayReleaseAudit.summary.includes(acct3.slice(-4)));
    assert.ok(!prepayReleaseAudit.summary.includes(acct3));

    // Customer cancel F (pending_payment) -> immediately releases acct4
    res = await fetch(`${srv.baseUrl}/api/reservations/${refF}`, {
      method: 'DELETE',
      headers: custHeaders
    });
    assert.equal(res.status, 200);
    poolRow = await prisma.oneTimeAccountPool.findUnique({ where: { account_number: acct4 } });
    assert.equal(poolRow.status, 'AVAILABLE');
    assert.equal(poolRow.assigned_order_ref, null);
  } finally {
    if (srv) await srv.close().catch(() => {});
    await prisma.oneTimeAccountPool.deleteMany({ where: { account_number: { in: createdPoolAccounts } } }).catch(() => {});
    if (createdOrderRefs.length) {
      await prisma.productOrder.deleteMany({ where: { order_ref: { in: createdOrderRefs } } }).catch(() => {});
    }
    if (createdBookingRefs.length) {
      await prisma.bookingPrepay.deleteMany({ where: { booking_ref: { in: createdBookingRefs } } }).catch(() => {});
      await prisma.reservation.deleteMany({ where: { booking_ref: { in: createdBookingRefs } } }).catch(() => {});
    }
    if (session) await prisma.session.delete({ where: { id: session.id } }).catch(() => {});
    if (product) await prisma.product.delete({ where: { id: product.id } }).catch(() => {});
    if (customer) await prisma.user.delete({ where: { id: customer.id } }).catch(() => {});
    if (staffUser) await prisma.adminUser.delete({ where: { id: staffUser.id } }).catch(() => {});
    if (createdPoolMethod) {
      await prisma.paymentMethodConfig.delete({ where: { code: poolMethodCode } }).catch(() => {});
    }
    if (createdLayoutId) await cleanupTestPublishedLayout(prisma, createdLayoutId).catch(() => {});
  }
});
