// backend/src/services/accounting/unpaidQuery.js
// 未結清預約統一查詢口徑（第 44 輪第 3 項）：摘要、交班預覽、未結追蹤三處共用

import prisma from '../../prismaClient.js';
import { dateOnly, toTaipeiDateString } from '../../../../shared/time.js';

function normalizeDateInput(val) {
  if (!val) return null;
  if (val instanceof Date) return dateOnly(toTaipeiDateString(val));
  return dateOnly(String(val));
}

/**
 * 查詢未結清預約並扣除卡券折抵價值。
 * - 排除已取消（status = 'cancelled'）與未到（attendance = 'no_show'，另外計入 no_show_count）
 * - 包含 billing_status IN ('unpaid', 'partial') 或從未開過帳 (billing_status = null 且 is_paid = false)
 * - 批次以一次 groupBy 查出每筆預約的 valid source='booking' method='pass' 折抵淨額
 * - unpaid_amount = max(0, amount_due - amount_received - pass_value)；為 0 者不列入
 */
export async function getUnpaidBookings(client = prisma, { dateFrom = null, dateTo = null } = {}) {
  const fromDate = normalizeDateInput(dateFrom);
  const toDate = normalizeDateInput(dateTo) || dateOnly(toTaipeiDateString(new Date()));

  const sessionDateWhere = fromDate ? { gte: fromDate, lte: toDate } : { lte: toDate };

  const candidates = await client.reservation.findMany({
    where: {
      status: { not: 'cancelled' },
      session: { session_date: sessionDateWhere },
      OR: [
        { billing_status: { in: ['unpaid', 'partial'] } },
        { billing_status: null, is_paid: false }
      ]
    },
    include: {
      user: true,
      session: true
    },
    orderBy: { session: { session_date: 'desc' } }
  });

  // 依 booking_ref 去重
  const uniqueMap = new Map();
  for (const r of candidates) {
    if (!uniqueMap.has(r.booking_ref)) {
      uniqueMap.set(r.booking_ref, r);
    }
  }

  let noShowCount = 0;
  const activeRefs = [];
  const activeReservations = [];
  for (const r of uniqueMap.values()) {
    if (r.attendance === 'no_show') {
      noShowCount += 1;
      continue;
    }
    activeRefs.push(r.booking_ref);
    activeReservations.push(r);
  }

  // 一次 groupBy 查出每筆預約的有效卡券折抵淨額（charge + supplement - refund）
  const passValueByRef = new Map();
  if (activeRefs.length > 0) {
    const passGroups = await client.payment.groupBy({
      by: ['booking_ref', 'kind'],
      where: {
        status: 'valid',
        source: 'booking',
        method: 'pass',
        booking_ref: { in: activeRefs }
      },
      _sum: { amount: true }
    });

    for (const g of passGroups) {
      const amt = g._sum?.amount || 0;
      const prev = passValueByRef.get(g.booking_ref) || 0;
      if (g.kind === 'charge' || g.kind === 'supplement') {
        passValueByRef.set(g.booking_ref, prev + amt);
      } else if (g.kind === 'refund') {
        passValueByRef.set(g.booking_ref, prev - amt);
      }
    }
  }

  const items = [];
  for (const r of activeReservations) {
    const amountDue = r.amount_due ?? r.total_amount ?? 0;
    const amountReceived = r.amount_received ?? 0;
    const passValue = Math.max(0, passValueByRef.get(r.booking_ref) || 0);
    const unpaidAmount = Math.max(0, amountDue - amountReceived - passValue);

    if (unpaidAmount <= 0) continue;

    items.push({
      booking_ref: r.booking_ref,
      ref_display: r.booking_ref,
      user: r.user,
      name: r.user?.name || '現場貴賓',
      pax: r.pax,
      date: r.session?.session_date || null,
      session_date: r.session?.session_date || null,
      status: r.billing_status || 'unpaid',
      billing_status: r.billing_status || 'unpaid',
      attendance: r.attendance || null,
      amount_due: amountDue,
      amount_received: amountReceived,
      pass_value: passValue,
      unpaid_amount: unpaidAmount
    });
  }

  const totalAmount = items.reduce((sum, item) => sum + item.unpaid_amount, 0);

  return {
    count: items.length,
    amount: totalAmount,
    no_show_count: noShowCount,
    items
  };
}
