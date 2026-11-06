import crypto from 'crypto';
import prisma from '../../prismaClient.js';
import { getActiveLayoutForDate } from '../seating/layoutService.js';
import { computeBill, billingStatus } from '../../../../shared/billing.js';
import { toTaipeiDateString, dateOnly } from '../../../../shared/time.js';
import { getEffectiveDailyRates } from '../../controllers/reservationController.js';

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

    let eqPlannedEndAt = null;
    if (eq.covered_sessions && eq.covered_sessions.length > 0) {
      const covIds = eq.covered_sessions.map(Number);
      const matched = reservations.filter(r => covIds.includes(r.session_id));
      if (matched.length > 0) {
        matched.sort((a, b) => a.session.start_time.localeCompare(b.session.start_time));
        const lastMatch = matched[matched.length - 1];
        const dStr = typeof lastMatch.session.session_date === 'string'
          ? lastMatch.session.session_date.slice(0, 10)
          : toTaipeiDateString(lastMatch.session.session_date);
        eqPlannedEndAt = new Date(`${dStr}T${lastMatch.session.end_time}:00+08:00`);
      } else {
        const coveredSessList = await tx.session.findMany({
          where: { id: { in: covIds } },
          orderBy: { start_time: 'asc' }
        });
        if (coveredSessList.length > 0) {
          const lastS = coveredSessList[coveredSessList.length - 1];
          const dStr = typeof lastS.session_date === 'string'
            ? lastS.session_date.slice(0, 10)
            : toTaipeiDateString(lastS.session_date);
          eqPlannedEndAt = new Date(`${dStr}T${lastS.end_time}:00+08:00`);
        }
      }
    }
    if (!eqPlannedEndAt && reservations.length > 0) {
      const lastRes = reservations[reservations.length - 1];
      const dStr = typeof lastRes.session.session_date === 'string'
        ? lastRes.session.session_date.slice(0, 10)
        : toTaipeiDateString(lastRes.session.session_date);
      eqPlannedEndAt = new Date(`${dStr}T${lastRes.session.end_time}:00+08:00`);
    }

    if (eq.quantity <= 1) {
      if (!eq.unit_group) {
        await tx.bookingEquipment.update({
          where: { id: eq.id },
          data: {
            unit_group: crypto.randomUUID(),
            segment_no: 1,
            unit_rate: unitRate,
            planned_end_at: eqPlannedEndAt
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
        planned_end_at: eqPlannedEndAt
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
          planned_end_at: eqPlannedEndAt
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
  const targetDate = dateOnly(targetDateStr);

  // 1. Layout
  const layout = await getActiveLayoutForDate(prisma, targetDate);

  // 2. Pricing
  const { hourly_price, unlimited_price, allow_unlimited } = await getEffectiveDailyRates(prisma, targetDate);
  const pricing = {
    hourly: hourly_price,
    unlimited: unlimited_price,
    allow_unlimited: allow_unlimited
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

  const seatToTableLabel = new Map();
  if (layout && layout.tables && layout.seats) {
    const tableMap = new Map(layout.tables.map(t => [t.id, t.label]));
    for (const s of layout.seats) {
      if (s.table_id && tableMap.has(s.table_id)) {
        seatToTableLabel.set(s.code, tableMap.get(s.table_id));
      }
    }
  }

  function getTableDisplay(assignedSeats = []) {
    for (const code of assignedSeats) {
      if (!code.startsWith('WAIT-') && seatToTableLabel.has(code)) {
        const label = seatToTableLabel.get(code);
        return label.startsWith('桌') ? label : `桌 ${label}`;
      }
    }
    if (assignedSeats.length > 0 && !assignedSeats[0].startsWith('WAIT-')) {
      const codePart = assignedSeats[0].split('-')[0];
      return codePart.startsWith('桌') ? codePart : `桌 ${codePart}`;
    }
    return '座位';
  }

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
      const bookedMinutes = Math.max(0, Math.floor((endDt.getTime() - startDt.getTime()) / 60000));
      const tableDisplay = getTableDisplay(firstRes.assigned_seats);

      // Only consider persons who are currently active (timer_started_at set, timer_ended_at null)
      // and not paid (neither booking nor person paid)
      const activeUnpaidPersons = bPersons.filter(p => {
        if (!p.timer_started_at || p.timer_ended_at) return false;
        if (firstRes.is_paid) return false;
        const isPaid = bPayments.some(pay =>
          pay.status === 'valid' &&
          (pay.kind === 'charge' || pay.kind === 'waive') &&
          (pay.person_nos?.includes(p.person_no) || !pay.person_nos)
        );
        return !isPaid;
      });

      if (activeUnpaidPersons.length > 0) {
        let maxDiff = -Infinity;

        for (const p of activeUnpaidPersons) {
          const startAtMs = new Date(p.billing_start_at || startDt || p.timer_started_at).getTime();
          const endAtMs = nowMs;
          let pausedMinutes = Math.floor((p.paused_seconds || 0) / 60);
          if (p.paused_at) {
            const currentlyPausedMs = Math.max(0, endAtMs - new Date(p.paused_at).getTime());
            pausedMinutes += Math.floor(currentlyPausedMs / 60000);
          }
          const rawElapsed = Math.max(0, endAtMs - startAtMs);
          const actualMinutes = Math.max(0, Math.floor(rawElapsed / 60000) - pausedMinutes);
          const diffMins = actualMinutes - bookedMinutes;

          if (diffMins > maxDiff) {
            maxDiff = diffMins;
          }
        }

        if (maxDiff > 0) {
          // Overtime alert (diff > 0)
          const alertText = `${user.name || '客人'} · ${tableDisplay} 超時 ${maxDiff} 分`;
          const alertHint = `預約到 ${lastRes.session.end_time}，問要不要加時或結帳`;
          alerts.push({
            type: 'overtime',
            booking_ref: bRef,
            title: alertText,
            subtitle: alertHint,
            text: alertText,
            hint: alertHint
          });
        } else if (maxDiff >= -30 && maxDiff <= 0) {
          // 30 min before end
          const alertText = `${user.name || '客人'} · ${tableDisplay} 即將到時`;
          const alertHint = `${lastRes.session.end_time} 到時，提醒預留 10 分鐘壓平作品`;
          alerts.push({
            type: 'warning_30m',
            booking_ref: bRef,
            title: alertText,
            subtitle: alertHint,
            text: alertText,
            hint: alertHint
          });
        }
      }
    }

    // Check if any seat does not exist in the active layout (Spec 5.1 step 6)
    const activeSeatCodes = new Set((layout?.seats || []).filter(s => s.is_active).map(s => s.code));
    const missingSeats = (firstRes.assigned_seats || []).filter(s => !s.startsWith('WAIT-') && !activeSeatCodes.has(s));
    if (missingSeats.length > 0) {
      const alertText = `座位 ${missingSeats.join('、')} 已不存在，請重新帶位`;
      const alertHint = `原座位佔用者（${user.name || '客人'} · ${bRef}）的座位已在新生效版面中刪除或停用`;
      alerts.push({
        type: 'seat_missing',
        booking_ref: bRef,
        title: alertText,
        subtitle: alertHint,
        text: alertText,
        hint: alertHint
      });
    }
  }

  // 9. Board usage
  const equipmentConfigs = await prisma.equipmentConfig.findMany({
    where: {
      visibility_status: { not: 'HIDDEN' },
      id: { not: 'bring_own' }
    }
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
      status_note: c.status_note,
      hourly_rate: c.hourly_rate,
      in_use: inUse,
      total: c.total_stock ?? 0
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
