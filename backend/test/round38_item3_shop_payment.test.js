import test from 'node:test';
import assert from 'node:assert/strict';
import prisma from '../src/prismaClient.js';
import {
  verifyOrderPayment,
  collectOrderBalance,
  updateAdminOrder
} from '../src/controllers/shopController.js';
import {
  getAccountingSummary,
  getClosingPreview
} from '../src/controllers/accountingController.js';
import { voidPayment, nextSerialNo } from '../src/services/billing/billService.js';
import { buildClosingSlip } from '../../shared/receipts.js';
import { toTaipeiDateString } from '../../shared/time.js';

function createMockReqRes({ body = {}, params = {}, query = {}, user = { id: 1, name: 'R38店員' } } = {}) {
  const req = {
    body,
    params,
    query,
    user,
    headers: { 'x-device-label': 'R38商城櫃檯' },
    ip: '127.0.0.1'
  };
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

test('Round 38 Item 3: shop deposit & balance payments, revenue exclusion, closing cash inclusion, legacy orders, and void', async () => {
  const ts = Date.now();
  const createdOrderIds = [];
  const createdPaymentRefs = [];
  let user = null;

  try {
    user = await prisma.user.create({
      data: {
        line_user_id: `manual_r38_3_${ts}`,
        name: 'R38商城顧客',
        phone: `0987${String(ts).slice(-6)}`
      }
    });

    const todayStr = toTaipeiDateString(new Date());

    // Baseline accounting summary and closing preview
    const baseSumRes = createMockReqRes({ query: { start_date: todayStr, end_date: todayStr } });
    await getAccountingSummary(baseSumRes.req, baseSumRes.res);
    const baseNetRev = baseSumRes.res.getBody().net_revenue;
    const baseCashMethodAmt = baseSumRes.res.getBody().by_method?.cash?.amount || 0;

    const baseCloseRes = createMockReqRes({ query: { date: todayStr } });
    await getClosingPreview(baseCloseRes.req, baseCloseRes.res);
    const baseClosingBody = baseCloseRes.res.getBody();
    const baseExpectedCash = baseClosingBody.expected_cash;
    const baseCloseCashAmt = baseClosingBody.by_method?.cash?.amount || 0;

    // Create Order 1: total=1000, deposit=300
    const order1Ref = `PO-R38-1-${ts}`;
    createdPaymentRefs.push(order1Ref);
    const order1 = await prisma.productOrder.create({
      data: {
        order_ref: order1Ref,
        user_id: user.id,
        total_amount: 1000,
        deposit_required: 300,
        paid_amount: 0,
        balance_amount: 1000,
        payment_method_code: 'transfer',
        payment_status: 'reported_pending_verify',
        order_status: 'preorder_placed'
      }
    });
    createdOrderIds.push(order1.id);

    // 1. Verify deposit 300 transfer
    const { req: vReq, res: vRes } = createMockReqRes({
      params: { id: String(order1.id) },
      body: { amount: 300, method: 'transfer', client_batch_id: `r38-shop-v1-${ts}`, send_line_notification: false }
    });
    await verifyOrderPayment(vReq, vRes);
    assert.equal(vRes.getStatusCode(), 200);
    assert.equal(vRes.getBody().order.paid_amount, 300);
    assert.equal(vRes.getBody().order.balance_amount, 700);
    assert.equal(vRes.getBody().order.payment_status, 'deposit_verified');
    assert.equal(vRes.getBody().payment.source, 'shop');

    const shopEv1 = await prisma.accountingEvent.findFirst({
      where: { booking_ref: order1Ref, event_type: 'shop_payment' }
    });
    assert.ok(shopEv1);

    // 1b. Duplicate client_batch_id -> idempotent (still 1 Payment)
    const { req: vDupReq, res: vDupRes } = createMockReqRes({
      params: { id: String(order1.id) },
      body: { amount: 300, method: 'transfer', client_batch_id: `r38-shop-v1-${ts}`, send_line_notification: false }
    });
    await verifyOrderPayment(vDupReq, vDupRes);
    assert.equal(vDupRes.getStatusCode(), 200);
    assert.equal(vDupRes.getBody().idempotent, true);
    const payCountAfterDup = await prisma.payment.count({ where: { booking_ref: order1Ref, status: 'valid' } });
    assert.equal(payCountAfterDup, 1);

    // 2. Trying picked_up while balance=700 -> 409
    const { req: puBlockReq, res: puBlockRes } = createMockReqRes({
      params: { id: String(order1.id) },
      body: { order_status: 'picked_up' }
    });
    await updateAdminOrder(puBlockReq, puBlockRes);
    assert.equal(puBlockRes.getStatusCode(), 409);

    // 2b. updateAdminOrder with paid_amount -> 422
    const { req: paReq, res: paRes } = createMockReqRes({
      params: { id: String(order1.id) },
      body: { paid_amount: 1000 }
    });
    await updateAdminOrder(paReq, paRes);
    assert.equal(paRes.getStatusCode(), 422);

    // 3. Collect balance 700 cash (cash_received=1000 -> change=300)
    const { req: colReq, res: colRes } = createMockReqRes({
      params: { id: String(order1.id) },
      body: { amount: 700, method: 'cash', cash_received: 1000, client_batch_id: `r38-shop-c1-${ts}` }
    });
    await collectOrderBalance(colReq, colRes);
    assert.equal(colRes.getStatusCode(), 200);
    const cashPay1 = colRes.getBody().payment;
    assert.equal(cashPay1.change_given, 300);
    assert.equal(colRes.getBody().order.paid_amount, 1000);
    assert.equal(colRes.getBody().order.balance_amount, 0);
    assert.equal(colRes.getBody().order.payment_status, 'fully_paid');

    // 4. Accounting summary: store net_revenue & by_method unchanged; shop.amount = 1000
    const sumAfterRes = createMockReqRes({ query: { start_date: todayStr, end_date: todayStr } });
    await getAccountingSummary(sumAfterRes.req, sumAfterRes.res);
    const sumAfter = sumAfterRes.res.getBody();
    assert.equal(sumAfter.net_revenue, baseNetRev);
    assert.equal(sumAfter.by_method?.cash?.amount || 0, baseCashMethodAmt);
    assert.equal(sumAfter.shop.amount, 1000);
    assert.equal(sumAfter.shop.count, 2);

    // 5. Closing preview: expected_cash +700, by_method.cash & actual_received unchanged, slip contains shop lines
    const closeAfterRes = createMockReqRes({ query: { date: todayStr } });
    await getClosingPreview(closeAfterRes.req, closeAfterRes.res);
    const closeAfter = closeAfterRes.res.getBody();
    assert.equal(closeAfter.expected_cash, baseExpectedCash + 700);
    assert.equal(closeAfter.by_method?.cash?.amount || 0, baseCloseCashAmt);
    assert.equal(closeAfter.actual_received, baseClosingBody.actual_received);
    assert.equal(closeAfter.shop.cash_income, 700);
    assert.equal(closeAfter.shop.non_cash_amount, 300);

    const slipCmds = buildClosingSlip({
      business_date: todayStr,
      float_amount: closeAfter.float_amount,
      expected_cash: closeAfter.expected_cash,
      totals_json: closeAfter
    });
    const slipText = slipCmds.map(c => c.text || '').join('\n');
    assert.match(slipText, /商城現金（不計入營收）.*NT\$700/);
    assert.match(slipText, /商城轉帳等.*NT\$300/);

    // 6. Direct shop cash refund 100 -> expected_cash drops by 100, store revenue unchanged
    const refundNo = await nextSerialNo(prisma, 'payment');
    await prisma.payment.create({
      data: {
        payment_no: refundNo,
        batch_no: `batch-ref-${ts}`,
        booking_ref: order1Ref,
        source: 'shop',
        source_ref: order1Ref,
        kind: 'refund',
        status: 'valid',
        method: 'cash',
        amount: 100,
        person_nos: [],
        breakdown_json: { type: 'shop_refund', order_ref: order1Ref },
        staff_name: 'R38店員',
        device_label: 'R38商城櫃檯'
      }
    });
    const closeRefundRes = createMockReqRes({ query: { date: todayStr } });
    await getClosingPreview(closeRefundRes.req, closeRefundRes.res);
    assert.equal(closeRefundRes.res.getBody().expected_cash, baseExpectedCash + 600);
    const sumRefundRes = createMockReqRes({ query: { start_date: todayStr, end_date: todayStr } });
    await getAccountingSummary(sumRefundRes.req, sumRefundRes.res);
    assert.equal(sumRefundRes.res.getBody().net_revenue, baseNetRev);

    // Mark refund payment voided before testing order1 cash pay void & picked_up
    await prisma.payment.updateMany({ where: { payment_no: refundNo }, data: { status: 'voided' } });

    // 7. Void 700 cash payment same day -> paid_amount goes back to 300, deposit_verified
    const vResult = await voidPayment(cashPay1.id, '收錯尾款方式', { id: 1, name: 'R38店員' }, { device_label: 'R38商城櫃檯' });
    assert.equal(vResult.voided_source, 'shop');
    const afterVoidOrder = await prisma.productOrder.findUnique({ where: { id: order1.id } });
    assert.equal(afterVoidOrder.paid_amount, 300);
    assert.equal(afterVoidOrder.balance_amount, 700);
    assert.equal(afterVoidOrder.payment_status, 'deposit_verified');

    // Re-collect 700 -> then picked_up succeeds (200)
    const { req: col2Req, res: col2Res } = createMockReqRes({
      params: { id: String(order1.id) },
      body: { amount: 700, method: 'transfer', client_batch_id: `r38-shop-c2-${ts}` }
    });
    await collectOrderBalance(col2Req, col2Res);
    assert.equal(col2Res.getStatusCode(), 200);

    const { req: puOkReq, res: puOkRes } = createMockReqRes({
      params: { id: String(order1.id) },
      body: { order_status: 'picked_up' }
    });
    await updateAdminOrder(puOkReq, puOkRes);
    assert.equal(puOkRes.getStatusCode(), 200);
    assert.equal(puOkRes.getBody().order.order_status, 'picked_up');

    // 8. Legacy order with paid_amount=500 & no Payments -> collect 500 -> paid_before_payments=500, paid_amount=1000
    const legRef = `PO-R38-LEG-${ts}`;
    createdPaymentRefs.push(legRef);
    const legOrder = await prisma.productOrder.create({
      data: {
        order_ref: legRef,
        user_id: user.id,
        total_amount: 1000,
        deposit_required: 500,
        paid_amount: 500,
        balance_amount: 500,
        payment_method_code: 'transfer',
        payment_status: 'deposit_verified',
        order_status: 'arrived'
      }
    });
    createdOrderIds.push(legOrder.id);

    const { req: legReq, res: legRes } = createMockReqRes({
      params: { id: String(legOrder.id) },
      body: { amount: 500, method: 'cash', client_batch_id: `r38-leg-${ts}` }
    });
    await collectOrderBalance(legReq, legRes);
    assert.equal(legRes.getStatusCode(), 200);
    assert.equal(legRes.getBody().order.paid_before_payments, 500);
    assert.equal(legRes.getBody().order.paid_amount, 1000);
    assert.equal(legRes.getBody().order.balance_amount, 0);

    // 9. Cancelled order verify -> 409; over-balance -> 422
    const cancelRef = `PO-R38-CAN-${ts}`;
    createdPaymentRefs.push(cancelRef);
    const cancelOrder = await prisma.productOrder.create({
      data: {
        order_ref: cancelRef,
        user_id: user.id,
        total_amount: 600,
        deposit_required: 300,
        paid_amount: 0,
        balance_amount: 600,
        payment_method_code: 'transfer',
        payment_status: 'pending_payment',
        order_status: 'cancelled'
      }
    });
    createdOrderIds.push(cancelOrder.id);

    const { req: canReq, res: canRes } = createMockReqRes({
      params: { id: String(cancelOrder.id) },
      body: { amount: 300, method: 'transfer', send_line_notification: false }
    });
    await verifyOrderPayment(canReq, canRes);
    assert.equal(canRes.getStatusCode(), 409);

    const openRef = `PO-R38-OVR-${ts}`;
    createdPaymentRefs.push(openRef);
    const openOrder = await prisma.productOrder.create({
      data: {
        order_ref: openRef,
        user_id: user.id,
        total_amount: 500,
        deposit_required: 200,
        paid_amount: 0,
        balance_amount: 500,
        payment_method_code: 'transfer',
        payment_status: 'pending_payment',
        order_status: 'preorder_placed'
      }
    });
    createdOrderIds.push(openOrder.id);

    const { req: ovrReq, res: ovrRes } = createMockReqRes({
      params: { id: String(openOrder.id) },
      body: { amount: 501, method: 'transfer', send_line_notification: false }
    });
    await verifyOrderPayment(ovrReq, ovrRes);
    assert.equal(ovrRes.getStatusCode(), 422);
  } finally {
    if (createdPaymentRefs.length) {
      await prisma.payment.deleteMany({ where: { booking_ref: { in: createdPaymentRefs } } });
    }
    if (createdOrderIds.length) {
      await prisma.productOrder.deleteMany({ where: { id: { in: createdOrderIds } } });
    }
    if (user) {
      await prisma.user.deleteMany({ where: { id: user.id } });
    }
  }
});
