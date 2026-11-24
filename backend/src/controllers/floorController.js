import crypto from 'crypto';
import prisma from '../prismaClient.js';
import { getLiveFloorData, splitBoardUnits } from '../services/floor/liveService.js';
import { applyCheckInRecords, resolveBillingStartAt, isPersonPaid } from '../services/floor/checkInService.js';
import { reseatBookings, assertNoSeatCollisions } from '../services/seating/allocator.js';
import {
  getActiveLayoutForDate,
  loadSeatedOccupants,
  assertNoSeatedCollisions,
  lockDaySeats,
  lockDaySessionsAndSeats,
  syncWalkInSeatHolds
} from '../services/seating/layoutService.js';
import { getAdminDeviceInfo } from '../utils/deviceParser.js';
import { log as auditLog } from '../services/audit/auditService.js';
import { refreshBillingCache, getBookingBill, saveDraft } from '../services/billing/billService.js';
import { swapBoundaryOptions, toTaipeiDateString, formatTimeHHmm } from '../../../shared/time.js';
import { formatBookingRef } from '../../../shared/receipts.js';
import { getReservationEntryPass } from '../services/kiosk/entryService.js';
import { calculateBoardTotal } from '../../../shared/boardPricing.js';
import { resolveCoveredSessions, formatCoveredSessions } from '../utils/equipmentWindow.js';
import displayBus from '../services/display/displayBus.js';

export async function getLive(req, res) {
  try {
    const dateStr = req.query.date || null;
    const rawNow = process.env.NODE_ENV === 'test' && req.query.now ? new Date(String(req.query.now)) : null;
    const serverNow = rawNow && !Number.isNaN(rawNow.getTime()) ? rawNow : new Date();
    const data = await getLiveFloorData(dateStr, serverNow);

    const { server_now, ...rest } = data;
    const jsonStr = JSON.stringify(rest);
    const etag = `"${crypto.createHash('md5').update(jsonStr).digest('hex')}"`;

    const serverNowIso = server_now || serverNow.toISOString();
    res.setHeader('X-Server-Now', serverNowIso);
    res.setHeader('Access-Control-Expose-Headers', 'X-Server-Now, ETag');
    res.setHeader('ETag', etag);

    if (req.headers['if-none-match'] === etag) {
      return res.status(304).end();
    }

    return res.json(data);
  } catch (error) {
    console.error('[getLive] Error:', error);
    return res.status(500).json({ error: '無法讀取現場狀態' });
  }
}

export async function checkIn(req, res) {
  const { booking_ref } = req.params;
  const { seats = [], board_assignments = [], start_timer = false, defer_seating = false } = req.body;
  const staffName = req.user?.name || '門市人員';
  const staffId = req.user?.id || null;
  const deviceInfo = getAdminDeviceInfo(req);

  try {
    const preRes = await prisma.reservation.findFirst({
      where: { booking_ref, status: { not: 'cancelled' } },
      include: { session: true },
      orderBy: { session: { start_time: 'asc' } }
    });
    if (!preRes) {
      return res.status(404).json({ error: '找不到此筆預約' });
    }
    const preDateStr = toTaipeiDateString(preRes.session.session_date);

    const result = await prisma.$transaction(async (tx) => {
      await lockDaySessionsAndSeats(tx, preDateStr);
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${booking_ref}))`;

      const reservations = await tx.reservation.findMany({
        where: { booking_ref, status: { not: 'cancelled' } },
        include: { session: true },
        orderBy: { session: { start_time: 'asc' } }
      });

      if (!reservations.length) {
        throw { status: 404, message: '找不到此筆預約' };
      }

      const firstRes = reservations[0];
      const pax = firstRes.pax;

      if (defer_seating) {
        await tx.reservation.updateMany({
          where: { booking_ref },
          data: {
            attendance: 'checked_in',
            checked_in_at: firstRes.checked_in_at || new Date(),
            checked_in_by: staffName
          }
        });
        return { booking_ref, deferred: true, displaced: [] };
      }

      if (seats.length > pax) {
        throw { status: 400, message: `選擇的座位數（${seats.length}）不可超過預約人數（${pax} 人）` };
      }

      // Validation: seats must not have duplicates
      const seatSet = new Set(seats);
      if (seatSet.size !== seats.length) {
        throw { status: 400, message: '選擇的座位不可重複' };
      }

      // Validation: seats must exist and be active on layout for this date
      const activeLayout = await getActiveLayoutForDate(tx, firstRes.session.session_date);
      const layoutSeats = activeLayout?.seats || [];
      for (const s of seats) {
        const found = layoutSeats.find(ls => ls.code === s);
        if (!found || !found.is_active) {
          throw { status: 400, message: `座位 ${s} 不存在或未啟用` };
        }
      }

      // Check physical seated occupants across all sessions (no auto-reseating for already-seated guests)
      const dateStr = toTaipeiDateString(firstRes.session.session_date);
      const seatedOccupants = await loadSeatedOccupants(tx, dateStr, { excludeBookingRef: booking_ref });
      for (const s of seats) {
        if (seatedOccupants[s]) {
          const occ = seatedOccupants[s];
          throw {
            status: 409,
            code: 'SEAT_OCCUPIED',
            conflict_seat: s,
            message: `${s} 還有客人（${occ.name}，預約到 ${occ.end_time}），請選其他座位或先讓上一組離場`
          };
        }
      }

      // Check conflicts for seats
      const sessionIds = reservations.map(r => r.session_id);
      const conflictReservations = await tx.reservation.findMany({
        where: {
          session_id: { in: sessionIds },
          booking_ref: { not: booking_ref },
          status: { not: 'cancelled' },
          OR: [{ attendance: null }, { attendance: { notIn: ['completed', 'no_show'] } }],
          assigned_seats: { hasSome: seats }
        },
        include: { user: true, session: true }
      });

      for (const cr of conflictReservations) {
        if (cr.is_seat_locked || cr.attendance === 'checked_in' || cr.seat_source === 'staff') {
          const conflictingSeat = cr.assigned_seats.find(s => seats.includes(s)) || seats[0];
          const crTime = cr.session?.start_time || '16:00';
          throw {
            status: 409,
            code: 'SEAT_CONFLICT',
            conflict_seat: conflictingSeat,
            conflict_time: crTime,
            message: `${conflictingSeat} 在 ${crTime} 有已鎖定的預約，請選其他座位`
          };
        }
      }

      const displacedRefs = [...new Set(conflictReservations.map(cr => cr.booking_ref))];
      const displaced = await reseatBookings(tx, {
        bookingRefs: displacedRefs,
        reservedSeats: seats,
        sessionIds,
        primaryBookingRef: booking_ref
      });

      const now = (process.env.NODE_ENV === 'test' && (req.body?.now || req.body?.at))
        ? new Date(req.body.now || req.body.at)
        : new Date();
      await applyCheckInRecords(tx, {
        booking_ref,
        reservations,
        seats,
        board_assignments,
        start_timer,
        staffName,
        seat_source: 'staff',
        is_seat_locked: true,
        now,
        touchedSessionIds: displaced?.touchedSessionIds || []
      });

      await assertNoSeatedCollisions(tx, dateStr);
      const holdRes = await syncWalkInSeatHolds(tx, booking_ref, now);
      const allDisplaced = [...displaced, ...(holdRes.displaced || [])];

      return {
        booking_ref,
        displaced: allDisplaced,
        displaced_reservations: allDisplaced.map(d => ({ ...d, new_seats: d.to })),
        warnings: holdRes.warnings || [],
        seat_hold_until: holdRes.seat_hold_until,
        billing_end_at: holdRes.billing_end_at
      };
    });

    displayBus.floorChanged();
    return res.json({
      success: true,
      server_now: new Date().toISOString(),
      ...result
    });
  } catch (error) {
    console.error('[checkIn] Error:', error);
    if (error.status) {
      return res.status(error.status).json({
        error: error.message,
        code: error.code || 'CHECK_IN_FAILED'
      });
    }
    return res.status(500).json({ error: '報到帶位失敗' });
  }
}

export async function moveSeat(req, res) {
  const { booking_ref } = req.params;
  const { from_seat, to_seat, mode = 'move' } = req.body;
  const staffName = req.user?.name || '門市人員';

  if (!from_seat || typeof from_seat !== 'string' || !from_seat.trim()) {
    return res.status(400).json({ code: 'FROM_SEAT_REQUIRED', error: '這位還沒有座位，請用「帶位」' });
  }

  try {
    const preRes = await prisma.reservation.findFirst({
      where: { booking_ref, status: { not: 'cancelled' } },
      include: { session: true },
      orderBy: { session: { start_time: 'asc' } }
    });
    if (!preRes) {
      return res.status(404).json({ error: '找不到此筆預約' });
    }
    const preDateStr = toTaipeiDateString(preRes.session.session_date);

    const moveResult = await prisma.$transaction(async (tx) => {
      await lockDaySessionsAndSeats(tx, preDateStr);
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${booking_ref}))`;

      const reservations = await tx.reservation.findMany({
        where: { booking_ref, status: { not: 'cancelled' } },
        include: { session: true }
      });
      if (!reservations.length) throw { status: 404, message: '找不到此筆預約' };

      if (!(reservations[0].assigned_seats || []).includes(from_seat)) {
        throw { status: 400, code: 'FROM_SEAT_REQUIRED', message: '這位還沒有座位，請用「帶位」' };
      }

      const sessionIds = reservations.map(r => r.session_id);
      const dateStr = toTaipeiDateString(reservations[0].session.session_date);

      // Validate to_seat exists and is active on layout (WAIT- seats bypass layout check)
      const isWaitSeat = to_seat.startsWith('WAIT-');
      if (!isWaitSeat) {
        const sessionDate = reservations[0].session.session_date;
        const activeLayout = await getActiveLayoutForDate(tx, sessionDate);
        const layoutSeats = activeLayout?.seats || [];
        const targetSeatObj = layoutSeats.find(ls => ls.code === to_seat);
        if (!targetSeatObj || !targetSeatObj.is_active) {
          throw { status: 400, message: `目標座位 ${to_seat} 不存在或未啟用` };
        }
      }

      // Check internal moves within the same booking
      const currentRes = reservations[0];
      const isInternalSeat = (currentRes.assigned_seats || []).includes(to_seat);

      if (isInternalSeat) {
        if (mode === 'swap') {
          // Internal swap between two seats of the same reservation
          const newSeats = currentRes.assigned_seats.map(s => s === from_seat ? to_seat : (s === to_seat ? from_seat : s));
          await tx.reservation.updateMany({
            where: { booking_ref },
            data: { assigned_seats: newSeats, seat_source: 'staff' }
          });
          // Swap bookingPerson seat_codes safely using a temp code
          const pFrom = await tx.bookingPerson.findFirst({ where: { booking_ref, seat_code: from_seat } });
          const pTo = await tx.bookingPerson.findFirst({ where: { booking_ref, seat_code: to_seat } });
          if (pFrom) {
            await tx.bookingPerson.update({ where: { id: pFrom.id }, data: { seat_code: '__TEMP_SWAP__' } });
          }
          if (pTo) {
            await tx.bookingPerson.update({ where: { id: pTo.id }, data: { seat_code: from_seat } });
          }
          if (pFrom) {
            await tx.bookingPerson.update({ where: { id: pFrom.id }, data: { seat_code: to_seat } });
          }
          return;
        } else {
          throw { status: 400, message: `座位 ${to_seat} 已被本筆預約的其他人員佔用` };
        }
      }

      // Check seated occupants across all sessions (swap mode handles two-way swap separately)
      if (!isWaitSeat && mode !== 'swap') {
        const seatedOccupants = await loadSeatedOccupants(tx, dateStr, { excludeBookingRef: booking_ref });
        if (seatedOccupants[to_seat]) {
          const occ = seatedOccupants[to_seat];
          throw {
            status: 409,
            code: 'SEAT_OCCUPIED',
            conflict_seat: to_seat,
            message: `${to_seat} 還有客人（${occ.name}，預約到 ${occ.end_time}），請選其他座位或先讓上一組離場`
          };
        }
      }

      // Check target occupancy across all sessions of this reservation (skip if wait seat)
      let displaced = null;
      const conflictReservations = isWaitSeat ? [] : await tx.reservation.findMany({
        where: {
          session_id: { in: sessionIds },
          booking_ref: { not: booking_ref },
          status: { not: 'cancelled' },
          assigned_seats: { has: to_seat }
        },
        include: { user: true }
      });

      if (conflictReservations.length > 0) {
        if (mode === 'swap') {
          const targetConflict = conflictReservations[0];
          // Check that target occupies to_seat in ALL sessions of its booking
          const targetAllResvs = await tx.reservation.findMany({
            where: { booking_ref: targetConflict.booking_ref, status: { not: 'cancelled' } }
          });
          const allSitToSeat = targetAllResvs.every(r => r.assigned_seats?.includes(to_seat));
          if (!allSitToSeat) {
            throw { status: 409, message: '目標座位佔用者在不同時段座位不一致，無法對調' };
          }

          // Check that from_seat is free in all target sessions
          const targetSessionIds = targetAllResvs.map(r => r.session_id);
          const fromSeatConflicts = await tx.reservation.findMany({
            where: {
              session_id: { in: targetSessionIds },
              booking_ref: { notIn: [booking_ref, targetConflict.booking_ref] },
              status: { not: 'cancelled' },
              assigned_seats: { has: from_seat }
            }
          });
          if (fromSeatConflicts.length > 0) {
            throw { status: 409, message: `對調座位的原座位 ${from_seat} 在其他時段已被佔用，無法對調` };
          }

          // Swap seats for target booking (only swap the single seat)
          const newTargetSeats = targetConflict.assigned_seats.map(s => s === to_seat ? from_seat : s);
          await tx.reservation.updateMany({
            where: { booking_ref: targetConflict.booking_ref },
            data: { assigned_seats: newTargetSeats }
          });
          // Sync target booking person seat_code
          await tx.bookingPerson.updateMany({
            where: { booking_ref: targetConflict.booking_ref, seat_code: to_seat },
            data: { seat_code: from_seat }
          });
        } else {
          for (const targetConflict of conflictReservations) {
            if (targetConflict.is_seat_locked || targetConflict.attendance === 'checked_in' || targetConflict.seat_source === 'staff') {
              throw { status: 409, message: `目標座位已被固定的預約（${targetConflict.user?.name || '客人'}）佔用` };
            }
          }

          // Displace using reseatBookings across all conflicting bookings
          const conflictRefs = [...new Set(conflictReservations.map(cr => cr.booking_ref))];
          displaced = await reseatBookings(tx, {
            bookingRefs: conflictRefs,
            reservedSeats: [to_seat],
            sessionIds,
            primaryBookingRef: booking_ref
          });
        }
      }

      // Update current booking seats
      const newSeats = currentRes.assigned_seats.map(s => s === from_seat ? to_seat : s);
      await tx.reservation.updateMany({
        where: { booking_ref },
        data: { assigned_seats: newSeats, seat_source: 'staff' }
      });

      // Update current person seat_code
      await tx.bookingPerson.updateMany({
        where: { booking_ref, seat_code: from_seat },
        data: { seat_code: to_seat }
      });

      // Assert no collisions across all touched sessions
      const allSessionsToCheck = [...new Set([...sessionIds, ...(displaced?.touchedSessionIds || [])])];
      await assertNoSeatCollisions(tx, allSessionsToCheck);
      await assertNoSeatedCollisions(tx, dateStr);
      const actionNow = (process.env.NODE_ENV === 'test' && (req.body?.now || req.body?.at))
        ? new Date(req.body.now || req.body.at)
        : new Date();
      const holdRes = await syncWalkInSeatHolds(tx, booking_ref, actionNow);
      return {
        warnings: holdRes.warnings || [],
        seat_hold_until: holdRes.seat_hold_until,
        billing_end_at: holdRes.billing_end_at
      };
    });

    displayBus.floorChanged();
    return res.json({
      success: true,
      server_now: new Date().toISOString(),
      warnings: moveResult?.warnings || [],
      seat_hold_until: moveResult?.seat_hold_until || null,
      billing_end_at: moveResult?.billing_end_at || null
    });
  } catch (error) {
    console.error('[moveSeat] Error:', error);
    if (error.status) {
      return res.status(error.status).json({
        error: error.message,
        ...(error.code ? { code: error.code } : {}),
        ...(error.conflict_seat ? { conflict_seat: error.conflict_seat } : {})
      });
    }
    return res.status(500).json({ error: '換位失敗' });
  }
}

