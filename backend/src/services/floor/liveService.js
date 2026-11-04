import crypto from 'crypto';
import prisma from '../../prismaClient.js';
import { getActiveLayoutForDate } from '../seating/layoutService.js';
import { computeBill, billingStatus } from '../../../../shared/billing.js';
import { toTaipeiDateString } from '../../../../shared/time.js';

/**
 * Split booking equipment with quantity > 1 into individual 1-unit records (spec 3.3 item 1)
 */
export async function splitBoardUnits(tx = prisma, booking_ref) {
  const equipments = await tx.bookingEquipment.findMany({
    where: { booking_ref },
    include: { equipment: true }
  });

  if (!equipments.length) return [];

  // Check if any row has quantity > 1 or lacks unit_group
  const needsSplit = equipments.some(e => e.quantity > 1 || !e.unit_group);
  if (!needsSplit) {
    return equipments;
  }

  // Find booking end time for planned_end_at
  const reservations = await tx.reservation.findMany({
    where: { booking_ref, status: { not: 'cancelled' } },
    include: { session: true },
    orderBy: { session: { start_time: 'asc' } }
  });

  let plannedEndAt = null;
  if (reservations.length > 0) {
    const lastRes = reservations[reservations.length - 1];
    const dStr = typeof lastRes.session.session_date === 'string'
      ? lastRes.session.session_date.slice(0, 10)
      : lastRes.session.session_date.toISOString().slice(0, 10);
    plannedEndAt = new Date(`${dStr}T${lastRes.session.end_time}:00+08:00`);
  }

  for (const eq of equipments) {
    const unitRate = eq.equipment?.hourly_rate || (eq.rental_hours > 0 ? Math.round(eq.subtotal_price / (eq.quantity * eq.rental_hours)) : 60);

    if (eq.quantity <= 1) {
      if (!eq.unit_group) {
        await tx.bookingEquipment.update({
          where: { id: eq.id },
          data: {
            unit_group: crypto.randomUUID(),
            segment_no: 1,
            unit_rate: unitRate,
            planned_end_at: plannedEndAt
          }
        });
      }
      continue;
    }

    // Split multiple quantity into quantity individual rows
    const count = eq.quantity;
    const baseSubtotal = Math.floor(eq.subtotal_price / count);
    const remainder = eq.subtotal_price - (baseSubtotal * count);

    // Update existing row as 1st unit
    await tx.bookingEquipment.update({
      where: { id: eq.id },
      data: {
        quantity: 1,
        subtotal_price: baseSubtotal + remainder,
        unit_group: crypto.randomUUID(),
        segment_no: 1,
        unit_rate: unitRate,
        planned_end_at: plannedEndAt
      }
    });

    // Create remaining count - 1 units
    for (let i = 1; i < count; i++) {
      await tx.bookingEquipment.create({
        data: {
          booking_ref: eq.booking_ref,
          equipment_id: eq.equipment_id,
          equipment_name_snapshot: eq.equipment_name_snapshot,
          quantity: 1,
          rental_hours: eq.rental_hours,
          subtotal_price: baseSubtotal,
          covered_sessions: eq.covered_sessions,
          unit_group: crypto.randomUUID(),
          segment_no: 1,
          unit_rate: unitRate,
          planned_end_at: plannedEndAt
        }
      });
    }
  }

  return await tx.bookingEquipment.findMany({
    where: { booking_ref },
    include: { equipment: true }
  });
}

/**
 * Get live floor data for a business date (spec 5.2)
 */
