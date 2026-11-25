import prisma from '../../prismaClient.js';
import { getDayInfo } from './dayType.js';

/**
 * Shared Prisma filter for sessions that are currently open for customer/staff booking.
 * Closed sessions (deleted while having cancelled reservations) and future closure types
 * are excluded via `closed_at: null`.
 */
export function bookableSessionWhere() {
  return { closed_at: null };
}

export function isSessionClosed(session) {
  return Boolean(session?.closed_at);
}

/**
 * 確認指定日期不是公休日，否則丟出 409 DAY_CLOSED。
 * @param {import('@prisma/client').PrismaClient} client
 * @param {string|Date} date
 * @param {{ isAdmin?: boolean }} [options]
 */
export async function assertDateBookable(client = prisma, date, { isAdmin = false } = {}) {
  const info = await getDayInfo(client || prisma, date);
  if (info.type === 'closed') {
    const baseMsg = info.closed_note ? `這天臨時公休（${info.closed_note}）` : '這天臨時公休';
    const message = isAdmin ? `${baseMsg}，若要開放請先到時段設定將這天改回營業` : baseMsg;
    throw {
      status: 409,
      code: 'DAY_CLOSED',
      error: message,
      message,
      closed_note: info.closed_note || null
    };
  }
  return info;
}
