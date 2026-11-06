import crypto from 'crypto';
import prisma from '../prismaClient.js';
import { getLiveFloorData, splitBoardUnits } from '../services/floor/liveService.js';
import { reseatBookings } from '../services/seating/allocator.js';
import { getActiveLayoutForDate } from '../services/seating/layoutService.js';
import { getAdminDeviceInfo } from '../utils/deviceParser.js';
import { log as auditLog } from '../services/audit/auditService.js';
import { refreshBillingCache, getBookingBill } from '../services/billing/billService.js';

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

      const displacedRefs = [...new Set(conflictReservations.map(cr => cr.booking_ref))];
      const displaced = await reseatBookings(tx, {
        bookingRefs: displacedRefs,
        reservedSeats: seats,
        sessionIds
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

      const targetCount = Math.max(pax, seats.length);
      for (let i = 0; i < targetCount; i++) {
        const personNo = i + 1;
        const seatCode = seats[i] || null;
        const exPerson = existingPersons.find(p => p.person_no === personNo);

        const personData = {
          seat_code: seatCode,
          status: 'active'
        };

        if (start_timer) {
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

      // Update reservation rows
      await tx.reservation.updateMany({
        where: { booking_ref },
        data: {
          assigned_seats: seats,
          seat_source: 'staff',
          is_seat_locked: true,
          attendance: 'checked_in',
          checked_in_at: firstRes.checked_in_at || now,
          checked_in_by: staffName
        }
      });

      return { booking_ref, displaced };
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

      // Validate to_seat exists and is active on layout
      const sessionDate = reservations[0].session.session_date;
      const activeLayout = await getActiveLayoutForDate(tx, sessionDate);
      const layoutSeats = activeLayout?.seats || [];
      const targetSeatObj = layoutSeats.find(ls => ls.code === to_seat);
      if (!targetSeatObj || !targetSeatObj.is_active) {
        throw { status: 400, message: `目標座位 ${to_seat} 不存在或未啟用` };
      }

      // Check target occupancy
      const targetConflict = await tx.reservation.findFirst({
        where: {
          session_id: { in: sessionIds },
          booking_ref: { not: booking_ref },
          status: { not: 'cancelled' },
          assigned_seats: { has: to_seat }
        },
        include: { user: true }
      });

      if (targetConflict) {
        if (mode === 'swap') {
          // Check that target occupies to_seat in ALL sessions of its booking
          const targetAllResvs = await tx.reservation.findMany({
            where: { booking_ref: targetConflict.booking_ref, status: { not: 'cancelled' } }
          });
          const allSitToSeat = targetAllResvs.every(r => r.assigned_seats?.includes(to_seat));
          if (!allSitToSeat) {
            throw { status: 409, message: '目標座位佔用者在不同時段座位不一致，無法對調' };
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
          if (targetConflict.is_seat_locked || targetConflict.attendance === 'checked_in' || targetConflict.seat_source === 'staff') {
            throw { status: 409, message: `目標座位已被固定的預約（${targetConflict.user?.name || '客人'}）佔用` };
          }

          // Displace using reseatBookings
          await reseatBookings(tx, {
            bookingRefs: [targetConflict.booking_ref],
            reservedSeats: [to_seat],
            sessionIds
          });
        }
      }

      // Update current booking seats
      const currentRes = reservations[0];
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
    });

    return res.json({ success: true, server_now: new Date().toISOString() });
  } catch (error) {
    console.error('[moveSeat] Error:', error);
    if (error.status) return res.status(error.status).json({ error: error.message });
    return res.status(500).json({ error: '換位失敗', details: error.message });
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
          // Check if person has valid payment
          const isPaid = await tx.payment.findFirst({
            where: {
              booking_ref,
              status: 'valid',
              kind: { in: ['charge', 'waive'] },
              person_nos: { has: p.person_no }
            }
          });
          if (!isPaid) {
            await tx.bookingPerson.update({
              where: { id: p.id },
              data: { timer_ended_at: null }
            });
          }
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

      // Check session capacities
      if (!force) {
        for (const r of reservations) {
          const bookedPax = await tx.reservation.aggregate({
            where: { session_id: r.session_id, status: { not: 'cancelled' } },
            _sum: { pax: true }
          });
          const totalBooked = (bookedPax._sum.pax || 0) + 1;
          if (totalBooked > r.session.max_capacity) {
            throw {
              status: 409,
              code: 'OVER_CAPACITY',
              message: `該時段（${r.session.start_time} - ${r.session.end_time}）人數已達上限 ${r.session.max_capacity} 人`
            };
          }
        }
      }

      // Increment pax
      await tx.reservation.updateMany({
        where: { booking_ref },
        data: { pax: { increment: 1 } }
      });

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

      if (seat_code) {
        // Validate seat_code exists and active on layout
        const sessionDate = reservations[0].session.session_date;
        const activeLayout = await getActiveLayoutForDate(tx, sessionDate);
        const targetSeatObj = (activeLayout?.seats || []).find(ls => ls.code === seat_code);
        if (!targetSeatObj || !targetSeatObj.is_active) {
          throw { status: 400, message: `座位 ${seat_code} 不存在或未啟用` };
        }

        const sessionIds = reservations.map(r => r.session_id);
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
        await reseatBookings(tx, {
          bookingRefs: conflictRefs,
          reservedSeats: [seat_code],
          sessionIds
        });

        const firstRes = reservations[0];
        const newSeats = [...(firstRes.assigned_seats || []), seat_code];
        await tx.reservation.updateMany({
          where: { booking_ref },
          data: { assigned_seats: newSeats }
        });
      }

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
  const { to_equipment_id, boundary_at } = req.body;

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
      const boundaryDt = new Date(boundary_at);

      // Close current segment
      await tx.bookingEquipment.update({
        where: { id: activeSeg.id },
        data: {
          end_at: boundaryDt,
          ended_reason: 'swapped'
        }
      });

      // Create next segment
      await tx.bookingEquipment.create({
        data: {
          booking_ref,
          equipment_id: to_equipment_id,
          equipment_name_snapshot: targetConfig.name,
          quantity: 1,
          rental_hours: activeSeg.rental_hours,
          subtotal_price: 0,
          covered_sessions: activeSeg.covered_sessions,
          person_id: activeSeg.person_id,
          unit_group: activeSeg.unit_group,
          segment_no: activeSeg.segment_no + 1,
          start_at: boundaryDt,
          end_at: activeSeg.planned_end_at,
          unit_rate: targetConfig.hourly_rate,
          planned_end_at: activeSeg.planned_end_at
        }
      });

      await refreshBillingCache(tx, booking_ref);
      return await getBookingBill(booking_ref, tx);
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

  try {
    const updatedBill = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${booking_ref}))`;

      const segments = await tx.bookingEquipment.findMany({
        where: { booking_ref, unit_group },
        orderBy: { segment_no: 'asc' }
      });
      if (!segments.length) throw { status: 404, message: '找不到此板子' };

      const activeSeg = segments[segments.length - 1];
      await tx.bookingEquipment.update({
        where: { id: activeSeg.id },
        data: {
          end_at: new Date(at),
          ended_reason: 'returned'
        }
      });

      await refreshBillingCache(tx, booking_ref);
      return await getBookingBill(booking_ref, tx);
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
    });

    return res.json({ success: true, server_now: new Date().toISOString() });
  } catch (error) {
    console.error('[reassignBoard] Error:', error);
    return res.status(500).json({ error: '指派板子失敗', details: error.message });
  }
}

export default {
  getLive,
  checkIn,
  moveSeat,
  handleTimer,
  addPerson,
  removePerson,
  swapBoard,
  returnBoard,
  reassignBoard
};
