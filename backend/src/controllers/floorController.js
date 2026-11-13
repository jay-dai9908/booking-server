import crypto from 'crypto';
import prisma from '../prismaClient.js';
import { getLiveFloorData, splitBoardUnits } from '../services/floor/liveService.js';
import { reseatBookings, assertNoSeatCollisions } from '../services/seating/allocator.js';
import { getActiveLayoutForDate } from '../services/seating/layoutService.js';
import { getAdminDeviceInfo } from '../utils/deviceParser.js';
import { log as auditLog } from '../services/audit/auditService.js';
import { refreshBillingCache, getBookingBill } from '../services/billing/billService.js';
import { swapBoundaryOptions, toTaipeiDateString } from '../../../shared/time.js';

export async function getLive(req, res) {
  try {
    const dateStr = req.query.date || null;
    const data = await getLiveFloorData(dateStr);

    const jsonStr = JSON.stringify(data);
    const etag = `"${crypto.createHash('md5').update(jsonStr).digest('hex')}"`;

    if (req.headers['if-none-match'] === etag) {
      return res.status(304).end();
    }

    res.setHeader('ETag', etag);
    return res.json(data);
  } catch (error) {
    console.error('[getLive] Error:', error);
    return res.status(500).json({ error: '無法讀取現場狀態', details: error.message });
  }
}

