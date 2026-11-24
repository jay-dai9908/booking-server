// backend/src/services/seating/layoutService.js
import prisma from '../../prismaClient.js';
import { resolveLayoutGeometry } from '../../../../shared/allocator/geometry.js';
import { allocate } from '../../../../shared/allocator/score.js';
import { dateOnly, toTaipeiDateString } from '../../../../shared/time.js';
import { isBookingCompleted, isPersonOnSeat, walkInBillingEndAt } from '../../../../shared/floorSelectors.js';
import { isReservationPinned, reseatBookings } from './allocator.js';

export function getLegacyFallbackLayout() {
  const zones = [
    { id: 1, name: 'A 區', note: '長桌區', sort_order: 0 },
    { id: 2, name: 'B 區', note: '四人桌區', sort_order: 1 }
  ];
  const tables = [
    { id: 101, zone_id: 1, label: 'A1', shape: 'long', arrangement: 'one_side', cx: 250, cy: 220, w: 60, h: 260, rotation: 0, sort_order: 0 },
    { id: 102, zone_id: 1, label: 'A2', shape: 'long', arrangement: 'one_side', cx: 250, cy: 460, w: 60, h: 260, rotation: 0, sort_order: 1 },
    { id: 201, zone_id: 2, label: 'B1', shape: 'rect', arrangement: 'two_sides', cx: 720, cy: 220, w: 70, h: 140, rotation: 0, sort_order: 0 },
    { id: 202, zone_id: 2, label: 'B2', shape: 'rect', arrangement: 'two_sides', cx: 720, cy: 460, w: 70, h: 140, rotation: 0, sort_order: 1 }
  ];
  const seats = [
    { id: 1, table_id: 101, zone_id: 1, code: 'A1-1', lx: -40, ly: -90, side: 'L', side_mode: 'auto', priority: 'normal', is_active: true, sort_order: 0 },
    { id: 2, table_id: 101, zone_id: 1, code: 'A1-2', lx: -40, ly: -30, side: 'L', side_mode: 'auto', priority: 'normal', is_active: true, sort_order: 1 },
    { id: 3, table_id: 101, zone_id: 1, code: 'A1-3', lx: -40, ly: 30, side: 'L', side_mode: 'auto', priority: 'normal', is_active: true, sort_order: 2 },
    { id: 4, table_id: 101, zone_id: 1, code: 'A1-4', lx: -40, ly: 90, side: 'L', side_mode: 'auto', priority: 'normal', is_active: true, sort_order: 3 },
    { id: 5, table_id: 102, zone_id: 1, code: 'A2-1', lx: -40, ly: -90, side: 'L', side_mode: 'auto', priority: 'normal', is_active: true, sort_order: 0 },
    { id: 6, table_id: 102, zone_id: 1, code: 'A2-2', lx: -40, ly: -30, side: 'L', side_mode: 'auto', priority: 'normal', is_active: true, sort_order: 1 },
    { id: 7, table_id: 102, zone_id: 1, code: 'A2-3', lx: -40, ly: 30, side: 'L', side_mode: 'auto', priority: 'normal', is_active: true, sort_order: 2 },
    { id: 8, table_id: 102, zone_id: 1, code: 'A2-4', lx: -40, ly: 90, side: 'L', side_mode: 'auto', priority: 'normal', is_active: true, sort_order: 3 },
    { id: 9, table_id: 201, zone_id: 2, code: 'B1-1', lx: -45, ly: -35, side: 'L', side_mode: 'auto', priority: 'normal', is_active: true, sort_order: 0 },
    { id: 10, table_id: 201, zone_id: 2, code: 'B1-2', lx: -45, ly: 35, side: 'L', side_mode: 'auto', priority: 'normal', is_active: true, sort_order: 1 },
    { id: 11, table_id: 201, zone_id: 2, code: 'B1-3', lx: 45, ly: -35, side: 'R', side_mode: 'auto', priority: 'normal', is_active: true, sort_order: 0 },
    { id: 12, table_id: 201, zone_id: 2, code: 'B1-4', lx: 45, ly: 35, side: 'R', side_mode: 'auto', priority: 'normal', is_active: true, sort_order: 1 },
    { id: 13, table_id: 202, zone_id: 2, code: 'B2-1', lx: -45, ly: -35, side: 'L', side_mode: 'auto', priority: 'normal', is_active: true, sort_order: 0 },
    { id: 14, table_id: 202, zone_id: 2, code: 'B2-2', lx: -45, ly: 35, side: 'L', side_mode: 'auto', priority: 'normal', is_active: true, sort_order: 1 },
    { id: 15, table_id: 202, zone_id: 2, code: 'B2-3', lx: 45, ly: -35, side: 'R', side_mode: 'auto', priority: 'normal', is_active: true, sort_order: 0 },
    { id: 16, table_id: 202, zone_id: 2, code: 'B2-4', lx: 45, ly: 35, side: 'R', side_mode: 'auto', priority: 'normal', is_active: true, sort_order: 1 },
  ];

  const layout = {
    id: 0,
    name: '傳統寫死格局',
    status: 'published',
    canvas_w: 1000,
    canvas_h: 625,
    capacity: 16,
    is_legacy: true,
    zones,
    tables,
    seats,
    rules_json: {
      spread_tables: true,
      avoid_opposite: true,
      avoid_beside: true,
      zone_mode: 'empty_tables_first'
    }
  };
  return resolveLayoutGeometry(layout);
}

