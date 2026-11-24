import prisma from '../../prismaClient.js';
import { dateOnly, toTaipeiDateString } from '../../../../shared/time.js';

/**
 * Returns the latest shift closing timestamp for the Taipei business date of `now`, or null if no shift has closed today.
 */
export async function getShiftLock(txOrPrisma = prisma, now = new Date()) {
  const todayStr = toTaipeiDateString(now);
  const latest = await txOrPrisma.cashClosing.findFirst({
    where: { business_date: dateOnly(todayStr) },
    orderBy: [{ created_at: 'desc' }, { id: 'desc' }]
  });
  return latest ? latest.created_at : null;
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