export async function checkIn(req, res) {
  const { booking_ref } = req.params;
  const { seats = [], board_assignments = [], start_timer = false, defer_seating = false } = req.body;
  const staffName = req.user?.name || '門市人員';
  const staffId = req.user?.id || null;
  const deviceInfo = getAdminDeviceInfo(req);

  try {
    const result = await prisma.$transaction(async (tx) => {
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

      // Check conflicts for seats
      const sessionIds = reservations.map(r => r.session_id);
      const conflictReservations = await tx.reservation.findMany({
        where: {
          session_id: { in: sessionIds },
          booking_ref: { not: booking_ref },
          status: { not: 'cancelled' },
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

      // Split equipment units
      await splitBoardUnits(tx, booking_ref);

      // Create or update BookingPerson
      const existingPersons = await tx.bookingPerson.findMany({
        where: { booking_ref },
        orderBy: { person_no: 'asc' }
      });

      const now = new Date();
      const dStr = typeof firstRes.session.session_date === 'string'
        ? firstRes.session.session_date.slice(0, 10)
        : firstRes.session.session_date.toISOString().slice(0, 10);
      const bookingStartDt = new Date(`${dStr}T${firstRes.session.start_time}:00+08:00`);

      // Query valid payments to check coverage (Spec 2.2 item 2)
      const validPayments = await tx.payment.findMany({
        where: {
          booking_ref,
          status: 'valid',
          kind: { in: ['charge', 'waive'] }
        }
      });

      const isBookingPaid =
        firstRes.is_paid === true ||
        firstRes.billing_status === 'paid' ||
        firstRes.billing_status === 'waived' ||
        validPayments.some(pay => !pay.person_nos || pay.person_nos.length === 0);

      const targetCount = Math.max(pax, seats.length);
      let allPersonsCovered = true;

      for (let i = 0; i < targetCount; i++) {
        const personNo = i + 1;
        const seatCode = seats[i] || null;
        const exPerson = existingPersons.find(p => p.person_no === personNo);

        const isPersonPaid =
          isBookingPaid ||
          validPayments.some(pay => Array.isArray(pay.person_nos) && pay.person_nos.includes(personNo));

        if (!isPersonPaid) {
          allPersonsCovered = false;
        }

        const personData = {
          seat_code: seatCode,
          status: 'active'
        };

        // If person is already covered by payment, do NOT start timer (Spec 2.2 item 2)
        if (start_timer && !isPersonPaid) {
          if (!exPerson?.timer_started_at) {
            personData.timer_started_at = now;
          }
          if (!exPerson?.billing_start_at) {
            personData.billing_start_at = firstRes.is_walk_in ? now : bookingStartDt;
          }
        }

        if (exPerson) {
          await tx.bookingPerson.update({
            where: { id: exPerson.id },
            data: personData
          });
        } else {
          await tx.bookingPerson.create({
            data: {
              booking_ref,
              person_no: personNo,
              ...personData,
              created_by_name: staffName
            }
          });
        }
      }

      // Assign boards to persons
      if (Array.isArray(board_assignments) && board_assignments.length) {
        const currentPersons = await tx.bookingPerson.findMany({ where: { booking_ref } });
        for (const ba of board_assignments) {
          if (!ba.unit_group) continue;
          const targetPerson = currentPersons.find(p => p.person_no === Number(ba.person_no));
          await tx.bookingEquipment.updateMany({
            where: { booking_ref, unit_group: ba.unit_group },
            data: { person_id: targetPerson ? targetPerson.id : null }
          });
        }
      }

      // Prompt 10: 整組都已付款時，attendance 仍然是 checked_in，只更新座位，不開始計時
      const finalAttendance = 'checked_in';

      // Update reservation rows
      await tx.reservation.updateMany({
        where: { booking_ref },
        data: {
          assigned_seats: seats,
          seat_source: 'staff',
          is_seat_locked: true,
          attendance: finalAttendance,
          checked_in_at: firstRes.checked_in_at || now,
          checked_in_by: staffName
        }
      });

      // Assert no collisions across all touched sessions (primary + displaced)
      const allSessionsToCheck = [...new Set([...sessionIds, ...(displaced?.touchedSessionIds || [])])];
      await assertNoSeatCollisions(tx, allSessionsToCheck);

      return {
        booking_ref,
        displaced,
        displaced_reservations: displaced.map(d => ({ ...d, new_seats: d.to }))
      };
    });

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
    return res.status(500).json({ error: '報到帶位失敗', details: error.message });
  }
}

export async function moveSeat(req, res) {
  const { booking_ref } = req.params;
  const { from_seat, to_seat, mode = 'move' } = req.body;
  const staffName = req.user?.name || '門市人員';

  try {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${booking_ref}))`;

      const reservations = await tx.reservation.findMany({
        where: { booking_ref, status: { not: 'cancelled' } },
        include: { session: true }
      });
      if (!reservations.length) throw { status: 404, message: '找不到此筆預約' };

      const sessionIds = reservations.map(r => r.session_id);

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
    });

    return res.json({ success: true, server_now: new Date().toISOString() });
  } catch (error) {
    console.error('[moveSeat] Error:', error);
    if (error.status) return res.status(error.status).json({ error: error.message });
    return res.status(500).json({ error: '換位失敗', details: error.message });
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

    let result = null;
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${booking_ref}))`;

      const reservations = await tx.reservation.findMany({
        where: { booking_ref, status: { not: 'cancelled' } },
        include: { session: true }
      });
      if (!reservations.length) throw { status: 404, message: '找不到此筆預約' };

      const sessionIds = reservations.map(r => r.session_id);
      const sessionDate = reservations[0].session.session_date;

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

      result = {
        success: true,
        new_seats: newSeats,
        table_label: targetTable.label,
        server_now: new Date().toISOString()
      };
    });

    return res.json(result);
  } catch (error) {
    console.error('[moveGroup] Error:', error);
    if (error.status) return res.status(error.status).json({ error: error.message, message: error.message });
    return res.status(500).json({ error: '整組換桌失敗', details: error.message });
  }
}