export async function seatPerson(req, res) {
  const { booking_ref, person_no } = req.params;
  const pNo = parseInt(person_no, 10);
  const { seat_code, start_timer = true } = req.body || {};
  const staffName = req.user?.name || '門市人員';
  const staffId = req.user?.id || null;
  const deviceInfo = getAdminDeviceInfo(req);

  if (!Number.isInteger(pNo) || pNo <= 0 || !seat_code || typeof seat_code !== 'string' || !seat_code.trim()) {
    return res.status(400).json({ error: '請指定客人編號與目標座位' });
  }
  const cleanSeatCode = seat_code.trim();
  const isWaitSeat = cleanSeatCode.startsWith('WAIT-');

  try {
    const preRes = await prisma.reservation.findFirst({
      where: { booking_ref, status: { not: 'cancelled' } },
      include: { session: true },
      orderBy: { session: { start_time: 'asc' } }
    });
    if (!preRes) {
      return res.status(404).json({ error: '找不到此筆預約' });
    }
    const dateStr = toTaipeiDateString(preRes.session.session_date);

    const result = await prisma.$transaction(async (tx) => {
      await lockDaySessionsAndSeats(tx, dateStr);
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${booking_ref}))`;

      const reservations = await tx.reservation.findMany({
        where: { booking_ref, status: { not: 'cancelled' } },
        include: { session: true },
        orderBy: { session: { start_time: 'asc' } }
      });
      if (!reservations.length) throw { status: 404, message: '找不到此筆預約' };

      const firstRes = reservations[0];
      if (firstRes.attendance !== 'checked_in') {
        throw { status: 409, message: '請先報到' };
      }

      const person = await tx.bookingPerson.findFirst({
        where: { booking_ref, person_no: pNo }
      });
      if (!person || person.status !== 'active') {
        throw { status: 409, code: 'PERSON_REMOVED', message: `第 ${pNo} 位不存在或已移除` };
      }
      if (person.seat_code && !String(person.seat_code).startsWith('WAIT-')) {
        throw { status: 409, code: 'ALREADY_SEATED', message: `第 ${pNo} 位已經有座位 ${person.seat_code}` };
      }

      const sessionIds = reservations.map(r => r.session_id);
      let displaced = null;

      if (!isWaitSeat) {
        const activeLayout = await getActiveLayoutForDate(tx, firstRes.session.session_date);
        const targetSeatObj = (activeLayout?.seats || []).find(ls => ls.code === cleanSeatCode);
        if (!targetSeatObj || !targetSeatObj.is_active) {
          throw { status: 400, message: `座位 ${cleanSeatCode} 不存在或未啟用` };
        }

        const otherSeated = await tx.bookingPerson.findFirst({
          where: {
            booking_ref,
            status: 'active',
            person_no: { not: pNo },
            seat_code: cleanSeatCode
          }
        });
        if (otherSeated || (firstRes.assigned_seats || []).includes(cleanSeatCode)) {
          throw { status: 400, message: `座位 ${cleanSeatCode} 已被本筆預約的其他人員佔用` };
        }

        const seatedOccupants = await loadSeatedOccupants(tx, dateStr, { excludeBookingRef: booking_ref });
        if (seatedOccupants[cleanSeatCode]) {
          const occ = seatedOccupants[cleanSeatCode];
          throw {
            status: 409,
            code: 'SEAT_OCCUPIED',
            conflict_seat: cleanSeatCode,
            message: `${cleanSeatCode} 還有客人（${occ.name}，預約到 ${occ.end_time}），請選其他座位或先讓上一組離場`
          };
        }

        const conflictReservations = await tx.reservation.findMany({
          where: {
            session_id: { in: sessionIds },
            booking_ref: { not: booking_ref },
            status: { not: 'cancelled' },
            OR: [{ attendance: null }, { attendance: { notIn: ['completed', 'no_show'] } }],
            assigned_seats: { has: cleanSeatCode }
          },
          include: { user: true, session: true }
        });

        for (const cr of conflictReservations) {
          if (cr.is_seat_locked || cr.attendance === 'checked_in' || cr.seat_source === 'staff') {
            const crTime = cr.session?.start_time || '';
            throw {
              status: 409,
              code: 'SEAT_CONFLICT',
              conflict_seat: cleanSeatCode,
              conflict_time: crTime,
              message: `${cleanSeatCode} 在 ${crTime} 有已鎖定的預約，請選其他座位`
            };
          }
        }

        const conflictRefs = [...new Set(conflictReservations.map(cr => cr.booking_ref))];
        displaced = await reseatBookings(tx, {
          bookingRefs: conflictRefs,
          reservedSeats: [cleanSeatCode],
          sessionIds,
          primaryBookingRef: booking_ref
        });
      }

      const now = (process.env.NODE_ENV === 'test' && (req.body?.now || req.body?.at))
        ? new Date(req.body.now || req.body.at)
        : new Date();

      const personPaid = await isPersonPaid(tx, booking_ref, pNo, firstRes);

      const personUpdate = { seat_code: cleanSeatCode };
      if (start_timer && !personPaid) {
        if (!person.timer_started_at) {
          personUpdate.timer_started_at = now;
        }
        if (!person.billing_start_at) {
          personUpdate.billing_start_at = resolveBillingStartAt(firstRes, now);
        }
      }

      const updatedPerson = await tx.bookingPerson.update({
        where: { id: person.id },
        data: personUpdate
      });

      const currentSeats = Array.isArray(firstRes.assigned_seats) ? [...firstRes.assigned_seats] : [];
      if (person.seat_code && String(person.seat_code).startsWith('WAIT-')) {
        const wIdx = currentSeats.indexOf(person.seat_code);
        if (wIdx >= 0) currentSeats[wIdx] = cleanSeatCode;
        else currentSeats.push(cleanSeatCode);
      } else if (!currentSeats.includes(cleanSeatCode)) {
        currentSeats.push(cleanSeatCode);
      }

      await tx.reservation.updateMany({
        where: { booking_ref },
        data: {
          assigned_seats: currentSeats,
          seat_source: 'staff',
          is_seat_locked: true
        }
      });

      await auditLog(tx, {
        booking_ref,
        event_type: 'seats_changed',
        category: 'seating',
        summary: `第 ${pNo} 位帶位至 ${cleanSeatCode}`,
        reason: '分批帶位',
        staff_name: staffName,
        staff_id: staffId,
        device_id: deviceInfo?.device_id || null,
        device_label: deviceInfo?.device_label || null
      });

      const allSessionsToCheck = [...new Set([...sessionIds, ...(displaced?.touchedSessionIds || [])])];
      await assertNoSeatCollisions(tx, allSessionsToCheck);
      await assertNoSeatedCollisions(tx, dateStr);
      const holdRes = await syncWalkInSeatHolds(tx, booking_ref, now);

      return { updatedPerson, holdRes };
    });

    displayBus.floorChanged();
    return res.json({
      success: true,
      person: result.updatedPerson,
      warnings: result.holdRes?.warnings || [],
      seat_hold_until: result.holdRes?.seat_hold_until || null,
      billing_end_at: result.holdRes?.billing_end_at || null,
      server_now: new Date().toISOString()
    });
  } catch (error) {
    console.error('[seatPerson] Error:', error);
    if (error.status) {
      return res.status(error.status).json({
        error: error.message,
        ...(error.code ? { code: error.code } : {}),
        ...(error.conflict_seat ? { conflict_seat: error.conflict_seat } : {})
      });
    }
    return res.status(500).json({ error: '帶位失敗' });
  }
}

export async function moveGroup(req, res) {
  const { booking_ref } = req.params;
  const { to_table_id, to_seats } = req.body;
  const staffName = req.user?.name || '門市人員';
  const staffId = req.user?.id || null;
  const deviceInfo = getAdminDeviceInfo(req);

  try {
    const targetTableId = parseInt(to_table_id, 10);
    if (!targetTableId || isNaN(targetTableId)) {
      return res.status(400).json({ error: '請指定目標桌' });
    }

    const preRes = await prisma.reservation.findFirst({
      where: { booking_ref, status: { not: 'cancelled' } },
      include: { session: true },
      orderBy: { session: { start_time: 'asc' } }
    });
    if (!preRes) {
      return res.status(404).json({ error: '找不到此筆預約' });
    }
    const preDateStr = toTaipeiDateString(preRes.session.session_date);

    let result = null;
    const moveResult = await prisma.$transaction(async (tx) => {
      await lockDaySessionsAndSeats(tx, preDateStr);
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${booking_ref}))`;

      const reservations = await tx.reservation.findMany({
        where: { booking_ref, status: { not: 'cancelled' } },
        include: { session: true }
      });
      if (!reservations.length) throw { status: 404, message: '找不到此筆預約' };

      const sessionIds = reservations.map(r => r.session_id);
      const sessionDate = reservations[0].session.session_date;
      const dateStr = toTaipeiDateString(sessionDate);
      const seatedOccupants = await loadSeatedOccupants(tx, dateStr, { excludeBookingRef: booking_ref });

      const activeLayout = await getActiveLayoutForDate(tx, sessionDate);
      const targetTable = (activeLayout?.tables || []).find(t => t.id === targetTableId);
      if (!targetTable) throw { status: 404, message: '目標桌不存在' };

      // All seats at this table and active seats sorted naturally
      const allTargetSeats = (activeLayout?.seats || []).filter(s => s.table_id === targetTableId);
      const targetSeatByCode = new Map(allTargetSeats.map(s => [s.code, s]));
      const targetSeats = allTargetSeats.filter(s => s.is_active);
      targetSeats.sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0) || a.code.localeCompare(b.code));

      // Find seats occupied across this booking's sessionIds by other active or un-checked-in bookings
      const conflictReservations = await tx.reservation.findMany({
        where: {
          session_id: { in: sessionIds },
          booking_ref: { not: booking_ref },
          status: { not: 'cancelled' },
          OR: [
            { attendance: null },
            { attendance: { not: 'completed' } }
          ]
        },
        select: { assigned_seats: true }
      });

      const occupiedSeatCodes = new Set();
      for (const cr of conflictReservations) {
        for (const s of cr.assigned_seats || []) {
          occupiedSeatCodes.add(s);
        }
      }
      for (const s of Object.keys(seatedOccupants)) {
        occupiedSeatCodes.add(s);
      }

      const availableTargetSeats = targetSeats.filter(s => !occupiedSeatCodes.has(s.code));

      // Determine active persons in this group
      const persons = await tx.bookingPerson.findMany({
        where: { booking_ref, status: 'active' },
        orderBy: { person_no: 'asc' }
      });

      const currentRes = reservations[0];
      const countNeeded = persons.length > 0 ? persons.length : ((currentRes.assigned_seats || []).length || currentRes.pax);

      let newSeats;
      if (to_seats !== undefined && to_seats !== null) {
        if (!Array.isArray(to_seats)) {
          throw { status: 422, message: '目標座位格式錯誤' };
        }
        const seenSeats = new Set();
        for (const code of to_seats) {
          if (typeof code !== 'string' || !code.trim()) {
            throw { status: 422, message: `無效的座位代碼：${code}` };
          }
          if (seenSeats.has(code)) {
            throw { status: 422, message: `目標座位 ${code} 重複指定` };
          }
          seenSeats.add(code);

          const seatObj = targetSeatByCode.get(code);
          if (!seatObj) {
            throw { status: 422, message: `座位 ${code} 不屬於目標桌「${targetTable.label}」` };
          }
          if (!seatObj.is_active) {
            throw { status: 422, message: `座位 ${code} 目前未啟用` };
          }
          if (seatedOccupants[code]) {
            const occ = seatedOccupants[code];
            throw {
              status: 409,
              code: 'SEAT_OCCUPIED',
              conflict_seat: code,
              message: `${code} 還有客人（${occ.name}，預約到 ${occ.end_time}），請選其他座位或先讓上一組離場`
            };
          }
          if (occupiedSeatCodes.has(code)) {
            throw { status: 422, message: `座位 ${code} 已被其他訂單佔用` };
          }
        }
        if (to_seats.length !== countNeeded) {
          throw { status: 422, message: `指定座位數量（${to_seats.length}）與這組人數（${countNeeded}）不符` };
        }
        newSeats = [...to_seats];
      } else {
        if (availableTargetSeats.length < countNeeded) {
          throw { status: 422, message: `這桌只剩 ${availableTargetSeats.length} 個空位` };
        }
        // Assign in order
        newSeats = availableTargetSeats.slice(0, countNeeded).map(s => s.code);
      }

      // Update reservation.assigned_seats
      await tx.reservation.updateMany({
        where: { booking_ref },
        data: { assigned_seats: newSeats, seat_source: 'staff' }
      });

      // Update each person's seat_code while keeping timer intact
      for (let i = 0; i < persons.length; i++) {
        const p = persons[i];
        const newCode = newSeats[i];
        if (p.seat_code !== newCode) {
          await tx.bookingPerson.update({
            where: { id: p.id },
            data: { seat_code: newCode }
          });
        }
      }

      // Write audit log
      await auditLog(tx, {
        booking_ref,
        event_type: 'seats_changed',
        category: 'seating',
        summary: `整組換桌至 ${targetTable.label} (${newSeats.join(', ')})`,
        reason: '整組換桌',
        staff_name: staffName,
        staff_id: staffId,
        device_id: deviceInfo?.device_id || null,
        device_label: deviceInfo?.device_label || null
      });

      // Assert no collisions
      await assertNoSeatCollisions(tx, sessionIds);
      await assertNoSeatedCollisions(tx, dateStr);
      const actionNow = (process.env.NODE_ENV === 'test' && (req.body?.now || req.body?.at))
        ? new Date(req.body.now || req.body.at)
        : new Date();
      const holdRes = await syncWalkInSeatHolds(tx, booking_ref, actionNow);

      result = {
        success: true,
        new_seats: newSeats,
        table_label: targetTable.label,
        warnings: holdRes.warnings || [],
        seat_hold_until: holdRes.seat_hold_until || null,
        billing_end_at: holdRes.billing_end_at || null,
        server_now: new Date().toISOString()
      };
    });

    displayBus.floorChanged();
    return res.json(result);
  } catch (error) {
    console.error('[moveGroup] Error:', error);
    if (error.status) {
      return res.status(error.status).json({
        error: error.message,
        message: error.message,
        ...(error.code ? { code: error.code } : {}),
        ...(error.conflict_seat ? { conflict_seat: error.conflict_seat } : {})
      });
    }
    return res.status(500).json({ error: '整組換桌失敗' });
  }
}

