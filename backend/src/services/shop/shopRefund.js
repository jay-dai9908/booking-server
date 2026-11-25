import crypto from 'crypto';
import { assertEnabledPaymentMethod, nextSerialNo, resolveBillingDate } from '../billing/billService.js';
import { log as auditLog } from '../audit/auditService.js';
import { recalcOrderPaid } from './shopPayment.js';

/**
 * Execute a shop order refund inside an existing Prisma transaction:
 * - Validates enabled refund method (non-pass)
 * - Links refund Payment rows via related_payment_id (LIFO across remaining refundable charges)
 * - Writes AccountingEvent (category: 'refund', event_type: 'shop_refund')
 * - Recalculates order paid_amount / balance_amount via recalcOrderPaid
 */
export async function refundShopOrder(
  tx,
  {
    order,
    amount,
    method = 'cash',
    reason,
    staffName = '門市人員',
    staffId = null,
    deviceInfo = null,
    reqBody = {}
  }
) {
  const refundAmt = Number(amount);
  if (!Number.isInteger(refundAmt) || refundAmt <= 0) {
    throw { status: 422, message: '退款金額必須為大於 0 的整數' };
  }

  const paidAmt = order.paid_amount || 0;
  if (refundAmt > paidAmt) {
    throw { status: 422, message: `退款金額不可大於已付金額 NT$${paidAmt}` };
  }

  const normalizedMethod = String(method || '').trim().toLowerCase();
  if (!normalizedMethod) {
    throw { status: 422, message: '請選擇退款方式' };
  }
  if (normalizedMethod === 'pass') {
    throw { status: 422, message: '商城退款不支援退為卡券' };
  }

  const matchedMethod = await assertEnabledPaymentMethod(tx, normalizedMethod);
  const canonicalMethod = matchedMethod.key;
  const reasonText = String(reason || '').trim() || '商城取消訂單全額退款';

  const priorPayments = await tx.payment.findMany({
    where: {
      source: 'shop',
      status: 'valid',
      OR: [
        { source_ref: order.order_ref },
        { booking_ref: order.order_ref }
      ]
    },
    orderBy: [{ created_at: 'desc' }, { id: 'desc' }]
  });

  // Track already-refunded amounts per original Payment ID
  const refundedByOrigId = new Map();
  for (const p of priorPayments) {
    if (p.kind === 'refund' && p.related_payment_id) {
      refundedByOrigId.set(
        p.related_payment_id,
        (refundedByOrigId.get(p.related_payment_id) || 0) + (p.amount || 0)
      );
    }
  }

  const charges = priorPayments.filter(
    (p) => (p.kind === 'charge' || p.kind === 'supplement') && p.method !== 'pass'
  );

  // Allocate refund LIFO across original charges that still have remaining balance
  const allocations = [];
  let left = refundAmt;
  for (const charge of charges) {
    if (left <= 0) break;
    const alreadyRefunded = refundedByOrigId.get(charge.id) || 0;
    const remaining = Math.max(0, (charge.amount || 0) - alreadyRefunded);
    if (remaining <= 0) continue;
    const take = Math.min(remaining, left);
    allocations.push({ relatedPaymentId: charge.id, amount: take });
    left -= take;
  }

  // Fallback for legacy orders where paid_before_payments > 0 without Payment rows
  if (left > 0) {
    const paidBefore = order.paid_before_payments || 0;
    const legacyAlreadyRefunded = priorPayments
      .filter((p) => p.kind === 'refund' && !p.related_payment_id)
      .reduce((s, p) => s + (p.amount || 0), 0);
    const legacyRemaining = Math.max(0, paidBefore - legacyAlreadyRefunded);
    if (left <= legacyRemaining) {
      allocations.push({ relatedPaymentId: null, amount: left });
      left = 0;
    } else {
      throw { status: 409, message: '可退金額計算不足，無法重複退款' };
    }
  }

  const payDate = resolveBillingDate(reqBody);
  const batchNo = crypto.randomUUID();
  const createdPayments = [];

  for (const alloc of allocations) {
    const payNo = await nextSerialNo(tx, 'payment', payDate);
    const created = await tx.payment.create({
      data: {
        payment_no: payNo,
        batch_no: batchNo,
        booking_ref: order.order_ref,
        source: 'shop',
        source_ref: order.order_ref,
        kind: 'refund',
        status: 'valid',
        method: canonicalMethod,
        amount: alloc.amount,
        related_payment_id: alloc.relatedPaymentId,
        person_nos: [],
        breakdown_json: {
          type: 'shop_refund',
          order_id: order.id,
          order_ref: order.order_ref,
          refund_amount: alloc.amount,
          total_refund_amount: refundAmt,
          reason: reasonText
        },
        reason: reasonText,
        staff_name: staffName,
        staff_id: staffId,
        device_id: deviceInfo?.device_id || null,
        device_label: deviceInfo?.device_label || '櫃檯'
      }
    });
    createdPayments.push(created);
  }

  await auditLog(tx, {
    booking_ref: order.order_ref,
    event_type: 'shop_refund',
    category: 'refund',
    summary: `商城退款 ${order.order_ref} · ${canonicalMethod} NT$${refundAmt}（原因：${reasonText}）`,
    amount: -refundAmt,
    payment_id: createdPayments[0]?.id || null,
    reason: reasonText,
    after_json: {
      order_id: order.id,
      order_ref: order.order_ref,
      refund_amount: refundAmt,
      method: canonicalMethod,
      payment_ids: createdPayments.map((p) => p.id),
      related_payment_ids: createdPayments.map((p) => p.related_payment_id)
    },
    staff_name: staffName,
    staff_id: staffId,
    device_id: deviceInfo?.device_id || null,
    device_label: deviceInfo?.device_label || '櫃檯'
  });

  const recalculatedOrder = await recalcOrderPaid(tx, order.id);
  return { order: recalculatedOrder, payments: createdPayments };
}
