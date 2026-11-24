import prisma from '../../prismaClient.js';
import { dateOnly, toTaipeiDateString } from '../../../../shared/time.js';

/**
 * Returns the latest shift closing end timestamp (`period_end_at ?? created_at`)
 * for the Taipei business date of `now`, or null if no shift has closed today.
 */
export async function getShiftLock(txOrPrisma = prisma, now = new Date()) {
  const todayStr = toTaipeiDateString(now);
  const closings = await txOrPrisma.cashClosing.findMany({
    where: { business_date: dateOnly(todayStr) }
  });
  if (!closings.length) return null;
  let latestEnd = null;
  for (const c of closings) {
    const candidate = c.period_end_at ?? c.created_at;
    if (!candidate) continue;
    const ms = new Date(candidate).getTime();
    if (!latestEnd || ms > new Date(latestEnd).getTime()) {
      latestEnd = candidate;
    }
  }
  return latestEnd;
}

/**
 * A payment may be voided only when:
 * - status is valid (not already voided), AND
 * - method === 'pass' or amount === 0 (no cash/revenue impact), OR
 * - created_at falls on today's Taipei date AND strictly after today's latest shift lock.
 */
export function canVoidPayment(payment, { shiftLockAt = null, now = new Date() } = {}) {
  if (!payment || payment.status === 'voided') return false;
  if (payment.method === 'pass' || Number(payment.amount) === 0) return true;

  const todayStr = toTaipeiDateString(now);
  const payDateStr = toTaipeiDateString(payment.created_at);
  if (payDateStr !== todayStr) return false;

  if (shiftLockAt && new Date(payment.created_at).getTime() <= new Date(shiftLockAt).getTime()) {
    return false;
  }
  return true;
}
