import prisma from '../../prismaClient.js';
import { dateOnly, toTaipeiDateString } from '../../../../shared/time.js';
import { earliestEntry, ironText } from '../../../../shared/selfService.js';
import { qrKeyFrom, parseQr, bookingRefPrefix, verifyQrMac } from './sgk1.js';
import { ensureKioskSetting } from '../selfService/prepayService.js';
import { getActiveLayoutForDate, lockDaySeats } from '../seating/layoutService.js';
import { reseatBookings } from '../seating/allocator.js';
import { applyCheckInRecords } from '../floor/checkInService.js';
import { sendSelfServiceFirstCheckinNotification } from '../../utils/lineMessaging.js';
import { activeUserWhere } from '../../utils/userQuery.js';

export function isBookingClearedForEntry(firstRes, prepay) {
  if (!firstRes) return false;
  if (prepay?.status === 'verified') return true;
  if (firstRes.billing_status === 'paid' || firstRes.billing_status === 'waived') return true;
  return false;
}

export async function resolveZoneForSeats(dbOrTx, sessionDate, seats = []) {
  const realSeats = (Array.isArray(seats) ? seats : []).filter((s) => s && !String(s).startsWith('WAIT-'));
  if (realSeats.length === 0) return '';
  const layout = await getActiveLayoutForDate(dbOrTx, sessionDate);
  if (!layout?.seats?.length) return '';
  const seatObj = layout.seats.find((ls) => ls.code === realSeats[0]);
  if (!seatObj) return '';
  const zoneObj = (layout.zones || []).find((z) => z.id === seatObj.zone_id);
  return zoneObj?.name || '';
}

export async function summarizeBookingBoards(dbOrTx, bookingRef) {
  const rows = await dbOrTx.bookingEquipment.findMany({
    where: { booking_ref: bookingRef }
  });
  const byName = new Map();
  for (const eq of rows) {
    if (!eq || eq.equipment_id === 'bring_own') continue;
    const name = eq.equipment_name_snapshot || eq.equipment_id;
    const qty = Number(eq.quantity) || 1;
    byName.set(name, (byName.get(name) || 0) + qty);
  }
  return Array.from(byName.entries()).map(([name, quantity]) => ({ name, quantity }));
}

function buildBookingBody({
  user,
  pax,
  zone = '',
  seats,
  start,
  openAt,
  until,
  ironStr,
  includeSeats = false
}) {
  const out = {
    name: user?.name || '會員',
    pax,
    zone: includeSeats ? (zone || '') : '',
    start,
    open_at: openAt,
    until,
    iron_text: ironStr
  };
  if (includeSeats) {
    out.seats = Array.isArray(seats) ? seats : [];
  }
  return out;
}

function groupReservationsByRef(rows) {
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.booking_ref)) map.set(r.booking_ref, []);
    map.get(r.booking_ref).push(r);
  }
  for (const list of map.values()) {
    list.sort((a, b) => a.session.start_time.localeCompare(b.session.start_time));
  }
  return map;
}

async function recordAccessLog(db, {
  deviceId = null,
  at,
  method,
  result,
  openDoor,
  bookingRef = null,
  userId = null,
  hint = null
}) {
  await db.kioskAccessLog.create({
    data: {
      device_id: deviceId,
      at,
      method,
      result,
      open_door: openDoor,
      booking_ref: bookingRef,
      user_id: userId,
      hint,
      offline: false,
      event_id: null
    }
  });
}

/**
 * 報到機 POST /api/kiosk/v1/access 核心判斷與首次報到交易
 * 判斷順序嚴格遵守：NORMAL_DAY -> 格式驗證(NOT_FOUND) -> 查今日 confirmed 預約(NOT_FOUND/QR_EXPIRED)
 *   -> 未付清(UNVERIFIED) -> TOO_EARLY -> ENDED -> RE_ENTRY -> FIRST_CHECKIN
 */
