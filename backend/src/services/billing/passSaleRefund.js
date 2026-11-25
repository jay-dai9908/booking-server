import crypto from 'crypto';
import { assertEnabledPaymentMethod, nextSerialNo } from './billService.js';
import { log as auditLog } from '../audit/auditService.js';

/**
 * Refund a purchased user pass (source: 'pass_sale').
 * Never touches booking bill calculations (refreshBillingCache / getBookingBill).
 */
export async function refundPassSale(tx, {
  userPassId,
  amount,
  method,
  reason,
  clientBatchId = null,
  staff = {},
  device = {},
  now = new Date()
}) {
  const passId = parseInt(userPassId, 10);
  if (!Number.isInteger(passId) || passId <= 0) {
    throw { status: 400, code: 'INVALID_PASS_ID', message: '無效的卡券編號' };
  }

  const trimmedReason = reason ? String(reason).trim() : '';
  if (!trimmedReason) {
    throw { status: 422, code: 'REASON_REQUIRED', message: '請填寫退費原因' };
  }

  // Row lock matching deductPass concurrency protocol
  await tx.$queryRaw`SELECT id FROM "UserPass" WHERE id = ${passId} FOR UPDATE`;

  const userPass = await tx.userPass.findUnique({
    where: { id: passId },
    include: {
      user: { select: { id: true, name: true, phone: true } },
      plan: true
    }
  });

  if (!userPass) {
    throw { status: 404, code: 'PASS_NOT_FOUND', message: '找不到該張卡券' };
  }

  if (clientBatchId) {
    const existingRefund = await tx.payment.findFirst({
      where: {
        client_batch_id: String(clientBatchId),
        source: 'pass_sale',
        kind: 'refund',
        status: 'valid'
      }
    });
    if (existingRefund) {
      return {
        pass: userPass,
        payment: existingRefund,
        deduplicated: true
      };
    }
  }

  const rawMethod = String(method || '').trim().toLowerCase();
  if (!rawMethod) {
    throw { status: 422, code: 'METHOD_REQUIRED', message: '請選擇退款方式' };
  }
  if (rawMethod === 'pass') {
    throw { status: 422, code: 'INVALID_METHOD', message: '卡券退費不可使用卡券付款方式' };
  }
  const matchedMethod = await assertEnabledPaymentMethod(tx, rawMethod);
  const canonicalMethod = matchedMethod.key;

  const salePayment = await tx.payment.findFirst({
    where: {
      source: 'pass_sale',
      source_ref: userPass.pass_code,
      kind: 'charge',
      status: 'valid'
    },
    orderBy: { id: 'desc' }
  });

  if (!salePayment) {
    throw { status: 409, code: 'NO_PASS_SALE_PAYMENT', message: '這張卡沒有販售收款，只能作廢' };
  }

  const priorRefunds = await tx.payment.findMany({
    where: {
      source: 'pass_sale',
      source_ref: userPass.pass_code,
      kind: 'refund',
      status: 'valid'
    },
    select: { amount: true }
  });
  const refundedSoFar = priorRefunds.reduce((sum, r) => sum + (Number(r.amount) || 0), 0);
  const remainingRefundable = Math.max(0, (Number(salePayment.amount) || 0) - refundedSoFar);

  const parsedAmount = typeof amount === 'number' ? amount : Number(String(amount ?? '').trim());
  if (!Number.isInteger(parsedAmount) || parsedAmount <= 0) {
    throw { status: 422, code: 'INVALID_AMOUNT', message: '退款金額必須為正整數' };
  }
  if (parsedAmount > remainingRefundable) {
    throw {
      status: 422,
      code: 'EXCEEDS_REFUNDABLE',
      message: `退款金額（NT$${parsedAmount}）超過可退餘額（NT$${remainingRefundable}）`
    };
  }

  const staffName = staff?.name || '門市人員';
  const staffId = staff?.id || null;
  const deviceId = device?.device_id || null;
  const deviceLabel = device?.device_label || '管理後台';

  const payNo = await nextSerialNo(tx, 'payment', now);
  const batchNo = crypto.randomUUID();
  const planName = userPass.plan_name_snapshot || userPass.plan?.name || '卡券';
  const codeTail = String(userPass.pass_code || '').slice(-4);

  const refundPayment = await tx.payment.create({
    data: {
      payment_no: payNo,
      batch_no: batchNo,
      client_batch_id: clientBatchId ? String(clientBatchId) : null,
      booking_ref: userPass.pass_code,
      source: 'pass_sale',
      source_ref: userPass.pass_code,
      kind: 'refund',
      status: 'valid',
      method: canonicalMethod,
      amount: parsedAmount,
      person_nos: [],
      related_payment_id: salePayment.id,
      breakdown_json: {
        type: 'pass_sale_refund',
        user_pass_id: userPass.id,
        pass_code: userPass.pass_code,
        plan_name: planName,
        related_payment_id: salePayment.id,
        related_payment_no: salePayment.payment_no,
        customer_name: userPass.user?.name || null,
        customer_phone: userPass.user?.phone || null
      },
      reason: trimmedReason,
      staff_name: staffName,
      staff_id: staffId,
      device_id: deviceId,
      device_label: deviceLabel
    }
  });

  await auditLog(tx, {
    booking_ref: userPass.pass_code,
    event_type: 'pass_sale_refunded',
    category: 'refund',
    target_type: 'user_pass',
    target_ref: userPass.pass_code,
    summary: `卡券販售退費 *${codeTail} · NT$${parsedAmount} · ${trimmedReason}`,
    amount: parsedAmount,
    payment_id: refundPayment.id,
    reason: trimmedReason,
    after_json: {
      user_pass_id: userPass.id,
      pass_code_last4: codeTail,
      amount: parsedAmount,
      method: canonicalMethod,
      related_payment_id: salePayment.id,
      reason: trimmedReason
    },
    staff_name: staffName,
    staff_id: staffId,
    device_id: deviceId,
    device_label: deviceLabel
  });

  const prevStatus = userPass.status;
  let updatedPass = userPass;
  if (prevStatus !== 'REVOKED') {
    updatedPass = await tx.userPass.update({
      where: { id: userPass.id },
      data: { status: 'REVOKED' },
      include: {
        user: { select: { id: true, name: true, phone: true } },
        plan: true
      }
    });

    await auditLog(tx, {
      booking_ref: userPass.pass_code,
      event_type: 'pass_status_changed',
      category: 'pass',
      target_type: 'user_pass',
      target_ref: userPass.pass_code,
      summary: `卡券 *${codeTail} 退費作廢（${prevStatus} → REVOKED）· ${trimmedReason}`,
      reason: trimmedReason,
      before_json: { status: prevStatus, remaining_quota: userPass.remaining_quota },
      after_json: { status: 'REVOKED', remaining_quota: userPass.remaining_quota },
      staff_name: staffName,
      staff_id: staffId,
      device_id: deviceId,
      device_label: deviceLabel
    });
  }

  return {
    pass: updatedPass,
    payment: refundPayment,
    deduplicated: false
  };
}
