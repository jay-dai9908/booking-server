import crypto from 'crypto';
import prisma from '../../prismaClient.js';
import { assertEnabledPaymentMethod, nextSerialNo, resolveBillingDate } from '../billing/billService.js';
import { markPoolAccountUsed } from '../selfService/poolAccountService.js';
import { log as auditLog } from '../audit/auditService.js';

/**
 * Recompute ProductOrder paid_amount, balance_amount, and payment_status
 * strictly from paid_before_payments + valid shop charges - valid shop refunds.
 */
export async function recalcOrderPaid(txOrPrisma, orderId) {
  const client = txOrPrisma || prisma;
  const order = await client.productOrder.findUnique({ where: { id: Number(orderId) } });
  if (!order) throw { status: 404, message: '找不到該筆訂單' };

  const validShopPayments = await client.payment.findMany({
    where: {
      source: 'shop',
      status: 'valid',
      OR: [
        { source_ref: order.order_ref },
        { booking_ref: order.order_ref }
      ]
    }
  });

  const chargesSum = validShopPayments
    .filter(p => p.kind === 'charge' || p.kind === 'supplement')
    .reduce((sum, p) => sum + (p.amount || 0), 0);
  const refundsSum = validShopPayments
    .filter(p => p.kind === 'refund')
    .reduce((sum, p) => sum + (p.amount || 0), 0);

  const paidBefore = order.paid_before_payments ?? 0;
  const paidAmount = Math.max(0, paidBefore + chargesSum - refundsSum);
  const balanceAmount = Math.max(0, order.total_amount - paidAmount);

  let nextPaymentStatus = order.payment_status;
  if (order.payment_status !== 'refunded') {
    if (balanceAmount === 0 && paidAmount >= order.total_amount) {
      nextPaymentStatus = 'fully_paid';
    } else if (paidAmount > 0) {
      nextPaymentStatus = 'deposit_verified';
    } else if (order.payment_status !== 'verified_unpaid') {
      nextPaymentStatus = order.remittance_reported_at ? 'reported_pending_verify' : 'pending_payment';
    }
  }

  return client.productOrder.update({
    where: { id: order.id },
    data: {
      paid_amount: paidAmount,
      balance_amount: balanceAmount,
      payment_status: nextPaymentStatus
    },
    include: {
      items: true,
      user: true
    }
  });
}

/**
 * Execute an additive payment against a ProductOrder inside an advisory/row-locked transaction.
 * Supports verifyOrderPayment (deposit/full remittance) and collectOrderBalance (onsite balance collection).
 */