export async function handleTimer(req, res) {
  const { booking_ref } = req.params;
  const { action, person_nos = 'all', reason } = req.body;
  const staffName = req.user?.name || '門市人員';

  try {
    await prisma.$transaction(async (tx) => {
      const now = new Date();
      const wherePersons = { booking_ref, status: 'active' };
      if (person_nos !== 'all' && Array.isArray(person_nos)) {
        wherePersons.person_no = { in: person_nos.map(Number) };
      }

      const persons = await tx.bookingPerson.findMany({
        where: wherePersons,
        include: { pauses: true }
      });

      for (const p of persons) {
        if (action === 'pause') {
          if (!p.paused_at) {
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
          }
        } else if (action === 'resume') {
          if (p.paused_at) {
            const openPause = p.pauses?.find(pa => !pa.ended_at);
            let pauseDurationSec = 0;
            if (openPause) {
              pauseDurationSec = Math.floor((now.getTime() - new Date(openPause.started_at).getTime()) / 1000);
              await tx.timerPause.update({
                where: { id: openPause.id },
                data: { ended_at: now }
              });
            }
            await tx.bookingPerson.update({
              where: { id: p.id },
              data: {
                paused_at: null,
                paused_seconds: (p.paused_seconds || 0) + Math.max(0, pauseDurationSec)
              }
            });
          }
        } else if (action === 'end') {
          // If paused, end pause first
          if (p.paused_at) {
            const openPause = p.pauses?.find(pa => !pa.ended_at);
            let pauseDurationSec = 0;
            if (openPause) {
              pauseDurationSec = Math.floor((now.getTime() - new Date(openPause.started_at).getTime()) / 1000);
              await tx.timerPause.update({
                where: { id: openPause.id },
                data: { ended_at: now }
              });
            }
            await tx.bookingPerson.update({
              where: { id: p.id },
              data: {
                paused_at: null,
                paused_seconds: (p.paused_seconds || 0) + Math.max(0, pauseDurationSec),
                timer_ended_at: now
              }
            });
          } else if (!p.timer_ended_at) {
            await tx.bookingPerson.update({
              where: { id: p.id },
              data: { timer_ended_at: now }
            });
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
                data: { timer_ended_at: null }
              });
            }
          }
        }
      }

      if (action === 'end') {
        if (person_nos === 'all') {
          await tx.bookingPerson.updateMany({
            where: { booking_ref, timer_ended_at: null },
            data: { timer_ended_at: now }
          });
          await tx.reservation.updateMany({
            where: { booking_ref },
            data: { attendance: 'completed' }
          });
        } else {
          const remainingNotEnded = await tx.bookingPerson.count({
            where: {
              booking_ref,
              timer_ended_at: null,
              status: 'active'
            }
          });
          if (remainingNotEnded === 0) {
            await tx.reservation.updateMany({
              where: { booking_ref },
              data: { attendance: 'completed' }
            });
          }
        }
      } else if (action === 'restart') {
        const hasRunningPerson = await tx.bookingPerson.findFirst({
          where: {
            booking_ref,
            timer_started_at: { not: null },
            timer_ended_at: null,
            status: 'active'
          }
        });
        if (hasRunningPerson) {
          await tx.reservation.updateMany({
            where: { booking_ref, attendance: 'completed' },
            data: { attendance: 'checked_in' }
          });
        }
      }
    });

    return res.json({ success: true, server_now: new Date().toISOString() });
  } catch (error) {
    console.error('[handleTimer] Error:', error);
    return res.status(500).json({ error: '計時操作失敗', details: error.message });
  }
}

