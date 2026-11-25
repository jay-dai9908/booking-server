import prisma from '../../prismaClient.js';
import { dateOnly } from '../../../../shared/time.js';
import { isRevenuePayment } from '../accounting/revenueScope.js';
import { getConfiguredPaymentMethods, buildMethodBreakdown } from '../accounting/methodAggregation.js';

/**
 * Compute authoritative shift closing stats & receipt snapshot for `[start, end]`.
 * Excludes pass tenders/refunds and shop revenue from store net revenue & by_method;
 * shop_cash_income / shop_cash_refund are reserved (always 0 in Round 36; wired in Round 38).
 */
export async function computeClosingStats({ start, end, businessDate, txOrPrisma = prisma }) {
  const payments = await txOrPrisma.payment.findMany({
    where: { created_at: { gte: start, lte: end } }
  });

  const storePayments = payments.filter(isRevenuePayment);
  const shopPayments = payments.filter(p => !isRevenuePayment(p));

  const validPayments = storePayments.filter(p => p.status === 'valid');
  const charges = validPayments.filter(p => (p.kind === 'charge' || p.kind === 'supplement') && p.method !== 'pass');
  const passes = validPayments.filter(p => (p.kind === 'charge' || p.kind === 'supplement') && p.method === 'pass');
  const refundsList = validPayments.filter(p => p.kind === 'refund' && p.method !== 'pass');
  const passRefundsList = validPayments.filter(p => p.kind === 'refund' && p.method === 'pass');
  const voids = storePayments.filter(p => p.status === 'voided');

  const validShop = shopPayments.filter(p => p.status === 'valid');
  const shopCharges = validShop.filter(p => p.kind === 'charge' || p.kind === 'supplement');
  const shopRefunds = validShop.filter(p => p.kind === 'refund');
  const shopCashIncome = shopCharges.filter(p => p.method === 'cash').reduce((sum, p) => sum + p.amount, 0);
  const shopCashRefund = shopRefunds.filter(p => p.method === 'cash').reduce((sum, p) => sum + p.amount, 0);
  const shopNonCashAmount =
    shopCharges.filter(p => p.method !== 'cash').reduce((sum, p) => sum + p.amount, 0) -
    shopRefunds.filter(p => p.method !== 'cash').reduce((sum, p) => sum + p.amount, 0);

  const configuredMethods = await getConfiguredPaymentMethods(txOrPrisma);
  const { by_method: byMethod, refunds: refundsByMethod, methods } = buildMethodBreakdown(
    charges,
    refundsList,
    configuredMethods
  );

  const totalIncome = charges.reduce((sum, p) => sum + p.amount, 0);
  const totalRefund = refundsList.reduce((sum, p) => sum + p.amount, 0);
  const netRevenue = totalIncome - totalRefund;

  const cashStats = byMethod.cash || { amount: 0 };
  const cashRefundStats = refundsByMethod.cash || { amount: 0 };
  const cashIncome = cashStats.amount;
  const cashRefund = cashRefundStats.amount;

  const passAmount = passes.reduce((sum, p) => sum + p.amount, 0);
  const passRefundAmount = passRefundsList.reduce((sum, p) => sum + p.amount, 0);
  const voidAmount = voids.reduce((sum, p) => sum + p.amount, 0);

  // Unpaid reservations across the entire business date (as of closing time)
  const unpaidRes = await txOrPrisma.reservation.findMany({
    where: {
      status: { not: 'cancelled' },
      session: { session_date: dateOnly(businessDate) },
      billing_status: { in: ['unpaid', 'partial'] }
    }
  });
  const unpaidMap = new Map();
  for (const r of unpaidRes) {
    if (!unpaidMap.has(r.booking_ref)) {
      unpaidMap.set(r.booking_ref, (r.amount_due || 0) - (r.amount_received || 0));
    }
  }
  const unpaidCount = unpaidMap.size;
  const unpaidAmount = Array.from(unpaidMap.values()).reduce((sum, amt) => sum + Math.max(0, amt), 0);

  return {
    by_method: byMethod,
    refunds: refundsByMethod,
    methods,
    voids: {
      count: voids.length,
      amount: voidAmount
    },
    passes: {
      count: passes.length,
      amount: passAmount
    },
    pass_refunds: {
      count: passRefundsList.length,
      amount: passRefundAmount
    },
    unpaid: {
      count: unpaidCount,
      amount: unpaidAmount
    },
    // Receipt-ready flat summary keys (buildClosingSlip reads strictly from totals_json)
    total_count: charges.length,
    total_income: totalIncome,
    actual_received: netRevenue,
    net_revenue: netRevenue,
    refund_amount: totalRefund,
    refund_count: refundsList.length,
    pass_amount: passAmount,
    pass_count: passes.length,
    void_amount: voidAmount,
    void_count: voids.length,
    unpaid_amount: unpaidAmount,
    unpaid_count: unpaidCount,
    cash_income: cashIncome,
    cash_refund: cashRefund,
    shop_cash_income: shopCashIncome,
    shop_cash_refund: shopCashRefund,
    shop: {
      cash_income: shopCashIncome,
      cash_refund: shopCashRefund,
      non_cash_amount: shopNonCashAmount,
      count: shopCharges.length
    }
  };
}