export const TIMER_ACTION_WHITELIST = ['pause', 'resume', 'end', 'restart', 'start', 'undo_leave_all'];

async function closeOpenPersonPausesTx(tx, person, closeAtDt) {
  const openPauses = (person.pauses || []).filter((pa) => !pa.ended_at);
  let pauseDurationSec = 0;
  if (openPauses.length > 0) {
    const earliestStartMs = Math.min(...openPauses.map((pa) => new Date(pa.started_at).getTime()));
    pauseDurationSec = Math.max(0, Math.floor((closeAtDt.getTime() - earliestStartMs) / 1000));
    await tx.timerPause.updateMany({
      where: { person_id: person.id, ended_at: null },
      data: { ended_at: closeAtDt }
    });
  }
  return pauseDurationSec;
}

export async function handleTimer(req, res) {
  const { booking_ref } = req.params;
  const { action, person_nos = 'all', reason } = req.body;
  const staffName = req.user?.name || '門市人員';
  const staffId = req.user?.id || null;
  const deviceInfo = getAdminDeviceInfo(req);

  if (!TIMER_ACTION_WHITELIST.includes(action)) {
    return res.status(400).json({ error: '不認得的計時動作', code: 'UNKNOWN_TIMER_ACTION' });
  }

  try {
    let preDateStr = null;
    if (['undo_leave_all', 'end', 'start', 'restart'].includes(action)) {
      const preRes = await prisma.reservation.findFirst({
        where: { booking_ref, status: { not: 'cancelled' } },
        include: { session: true },
        orderBy: { session: { start_time: 'asc' } }
      });
      if (!preRes) {
        return res.status(404).json({ error: '找不到此筆預約' });
      }
      preDateStr = toTaipeiDateString(preRes.session.session_date);
    }

    const timerResult = await prisma.$transaction(async (tx) => {
      if (['undo_leave_all', 'end', 'start', 'restart'].includes(action)) {
        await lockDaySessionsAndSeats(tx, preDateStr);
      }
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${booking_ref}))`;

      const now = (process.env.NODE_ENV === 'test' && (req.body?.now || req.body?.at))
        ? new Date(req.body.now || req.body.at)
        : new Date();

      if (action === 'undo_leave_all') {
        const reservations = await tx.reservation.findMany({
          where: { booking_ref, status: { not: 'cancelled' } },
          include: { session: true },
          orderBy: { session: { start_time: 'asc' } }
        });
        if (!reservations.length) {
          throw { status: 404, message: '找不到此筆預約' };
        }
        const firstRes = reservations[0];
        const bookingDateStr = toTaipeiDateString(firstRes.session.session_date);
        const todayStr = toTaipeiDateString(now);
        if (bookingDateStr !== todayStr) {
          throw { status: 409, code: 'NOT_TODAY', message: '只能取消當天的全組離場' };
        }
        if (firstRes.attendance !== 'completed') {
          throw { status: 409, code: 'NOT_COMPLETED', message: '這組目前不是已離場狀態' };
        }
        const validPayCount = await tx.payment.count({
          where: { booking_ref, status: 'valid', kind: { in: ['charge', 'waive'] } }
        });
        if (validPayCount > 0) {
          throw { status: 409, code: 'ALREADY_PAID', message: '這組已有收款或免收紀錄，不能取消全組離場' };
        }

        const activePersons = await tx.bookingPerson.findMany({
          where: { booking_ref, status: 'active' },
          orderBy: { person_no: 'asc' }
        });
        const [lastGroupLeft, lastUndone] = await Promise.all([
          tx.accountingEvent.findFirst({
            where: { booking_ref, event_type: 'group_left' },
            orderBy: { id: 'desc' }
          }),
          tx.accountingEvent.findFirst({
            where: { booking_ref, event_type: 'group_leave_undone' },
            orderBy: { id: 'desc' }
          })
        ]);

        let restorePersonNos = [];
        if (lastGroupLeft) {
          const alreadyUndone = Boolean(
            lastUndone && (
              lastUndone.id > lastGroupLeft.id ||
              lastUndone.after_json?.group_left_id === lastGroupLeft.id
            )
          );
          if (alreadyUndone) {
            throw { status: 409, code: 'ALREADY_UNDONE', message: '已經復原過這一次全組離場' };
          }
          const rawNos = Array.isArray(lastGroupLeft.after_json?.person_nos) ? lastGroupLeft.after_json.person_nos : [];
          const activeSet = new Set(activePersons.map(ap => ap.person_no));
          restorePersonNos = rawNos.map(Number).filter(n => activeSet.has(n));
        } else {
          if (lastUndone) {
            throw { status: 409, code: 'ALREADY_UNDONE', message: '已經復原過這一次全組離場' };
          }
          const endedPersons = activePersons.filter(ap => ap.timer_ended_at != null);
          if (endedPersons.length > 0) {
            const maxSec = Math.max(...endedPersons.map(ap => Math.floor(new Date(ap.timer_ended_at).getTime() / 1000)));
            restorePersonNos = endedPersons
              .filter(ap => Math.floor(new Date(ap.timer_ended_at).getTime() / 1000) === maxSec)
              .map(ap => ap.person_no);
          }
        }

        if (restorePersonNos.length === 0) {
          throw { status: 409, code: 'NOTHING_TO_UNDO', message: '找不到可復原的離場人員' };
        }

        const seatsToRestore = activePersons
          .filter(ap => restorePersonNos.includes(ap.person_no) && ap.seat_code && !String(ap.seat_code).startsWith('WAIT-'))
          .map(ap => ap.seat_code);
        if (seatsToRestore.length > 0) {
          const occupied = await loadSeatedOccupants(tx, bookingDateStr, { excludeBookingRef: booking_ref });
          const conflictSeats = [...new Set(seatsToRestore.filter(sc => Boolean(occupied[sc])))];
          if (conflictSeats.length > 0) {
            throw {
              status: 409,
              code: 'SEAT_OCCUPIED',
              conflicts: conflictSeats,
              message: `座位 ${conflictSeats.join('、')} 已被其他組使用，無法取消全組離場`
            };
          }
        }

        await tx.bookingPerson.updateMany({
          where: { booking_ref, person_no: { in: restorePersonNos }, status: 'active' },
          data: { timer_ended_at: null, left_at: null }
        });
        await tx.reservation.updateMany({
          where: { booking_ref, status: { not: 'cancelled' } },
          data: { attendance: 'checked_in' }
        });
        await auditLog(tx, {
          booking_ref,
          event_type: 'group_leave_undone',
          category: 'seating',
          summary: `取消全組離場（第 ${restorePersonNos.join('、')} 位回到計時）`,
          after_json: {
            group_left_id: lastGroupLeft?.id || null,
            person_nos: restorePersonNos,
            at: now.toISOString()
          },
          staff_name: staffName,
          staff_id: staffId,
          device_id: deviceInfo?.device_id || null,
          device_label: deviceInfo?.device_label || null
        });
        await refreshBillingCache(tx, booking_ref);
        const holdRes = await syncWalkInSeatHolds(tx, booking_ref, now);
        return { holdRes };
      }

      let persons;
      if (person_nos !== 'all' && Array.isArray(person_nos)) {
        const reqNos = person_nos.map(Number);
        const targetRows = await tx.bookingPerson.findMany({
          where: { booking_ref, person_no: { in: reqNos } },
          include: { pauses: true }
        });
        for (const no of reqNos) {
          const found = targetRows.find(r => r.person_no === no);
          if (!found || found.status !== 'active') {
            throw { status: 409, code: 'PERSON_REMOVED', message: `第 ${no} 位已移除，不能再操作計時` };
          }
        }
        persons = targetRows;
      } else {
        persons = await tx.bookingPerson.findMany({
          where: { booking_ref, status: 'active' },
          include: { pauses: true }
        });
      }

      let firstResForStart = null;
      if (action === 'start') {
        firstResForStart = await tx.reservation.findFirst({
          where: { booking_ref, status: { not: 'cancelled' } },
          include: { session: true },
          orderBy: { session: { start_time: 'asc' } }
        });
        if (!firstResForStart || firstResForStart.attendance !== 'checked_in') {
          throw { status: 409, message: '請先報到' };
        }
      }

      const startedPersonNos = [];
      let affectedCount = 0;
      for (const p of persons) {
        if (action === 'pause') {
          if (p.status === 'active' && p.timer_started_at && !p.timer_ended_at && !p.paused_at) {
            affectedCount++;
            await tx.timerPause.create({
              data: {
                person_id: p.id,
                started_at: now,
                reason: reason ? String(reason).trim() : '外出用餐',
                staff_name: staffName
              }
            });
            await tx.bookingPerson.update({
              where: { id: p.id },
              data: { paused_at: now }
            });
            const pBoards = await tx.bookingEquipment.findMany({
              where: { booking_ref, person_id: p.id, end_at: null, unit_group: { not: null } },
              select: { unit_group: true }
            });
            const uGroups = [...new Set(pBoards.map(b => b.unit_group).filter(Boolean))];
            for (const ug of uGroups) {
              const openBp = await tx.boardPause.findFirst({
                where: { unit_group: ug, ended_at: null }
              });
              if (!openBp) {
                await tx.boardPause.create({
                  data: {
                    unit_group: ug,
                    started_at: now,
                    source: 'person',
                    staff_name: staffName
                  }
                });
              }
            }
          }
        } else if (action === 'resume') {
          if (p.status === 'active' && p.paused_at && !p.timer_ended_at) {
            affectedCount++;
            const pauseDurationSec = await closeOpenPersonPausesTx(tx, p, now);
            await tx.bookingPerson.update({
              where: { id: p.id },
              data: {
                paused_at: null,
                paused_seconds: (p.paused_seconds || 0) + pauseDurationSec
              }
            });
            const pBoards = await tx.bookingEquipment.findMany({
              where: { booking_ref, person_id: p.id, end_at: null, unit_group: { not: null } },
              select: { unit_group: true }
            });
            const uGroups = [...new Set(pBoards.map(b => b.unit_group).filter(Boolean))];
            if (uGroups.length > 0) {
              await tx.boardPause.updateMany({
                where: { unit_group: { in: uGroups }, ended_at: null, source: 'person' },
                data: { ended_at: now }
              });
            }
          }
        } else if (action === 'end') {
          if (p.timer_ended_at) {
            // Already has timer_ended_at (departed OR paid): never overwrite timer_ended_at; record left_at if missing
            const origEndDt = new Date(p.timer_ended_at);
            const openPauses = (p.pauses || []).filter(pa => !pa.ended_at);
            const pauseExtraSec = (openPauses.length > 0 || p.paused_at)
              ? await closeOpenPersonPausesTx(tx, p, origEndDt)
              : 0;
            if (!p.left_at || pauseExtraSec > 0 || p.paused_at) {
              await tx.bookingPerson.update({
                where: { id: p.id },
                data: {
                  ...(p.left_at ? {} : { left_at: now }),
                  ...((pauseExtraSec > 0 || p.paused_at) ? {
                    paused_at: null,
                    paused_seconds: (p.paused_seconds || 0) + pauseExtraSec
                  } : {})
                }
              });
            }
          } else {
            // Not yet departed: close all open pauses (if any) and set timer_ended_at + left_at = now
            const openPauses = (p.pauses || []).filter(pa => !pa.ended_at);
            if (p.paused_at || openPauses.length > 0) {
              const pauseDurationSec = await closeOpenPersonPausesTx(tx, p, now);
              await tx.bookingPerson.update({
                where: { id: p.id },
                data: {
                  paused_at: null,
                  paused_seconds: (p.paused_seconds || 0) + pauseDurationSec,
                  timer_ended_at: now,
                  left_at: now
                }
              });
            } else {
              await tx.bookingPerson.update({
                where: { id: p.id },
                data: { timer_ended_at: now, left_at: now }
              });
            }
          }
          {
            const pBoards = await tx.bookingEquipment.findMany({
              where: { booking_ref, person_id: p.id, unit_group: { not: null } },
              select: { unit_group: true, end_at: true, ended_reason: true, added_after_payment: true }
            });
            const uGroups = [...new Set(pBoards.map(b => b.unit_group).filter(Boolean))];
            if (uGroups.length > 0) {
              await tx.boardPause.updateMany({
                where: { unit_group: { in: uGroups }, ended_at: null },
                data: { ended_at: now }
              });
            }
            const unreturnedAfterPayUgs = [...new Set(
              pBoards
                .filter(b => b.added_after_payment === true && !b.end_at && !b.ended_reason)
                .map(b => b.unit_group)
                .filter(Boolean)
            )];
            for (const ug of unreturnedAfterPayUgs) {
              const ret = await applyReturnBoardTx(tx, {
                booking_ref,
                unit_group: ug,
                at: null,
                now
              });
              await computeAfterPaymentBoardFee(tx, booking_ref, ug, ret.actionDt, {
                staffName,
                staffId,
                deviceInfo
              });
            }
          }
        } else if (action === 'start') {
          if (p.status === 'active' && !p.timer_started_at && !p.timer_ended_at) {
            const paid = await isPersonPaid(tx, booking_ref, p.person_no, firstResForStart);
            if (!paid) {
              affectedCount++;
              startedPersonNos.push(p.person_no);
              const startUpdate = { timer_started_at: now };
              if (!p.billing_start_at) {
                startUpdate.billing_start_at = resolveBillingStartAt(firstResForStart, now);
              }
              await tx.bookingPerson.update({
                where: { id: p.id },
                data: startUpdate
              });
            }
          }
        } else if (action === 'restart') {
          // Spec 2.2 item 1: 只限當天而且還沒付款
          const firstRes = await tx.reservation.findFirst({
            where: { booking_ref },
            include: { session: true }
          });
          const todayTaipeiStr = toTaipeiDateString(now);
          const resvDateStr = firstRes?.session?.session_date
            ? toTaipeiDateString(firstRes.session.session_date)
            : todayTaipeiStr;

          if (resvDateStr === todayTaipeiStr) {
            const isBookingPaid =
              firstRes?.is_paid === true ||
              firstRes?.billing_status === 'paid' ||
              firstRes?.billing_status === 'waived';

            const personPaid = isBookingPaid || Boolean(await tx.payment.findFirst({
              where: {
                booking_ref,
                status: 'valid',
                kind: { in: ['charge', 'waive'] },
                OR: [
                  { person_nos: { has: p.person_no } },
                  { person_nos: { equals: [] } }
                ]
              }
            }));

            if (!personPaid) {
              await tx.bookingPerson.update({
                where: { id: p.id },
                data: { timer_ended_at: null, left_at: null }
              });
            } else if (p.left_at) {
              await tx.bookingPerson.update({
                where: { id: p.id },
                data: { left_at: null }
              });
            }
          }
        }
      }

      if (action === 'pause' && affectedCount === 0) {
        throw { status: 409, code: 'NOTHING_TO_PAUSE', message: '這幾位沒有正在計時的人' };
      }
      if (action === 'resume' && affectedCount === 0) {
        throw { status: 409, code: 'NOTHING_TO_RESUME', message: '這幾位沒有正在計時的人' };
      }
      if (action === 'start') {
        if (startedPersonNos.length === 0) {
          throw { status: 409, code: 'NOTHING_TO_START', message: '這幾位已經在計時或已付款' };
        }
        await auditLog(tx, {
          booking_ref,
          event_type: 'timer_started',
          category: 'seating',
          summary: `第 ${startedPersonNos.join('、')} 位開始計時`,
          staff_name: staffName,
          staff_id: staffId,
          device_id: deviceInfo?.device_id || null,
          device_label: deviceInfo?.device_label || null
        });
      }

      if (action === 'end') {
        if (person_nos === 'all') {
          const endedNowPersonNos = persons
            .filter(p => p.status === 'active' && !p.timer_ended_at)
            .map(p => p.person_no)
            .sort((a, b) => a - b);
          const allBoards = await tx.bookingEquipment.findMany({
            where: { booking_ref, unit_group: { not: null } },
            select: { unit_group: true }
          });
          const allUgs = [...new Set(allBoards.map(b => b.unit_group).filter(Boolean))];
          if (allUgs.length > 0) {
            await tx.boardPause.updateMany({
              where: { unit_group: { in: allUgs }, ended_at: null },
              data: { ended_at: now }
            });
          }
          await tx.bookingPerson.updateMany({
            where: { booking_ref, timer_ended_at: null },
            data: { timer_ended_at: now }
          });
          await tx.bookingPerson.updateMany({
            where: { booking_ref, left_at: null },
            data: { left_at: now }
          });
          await tx.reservation.updateMany({
            where: { booking_ref },
            data: { attendance: 'completed' }
          });
          await auditLog(tx, {
            booking_ref,
            event_type: 'group_left',
            category: 'seating',
            summary: endedNowPersonNos.length > 0
              ? `全組離場（第 ${endedNowPersonNos.join('、')} 位）`
              : '全組離場',
            after_json: {
              person_nos: endedNowPersonNos,
              at: now.toISOString()
            },
            staff_name: staffName,
            staff_id: staffId,
            device_id: deviceInfo?.device_id || null,
            device_label: deviceInfo?.device_label || null
          });
        } else {
          const remainingStillSeated = await tx.bookingPerson.count({
            where: {
              booking_ref,
              left_at: null,
              status: 'active'
            }
          });
          if (remainingStillSeated === 0) {
            await tx.reservation.updateMany({
              where: { booking_ref },
              data: { attendance: 'completed' }
            });
          }
        }
      } else if (action === 'restart') {
        const hasSeatedPerson = await tx.bookingPerson.findFirst({
          where: {
            booking_ref,
            left_at: null,
            status: 'active'
          }
        });
        if (hasSeatedPerson) {
          await tx.reservation.updateMany({
            where: { booking_ref, attendance: 'completed' },
            data: { attendance: 'checked_in' }
          });
        }
      }

      if (['end', 'start', 'restart'].includes(action)) {
        const holdRes = await syncWalkInSeatHolds(tx, booking_ref, now);
        return { holdRes };
      }
      return { holdRes: null };
    });

    displayBus.floorChanged();
    return res.json({
      success: true,
      server_now: new Date().toISOString(),
      warnings: timerResult?.holdRes?.warnings || [],
      seat_hold_until: timerResult?.holdRes?.seat_hold_until || null,
      billing_end_at: timerResult?.holdRes?.billing_end_at || null
    });
  } catch (error) {
    console.error('[handleTimer] Error:', error);
    if (error.status) {
      return res.status(error.status).json({
        error: error.message,
        message: error.message,
        ...(error.code ? { code: error.code } : {})
      });
    }
    return res.status(500).json({ error: '計時操作失敗' });
  }
}

export async function addPerson(req, res) {
  const { booking_ref } = req.params;
  const { seat_code = null, force = false } = req.body;
  const staffName = req.user?.name || '門市人員';
  const staffId = req.user?.id || null;
  const deviceInfo = getAdminDeviceInfo(req);

  try {
    const preRes = await prisma.reservation.findFirst({
      where: { booking_ref, status: { not: 'cancelled' } },
      include: { session: true },
      orderBy: { session: { start_time: 'asc' } }
    });
    if (!preRes) {
      return res.status(404).json({ error: '找不到此筆預約' });
    }
    const preDateStr = toTaipeiDateString(preRes.session.session_date);

    const result = await prisma.$transaction(async (tx) => {
      await lockDaySessionsAndSeats(tx, preDateStr);
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${booking_ref}))`;

      const reservations = await tx.reservation.findMany({
        where: { booking_ref, status: { not: 'cancelled' } },
        include: { session: true }
      });
      if (!reservations.length) throw { status: 404, message: '找不到此筆預約' };

      const firstRes = reservations[0];
      const sessionIds = reservations.map(r => r.session_id);
      const dateStr = toTaipeiDateString(firstRes.session.session_date);
      let displaced = null;

      if (seat_code) {
        if ((firstRes.assigned_seats || []).includes(seat_code)) {
          throw { status: 400, message: `座位 ${seat_code} 已被本筆預約的其他人員佔用` };
        }

        // Validate seat_code exists and active on layout
        const sessionDate = firstRes.session.session_date;
        const activeLayout = await getActiveLayoutForDate(tx, sessionDate);
        const targetSeatObj = (activeLayout?.seats || []).find(ls => ls.code === seat_code);
        if (!targetSeatObj || !targetSeatObj.is_active) {
          throw { status: 400, message: `座位 ${seat_code} 不存在或未啟用` };
        }

        const seatedOccupants = await loadSeatedOccupants(tx, dateStr, { excludeBookingRef: booking_ref });
        if (seatedOccupants[seat_code]) {
          const occ = seatedOccupants[seat_code];
          throw {
            status: 409,
            code: 'SEAT_OCCUPIED',
            conflict_seat: seat_code,
            message: `${seat_code} 還有客人（${occ.name}，預約到 ${occ.end_time}），請選其他座位或先讓上一組離場`
          };
        }

        const conflictReservations = await tx.reservation.findMany({
          where: {
            session_id: { in: sessionIds },
            booking_ref: { not: booking_ref },
            status: { not: 'cancelled' },
            OR: [{ attendance: null }, { attendance: { notIn: ['completed', 'no_show'] } }],
            assigned_seats: { has: seat_code }
          },
          include: { user: true }
        });

        for (const cr of conflictReservations) {
          if (cr.is_seat_locked || cr.attendance === 'checked_in' || cr.seat_source === 'staff') {
            throw {
              status: 409,
              code: 'SEAT_CONFLICT',
              message: `座位已被固定的預約（${cr.user?.name || '客人'} · ${cr.booking_ref}）佔用，無法排入`
            };
          }
        }

        const conflictRefs = [...new Set(conflictReservations.map(cr => cr.booking_ref))];
        displaced = await reseatBookings(tx, {
          bookingRefs: conflictRefs,
          reservedSeats: [seat_code],
          sessionIds,
          primaryBookingRef: booking_ref
        });
      }

      // Check physical layout seat capacity instead of online max_capacity
      if (!force) {
        for (const r of reservations) {
          const bookedPax = await tx.reservation.aggregate({
            where: { session_id: r.session_id, status: { not: 'cancelled' } },
            _sum: { pax: true }
          });
          const totalBooked = (bookedPax._sum.pax || 0) + 1;
          const activeLayout = await getActiveLayoutForDate(tx, r.session.session_date);
          const layoutCapacity = (activeLayout?.capacity && activeLayout.capacity > 0) ? activeLayout.capacity : (activeLayout?.seats || []).filter(s => s.is_active).length || 16;
          if (totalBooked > layoutCapacity) {
            throw {
              status: 409,
              code: 'OVER_CAPACITY',
              message: `該時段（${r.session.start_time} - ${r.session.end_time}）座位已滿（共 ${layoutCapacity} 個座位）`
            };
          }
        }
      }

      // Increment pax
      await tx.reservation.updateMany({
        where: { booking_ref },
        data: {
          pax: { increment: 1 },
          ...(seat_code ? { assigned_seats: [...(firstRes.assigned_seats || []), seat_code] } : {})
        }
      });

      if (seat_code) {
        const allSessionsToCheck = [...new Set([...sessionIds, ...(displaced?.touchedSessionIds || [])])];
        await assertNoSeatCollisions(tx, allSessionsToCheck);
        await assertNoSeatedCollisions(tx, dateStr);
      }

      const existingPersons = await tx.bookingPerson.findMany({
        where: { booking_ref },
        orderBy: { person_no: 'desc' }
      });
      const newPersonNo = (existingPersons[0]?.person_no || 0) + 1;

      const now = new Date();
      const newPerson = await tx.bookingPerson.create({
        data: {
          booking_ref,
          person_no: newPersonNo,
          seat_code: seat_code || null,
          status: 'active',
          is_onsite_added: true,
          billing_start_at: seat_code ? now : null,
          timer_started_at: seat_code ? now : null,
          created_by_name: staffName
        }
      });

      await auditLog(tx, {
        booking_ref,
        event_type: 'amount_adjusted',
        category: 'amount',
        summary: `現場加人 第 ${newPersonNo} 位`,
        reason: '現場加人',
        staff_name: staffName,
        staff_id: staffId,
        device_id: deviceInfo.device_id,
        device_label: deviceInfo.device_label
      });

      await refreshBillingCache(tx, booking_ref);
      return newPerson;
    });

    displayBus.floorChanged();
    return res.json({ success: true, person: result, server_now: new Date().toISOString() });
  } catch (error) {
    console.error('[addPerson] Error:', error);
    if (error.status) return res.status(error.status).json({ error: error.message, code: error.code });
    return res.status(500).json({ error: '加人失敗' });
  }
}

