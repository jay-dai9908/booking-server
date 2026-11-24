import { splitBoardUnits } from './liveService.js';
import { assertNoSeatCollisions } from '../seating/allocator.js';
import { toTaipeiDateString } from '../../../../shared/time.js';

export function resolveBillingStartAt(firstRes, now = new Date()) {
  if (firstRes?.is_walk_in) return now;
  const sessionDate = firstRes?.session?.session_date;
  const startTime = firstRes?.session?.start_time;
  if (!sessionDate || !startTime) return now;
  const dStr = typeof sessionDate === 'string'
    ? sessionDate.slice(0, 10)
    : toTaipeiDateString(sessionDate);
  return new Date(`${dStr}T${startTime}:00+08:00`);
}

export async function isPersonPaid(tx, booking_ref, person_no, preloadedFirstRes = null) {
  const firstRes = preloadedFirstRes || await tx.reservation.findFirst({
    where: { booking_ref, status: { not: 'cancelled' } },
    include: { session: true },
    orderBy: { session: { start_time: 'asc' } }
  });
  if (!firstRes) return false;
  if (
    firstRes.is_paid === true ||
    firstRes.billing_status === 'paid' ||
    firstRes.billing_status === 'waived'
  ) {
    return true;
  }

  const pNo = Number(person_no);
  const validPay = await tx.payment.findFirst({
    where: {
      booking_ref,
      status: 'valid',
      kind: { in: ['charge', 'waive'] },
      OR: [
        { person_nos: { has: pNo } },
        { person_nos: { equals: [] } }
      ]
    },
    select: { id: true }
  });
  return Boolean(validPay);
}

/**
 * 報到共用的交易寫入步驟（門市店員帶位與門口報到機報到共用）：
 * 1) 拆解智能板為一機一列（splitBoardUnits）
 * 2) 建立／更新 BookingPerson 與座位對應（已付清人員不啟動計時器）
 * 3) 更新所有時段列之座位鎖定與首次報到狀態
 * 4) 執行 assertNoSeatCollisions 最終防撞驗證
 */
export async function applyCheckInRecords(tx, {
  booking_ref,
  reservations,
  seats = [],
  board_assignments = [],
  start_timer = false,
  staffName = '門市人員',
  seat_source = undefined,
  is_seat_locked = true,
  now = new Date(),
  touchedSessionIds = []
}) {
  const firstRes = reservations[0];
  const pax = firstRes.pax;
  const sessionIds = reservations.map((r) => r.session_id);

  // Split equipment units so smart board rows match 1 unit per row identically
  await splitBoardUnits(tx, booking_ref);

  const existingPersons = await tx.bookingPerson.findMany({
    where: { booking_ref },
    orderBy: { person_no: 'asc' }
  });

  const billingStartDefault = resolveBillingStartAt(firstRes, now);

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
    validPayments.some((pay) => !pay.person_nos || pay.person_nos.length === 0);

  const targetCount = Math.max(pax, seats.length);

  for (let i = 0; i < targetCount; i++) {
    const personNo = i + 1;
    const seatCode = seats[i] || null;
    const exPerson = existingPersons.find((p) => p.person_no === personNo);

    const isPaidPerson =
      isBookingPaid ||
      validPayments.some((pay) => Array.isArray(pay.person_nos) && pay.person_nos.includes(personNo));

    const personData = {
      seat_code: seatCode,
      status: 'active'
    };

    if (start_timer && !isPaidPerson) {
      if (!exPerson?.timer_started_at) {
        personData.timer_started_at = now;
      }
      if (!exPerson?.billing_start_at) {
        personData.billing_start_at = billingStartDefault;
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

  if (Array.isArray(board_assignments) && board_assignments.length) {
    const currentPersons = await tx.bookingPerson.findMany({ where: { booking_ref } });
    for (const ba of board_assignments) {
      if (!ba.unit_group) continue;
      const targetPerson = currentPersons.find((p) => p.person_no === Number(ba.person_no));
      await tx.bookingEquipment.updateMany({
        where: { booking_ref, unit_group: ba.unit_group },
        data: { person_id: targetPerson ? targetPerson.id : null }
      });
    }
  }

  const updateData = {
    assigned_seats: seats,
    is_seat_locked,
    attendance: 'checked_in',
    checked_in_at: firstRes.checked_in_at || now,
    checked_in_by: staffName
  };
  if (seat_source !== undefined) {
    updateData.seat_source = seat_source;
  }

  await tx.reservation.updateMany({
    where: { booking_ref },
    data: updateData
  });

  const allSessionsToCheck = [...new Set([...sessionIds, ...(touchedSessionIds || [])])];
  await assertNoSeatCollisions(tx, allSessionsToCheck);
}