/**
 * 取得特定日期生效的版面
 * @param {any} client - prisma 或 tx
 * @param {string|Date} date
 * @returns {Promise<any>}
 */
export async function getActiveLayoutForDate(client = prisma, date) {
  const targetDate = dateOnly(date);

  // Find latest published layout with effective_from <= targetDate
  const layout = await client.seatLayout.findFirst({
    where: {
      status: 'published',
      effective_from: { lte: targetDate }
    },
    orderBy: [
      { effective_from: 'desc' },
      { id: 'desc' }
    ],
    include: {
      zones: { orderBy: { sort_order: 'asc' } },
      tables: { orderBy: { sort_order: 'asc' } },
      seats: { orderBy: { sort_order: 'asc' } }
    }
  });

  if (!layout) {
    return getLegacyFallbackLayout();
  }

  return resolveLayoutGeometry(layout);
}

/**
 * 載入排位器的 Context（4.7.8）
 * @param {any} client
 * @param {string|Date} sessionDate
 * @returns {Promise<{ layout: any, rules: any, enabled: boolean }>}
 */
export async function loadAllocatorContext(client = prisma, sessionDate) {
  const globalSetting = await client.globalSetting.findFirst();
  const enabled = Boolean(globalSetting?.seat_layout_enabled);

  const activeLayout = await getActiveLayoutForDate(client, sessionDate);
  const rules = activeLayout?.rules_json || {};

  return {
    layout: activeLayout,
    rules,
    enabled
  };
}

/**
 * 計算給定時段的座位佔用狀態（Spec 5.2）
 * 某位客人的 timer_ended_at 早於某個時段的開始時間時，他的座位在那個時段算釋出
 * @param {any} client - prisma 或 tx
 * @param {number[]} sessionIds
 * @param {string} [excludeBookingRef]
 * @returns {Promise<Record<number, Record<string, string>>>} { [sessionId]: { [seatCode]: booking_ref } }
 */