export async function processKioskAccess(db = prisma, {
  device = null,
  method,
  payload,
  now = new Date(),
  notifyFn = sendSelfServiceFirstCheckinNotification,
  reseatFn = reseatBookings
}) {
  const cleanMethod = method === 'qr' ? 'qr' : (method === 'phone' ? 'phone' : String(method || 'qr'));
  const rawPayload = String(payload ?? '').trim();
  const deviceId = device?.id ?? null;

  let parsedQr = null;
  let hint = null;
  if (cleanMethod === 'qr') {
    parsedQr = parseQr(rawPayload);
    hint = parsedQr ? parsedQr.entry : null;
  } else if (cleanMethod === 'phone') {
    const digitsOnly = rawPayload.replace(/\D/g, '');
    hint = digitsOnly.length >= 3 ? digitsOnly.slice(-3) : null;
  }

  const finish = async (result, openDoor, booking = undefined, meta = {}) => {
    await recordAccessLog(db, {
      deviceId,
      at: now,
      method: cleanMethod,
      result,
      openDoor,
      bookingRef: meta.bookingRef || null,
      userId: meta.userId || null,
      hint
    });
    return booking ? { result, open_door: openDoor, booking } : { result, open_door: openDoor };
  };

  const todayStr = toTaipeiDateString(now);
  const todayDate = dateOnly(todayStr);

  // 1. 今天不是半自助日 -> NORMAL_DAY
  const dailySetting = await db.dailySetting.findUnique({ where: { date: todayDate } });
  if (!dailySetting?.is_self_service) {
    return finish('NORMAL_DAY', false);
  }

  // 2. 格式檢查 -> NOT_FOUND
  if (cleanMethod === 'qr') {
    if (!parsedQr) {
      return finish('NOT_FOUND', false);
    }
  } else if (cleanMethod === 'phone') {
    if (!/^09\d{8}$/.test(rawPayload)) {
      return finish('NOT_FOUND', false);
    }
  } else {
    return finish('NOT_FOUND', false);
  }

  // 預讀今日時段與報到機規則
  const [kioskSetting, allDaySessions] = await Promise.all([
    ensureKioskSetting(db),
    db.session.findMany({
      where: { session_date: todayDate },
      select: { id: true, start_time: true, end_time: true },
      orderBy: { start_time: 'asc' }
    })
  ]);

  const earlyMinutes = kioskSetting?.early_minutes ?? 30;
  const afterCloseMinutes = kioskSetting?.after_close_minutes ?? 60;
  const until = allDaySessions.length > 0
    ? allDaySessions.reduce((mx, s) => (s.end_time > mx ? s.end_time : mx), '')
    : '21:00';
  const untilDt = new Date(`${todayStr}T${until}:00+08:00`);
  const closeWindowEndDt = new Date(untilDt.getTime() + afterCloseMinutes * 60000);
  const ironStr = ironText({
    iron_mode: dailySetting.iron_mode || 'today',
    iron_date: dailySetting.iron_date,
    date: todayStr,
    today: todayStr
  });

  // 3. 找今天（台北時間）、狀態 confirmed 的預約
  let selectedGroup = null;
  let selectedPrepay = null;

  if (cleanMethod === 'qr') {
    const prefix = bookingRefPrefix(parsedQr.entry);
    const matchingRows = await db.reservation.findMany({
      where: {
        status: 'confirmed',
        booking_ref: { startsWith: prefix },
        session: { session_date: todayDate }
      },
      include: {
        session: true,
        user: { select: { id: true, name: true, phone: true, line_user_id: true } }
      },
      orderBy: { session: { start_time: 'asc' } }
    });

    if (matchingRows.length === 0) {
      return finish('NOT_FOUND', false);
    }

    const groups = groupReservationsByRef(matchingRows);
    selectedGroup = Array.from(groups.values())[0];
    const targetRef = selectedGroup[0].booking_ref;

    const qrKey = qrKeyFrom(process.env.JWT_SECRET);
    const macStatus = verifyQrMac(qrKey, targetRef, parsedQr.mac, Math.floor(now.getTime() / 1000));
    if (macStatus !== 'ok') {
      return finish('QR_EXPIRED', false, undefined, {
        bookingRef: targetRef,
        userId: selectedGroup[0].user_id
      });
    }

    selectedPrepay = await db.bookingPrepay.findUnique({ where: { booking_ref: targetRef } });
  } else {
    const matchingRows = await db.reservation.findMany({
      where: {
        status: 'confirmed',
        user: activeUserWhere({ phone: rawPayload }),
        session: { session_date: todayDate }
      },
      include: {
        session: true,
        user: { select: { id: true, name: true, phone: true, line_user_id: true } }
      },
      orderBy: { session: { start_time: 'asc' } }
    });

    if (matchingRows.length === 0) {
      return finish('NOT_FOUND', false);
    }

    const groups = groupReservationsByRef(matchingRows);
    const candidateRefs = Array.from(groups.keys());
    const prepays = await db.bookingPrepay.findMany({
      where: { booking_ref: { in: candidateRefs } }
    });
    const prepayMap = new Map(prepays.map((p) => [p.booking_ref, p]));

    const ranked = Array.from(groups.values()).map((grp) => {
      const first = grp[0];
      const p = prepayMap.get(first.booking_ref) || null;
      const cleared = isBookingClearedForEntry(first, p);
      const startTime = first.session.start_time;
      const openAt = earliestEntry(startTime, earlyMinutes);
      const openAtDt = new Date(`${todayStr}T${openAt}:00+08:00`);
      const inWindow = now >= openAtDt && now <= closeWindowEndDt;
      return { grp, prepay: p, cleared, inWindow, startTime };
    });

    ranked.sort((a, b) => {
      const aTier = a.cleared && a.inWindow ? 0 : (a.cleared ? 1 : 2);
      const bTier = b.cleared && b.inWindow ? 0 : (b.cleared ? 1 : 2);
      if (aTier !== bTier) return aTier - bTier;
      return a.startTime.localeCompare(b.startTime);
    });

    selectedGroup = ranked[0].grp;
    selectedPrepay = ranked[0].prepay;
  }

  const firstRes = selectedGroup[0];
  const targetRef = firstRes.booking_ref;
  const user = firstRes.user;
  const start = firstRes.session.start_time;
  const openAt = earliestEntry(start, earlyMinutes);
  const openAtDt = new Date(`${todayStr}T${openAt}:00+08:00`);

  // 4. 還沒付清 -> UNVERIFIED
  if (!isBookingClearedForEntry(firstRes, selectedPrepay)) {
    return finish(
      'UNVERIFIED',
      false,
      buildBookingBody({ user, pax: firstRes.pax, start, openAt, until, ironStr, includeSeats: false }),
      { bookingRef: targetRef, userId: firstRes.user_id }
    );
  }

  // 5. 早於可進場時間 -> TOO_EARLY
  if (now < openAtDt) {
    return finish(
      'TOO_EARLY',
      false,
      buildBookingBody({ user, pax: firstRes.pax, start, openAt, until, ironStr, includeSeats: false }),
      { bookingRef: targetRef, userId: firstRes.user_id }
    );
  }

  // 6. 晚於打烊後寬限時間 -> ENDED
  if (now > closeWindowEndDt) {
    return finish(
      'ENDED',
      false,
      buildBookingBody({ user, pax: firstRes.pax, start, openAt, until, ironStr, includeSeats: false }),
      { bookingRef: targetRef, userId: firstRes.user_id }
    );
  }

  // 7 & 8. 在同一筆 booking_ref 的交易鎖內判斷是否首次報到或再次進門
  const preBookingDateStr = toTaipeiDateString(firstRes.session.session_date);
  const txOutcome = await db.$transaction(async (tx) => {
    await lockDaySeats(tx, preBookingDateStr);
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${targetRef}))`;

    const lockedRows = await tx.reservation.findMany({
      where: { booking_ref: targetRef, status: 'confirmed' },
      include: {
        session: true,
        user: { select: { id: true, name: true, phone: true, line_user_id: true } }
      },
      orderBy: { session: { start_time: 'asc' } }
    });

    if (lockedRows.length === 0) {
      return { notFound: true };
    }

    const lockedFirst = lockedRows[0];
    const sessionIds = lockedRows.map((r) => r.session_id);

    // 7. 已經報到過 -> RE_ENTRY（開門、只記錄、不推 LINE）
    if (lockedFirst.checked_in_at) {
      const physicalSeats = (lockedFirst.assigned_seats || []).filter((s) => s && !String(s).startsWith('WAIT-'));
      const zone = await resolveZoneForSeats(tx, todayDate, physicalSeats);
      return {
        result: 'RE_ENTRY',
        isFirstCheckin: false,
        seats: physicalSeats,
        zone,
        user: lockedFirst.user,
        pax: lockedFirst.pax
      };
    }

    // 8. 首次進門 -> FIRST_CHECKIN
    const rawSeats = Array.isArray(lockedFirst.assigned_seats) ? lockedFirst.assigned_seats.filter(Boolean) : [];
    const needsPhysicalSeat = rawSeats.length === 0 || rawSeats.some((s) => String(s).startsWith('WAIT-'));

    let finalSeats = rawSeats.filter((s) => !String(s).startsWith('WAIT-'));
    let touchedSessionIds = [];

    if (needsPhysicalSeat) {
      // 呼叫 reseatBookings 前先建立 SAVEPOINT：
      // 1. reseatBookings (allocator.js) 是一邊計算一邊寫入資料庫；若在處理後續預約時拋出
      //    CANNOT_DISPLACE 等業務異常，ROLLBACK TO SAVEPOINT 可確保前面已被修改的其他顧客座位
      //    完全復原，絕不留下改了一半的狀態。
      // 2. 若重排過程中發生任何資料庫異常（如唯一約束或 SQL 錯誤），PostgreSQL 會將整筆交易標記為
      //    aborted；透過回滾至 SAVEPOINT 可清除錯誤狀態，使外層報到交易能順利提交並開門，
      //    嚴格貫徹「排不到座位也照樣開門」的業務原則。
      await tx.$executeRaw`SAVEPOINT kiosk_reseat`;
      try {
        const displaced = await reseatFn(tx, {
          bookingRefs: [targetRef],
          reservedSeats: [],
          sessionIds
        });
        await tx.$executeRaw`RELEASE SAVEPOINT kiosk_reseat`;
        touchedSessionIds = displaced?.touchedSessionIds || [];
        const updatedRow = await tx.reservation.findFirst({
          where: { booking_ref: targetRef, status: 'confirmed' },
          select: { assigned_seats: true }
        });
        const candidateSeats = (updatedRow?.assigned_seats || []).filter(Boolean);
        finalSeats = candidateSeats.some((s) => String(s).startsWith('WAIT-')) ? [] : candidateSeats;
      } catch (err) {
        // 重排失敗或資料庫異常：回滾到 SAVEPOINT，復原所有已被異動的座位並復原交易可用狀態
        await tx.$executeRaw`ROLLBACK TO SAVEPOINT kiosk_reseat`;
        // 仍然排不到實體座位：照樣開門，seats 回空陣列
        finalSeats = [];
        touchedSessionIds = [];
      }
    }

    await applyCheckInRecords(tx, {
      booking_ref: targetRef,
      reservations: lockedRows,
      seats: finalSeats,
      start_timer: false,
      staffName: '報到機',
      seat_source: undefined,
      is_seat_locked: true,
      now,
      touchedSessionIds
    });

    const [zone, boards] = await Promise.all([
      resolveZoneForSeats(tx, todayDate, finalSeats),
      summarizeBookingBoards(tx, targetRef)
    ]);

    return {
      result: 'FIRST_CHECKIN',
      isFirstCheckin: true,
      seats: finalSeats,
      zone,
      boards,
      user: lockedFirst.user,
      pax: lockedFirst.pax
    };
  });

  if (txOutcome.notFound) {
    return finish('NOT_FOUND', false);
  }

  const bookingBody = buildBookingBody({
    user: txOutcome.user,
    pax: txOutcome.pax,
    zone: txOutcome.zone,
    seats: txOutcome.seats,
    start,
    openAt,
    until,
    ironStr,
    includeSeats: true
  });

  const out = await finish(txOutcome.result, true, bookingBody, {
    bookingRef: targetRef,
    userId: txOutcome.user?.id || firstRes.user_id
  });

  // 首次成功進門於交易完成後才推 LINE（推播失敗不影響開門；不看 line_auto_notify_booking）
  if (txOutcome.isFirstCheckin && typeof notifyFn === 'function') {
    try {
      await notifyFn(
        {
          booking_ref: targetRef,
          seats: txOutcome.seats,
          zone: txOutcome.zone,
          open_at: openAt,
          until,
          iron_text: ironStr,
          boards: txOutcome.boards || []
        },
        txOutcome.user
      );
    } catch (lineErr) {
      console.warn('[accessService] first check-in LINE notify failed:', lineErr.message);
    }
  }

  return out;
}