export async function removePerson(req, res) {
  const { booking_ref, person_no } = req.params;
  const pNo = parseInt(person_no, 10);
  const staffName = req.user?.name || '門市人員';
  const staffId = req.user?.id || null;
  const deviceInfo = getAdminDeviceInfo(req);
  const now = (process.env.NODE_ENV === 'test' && (req.body?.now || req.query?.now))
    ? new Date(req.body?.now || req.query?.now)
    : new Date();

  try {
    const preRes = await prisma.reservation.findFirst({
      where: { booking_ref, status: { not: 'cancelled' } },
      include: { session: true },
      orderBy: { session: { start_time: 'asc' } }
    });
    if (!preRes) {
      return res.status(404).json({ error: '找不到此筆預約' });
    }
    const preDateStr = toTaipeiDateString(preRes.session.session_date);

    const removeResult = await prisma.$transaction(async (tx) => {
      await lockDaySessionsAndSeats(tx, preDateStr);
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${booking_ref}))`;

      // Check payment status of this person or whole booking
      const firstRes = await tx.reservation.findFirst({
        where: { booking_ref, status: { not: 'cancelled' } }
      });
      const isBookingPaid =
        firstRes?.is_paid === true ||
        firstRes?.billing_status === 'paid' ||
        firstRes?.billing_status === 'waived';

      const paid = isBookingPaid || Boolean(await tx.payment.findFirst({
        where: {
          booking_ref,
          status: 'valid',
          kind: { in: ['charge', 'waive'] },
          OR: [
            { person_nos: { has: pNo } },
            { person_nos: { equals: [] } }
          ]
        }
      }));
      if (paid) {
        throw { status: 400, message: `第 ${pNo} 位已付款，無法直接移除` };
      }

      const person = await tx.bookingPerson.findUnique({
        where: { booking_ref_person_no: { booking_ref, person_no: pNo } }
      });
      if (!person || person.status === 'removed') {
        throw { status: 404, message: '找不到該顧客資料' };
      }

      const activeCount = await tx.bookingPerson.count({
        where: { booking_ref, status: 'active' }
      });
      if (activeCount <= 1) {
        throw { status: 422, message: '這組只剩這一位，要取消整組請到訂單管理' };
      }

      if (person.timer_started_at) {
        const refEndMs = person.paused_at
          ? Math.min(now.getTime(), new Date(person.paused_at).getTime())
          : now.getTime();
        const elapsedSec = Math.max(
          0,
          Math.floor((refEndMs - new Date(person.timer_started_at).getTime()) / 1000) - (person.paused_seconds || 0)
        );
        if (elapsedSec > 15 * 60) {
          throw { status: 422, message: '已計時超過 15 分鐘，請改用離場' };
        }
      }

      // Close any open timer pause
      await tx.timerPause.updateMany({
        where: { person_id: person.id, ended_at: null },
        data: { ended_at: now }
      });

      await tx.bookingPerson.update({
        where: { id: person.id },
        data: {
          status: 'removed',
          seat_code: null,
          paused_at: null,
          timer_ended_at: now,
          left_at: now
        }
      });

      // Release seat if any
      if (person.seat_code) {
        const reservations = await tx.reservation.findMany({ where: { booking_ref } });
        for (const r of reservations) {
          const updatedSeats = (r.assigned_seats || []).filter(sc => sc !== person.seat_code);
          await tx.reservation.update({
            where: { id: r.id },
            data: { assigned_seats: updatedSeats }
          });
        }
      }

      // Directly end boards under this person, close open BoardPause, release stock & waive fee
      const personBoards = await tx.bookingEquipment.findMany({
        where: { booking_ref, person_id: person.id },
        select: { id: true, unit_group: true }
      });
      const uGroups = [...new Set(personBoards.map(b => b.unit_group).filter(Boolean))];
      if (uGroups.length > 0) {
        await tx.boardPause.updateMany({
          where: { unit_group: { in: uGroups }, ended_at: null },
          data: { ended_at: now }
        });
      }
      if (personBoards.length > 0) {
        await tx.bookingEquipment.updateMany({
          where: { booking_ref, person_id: person.id },
          data: {
            end_at: now,
            ended_reason: 'person_removed',
            subtotal_price: 0,
            covered_sessions: [],
            quantity: 0
          }
        });
      }

      // Decrement pax
      await tx.reservation.updateMany({
        where: { booking_ref },
        data: { pax: { decrement: 1 } }
      });

      await auditLog(tx, {
        booking_ref,
        event_type: 'amount_adjusted',
        category: 'amount',
        summary: `移除 第 ${pNo} 位（這位不玩了）`,
        reason: '現場減人（未收費移除）',
        staff_name: staffName,
        staff_id: staffId,
        device_id: deviceInfo.device_id,
        device_label: deviceInfo.device_label
      });

      await refreshBillingCache(tx, booking_ref);
      const holdRes = await syncWalkInSeatHolds(tx, booking_ref, now);
      return { holdRes };
    });

    displayBus.floorChanged();
    return res.json({
      success: true,
      server_now: new Date().toISOString(),
      warnings: removeResult?.holdRes?.warnings || [],
      seat_hold_until: removeResult?.holdRes?.seat_hold_until || null
    });
  } catch (error) {
    console.error('[removePerson] Error:', error);
    if (error.status) return res.status(error.status).json({ error: error.message });
    return res.status(500).json({ error: '移除顧客失敗' });
  }
}

async function resolveBoardSegStartMs(tx, activeSeg, bookingReservations) {
  const sessionDate = bookingReservations[0]?.session?.session_date || null;
  const coveredSessions = await resolveCoveredSessions(tx, sessionDate, activeSeg.covered_sessions || []);

  let segStartMs;
  if (activeSeg.start_at) {
    segStartMs = new Date(activeSeg.start_at).getTime();
  } else if (coveredSessions.length > 0) {
    const firstSess = coveredSessions[0];
    const dStr = typeof firstSess.session_date === 'string'
      ? firstSess.session_date.slice(0, 10)
      : toTaipeiDateString(firstSess.session_date);
    segStartMs = new Date(`${dStr}T${firstSess.start_time}:00+08:00`).getTime();
  } else {
    segStartMs = Date.now();
  }
  return { segStartMs, coveredSessions, sessionDate };
}

async function applySwapBoardTx(tx, { booking_ref, unit_group, to_equipment_id, boundary_at, now }) {
  const targetConfig = await tx.equipmentConfig.findUnique({
    where: { id: to_equipment_id }
  });
  if (!targetConfig) throw { status: 404, message: '找不到目標尺寸' };

  const segments = await tx.bookingEquipment.findMany({
    where: { booking_ref, unit_group },
    orderBy: { segment_no: 'asc' }
  });
  if (!segments.length) throw { status: 404, message: '找不到此板子' };

  const activeSeg = segments[segments.length - 1];
  const bookingReservations = await tx.reservation.findMany({
    where: { booking_ref, status: { not: 'cancelled' } },
    include: { session: true },
    orderBy: { session: { start_time: 'asc' } }
  });

  const { segStartMs, coveredSessions, sessionDate } = await resolveBoardSegStartMs(tx, activeSeg, bookingReservations);
  const globalSetting = await tx.globalSetting.findFirst();
  const swapGrace = globalSetting?.board_swap_grace_minutes ?? 10;

  const nowMs = (process.env.NODE_ENV === 'test' && now) ? new Date(now).getTime() : Date.now();
  const { options, suggested } = swapBoundaryOptions(segStartMs, nowMs, { grace: swapGrace });

  let boundaryMs;
  if (boundary_at !== undefined && boundary_at !== null) {
    boundaryMs = new Date(boundary_at).getTime();
    const isValid = Number.isFinite(boundaryMs) && options.some(opt => Math.abs(opt - boundaryMs) < 60000);
    if (!isValid) {
      throw { status: 422, message: '換板時間必須是建議的半小時選項之一' };
    }
  } else {
    boundaryMs = suggested;
  }

  const boundaryDt = new Date(boundaryMs);
  const isStartBoundary = Math.abs(boundaryMs - segStartMs) < 60000;

  let swapSessionIndex = 0;
  if (coveredSessions.length > 0) {
    const foundIdx = coveredSessions.findIndex(s => {
      const dStr = typeof s.session_date === 'string'
        ? s.session_date.slice(0, 10)
        : toTaipeiDateString(s.session_date);
      const sStart = new Date(`${dStr}T${s.start_time}:00+08:00`).getTime();
      const sEnd = new Date(`${dStr}T${s.end_time}:00+08:00`).getTime();
      return sStart <= boundaryMs && boundaryMs < sEnd;
    });
    if (foundIdx !== -1) {
      swapSessionIndex = foundIdx;
    } else {
      const lastS = coveredSessions[coveredSessions.length - 1];
      const dStr = typeof lastS.session_date === 'string'
        ? lastS.session_date.slice(0, 10)
        : toTaipeiDateString(lastS.session_date);
      const lastEnd = new Date(`${dStr}T${lastS.end_time}:00+08:00`).getTime();
      swapSessionIndex = boundaryMs >= lastEnd ? coveredSessions.length - 1 : 0;
    }
  }

  const oldCoveredSessions = formatCoveredSessions(coveredSessions.slice(0, swapSessionIndex + 1));
  const newCoveredSessionObjs = isStartBoundary
    ? coveredSessions
    : coveredSessions.slice(swapSessionIndex);
  const newCoveredSessions = formatCoveredSessions(newCoveredSessionObjs);

  const totalStock = targetConfig.total_stock;
  if (totalStock !== null && totalStock !== undefined && newCoveredSessionObjs.length > 0) {
    const stockDate = sessionDate || newCoveredSessionObjs[0]?.session_date;
    const dateReservations = await tx.reservation.findMany({
      where: {
        session: { session_date: stockDate },
        status: { not: 'cancelled' }
      },
      include: { session: true }
    });
    const activeBookingRefs = Array.from(new Set(dateReservations.map(r => r.booking_ref)));
    const uncancelledEquips = await tx.bookingEquipment.findMany({
      where: {
        equipment_id: to_equipment_id,
        booking_ref: { in: activeBookingRefs },
        ended_reason: null,
        OR: [
          { unit_group: null },
          { unit_group: { not: unit_group } }
        ]
      }
    });

    const dStr = typeof stockDate === 'string'
      ? stockDate.slice(0, 10)
      : toTaipeiDateString(stockDate);

    for (const sess of newCoveredSessionObjs) {
      const sId = sess.id;
      const sessTimeStr = `${sess.start_time}-${sess.end_time}`;
      let occupiedCount = 0;

      for (const be of uncancelledEquips) {
        let isCovered = false;
        if (Array.isArray(be.covered_sessions) && be.covered_sessions.length > 0) {
          isCovered = be.covered_sessions.some(cs => {
            if (typeof cs === 'number' || (!isNaN(Number(cs)) && !String(cs).includes(':'))) {
              return Number(cs) === sId;
            }
            return cs === sess.start_time || cs === sessTimeStr || String(cs).startsWith(sess.start_time);
          });
        } else if (be.start_at && (be.end_at || be.planned_end_at)) {
          let sStart = new Date(`${dStr}T${sess.start_time}:00+08:00`).getTime();
          let sEnd = new Date(`${dStr}T${sess.end_time}:00+08:00`).getTime();
          if (sEnd <= sStart) sEnd += 24 * 60 * 60 * 1000;
          const bStart = new Date(be.start_at).getTime();
          const bEnd = new Date(be.end_at || be.planned_end_at).getTime();
          isCovered = Math.max(bStart, sStart) < Math.min(bEnd, sEnd);
        } else {
          const bRes = dateReservations.filter(r => r.booking_ref === be.booking_ref);
          isCovered = bRes.some(r => r.session?.start_time === sess.start_time);
        }
        if (isCovered) {
          occupiedCount += (be.quantity ?? 1);
        }
      }

      const available = totalStock - occupiedCount;
      if (available < 1) {
        throw { status: 409, message: `${targetConfig.name}剩 0 台` };
      }
    }
  }

  const openSwapPauses = await tx.boardPause.findMany({
    where: { unit_group, ended_at: null }
  });
  for (const bp of openSwapPauses) {
    const pEndDt = boundaryDt.getTime() >= new Date(bp.started_at).getTime()
      ? boundaryDt
      : new Date(bp.started_at);
    await tx.boardPause.update({
      where: { id: bp.id },
      data: { ended_at: pEndDt }
    });
  }

  const nextRate = (to_equipment_id === activeSeg.equipment_id && activeSeg.unit_rate != null)
    ? activeSeg.unit_rate
    : targetConfig.hourly_rate;

  if (isStartBoundary) {
    await tx.bookingEquipment.update({
      where: { id: activeSeg.id },
      data: {
        equipment_id: to_equipment_id,
        equipment_name_snapshot: targetConfig.name,
        unit_rate: nextRate,
        covered_sessions: newCoveredSessions
      }
    });
  } else {
    await tx.bookingEquipment.update({
      where: { id: activeSeg.id },
      data: {
        end_at: boundaryDt,
        ended_reason: 'swapped',
        covered_sessions: oldCoveredSessions
      }
    });

    await tx.bookingEquipment.create({
      data: {
        booking_ref,
        equipment_id: to_equipment_id,
        equipment_name_snapshot: targetConfig.name,
        quantity: 1,
        rental_hours: activeSeg.rental_hours,
        subtotal_price: 0,
        covered_sessions: newCoveredSessions,
        person_id: activeSeg.person_id,
        unit_group: activeSeg.unit_group,
        segment_no: activeSeg.segment_no + 1,
        start_at: boundaryDt,
        end_at: null,
        unit_rate: nextRate,
        daily_cap_snapshot: activeSeg.daily_cap_snapshot ?? null,
        is_price_fixed: activeSeg.is_price_fixed !== false,
        planned_end_at: activeSeg.planned_end_at,
        added_after_payment: Boolean(activeSeg.added_after_payment)
      }
    });
  }

  return { activeSeg, targetConfig, actionDt: boundaryDt };
}

export async function computeAfterPaymentBoardFee(
  tx,
  booking_ref,
  unit_group,
  endAt,
  { staffName = '系統', staffId = null, deviceInfo = null } = {}
) {
  const segments = await tx.bookingEquipment.findMany({
    where: { booking_ref, unit_group },
    orderBy: { segment_no: 'asc' }
  });
  if (!segments.length || !segments.some((s) => s.added_after_payment === true)) {
    return null;
  }

  const activeSegments = segments.filter((s) => s.ended_reason !== 'person_removed');
  if (!activeSegments.length) return null;

  const reservations = await tx.reservation.findMany({
    where: { booking_ref, status: { not: 'cancelled' } },
    include: { session: true },
    orderBy: { session: { start_time: 'asc' } }
  });
  const firstRes = reservations[0];
  const lastRes = reservations[reservations.length - 1];
  if (!firstRes) return null;

  const sessionDate = firstRes.session.session_date;
  const dStr = typeof sessionDate === 'string'
    ? sessionDate.slice(0, 10)
    : toTaipeiDateString(sessionDate);
  const bookingStartDt = new Date(`${dStr}T${firstRes.session.start_time}:00+08:00`);
  let bookingEndDt = new Date(`${dStr}T${lastRes.session.end_time}:00+08:00`);
  if (bookingEndDt <= bookingStartDt) {
    bookingEndDt = new Date(bookingEndDt.getTime() + 24 * 60 * 60 * 1000);
  }

  let personNo = 1;
  if (activeSegments[0].person_id) {
    const bp = await tx.bookingPerson.findUnique({
      where: { id: activeSegments[0].person_id },
      select: { person_no: true }
    });
    if (bp?.person_no) personNo = bp.person_no;
  }

  const endDt = endAt instanceof Date ? endAt : new Date(endAt);
  const pauses = await tx.boardPause.findMany({
    where: { unit_group },
    orderBy: { started_at: 'asc' }
  });
  const globalSetting = await tx.globalSetting.findFirst();
  const discountConfig = {
    enabled: globalSetting?.equipment_discount_enabled ?? true,
    buy_hours: globalSetting?.equipment_discount_buy_hours ?? 3,
    free_hours: globalSetting?.equipment_discount_free_hours ?? 1,
    tier2_enabled: globalSetting?.equipment_discount2_enabled ?? false,
    tier2_buy_hours: globalSetting?.equipment_discount2_buy_hours ?? 8,
    tier2_free_hours: globalSetting?.equipment_discount2_free_hours ?? 4,
    stackable: globalSetting?.equipment_discount_stackable ?? true
  };
  const graceMinutes = globalSetting?.board_swap_grace_minutes ?? 10;

  const capVals = activeSegments
    .map((s) => s.daily_cap_snapshot)
    .filter((v) => v !== null && v !== undefined && Number.isFinite(Number(v)))
    .map(Number);
  const dailyCap = capVals.length > 0 ? Math.max(...capVals) : null;

  const mappedSegs = activeSegments.map((s) => {
    const startDt = s.start_at ? new Date(s.start_at) : bookingStartDt;
    const segEnd = s.end_at ? new Date(s.end_at) : endDt;
    return {
      equipment_id: s.equipment_id,
      name: s.equipment_name_snapshot,
      rate: s.unit_rate ?? 60,
      hours: 0,
      start_at: startDt.toISOString(),
      end_at: segEnd.toISOString(),
      effective_end_at: segEnd.toISOString(),
      ended_reason: s.ended_reason || 'returned',
      bill_until_return: true
    };
  });

  const calc = calculateBoardTotal({
    segments: mappedSegs,
    pauses,
    discountConfig,
    now: endDt,
    dailyCap,
    graceMinutes
  });
  const amount = Math.max(0, Math.round(calc.total || 0));
  const sourceKey = `board:${unit_group}`;

  const validSupplements = await tx.payment.findMany({
    where: { booking_ref, status: 'valid', kind: 'supplement' }
  });
  const alreadyCollected = validSupplements.some((pay) => {
    const items = Array.isArray(pay.breakdown_json?.pending_items) ? pay.breakdown_json.pending_items : [];
    return items.some((pi) => pi?.source_key === sourceKey);
  });
  if (alreadyCollected) {
    return { unit_group, person_no: personNo, source_key: sourceKey, amount, skippedBecauseCollected: true };
  }

  const currentDraft = (firstRes.checkout_details && typeof firstRes.checkout_details === 'object')
    ? firstRes.checkout_details
    : {};
  const currentRev = Number.isInteger(currentDraft.rev) ? currentDraft.rev : 0;
  const prevPending = Array.isArray(currentDraft.pending_supplements) ? currentDraft.pending_supplements : [];

  if (amount <= 0) {
    if (prevPending.some((ps) => ps?.source_key === sourceKey)) {
      const nextDraft = {
        ...currentDraft,
        pending_supplements: prevPending.filter((ps) => ps?.source_key !== sourceKey)
      };
      await saveDraft(booking_ref, currentRev, nextDraft, staffName, staffId, deviceInfo, tx);
      await refreshBillingCache(tx, booking_ref);
    }
    return { unit_group, person_no: personNo, source_key: sourceKey, amount: 0 };
  }

  const firstStartDt = mappedSegs[0]?.start_at ? new Date(mappedSegs[0].start_at) : endDt;
  const fmtHHmm = (d) => new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Taipei',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).format(d);
  const boardNames = [...new Set(activeSegments.map((s) => s.equipment_name_snapshot).filter(Boolean))].join('/');
  const label = `智能板加租 ${boardNames || '智能板'} ${fmtHHmm(firstStartDt)}–${fmtHHmm(endDt)}`;

  const existingSame = prevPending.find((ps) => ps?.source_key === sourceKey);
  if (
    existingSame &&
    Number(existingSame.person_no) === personNo &&
    Number(existingSame.amount) === amount &&
    existingSame.source_type === 'board_addon'
  ) {
    return { unit_group, person_no: personNo, source_key: sourceKey, amount };
  }

  const nextPending = [
    ...prevPending.filter((ps) => ps?.source_key !== sourceKey),
    {
      person_no: personNo,
      source_key: sourceKey,
      source_type: 'board_addon',
      label,
      amount,
      computed_until: endDt.toISOString()
    }
  ];
  await saveDraft(
    booking_ref,
    currentRev,
    { ...currentDraft, pending_supplements: nextPending },
    staffName,
    staffId,
    deviceInfo,
    tx
  );
  await refreshBillingCache(tx, booking_ref);
  return { unit_group, person_no: personNo, source_key: sourceKey, amount, label };
}

async function applyReturnBoardTx(tx, { booking_ref, unit_group, at, now }) {
  const segments = await tx.bookingEquipment.findMany({
    where: { booking_ref, unit_group },
    orderBy: { segment_no: 'asc' }
  });
  if (!segments.length) throw { status: 404, message: '找不到此板子' };

  const activeSeg = segments[segments.length - 1];
  if (activeSeg.ended_reason === 'returned' && activeSeg.end_at) {
    return { activeSeg, actionDt: new Date(activeSeg.end_at), alreadyReturned: true };
  }
  const bookingReservations = await tx.reservation.findMany({
    where: { booking_ref, status: { not: 'cancelled' } },
    include: { session: true },
    orderBy: { session: { start_time: 'asc' } }
  });

  const { segStartMs, coveredSessions } = await resolveBoardSegStartMs(tx, activeSeg, bookingReservations);
  const globalSetting = await tx.globalSetting.findFirst();
  const swapGrace = globalSetting?.board_swap_grace_minutes ?? 10;

  const nowMs = (process.env.NODE_ENV === 'test' && now) ? new Date(now).getTime() : Date.now();
  const { options, suggested } = swapBoundaryOptions(segStartMs, nowMs, { grace: swapGrace });

  let returnMs;
  if (at !== undefined && at !== null) {
    const parsedMs = new Date(at).getTime();
    const isValid = Number.isFinite(parsedMs) && options.some(opt => Math.abs(opt - parsedMs) < 60000);
    if (!isValid) {
      throw { status: 422, message: '歸還時間必須是建議的半小時選項之一' };
    }
    returnMs = parsedMs;
  } else {
    returnMs = suggested;
  }

  const returnDt = new Date(returnMs);

  let returnIndex = coveredSessions.length - 1;
  if (coveredSessions.length > 0) {
    const foundIdx = coveredSessions.findIndex(s => {
      const dStr = typeof s.session_date === 'string'
        ? s.session_date.slice(0, 10)
        : toTaipeiDateString(s.session_date);
      const sStart = new Date(`${dStr}T${s.start_time}:00+08:00`).getTime();
      const sEnd = new Date(`${dStr}T${s.end_time}:00+08:00`).getTime();
      return sStart <= returnMs && returnMs < sEnd;
    });
    if (foundIdx !== -1) {
      returnIndex = foundIdx;
    } else {
      const firstS = coveredSessions[0];
      const dStr = typeof firstS.session_date === 'string'
        ? firstS.session_date.slice(0, 10)
        : toTaipeiDateString(firstS.session_date);
      const firstStart = new Date(`${dStr}T${firstS.start_time}:00+08:00`).getTime();
      if (returnMs < firstStart) {
        returnIndex = -1;
      }
    }
  }

  const keptCoveredSessions = returnIndex >= 0
    ? formatCoveredSessions(coveredSessions.slice(0, returnIndex + 1))
    : [];

  const openRetPauses = await tx.boardPause.findMany({
    where: { unit_group, ended_at: null }
  });
  for (const bp of openRetPauses) {
    const pEndDt = returnDt.getTime() >= new Date(bp.started_at).getTime()
      ? returnDt
      : new Date(bp.started_at);
    await tx.boardPause.update({
      where: { id: bp.id },
      data: { ended_at: pEndDt }
    });
  }

  await tx.bookingEquipment.update({
    where: { id: activeSeg.id },
    data: {
      end_at: returnDt,
      ended_reason: 'returned',
      bill_until_return: true,
      covered_sessions: keptCoveredSessions
    }
  });

  return { activeSeg, actionDt: returnDt };
}

function findBoardInBill(bill, unitGroup) {
  for (const p of (bill?.persons || [])) {
    const unit = (p.board?.units || []).find(u => u.unit_group === unitGroup);
    if (unit) {
      return { person: p, unit };
    }
  }
  return { person: null, unit: null };
}

export async function previewBoardChange(req, res) {
  const { booking_ref, unit_group } = req.params;
  const { action, to_equipment_id, now } = req.body || {};
  const at = req.body?.at ?? req.body?.boundary_at;

  if (action !== 'swap' && action !== 'return') {
    return res.status(400).json({ error: 'action 必須是 swap 或 return' });
  }

  const nowDate = (process.env.NODE_ENV === 'test' && now) ? new Date(now) : new Date();

  try {
    const preRes = await prisma.reservation.findFirst({
      where: { booking_ref, status: { not: 'cancelled' } },
      include: { session: true },
      orderBy: { session: { start_time: 'asc' } }
    });
    if (!preRes) {
      return res.status(404).json({ error: '找不到此筆預約' });
    }
    const preDateStr = toTaipeiDateString(preRes.session.session_date);

    const moveResult = await prisma.$transaction(async (tx) => {
      await lockDaySessionsAndSeats(tx, preDateStr);
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${booking_ref}))`;

      const beforeData = await getBookingBill(booking_ref, tx, nowDate);
      const beforeMatch = findBoardInBill(beforeData.bill, unit_group);
      const board_amount_before = beforeMatch.unit ? beforeMatch.unit.total : 0;

      let actionResult;
      if (action === 'return') {
        actionResult = await applyReturnBoardTx(tx, { booking_ref, unit_group, at, now });
      } else {
        if (!to_equipment_id) throw { status: 400, message: '缺少目標板子尺寸' };
        actionResult = await applySwapBoardTx(tx, {
          booking_ref,
          unit_group,
          to_equipment_id,
          boundary_at: at,
          now
        });
      }

      const afterData = await getBookingBill(booking_ref, tx, nowDate);
      const afterMatch = findBoardInBill(afterData.bill, unit_group);
      const targetPersonNo = afterMatch.person?.person_no ?? beforeMatch.person?.person_no;
      const targetPerson = afterMatch.person
        || (afterData.bill?.persons || []).find(p => Number(p.person_no) === Number(targetPersonNo));

      const previewResult = {
        board_amount_before,
        board_amount_after: afterMatch.unit ? afterMatch.unit.total : 0,
        person_total_after: targetPerson ? targetPerson.total : 0,
        at: actionResult.actionDt.toISOString(),
        board: afterMatch.unit ? {
          total: afterMatch.unit.total,
          gross: afterMatch.unit.gross,
          discount: afterMatch.unit.discount,
          H: afterMatch.unit.H
        } : null
      };

      throw { isPreviewRollback: true, previewResult };
    });
  } catch (error) {
    if (error?.isPreviewRollback) {
      return res.json({ success: true, ...error.previewResult });
    }
    console.error('[previewBoardChange] Error:', error);
    if (error?.status) return res.status(error.status).json({ error: error.message });
    return res.status(500).json({ error: '預覽試算失敗' });
  }
}