export async function occupancyForSessions(client = prisma, sessionIds = [], excludeBookingRef = null) {
  if (!sessionIds.length) return {};

  const sessions = await client.session.findMany({
    where: { id: { in: sessionIds } }
  });
  const sessionMap = new Map(sessions.map(s => [s.id, s]));

  const whereClause = {
    session_id: { in: sessionIds },
    status: { not: 'cancelled' }
  };
  if (excludeBookingRef) {
    whereClause.booking_ref = { not: excludeBookingRef };
  }

  const reservations = await client.reservation.findMany({
    where: whereClause,
    include: {
      session: true
    }
  });

  const bookingRefs = [...new Set(reservations.map(r => r.booking_ref))];
  const persons = bookingRefs.length ? await client.bookingPerson.findMany({
    where: {
      booking_ref: { in: bookingRefs },
      status: 'active'
    }
  }) : [];

  const personsByBooking = new Map();
  for (const p of persons) {
    if (!personsByBooking.has(p.booking_ref)) {
      personsByBooking.set(p.booking_ref, []);
    }
    personsByBooking.get(p.booking_ref).push(p);
  }

  const occupancy = {};
  for (const sId of sessionIds) {
    occupancy[sId] = {};
  }

  for (const r of reservations) {
    const sId = r.session_id;
    const session = sessionMap.get(sId);
    if (!session || !r.assigned_seats || !Array.isArray(r.assigned_seats)) continue;

    // Determine session start DateTime
    let sessionStartDt = null;
    if (session.session_date && session.start_time) {
      const dStr = typeof session.session_date === 'string'
        ? session.session_date.slice(0, 10)
        : session.session_date.toISOString().slice(0, 10);
      sessionStartDt = new Date(`${dStr}T${session.start_time}:00+08:00`);
    }

    // Departed or completed bookings do not occupy seats
    if (r.attendance === 'completed' || isBookingCompleted(r, sessionStartDt || new Date())) {
      continue;
    }

    const bPersons = personsByBooking.get(r.booking_ref) || [];

    for (const seatCode of r.assigned_seats) {
      const p = bPersons.find(bp => bp.seat_code === seatCode);
      const isPaid = r.is_paid || r.billing_status === 'paid' || Boolean(p?.paid);
      if (!isPaid && p && p.timer_ended_at && sessionStartDt) {
        if (new Date(p.timer_ended_at) <= sessionStartDt) {
          // Already ended before this session starts -> released
          continue;
        }
      }
      occupancy[sId][seatCode] = r.booking_ref;
    }
  }

  return occupancy;
}

/**
 * Advisory lock for all seating operations on a Taipei business date.
 * STRICT LOCK ORDER across all transactions that mutate seats:
 *   1. Session rows FOR UPDATE (if any)
 *   2. lockDaySeats(tx, dateStr)
 *   3. pg_advisory_xact_lock(hashtext(booking_ref))
 * Never acquire booking_ref lock before lockDaySeats to prevent deadlocks.
 */
