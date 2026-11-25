import prisma from '../../prismaClient.js';
import { lockPrepay } from '../selfService/prepayService.js';
import { restorePass } from '../billing/passTender.js';
import { log as auditLog } from '../audit/auditService.js';
import { refreshBillingCache } from '../billing/billService.js';
import { releasePromo } from '../promo/redemption.js';
import { releasePoolAccount } from '../selfService/poolAccountService.js';
import { sendBookingCancellationNotification } from '../../utils/lineMessaging.js';

export function formatSessionsToTimeRange(sessions) {
  if (!sessions || sessions.length === 0) return '';
  const sorted = [...sessions].sort((a, b) => (a.start_time || '').localeCompare(b.start_time || ''));
  const blocks = [];
  let currentBlock = null;
  for (const s of sorted) {
    if (!currentBlock) {
      currentBlock = { start_time: s.start_time, end_time: s.end_time };
    } else if (s.start_time === currentBlock.end_time) {
      currentBlock.end_time = s.end_time;
    } else {
      blocks.push(currentBlock);
      currentBlock = { start_time: s.start_time, end_time: s.end_time };
    }
  }
  if (currentBlock) blocks.push(currentBlock);
  return blocks.map((b) => `${b.start_time} - ${b.end_time}`).join(', ');
}

/**
 * 在呼叫端的資料庫交易 (tx) 內執行預約取消的核心邏輯。
 * `suppressAutoNotify: true` 時回傳旗標讓呼叫端跳過預設自動取消通知（如臨時公休批次通知）。
 */
