import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import cookieParser from 'cookie-parser';
import prisma from '../src/prismaClient.js';
import { generateToken } from '../src/middlewares/authMiddleware.js';
import shopRoutes from '../src/routes/shop.js';
import accountingRoutes from '../src/routes/accounting.js';
import { toTaipeiDateString } from '../../shared/time.js';

function startLocalApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/shop', shopRoutes);
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

test('Round 45 Item 3 & Option C: shop cancel refund, no_payment_found, PATCH locks, pickup bonus pass gate, remittance last5 format & cancelled guard', async () => {
  const runId = `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const todayStr = toTaipeiDateString(new Date());
  const poolAcct = `99900099${String(Date.now()).slice(-5)}`;

  let srv = null;
  let staffUser = null;
  let customer = null;
  let passPlan = null;
  let bundleProduct = null;
  const createdOrderRefs = [];

  try {
    srv = await startLocalApp();

    staffUser = await prisma.adminUser.create({
      data: {
        password: `R45I3_${runId}_Pass!`,
        name: `R45商城取消測試_${runId}`,
        permissions: ['shop', 'accounting', 'reservations'],
        is_active: true
      }
    });
    const adminToken = generateToken({
      id: staffUser.id,
      role: 'admin',
      name: staffUser.name,
      permissions: ['shop', 'accounting', 'reservations'],
      token_version: staffUser.token_version
    });
    const adminHeaders = {
      Authorization: `Bearer ${adminToken}`,
      'Content-Type': 'application/json'
    };

    customer = await prisma.user.create({
      data: {
        line_user_id: `r45_i3_cust_${runId}`,
        name: 'R45商城顧客',
        phone: `09453${String(Date.now()).slice(-5)}`
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

    passPlan = await prisma.passPlan.create({
      data: {
        code: `r45_gift_${runId}`,
        name: 'R45測試免費券',
        pass_type: 'PUNCH_CARD',
        total_quota: 5,
        price: 0,
        day_restriction: 'ANY'
      }
    });

    bundleProduct = await prisma.product.create({
      data: {
        code: `R45_GIFT_${runId}`,
        name: `R45贈品套組_${runId}`,
        price: 2000,
        deposit_amount: 600,
        bonus_pass_plan_code: passPlan.code,
        visibility_status: 'ACTIVE'
      }
    });

    const createOrderFixture = async (suffix, extra = {}) => {
      const ref = `PO-R45-${suffix}-${runId}`;
      createdOrderRefs.push(ref);
      return prisma.productOrder.create({
        data: {
          order_ref: ref,
          user_id: customer.id,
          total_amount: 2000,
          deposit_required: 600,
          paid_amount: 0,
          balance_amount: 2000,
          payment_status: 'pending_payment',
          order_status: 'preorder_placed',
          payment_method_code: 'bank_transfer',
          items: {
            create: {
              product_id: bundleProduct.id,
              product_code_snapshot: bundleProduct.code,
              product_name_snapshot: bundleProduct.name,
              price_snapshot: 2000,
              quantity: 1,
              subtotal: 2000
            }
          },
          ...extra
        }
      });
    };

    // Baseline accounting summary before shop transactions
    let sumRes = await fetch(`${srv.baseUrl}/api/accounting/summary?start_date=${todayStr}&end_date=${todayStr}`, {
      headers: adminHeaders
    });
    assert.equal(sumRes.status, 200);
    const baseSummary = await sumRes.json();

    const baseShopRes = await fetch(`${srv.baseUrl}/api/accounting/shop-summary?date_from=${todayStr}&date_to=${todayStr}`, {
      headers: adminHeaders
    });
    assert.equal(baseShopRes.status, 200);
    const baseShopStats = await baseShopRes.json();

    // 1. Order 1: Paid 600 -> full refund 600 cash on cancel -> Payment refund linked via related_payment_id, shop summary reflects net 0, booking revenue unchanged
    const ord1 = await createOrderFixture('ORD1');
    let res = await fetch(`${srv.baseUrl}/api/shop/admin/orders/${ord1.id}/verify-payment`, {
      method: 'PATCH',
      headers: adminHeaders,
      body: JSON.stringify({ amount: 600, method: 'cash', send_line_notification: false })
    });
    assert.equal(res.status, 200);
    const verify1Body = await res.json();
    const depPaymentId = verify1Body.payment.id;

    // Booking summary net_revenue must be untouched; shop summary +600
    sumRes = await fetch(`${srv.baseUrl}/api/accounting/summary?start_date=${todayStr}&end_date=${todayStr}`, {
      headers: adminHeaders
    });
    const afterPaySummary = await sumRes.json();
    assert.equal(afterPaySummary.net_revenue, baseSummary.net_revenue);

    const afterPayShopRes = await fetch(`${srv.baseUrl}/api/accounting/shop-summary?date_from=${todayStr}&date_to=${todayStr}`, {
      headers: adminHeaders
    });
    const afterPayShopStats = await afterPayShopRes.json();
    assert.equal(afterPayShopStats.net - baseShopStats.net, 600);

    // Cancel with refund 600 cash
    res = await fetch(`${srv.baseUrl}/api/shop/admin/orders/${ord1.id}/cancel`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ refund_amount: 600, refund_method: 'cash', reason: '客人取消全退' })
    });
    assert.equal(res.status, 200);
    const cancel1Body = await res.json();
    assert.equal(cancel1Body.order.order_status, 'cancelled');
    assert.equal(cancel1Body.order.payment_status, 'refunded');
    assert.equal(cancel1Body.order.paid_amount, 0);

    const ord1Refunds = await prisma.payment.findMany({
      where: { source: 'shop', source_ref: ord1.order_ref, kind: 'refund', status: 'valid' }
    });
    assert.equal(ord1Refunds.length, 1);
    assert.equal(ord1Refunds[0].amount, 600);
    assert.equal(ord1Refunds[0].related_payment_id, depPaymentId);

    const shopRefundEvent = await prisma.accountingEvent.findFirst({
      where: { booking_ref: ord1.order_ref, event_type: 'shop_refund', category: 'refund' }
    });
    assert.ok(shopRefundEvent);
    assert.equal(shopRefundEvent.amount, -600);

    // Verify Shop stats endpoint net drops back to baseline and booking revenue unchanged
    const shopStatsRes = await fetch(`${srv.baseUrl}/api/accounting/shop-summary?date_from=${todayStr}&date_to=${todayStr}`, {
      headers: adminHeaders
    });
    assert.equal(shopStatsRes.status, 200);
    const shopStatsBody = await shopStatsRes.json();
    assert.equal(shopStatsBody.refunds - baseShopStats.refunds, 600);
    assert.equal(shopStatsBody.net, baseShopStats.net);

    sumRes = await fetch(`${srv.baseUrl}/api/accounting/summary?start_date=${todayStr}&end_date=${todayStr}`, {
      headers: adminHeaders
    });
    const afterRefundSummary = await sumRes.json();
    assert.equal(afterRefundSummary.net_revenue, baseSummary.net_revenue);

    // 2. Order 2: Two payments (300 deposit + 300 collect) -> refund 450 splits LIFO (300 on bal, 150 on dep)
    const ord2 = await createOrderFixture('ORD2');
    res = await fetch(`${srv.baseUrl}/api/shop/admin/orders/${ord2.id}/verify-payment`, {
      method: 'PATCH',
      headers: adminHeaders,
      body: JSON.stringify({ amount: 300, method: 'cash', send_line_notification: false })
    });
    assert.equal(res.status, 200);
    const payDep2Id = (await res.json()).payment.id;

    res = await fetch(`${srv.baseUrl}/api/shop/admin/orders/${ord2.id}/collect`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ amount: 300, method: 'cash' })
    });
    assert.equal(res.status, 200);
    const payBal2Id = (await res.json()).payment.id;

    res = await fetch(`${srv.baseUrl}/api/shop/admin/orders/${ord2.id}/cancel`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ refund_amount: 450, refund_method: 'cash', reason: '扣150手續費' })
    });
    assert.equal(res.status, 200);
    const cancel2Body = await res.json();
    assert.equal(cancel2Body.order.order_status, 'cancelled');
    assert.equal(cancel2Body.order.paid_amount, 150);
    assert.equal(cancel2Body.order.payment_status, 'deposit_verified');

    const ord2Refunds = await prisma.payment.findMany({
      where: { source: 'shop', source_ref: ord2.order_ref, kind: 'refund', status: 'valid' },
      orderBy: { id: 'asc' }
    });
    assert.equal(ord2Refunds.length, 2);
    const refBal = ord2Refunds.find((p) => p.related_payment_id === payBal2Id);
    const refDep = ord2Refunds.find((p) => p.related_payment_id === payDep2Id);
    assert.equal(refBal?.amount, 300);
    assert.equal(refDep?.amount, 150);

    // 3. Order 3: Paid 600 -> refund_amount: 0 without reason -> 422; with reason -> 200 & 0 refunds; > paid -> 422; pass -> 422
    const ord3 = await createOrderFixture('ORD3');
    res = await fetch(`${srv.baseUrl}/api/shop/admin/orders/${ord3.id}/verify-payment`, {
      method: 'PATCH',
      headers: adminHeaders,
      body: JSON.stringify({ amount: 600, method: 'cash', send_line_notification: false })
    });
    assert.equal(res.status, 200);

    res = await fetch(`${srv.baseUrl}/api/shop/admin/orders/${ord3.id}/cancel`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ refund_amount: 700, refund_method: 'cash', reason: '超退' })
    });
    assert.equal(res.status, 422);

    res = await fetch(`${srv.baseUrl}/api/shop/admin/orders/${ord3.id}/cancel`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ refund_amount: 100, refund_method: 'pass', reason: '退卡券' })
    });
    assert.equal(res.status, 422);

    res = await fetch(`${srv.baseUrl}/api/shop/admin/orders/${ord3.id}/cancel`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ refund_amount: 0, reason: '   ' })
    });
    assert.equal(res.status, 422);

    res = await fetch(`${srv.baseUrl}/api/shop/admin/orders/${ord3.id}/cancel`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ refund_amount: 0, reason: '訂金不退' })
    });
    assert.equal(res.status, 200);
    const cancel3Body = await res.json();
    assert.equal(cancel3Body.order.payment_status, 'deposit_verified');
    const ord3RefundCount = await prisma.payment.count({
      where: { source: 'shop', source_ref: ord3.order_ref, kind: 'refund' }
    });
    assert.equal(ord3RefundCount, 0);

    // 4. Reported pending verify order + Option C no_payment_found:
    //   - amount: 0 without flag -> 422
    //   - reported_pending_verify cancel -> 409
    //   - PATCH order_status: 'cancelled' -> 409; PATCH payment_status: 'refunded' -> 409
    //   - no_payment_found without note -> 422; with note -> verified_unpaid, pool stays ASSIGNED
    //   - cancel after verified_unpaid -> 200, pool STILL ASSIGNED
    await prisma.oneTimeAccountPool.create({
      data: {
        account_number: poolAcct,
        status: 'ASSIGNED',
        assigned_order_ref: `PO-R45-ORD4-${runId}`,
        assigned_user_id: customer.id,
        assigned_at: new Date()
      }
    });
    const ord4 = await createOrderFixture('ORD4', {
      payment_method_code: 'ctbc_pool',
      assigned_pool_account: poolAcct,
      payment_status: 'reported_pending_verify',
      remittance_last5: '98765',
      remittance_reported_at: new Date()
    });

    res = await fetch(`${srv.baseUrl}/api/shop/admin/orders/${ord4.id}/verify-payment`, {
      method: 'PATCH',
      headers: adminHeaders,
      body: JSON.stringify({ amount: 0, method: 'transfer', send_line_notification: false })
    });
    assert.equal(res.status, 422);

    res = await fetch(`${srv.baseUrl}/api/shop/admin/orders/${ord4.id}/cancel`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ reason: '未對帳想取消' })
    });
    assert.equal(res.status, 409);

    res = await fetch(`${srv.baseUrl}/api/shop/admin/orders/${ord4.id}`, {
      method: 'PATCH',
      headers: adminHeaders,
      body: JSON.stringify({ order_status: 'cancelled' })
    });
    assert.equal(res.status, 409);

    res = await fetch(`${srv.baseUrl}/api/shop/admin/orders/${ord4.id}`, {
      method: 'PATCH',
      headers: adminHeaders,
      body: JSON.stringify({ payment_status: 'refunded', reason: '想偷改狀態' })
    });
    assert.equal(res.status, 409);

    res = await fetch(`${srv.baseUrl}/api/shop/admin/orders/${ord4.id}/verify-payment`, {
      method: 'PATCH',
      headers: adminHeaders,
      body: JSON.stringify({ no_payment_found: true, note: '' })
    });
    assert.equal(res.status, 422);

    res = await fetch(`${srv.baseUrl}/api/shop/admin/orders/${ord4.id}/verify-payment`, {
      method: 'PATCH',
      headers: adminHeaders,
      body: JSON.stringify({ no_payment_found: true, note: '銀行核對無98765入帳' })
    });
    assert.equal(res.status, 200);
    const vUnpaidBody = await res.json();
    assert.equal(vUnpaidBody.order.payment_status, 'verified_unpaid');
    let poolRow = await prisma.oneTimeAccountPool.findUnique({ where: { account_number: poolAcct } });
    assert.equal(poolRow.status, 'ASSIGNED');

    res = await fetch(`${srv.baseUrl}/api/shop/admin/orders/${ord4.id}/cancel`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ reason: '查無入帳取消' })
    });
    assert.equal(res.status, 200);
    poolRow = await prisma.oneTimeAccountPool.findUnique({ where: { account_number: poolAcct } });
    assert.equal(poolRow.status, 'ASSIGNED');
    assert.equal(poolRow.assigned_order_ref, ord4.order_ref);

    // Customer cannot update last5 on cancelled order (409)
    res = await fetch(`${srv.baseUrl}/api/shop/orders/${ord4.id}/remittance`, {
      method: 'PATCH',
      headers: custHeaders,
      body: JSON.stringify({ remittance_last5: '11111' })
    });
    assert.equal(res.status, 409);

    // 5. Pickup bonus pass requires fully_paid, writes pass_granted with order_ref reason
    const ord5 = await createOrderFixture('ORD5');
    await fetch(`${srv.baseUrl}/api/shop/admin/orders/${ord5.id}/verify-payment`, {
      method: 'PATCH',
      headers: adminHeaders,
      body: JSON.stringify({ amount: 600, method: 'cash', send_line_notification: false })
    });

    // Only deposit paid -> pickup rejected (409)
    res = await fetch(`${srv.baseUrl}/api/shop/admin/orders/${ord5.id}`, {
      method: 'PATCH',
      headers: adminHeaders,
      body: JSON.stringify({ order_status: 'picked_up' })
    });
    assert.equal(res.status, 409);

    // Collect balance to fully_paid -> pickup grants 1 pass + pass_granted audit
    res = await fetch(`${srv.baseUrl}/api/shop/admin/orders/${ord5.id}/collect`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ amount: 1400, method: 'cash' })
    });
    assert.equal(res.status, 200);

    res = await fetch(`${srv.baseUrl}/api/shop/admin/orders/${ord5.id}`, {
      method: 'PATCH',
      headers: adminHeaders,
      body: JSON.stringify({ order_status: 'picked_up' })
    });
    assert.equal(res.status, 200);
    const grantedPass = await prisma.userPass.findFirst({
      where: { order_ref: ord5.order_ref, plan_id: passPlan.id }
    });
    assert.ok(grantedPass);
    const passAudit = await prisma.accountingEvent.findFirst({
      where: { booking_ref: ord5.order_ref, event_type: 'pass_granted' }
    });
    assert.ok(passAudit);
    assert.ok(passAudit.reason.includes(ord5.order_ref));

    // 6. Customer remittance last5 format check ('1234' -> 400, '12345' -> 200)
    const ord6 = await createOrderFixture('ORD6');
    res = await fetch(`${srv.baseUrl}/api/shop/orders/${ord6.id}/remittance`, {
      method: 'PATCH',
      headers: custHeaders,
      body: JSON.stringify({ remittance_last5: '1234' })
    });
    assert.equal(res.status, 400);

    res = await fetch(`${srv.baseUrl}/api/shop/orders/${ord6.id}/remittance`, {
      method: 'PATCH',
      headers: custHeaders,
      body: JSON.stringify({ remittance_last5: '12345' })
    });
    assert.equal(res.status, 200);
  } finally {
    if (srv) await srv.close().catch(() => {});
    await prisma.oneTimeAccountPool.deleteMany({ where: { account_number: poolAcct } }).catch(() => {});
    if (createdOrderRefs.length) {
      await prisma.userPass.deleteMany({ where: { order_ref: { in: createdOrderRefs } } }).catch(() => {});
      await prisma.payment.deleteMany({ where: { source_ref: { in: createdOrderRefs } } }).catch(() => {});
      await prisma.productOrder.deleteMany({ where: { order_ref: { in: createdOrderRefs } } }).catch(() => {});
    }
    if (bundleProduct) await prisma.product.delete({ where: { id: bundleProduct.id } }).catch(() => {});
    if (passPlan) await prisma.passPlan.delete({ where: { id: passPlan.id } }).catch(() => {});
    if (customer) await prisma.user.delete({ where: { id: customer.id } }).catch(() => {});
    if (staffUser) await prisma.adminUser.delete({ where: { id: staffUser.id } }).catch(() => {});
  }
});