export async function swapBoard(req, res) {
  const { booking_ref, unit_group } = req.params;
  const { to_equipment_id, boundary_at, now } = req.body;
  const deviceInfo = getAdminDeviceInfo(req);
  const staffName = req.user?.name || '門市人員';
  const staffId = req.user?.id || null;

  try {
    const updatedBill = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${booking_ref}))`;

      const { activeSeg, targetConfig } = await applySwapBoardTx(tx, {
        booking_ref,
        unit_group,
        to_equipment_id,
        boundary_at,
        now
      });

      await auditLog(tx, {
        booking_ref,
        event_type: 'amount_adjusted',
        category: 'amount',
        summary: `換板 ${activeSeg.equipment_name_snapshot} → ${targetConfig.name}`,
        reason: '更換智能板尺寸',
        staff_name: staffName,
        staff_id: staffId,
        device_id: deviceInfo.device_id,
        device_label: deviceInfo.device_label
      });

      await refreshBillingCache(tx, booking_ref);
      const billData = await getBookingBill(booking_ref, tx);
      return billData.bill;
    });

    displayBus.floorChanged();
    return res.json({ success: true, bill: updatedBill, server_now: new Date().toISOString() });
  } catch (error) {
    console.error('[swapBoard] Error:', error);
    if (error.status) return res.status(error.status).json({ error: error.message });
    return res.status(500).json({ error: '換板失敗' });
  }
}

export async function returnBoard(req, res) {
  const { booking_ref, unit_group } = req.params;
  const { at, now } = req.body || {};
  const deviceInfo = getAdminDeviceInfo(req);
  const staffName = req.user?.name || '門市人員';
  const staffId = req.user?.id || null;

  try {
    const updatedBill = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${booking_ref}))`;

      const { activeSeg, actionDt } = await applyReturnBoardTx(tx, {
        booking_ref,
        unit_group,
        at,
        now
      });

      if (activeSeg?.added_after_payment) {
        await computeAfterPaymentBoardFee(tx, booking_ref, unit_group, actionDt, {
          staffName,
          staffId,
          deviceInfo
        });
      }

      await auditLog(tx, {
        booking_ref,
        event_type: 'amount_adjusted',
        category: 'amount',
        summary: `歸還 ${activeSeg.equipment_name_snapshot}`,
        reason: '提前歸還智能板',
        staff_name: staffName,
        staff_id: staffId,
        device_id: deviceInfo.device_id,
        device_label: deviceInfo.device_label
      });

      await refreshBillingCache(tx, booking_ref);
      const billData = await getBookingBill(booking_ref, tx);
      return billData.bill;
    });

    displayBus.floorChanged();
    return res.json({ success: true, bill: updatedBill, server_now: new Date().toISOString() });
  } catch (error) {
    console.error('[returnBoard] Error:', error);
    if (error.status) return res.status(error.status).json({ error: error.message });
    return res.status(500).json({ error: '歸還板子失敗' });
  }
}