export async function cancelBooking(
  tx,
  {
    booking_ref,
    actor = 'customer',
    userId = null,
    operatorName = null,
    reason = null,
    isAdmin = actor === 'admin',
    confirmPaidCancel = false,
    suppressAutoNotify = false
  }
) {
  const effectiveOperatorName = operatorName || (isAdmin ? '管理員' : 'customer');
  const cancelledByTag = isAdmin ? `admin:${effectiveOperatorName}` : 'customer';

  const lockedPrepay = await lockPrepay(tx, booking_ref);

  const reservations = await tx.reservation.findMany({
    where: { booking_ref },
    include: { session: true }
  });

  if (reservations.length === 0) {
    return { errorStatus: 404, errorBody: { error: '找不到該筆預約' } };
  }

  if (!isAdmin && reservations[0].user_id !== userId) {
    return { errorStatus: 403, errorBody: { error: '無權限取消此預約' } };
  }

  if (reservations[0].status === 'cancelled') {
    return { errorStatus: 400, errorBody: { error: '此預約先前已取消' } };
  }

  const isSelfCustomerAllPassVerified =
    !isAdmin &&
    Boolean(lockedPrepay) &&
    lockedPrepay.status === 'verified' &&
    (lockedPrepay.amount_due ?? 0) === 0 &&
    !reservations.some((r) => r.amount_received && r.amount_received > 0);

  if (!isAdmin && lockedPrepay && lockedPrepay.status !== 'pending_payment' && !isSelfCustomerAllPassVerified) {
    return { errorStatus: 400, errorBody: { error: '這筆預約已經付款或正在對帳，如需取消請用 LINE 聯絡我們' } };
  }

  const isCollected =
    !isSelfCustomerAllPassVerified &&
    reservations.some((r) => r.amount_received && r.amount_received > 0);
  if (isCollected) {
    const amt = reservations[0].amount_received || 0;
    return { errorStatus: 409, errorBody: { error: `這筆已收款 NT$${amt}，請先退款或作廢收款` } };
  }

  const hasPaid = !isSelfCustomerAllPassVerified && reservations.some((r) => r.is_paid);
  const hasCheckedIn = reservations.some((r) => r.attendance === 'checked_in');

  let earliestStartDateTime = null;
  for (const r of reservations) {
    if (r.session?.session_date && r.session?.start_time) {
      const dateStr = r.session.session_date.toISOString().slice(0, 10);
      const dt = new Date(`${dateStr}T${r.session.start_time}:00+08:00`);
      if (!earliestStartDateTime || dt < earliestStartDateTime) {
        earliestStartDateTime = dt;
      }
    }
  }
  const hasStarted = earliestStartDateTime && new Date() >= earliestStartDateTime;

  if (!isAdmin) {
    if (hasPaid) {
      return { errorStatus: 400, errorBody: { error: '此預約已完成付款，如需取消或退款請直接聯繫門市人員協助！' } };
    }
    if (hasCheckedIn) {
      return { errorStatus: 400, errorBody: { error: '此預約已報到入座，無法取消。' } };
    }
    if (hasStarted) {
      return { errorStatus: 400, errorBody: { error: '此預約時段已過開始時間，無法線上取消。如需協助請聯繫門市人員。' } };
    }
  } else if (hasPaid && !confirmPaidCancel) {
    return {
      errorStatus: 409,
      errorBody: {
        code: 'REQUIRE_PAID_CANCEL_CONFIRM',
        error: '此預約已完成付款結帳，取消將影響營收帳務，請再次確認是否強制取消？'
      }
    };
  }

  if (lockedPrepay && lockedPrepay.status !== 'cancelled' && lockedPrepay.status !== 'expired') {
    if (isSelfCustomerAllPassVerified) {
      const validPayments = await tx.payment.findMany({
        where: { booking_ref, status: 'valid' }
      });
      const nowVoid = new Date();
      for (const vp of validPayments) {
        await tx.payment.update({
          where: { id: vp.id },
          data: {
            status: 'voided',
            voided_at: nowVoid,
            voided_by_name: 'customer',
            void_reason: '顧客取消半自助卡券預約'
          }
        });
        if (vp.method === 'pass' && Array.isArray(vp.pass_json)) {
          for (const pj of vp.pass_json) {
            if (pj?.user_pass_id) {
              await restorePass(tx, {
                user_pass_id: Number(pj.user_pass_id),
                units: Number(pj.units) || 1,
                booking_ref,
                payment_no: vp.payment_no,
                person_no: pj.person_no ?? null,
                staff_name: 'customer'
              });
              await auditLog(tx, {
                booking_ref,
                event_type: 'pass_restored',
                category: 'pass',
                summary: `卡券退回（取消預約）· ${pj.plan_name || '計次卡'} · ${pj.units || 1} 次`,
                payment_id: vp.id,
                staff_name: 'customer',
                device_label: '線上取消'
              });
            }
          }
        }
        await auditLog(tx, {
          booking_ref,
          event_type: 'payment_voided',
          category: 'payment',
          summary: `作廢收款（取消預約）· ${vp.payment_no}`,
          amount: -(vp.amount || 0),
          reason: '顧客取消半自助卡券預約',
          payment_id: vp.id,
          staff_name: 'customer',
          device_label: '線上取消'
        });
      }
      await refreshBillingCache(tx, booking_ref);
    } else {
      if (lockedPrepay.assigned_pool_account && lockedPrepay.status === 'pending_payment') {
        await releasePoolAccount(tx, {
          accountNumber: lockedPrepay.assigned_pool_account,
          orderRef: booking_ref
        });
      }
      if (!lockedPrepay.settled_at) {
        const holds = Array.isArray(lockedPrepay.pass_holds) ? lockedPrepay.pass_holds : [];
        for (const h of holds) {
          if (h?.user_pass_id && (Number(h.units) || 0) > 0) {
            const restoredPass = await restorePass(tx, {
              user_pass_id: Number(h.user_pass_id),
              units: Number(h.units),
              booking_ref,
              payment_no: null,
              person_no: null,
              staff_name: effectiveOperatorName
            });
            await auditLog(tx, {
              booking_ref,
              event_type: 'pass_restored',
              category: 'pass',
              summary: `半自助卡券退回（取消預約）· ${h.plan_name || '計次卡'} · ${Number(h.units)} 次`,
              after_json: {
                user_pass_id: Number(h.user_pass_id),
                units: Number(h.units),
                remaining_after: restoredPass?.remaining_quota ?? null
              },
              staff_name: effectiveOperatorName,
              device_label: '線上預約'
            });
          }
        }
      }
    }

    await tx.bookingPrepay.update({
      where: { booking_ref },
      data: { status: 'cancelled' }
    });
  }

  const cancelledRes = await tx.reservation.updateMany({
    where: { booking_ref },
    data: {
      status: 'cancelled',
      cancelled_at: new Date(),
      cancelled_by: cancelledByTag
    }
  });

  await releasePromo(tx, { booking_ref, reason: reason || 'reservation_cancelled' });

  return {
    cancelledRes,
    reservations,
    suppressAutoNotify
  };
}

export async function sendAutoCancelNotification(reservations, { booking_ref, isAdmin }) {
  try {
    const globalSetting = await prisma.globalSetting.findUnique({
      where: { id: 1 },
      select: { line_auto_notify_cancel: true }
    });
    if (!globalSetting?.line_auto_notify_cancel) return;
    const firstRes = reservations[0];
    if (!firstRes) return;
    const user = await prisma.user.findUnique({
      where: { id: firstRes.user_id },
      select: { id: true, name: true, line_user_id: true }
    });
    if (!user?.line_user_id || user.line_user_id.startsWith('manual_')) return;

    const resSessions = await prisma.session.findMany({
      where: { id: { in: reservations.map((r) => r.session_id) } },
      orderBy: { start_time: 'asc' }
    });
    const firstSession = resSessions[0];
    const timeRange = formatSessionsToTimeRange(resSessions);

    await sendBookingCancellationNotification(
      {
        booking_ref,
        session_date: firstSession?.session_date || firstRes.session_date,
        time_range: timeRange
      },
      user,
      isAdmin ? 'admin' : 'customer'
    );
  } catch (notifyErr) {
    console.warn('[cancelReservation] Auto LINE cancellation notification failed:', notifyErr.message);
  }
}

export default { cancelBooking, sendAutoCancelNotification, formatSessionsToTimeRange };