export async function addPerson(req, res) {
  const { booking_ref } = req.params;
  const { seat_code = null, force = false } = req.body;
  const staffName = req.user?.name || '門市人員';
  const staffId = req.user?.id || null;
  const deviceInfo = getAdminDeviceInfo(req);

  try {
    const result = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${booking_ref}))`;

      const reservations = await tx.reservation.findMany({
        where: { booking_ref, status: { not: 'cancelled' } },
        include: { session: true }
      });
      if (!reservations.length) throw { status: 404, message: '找不到此筆預約' };

      const firstRes = reservations[0];
      const sessionIds = reservations.map(r => r.session_id);
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

        const conflictReservations = await tx.reservation.findMany({
          where: {
            session_id: { in: sessionIds },
            booking_ref: { not: booking_ref },
            status: { not: 'cancelled' },
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

    return res.json({ success: true, person: result, server_now: new Date().toISOString() });
  } catch (error) {
    console.error('[addPerson] Error:', error);
    if (error.status) return res.status(error.status).json({ error: error.message, code: error.code });
    return res.status(500).json({ error: '加人失敗', details: error.message });
  }
}

export async function removePerson(req, res) {
  const { booking_ref, person_no } = req.params;
  const pNo = parseInt(person_no, 10);
  const staffName = req.user?.name || '門市人員';
  const staffId = req.user?.id || null;
  const deviceInfo = getAdminDeviceInfo(req);

  try {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${booking_ref}))`;

      // Check payment status of this person
      const paid = await tx.payment.findFirst({
        where: {
          booking_ref,
          status: 'valid',
          kind: { in: ['charge', 'waive'] },
          person_nos: { has: pNo }
        }
      });
      if (paid) {
        throw { status: 400, message: `第 ${pNo} 位已付款，無法直接移除` };
      }

      const person = await tx.bookingPerson.findUnique({
        where: { booking_ref_person_no: { booking_ref, person_no: pNo } }
      });
      if (!person) throw { status: 404, message: '找不到該顧客資料' };

      await tx.bookingPerson.update({
        where: { id: person.id },
        data: { status: 'removed', seat_code: null }
      });

      // Release seat if any
      if (person.seat_code) {
        const reservations = await tx.reservation.findMany({ where: { booking_ref } });
        for (const r of reservations) {
          const updatedSeats = (r.assigned_seats || []).filter(s => s !== person.seat_code);
          await tx.reservation.update({
            where: { id: r.id },
            data: { assigned_seats: updatedSeats }
          });
        }
      }

      // Reassign boards to person 1
      const p1 = await tx.bookingPerson.findFirst({
        where: { booking_ref, person_no: 1 }
      });
      if (p1) {
        await tx.bookingEquipment.updateMany({
          where: { booking_ref, person_id: person.id },
          data: { person_id: p1.id }
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
        summary: `移除 第 ${pNo} 位`,
        reason: '移除未付款顧客',
        staff_name: staffName,
        staff_id: staffId,
        device_id: deviceInfo.device_id,
        device_label: deviceInfo.device_label
      });

      await refreshBillingCache(tx, booking_ref);
    });

    return res.json({ success: true, server_now: new Date().toISOString() });
  } catch (error) {
    console.error('[removePerson] Error:', error);
    if (error.status) return res.status(error.status).json({ error: error.message });
    return res.status(500).json({ error: '移除顧客失敗', details: error.message });
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

      // Load all covered sessions of activeSeg
      const covSessionIds = (activeSeg.covered_sessions || []).map(Number);
      const coveredSessions = await tx.session.findMany({
        where: { id: { in: covSessionIds } },
        orderBy: { start_time: 'asc' }
      });

      // Determine segment start time in ms
      let segStartMs;
      if (activeSeg.start_at) {
        segStartMs = activeSeg.start_at.getTime();
      } else if (coveredSessions.length > 0) {
        const firstSess = coveredSessions[0];
        const dStr = typeof firstSess.session_date === 'string'
          ? firstSess.session_date.slice(0, 10)
          : toTaipeiDateString(firstSess.session_date);
        segStartMs = new Date(`${dStr}T${firstSess.start_time}:00+08:00`).getTime();
      } else {
        segStartMs = Date.now();
      }

      const nowMs = now ? new Date(now).getTime() : Date.now();
      const { options, suggested } = swapBoundaryOptions(segStartMs, nowMs);

      // Validate boundary_at
      let boundaryMs;
      if (boundary_at !== undefined && boundary_at !== null) {
        boundaryMs = new Date(boundary_at).getTime();
        const isValid = options.some(opt => Math.abs(opt - boundaryMs) < 60000);
        if (!isValid) {
          throw { status: 422, message: '換板時間必須是建議的半小時選項之一' };
        }
      } else {
        boundaryMs = suggested;
      }

      const boundaryDt = new Date(boundaryMs);
      const isStartBoundary = Math.abs(boundaryMs - segStartMs) < 60000;

      // Determine session partitioning
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
          if (boundaryMs >= lastEnd) {
            swapSessionIndex = coveredSessions.length - 1;
          } else {
            swapSessionIndex = 0;
          }
        }
      }

      const oldCoveredSessions = coveredSessions.slice(0, swapSessionIndex + 1).map(s => String(s.id));
      const newCoveredSessions = isStartBoundary
        ? coveredSessions.map(s => String(s.id))
        : coveredSessions.slice(swapSessionIndex).map(s => String(s.id));

      // Check stock for targetConfig in all newCoveredSessions
      const totalStock = targetConfig.total_stock;
      if (totalStock !== null && totalStock !== undefined) {
        const activeEquips = await tx.bookingEquipment.findMany({
          where: {
            equipment_id: to_equipment_id,
            OR: [
              { unit_group: null },
              { unit_group: { not: unit_group } }
            ]
          }
        });
        const activeResvs = await tx.reservation.findMany({
          where: {
            status: { not: 'cancelled' },
            booking_ref: { in: activeEquips.map(e => e.booking_ref) }
          },
          select: { booking_ref: true }
        });
        const activeBookingSet = new Set(activeResvs.map(r => r.booking_ref));
        const uncancelledEquips = activeEquips.filter(e => activeBookingSet.has(e.booking_ref));

        for (const sIdStr of newCoveredSessions) {
          const sId = Number(sIdStr);
          const occupiedCount = uncancelledEquips.filter(be => {
            const cSessions = (be.covered_sessions || []).map(Number);
            return cSessions.includes(sId);
          }).reduce((sum, be) => sum + (be.quantity || 1), 0);

          const available = totalStock - occupiedCount;
          if (available < 1) {
            throw { status: 409, message: `${targetConfig.name}剩 0 台` };
          }
        }
      }

      if (isStartBoundary) {
        await tx.bookingEquipment.update({
          where: { id: activeSeg.id },
          data: {
            equipment_id: to_equipment_id,
            equipment_name_snapshot: targetConfig.name,
            unit_rate: targetConfig.hourly_rate
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
            unit_rate: targetConfig.hourly_rate,
            planned_end_at: activeSeg.planned_end_at
          }
        });
      }

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

    return res.json({ success: true, bill: updatedBill, server_now: new Date().toISOString() });
  } catch (error) {
    console.error('[swapBoard] Error:', error);
    if (error.status) return res.status(error.status).json({ error: error.message });
    return res.status(500).json({ error: '換板失敗', details: error.message });
  }
}