export async function applyShopOrderPayment({
  orderId,
  amountInput,
  isFullPayment = false,
  method = 'transfer',
  cashReceived,
  clientBatchId,
  staffUser,
  deviceInfo,
  markPoolUsed = true,
  note = null,
  reqBody = {},
  defaultToDeposit = false
}) {
  const staffName = staffUser?.name || '門市人員';
  const staffId = staffUser?.id || null;

  return prisma.$transaction(async (tx) => {
    const locked = await tx.$queryRaw`
      SELECT * FROM "ProductOrder" WHERE id = ${Number(orderId)} FOR UPDATE
    `;
    if (!locked.length) {
      throw { status: 404, message: '找不到該筆訂單' };
    }
    const order = locked[0];

    if (order.order_status === 'cancelled' || order.order_status === 'picked_up') {
      throw { status: 409, message: '此訂單已取消或已完成取貨，不可再收款' };
    }
    if (order.payment_status === 'fully_paid' || order.payment_status === 'refunded') {
      throw { status: 409, message: '此訂單已結清或已退款，不可重複收款' };
    }

    if (clientBatchId) {
      const existingPay = await tx.payment.findFirst({
        where: {
          client_batch_id: String(clientBatchId),
          source: 'shop',
          status: 'valid',
          OR: [{ source_ref: order.order_ref }, { booking_ref: order.order_ref }]
        }
      });
      if (existingPay) {
        const currentOrder = await tx.productOrder.findUnique({
          where: { id: order.id },
          include: { items: true, user: true }
        });
        return { order: currentOrder, payment: existingPay, idempotent: true };
      }
    }

    // Freeze legacy paid_amount into paid_before_payments the first time a Payment is recorded
    if (order.paid_before_payments === null || order.paid_before_payments === undefined) {
      await tx.productOrder.update({
        where: { id: order.id },
        data: { paid_before_payments: order.paid_amount ?? 0 }
      });
    }

    // Recompute current balance accurately inside lock before validating amount
    const existingPays = await tx.payment.findMany({
      where: {
        source: 'shop',
        status: 'valid',
        OR: [{ source_ref: order.order_ref }, { booking_ref: order.order_ref }]
      }
    });
    const basePaid = (order.paid_before_payments ?? order.paid_amount ?? 0);
    const curCharges = existingPays.filter(p => p.kind === 'charge' || p.kind === 'supplement').reduce((s, p) => s + (p.amount || 0), 0);
    const curRefunds = existingPays.filter(p => p.kind === 'refund').reduce((s, p) => s + (p.amount || 0), 0);
    const currentPaid = Math.max(0, basePaid + curCharges - curRefunds);
    const currentBalance = Math.max(0, order.total_amount - currentPaid);

    if (currentBalance <= 0) {
      throw { status: 409, message: '此訂單已無尚欠金額' };
    }

    let payAmount;
    if (isFullPayment) {
      payAmount = currentBalance;
    } else if (amountInput !== undefined && amountInput !== null && amountInput !== '') {
      payAmount = Number(amountInput);
    } else if (defaultToDeposit) {
      payAmount = Math.min(currentBalance, order.deposit_required || currentBalance);
    } else {
      payAmount = currentBalance;
    }

    if (!Number.isInteger(payAmount) || payAmount <= 0) {
      throw { status: 422, message: '收款金額必須為正整數' };
    }
    if (payAmount > currentBalance) {
      throw { status: 422, message: `收款金額（NT$${payAmount}）不可超過尚欠金額（NT$${currentBalance}）` };
    }

    const normalizedMethod = String(method || '').trim().toLowerCase();
    if (!normalizedMethod) {
      throw { status: 422, message: '請選擇付款方式' };
    }
    if (normalizedMethod === 'pass') {
      throw { status: 422, message: '商城收款不支援使用卡券' };
    }
    const matchedMethod = await assertEnabledPaymentMethod(tx, normalizedMethod);
    const canonicalMethod = matchedMethod.key;

    let providedCash = null;
    let changeGiven = null;
    if (canonicalMethod === 'cash') {
      providedCash = (cashReceived !== undefined && cashReceived !== null && cashReceived !== '')
        ? Number(cashReceived)
        : payAmount;
      if (!Number.isFinite(providedCash) || providedCash < payAmount) {
        throw { status: 400, message: `實收現金（NT$${Number.isFinite(providedCash) ? providedCash : 0}）不足（應收 NT$${payAmount}）` };
      }
      changeGiven = providedCash - payAmount;
    }

    if (markPoolUsed && order.assigned_pool_account) {
      await markPoolAccountUsed(tx, {
        accountNumber: order.assigned_pool_account,
        orderRef: order.order_ref
      });
    }

    const orderUser = await tx.user.findUnique({
      where: { id: order.user_id },
      select: { name: true, phone: true }
    });

    const payDate = resolveBillingDate(reqBody);
    const payNo = await nextSerialNo(tx, 'payment', payDate);
    const batchNo = crypto.randomUUID();

    const payment = await tx.payment.create({
      data: {
        payment_no: payNo,
        batch_no: batchNo,
        client_batch_id: clientBatchId ? String(clientBatchId) : null,
        booking_ref: order.order_ref,
        source: 'shop',
        source_ref: order.order_ref,
        kind: 'charge',
        status: 'valid',
        method: canonicalMethod,
        amount: payAmount,
        cash_received: providedCash,
        change_given: changeGiven,
        person_nos: [],
        breakdown_json: {
          type: 'shop',
          order_id: order.id,
          order_ref: order.order_ref,
          customer_name: orderUser?.name || '商城顧客',
          customer_phone: orderUser?.phone || ''
        },
        note: note ? String(note).trim() : null,
        staff_name: staffName,
        staff_id: staffId,
        device_id: deviceInfo?.device_id || null,
        device_label: deviceInfo?.device_label || '櫃檯'
      }
    });

    await auditLog(tx, {
      booking_ref: order.order_ref,
      event_type: 'shop_payment',
      category: 'payment',
      summary: `商城收款 ${order.order_ref} · ${canonicalMethod === 'cash' ? '現金' : canonicalMethod} NT$${payAmount}`,
      amount: payAmount,
      payment_id: payment.id,
      after_json: {
        order_id: order.id,
        order_ref: order.order_ref,
        amount: payAmount,
        method: canonicalMethod
      },
      staff_name: staffName,
      staff_id: staffId,
      device_id: deviceInfo?.device_id,
      device_label: deviceInfo?.device_label
    });

    const updatedOrder = await recalcOrderPaid(tx, order.id);
    return { order: updatedOrder, payment, idempotent: false };
  });
}
