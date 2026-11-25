// backend/src/services/accounting/shopRevenue.js
// 商城收入獨立統計核心函式（第 44 輪第 5 項）：摘要頁 shop 區塊與 /shop-summary 共用同一套口徑

import prisma from '../../prismaClient.js';
import { toTaipeiDateString } from '../../../../shared/time.js';
import { getConfiguredPaymentMethods, buildMethodBreakdown } from './methodAggregation.js';

function buildDateList(fromStr, toStr) {
  const days = [];
  const cursor = new Date(`${fromStr}T00:00:00Z`);
  const endD = new Date(`${toStr}T00:00:00Z`);
  while (cursor <= endD) {
    days.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return days;
}

/**
 * 計算指定期間內 source='shop' 的收款、退款、淨額、不重複單號數、付款方式分佈與每日走勢
 */
export async function computeShopSummary(client = prisma, { start, end, startStr, endStr }) {
  const payments = await client.payment.findMany({
    where: {
      source: 'shop',
      status: 'valid',
      created_at: { gte: start, lte: end }
    },
    orderBy: [{ created_at: 'asc' }, { id: 'asc' }]
  });

  const shopCharges = payments.filter(
    (p) => (p.kind === 'charge' || p.kind === 'supplement') && p.method !== 'pass'
  );
  const shopRefunds = payments.filter((p) => p.kind === 'refund' && p.method !== 'pass');

  const income = shopCharges.reduce((sum, p) => sum + (p.amount || 0), 0);
  const refunds = shopRefunds.reduce((sum, p) => sum + (p.amount || 0), 0);
  const net = income - refunds;

  const uniqueOrders = new Set(
    shopCharges.map((p) => p.source_ref || p.booking_ref).filter(Boolean)
  );

  const configuredMethods = await getConfiguredPaymentMethods(client);
  const { by_method: byMethod, refunds: refundsByMethod, methods } = buildMethodBreakdown(
    shopCharges,
    shopRefunds,
    configuredMethods
  );

  const resolvedFrom = startStr || toTaipeiDateString(start);
  const resolvedTo = endStr || toTaipeiDateString(end);
  const dayBuckets = new Map();
  for (const d of buildDateList(resolvedFrom, resolvedTo)) {
    dayBuckets.set(d, { date: d, income: 0, refunds: 0, net: 0 });
  }

  for (const p of shopCharges) {
    const dStr = toTaipeiDateString(p.created_at);
    if (!dayBuckets.has(dStr)) continue;
    const row = dayBuckets.get(dStr);
    row.income += p.amount || 0;
    row.net += p.amount || 0;
  }

  for (const p of shopRefunds) {
    const dStr = toTaipeiDateString(p.created_at);
    if (!dayBuckets.has(dStr)) continue;
    const row = dayBuckets.get(dStr);
    row.refunds += p.amount || 0;
    row.net -= p.amount || 0;
  }

  return {
    income,
    refunds,
    net,
    order_count: uniqueOrders.size,
    charge_count: shopCharges.length,
    refund_count: shopRefunds.length,
    by_method: byMethod,
    refunds_by_method: refundsByMethod,
    methods,
    daily: Array.from(dayBuckets.values())
  };
}