export async function returnBoard(req, res) {
  const { booking_ref, unit_group } = req.params;
  const { at = new Date() } = req.body;
  const deviceInfo = getAdminDeviceInfo(req);
  const staffName = req.user?.name || '門市人員';
  const staffId = req.user?.id || null;

  try {
    const updatedBill = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${booking_ref}))`;

      const segments = await tx.bookingEquipment.findMany({
        where: { booking_ref, unit_group },
        orderBy: { segment_no: 'asc' }
      });
      if (!segments.length) throw { status: 404, message: '找不到此板子' };

      const activeSeg = segments[segments.length - 1];
      const returnDt = new Date(at);
      const returnMs = returnDt.getTime();

      const covSessionIds = (activeSeg.covered_sessions || []).map(Number);
      const coveredSessions = await tx.session.findMany({
        where: { id: { in: covSessionIds } },
        orderBy: { start_time: 'asc' }
      });

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
        ? coveredSessions.slice(0, returnIndex + 1).map(s => String(s.id))
        : [];

      await tx.bookingEquipment.update({
        where: { id: activeSeg.id },
        data: {
          end_at: returnDt,
          ended_reason: 'returned',
          covered_sessions: keptCoveredSessions
        }
      });

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

    return res.json({ success: true, bill: updatedBill, server_now: new Date().toISOString() });
  } catch (error) {
    console.error('[returnBoard] Error:', error);
    if (error.status) return res.status(error.status).json({ error: error.message });
    return res.status(500).json({ error: '歸還板子失敗', details: error.message });
  }
}

export async function reassignBoard(req, res) {
  const { booking_ref, unit_group } = req.params;
  const { person_no } = req.body;

  try {
    await prisma.$transaction(async (tx) => {
      const person = await tx.bookingPerson.findUnique({
        where: { booking_ref_person_no: { booking_ref, person_no: Number(person_no) } }
      });
      await tx.bookingEquipment.updateMany({
        where: { booking_ref, unit_group },
        data: { person_id: person ? person.id : null }
      });

      await refreshBillingCache(tx, booking_ref);
    });

    return res.json({ success: true, server_now: new Date().toISOString() });
  } catch (error) {
    console.error('[reassignBoard] Error:', error);
    return res.status(500).json({ error: '指派板子失敗', details: error.message });
  }
}

export async function addBoardRental(req, res) {
  const booking_ref = req.params.booking_ref || req.params.ref;
  const { person_no, equipment_id, from_at, to_at } = req.body;
  const staffName = req.user?.name || '門市人員';
  const staffId = req.user?.id || null;
  const deviceInfo = getAdminDeviceInfo(req);

  try {
    const result = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${booking_ref}))`;

      const reservations = await tx.reservation.findMany({
        where: { booking_ref, status: { not: 'cancelled' } },
        include: { session: true },
        orderBy: { session: { start_time: 'asc' } }
      });
      if (!reservations.length) {
        throw { status: 404, message: '找不到此筆預約' };
      }

      const pNo = Number(person_no);
      const targetPerson = await tx.bookingPerson.findFirst({
        where: { booking_ref, person_no: pNo }
      });
      if (!targetPerson) {
        throw { status: 404, message: `找不到第 ${person_no} 位顧客` };
      }

      const targetConfigs = await tx.$queryRaw`
        SELECT * FROM "EquipmentConfig" WHERE id = ${equipment_id} FOR UPDATE
      `;
      const targetConfig = targetConfigs[0];
      if (!targetConfig) {
        throw { status: 404, message: '找不到此設備尺寸' };
      }

      const firstRes = reservations[0];
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
        const now = new Date();
        fromDt = now < bookingStartDt ? bookingStartDt : now;
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
      const unitRate = targetConfig.hourly_rate || 60;
      const subtotalPrice = rentalHours * unitRate;
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
          end_at: toDt,
          planned_end_at: toDt,
          unit_rate: unitRate,
          rental_hours: rentalHours,
          subtotal_price: subtotalPrice,
          covered_sessions: coveredSessionStrings
        }
      });

      await auditLog(tx, {
        booking_ref,
        event_type: 'amount_adjusted',
        category: 'amount',
        summary: `加租智能板：第 ${pNo} 位租借 ${targetConfig.name}`,
        reason: '加租智能板',
        staff_name: staffName,
        staff_id: staffId,
        device_id: deviceInfo?.device_id,
        device_label: deviceInfo?.device_label
      });

      await refreshBillingCache(tx, booking_ref);

      return newEquipment;
    });

    return res.json({
      success: true,
      booking_equipment: result,
      server_now: new Date().toISOString()
    });
  } catch (error) {
    console.error('[addBoardRental] Error:', error);
    if (error.status) return res.status(error.status).json({ error: error.message, code: error.code });
    return res.status(500).json({ error: '加租智能板失敗', details: error.message });
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
  addBoardRental
};