export async function reassignBoard(req, res) {
  const { booking_ref, unit_group } = req.params;
  const { person_no } = req.body || {};
  const staffName = req.user?.name || '門市人員';
  const staffId = req.user?.id || null;
  const deviceInfo = getAdminDeviceInfo(req);

  const pNo = Number(person_no);
  if (!Number.isInteger(pNo) || pNo <= 0) {
    return res.status(400).json({ error: '請指定正確的顧客編號' });
  }

  try {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${booking_ref}))`;

      const person = await tx.bookingPerson.findUnique({
        where: { booking_ref_person_no: { booking_ref, person_no: pNo } }
      });
      if (!person || person.status !== 'active') {
        throw { status: 404, message: `找不到第 ${pNo} 位，或這位已移除` };
      }

      const segCount = await tx.bookingEquipment.count({
        where: { booking_ref, unit_group }
      });
      if (segCount === 0) {
        throw { status: 404, message: '此智能板不屬於這筆預約' };
      }

      await tx.bookingEquipment.updateMany({
        where: { booking_ref, unit_group },
        data: { person_id: person.id }
      });

      await auditLog(tx, {
        booking_ref,
        event_type: 'board_reassigned',
        category: 'seating',
        summary: `智能板改給第 ${pNo} 位`,
        staff_name: staffName,
        staff_id: staffId,
        device_id: deviceInfo?.device_id || null,
        device_label: deviceInfo?.device_label || null
      });

      await refreshBillingCache(tx, booking_ref);
    });

    displayBus.floorChanged();
    return res.json({ success: true, server_now: new Date().toISOString() });
  } catch (error) {
    console.error('[reassignBoard] Error:', error);
    if (error.status) {
      return res.status(error.status).json({
        error: error.message,
        ...(error.code ? { code: error.code } : {})
      });
    }
    return res.status(500).json({ error: '指派板子失敗' });
  }
}

export async function addBoardRental(req, res) {
  const booking_ref = req.params.booking_ref || req.params.ref;
  const { person_no, equipment_id, from_at, to_at, now: bodyNow } = req.body;
  const staffName = req.user?.name || '門市人員';
  const staffId = req.user?.id || null;
  const deviceInfo = getAdminDeviceInfo(req);

  try {
    const preRes = await prisma.reservation.findFirst({
      where: { booking_ref, status: { not: 'cancelled' } },
      include: { session: true },
      orderBy: { session: { start_time: 'asc' } }
    });
    if (!preRes) {
      return res.status(404).json({ error: '找不到此筆預約' });
    }
    const preDateStr = toTaipeiDateString(preRes.session.session_date);

    const result = await prisma.$transaction(async (tx) => {
      await lockDaySessionsAndSeats(tx, preDateStr);
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${booking_ref}))`;

      const reservations = await tx.reservation.findMany({
        where: { booking_ref, status: { not: 'cancelled' } },
        include: { session: true },
        orderBy: { session: { start_time: 'asc' } }
      });
      if (!reservations.length) {
        throw { status: 404, message: '找不到此筆預約' };
      }

      const firstRes = reservations[0];
      const pNo = Number(person_no);
      const targetPerson = await tx.bookingPerson.findFirst({
        where: { booking_ref, person_no: pNo }
      });
      if (!targetPerson) {
        throw { status: 404, message: `找不到第 ${person_no} 位顧客` };
      }
      const actionNow = (process.env.NODE_ENV === 'test' && bodyNow) ? new Date(bodyNow) : new Date();
      const paidAfterPayment = await isPersonPaid(tx, booking_ref, pNo, firstRes);
      const hasPersonLeft = targetPerson.status !== 'active'
        || firstRes.attendance === 'completed'
        || Boolean(targetPerson.left_at)
        || (!paidAfterPayment && Boolean(targetPerson.timer_ended_at) && new Date(targetPerson.timer_ended_at).getTime() <= actionNow.getTime());
      if (hasPersonLeft) {
        throw { status: 409, code: 'PERSON_INACTIVE', message: '此顧客已離場或已移除，不能加租智能板' };
      }

      const targetConfigs = await tx.$queryRaw`
        SELECT * FROM "EquipmentConfig" WHERE id = ${equipment_id} FOR UPDATE
      `;
      const targetConfig = targetConfigs[0];
      if (!targetConfig) {
        throw { status: 404, message: '找不到此設備尺寸' };
      }

      const lastRes = reservations[reservations.length - 1];
      const sessionDate = firstRes.session.session_date;
      const dStr = typeof sessionDate === 'string'
        ? sessionDate.slice(0, 10)
        : toTaipeiDateString(sessionDate);

      const bookingStartDt = new Date(`${dStr}T${firstRes.session.start_time}:00+08:00`);
      let bookingEndDt = new Date(`${dStr}T${lastRes.session.end_time}:00+08:00`);
      if (bookingEndDt <= bookingStartDt) {
        bookingEndDt = new Date(bookingEndDt.getTime() + 24 * 60 * 60 * 1000);
      }

      let fromDt;
      if (from_at) {
        if (typeof from_at === 'string' && from_at.includes('T')) {
          fromDt = new Date(from_at);
        } else if (typeof from_at === 'string' && from_at.includes(':')) {
          const t = from_at.length === 5 ? `${from_at}:00` : from_at;
          fromDt = new Date(`${dStr}T${t}+08:00`);
          if (fromDt < bookingStartDt && bookingEndDt > bookingStartDt) {
            const nextDayFrom = new Date(fromDt.getTime() + 24 * 60 * 60 * 1000);
            if (nextDayFrom <= bookingEndDt) {
              fromDt = nextDayFrom;
            }
          }
        } else {
          fromDt = new Date(from_at);
        }
      } else {
        const nowDt = (process.env.NODE_ENV === 'test' && bodyNow) ? new Date(bodyNow) : new Date();
        fromDt = nowDt < bookingStartDt ? bookingStartDt : nowDt;
      }

      let toDt;
      if (to_at) {
        if (typeof to_at === 'string' && to_at.includes('T')) {
          toDt = new Date(to_at);
        } else if (typeof to_at === 'string' && to_at.includes(':')) {
          const t = to_at.length === 5 ? `${to_at}:00` : to_at;
          toDt = new Date(`${dStr}T${t}+08:00`);
          if (toDt <= fromDt) {
            toDt = new Date(toDt.getTime() + 24 * 60 * 60 * 1000);
          }
        } else {
          toDt = new Date(to_at);
        }
      } else {
        toDt = bookingEndDt;
      }

      if (fromDt.getTime() >= toDt.getTime()) {
        throw { status: 400, message: '加租開始時間必須早於結束時間' };
      }

      // Check overlap: "檢查這一位在同一時間不會有兩台" (同一位重疊時段回 409)
      const existingPersonBoards = await tx.bookingEquipment.findMany({
        where: {
          booking_ref,
          person_id: targetPerson.id,
          ended_reason: null
        }
      });

      for (const ex of existingPersonBoards) {
        const exStart = ex.start_at ? new Date(ex.start_at) : bookingStartDt;
        const exEnd = ex.end_at ? new Date(ex.end_at) : (ex.planned_end_at ? new Date(ex.planned_end_at) : bookingEndDt);
        if (Math.max(fromDt.getTime(), exStart.getTime()) < Math.min(toDt.getTime(), exEnd.getTime())) {
          throw {
            status: 409,
            code: 'BOARD_TIME_OVERLAP',
            message: `第 ${person_no} 位在此時段已租借智能板，不可同時租借兩台`
          };
        }
      }

      // Find sessions on this date covering fromDt..toDt
      const allSessionsOnDate = await tx.session.findMany({
        where: { session_date: sessionDate },
        orderBy: { start_time: 'asc' }
      });

      const coveredSessions = allSessionsOnDate.filter(s => {
        let sStart = new Date(`${dStr}T${s.start_time}:00+08:00`).getTime();
        let sEnd = new Date(`${dStr}T${s.end_time}:00+08:00`).getTime();
        if (sEnd <= sStart) {
          sEnd += 24 * 60 * 60 * 1000;
        }
        return Math.max(fromDt.getTime(), sStart) < Math.min(toDt.getTime(), sEnd);
      });

      const coveredSessionStrings = coveredSessions.map(s => `${s.start_time}-${s.end_time}`);

      // Inventory check: only count same date, non-cancelled, overlapping rentals (matches createReservation)
      const totalStock = targetConfig.total_stock;
      if (totalStock !== null && totalStock !== undefined) {
        const dateReservations = await tx.reservation.findMany({
          where: {
            session: { session_date: sessionDate },
            status: { not: 'cancelled' }
          },
          include: { session: true }
        });
        const activeBookingRefs = Array.from(new Set(dateReservations.map(r => r.booking_ref)));
        const bookedEquipments = await tx.bookingEquipment.findMany({
          where: {
            equipment_id,
            booking_ref: { in: activeBookingRefs },
            ended_reason: null
          }
        });

        for (const sess of coveredSessions) {
          const sId = sess.id;
          const sessTimeStr = `${sess.start_time}-${sess.end_time}`;
          let occupiedCount = 0;
          for (const be of bookedEquipments) {
            let isCovered = false;
            if (Array.isArray(be.covered_sessions) && be.covered_sessions.length > 0) {
              isCovered = be.covered_sessions.some(cs => {
                if (typeof cs === 'number' || (!isNaN(Number(cs)) && !String(cs).includes(':'))) {
                  return Number(cs) === sId;
                }
                return cs === sess.start_time || cs === sessTimeStr || String(cs).startsWith(sess.start_time);
              });
            } else if (be.start_at && (be.end_at || be.planned_end_at)) {
              let sStart = new Date(`${dStr}T${sess.start_time}:00+08:00`).getTime();
              let sEnd = new Date(`${dStr}T${sess.end_time}:00+08:00`).getTime();
              if (sEnd <= sStart) sEnd += 24 * 60 * 60 * 1000;
              const bStart = new Date(be.start_at).getTime();
              const bEnd = new Date(be.end_at || be.planned_end_at).getTime();
              isCovered = Math.max(bStart, sStart) < Math.min(bEnd, sEnd);
            } else {
              const bRes = dateReservations.filter(r => r.booking_ref === be.booking_ref);
              isCovered = bRes.some(r => r.session?.start_time === sess.start_time);
            }
            if (isCovered) {
              occupiedCount += (be.quantity || 1);
            }
          }

          const available = totalStock - occupiedCount;
          if (available < 1) {
            throw {
              status: 409,
              code: 'BOARD_OUT_OF_STOCK',
              message: `${targetConfig.name}庫存不足，剩餘 0 台`
            };
          }
        }
      }

      const diffMs = toDt.getTime() - fromDt.getTime();
      const rentalHours = Math.max(1, Math.ceil(diffMs / 3600000));
      const unitRate = targetConfig.hourly_rate ?? 60;
      const dailyCapSnapshot = targetConfig.daily_cap ?? null;
      const newUnitGroup = crypto.randomUUID();

      const newEquipment = await tx.bookingEquipment.create({
        data: {
          booking_ref,
          person_id: targetPerson.id,
          equipment_id,
          equipment_name_snapshot: targetConfig.name,
          quantity: 1,
          unit_group: newUnitGroup,
          segment_no: 1,
          start_at: fromDt,
          end_at: null,
          planned_end_at: toDt,
          unit_rate: unitRate,
          daily_cap_snapshot: dailyCapSnapshot,
          is_price_fixed: false,
          added_after_payment: paidAfterPayment,
          rental_hours: rentalHours,
          subtotal_price: 0,
          covered_sessions: coveredSessionStrings
        }
      });

      await auditLog(tx, {
        booking_ref,
        event_type: 'amount_adjusted',
        category: 'amount',
        summary: paidAfterPayment
          ? `第 ${pNo} 位付款後加租智能板（歸還時列待補收）`
          : `加租智能板：第 ${pNo} 位租借 ${targetConfig.name}`,
        reason: paidAfterPayment ? '付款後加租智能板' : '加租智能板',
        staff_name: staffName,
        staff_id: staffId,
        device_id: deviceInfo?.device_id,
        device_label: deviceInfo?.device_label
      });

      await refreshBillingCache(tx, booking_ref);

      return newEquipment;
    });

    displayBus.floorChanged();
    return res.json({
      success: true,
      booking_equipment: result,
      server_now: new Date().toISOString()
    });
  } catch (error) {
    console.error('[addBoardRental] Error:', error);
    if (error.status) return res.status(error.status).json({ error: error.message, code: error.code });
    return res.status(500).json({ error: '加租智能板失敗' });
  }
}

