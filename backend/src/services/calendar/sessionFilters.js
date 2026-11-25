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