export async function getLiveFloorData(dateStr = null) {
  const serverNow = new Date();
  const targetDateStr = dateStr || toTaipeiDateString(serverNow);
  const targetDate = new Date(`${targetDateStr}T00:00:00+08:00`);

  // 1. Layout
  const layout = await getActiveLayoutForDate(prisma, targetDate);

  // 2. Pricing
  const globalSetting = await prisma.globalSetting.findFirst() || {};
  const dailySetting = await prisma.dailySetting.findUnique({
    where: { date: targetDate }
  });

  const dayOfWeek = targetDate.getDay();
  const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;

  const hourlyPrice = dailySetting?.hourly_price ?? (isWeekend ? globalSetting.weekend_hourly_price ?? 150 : globalSetting.weekday_hourly_price ?? 100);
  const unlimitedPrice = dailySetting?.unlimited_price ?? (isWeekend ? globalSetting.weekend_unlimited_price ?? 800 : globalSetting.weekday_unlimited_price ?? 550);
  const allowUnlimited = dailySetting?.allow_unlimited ?? true;

  const pricing = {
    hourly: hourlyPrice,
    unlimited: unlimitedPrice,
    allow_unlimited: allowUnlimited
  };

  // 3. Sessions on date
  const sessions = await prisma.session.findMany({
    where: { session_date: targetDate },
    orderBy: { start_time: 'asc' }
  });

  // 4. Reservations on date
  const reservations = await prisma.reservation.findMany({
    where: {
      session: { session_date: targetDate },
      status: { not: 'cancelled' }
    },
    include: {
      user: true,
      session: true
    },
    orderBy: [
      { session: { start_time: 'asc' } },
      { id: 'asc' }
    ]
  });

  // Compute booked pax per session
  const sessionBookedMap = new Map();
  for (const s of sessions) {
    sessionBookedMap.set(s.id, 0);
  }
  for (const r of reservations) {
    const cur = sessionBookedMap.get(r.session_id) || 0;
    sessionBookedMap.set(r.session_id, cur + r.pax);
  }

  const sessionList = sessions.map(s => ({
    id: s.id,
    start_time: s.start_time,
    end_time: s.end_time,
    max_capacity: s.max_capacity,
    booked: sessionBookedMap.get(s.id) || 0
  }));

  // Group reservations by booking_ref
  const bookingsMap = new Map();
  for (const r of reservations) {
    if (!bookingsMap.has(r.booking_ref)) {
      bookingsMap.set(r.booking_ref, []);
    }
    bookingsMap.get(r.booking_ref).push(r);
  }

  const allBookingRefs = Array.from(bookingsMap.keys());

  // 5. Persons & Pauses
  const persons = allBookingRefs.length ? await prisma.bookingPerson.findMany({
    where: { booking_ref: { in: allBookingRefs } },
    include: { pauses: { orderBy: { started_at: 'asc' } } },
    orderBy: { person_no: 'asc' }
  }) : [];

  const personsByRef = new Map();
  for (const p of persons) {
    if (!personsByRef.has(p.booking_ref)) {
      personsByRef.set(p.booking_ref, []);
    }
    personsByRef.get(p.booking_ref).push(p);
  }

  // 6. Payments
  const payments = allBookingRefs.length ? await prisma.payment.findMany({
    where: { booking_ref: { in: allBookingRefs } },
    orderBy: { created_at: 'asc' }
  }) : [];

  const paymentsByRef = new Map();
  for (const pay of payments) {
    if (!paymentsByRef.has(pay.booking_ref)) {
      paymentsByRef.set(pay.booking_ref, []);
    }
    paymentsByRef.get(pay.booking_ref).push(pay);
  }

  // 7. Equipments
  const equipments = allBookingRefs.length ? await prisma.bookingEquipment.findMany({
    where: { booking_ref: { in: allBookingRefs } },
    include: { equipment: true },
    orderBy: [{ unit_group: 'asc' }, { segment_no: 'asc' }]
  }) : [];

  const equipmentsByRef = new Map();
  for (const eq of equipments) {
    if (!equipmentsByRef.has(eq.booking_ref)) {
      equipmentsByRef.set(eq.booking_ref, []);
    }
    equipmentsByRef.get(eq.booking_ref).push(eq);
  }

  // 8. Build bookings array
  const bookings = [];
  const alerts = [];

  for (const [bRef, resList] of bookingsMap.entries()) {
    const firstRes = resList[0];
    const lastRes = resList[resList.length - 1];
    const user = firstRes.user || {};

    const startAtStr = `${targetDateStr}T${firstRes.session.start_time}:00+08:00`;
    const endAtStr = `${targetDateStr}T${lastRes.session.end_time}:00+08:00`;
    const startDt = new Date(startAtStr);
    const endDt = new Date(endAtStr);

    const bPersons = personsByRef.get(bRef) || [];
    const bPayments = paymentsByRef.get(bRef) || [];
    const bEquipments = equipmentsByRef.get(bRef) || [];

    // Format ref_display (e.g. BK-4E1A-90C2)
    const cleanRef = bRef.replace(/^BK-/i, '');
    const refDisplay = `BK-${cleanRef.slice(0, 4).toUpperCase()}-${cleanRef.slice(-4).toUpperCase()}`;

    // Phone masked (0912***678)
    let phoneMasked = user.phone || '';
    if (phoneMasked.length >= 8) {
      phoneMasked = `${phoneMasked.slice(0, 4)}***${phoneMasked.slice(-3)}`;
    }

    // Boards grouped by unit_group
    const boardGroupMap = new Map();
    for (const eq of bEquipments) {
      const uGroup = eq.unit_group || `single-${eq.id}`;
      if (!boardGroupMap.has(uGroup)) {
        boardGroupMap.set(uGroup, {
          unit_group: eq.unit_group,
          person_no: eq.person_id ? bPersons.find(p => p.id === eq.person_id)?.person_no || null : null,
          segments: []
        });
      }
      boardGroupMap.get(uGroup).segments.push({
        equipment_id: eq.equipment_id,
        name: eq.equipment?.name || eq.equipment_name_snapshot,
        start_at: eq.start_at ? eq.start_at.toISOString() : null,
        end_at: eq.end_at ? eq.end_at.toISOString() : null,
        ended_reason: eq.ended_reason
      });
    }

    // Determine billing status and summary
    const statusObj = billingStatus({
      persons: bPersons.length ? bPersons : Array.from({ length: firstRes.pax }, (_, i) => ({ person_no: i + 1, status: 'active' })),
      payments: bPayments
    });

    const activePersons = bPersons.filter(p => p.status === 'active');
    const personsTotal = activePersons.length || firstRes.pax;

    const bookingItem = {
      booking_ref: bRef,
      ref_display: refDisplay,
      name: user.name || '現場客人',
      phone_masked: phoneMasked,
      pax: firstRes.pax,
      start_at: startAtStr,
      end_at: endAtStr,
      is_walk_in: Boolean(firstRes.is_walk_in),
      attendance: firstRes.attendance || null,
      checked_in_at: firstRes.checked_in_at ? firstRes.checked_in_at.toISOString() : null,
      checked_in_by: firstRes.checked_in_by || null,
      seat_source: firstRes.seat_source || 'auto',
      is_seat_locked: Boolean(firstRes.is_seat_locked),
      assigned_seats: firstRes.assigned_seats || [],
      billing: {
        status: statusObj.code,
        paid_persons: firstRes.paid_persons ?? 0,
        persons_total: personsTotal,
        amount_due: firstRes.amount_due ?? 0,
        amount_received: firstRes.amount_received ?? 0,
        has_refund: Boolean(firstRes.has_refund),
        pending_supplement: 0
      },
      persons: bPersons.map(p => {
        const lastPause = p.pauses?.find(pa => !pa.ended_at);
        return {
          id: p.id,
          person_no: p.person_no,
          seat_code: p.seat_code,
          status: p.status,
          paid: bPayments.some(pay => pay.status === 'valid' && (pay.kind === 'charge' || pay.kind === 'waive') && pay.person_nos?.includes(p.person_no)),
          timer: {
            billing_start_at: p.billing_start_at ? p.billing_start_at.toISOString() : null,
            timer_started_at: p.timer_started_at ? p.timer_started_at.toISOString() : null,
            timer_ended_at: p.timer_ended_at ? p.timer_ended_at.toISOString() : null,
            paused_at: p.paused_at ? p.paused_at.toISOString() : null,
            paused_seconds: p.paused_seconds || 0,
            pause_reason: lastPause?.reason || null
          }
        };
      }),
      boards: Array.from(boardGroupMap.values()),
      customer_note: firstRes.customer_note || null,
      admin_note: firstRes.admin_note || null
    };

    bookings.push(bookingItem);

    // Alerts check for checked-in and active bookings
    if (firstRes.attendance === 'checked_in') {
      const nowMs = serverNow.getTime();
      const endMs = endDt.getTime();
      const diffMins = Math.floor((nowMs - endMs) / 60000);
      const tableName = (firstRes.assigned_seats && firstRes.assigned_seats.length)
        ? firstRes.assigned_seats[0].split('-')[0]
        : '座位';

      if (diffMins > 10) {
        // Overtime alert
        alerts.push({
          type: 'overtime',
          booking_ref: bRef,
          text: `${user.name || '客人'} · 桌 ${tableName} 超時 ${diffMins} 分`,
          hint: `預約到 ${lastRes.session.end_time}，問要不要加時或結帳`
        });
      } else if (diffMins >= -30 && diffMins <= 0) {
        // 30 min before end
        alerts.push({
          type: 'warning_30m',
          booking_ref: bRef,
          text: `${user.name || '客人'} · 桌 ${tableName} 即將到時`,
          hint: `${lastRes.session.end_time} 到時，提醒預留 10 分鐘壓平作品`
        });
      }
    }
  }

  // 9. Board usage
  const equipmentConfigs = await prisma.equipmentConfig.findMany({
    where: { is_active: true }
  });

  const boardUsage = equipmentConfigs.map(c => {
    // Count currently in-use boards
    let inUse = 0;
    for (const b of bookings) {
      if (b.attendance === 'checked_in') {
        for (const bd of b.boards) {
          const currentSeg = bd.segments.find(s => !s.end_at);
          if (currentSeg && currentSeg.equipment_id === c.id) {
            inUse++;
          }
        }
      }
    }
    return {
      equipment_id: c.id,
      name: c.name,
      in_use: inUse,
      total: c.total_inventory
    };
  });

  // 10. Printer station status
  const station = await prisma.printStation.findFirst({
    where: { is_active: true, is_default: true }
  });

  let printerStatus = {
    online: false,
    state: 'not_found',
    label: '離線 · 找不到列印站'
  };

  if (station) {
    const isOnline = station.last_seen_at && (serverNow.getTime() - new Date(station.last_seen_at).getTime()) <= 75000;
    const state = isOnline ? (station.printer_state || 'ok') : 'offline';
    let label = '在線 · 正常';
    if (!isOnline) {
      label = '離線';
    } else if (state === 'no_paper') {
      label = '在線 · 缺紙';
    } else if (state === 'overheat') {
      label = '在線 · 印字頭過熱';
    } else if (state === 'cover_open') {
      label = '在線 · 上蓋開啟';
    } else if (state === 'ok') {
      label = '在線 · 紙張正常';
    } else {
      label = `在線 · ${station.printer_message || '異常'}`;
    }

    printerStatus = {
      online: Boolean(isOnline),
      state,
      label
    };
  }

  return {
    server_now: serverNow.toISOString(),
    date: targetDateStr,
    layout,
    pricing,
    sessions: sessionList,
    bookings,
    board_usage: boardUsage,
    alerts,
    printer: printerStatus
  };
}

export default {
  splitBoardUnits,
  getLiveFloorData
};