export async function pauseBoard(req, res) {
  const { booking_ref, unit_group } = req.params;
  const { at = null } = req.body || {};
  const deviceInfo = getAdminDeviceInfo(req);
  const staffName = req.user?.name || '門市人員';
  const staffId = req.user?.id || null;

  try {
    const pauseDt = (process.env.NODE_ENV === 'test' && at) ? new Date(at) : new Date();
    const result = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${booking_ref}))`;

      const segments = await tx.bookingEquipment.findMany({
        where: { booking_ref, unit_group },
        orderBy: { segment_no: 'asc' }
      });
      if (!segments.length) throw { status: 404, message: '找不到此板子' };

      const activeSeg = segments.find(seg => !seg.end_at);
      if (!activeSeg) throw { status: 400, message: '此板子已歸還，無法暫停' };

      let pauseRow = await tx.boardPause.findFirst({
        where: { unit_group, ended_at: null }
      });
      if (!pauseRow) {
        pauseRow = await tx.boardPause.create({
          data: {
            unit_group,
            started_at: pauseDt,
            source: 'solo',
            staff_name: staffName
          }
        });
      }

      await auditLog(tx, {
        booking_ref,
        event_type: 'amount_adjusted',
        category: 'amount',
        summary: `單獨暫停 ${activeSeg.equipment_name_snapshot}`,
        reason: '智能板單獨暫停',
        staff_name: staffName,
        staff_id: staffId,
        device_id: deviceInfo.device_id,
        device_label: deviceInfo.device_label
      });

      await refreshBillingCache(tx, booking_ref);
      return pauseRow;
    });

    displayBus.floorChanged();
    return res.json({ success: true, board_pause: result, server_now: new Date().toISOString() });
  } catch (error) {
    console.error('[pauseBoard] Error:', error);
    if (error.status) return res.status(error.status).json({ error: error.message });
    return res.status(500).json({ error: '暫停智能板失敗' });
  }
}

export async function resumeBoard(req, res) {
  const { booking_ref, unit_group } = req.params;
  const { at = null } = req.body || {};
  const deviceInfo = getAdminDeviceInfo(req);
  const staffName = req.user?.name || '門市人員';
  const staffId = req.user?.id || null;

  try {
    const resumeDt = (process.env.NODE_ENV === 'test' && at) ? new Date(at) : new Date();
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${booking_ref}))`;

      const segments = await tx.bookingEquipment.findMany({
        where: { booking_ref, unit_group },
        orderBy: { segment_no: 'asc' }
      });
      if (!segments.length) throw { status: 404, message: '找不到此板子' };

      const activeSeg = segments.find(seg => !seg.end_at) || segments[segments.length - 1];
      const openPauses = await tx.boardPause.findMany({
        where: { unit_group, ended_at: null }
      });
      for (const bp of openPauses) {
        const pEndDt = resumeDt.getTime() >= new Date(bp.started_at).getTime()
          ? resumeDt
          : new Date(bp.started_at);
        await tx.boardPause.update({
          where: { id: bp.id },
          data: { ended_at: pEndDt }
        });
      }

      await auditLog(tx, {
        booking_ref,
        event_type: 'amount_adjusted',
        category: 'amount',
        summary: `繼續使用 ${activeSeg.equipment_name_snapshot}`,
        reason: '繼續使用智能板',
        staff_name: staffName,
        staff_id: staffId,
        device_id: deviceInfo.device_id,
        device_label: deviceInfo.device_label
      });

      await refreshBillingCache(tx, booking_ref);
    });

    displayBus.floorChanged();
    return res.json({ success: true, server_now: new Date().toISOString() });
  } catch (error) {
    console.error('[resumeBoard] Error:', error);
    if (error.status) return res.status(error.status).json({ error: error.message });
    return res.status(500).json({ error: '恢復智能板失敗' });
  }
}

