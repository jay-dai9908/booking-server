// backend/src/services/seating/layoutService.js
import prisma from '../../prismaClient.js';
import { resolveLayoutGeometry } from '../../../../shared/allocator/geometry.js';
import { allocate } from '../../../../shared/allocator/score.js';
import { dateOnly } from '../../../../shared/time.js';
import { isBookingCompleted } from '../../../../shared/floorSelectors.js';

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
