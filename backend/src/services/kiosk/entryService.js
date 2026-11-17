import prisma from '../../prismaClient.js';
import { toTaipeiDateString } from '../../../../shared/time.js';
import { earliestEntry, ironText } from '../../../../shared/selfService.js';
import { qrKeyFrom, qrCodeFor } from './sgk1.js';
import { ensureKioskSetting } from '../selfService/prepayService.js';
import { isBookingClearedForEntry, resolveZoneForSeats, summarizeBookingBoards } from './accessService.js';

/**
 * 取得顧客半自助預約之進場資訊（狀態、可進場時間、動態 QR 等）
 * @param {object} [db]
 * @param {object} params
 * @param {string} params.bookingRef
 * @param {number} [params.userId] - 呼叫端使用者 ID，必須為預約本人
 * @param {Date} [params.now] - 台北時間戳記，預設為當前時間
 * @returns {Promise<{
 *   state: 'unpaid' | 'reported' | 'mismatch' | 'confirmed' | 'open' | 'in' | 'ended' | 'cancelled',
 *   start: string,
 *   open_at: string,
 *   until: string,
 *   first_checkin_at: string | null,
 *   seats: string[],
 *   zone: string,
 *   iron_text: string,
 *   boards: Array<{ name: string, quantity: number }>,
 *   code: string | null,
 *   code_expires_at: number | null,
 *   server_now: string
 * }>}
 */
export async function getReservationEntryPass(db = prisma, {
  bookingRef,
  userId = null,
  now = new Date()
}) {
  const rows = await db.reservation.findMany({
    where: { booking_ref: bookingRef },
    include: {
      session: true,
      user: { select: { id: true, name: true, phone: true } }
    },
    orderBy: { session: { start_time: 'asc' } }
  });

  if (!rows || rows.length === 0) {
    const err = new Error('RESERVATION_NOT_FOUND');
    err.statusCode = 404;
    throw err;
  }

  const firstRes = rows[0];
  if (userId && firstRes.user_id !== userId) {
    const err = new Error('FORBIDDEN');
    err.statusCode = 403;
    throw err;
  }

  const sessionDate = firstRes.session.session_date;
  const sessionDateStr = toTaipeiDateString(sessionDate);

  const [prepay, dailySetting, kioskSetting, allDaySessions] = await Promise.all([
    db.bookingPrepay.findUnique({ where: { booking_ref: bookingRef } }),
    db.dailySetting.findUnique({ where: { date: sessionDate } }),
    ensureKioskSetting(db),
    db.session.findMany({
      where: { session_date: sessionDate },
      select: { id: true, start_time: true, end_time: true },
      orderBy: { start_time: 'asc' }
    })
  ]);

  const earlyMinutes = kioskSetting?.early_minutes ?? 30;
  const afterCloseMinutes = kioskSetting?.after_close_minutes ?? 60;
  const start = firstRes.session.start_time;
  const openAt = earliestEntry(start, earlyMinutes);
  const openAtDt = new Date(`${sessionDateStr}T${openAt}:00+08:00`);

  const until = allDaySessions.length > 0
    ? allDaySessions.reduce((mx, s) => (s.end_time > mx ? s.end_time : mx), '')
    : '21:00';
  const untilDt = new Date(`${sessionDateStr}T${until}:00+08:00`);
  const closeWindowEndDt = new Date(untilDt.getTime() + afterCloseMinutes * 60000);

  const isCancelled = rows.every((r) => r.status === 'cancelled');
  const cleared = isBookingClearedForEntry(firstRes, prepay);

  let state = 'unpaid';
  if (isCancelled) {
    state = 'cancelled';
  } else if (!cleared) {
    if (prepay) {
      if (prepay.status === 'reported_pending_verify') {
        state = 'reported';
      } else if (prepay.status === 'mismatch') {
        state = 'mismatch';
      } else {
        state = 'unpaid';
      }
    } else {
      state = 'unpaid';
    }
  } else {
    // 已付清
    if (now > closeWindowEndDt) {
      state = 'ended';
    } else if (firstRes.checked_in_at) {
      state = 'in';
    } else if (now < openAtDt) {
      state = 'confirmed';
    } else {
      state = 'open';
    }
  }

  let code = null;
  let codeExpiresAt = null;
  if (state === 'open' || state === 'in') {
    const qrKey = qrKeyFrom();
    const unixSec = Math.floor(now.getTime() / 1000);
    const generated = qrCodeFor(qrKey, bookingRef, unixSec);
    code = generated.code;
    codeExpiresAt = generated.expires_at;
  }

  let activeSeats = [];
  if (!isCancelled) {
    if (Array.isArray(firstRes.assigned_seats) && firstRes.assigned_seats.length > 0) {
      activeSeats = firstRes.assigned_seats.filter((s) => s && !String(s).startsWith('WAIT-'));
    } else {
      activeSeats = rows.map((r) => r.seat_code).filter((s) => s && !String(s).startsWith('WAIT-'));
    }
  }
  const zone = await resolveZoneForSeats(db, sessionDate, activeSeats);
  const boards = await summarizeBookingBoards(db, bookingRef);
  const ironStr = ironText({
    iron_mode: dailySetting?.iron_mode || 'today',
    iron_date: dailySetting?.iron_date,
    date: sessionDateStr,
    today: toTaipeiDateString(now)
  });

  return {
    state,
    start,
    open_at: openAt,
    until,
    first_checkin_at: firstRes.checked_in_at ? firstRes.checked_in_at.toISOString() : null,
    seats: activeSeats,
    zone: zone || '',
    iron_text: ironStr,
    boards,
    code,
    code_expires_at: codeExpiresAt,
    server_now: now.toISOString()
  };
}