export async function lockDaySeats(tx, dateStr) {
  const targetDateStr = typeof dateStr === 'string' && /^\d{4}-\d{2}-\d{2}/.test(dateStr)
    ? dateStr.slice(0, 10)
    : toTaipeiDateString(dateStr);
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(3901, hashtext(${targetDateStr}))`;
  return targetDateStr;
}

/**
 * Lock all Session rows of a Taipei business date (FOR UPDATE) and then acquire lockDaySeats.
 * Enforces canonical lock order: Session -> lockDaySeats -> booking_ref.
 */
export async function lockDaySessionsAndSeats(tx, dateInput) {
  const targetDateStr = typeof dateInput === 'string' && /^\d{4}-\d{2}-\d{2}/.test(dateInput)
    ? dateInput.slice(0, 10)
    : toTaipeiDateString(dateInput);
  const sessions = await tx.$queryRaw`
    SELECT id, max_capacity, session_date, start_time, end_time
    FROM "Session"
    WHERE session_date = ${targetDateStr}::date
    ORDER BY id ASC
    FOR UPDATE
  `;
  await lockDaySeats(tx, targetDateStr);
  return { dateStr: targetDateStr, sessions };
}

function formatTaipeiHM(dt) {
  if (!dt) return '';
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Taipei',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).format(new Date(dt));
}

export async function loadActiveSeatHolds(client = prisma, sessionIds = [], { excludeBookingRef = null } = {}) {
  const numIds = [...new Set((sessionIds || []).map(Number))].filter(Number.isInteger);
  if (!numIds.length) return [];
  const where = {
    session_id: { in: numIds },
    status: 'active'
  };
  if (excludeBookingRef) {
    where.booking_ref = { not: excludeBookingRef };
  }
  return client.seatHold.findMany({ where });
}

export function seatHoldsToPinnedReservations(holds = []) {
  return (holds || []).map(h => ({
    booking_ref: `__HOLD_${h.booking_ref}__`,
    original_booking_ref: h.booking_ref,
    session_id: h.session_id,
    pax: h.pax,
    assigned_seats: Array.isArray(h.seat_codes) ? [...h.seat_codes] : [],
    status: 'confirmed',
    attendance: 'checked_in',
    is_seat_locked: true,
    seat_source: 'staff',
    is_pinned: true,
    is_seat_hold: true,
    hold_until: h.hold_until
  }));
}

async function releaseBookingSeatHolds(tx, bookingRef, now) {
  await tx.seatHold.updateMany({
    where: { booking_ref: bookingRef, status: 'active' },
    data: { status: 'released', released_at: now }
  });
}

function sameStringSet(a = [], b = []) {
  const sa = [...new Set(a.map(String))].sort();
  const sb = [...new Set(b.map(String))].sort();
  return sa.length === sb.length && sa.every((v, idx) => v === sb[idx]);
}

/**
 * Synchronize walk-in SeatHold extension records for a booking.
 * Idempotent: calling twice produces the exact same active SeatHold rows.
 */
export async function syncWalkInSeatHolds(tx, booking_ref, now = new Date()) {
  const effectiveNow = now instanceof Date ? now : new Date(now || Date.now());
  const reservations = await tx.reservation.findMany({
    where: { booking_ref, status: { not: 'cancelled' } },
    include: { session: true },
    orderBy: { session: { start_time: 'asc' } }
  });

  if (!reservations.length) {
    await releaseBookingSeatHolds(tx, booking_ref, effectiveNow);
    return { holds: [], warnings: [], seat_hold_until: null, billing_end_at: null, displaced: [] };
  }

  const firstRes = reservations[0];
  if (!firstRes.is_walk_in || firstRes.attendance !== 'checked_in' || firstRes.status !== 'confirmed') {
    await releaseBookingSeatHolds(tx, booking_ref, effectiveNow);
    return { holds: [], warnings: [], seat_hold_until: null, billing_end_at: null, displaced: [] };
  }

  const persons = await tx.bookingPerson.findMany({
    where: { booking_ref },
    orderBy: { person_no: 'asc' }
  });
  const activeSeated = persons.filter(p =>
    (p.status == null || p.status === 'active') &&
    p.left_at == null &&
    p.seat_code &&
    !String(p.seat_code).startsWith('WAIT-') &&
    p.timer_started_at != null &&
    p.billing_start_at != null
  );

  if (!activeSeated.length) {
    await releaseBookingSeatHolds(tx, booking_ref, effectiveNow);
    return { holds: [], warnings: [], seat_hold_until: null, billing_end_at: null, displaced: [] };
  }

  const lastRes = reservations[reservations.length - 1];
  const dStr = toTaipeiDateString(firstRes.session.session_date);
  const bookingStartDt = new Date(`${dStr}T${firstRes.session.start_time}:00+08:00`);
  const bookingEndDt = new Date(`${dStr}T${lastRes.session.end_time}:00+08:00`);
  const bookedMinutes = Math.max(0, Math.floor((bookingEndDt.getTime() - bookingStartDt.getTime()) / 60000));
  const minBillingStartMs = Math.min(...activeSeated.map(p => new Date(p.billing_start_at).getTime()));
  const billingEnd = walkInBillingEndAt({
    billingStartAt: new Date(minBillingStartMs),
    bookedMinutes
  });

  if (!billingEnd || billingEnd.getTime() <= bookingEndDt.getTime()) {
    await releaseBookingSeatHolds(tx, booking_ref, effectiveNow);
    return {
      holds: [],
      warnings: [],
      seat_hold_until: null,
      billing_end_at: billingEnd ? billingEnd.toISOString() : bookingEndDt.toISOString(),
      displaced: []
    };
  }

  const { sessions: daySessions } = await lockDaySessionsAndSeats(tx, dStr);
  const bookingEndMs = bookingEndDt.getTime();
  const billingEndMs = billingEnd.getTime();

  const neededSessions = daySessions.filter(s => {
    const sStartMs = new Date(`${dStr}T${s.start_time}:00+08:00`).getTime();
    return sStartMs >= bookingEndMs && sStartMs < billingEndMs;
  });

  if (!neededSessions.length) {
    await releaseBookingSeatHolds(tx, booking_ref, effectiveNow);
    return {
      holds: [],
      warnings: [],
      seat_hold_until: null,
      billing_end_at: billingEnd.toISOString(),
      displaced: []
    };
  }

  const seatCodes = [...new Set(activeSeated.map(p => String(p.seat_code)))].sort();
  const holdPax = activeSeated.length;
  const neededSessionIds = neededSessions.map(s => s.id);
  const neededIdSet = new Set(neededSessionIds);

  // Release holds on sessions no longer needed (e.g. extended into formal session or shrunk)
  await tx.seatHold.updateMany({
    where: {
      booking_ref,
      status: 'active',
      session_id: { notIn: neededSessionIds }
    },
    data: { status: 'released', released_at: effectiveNow }
  });

  const existingActive = await tx.seatHold.findMany({
    where: { booking_ref, status: 'active', session_id: { in: neededSessionIds } }
  });
  const existingBySess = new Map(existingActive.map(h => [h.session_id, h]));

  const activeHolds = [];
  for (const sess of neededSessions) {
    if (!neededIdSet.has(sess.id)) continue;
    const prev = existingBySess.get(sess.id);
    if (
      prev &&
      prev.pax === holdPax &&
      new Date(prev.hold_until).getTime() === billingEndMs &&
      sameStringSet(prev.seat_codes, seatCodes)
    ) {
      activeHolds.push(prev);
    } else if (prev) {
      const updated = await tx.seatHold.update({
        where: { id: prev.id },
        data: {
          seat_codes: seatCodes,
          pax: holdPax,
          hold_until: billingEnd
        }
      });
      activeHolds.push(updated);
    } else {
      const created = await tx.seatHold.create({
        data: {
          booking_ref,
          session_id: sess.id,
          seat_codes: seatCodes,
          pax: holdPax,
          hold_until: billingEnd,
          status: 'active'
        }
      });
      activeHolds.push(created);
    }
  }

  // Evaluate capacity warnings and seat conflicts for each needed session
  const warnings = [];
  const displaceableRefsSet = new Set();
  const holdUntilHM = formatTaipeiHM(billingEnd);

  const [daySessResvs, otherActiveHolds] = await Promise.all([
    tx.reservation.findMany({
      where: {
        session_id: { in: neededSessionIds },
        booking_ref: { not: booking_ref },
        status: 'confirmed'
      },
      include: { user: { select: { name: true } } }
    }),
    tx.seatHold.findMany({
      where: {
        session_id: { in: neededSessionIds },
        booking_ref: { not: booking_ref },
        status: 'active'
      }
    })
  ]);

  const otherHoldRefs = [...new Set(otherActiveHolds.map(h => h.booking_ref))];
  const otherHoldUsers = otherHoldRefs.length
    ? await tx.reservation.findMany({
        where: { booking_ref: { in: otherHoldRefs } },
        include: { user: { select: { name: true } } },
        distinct: ['booking_ref']
      })
    : [];
  const otherHoldUserMap = new Map(otherHoldUsers.map(r => [r.booking_ref, r.user?.name || '客人']));

  const sessResvsPersonsRefs = [...new Set(daySessResvs.map(r => r.booking_ref))];
  const sessResvsPersons = sessResvsPersonsRefs.length
    ? await tx.bookingPerson.findMany({
        where: { booking_ref: { in: sessResvsPersonsRefs }, status: 'active' }
      })
    : [];
  const personsByRef = new Map();
  for (const p of sessResvsPersons) {
    if (!personsByRef.has(p.booking_ref)) personsByRef.set(p.booking_ref, []);
    personsByRef.get(p.booking_ref).push(p);
  }

  for (const sess of neededSessions) {
    const sResvs = daySessResvs.filter(r => r.session_id === sess.id);
    const sOtherHolds = otherActiveHolds.filter(h => h.session_id === sess.id);
    const bookedPax = sResvs.reduce((sum, r) => sum + r.pax, 0);
    const otherHoldPax = sOtherHolds.reduce((sum, h) => sum + h.pax, 0);
    const available = (sess.max_capacity || 0) - bookedPax - otherHoldPax;
    const sessionLabel = `${sess.start_time}–${sess.end_time}`;

    if (available < holdPax) {
      const exceed = holdPax - Math.max(0, available);
      warnings.push({
        code: 'HOLD_OVER_CAPACITY',
        session: sessionLabel,
        exceed,
        message: `${sessionLabel} 線上名額已滿，延伸佔位超出 ${exceed} 位，請留意`
      });
    }

    for (const r of sResvs) {
      if (r.attendance === 'completed' || r.attendance === 'no_show') continue;
      const overlapSeats = seatCodes.filter(sc => (r.assigned_seats || []).includes(sc));
      if (!overlapSeats.length) continue;

      const rWithPersons = { ...r, persons: personsByRef.get(r.booking_ref) || [] };
      if (isReservationPinned(rWithPersons)) {
        for (const sc of overlapSeats) {
          const guestName = r.user?.name || '客人';
          warnings.push({
            code: 'HOLD_SEAT_PINNED',
            seat: sc,
            session: sessionLabel,
            booking_ref: r.booking_ref,
            guest_name: guestName,
            hold_until_time: holdUntilHM,
            message: `${sc} 臨時客可玩到 ${holdUntilHM}，${sess.start_time} 的 ${guestName} 也排在這個座位`
          });
        }
      } else {
        displaceableRefsSet.add(r.booking_ref);
      }
    }

    for (const oh of sOtherHolds) {
      const overlapSeats = seatCodes.filter(sc => (oh.seat_codes || []).includes(sc));
      for (const sc of overlapSeats) {
        const guestName = otherHoldUserMap.get(oh.booking_ref) || '客人';
        warnings.push({
          code: 'HOLD_SEAT_PINNED',
          seat: sc,
          session: sessionLabel,
          booking_ref: oh.booking_ref,
          guest_name: guestName,
          hold_until_time: holdUntilHM,
          message: `${sc} 臨時客可玩到 ${holdUntilHM}，${sess.start_time} 的 ${guestName} 也排在這個座位`
        });
      }
    }
  }

  let displaced = [];
  const displaceableRefs = [...displaceableRefsSet];
  if (displaceableRefs.length > 0) {
    displaced = await reseatBookings(tx, {
      bookingRefs: displaceableRefs,
      reservedSeats: seatCodes,
      sessionIds: neededSessionIds,
      primaryBookingRef: booking_ref,
      allowWaitFallback: true
    });
  }

  return {
    holds: activeHolds,
    warnings,
    seat_hold_until: billingEnd.toISOString(),
    billing_end_at: billingEnd.toISOString(),
    displaced
  };
}

/**
 * Load physical seats currently occupied by seated (checked-in, not departed) guests on a date,
 * regardless of which sessions the current reservation covers.
 * Returns { [seatCode]: { booking_ref, name, end_time } }
 */
export async function loadSeatedOccupants(client = prisma, dateStr, { excludeBookingRef = null } = {}) {
  const targetDateStr = typeof dateStr === 'string' && /^\d{4}-\d{2}-\d{2}/.test(dateStr)
    ? dateStr.slice(0, 10)
    : toTaipeiDateString(dateStr);
  const targetDate = dateOnly(targetDateStr);

  const whereRes = {
    session: { session_date: targetDate },
    status: { not: 'cancelled' },
    attendance: 'checked_in'
  };
  if (excludeBookingRef) {
    whereRes.booking_ref = { not: excludeBookingRef };
  }

  const reservations = await client.reservation.findMany({
    where: whereRes,
    include: {
      user: { select: { name: true } },
      session: { select: { start_time: true, end_time: true } }
    },
    orderBy: [{ checked_in_at: 'asc' }, { session: { start_time: 'asc' } }]
  });

  if (!reservations.length) return {};

  const bookingMetaMap = new Map();
  for (const r of reservations) {
    const existing = bookingMetaMap.get(r.booking_ref);
    if (!existing) {
      bookingMetaMap.set(r.booking_ref, {
        booking_ref: r.booking_ref,
        attendance: r.attendance,
        status: r.status,
        name: r.user?.name || '客人',
        end_time: r.session?.end_time || '',
        checked_in_at: r.checked_in_at ? new Date(r.checked_in_at).getTime() : Number.MAX_SAFE_INTEGER
      });
    } else if (r.session?.end_time && r.session.end_time > existing.end_time) {
      existing.end_time = r.session.end_time;
    }
  }

  const bookingRefs = Array.from(bookingMetaMap.keys());
  const persons = await client.bookingPerson.findMany({
    where: { booking_ref: { in: bookingRefs } },
    orderBy: { person_no: 'asc' }
  });

  const occupants = {};
  for (const p of persons) {
    const booking = bookingMetaMap.get(p.booking_ref);
    if (!booking || !isPersonOnSeat(p, booking)) continue;
    if (!occupants[p.seat_code]) {
      occupants[p.seat_code] = {
        booking_ref: booking.booking_ref,
        name: booking.name,
        end_time: booking.end_time
      };
    }
  }

  return occupants;
}

/**
 * Guard against two distinct checked-in groups occupying the same physical seat at the same time on a date.
 */
export async function assertNoSeatedCollisions(tx, dateStr) {
  const targetDateStr = typeof dateStr === 'string' && /^\d{4}-\d{2}-\d{2}/.test(dateStr)
    ? dateStr.slice(0, 10)
    : toTaipeiDateString(dateStr);
  const targetDate = dateOnly(targetDateStr);

  const reservations = await tx.reservation.findMany({
    where: {
      session: { session_date: targetDate },
      status: { not: 'cancelled' },
      attendance: 'checked_in'
    },
    select: {
      booking_ref: true,
      attendance: true,
      status: true
    }
  });
  if (!reservations.length) return;

  const bookingMap = new Map();
  for (const r of reservations) {
    if (!bookingMap.has(r.booking_ref)) {
      bookingMap.set(r.booking_ref, r);
    }
  }

  const bookingRefs = Array.from(bookingMap.keys());
  const persons = await tx.bookingPerson.findMany({
    where: { booking_ref: { in: bookingRefs } },
    select: { booking_ref: true, person_no: true, status: true, seat_code: true, timer_ended_at: true }
  });

  const seatBookingSets = new Map();
  for (const p of persons) {
    const booking = bookingMap.get(p.booking_ref);
    if (!booking || !isPersonOnSeat(p, booking)) continue;
    if (!seatBookingSets.has(p.seat_code)) {
      seatBookingSets.set(p.seat_code, new Set());
    }
    seatBookingSets.get(p.seat_code).add(p.booking_ref);
  }

  const collisions = [];
  for (const [seatCode, refs] of seatBookingSets.entries()) {
    if (refs.size > 1) {
      collisions.push(`${seatCode}`);
    }
  }

  if (collisions.length > 0) {
    throw {
      status: 409,
      code: 'SEAT_COLLISION',
      message: `座位衝突：檢測到同一座位同時有多組在座（${collisions.join('、')}）`
    };
  }
}