export async function getFloorKioskRecent(req, res) {
  try {
    const rawNow = process.env.NODE_ENV === 'test' && req.query.now ? new Date(String(req.query.now)) : null;
    const now = rawNow && !Number.isNaN(rawNow.getTime()) ? rawNow : new Date();
    const dateStr = toTaipeiDateString(now);
    const startAt = new Date(`${dateStr}T00:00:00+08:00`);
    const endAt = new Date(startAt.getTime() + 86400000);

    const rows = await prisma.kioskAccessLog.findMany({
      where: {
        at: { gte: startAt, lt: endAt }
      },
      select: {
        at: true,
        at_unknown: true,
        method: true,
        result: true,
        open_door: true,
        booking_ref: true,
        user_id: true,
        hint: true
      },
      orderBy: [{ at: 'desc' }, { id: 'desc' }],
      take: 20
    });

    const userIds = [...new Set(rows.map(r => r.user_id).filter(Boolean))];
    const users = userIds.length > 0
      ? await prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } })
      : [];
    const userNameById = new Map(users.map(u => [u.id, u.name]));

    const logs = rows.map(l => ({
      at: l.at ? l.at.toISOString() : null,
      at_unknown: Boolean(l.at_unknown),
      method: l.method,
      result: l.result,
      open_door: Boolean(l.open_door),
      booking_ref_display: l.booking_ref ? formatBookingRef(l.booking_ref) : null,
      user_name: (l.user_id ? userNameById.get(l.user_id) : null) || null,
      hint: l.hint || null
    }));

    return res.json({ date: dateStr, logs });
  } catch (error) {
    console.error('[getFloorKioskRecent] Error:', error);
    return res.status(500).json({ error: '無法取得報到機紀錄' });
  }
}

function buildFloorKioskStatusReason(pass) {
  switch (pass.state) {
    case 'unpaid':
      return '還沒付款';
    case 'reported':
      return '已回報末五碼，等對帳';
    case 'mismatch':
      return '金額不符';
    case 'confirmed':
      return `已付款，還沒到可進場時間（${pass.open_at} 起）`;
    case 'open':
      return '現在掃碼可以開門';
    case 'in': {
      const hm = pass.first_checkin_at ? formatTimeHHmm(pass.first_checkin_at) : '';
      return hm ? `已進場（${hm} 首次報到）` : '已進場';
    }
    case 'ended':
      return '今天的使用時間已結束';
    case 'cancelled':
      return '這筆預約已取消';
    default:
      return '狀態未知';
  }
}

export async function getFloorKioskBookingStatus(req, res) {
  try {
    const { booking_ref } = req.params;
    const rawNow = process.env.NODE_ENV === 'test' && req.query.now ? new Date(String(req.query.now)) : null;
    const now = rawNow && !Number.isNaN(rawNow.getTime()) ? rawNow : new Date();

    const pass = await getReservationEntryPass(prisma, {
      bookingRef: booking_ref,
      userId: null,
      now
    });

    return res.json({
      state: pass.state,
      open_at: pass.open_at,
      until: pass.until,
      first_checkin_at: pass.first_checkin_at,
      seats: pass.seats,
      reason: buildFloorKioskStatusReason(pass)
    });
  } catch (error) {
    if (error.statusCode === 404 || error.message === 'RESERVATION_NOT_FOUND') {
      return res.status(404).json({ error: '找不到這筆預約' });
    }
    console.error('[getFloorKioskBookingStatus] Error:', error);
    return res.status(500).json({ error: '無法查詢報到狀態' });
  }
}

export default {
  getLive,
  checkIn,
  moveSeat,
  moveGroup,
  handleTimer,
  addPerson,
  removePerson,
  swapBoard,
  returnBoard,
  reassignBoard,
  addBoardRental,
  pauseBoard,
  resumeBoard,
  getFloorKioskRecent,
  getFloorKioskBookingStatus
};
