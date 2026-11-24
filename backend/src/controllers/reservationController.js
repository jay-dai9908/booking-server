import prisma from '../prismaClient.js';
import { Prisma } from '@prisma/client';
import crypto from 'crypto';
import { allocateSeats } from '../utils/SeatAllocator.js';
import { loadAllocatorContext, getActiveLayoutForDate, loadSeatedOccupants, lockDaySeats } from '../services/seating/layoutService.js';
import { isReservationPinned, reseatBookings, MOVABLE_RESERVATION_FILTER, assertNoSeatCollisions } from '../services/seating/allocator.js';
import { isPersonPaid } from '../services/floor/checkInService.js';
import { calculateEquipmentChargeableHours } from '../utils/equipmentPricing.js';
import { resolveEquipmentWindow } from '../utils/equipmentWindow.js';
import { evaluatePromoCode } from './checkoutController.js';
import {
  sendBookingConfirmationNotification,
  sendBookingCancellationNotification,
  sendSelfServiceTransferPendingNotification
} from '../utils/lineMessaging.js';
import { markUnpaid, collectPayment, saveDraft, getBookingBill, refreshBillingCache, buildInitialDraft } from '../services/billing/billService.js';
import { redeemPromo, releasePromo } from '../services/promo/redemption.js';
import { deductPass, restorePass } from '../services/billing/passTender.js';
import { assignPoolAccount, releasePoolAccount } from '../services/selfService/poolAccountService.js';
import { log as auditLog } from '../services/audit/auditService.js';
import {
  ensureKioskSetting,
  computeSelfServiceQuote,
  settleSelfServiceBooking,
  attachSelfInfoToReservations,
  makePrepayError,
  lockPrepay
} from '../services/selfService/prepayService.js';
import { earliestEntry, ironText } from '../../../shared/selfService.js';
import { getAdminDeviceInfo } from '../utils/deviceParser.js';
import { dateOnly, toTaipeiDateString } from '../../../shared/time.js';
import { getReservationEntryPass } from '../services/kiosk/entryService.js';
import { isPlainString } from '../utils/phone.js';
import { activeUserWhere } from '../utils/userQuery.js';
import displayBus from '../services/display/displayBus.js';

function mergeCustomerEquipments(rawList = []) {
  if (!Array.isArray(rawList) || rawList.length === 0) return [];

  const byUnitGroup = new Map();
  const withoutUnitGroup = [];

  for (const eq of rawList) {
    if (eq.unit_group) {
      if (!byUnitGroup.has(eq.unit_group)) byUnitGroup.set(eq.unit_group, []);
      byUnitGroup.get(eq.unit_group).push(eq);
    } else {
      withoutUnitGroup.push(eq);
    }
  }

  const result = [];

  for (const [uGroup, segs] of byUnitGroup.entries()) {
    if (segs.length > 1 || segs.some(s => s.ended_reason === 'swapped')) {
      for (const s of segs) {
        let timeSuffix = '';
        if (s.start_at && s.end_at) {
          const from = new Date(s.start_at).toLocaleTimeString('zh-TW', { hour12: false, hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Taipei' });
          const to = new Date(s.end_at).toLocaleTimeString('zh-TW', { hour12: false, hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Taipei' });
          timeSuffix = ` (${from}-${to})`;
        }
        result.push({
          ...s,
          equipment_name_snapshot: `${s.equipment_name_snapshot || ''}${timeSuffix}`
        });
      }
    } else {
      withoutUnitGroup.push(segs[0]);
    }
  }

  const mergedMap = new Map();
  for (const eq of withoutUnitGroup) {
    const key = `${eq.equipment_id}|${(eq.covered_sessions || []).join(',')}|${eq.rental_hours}`;
    if (!mergedMap.has(key)) {
      mergedMap.set(key, { ...eq });
    } else {
      const existing = mergedMap.get(key);
      existing.quantity = (existing.quantity || 1) + (eq.quantity || 1);
      existing.subtotal_price = (existing.subtotal_price || 0) + (eq.subtotal_price || 0);
    }
  }

  return [...result, ...Array.from(mergedMap.values())];
}

// Helper function to group reservations by booking_ref
const groupReservations = (reservations, equipmentsMap = {}, options = {}) => {
  const includeAdminNote = options.includeAdminNote !== false;
  const groups = {};
  for (const r of reservations) {
    const ref = r.booking_ref;
    if (!groups[ref]) {
      groups[ref] = {
        booking_ref: ref,
        user_id: r.user_id,
        user: r.user,
        pax: r.pax,
        status: r.status,
        attendance: r.attendance,
        checked_in_at: r.checked_in_at || null,
        checked_in_by: r.checked_in_by || null,
        seat_source: r.seat_source || 'auto',
        billing_status: r.billing_status || null,
        amount_due: r.amount_due ?? null,
        amount_received: r.amount_received ?? 0,
        paid_persons: r.paid_persons ?? 0,
        has_refund: r.has_refund || false,
        created_at: r.created_at,
        session_date: r.session.session_date,
        sessions: [],
        assigned_seats: r.assigned_seats || [],
        is_seat_locked: r.is_seat_locked || false,
        is_force_split: r.is_force_split || false,
        is_unlimited: r.is_unlimited || false,
        is_paid: r.is_paid || false,
        paid_at: r.paid_at || null,
        payment_method: r.payment_method || null,
        total_amount: r.total_amount ?? null,
        is_amount_manual: r.is_amount_manual || false,
        checkout_unlimited_pax: r.checkout_unlimited_pax ?? null,
        checkout_regular_hours: r.checkout_regular_hours ?? null,
        checkout_details: r.checkout_details || null,
        promo_code: r.promo_code || null,
        discount_amount: r.discount_amount || 0,
        addons_amount: r.addons_amount || 0,
        customer_note: r.customer_note || null,
        admin_note: includeAdminNote ? (r.admin_note || null) : undefined,
        is_self_service: Boolean(r.is_self_service),
        cancelled_at: r.cancelled_at || null,
        cancelled_by: r.cancelled_by || null
      };
    } else {
      if (r.attendance === 'checked_in') {
        groups[ref].attendance = 'checked_in';
      } else if (!groups[ref].attendance && r.attendance) {
        groups[ref].attendance = r.attendance;
      }
      if (r.checked_in_by && !groups[ref].checked_in_by) {
        groups[ref].checked_in_by = r.checked_in_by;
      }
      if (r.seat_source && groups[ref].seat_source === 'auto') {
        groups[ref].seat_source = r.seat_source;
      }
      if (r.billing_status) groups[ref].billing_status = r.billing_status;
      if (r.amount_due != null) groups[ref].amount_due = r.amount_due;
      if (r.amount_received) groups[ref].amount_received = r.amount_received;
      if (r.paid_persons) groups[ref].paid_persons = r.paid_persons;
      if (r.has_refund) groups[ref].has_refund = true;

      if (r.checked_in_at) {
        if (!groups[ref].checked_in_at || new Date(r.checked_in_at) < new Date(groups[ref].checked_in_at)) {
          groups[ref].checked_in_at = r.checked_in_at;
        }
      }

      if (r.created_at) {
        if (!groups[ref].created_at || new Date(r.created_at) < new Date(groups[ref].created_at)) {
          groups[ref].created_at = r.created_at;
        }
      }

      if (r.is_paid) {
        groups[ref].is_paid = true;
      }
      if (r.paid_at && !groups[ref].paid_at) {
        groups[ref].paid_at = r.paid_at;
      }
      if (r.payment_method && !groups[ref].payment_method) {
        groups[ref].payment_method = r.payment_method;
      }
      if (r.total_amount != null && groups[ref].total_amount == null) {
        groups[ref].total_amount = r.total_amount;
      }
      if (r.checkout_details && !groups[ref].checkout_details) {
        groups[ref].checkout_details = r.checkout_details;
      }
      if (r.promo_code && !groups[ref].promo_code) {
        groups[ref].promo_code = r.promo_code;
      }
      if (r.discount_amount && !groups[ref].discount_amount) {
        groups[ref].discount_amount = r.discount_amount;
      }
      if (r.addons_amount && !groups[ref].addons_amount) {
        groups[ref].addons_amount = r.addons_amount;
      }
      if (r.customer_note && !groups[ref].customer_note) {
        groups[ref].customer_note = r.customer_note;
      }
      if (includeAdminNote && r.admin_note && !groups[ref].admin_note) {
        groups[ref].admin_note = r.admin_note;
      }
    }
    groups[ref].sessions.push(r.session);
  }

  // Calculate start and end times for each group
  return Object.values(groups).map(group => {
    // Sort sessions by start_time
    group.sessions.sort((a, b) => a.start_time.localeCompare(b.start_time));
    const start_time = group.sessions[0].start_time;
    const end_time = group.sessions[group.sessions.length - 1].end_time;
    
    const time_blocks = [];
    let current_block = null;
    
    for (const session of group.sessions) {
      if (!current_block) {
        current_block = { start_time: session.start_time, end_time: session.end_time };
      } else {
        if (session.start_time === current_block.end_time) {
          current_block.end_time = session.end_time;
        } else {
          time_blocks.push(current_block);
          current_block = { start_time: session.start_time, end_time: session.end_time };
        }
      }
    }
    if (current_block) time_blocks.push(current_block);

    const cleanRef = group.booking_ref.replace(/^BK-/i, '');
    const ref_display = `BK-${cleanRef.slice(0, 4).toUpperCase()}-${cleanRef.slice(-4).toUpperCase()}`;

    const billing = {
      status: group.billing_status || (group.is_paid ? 'paid' : 'unpaid'),
      amount_due: group.amount_due ?? group.total_amount ?? 0,
      amount_received: group.amount_received ?? (group.is_paid ? (group.total_amount ?? 0) : 0),
      paid_persons: group.paid_persons ?? (group.is_paid ? group.pax : 0),
      persons_total: group.pax,
      has_refund: Boolean(group.has_refund)
    };

    const rawEquipments = equipmentsMap[group.booking_ref] || [];
    const finalEquipments = options.mergeEquipments ? mergeCustomerEquipments(rawEquipments) : rawEquipments;
    
    return {
      booking_ref: group.booking_ref,
      ref_display,
      user_id: group.user_id,
      user: group.user,
      pax: group.pax,
      status: group.status,
      attendance: group.attendance,
      checked_in_by: group.checked_in_by,
      seat_source: group.seat_source,
      billing,
      created_at: group.created_at,
      session_date: group.session_date,
      start_time,
      end_time,
      time_blocks,
      session_count: group.sessions.length,
      assigned_seats: group.assigned_seats,
      is_seat_locked: group.is_seat_locked,
      is_force_split: group.is_force_split,
      is_unlimited: group.is_unlimited,
      is_paid: group.is_paid,
      paid_at: group.paid_at,
      payment_method: group.payment_method,
      total_amount: group.total_amount,
      is_amount_manual: group.is_amount_manual,
      checkout_unlimited_pax: group.checkout_unlimited_pax,
      checkout_regular_hours: group.checkout_regular_hours,
      checkout_details: group.checkout_details,
      promo_code: group.promo_code,
      discount_amount: group.discount_amount,
      addons_amount: group.addons_amount,
      customer_note: group.customer_note || null,
      admin_note: group.admin_note || null,
      is_self_service: Boolean(group.is_self_service),
      cancelled_at: group.cancelled_at,
      cancelled_by: group.cancelled_by,
      checked_in_at: group.checked_in_at || null,
      equipments: finalEquipments
    };
  });
};

/**
 * Format session objects into a merged, continuous timeRange string
 * e.g. "10:00 - 12:00" or "10:00 - 11:00, 14:00 - 15:00"
 */
export const formatSessionsToTimeRange = (sessions = []) => {
  if (!Array.isArray(sessions) || sessions.length === 0) return '';
  const sorted = [...sessions].sort((a, b) => (a.start_time || '').localeCompare(b.start_time || ''));
  const blocks = [];
  let currentBlock = null;

  for (const s of sorted) {
    if (!currentBlock) {
      currentBlock = { start_time: s.start_time, end_time: s.end_time };
    } else {
      if (s.start_time === currentBlock.end_time) {
        currentBlock.end_time = s.end_time;
      } else {
        blocks.push(currentBlock);
        currentBlock = { start_time: s.start_time, end_time: s.end_time };
      }
    }
  }
  if (currentBlock) blocks.push(currentBlock);

  return blocks.map(b => `${b.start_time} - ${b.end_time}`).join(', ');
};

// Helper to resolve daily pricing rates
export const getEffectiveDailyRates = async (tx, sessionDate) => {
  const dOnly = dateOnly(sessionDate);
  const dailySetting = await tx.dailySetting.findUnique({
    where: { date: dOnly }
  });

  let hourly_price = dailySetting?.hourly_price;
  let unlimited_price = dailySetting?.unlimited_price;
  const allow_unlimited = dailySetting?.allow_unlimited ?? true;

  const dayOfWeek = dOnly.getUTCDay();
  const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;

  if (hourly_price == null || unlimited_price == null) {
    const globalSetting = await tx.globalSetting.findUnique({
      where: { id: 1 }
    });

    if (!globalSetting) {
      hourly_price = hourly_price ?? (isWeekend ? 180 : 150);
      unlimited_price = unlimited_price ?? (isWeekend ? 1100 : 750);
    } else {
      hourly_price = hourly_price ?? (isWeekend ? globalSetting.weekend_hourly_price : globalSetting.weekday_hourly_price);
      unlimited_price = unlimited_price ?? (isWeekend ? globalSetting.weekend_unlimited_price : globalSetting.weekday_unlimited_price);
    }
  }

  return { hourly_price, unlimited_price, allow_unlimited, is_weekend: isWeekend };
};

function computeBookedHours(sortedSessions = [], fallbackCount = 1) {
  if (!Array.isArray(sortedSessions) || sortedSessions.length === 0) return fallbackCount;
  const first = sortedSessions[0];
  const last = sortedSessions[sortedSessions.length - 1];
  const startDt = new Date(`2000-01-01T${first.start_time}:00+08:00`);
  const endDt = new Date(`2000-01-01T${last.end_time}:00+08:00`);
  const mins = Math.max(0, Math.floor((endDt.getTime() - startDt.getTime()) / 60000));
  return mins > 0 ? mins / 60 : fallbackCount;
}

// Helper function to calculate total amount based on pricing rules
export const calculateTotalAmount = async (tx, sessionDate, pax, sessionCount, is_unlimited) => {
  const { hourly_price, unlimited_price, allow_unlimited } = await getEffectiveDailyRates(tx, sessionDate);

  const perPaxHourlyCost = Math.round(hourly_price * sessionCount);
  const calculatedHourlyTotal = pax * perPaxHourlyCost;
  const calculatedUnlimitedTotal = pax * unlimited_price;

  if (is_unlimited && allow_unlimited) {
    return calculatedUnlimitedTotal;
  }
  if (allow_unlimited) {
    return Math.min(calculatedHourlyTotal, calculatedUnlimitedTotal);
  }
  return calculatedHourlyTotal;
};

/**
 * Master unified order recalculation engine
 * Ensures seating fees (with unlimited auto-cap), equipment fees (with buy/free discounts & daily caps),
 * addon amounts, and valid promo discounts are never wiped or desynchronized across operations.
 */
export const recalculateReservationTotal = async (txOrPrisma, booking_ref) => {
  const reservations = await txOrPrisma.reservation.findMany({
    where: { booking_ref, status: 'confirmed' },
    include: { session: true }
  });
  if (!reservations || reservations.length === 0) return 0;
  const firstRes = reservations[0];
  if (firstRes.is_amount_manual) {
    return firstRes.total_amount;
  }

  const sessionDate = firstRes.session.session_date;
  const pax = firstRes.pax;
  const is_unlimited = Boolean(firstRes.is_unlimited);
  const baseSeatingPrice = await calculateTotalAmount(txOrPrisma, sessionDate, pax, reservations.length, is_unlimited);

  const eqRecords = await txOrPrisma.bookingEquipment.findMany({
    where: { booking_ref }
  });
  const equipmentTotal = eqRecords.reduce((sum, e) => sum + (e.subtotal_price || 0), 0);
  const addonsAmount = firstRes.addons_amount || 0;
  const subtotalBeforeDiscount = baseSeatingPrice + equipmentTotal + addonsAmount;

  let discountAmount = firstRes.discount_amount || 0;
  if (firstRes.promo_code) {
    try {
      const { hourly_price } = await getEffectiveDailyRates(txOrPrisma, sessionDate);
      const promoEval = await evaluatePromoCode(txOrPrisma, {
        code: firstRes.promo_code,
        session_date: sessionDate,
        pax,
        hours: reservations.length,
        is_unlimited,
        base_amount: subtotalBeforeDiscount,
        hourly_price,
        user_id: firstRes.user_id,
        skip_usage_check: true,
        seating_amount: baseSeatingPrice,
        equipment_amount: equipmentTotal
      });
      if (promoEval.valid) {
        discountAmount = promoEval.discount_amount;
      }
    } catch (err) {
      console.warn(`[recalculateReservationTotal] Promo re-eval failed for ${booking_ref}:`, err);
    }
  }

  const finalTotal = Math.max(0, subtotalBeforeDiscount - discountAmount);

  await txOrPrisma.reservation.updateMany({
    where: { booking_ref },
    data: {
      total_amount: finalTotal,
      discount_amount: discountAmount
    }
  });

  return finalTotal;
};

function buildPrepayQuoteResponse(quote, overrides = {}) {
  return {
    total_amount: quote.total_amount,
    persons: quote.persons,
    pass_persons: quote.pass_persons,
    unpaid_entry_persons: quote.unpaid_entry_persons,
    entry_amount: quote.entry_amount,
    board_amount: quote.board_amount,
    promo: quote.promo
      ? {
          code: quote.promo.code,
          discount: quote.promo.discount,
          applies_to_persons: quote.promo.applies_to_persons
        }
      : null,
    pass_units: quote.pass_units,
    transfer_amount: quote.transfer_amount,
    transfer_open: quote.transfer_open,
    ...overrides
  };
}

export const createReservationHandler = (deps = {}) => async (req, res) => {
  const getBillFn = deps.getBookingBill || getBookingBill;
  const { session_ids, pax, forceSplit } = req.body;
  const userId = req.user.id;

  const parsedPax = parseInt(pax, 10);
  if (!Array.isArray(session_ids) || session_ids.length === 0 || !Number.isInteger(parsedPax) || parsedPax < 1) {
    return res.status(400).json({ error: '人數必須為大於 0 的正整數，且必須選擇至少一個時段' });
  }

  try {
    const booking_ref = crypto.randomUUID();

    const result = await prisma.$transaction(async (tx) => {
      // 0. Verify customer blacklist status
      const user = await tx.user.findUnique({ where: { id: userId } });
      if (user?.is_blacklisted) {
        throw new Error('BLACKLISTED_USER');
      }

      // 1. Get the requested sessions
      const requestedSessions = await tx.$queryRaw`
        SELECT id, max_capacity, session_date, start_time, end_time
        FROM "Session" 
        WHERE id IN (${Prisma.join(session_ids)}) 
        FOR UPDATE
      `;

      if (requestedSessions.length !== session_ids.length) {
        throw new Error('SOME_SESSIONS_NOT_FOUND');
      }

      // 檢查是否跨日期：一筆預約只能包含同一天的時段
      const uniqueDates = new Set(
        requestedSessions.map(s => {
          return s.session_date instanceof Date
            ? s.session_date.toISOString().slice(0, 10)
            : String(s.session_date).slice(0, 10);
        })
      );
      if (uniqueDates.size > 1) {
        throw new Error('CROSS_DATE_SESSIONS');
      }

      const sessionDate = requestedSessions[0].session_date;

      // Lock ALL sessions for the same date to prevent race conditions across the day
      const dateStr = toTaipeiDateString(sessionDate);
      const allSessionsOfDay = await tx.$queryRaw`
        SELECT id
        FROM "Session"
        WHERE session_date = ${dateStr}::date
        FOR UPDATE
      `;
      await lockDaySeats(tx, dateStr);
      const allSessionIdsOfDay = allSessionsOfDay.map(s => s.id);

      // Fetch all confirmed reservations for the day
      const currentReservations = await tx.reservation.findMany({
        where: { session_id: { in: allSessionIdsOfDay }, status: 'confirmed' }
      });

      // Prepare the new reservation block
      const newReservationBlock = { 
        booking_ref: 'NEW_RES', 
        pax: parseInt(pax, 10), 
        session_ids: session_ids 
      };

      // Strict capacity check before allocation
      for (const reqSession of requestedSessions) {
        const bookedPax = currentReservations
          .filter(r => r.session_id === reqSession.id)
          .reduce((sum, r) => sum + r.pax, 0);
        
        if (reqSession.max_capacity - bookedPax < parseInt(pax, 10)) {
          throw new Error('INSUFFICIENT_CAPACITY');
        }
      }

      // Run Continuous Block Allocation algorithm
      const ctx = await loadAllocatorContext(tx, sessionDate);
      const allocResult = allocateSeats(currentReservations, newReservationBlock, forceSplit === true, ctx);

      if (!allocResult.success) {
        if (allocResult.error === 'INSUFFICIENT_SEATS') throw new Error('INSUFFICIENT_CAPACITY');
        if (allocResult.error === 'SPLIT_REQUIRED') throw new Error('SPLIT_REQUIRED');
        throw new Error('ALLOCATION_FAILED');
      }

      if (process.env.NODE_ENV === 'test' && Number(req.body?.__testDelayAfterAllocMs) > 0) {
        await new Promise((resolve) => setTimeout(resolve, Math.min(Number(req.body.__testDelayAfterAllocMs), 5000)));
      }

      // Apply Reshuffle Updates to existing reservations
      const sessionUpdates = []; 
      const newReservationsData = [];
      const mySeats = allocResult.updates.find(u => u.booking_ref === 'NEW_RES')?.assigned_seats || [];
      const is_unlimited = req.body.isUnlimited === true;
      const cleanCustomerNote = req.body.customer_note ? String(req.body.customer_note).trim() : null;
      const sortedRequestedSessions = [...requestedSessions].sort((a, b) => a.start_time.localeCompare(b.start_time));

      const dailySetting = await tx.dailySetting.findUnique({
        where: { date: new Date(`${dateStr}T00:00:00.000Z`) }
      });
      const isSelfServiceDay = Boolean(dailySetting?.is_self_service);
      if (isSelfServiceDay) {
        if (req.body.self_service_ack !== true) {
          throw makePrepayError('SELF_ACK_REQUIRED', '請先勾選同意半自助時段須知', 400);
        }
        if (!req.body.prepay || typeof req.body.prepay !== 'object') {
          throw makePrepayError('PREPAY_REQUIRED', '半自助預約必須提供預付付款資訊', 400);
        }
      }

      if (isSelfServiceDay) {
        const prepayPayload = req.body.prepay || {};
        const kioskSetting = await ensureKioskSetting(tx);
        const dailyRates = await getEffectiveDailyRates(tx, sessionDate);

        const quote = await computeSelfServiceQuote(tx, {
          userId,
          requestedSessions: sortedRequestedSessions,
          dailySetting,
          dailyRates,
          kioskSetting,
          pax: parsedPax,
          isUnlimited: is_unlimited,
          equipments: req.body.equipments || [],
          promoCode: req.body.promo_code || null,
          passUses: prepayPayload.pass_uses || [],
          strict: true,
          skipUsageCheck: false
        });

        if (
          prepayPayload.expected_transfer_amount !== undefined &&
          prepayPayload.expected_transfer_amount !== null &&
          Number(prepayPayload.expected_transfer_amount) !== quote.transfer_amount
        ) {
          throw makePrepayError('AMOUNT_CHANGED', '預約金額已變動，請確認最新金額後再送出', 409, {
            quote: buildPrepayQuoteResponse(quote)
          });
        }

        let paymentMethodCode = null;
        let selectedBankInfo = null;
        let assignedPoolAccount = null;
        let assignedPoolUrl = null;

        if (quote.transfer_amount > 0) {
          if (!quote.transfer_open) {
            throw makePrepayError('PREPAY_DEADLINE_PASSED', '已超過半自助日匯款期限，無法成立需要匯款的預約', 409);
          }

          // Serialize concurrent self-service bookings from the same member before counting unpaid orders
          await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${userId} FOR UPDATE`;

          const maxUnpaid = kioskSetting.max_unpaid_self_bookings ?? 2;
          const unpaidCount = await tx.bookingPrepay.count({
            where: { user_id: userId, status: 'pending_payment' }
          });
          if (unpaidCount >= maxUnpaid) {
            throw makePrepayError('TOO_MANY_UNPAID', `待付款的半自助預約已達上限（${maxUnpaid} 筆）`, 409);
          }

          const transferInput = prepayPayload.transfer || {};
          paymentMethodCode = transferInput.payment_method_code || transferInput.code || null;
          selectedBankInfo = transferInput.selected_bank_info || transferInput.bank_info || null;
          if (!paymentMethodCode) {
            throw makePrepayError('PREPAY_REQUIRED', '請選擇匯款方式', 400);
          }

          const methodCfg = await tx.paymentMethodConfig.findUnique({
            where: { code: String(paymentMethodCode) }
          });
          if (!methodCfg || !methodCfg.is_enabled || methodCfg.method_type === 'ONSITE') {
            throw makePrepayError('PREPAY_REQUIRED', '選擇的匯款方式無效或未啟用', 400);
          }

          const needsPoolAccount =
            methodCfg.method_type === 'POOL_ACCOUNT' || methodCfg.code === 'ctbc_pool';
          if (needsPoolAccount) {
            const allocated = await assignPoolAccount(tx, {
              userId,
              orderRef: booking_ref,
              paymentMethodCode: methodCfg.code,
              maxHolds: 2,
              checkHoldLimit: true,
              holdLimitMessage: '您目前已有 2 筆待付款並佔用專屬收款帳號的訂單／預約，請先完成匯款回報，或聯繫門市人員協助！'
            });
            if (!allocated) {
              throw makePrepayError('NO_POOL_ACCOUNT', '目前專屬收款帳號已發完，請改選其他匯款方式', 409);
            }
            assignedPoolAccount = allocated.accountNumber;
            assignedPoolUrl = allocated.paymentUrl;
          }
        }

        // Deduct punch card holds immediately upon reservation submission
        const passHolds = [];
        const holdUseDateStr = toTaipeiDateString(sessionDate);
        for (const hold of quote.pass_holds_plan) {
          const updatedPass = await deductPass(tx, {
            user_pass_id: hold.user_pass_id,
            units: hold.units,
            booking_ref,
            payment_no: null,
            person_no: null,
            staff_name: '半自助預約',
            source: 'self_service_prepay',
            date: sessionDate
          });
          await auditLog(tx, {
            booking_ref,
            event_type: 'pass_held',
            category: 'pass',
            summary: `半自助預約扣卡 · ${hold.plan_name || '計次卡'} · ${hold.units} 次 · 使用日 ${holdUseDateStr}`,
            after_json: {
              user_pass_id: hold.user_pass_id,
              units: hold.units,
              remaining_after: updatedPass.remaining_quota
            },
            staff_name: 'customer',
            device_label: '線上預約'
          });
          passHolds.push({
            user_pass_id: hold.user_pass_id,
            pass_code: hold.pass_code,
            plan_name: hold.plan_name,
            units: hold.units,
            person_nos: hold.person_nos,
            remaining_after: updatedPass.remaining_quota
          });
        }

        const appliedPromoCode = quote.promo?.code || null;
        const appliedDiscountAmount = quote.promo?.discount || 0;
        if (quote.promo?.promo_row?.id) {
          try {
            await redeemPromo(tx, {
              promo: quote.promo.promo_row,
              booking_ref,
              user_id: userId,
              channel: 'self'
            });
          } catch (redeemErr) {
            throw makePrepayError('PROMO_ERROR', redeemErr.error || redeemErr.message || '優惠碼已達使用上限', 400);
          }
        }

        await applyMovableSeatUpdates(tx, allocResult.updates);

        const resRowsData = session_ids.map((sessionId) => ({
          booking_ref,
          session_id: sessionId,
          user_id: userId,
          pax: parsedPax,
          status: 'confirmed',
          assigned_seats: mySeats,
          is_force_split: forceSplit === true,
          is_unlimited: is_unlimited,
          is_self_service: true,
          total_amount: quote.total_amount,
          promo_code: appliedPromoCode,
          discount_amount: appliedDiscountAmount,
          checkout_details: quote.draft,
          customer_note: cleanCustomerNote
        }));

        const createdRes = await tx.reservation.createMany({ data: resRowsData });

        if (quote.equipmentRecordsSpec.length > 0) {
          await tx.bookingEquipment.createMany({
            data: quote.equipmentRecordsSpec.map((eq) => ({
              booking_ref,
              equipment_id: eq.equipment_id,
              equipment_name_snapshot: eq.equipment_name_snapshot,
              quantity: eq.quantity,
              rental_hours: eq.rental_hours,
              unit_rate: eq.unit_rate,
              daily_cap_snapshot: eq.daily_cap_snapshot ?? null,
              subtotal_price: eq.subtotal_price,
              covered_sessions: eq.covered_sessions
            }))
          });
        }

        // Authoritative amount verification against persisted getBookingBill
        const authoritativeBillData = await getBillFn(booking_ref, tx);
        const authoritativeTotal = authoritativeBillData.bill?.summary?.amount_due ?? quote.total_amount;

        if (authoritativeTotal !== quote.total_amount) {
          console.error('[createReservation] Self-service quote differed from getBookingBill; aborting:', {
            booking_ref,
            quoteTotal: quote.total_amount,
            billTotal: authoritativeTotal
          });
          const passCover = quote.total_amount - quote.transfer_amount;
          const recalculatedTransfer = Math.max(0, authoritativeTotal - passCover);
          throw makePrepayError('AMOUNT_CHANGED', '預約金額已變動，請確認最新金額後再送出', 409, {
            quote: buildPrepayQuoteResponse(quote, {
              total_amount: authoritativeTotal,
              transfer_amount: recalculatedTransfer
            })
          });
        }

        let createdPrepay = await tx.bookingPrepay.create({
          data: {
            booking_ref,
            user_id: userId,
            total_amount: quote.total_amount,
            pass_persons: quote.pass_persons,
            pass_holds: passHolds,
            pricing_snapshot: {
              hourly: dailyRates.hourly_price,
              unlimited: dailyRates.unlimited_price,
              allow_unlimited: dailyRates.allow_unlimited,
              is_weekend: dailyRates.is_weekend
            },
            amount_due: quote.transfer_amount,
            status: 'pending_payment',
            deadline_at: quote.deadline_at,
            payment_method_code: paymentMethodCode,
            selected_bank_info: selectedBankInfo,
            assigned_pool_account: assignedPoolAccount,
            assigned_pool_url: assignedPoolUrl,
            agreed_terms_at: new Date()
          }
        });

        if (quote.transfer_amount === 0) {
          const settleResult = await settleSelfServiceBooking(tx, {
            booking_ref,
            staffName: '系統'
          });
          createdPrepay = settleResult.prepay;
        }

        const allDaySess = await tx.session.findMany({
          where: { session_date: sessionDate },
          select: { end_time: true }
        });
        const maxDayEnd = allDaySess.reduce((mx, s) => (s.end_time > mx ? s.end_time : mx), '') ||
          sortedRequestedSessions[sortedRequestedSessions.length - 1].end_time;
        const openAt = earliestEntry(
          sortedRequestedSessions[0].start_time,
          kioskSetting.early_minutes ?? 30
        );
        const iText = ironText({
          iron_mode: dailySetting.iron_mode,
          iron_date: dailySetting.iron_date,
          date: dateStr
        });

        return {
          booking_ref,
          count: createdRes.count,
          pax: parsedPax,
          is_unlimited,
          session_date: dateStr,
          start_time: sortedRequestedSessions[0].start_time,
          end_time: sortedRequestedSessions[sortedRequestedSessions.length - 1].end_time,
          sessions: sortedRequestedSessions,
          assigned_seats: mySeats,
          total_amount: quote.total_amount,
          promo_code: appliedPromoCode,
          discount_amount: appliedDiscountAmount,
          requested_sessions: sortedRequestedSessions,
          is_self_service: true,
          prepay: createdPrepay,
          self_info: {
            open_at: openAt,
            earliest_entry: openAt,
            until: maxDayEnd,
            iron_text: iText,
            early_minutes: kioskSetting.early_minutes ?? 30
          }
        };
      }
      
      // Smart Pegboard / Equipment fee calculation
      const equipments = req.body.equipments;
      let totalEquipmentFee = 0;
      const newEquipmentRecords = [];

      if (Array.isArray(equipments) && equipments.length > 0) {
        const allConfigs = await tx.equipmentConfig.findMany();
        const configMap = {};
        allConfigs.forEach(c => { configMap[c.id] = c; });

        const globalSetting = await tx.globalSetting.findUnique({ where: { id: 1 } });
        const allowExceedPax = globalSetting?.allow_equipment_exceed_pax === true;
        const discountConfig = {
          enabled: globalSetting ? globalSetting.equipment_discount_enabled !== false : true,
          buy_hours: globalSetting?.equipment_discount_buy_hours ?? 3,
          free_hours: globalSetting?.equipment_discount_free_hours ?? 1,
          stackable: globalSetting ? globalSetting.equipment_discount_stackable !== false : true,
          tier2_enabled: !!globalSetting?.equipment_discount2_enabled,
          tier2_buy_hours: globalSetting?.equipment_discount2_buy_hours ?? 8,
          tier2_free_hours: globalSetting?.equipment_discount2_free_hours ?? 4
        };

        const totalHours = session_ids.length;
        const sortedReqSessions = [...requestedSessions].sort((a, b) => a.start_time.localeCompare(b.start_time));

        // Verify concurrent boards against pax quota across all covered sessions
        if (!allowExceedPax) {
          for (const session of sortedReqSessions) {
            let concurrentBoards = 0;
            for (const eq of equipments) {
              if (eq.equipment_id === 'bring_own') continue;
              const qty = parseInt(eq.quantity, 10) || 0;
              if (qty <= 0) continue;
              const config = configMap[eq.equipment_id];
              const minHours = config?.min_contiguous_hours || 2;
              const { windowSessions } = resolveEquipmentWindow(sortedReqSessions, eq, minHours);
              if (windowSessions.some(ws => ws.id === session.id)) {
                concurrentBoards += qty;
              }
            }
            if (concurrentBoards > parseInt(pax, 10)) {
              throw new Error('EQUIPMENT_EXCEED_PAX');
            }
          }
        }

        // Pre-fetch all confirmed reservations and their equipment on this date to verify stock
        const dateReservations = await tx.reservation.findMany({
          where: {
            session: { session_date: sessionDate },
            status: 'confirmed'
          },
          include: { session: true }
        });
        const activeBookingRefs = Array.from(new Set(dateReservations.map(r => r.booking_ref)));
        const bookedEquipments = await tx.bookingEquipment.findMany({
          where: { booking_ref: { in: activeBookingRefs } }
        });

        const requestUsage = {};

        for (const eq of equipments) {
          const qty = parseInt(eq.quantity, 10) || 0;
          if (qty <= 0) continue;

          const config = configMap[eq.equipment_id];
          if (!config) continue;

          if (eq.equipment_id !== 'bring_own' && config.visibility_status !== 'ACTIVE') {
            throw new Error(`EQUIPMENT_UNAVAILABLE:智能拼豆板「${config.name}」目前維護中，暫停借用。`);
          }

          const minHours = config.min_contiguous_hours || 2;
          const { rentalHours, windowSessions, coveredSessions: eqCoveredSessions } =
            resolveEquipmentWindow(sortedReqSessions, eq, minHours);

          // Real-time stock verification across each covered session
          if (eq.equipment_id !== 'bring_own') {
            const totalStock = config.total_stock || 0;
            for (const sess of windowSessions) {
              const sessTimeStr = `${sess.start_time}-${sess.end_time}`;
              const usageKey = `${eq.equipment_id}|${sess.start_time}`;
              let bookedInThisSession = 0;
              for (const be of bookedEquipments) {
                if (be.equipment_id !== eq.equipment_id) continue;
                let isCovered = false;
                if (Array.isArray(be.covered_sessions) && be.covered_sessions.length > 0) {
                  isCovered = be.covered_sessions.some(cs => cs === sess.start_time || cs === sessTimeStr || cs.startsWith(sess.start_time));
                } else {
                  const bRes = dateReservations.filter(r => r.booking_ref === be.booking_ref);
                  isCovered = bRes.some(r => r.session?.start_time === sess.start_time);
                }
                if (isCovered) {
                  bookedInThisSession += be.quantity;
                }
              }

              if (bookedInThisSession + (requestUsage[usageKey] || 0) + qty > totalStock) {
                throw new Error(`EQUIPMENT_OUT_OF_STOCK:智能拼豆板「${config.name}」在 ${sess.start_time} 時段庫存不足（僅剩 ${Math.max(0, totalStock - bookedInThisSession - (requestUsage[usageKey] || 0))} 台）`);
              }
            }
            for (const sess of windowSessions) {
              const usageKey = `${eq.equipment_id}|${sess.start_time}`;
              requestUsage[usageKey] = (requestUsage[usageKey] || 0) + qty;
            }
          }

          const chargeableHours = calculateEquipmentChargeableHours(rentalHours, discountConfig);

          const singlePrice = (config.daily_cap && config.daily_cap > 0)
            ? Math.min(config.hourly_rate * chargeableHours, config.daily_cap)
            : (config.hourly_rate * chargeableHours);
          const subtotal = singlePrice * qty;
          totalEquipmentFee += subtotal;

          newEquipmentRecords.push({
            booking_ref,
            equipment_id: eq.equipment_id,
            equipment_name_snapshot: config.name,
            quantity: qty,
            rental_hours: rentalHours,
            unit_rate: config.hourly_rate,
            daily_cap_snapshot: config.daily_cap ?? null,
            subtotal_price: subtotal,
            covered_sessions: eqCoveredSessions
          });
        }
      }

      const dailyRates = await getEffectiveDailyRates(tx, sessionDate);
      const { hourly_price } = dailyRates;
      const pricingSnapshot = {
        hourly: dailyRates.hourly_price,
        unlimited: dailyRates.unlimited_price,
        allow_unlimited: dailyRates.allow_unlimited,
        is_weekend: dailyRates.is_weekend,
        captured_at: new Date().toISOString()
      };
      const bookedHours = computeBookedHours(sortedRequestedSessions, session_ids.length);
      const baseSeatingPrice = await calculateTotalAmount(tx, sessionDate, parseInt(pax, 10), bookedHours, is_unlimited);
      let subtotalAmount = baseSeatingPrice + totalEquipmentFee;

      // Promo code evaluation if provided by customer
      let appliedPromoCode = null;
      let appliedPromoRule = null;
      let appliedDiscountAmount = 0;
      if (req.body.promo_code && String(req.body.promo_code).trim()) {
        const promoEval = await evaluatePromoCode(tx, {
          code: req.body.promo_code,
          session_date: sessionDate,
          pax: parseInt(pax, 10),
          hours: session_ids.length,
          is_unlimited,
          base_amount: subtotalAmount,
          hourly_price,
          user_id: userId,
          seating_amount: baseSeatingPrice,
          equipment_amount: totalEquipmentFee
        });
        if (!promoEval.valid) {
          throw new Error(`PROMO_ERROR:${promoEval.error}`);
        }
        appliedPromoCode = promoEval.promo.code;
        appliedPromoRule = promoEval.rule;
        appliedDiscountAmount = promoEval.discount_amount;
        try {
          await redeemPromo(tx, {
            promo: promoEval.promo,
            booking_ref,
            user_id: userId,
            channel: 'online'
          });
        } catch (redeemErr) {
          throw new Error(`PROMO_ERROR:${redeemErr.error || redeemErr.message || '優惠碼已達使用上限'}`);
        }
      }

      const totalAmount = Math.max(0, subtotalAmount - appliedDiscountAmount);
      const initialDraft = buildInitialDraft({
        pax: parseInt(pax, 10),
        isUnlimited: is_unlimited,
        promoRule: appliedPromoRule
      });

      for (const sessionId of session_ids) {
        newReservationsData.push({
          booking_ref,
          session_id: sessionId,
          user_id: userId,
          pax: parseInt(pax, 10),
          status: 'confirmed',
          assigned_seats: mySeats,
          is_force_split: forceSplit === true,
          is_unlimited: is_unlimited,
          total_amount: totalAmount,
          promo_code: appliedPromoCode,
          discount_amount: appliedDiscountAmount,
          checkout_details: initialDraft,
          customer_note: cleanCustomerNote,
          pricing_snapshot: pricingSnapshot
        });
      }

      await applyMovableSeatUpdates(tx, allocResult.updates);

      // Create the new reservations with their assigned seats
      const newReservations = await tx.reservation.createMany({
        data: newReservationsData
      });

      if (newEquipmentRecords.length > 0) {
        await tx.bookingEquipment.createMany({
          data: newEquipmentRecords
        });
      }

      const { bill: verifiedBill } = await getBookingBill(booking_ref, tx);
      if (
        (verifiedBill?.summary?.amount_due ?? 0) !== totalAmount ||
        (verifiedBill?.summary?.discounts_total ?? 0) !== appliedDiscountAmount
      ) {
        throw new Error(`BILL_MISMATCH: expected total=${totalAmount} discount=${appliedDiscountAmount}, got due=${verifiedBill?.summary?.amount_due} discount=${verifiedBill?.summary?.discounts_total}`);
      }

      return { 
        booking_ref, 
        count: newReservations.count, 
        assigned_seats: mySeats, 
        total_amount: totalAmount, 
        promo_code: appliedPromoCode, 
        discount_amount: appliedDiscountAmount,
        requested_sessions: sortedRequestedSessions
      };
    });

    res.status(201).json({
      message: 'Reservation successful',
      reservation: result,
      ...(result.is_self_service
        ? { prepay: result.prepay, self_info: result.self_info }
        : {})
    });

    // Auto LINE confirmation notification (asynchronously dispatched, never blocks response)
    (async () => {
      try {
        const globalSetting = await prisma.globalSetting.findUnique({
          where: { id: 1 },
          select: { line_auto_notify_booking: true }
        });
        if (globalSetting?.line_auto_notify_booking) {
          const user = await prisma.user.findUnique({
            where: { id: userId },
            select: { id: true, name: true, line_user_id: true }
          });
          if (user?.line_user_id && !user.line_user_id.startsWith('manual_')) {
            const reqSessions = result.requested_sessions || [];
            const firstSession = reqSessions[0];
            const timeRange = formatSessionsToTimeRange(reqSessions);

            if (result.is_self_service && result.prepay?.status === 'pending_payment') {
              await sendSelfServiceTransferPendingNotification(
                {
                  booking_ref: result.booking_ref,
                  session_date: firstSession?.session_date,
                  time_range: timeRange,
                  amount_due: result.prepay.amount_due,
                  deadline_at: result.prepay.deadline_at
                },
                user
              );
              return;
            }

            const equipments = req.body.equipments;
            let equipmentSummary = '';
            if (Array.isArray(equipments) && equipments.length > 0) {
              const eqConfigs = await prisma.equipmentConfig.findMany({
                where: { id: { in: equipments.map(e => e.equipment_id) } },
                select: { id: true, name: true }
              });
              const eqMap = Object.fromEntries(eqConfigs.map(c => [c.id, c.name]));
              const qtyByEq = {};
              for (const e of equipments) {
                const q = parseInt(e.quantity, 10) || 0;
                if (q > 0) {
                  qtyByEq[e.equipment_id] = (qtyByEq[e.equipment_id] || 0) + q;
                }
              }
              equipmentSummary = Object.entries(qtyByEq)
                .map(([eqId, qty]) => `${eqMap[eqId] || eqId}×${qty}`)
                .join(' + ');
            }

            await sendBookingConfirmationNotification(
              {
                booking_ref: result.booking_ref,
                session_date: firstSession?.session_date,
                time_range: timeRange,
                pax,
                equipment_summary: equipmentSummary,
                total_amount: result.total_amount
              },
              user
            );
          }
        }
      } catch (notifyErr) {
        console.warn('[createReservation] Auto LINE booking notification failed:', notifyErr.message);
      }
    })();


  } catch (error) {
    console.error('Reservation error:', error);
    if (error.isPrepayError) {
      return res.status(error.status || 400).json({
        error: error.message,
        code: error.code,
        ...(error.quote ? { quote: error.quote } : {})
      });
    }
    if (error.isBusinessError) {
      return res.status(error.status || 409).json({
        error: error.message,
        code: error.code || 'POOL_HOLD_LIMIT'
      });
    }
    if (error.status) {
      return res.status(error.status).json({
        error: error.message,
        ...(error.code ? { code: error.code } : {})
      });
    }
    if (error.message && error.message.startsWith('EQUIPMENT_WINDOW_INVALID:')) {
      return res.status(400).json({ error: error.message.replace('EQUIPMENT_WINDOW_INVALID:', '') });
    }
    if (error.message === 'CROSS_DATE_SESSIONS') {
      return res.status(400).json({ error: '一筆預約只能包含同一天的時段' });
    }
    if (error.message === 'BLACKLISTED_USER') {
      return res.status(403).json({ error: '您的帳號目前無法使用線上預約服務，請直接聯繫門市人員。' });
    }
    if (error.message && error.message.startsWith('EQUIPMENT_OUT_OF_STOCK:')) {
      return res.status(409).json({ error: error.message.replace('EQUIPMENT_OUT_OF_STOCK:', '') });
    }
    if (error.message && error.message.startsWith('EQUIPMENT_UNAVAILABLE:')) {
      return res.status(400).json({ error: error.message.replace('EQUIPMENT_UNAVAILABLE:', '') });
    }
    if (error.message === 'EQUIPMENT_EXCEED_PAX') {
      return res.status(400).json({ error: '預約之智能拼豆板總數不得超過同行人數上限。' });
    }
    if (error.message && error.message.startsWith('PROMO_ERROR:')) {
      return res.status(400).json({ error: error.message.replace('PROMO_ERROR:', '') });
    }
    if (error.message === 'SOME_SESSIONS_NOT_FOUND') {
      return res.status(404).json({ error: 'One or more sessions not found.' });
    }
    if (error.message === 'INSUFFICIENT_CAPACITY') {
      return res.status(409).json({ error: '該時段已額滿或剩餘人數不足，請選擇其他時段。', code: 'INSUFFICIENT_CAPACITY' });
    }
    if (error.message === 'SPLIT_REQUIRED') {
      return res.status(409).json({ error: '連續座位不足，同行者將被拆散。是否確認預約？' });
    }
    res.status(500).json({ error: 'Failed to create reservation.' });
  }
};

export const createReservation = createReservationHandler();

export const getAdminReservations = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const search = (req.query.search || '').trim();
    const month = req.query.month; // format: 'YYYY-MM'
    const date = req.query.date;   // format: 'YYYY-MM-DD'
    const sort = req.query.sort;   // format: 'start_time_asc'

    let whereClause = {};

    if (date) {
      const startDate = new Date(`${date}T00:00:00.000Z`);
      const endDate = new Date(startDate);
      endDate.setDate(endDate.getDate() + 1);
      
      whereClause.session = {
        session_date: {
          gte: startDate,
          lt: endDate
        }
      };
    } else if (month) {
      const startDate = new Date(`${month}-01T00:00:00.000Z`);
      const endDate = new Date(startDate);
      endDate.setMonth(endDate.getMonth() + 1);
      
      whereClause.session = {
        session_date: {
          gte: startDate,
          lt: endDate
        }
      };
    }

    if (search) {
      const shortRefMatch = search.match(/^(?:BK-)?([0-9a-fA-F]{4})-([0-9a-fA-F]{4})$/i);
      const cleanRefPrefix = search.replace(/^BK-/i, '');
      const orConditions = [
        { booking_ref: { contains: search, mode: 'insensitive' } },
        { user: activeUserWhere({ name: { contains: search, mode: 'insensitive' } }) },
        { user: activeUserWhere({ phone: { contains: search } }) },
        { customer_note: { contains: search, mode: 'insensitive' } },
        { admin_note: { contains: search, mode: 'insensitive' } }
      ];
      if (cleanRefPrefix && cleanRefPrefix !== search) {
        orConditions.push({ booking_ref: { contains: cleanRefPrefix, mode: 'insensitive' } });
      }
      if (shortRefMatch) {
        orConditions.push({
          AND: [
            { booking_ref: { startsWith: shortRefMatch[1], mode: 'insensitive' } },
            { booking_ref: { endsWith: shortRefMatch[2], mode: 'insensitive' } }
          ]
        });
      }
      whereClause.OR = orConditions;
    }

    // Fetch all reservations matching criteria (for the month)
    const reservations = await prisma.reservation.findMany({
      where: whereClause,
      include: {
        session: true,
        user: {
          select: { id: true, name: true, phone: true, line_user_id: true, line_display_name: true, line_picture_url: true }
        }
      },
      orderBy: {
        created_at: 'desc'
      }
    });

    // Fetch equipment bookings for these reservations
    const bookingRefs = [...new Set(reservations.map(r => r.booking_ref))];
    const equipments = await prisma.bookingEquipment.findMany({
      where: { booking_ref: { in: bookingRefs } }
    });
    const equipmentsMap = {};
    equipments.forEach(eq => {
      if (!equipmentsMap[eq.booking_ref]) equipmentsMap[eq.booking_ref] = [];
      equipmentsMap[eq.booking_ref].push(eq);
    });

    // Group them
    let grouped = groupReservations(reservations, equipmentsMap);

    const prepays = bookingRefs.length
      ? await prisma.bookingPrepay.findMany({
          where: { booking_ref: { in: bookingRefs } },
          select: {
            booking_ref: true,
            status: true,
            amount_due: true,
            pass_persons: true,
            remittance_last5: true,
            deadline_at: true
          }
        })
      : [];
    const prepayByRef = new Map(prepays.map((p) => [p.booking_ref, p]));
    grouped = grouped.map((g) => ({
      ...g,
      prepay: prepayByRef.get(g.booking_ref) || null
    }));
    
    // Sort grouped reservations by session_date ascending, then start_time ascending
    grouped.sort((a, b) => {
      if (a.session_date > b.session_date) return 1;
      if (a.session_date < b.session_date) return -1;
      
      return a.start_time.localeCompare(b.start_time);
    });

    // Calculate total daily revenue if it's a specific date query
    let total_daily_revenue = 0;
    if (date && !search) {
      total_daily_revenue = grouped.reduce((sum, r) => {
        if (r.status === 'confirmed' && r.is_paid && r.total_amount) {
          return sum + r.total_amount;
        }
        return sum;
      }, 0);
    }

    const total = grouped.length;
    const totalPages = Math.ceil(total / limit);
    const paginatedData = grouped.slice((page - 1) * limit, page * limit);

    res.json({
      data: paginatedData,
      total,
      page,
      totalPages,
      total_daily_revenue
    });
  } catch (error) {
    console.error('Error fetching reservations:', error);
    res.status(500).json({ error: 'Failed to fetch reservations' });
  }
};

export const getAdminReservationDetails = async (req, res) => {
  const { booking_ref } = req.params;
  try {
    const reservations = await prisma.reservation.findMany({
      where: { booking_ref },
      include: {
        session: true,
        user: { select: { id: true, name: true, phone: true, line_user_id: true, line_display_name: true, line_picture_url: true } }
      },
      orderBy: { created_at: 'desc' }
    });
    if (reservations.length === 0) {
      return res.status(404).json({ error: 'Reservation not found' });
    }
    
    let firstRes = reservations[0];
    const eqRecords = await prisma.bookingEquipment.findMany({ where: { booking_ref } });
    const eqTotal = eqRecords.reduce((sum, e) => sum + e.subtotal_price, 0);

    // Recalculate reservation total with centralized logic (equipment, addons, promo discount)
    await recalculateReservationTotal(prisma, booking_ref);

    const refreshedReservations = await prisma.reservation.findMany({
      where: { booking_ref },
      include: {
        session: true,
        user: { select: { id: true, name: true, phone: true, line_user_id: true, line_display_name: true, line_picture_url: true } }
      },
      orderBy: { created_at: 'desc' }
    });

    const sessionDate = refreshedReservations[0].session.session_date;
    const pricingInfo = await getEffectiveDailyRates(prisma, sessionDate);

    const prepay = await prisma.bookingPrepay.findUnique({ where: { booking_ref } });

    const equipmentsMap = { [booking_ref]: eqRecords };
    const grouped = groupReservations(refreshedReservations, equipmentsMap);
    const result = {
      ...grouped[0],
      prepay: prepay || null,
      pricing_info: pricingInfo
    };

    // If attendance was desynced across session segments in database, auto-heal them
    if (result && result.attendance) {
      const needsSync = refreshedReservations.some(r => r.attendance !== result.attendance || (result.checked_in_at && !r.checked_in_at));
      if (needsSync) {
        prisma.reservation.updateMany({
          where: { booking_ref },
          data: {
            attendance: result.attendance,
            checked_in_at: result.checked_in_at
          }
        }).catch(e => console.error('Error auto-healing reservation details attendance:', e));
      }
    }

    res.json(result);
  } catch (error) {
    console.error('Error fetching reservation details:', error);
    res.status(500).json({ error: 'Failed to fetch reservation details' });
  }
};

export const getMyReservations = async (req, res) => {
  const userId = req.user.id;

  try {
    const reservations = await prisma.reservation.findMany({
      where: { user_id: userId },
      include: {
        session: true,
        user: {
          select: {
            id: true,
            name: true,
            phone: true,
            line_user_id: true,
            line_display_name: true,
            line_picture_url: true
          }
        }
      },
      orderBy: {
        created_at: 'desc'
      }
    });

    const bookingRefs = [...new Set(reservations.map(r => r.booking_ref))];
    const equipments = await prisma.bookingEquipment.findMany({
      where: { booking_ref: { in: bookingRefs } }
    });
    const equipmentsMap = {};
    equipments.forEach(eq => {
      if (!equipmentsMap[eq.booking_ref]) equipmentsMap[eq.booking_ref] = [];
      equipmentsMap[eq.booking_ref].push(eq);
    });

    // 顧客端不回傳 admin_note 與敏感資料，並合併未換板的設備
    const grouped = groupReservations(reservations, equipmentsMap, { includeAdminNote: false, mergeEquipments: true });
    const enriched = await attachSelfInfoToReservations(grouped, prisma);
    res.json(enriched);
  } catch (error) {
    console.error('Error fetching my reservations:', error);
    res.status(500).json({ error: 'Failed to fetch your reservations' });
  }
};

async function cancelReservationCore(req, res, { actor }) {
  const isAdmin = actor === 'admin';
  // Customer route uses :id, admin route uses :booking_ref
  const booking_ref = isAdmin ? req.params.booking_ref : req.params.id;
  const userId = req.user?.id;
  const confirmPaidCancel = isAdmin ? Boolean(req.body?.confirmPaidCancel || req.query?.confirmPaidCancel === 'true') : false;
  const operatorName = isAdmin ? (req.user?.name || '管理員') : 'customer';
  const cancelledByTag = isAdmin ? `admin:${operatorName}` : 'customer';

  try {
    const txResult = await prisma.$transaction(async (tx) => {
      const lockedPrepay = await lockPrepay(tx, booking_ref);

      // Find all reservations with this booking_ref under lock
      const reservations = await tx.reservation.findMany({
        where: { booking_ref },
        include: { session: true }
      });

      if (reservations.length === 0) {
        return { errorStatus: 404, errorBody: { error: '找不到該筆預約' } };
      }

      // Check ownership
      if (!isAdmin && reservations[0].user_id !== userId) {
        return { errorStatus: 403, errorBody: { error: '無權限取消此預約' } };
      }

      if (reservations[0].status === 'cancelled') {
        return { errorStatus: 400, errorBody: { error: '此預約先前已取消' } };
      }

      const isSelfCustomerAllPassVerified =
        !isAdmin &&
        Boolean(lockedPrepay) &&
        lockedPrepay.status === 'verified' &&
        (lockedPrepay.amount_due ?? 0) === 0 &&
        !reservations.some(r => (r.amount_received && r.amount_received > 0));

      if (!isAdmin && lockedPrepay && lockedPrepay.status !== 'pending_payment' && !isSelfCustomerAllPassVerified) {
        return { errorStatus: 400, errorBody: { error: '這筆預約已經付款或正在對帳，如需取消請用 LINE 聯絡我們' } };
      }

      const isCollected = !isSelfCustomerAllPassVerified &&
        reservations.some(r => r.amount_received && r.amount_received > 0);
      if (isCollected) {
        const amt = reservations[0].amount_received || 0;
        return { errorStatus: 409, errorBody: { error: `這筆已收款 NT$${amt}，請先退款或作廢收款` } };
      }

      const hasPaid = !isSelfCustomerAllPassVerified && reservations.some(r => r.is_paid);
      const hasCheckedIn = reservations.some(r => r.attendance === 'checked_in');

      // 計算該預約最早開始的時間
      let earliestStartDateTime = null;
      for (const r of reservations) {
        if (r.session?.session_date && r.session?.start_time) {
          const dateStr = r.session.session_date.toISOString().slice(0, 10);
          const dt = new Date(`${dateStr}T${r.session.start_time}:00+08:00`);
          if (!earliestStartDateTime || dt < earliestStartDateTime) {
            earliestStartDateTime = dt;
          }
        }
      }
      const hasStarted = earliestStartDateTime && new Date() >= earliestStartDateTime;

      // 顧客端規則校驗 (非管理員一律嚴格攔截)
      if (!isAdmin) {
        if (hasPaid) {
          return { errorStatus: 400, errorBody: { error: '此預約已完成付款，如需取消或退款請直接聯繫門市人員協助！' } };
        }
        if (hasCheckedIn) {
          return { errorStatus: 400, errorBody: { error: '此預約已報到入座，無法取消。' } };
        }
        if (hasStarted) {
          return { errorStatus: 400, errorBody: { error: '此預約時段已過開始時間，無法線上取消。如需協助請聯繫門市人員。' } };
        }
      } else {
        // 員工端防呆二次確認：若訂單已付款且未帶確認旗標，要求二次確認以保護營收帳務
        if (hasPaid && !confirmPaidCancel) {
          return {
            errorStatus: 409,
            errorBody: {
              code: 'REQUIRE_PAID_CANCEL_CONFIRM',
              error: '此預約已完成付款結帳，取消將影響營收帳務，請再次確認是否強制取消？'
            }
          };
        }
      }

      if (lockedPrepay && lockedPrepay.status !== 'cancelled' && lockedPrepay.status !== 'expired') {
        if (isSelfCustomerAllPassVerified) {
          const validPayments = await tx.payment.findMany({
            where: { booking_ref, status: 'valid' }
          });
          const nowVoid = new Date();
          for (const vp of validPayments) {
            await tx.payment.update({
              where: { id: vp.id },
              data: {
                status: 'voided',
                voided_at: nowVoid,
                voided_by_name: 'customer',
                void_reason: '顧客取消半自助卡券預約'
              }
            });
            if (vp.method === 'pass' && Array.isArray(vp.pass_json)) {
              for (const pj of vp.pass_json) {
                if (pj?.user_pass_id) {
                  await restorePass(tx, {
                    user_pass_id: Number(pj.user_pass_id),
                    units: Number(pj.units) || 1,
                    booking_ref,
                    payment_no: vp.payment_no,
                    person_no: pj.person_no ?? null,
                    staff_name: 'customer'
                  });
                  await auditLog(tx, {
                    booking_ref,
                    event_type: 'pass_restored',
                    category: 'pass',
                    summary: `卡券退回（取消預約）· ${pj.plan_name || '計次卡'} · ${pj.units || 1} 次`,
                    payment_id: vp.id,
                    staff_name: 'customer',
                    device_label: '線上取消'
                  });
                }
              }
            }
            await auditLog(tx, {
              booking_ref,
              event_type: 'payment_voided',
              category: 'payment',
              summary: `作廢收款（取消預約）· ${vp.payment_no}`,
              amount: -(vp.amount || 0),
              reason: '顧客取消半自助卡券預約',
              payment_id: vp.id,
              staff_name: 'customer',
              device_label: '線上取消'
            });
          }
          await refreshBillingCache(tx, booking_ref);
        } else {
          // Release held pool account if any
          if (lockedPrepay.assigned_pool_account) {
            await releasePoolAccount(tx, {
              accountNumber: lockedPrepay.assigned_pool_account,
              orderRef: booking_ref
            });
          }
          // Restore held passes if not yet settled (if settled, admin already voided payments first)
          if (!lockedPrepay.settled_at) {
            const holds = Array.isArray(lockedPrepay.pass_holds) ? lockedPrepay.pass_holds : [];
            for (const h of holds) {
              if (h?.user_pass_id && (Number(h.units) || 0) > 0) {
                const restoredPass = await restorePass(tx, {
                  user_pass_id: Number(h.user_pass_id),
                  units: Number(h.units),
                  booking_ref,
                  payment_no: null,
                  person_no: null,
                  staff_name: operatorName
                });
                await auditLog(tx, {
                  booking_ref,
                  event_type: 'pass_restored',
                  category: 'pass',
                  summary: `半自助卡券退回（取消預約）· ${h.plan_name || '計次卡'} · ${Number(h.units)} 次`,
                  after_json: {
                    user_pass_id: Number(h.user_pass_id),
                    units: Number(h.units),
                    remaining_after: restoredPass?.remaining_quota ?? null
                  },
                  staff_name: operatorName,
                  device_label: '線上預約'
                });
              }
            }
          }
        }

        await tx.bookingPrepay.update({
          where: { booking_ref },
          data: { status: 'cancelled' }
        });
      }

      // Cancel all related rows
      const cancelledRes = await tx.reservation.updateMany({
        where: { booking_ref },
        data: {
          status: 'cancelled',
          cancelled_at: new Date(),
          cancelled_by: cancelledByTag
        }
      });

      // Release promo code redemptions for this booking
      await releasePromo(tx, { booking_ref, reason: 'reservation_cancelled' });

      return { cancelledRes, reservations };
    });

    if (txResult.errorStatus) {
      return res.status(txResult.errorStatus).json(txResult.errorBody);
    }

    const updated = txResult.cancelledRes;
    const reservations = txResult.reservations;

    res.json({ message: '預約已成功取消', count: updated.count });

    // Auto LINE cancellation notification (asynchronously dispatched, never blocks response)
    (async () => {
      try {
        const globalSetting = await prisma.globalSetting.findUnique({
          where: { id: 1 },
          select: { line_auto_notify_cancel: true }
        });
        if (globalSetting?.line_auto_notify_cancel) {
          const firstRes = reservations[0];
          const user = await prisma.user.findUnique({
            where: { id: firstRes.user_id },
            select: { id: true, name: true, line_user_id: true }
          });
          if (user?.line_user_id && !user.line_user_id.startsWith('manual_')) {
            const resSessions = await prisma.session.findMany({
              where: { id: { in: reservations.map(r => r.session_id) } },
              orderBy: { start_time: 'asc' }
            });
            const firstSession = resSessions[0];
            const timeRange = formatSessionsToTimeRange(resSessions);

            await sendBookingCancellationNotification(
              {
                booking_ref,
                session_date: firstSession?.session_date || firstRes.session_date,
                time_range: timeRange
              },
              user,
              isAdmin ? 'admin' : 'customer'
            );
          }
        }
      } catch (notifyErr) {
        console.warn('[cancelReservation] Auto LINE cancellation notification failed:', notifyErr.message);
      }
    })();
  } catch (error) {
    console.error('Error cancelling reservation:', error);
    res.status(500).json({ error: 'Failed to cancel reservation' });
  }
}

export const cancelReservation = (req, res) => cancelReservationCore(req, res, { actor: 'customer' });
export const adminCancelReservation = (req, res) => cancelReservationCore(req, res, { actor: 'admin' });

export const deleteReservationRecord = async (req, res) => {
  const { id: booking_ref } = req.params;
  
  // This route is protected by requireAdmin middleware, so we know they are admin.
  try {
    const reservations = await prisma.reservation.findMany({
      where: { booking_ref }
    });

    if (reservations.length === 0) {
      return res.status(404).json({ error: 'Reservation not found' });
    }

    if (reservations[0].status !== 'cancelled') {
      return res.status(400).json({ error: 'Only cancelled reservations can be permanently deleted' });
    }

    // Hard delete all related rows
    const deleted = await prisma.reservation.deleteMany({
      where: { booking_ref }
    });

    res.json({ message: 'Reservation record deleted permanently', count: deleted.count });
  } catch (error) {
    console.error('Error deleting reservation record:', error);
    res.status(500).json({ error: 'Failed to delete reservation record' });
  }
};

export async function applyMovableSeatUpdates(tx, updates = []) {
  for (const update of updates) {
    if (!update?.booking_ref || update.booking_ref === 'NEW_RES') continue;
    const expectedCount = await tx.reservation.count({
      where: { booking_ref: update.booking_ref, status: 'confirmed' }
    });
    if (expectedCount === 0) continue;

    const updateRes = await tx.reservation.updateMany({
      where: {
        booking_ref: update.booking_ref,
        status: 'confirmed',
        ...MOVABLE_RESERVATION_FILTER
      },
      data: { assigned_seats: update.assigned_seats }
    });

    if (updateRes.count !== expectedCount) {
      const raceErr = new Error('座位剛被其他店員調整，請重新整理後再試');
      raceErr.status = 409;
      raceErr.code = 'SEAT_RACE';
      throw raceErr;
    }
  }
}

export async function reshuffleAfterSeatChange(tx, sessionIds, updatedBookingRefs) {
  const currentReservations = await tx.reservation.findMany({
    where: { session_id: { in: sessionIds }, status: 'confirmed' },
    include: {
      user: { select: { name: true } },
      session: { select: { session_date: true } }
    }
  });

  const nonUpdatedRefs = [...new Set(
    currentReservations
      .filter((r) => !updatedBookingRefs.includes(r.booking_ref))
      .map((r) => r.booking_ref)
  )];
  const seatedPersonRefs = new Set();
  if (nonUpdatedRefs.length > 0) {
    const bpRows = await tx.bookingPerson.findMany({
      where: { booking_ref: { in: nonUpdatedRefs }, seat_code: { not: null }, status: 'active' },
      select: { booking_ref: true }
    });
    for (const bp of bpRows) seatedPersonRefs.add(bp.booking_ref);
  }

  const updatedSeatsMap = new Map();
  for (const r of currentReservations) {
    if (updatedBookingRefs.includes(r.booking_ref)) {
      if (!updatedSeatsMap.has(r.session_id)) updatedSeatsMap.set(r.session_id, new Set());
      for (const s of r.assigned_seats || []) {
        if (s && !String(s).startsWith('WAIT-')) {
          updatedSeatsMap.get(r.session_id).add(s);
        }
      }
    }
  }

  const collidingRefs = new Set();
  const hitSeatsSet = new Set();
  for (const r of currentReservations) {
    if (updatedBookingRefs.includes(r.booking_ref)) continue;
    const updatedSeatsForSession = updatedSeatsMap.get(r.session_id);
    if (!updatedSeatsForSession || !r.assigned_seats) continue;

    const hitSeats = r.assigned_seats.filter(
      (seat) => seat && !String(seat).startsWith('WAIT-') && updatedSeatsForSession.has(seat)
    );
    if (hitSeats.length > 0) {
      if (isReservationPinned(r) || seatedPersonRefs.has(r.booking_ref)) {
        const pinnedErr = new Error(
          `${hitSeats[0]} 已被 ${r.user?.name || '客人'} 固定（已報到或店員帶位），不能自動移開`
        );
        pinnedErr.status = 409;
        pinnedErr.code = 'SEAT_PINNED';
        throw pinnedErr;
      }
      collidingRefs.add(r.booking_ref);
      hitSeats.forEach((s) => hitSeatsSet.add(s));
    }
  }

  const displacedCount = collidingRefs.size;
  if (displacedCount > 0) {
    try {
      await reseatBookings(tx, {
        bookingRefs: Array.from(collidingRefs),
        reservedSeats: Array.from(hitSeatsSet),
        sessionIds,
        primaryBookingRef: updatedBookingRefs[0] || null
      });
    } catch (err) {
      if (err?.code !== 'CANNOT_DISPLACE') {
        throw err;
      }

      const sampleDate = currentReservations[0]?.session?.session_date;
      let allDayReservations = currentReservations;
      if (sampleDate) {
        const allSessionsOfDay = await tx.session.findMany({
          where: { session_date: sampleDate },
          select: { id: true }
        });
        allDayReservations = await tx.reservation.findMany({
          where: { session_id: { in: allSessionsOfDay.map((s) => s.id) }, status: 'confirmed' },
          include: {
            user: { select: { name: true } }
          }
        });
      }

      let maxWait = 0;
      for (const res of allDayReservations) {
        for (const seat of res.assigned_seats || []) {
          if (String(seat).startsWith('WAIT-')) {
            const num = parseInt(String(seat).replace('WAIT-', ''), 10);
            if (!Number.isNaN(num) && num > maxWait) maxWait = num;
          }
        }
      }

      let waitCounter = maxWait + 1;
      for (const ref of collidingRefs) {
        const refRows = allDayReservations.filter((res) => res.booking_ref === ref);
        if (!refRows.length) continue;

        const stillCollides = refRows.some((r) => {
          const updatedSet = updatedSeatsMap.get(r.session_id);
          return updatedSet && (r.assigned_seats || []).some((s) => updatedSet.has(s));
        });
        if (!stillCollides) continue;

        if (refRows.some((r) => isReservationPinned(r))) {
          const pinnedErr = new Error(
            `${Array.from(hitSeatsSet)[0] || '座位'} 已被 ${refRows[0]?.user?.name || '客人'} 固定（已報到或店員帶位），不能自動移開`
          );
          pinnedErr.status = 409;
          pinnedErr.code = 'SEAT_PINNED';
          throw pinnedErr;
        }

        const paxCount = refRows[0]?.pax || 1;
        const waitSeats = [];
        for (let i = 0; i < paxCount; i++) {
          waitSeats.push(`WAIT-${waitCounter++}`);
        }
        const expectedCount = await tx.reservation.count({
          where: { booking_ref: ref, status: 'confirmed' }
        });
        const updateRes = await tx.reservation.updateMany({
          where: {
            booking_ref: ref,
            status: 'confirmed',
            ...MOVABLE_RESERVATION_FILTER
          },
          data: { assigned_seats: waitSeats }
        });
        if (updateRes.count !== expectedCount) {
          const raceErr = new Error('座位剛被其他店員調整，請重新整理後再試');
          raceErr.status = 409;
          raceErr.code = 'SEAT_RACE';
          throw raceErr;
        }
      }
    }
  }

  return displacedCount;
}

export const moveSeat = async (req, res) => {
  const { id, assigned_seats } = req.body;

  if (!id || !assigned_seats || !Array.isArray(assigned_seats)) {
    return res.status(400).json({ error: 'Valid reservation id and assigned_seats array are required.' });
  }

  try {
    const parsedId = parseInt(id, 10);
    const preTarget = await prisma.reservation.findUnique({
      where: { id: parsedId },
      include: { session: true }
    });
    if (!preTarget) {
      return res.status(404).json({ error: 'Reservation not found' });
    }
    const dateStr = toTaipeiDateString(preTarget.session.session_date);

    const { singleUpdated, displacedCount } = await prisma.$transaction(async (tx) => {
      await lockDaySeats(tx, dateStr);
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${preTarget.booking_ref}))`;

      const group = await tx.reservation.findMany({
        where: { booking_ref: preTarget.booking_ref, status: 'confirmed' }
      });
      if (!group.length) {
        const notFoundErr = new Error('Reservation not found');
        notFoundErr.status = 404;
        throw notFoundErr;
      }
      const sessionIds = group.map((r) => r.session_id);

      await tx.reservation.updateMany({
        where: { booking_ref: preTarget.booking_ref, status: 'confirmed' },
        data: {
          assigned_seats,
          is_seat_locked: true
        }
      });

      const dCount = await reshuffleAfterSeatChange(tx, sessionIds, [preTarget.booking_ref]);
      const updated = await tx.reservation.findUnique({ where: { id: parsedId } });
      return { singleUpdated: updated, displacedCount: dCount };
    });

    res.json({
      message: 'Seat moved successfully',
      reservation: singleUpdated,
      displacedCount
    });
  } catch (error) {
    console.error('Error moving seat:', error);
    if (error.status) {
      return res.status(error.status).json({
        error: error.message,
        ...(error.code ? { code: error.code } : {})
      });
    }
    res.status(500).json({ error: 'Failed to move seat' });
  }
};

export const swapSeats = async (req, res) => {
  const { source_booking_ref, source_assigned_seats, target_booking_ref, target_assigned_seats } = req.body;

  if (!source_booking_ref || !target_booking_ref || !Array.isArray(source_assigned_seats) || !Array.isArray(target_assigned_seats)) {
    return res.status(400).json({ error: 'Invalid parameters for swapping seats' });
  }

  try {
    const preSource = await prisma.reservation.findMany({
      where: { booking_ref: source_booking_ref, status: 'confirmed' },
      include: { session: true }
    });
    const preTarget = await prisma.reservation.findMany({
      where: { booking_ref: target_booking_ref, status: 'confirmed' },
      include: { session: true }
    });
    if (!preSource.length || !preTarget.length) {
      return res.status(404).json({ error: 'Reservation not found' });
    }
    const dateStr = toTaipeiDateString(preSource[0].session.session_date);

    const displacedCount = await prisma.$transaction(async (tx) => {
      await lockDaySeats(tx, dateStr);
      const refsSorted = [...new Set([source_booking_ref, target_booking_ref])].sort();
      for (const ref of refsSorted) {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${ref}))`;
      }

      const sourceGroup = await tx.reservation.findMany({
        where: { booking_ref: source_booking_ref, status: 'confirmed' }
      });
      const targetGroup = await tx.reservation.findMany({
        where: { booking_ref: target_booking_ref, status: 'confirmed' }
      });
      const sessionIds = Array.from(
        new Set([...sourceGroup.map((r) => r.session_id), ...targetGroup.map((r) => r.session_id)])
      );

      await tx.reservation.updateMany({
        where: { booking_ref: source_booking_ref, status: 'confirmed' },
        data: { assigned_seats: source_assigned_seats, is_seat_locked: true }
      });
      await tx.reservation.updateMany({
        where: { booking_ref: target_booking_ref, status: 'confirmed' },
        data: { assigned_seats: target_assigned_seats, is_seat_locked: true }
      });

      return await reshuffleAfterSeatChange(tx, sessionIds, [source_booking_ref, target_booking_ref]);
    });

    res.json({ message: 'Seats swapped successfully', displacedCount });
  } catch (error) {
    console.error('Error swapping seats:', error);
    if (error.status) {
      return res.status(error.status).json({
        error: error.message,
        ...(error.code ? { code: error.code } : {})
      });
    }
    res.status(500).json({ error: 'Failed to swap seats' });
  }
};

export const getSessionSeats = async (req, res) => {
  const { id } = req.params;

  try {
    const session = await prisma.session.findUnique({
      where: { id: parseInt(id, 10) }
    });

    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    const reservations = await prisma.reservation.findMany({
      where: { session_id: parseInt(id, 10), status: 'confirmed' },
      include: {
        user: {
          select: { name: true, phone: true }
        }
      }
    });

    // --- Self-Healing Mechanism ---
    const SEAT_REGEX = /^[AB][12]-[1-4]$/;
    const WAIT_REGEX = /^WAIT-\d+$/;
    const occupiedSeats = new Set();
    let maxWait = 0;

    for (const r of reservations) {
      if (r.assigned_seats && Array.isArray(r.assigned_seats)) {
        for (const s of r.assigned_seats) {
          if (WAIT_REGEX.test(s)) {
            const num = parseInt(s.split('-')[1], 10);
            if (num > maxWait) maxWait = num;
          }
        }
      }
    }

    let waitCounter = maxWait + 1;
    const healUpdates = [];

    for (let i = 0; i < reservations.length; i++) {
      const r = reservations[i];
      let isMissing = false;

      if (!r.assigned_seats || !Array.isArray(r.assigned_seats) || r.assigned_seats.length === 0) {
        isMissing = true;
      } else {
        for (const s of r.assigned_seats) {
          if (!SEAT_REGEX.test(s) && !WAIT_REGEX.test(s)) {
            isMissing = true;
            break;
          }
          if (occupiedSeats.has(s)) {
            isMissing = true; // Overlap detected! One of them must be pushed to wait.
            break;
          }
        }
      }

      if (isMissing) {
        const waitSeats = [];
        const paxCount = r.pax || 1;
        for (let j = 0; j < paxCount; j++) {
          waitSeats.push(`WAIT-${waitCounter++}`);
        }
        r.assigned_seats = waitSeats; // Update memory for current response
        healUpdates.push(
          prisma.reservation.updateMany({
            where: { booking_ref: r.booking_ref },
            data: { assigned_seats: waitSeats }
          })
        );
      } else {
        // Valid and no overlap, mark seats as occupied
        for (const s of r.assigned_seats) {
          occupiedSeats.add(s);
        }
      }
    }

    if (healUpdates.length > 0) {
      await prisma.$transaction(healUpdates);
      console.log(`Self-healed ${healUpdates.length} missing/overlapping reservations in session ${id}`);
    }
    // --- End Self-Healing ---

    const bookingRefs = [...new Set(reservations.map(r => r.booking_ref))];
    const [allRelatedReservations, equipments] = await Promise.all([
      prisma.reservation.findMany({
        where: {
          booking_ref: { in: bookingRefs },
          status: 'confirmed'
        },
        include: {
          session: true
        }
      }),
      prisma.bookingEquipment.findMany({
        where: {
          booking_ref: { in: bookingRefs }
        }
      })
    ]);

    const endTimeMap = {};
    const attendanceMap = {};
    const checkedInAtMap = {};
    const customerNoteMap = {};
    const adminNoteMap = {};

    allRelatedReservations.forEach(r => {
      if (!endTimeMap[r.booking_ref] || r.session.end_time > endTimeMap[r.booking_ref]) {
        endTimeMap[r.booking_ref] = r.session.end_time;
      }
      if (r.attendance === 'checked_in') {
        attendanceMap[r.booking_ref] = 'checked_in';
      } else if (!attendanceMap[r.booking_ref] && r.attendance) {
        attendanceMap[r.booking_ref] = r.attendance;
      }
      if (r.checked_in_at) {
        if (!checkedInAtMap[r.booking_ref] || new Date(r.checked_in_at) < new Date(checkedInAtMap[r.booking_ref])) {
          checkedInAtMap[r.booking_ref] = r.checked_in_at;
        }
      }
      if (r.customer_note && !customerNoteMap[r.booking_ref]) {
        customerNoteMap[r.booking_ref] = r.customer_note;
      }
      if (r.admin_note && !adminNoteMap[r.booking_ref]) {
        adminNoteMap[r.booking_ref] = r.admin_note;
      }
    });

    // Auto-heal any desynced attendance records in database
    const desyncedRefs = [];
    allRelatedReservations.forEach(r => {
      const targetAtt = attendanceMap[r.booking_ref];
      const targetTime = checkedInAtMap[r.booking_ref];
      if (targetAtt && (r.attendance !== targetAtt || (targetTime && !r.checked_in_at))) {
        desyncedRefs.push(r.booking_ref);
      }
    });
    if (desyncedRefs.length > 0) {
      const uniqueRefs = [...new Set(desyncedRefs)];
      for (const uRef of uniqueRefs) {
        prisma.reservation.updateMany({
          where: { booking_ref: uRef },
          data: {
            attendance: attendanceMap[uRef],
            checked_in_at: checkedInAtMap[uRef]
          }
        }).catch(err => console.error('Failed to auto-heal attendance desync in getSessionSeats:', err));
      }
    }

    const equipmentsMap = {};
    equipments.forEach(eq => {
      if (!equipmentsMap[eq.booking_ref]) equipmentsMap[eq.booking_ref] = [];
      equipmentsMap[eq.booking_ref].push(eq);
    });

    const reservationsWithEndTime = reservations.map(r => ({
      ...r,
      attendance: attendanceMap[r.booking_ref] || r.attendance,
      checked_in_at: checkedInAtMap[r.booking_ref] || r.checked_in_at,
      customer_note: customerNoteMap[r.booking_ref] || r.customer_note || null,
      admin_note: adminNoteMap[r.booking_ref] || r.admin_note || null,
      booking_end_time: endTimeMap[r.booking_ref] || session.end_time,
      equipments: equipmentsMap[r.booking_ref] || []
    }));

    res.json({
      session,
      reservations: reservationsWithEndTime
    });
  } catch (error) {
    console.error('Error fetching session seats:', error);
    res.status(500).json({ error: 'Failed to fetch session seats' });
  }
};

export const adminCreateReservation = async (req, res) => {
  const { session_ids, pax, name, phone, forceSplit, isForceWait, isWalkIn, is_walk_in, attendance, autoCheckIn } = req.body || {};
  const effectiveWalkIn = isWalkIn === true || isWalkIn === 'true' || is_walk_in === true || is_walk_in === 'true';
  
  const parsedPax = parseInt(pax, 10);
  if (!Array.isArray(session_ids) || session_ids.length === 0 || !Number.isInteger(parsedPax) || parsedPax < 1) {
    return res.status(400).json({ error: '人數必須為大於 0 的正整數，且必須選擇至少一個時段' });
  }

  if (!isPlainString(name) || !name.trim()) {
    return res.status(400).json({ error: 'Name is required for manual booking.' });
  }

  if (phone !== undefined && phone !== null && !isPlainString(phone)) {
    return res.status(400).json({ error: '電話號碼格式不正確' });
  }
  const cleanName = name.trim();
  const cleanPhone = isPlainString(phone) ? phone.trim() : '';

  try {
    const booking_ref = crypto.randomUUID();

    const result = await prisma.$transaction(async (tx) => {
      // 0. Handle user finding / creation (exclude merged users; prefer real LINE user over manual user)
      let targetUser = null;
      if (cleanPhone) {
        const matchedUsers = await tx.user.findMany({
          where: activeUserWhere({ phone: cleanPhone }),
          orderBy: { id: 'asc' }
        });
        targetUser =
          matchedUsers.find((u) => u.line_user_id && !u.line_user_id.startsWith('manual_')) ||
          matchedUsers[0] ||
          null;
      }

      if (!targetUser) {
        // Create manual user
        targetUser = await tx.user.create({
          data: {
            line_user_id: `manual_${crypto.randomUUID()}`,
            name: cleanName,
            phone: cleanPhone || null
          }
        });
      }

      // 1. Get the requested sessions
      const requestedSessions = await tx.$queryRaw`
        SELECT id, max_capacity, session_date, start_time, end_time
        FROM "Session" 
        WHERE id IN (${Prisma.join(session_ids)}) 
        FOR UPDATE
      `;

      if (requestedSessions.length !== session_ids.length) {
        throw new Error('SOME_SESSIONS_NOT_FOUND');
      }

      // 檢查是否跨日期：一筆預約只能包含同一天的時段
      const uniqueDates = new Set(
        requestedSessions.map(s => {
          return s.session_date instanceof Date
            ? s.session_date.toISOString().slice(0, 10)
            : String(s.session_date).slice(0, 10);
        })
      );
      if (uniqueDates.size > 1) {
        throw new Error('CROSS_DATE_SESSIONS');
      }

      const sessionDate = requestedSessions[0].session_date;

      // Lock ALL sessions for the same date to prevent race conditions across the day
      const dateStr = toTaipeiDateString(sessionDate);
      const allSessionsOfDay = await tx.$queryRaw`
        SELECT id
        FROM "Session"
        WHERE session_date = ${dateStr}::date
        FOR UPDATE
      `;
      await lockDaySeats(tx, dateStr);
      const allSessionIdsOfDay = allSessionsOfDay.map(s => s.id);

      // Fetch all confirmed reservations for the day
      const currentReservations = await tx.reservation.findMany({
        where: { session_id: { in: allSessionIdsOfDay }, status: 'confirmed' }
      });

      // Prepare the new reservation block
      const newReservationBlock = { 
        booking_ref: 'NEW_RES', 
        pax: parseInt(pax, 10), 
        session_ids: session_ids 
      };

      // Run Allocation algorithm or Force Wait
      let mySeats = [];
      let allocReason = null;
      const sessionUpdates = [];

      if (isForceWait === true || isForceWait === 'true') {
        let waitCounter = 1;
        const requestedSessionIdsSet = new Set(session_ids);
        for (const r of currentReservations) {
          if (requestedSessionIdsSet.has(r.session_id) && r.assigned_seats) {
            for (const s of r.assigned_seats) {
              if (s.startsWith('WAIT-')) {
                const num = parseInt(s.split('-')[1]);
                if (num >= waitCounter) waitCounter = num + 1;
              }
            }
          }
        }
        for (let i = 0; i < parseInt(pax, 10); i++) {
          mySeats.push(`WAIT-${waitCounter++}`);
        }
      } else {
        const ctx = await loadAllocatorContext(tx, sessionDate);
        const allocCurrentReservations = [...currentReservations];
        if (effectiveWalkIn) {
          const seatedOccupants = await loadSeatedOccupants(tx, dateStr);
          for (const sCode of Object.keys(seatedOccupants)) {
            for (const sId of session_ids) {
              allocCurrentReservations.push({
                booking_ref: `__SEATED_${seatedOccupants[sCode].booking_ref}_${sCode}__`,
                session_id: sId,
                assigned_seats: [sCode],
                pax: 1,
                status: 'confirmed',
                attendance: 'checked_in',
                is_seat_locked: true,
                seat_source: 'staff',
                is_pinned: true
              });
            }
          }
        }
        const allocResult = allocateSeats(allocCurrentReservations, newReservationBlock, forceSplit === true || forceSplit === 'true', ctx);

        if (!allocResult.success) {
          if (allocResult.error === 'INSUFFICIENT_SEATS') throw new Error('INSUFFICIENT_CAPACITY');
          if (allocResult.error === 'SPLIT_REQUIRED') throw new Error('SPLIT_REQUIRED');
          throw new Error('ALLOCATION_FAILED');
        }

        mySeats = allocResult.updates.find(u => u.booking_ref === 'NEW_RES').assigned_seats;
        allocReason = allocResult.reason || null;

        await applyMovableSeatUpdates(tx, allocResult.updates);
      }

      // Smart Pegboard / Equipment fee calculation
      const sortedRequestedSessions = [...requestedSessions].sort((a, b) => a.start_time.localeCompare(b.start_time));
      const bookedHours = computeBookedHours(sortedRequestedSessions, session_ids.length);
      const equipments = req.body.equipments;
      let totalEquipmentFee = 0;
      const newEquipmentRecords = [];

      if (Array.isArray(equipments) && equipments.length > 0) {
        const allConfigs = await tx.equipmentConfig.findMany();
        const configMap = {};
        allConfigs.forEach(c => { configMap[c.id] = c; });

        const globalSetting = await tx.globalSetting.findUnique({ where: { id: 1 } });
        const discountConfig = {
          enabled: globalSetting ? globalSetting.equipment_discount_enabled !== false : true,
          buy_hours: globalSetting?.equipment_discount_buy_hours ?? 3,
          free_hours: globalSetting?.equipment_discount_free_hours ?? 1,
          stackable: globalSetting ? globalSetting.equipment_discount_stackable !== false : true,
          tier2_enabled: !!globalSetting?.equipment_discount2_enabled,
          tier2_buy_hours: globalSetting?.equipment_discount2_buy_hours ?? 8,
          tier2_free_hours: globalSetting?.equipment_discount2_free_hours ?? 4
        };

        const totalHours = session_ids.length;

        for (const eq of equipments) {
          const qty = parseInt(eq.quantity, 10) || 0;
          if (qty <= 0) continue;

          const config = configMap[eq.equipment_id];
          if (!config) continue;

          const minHours = config.min_contiguous_hours || 2;
          const rentalHours = totalHours < minHours 
            ? totalHours 
            : Math.max(minHours, Math.min(totalHours, parseInt(eq.rental_hours, 10) || totalHours));

          const chargeableHours = calculateEquipmentChargeableHours(rentalHours, discountConfig);

          const singlePrice = (config.daily_cap && config.daily_cap > 0)
            ? Math.min(config.hourly_rate * chargeableHours, config.daily_cap)
            : (config.hourly_rate * chargeableHours);
          const subtotal = singlePrice * qty;
          totalEquipmentFee += subtotal;

          const coveredSessionsStrings = sortedRequestedSessions
            .slice(0, rentalHours)
            .map(s => `${s.start_time}-${s.end_time}`);

          newEquipmentRecords.push({
            booking_ref,
            equipment_id: eq.equipment_id,
            equipment_name_snapshot: config.name,
            quantity: qty,
            rental_hours: rentalHours,
            unit_rate: config.hourly_rate,
            daily_cap_snapshot: config.daily_cap ?? null,
            subtotal_price: subtotal,
            covered_sessions: coveredSessionsStrings
          });
        }
      }

      const newReservationsData = [];
      const is_unlimited = req.body.isUnlimited === true || req.body.isUnlimited === 'true' || req.body.is_unlimited === true || req.body.is_unlimited === 'true';
      const adminDailyRates = await getEffectiveDailyRates(tx, sessionDate);
      const adminPricingSnapshot = {
        hourly: adminDailyRates.hourly_price,
        unlimited: adminDailyRates.unlimited_price,
        allow_unlimited: adminDailyRates.allow_unlimited,
        is_weekend: adminDailyRates.is_weekend,
        captured_at: new Date().toISOString()
      };
      const baseSeatingPrice = await calculateTotalAmount(tx, sessionDate, parseInt(pax, 10), bookedHours, is_unlimited);
      const totalAmount = baseSeatingPrice + totalEquipmentFee;

      const shouldAutoCheckIn = attendance === 'checked_in' || autoCheckIn === true || autoCheckIn === 'true' || isWalkIn === true || isWalkIn === 'true';
      const checkInStatus = shouldAutoCheckIn ? 'checked_in' : (attendance || null);
      const checkInTime = shouldAutoCheckIn ? new Date() : null;
      const cleanCustomerNote = req.body.customer_note ? String(req.body.customer_note).trim() : null;
      const cleanAdminNote = req.body.admin_note ? String(req.body.admin_note).trim() : null;
      const initialAdminDraft = buildInitialDraft({
        pax: parseInt(pax, 10),
        isUnlimited: is_unlimited,
        updatedBy: req.user?.name || '門市人員'
      });

      for (const sessionId of session_ids) {
        newReservationsData.push({
          booking_ref,
          session_id: sessionId,
          user_id: targetUser.id,
          pax: parseInt(pax, 10),
          status: 'confirmed',
          attendance: checkInStatus,
          checked_in_at: checkInTime,
          assigned_seats: mySeats,
          is_force_split: forceSplit === true || forceSplit === 'true',
          is_walk_in: effectiveWalkIn,
          is_unlimited: is_unlimited,
          total_amount: totalAmount,
          checkout_details: initialAdminDraft,
          customer_note: cleanCustomerNote,
          admin_note: cleanAdminNote,
          pricing_snapshot: adminPricingSnapshot
        });
      }

      if (sessionUpdates.length > 0) {
        await Promise.all(sessionUpdates);
      }

      // Create the new reservations with their assigned seats
      const newReservations = await tx.reservation.createMany({
        data: newReservationsData
      });

      if (newEquipmentRecords.length > 0) {
        await tx.bookingEquipment.createMany({
          data: newEquipmentRecords
        });
      }

      const { bill: verifiedAdminBill } = await getBookingBill(booking_ref, tx);
      if ((verifiedAdminBill?.summary?.amount_due ?? 0) !== totalAmount) {
        throw new Error(`BILL_MISMATCH: expected total=${totalAmount}, got due=${verifiedAdminBill?.summary?.amount_due}`);
      }

      return {
        booking_ref,
        count: newReservations.count,
        assigned_seats: mySeats,
        reason: allocReason || (isForceWait ? '放入等待區' : undefined)
      };
    });

    res.status(201).json({ message: 'Manual reservation successful', reservation: result });

  } catch (error) {
    console.error('Manual Reservation error:', error);
    if (error.status) {
      return res.status(error.status).json({
        error: error.message,
        ...(error.code ? { code: error.code } : {})
      });
    }
    if (error.message === 'CROSS_DATE_SESSIONS') {
      return res.status(400).json({ error: '一筆預約只能包含同一天的時段' });
    }
    if (error.message === 'SOME_SESSIONS_NOT_FOUND') {
      return res.status(404).json({ error: 'One or more sessions not found.' });
    }
    if (error.message === 'INSUFFICIENT_CAPACITY') {
      return res.status(400).json({ error: 'Not enough capacity remaining for one or more selected sessions.' });
    }
    if (error.message === 'SPLIT_REQUIRED') {
      return res.status(409).json({ error: '連續座位不足，同行者將被拆散。是否確認預約？' });
    }
    res.status(500).json({ error: 'Failed to create manual reservation.' });
  }
};

function cloneReservationRow(base, overrides = {}) {
  const excluded = new Set(['id', 'session_id', 'created_at', 'updated_at']);
  const row = {};
  for (const field of Object.values(Prisma.ReservationScalarFieldEnum)) {
    if (excluded.has(field)) continue;
    if (base[field] !== undefined && base[field] !== null) {
      row[field] = base[field];
    }
  }
  return { ...row, ...overrides };
}

export const extendReservation = async (req, res) => {
  const { booking_ref } = req.params;
  const { session_ids, extendMode, forceSplit } = req.body;
  const staffName = req.user?.name || '門市人員';
  const staffId = req.user?.id || null;
  const deviceInfo = getAdminDeviceInfo(req);

  if (!Array.isArray(session_ids) || session_ids.length === 0) {
    return res.status(400).json({ error: '請至少選擇一個加時時段' });
  }

  const uniqueSessionIds = [...new Set(session_ids.map(Number).filter(Number.isInteger))];
  if (uniqueSessionIds.length !== session_ids.length || uniqueSessionIds.length === 0) {
    return res.status(400).json({ error: '選取的時段格式不正確或有重複' });
  }

  try {
    const sessionsPre = await prisma.session.findMany({
      where: { id: { in: uniqueSessionIds } },
      select: { id: true, session_date: true }
    });
    if (sessionsPre.length !== uniqueSessionIds.length) {
      return res.status(404).json({ error: '找不到指定的時段' });
    }
    const extendDateStr = toTaipeiDateString(sessionsPre[0].session_date);

    const result = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`
        SELECT id
        FROM "Session"
        WHERE session_date = ${extendDateStr}::date
        FOR UPDATE
      `;
      await lockDaySeats(tx, extendDateStr);
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${booking_ref}))`;

      // Find existing reservation details with session info
      const existingReservations = await tx.reservation.findMany({
        where: { booking_ref, status: 'confirmed' },
        include: { session: true },
        orderBy: { session: { start_time: 'asc' } }
      });

      if (existingReservations.length === 0) {
        throw { status: 404, message: '找不到原本的預約' };
      }

      const baseReservation = existingReservations[0];
      if (baseReservation.attendance === 'completed' || baseReservation.attendance === 'no_show') {
        throw { status: 409, code: 'ATTENDANCE_NOT_EXTENDABLE', message: '已離場或未到的預約不能加時' };
      }

      const bookingDateStr = toTaipeiDateString(baseReservation.session.session_date);

      const sessions = await tx.session.findMany({
        where: { id: { in: uniqueSessionIds } },
        include: {
          reservations: {
            where: {
              status: 'confirmed',
              OR: [{ attendance: null }, { attendance: { notIn: ['completed', 'no_show'] } }]
            },
            select: { pax: true, assigned_seats: true }
          }
        },
        orderBy: { start_time: 'asc' }
      });

      if (sessions.length !== uniqueSessionIds.length) {
        throw { status: 404, message: '找不到指定的時段' };
      }

      if (sessions.some(s => toTaipeiDateString(s.session_date) !== bookingDateStr)) {
        throw { status: 400, code: 'CROSS_DATE_EXTEND', message: '加時只能加同一天的時段' };
      }

      const existingSessIdSet = new Set(existingReservations.map(r => r.session_id));
      const dupSession = sessions.find(s => existingSessIdSet.has(s.id));
      if (dupSession) {
        throw {
          status: 409,
          code: 'DUPLICATE_SESSION',
          message: `${dupSession.start_time.slice(0, 5)} 這個時段已經在這筆預約裡`
        };
      }

      // Check contiguity: all new sessions form one block immediately before or after existing sessions
      const allDaySessions = await tx.session.findMany({
        where: { session_date: baseReservation.session.session_date },
        orderBy: { start_time: 'asc' },
        select: { id: true, start_time: true, end_time: true }
      });
      const indexById = new Map(allDaySessions.map((s, idx) => [s.id, idx]));
      const existingIndices = existingReservations
        .map(r => indexById.get(r.session_id))
        .filter(i => i !== undefined)
        .sort((a, b) => a - b);
      const newIndices = sessions
        .map(s => indexById.get(s.id))
        .filter(i => i !== undefined)
        .sort((a, b) => a - b);

      let newIsContiguous = newIndices.length === sessions.length;
      for (let i = 1; i < newIndices.length; i++) {
        if (newIndices[i] !== newIndices[i - 1] + 1) {
          newIsContiguous = false;
          break;
        }
      }
      const existMinIdx = existingIndices[0];
      const existMaxIdx = existingIndices[existingIndices.length - 1];
      const newMinIdx = newIndices[0];
      const newMaxIdx = newIndices[newIndices.length - 1];
      const attachesToExisting = existingIndices.length > 0 && (
        newMaxIdx === existMinIdx - 1 || newMinIdx === existMaxIdx + 1
      );
      if (!newIsContiguous || !attachesToExisting) {
        throw { status: 400, code: 'NON_CONTIGUOUS_EXTEND', message: '加時的時段要和原本的時段相連' };
      }

      const { user_id, pax, assigned_seats, is_walk_in } = baseReservation;

      // Inherit attendance, checked_in_at, and payment details
      const checkedInRes = existingReservations.find(r => r.attendance === 'checked_in') || existingReservations.find(r => r.attendance != null);
      const inheritedAttendance = checkedInRes ? checkedInRes.attendance : (baseReservation.attendance || null);
      const inheritedCheckedInAt = checkedInRes ? checkedInRes.checked_in_at : (baseReservation.checked_in_at || null);

      const paidRes = existingReservations.find(r => r.is_paid) || baseReservation;
      const inheritedIsPaid = paidRes.is_paid || false;
      const inheritedPaidAt = paidRes.paid_at || null;
      const inheritedIsAmountManual = baseReservation.is_amount_manual || false;

      if (inheritedAttendance) {
        await tx.reservation.updateMany({
          where: { booking_ref, status: 'confirmed' },
          data: {
            attendance: inheritedAttendance,
            checked_in_at: inheritedCheckedInAt
          }
        });
      }

      let mySeats = [];

      // Fetch current active reservations in the target sessions for allocator
      const allCurrentReservations = await tx.reservation.findMany({
        where: {
          session_id: { in: uniqueSessionIds },
          status: 'confirmed',
          OR: [{ attendance: null }, { attendance: { notIn: ['completed', 'no_show'] } }]
        }
      });

      if (extendMode === 'force_wait') {
        let maxWait = 0;
        for (const r of allCurrentReservations) {
          if (r.assigned_seats) {
            for (const seat of r.assigned_seats) {
              if (seat.startsWith('WAIT-')) {
                const num = parseInt(seat.replace('WAIT-', ''), 10);
                if (!isNaN(num) && num > maxWait) maxWait = num;
              }
            }
          }
        }
        let waitCounter = maxWait + 1;
        for (let i = 0; i < pax; i++) {
          mySeats.push(`WAIT-${waitCounter++}`);
        }
      } else {
        for (const session of sessions) {
          const bookedPax = session.reservations.reduce((sum, r) => sum + r.pax, 0);
          const activeLayout = await getActiveLayoutForDate(tx, session.session_date);
          const layoutCapacity = (activeLayout?.capacity && activeLayout.capacity > 0)
            ? activeLayout.capacity
            : ((activeLayout?.seats || []).filter(s => s.is_active).length || 16);
          if (layoutCapacity - bookedPax < pax) {
            throw { status: 400, code: 'INSUFFICIENT_CAPACITY', message: '加時時段座位已滿，無法加時' };
          }
        }

        if (extendMode === 'keep_seat') {
          mySeats = assigned_seats || [];
        } else if (extendMode === 'system_allocate') {
          const newBlock = { booking_ref: 'NEW_RES', pax, session_ids: uniqueSessionIds };
          const ctx = await loadAllocatorContext(tx, sessions[0]?.session_date);
          const allocResult = allocateSeats(allCurrentReservations, newBlock, forceSplit === true || forceSplit === 'true', ctx);

          if (!allocResult.success) {
            if (allocResult.error === 'INSUFFICIENT_SEATS') {
              throw { status: 400, code: 'INSUFFICIENT_CAPACITY', message: '加時時段座位已滿，無法加時' };
            }
            if (allocResult.error === 'SPLIT_REQUIRED') {
              throw { status: 409, code: 'SPLIT_REQUIRED', message: '連續座位不足，同行者將被拆散。是否確認預約？' };
            }
            throw { status: 400, message: '無法為加時時段分配座位' };
          }

          mySeats = allocResult.updates.find(u => u.booking_ref === 'NEW_RES').assigned_seats;
          await applyMovableSeatUpdates(tx, allocResult.updates);
        }
      }

      const newReservationsData = uniqueSessionIds.map(sessionId =>
        cloneReservationRow(baseReservation, {
          session_id: sessionId,
          assigned_seats: mySeats,
          is_force_split: forceSplit === true || forceSplit === 'true',
          attendance: inheritedAttendance,
          checked_in_at: inheritedCheckedInAt,
          is_paid: inheritedIsPaid,
          paid_at: inheritedPaidAt,
          is_amount_manual: inheritedIsAmountManual
        })
      );

      const newReservations = await tx.reservation.createMany({
        data: newReservationsData
      });

      // If keep_seat, trigger transactional reshuffle inside the same tx/lock then verify no collisions
      if (extendMode === 'keep_seat') {
        await reshuffleAfterSeatChange(tx, uniqueSessionIds, [booking_ref]);
      }
      if (extendMode !== 'force_wait') {
        await assertNoSeatCollisions(tx, uniqueSessionIds);
      }

      // Compute pending supplements for already-paid non-unlimited persons
      const activePersons = await tx.bookingPerson.findMany({
        where: { booking_ref, status: 'active' },
        orderBy: { person_no: 'asc' }
      });
      const validPayments = await tx.payment.findMany({
        where: { booking_ref, status: 'valid', kind: { in: ['charge', 'waive'] } },
        orderBy: { created_at: 'desc' }
      });

      let addedHours = 0;
      for (const s of sessions) {
        const sStart = new Date(`${bookingDateStr}T${s.start_time}:00+08:00`);
        let sEnd = new Date(`${bookingDateStr}T${s.end_time}:00+08:00`);
        if (sEnd <= sStart) sEnd = new Date(sEnd.getTime() + 24 * 60 * 60 * 1000);
        addedHours += Math.max(0, (sEnd.getTime() - sStart.getTime()) / 3600000);
      }

      const dailyRates = await getEffectiveDailyRates(tx, baseReservation.session.session_date);
      const hourlyPrice = Number(dailyRates.hourly_price ?? 150);
      const unlimitedPrice = dailyRates.unlimited_price != null ? Number(dailyRates.unlimited_price) : null;
      const allowUnlimited = Boolean(dailyRates.allow_unlimited);

      const currentDraft = (baseReservation.checkout_details && typeof baseReservation.checkout_details === 'object')
        ? baseReservation.checkout_details
        : {};
      const currentRev = Number.isInteger(currentDraft.rev) ? currentDraft.rev : 0;
      const prevPending = Array.isArray(currentDraft.pending_supplements) ? currentDraft.pending_supplements : [];
      const draftPersons = Array.isArray(currentDraft.persons) ? currentDraft.persons : [];

      const sourceKey = `extend:${uniqueSessionIds.slice().sort((a, b) => a - b).join('-')}`;
      const hoursText = Number.isInteger(addedHours) ? String(addedHours) : addedHours.toFixed(1);
      const extendLabel = `加時 ${hoursText} 小時`;

      const personNosToCheck = activePersons.length > 0
        ? activePersons.map(p => p.person_no)
        : Array.from({ length: pax }, (_, idx) => idx + 1);

      const addedSupplements = [];
      for (const pNo of personNosToCheck) {
        const personObj = activePersons.find(p => p.person_no === pNo) || { person_no: pNo };
        const paid = await isPersonPaid(tx, booking_ref, pNo, baseReservation);
        if (!paid) continue;

        const dPerson = draftPersons.find(dp => Number(dp.person_no) === pNo);
        const isUnl = dPerson?.mode ? dPerson.mode === 'unlimited' : Boolean(baseReservation.is_unlimited);
        if (isUnl) continue;

        const alreadyHas = prevPending.some(
          ps => Number(ps?.person_no) === pNo && ps?.source_key === sourceKey
        );
        if (alreadyHas) continue;

        let snapshotEntry = null;
        for (const pay of validPayments) {
          const snapList = Array.isArray(pay.breakdown_json?.persons) ? pay.breakdown_json.persons : [];
          const snapPerson = snapList.find(sp => Number(sp.person_no) === pNo);
          if (snapPerson) {
            snapshotEntry = Number(snapPerson.entry?.amount ?? snapPerson.total ?? 0);
            break;
          }
        }
        if (snapshotEntry === null) snapshotEntry = 0;

        const rawExtended = snapshotEntry + Math.round(addedHours * hourlyPrice);
        const cappedExtended = (allowUnlimited && unlimitedPrice != null)
          ? Math.min(rawExtended, unlimitedPrice)
          : rawExtended;
        const suppAmount = Math.max(0, Math.round(cappedExtended - snapshotEntry));
        if (suppAmount > 0) {
          addedSupplements.push({
            person_no: pNo,
            source_key: sourceKey,
            source_type: 'other',
            label: extendLabel,
            amount: suppAmount
          });
        }
      }

      if (addedSupplements.length > 0) {
        await saveDraft(
          booking_ref,
          currentRev,
          { ...currentDraft, pending_supplements: [...prevPending, ...addedSupplements] },
          staffName,
          staffId,
          deviceInfo,
          tx
        );

        const rangeStr = `${sessions[0].start_time.slice(0, 5)}–${sessions[sessions.length - 1].end_time.slice(0, 5)}`;
        const detailText = addedSupplements.map(s => `第 ${s.person_no} 位待補收 NT$${s.amount}`).join('、');
        await auditLog(tx, {
          booking_ref,
          event_type: 'amount_adjusted',
          category: 'amount',
          summary: `加時 ${rangeStr}，${detailText}`,
          reason: '已付款加時待補收',
          staff_name: staffName,
          staff_id: staffId,
          device_id: deviceInfo?.device_id || null,
          device_label: deviceInfo?.device_label || null
        });
      }

      await recalculateReservationTotal(tx, booking_ref);
      await refreshBillingCache(tx, booking_ref);

      return { count: newReservations.count };
    });

    displayBus.floorChanged();
    res.status(201).json({ message: '加時成功', result });

  } catch (error) {
    console.error('Extend Reservation error:', error);
    if (error.status) {
      return res.status(error.status).json({
        error: error.message,
        ...(error.code ? { code: error.code } : {})
      });
    }
    if (error.message === 'RESERVATION_NOT_FOUND') {
      return res.status(404).json({ error: '找不到原本的預約' });
    }
    if (error.message === 'SOME_SESSIONS_NOT_FOUND') {
      return res.status(404).json({ error: '找不到指定的時段' });
    }
    if (error.message === 'INSUFFICIENT_CAPACITY') {
      return res.status(400).json({ error: '加時時段座位已滿，無法加時' });
    }
    if (error.message === 'SPLIT_REQUIRED') {
      return res.status(409).json({ error: '連續座位不足，同行者將被拆散。是否確認預約？' });
    }
    res.status(500).json({ error: '加時失敗，請稍後再試' });
  }
};

export const updateAttendance = async (req, res) => {
  const { id: booking_ref } = req.params;
  const { attendance } = req.body; // 'checked_in', 'no_show', or null
  const staffName = req.user?.name || '門市人員';
  const staffId = req.user?.id || null;
  const deviceInfo = getAdminDeviceInfo(req);
  const now = (process.env.NODE_ENV === 'test' && (req.body?.now || req.query?.now))
    ? new Date(req.body?.now || req.query?.now)
    : new Date();

  try {
    if (attendance === null || attendance === '') {
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
        const prevAttendance = firstRes.attendance;
        if (prevAttendance !== 'checked_in' && prevAttendance !== 'no_show') {
          throw { status: 409, code: 'INVALID_ATTENDANCE_TRANSITION', message: '這筆預約目前不能改回未報到' };
        }

        const bookingDateStr = toTaipeiDateString(firstRes.session.session_date);
        const todayStr = toTaipeiDateString(now);
        if (bookingDateStr !== todayStr) {
          throw { status: 409, code: 'NOT_TODAY', message: '只能處理今天的預約' };
        }

        const payment = await tx.payment.findFirst({
          where: { booking_ref, status: 'valid' }
        });
        if (payment) {
          throw { status: 409, code: 'HAS_VALID_PAYMENT', message: '已有收款，不能取消報到' };
        }

        const equips = await tx.bookingEquipment.findMany({
          where: { booking_ref },
          select: { unit_group: true }
        });
        const unitGroups = [...new Set(equips.map(e => e.unit_group).filter(Boolean))];
        if (unitGroups.length > 0) {
          await tx.boardPause.updateMany({
            where: {
              unit_group: { in: unitGroups },
              source: 'person',
              ended_at: null
            },
            data: { ended_at: now }
          });
        }

        await tx.bookingEquipment.updateMany({
          where: { booking_ref },
          data: { person_id: null }
        });

        await tx.bookingPerson.deleteMany({
          where: { booking_ref }
        });

        const updated = await tx.reservation.updateMany({
          where: { booking_ref, status: { not: 'cancelled' } },
          data: {
            attendance: null,
            checked_in_at: null,
            checked_in_by: null,
            seat_source: 'auto'
          }
        });

        await auditLog(tx, {
          booking_ref,
          event_type: prevAttendance === 'no_show' ? 'no_show_reverted' : 'check_in_cancelled',
          category: 'seating',
          summary: prevAttendance === 'no_show' ? '未到還原為未報到' : '取消報到並清除板子人員指派',
          before_json: { attendance: prevAttendance },
          after_json: { attendance: null },
          staff_name: staffName,
          staff_id: staffId,
          device_id: deviceInfo?.device_id || null,
          device_label: deviceInfo?.device_label || null
        });

        await refreshBillingCache(tx, booking_ref);
        return { count: updated.count };
      });

      displayBus.floorChanged();
      return res.json({ message: '報到已取消', count: result.count, attendance: null });
    }

    if (attendance === 'no_show') {
      const result = await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${booking_ref}))`;

        const reservations = await tx.reservation.findMany({
          where: { booking_ref, status: { not: 'cancelled' } }
        });
        if (!reservations.length) {
          throw { status: 404, message: '找不到此筆預約' };
        }

        const currentAttendance = reservations[0].attendance;
        if (currentAttendance !== null && currentAttendance !== '' && currentAttendance !== 'pending') {
          throw { status: 409, code: 'INVALID_ATTENDANCE_TRANSITION', message: '只有未報到的預約才能標記未到' };
        }

        const updated = await tx.reservation.updateMany({
          where: { booking_ref, status: { not: 'cancelled' } },
          data: { attendance: 'no_show', checked_in_at: null }
        });
        return { count: updated.count };
      });

      displayBus.floorChanged();
      return res.json({
        message: 'Attendance updated successfully',
        count: result.count,
        attendance: 'no_show',
        checked_in_at: null
      });
    }

    const dataToUpdate = { attendance };
    if (attendance === 'checked_in') {
      dataToUpdate.checked_in_at = now;
      dataToUpdate.checked_in_by = staffName;
    } else {
      dataToUpdate.checked_in_at = null;
    }

    const updated = await prisma.reservation.updateMany({
      where: { booking_ref, status: { not: 'cancelled' } },
      data: dataToUpdate
    });

    if (updated.count === 0) {
      return res.status(404).json({ error: 'Reservation not found' });
    }

    displayBus.floorChanged();
    res.json({
      message: 'Attendance updated successfully',
      count: updated.count,
      attendance,
      checked_in_at: dataToUpdate.checked_in_at
    });
  } catch (error) {
    console.error('Error updating attendance:', error);
    if (error.status) {
      return res.status(error.status).json({
        error: error.message,
        ...(error.code ? { code: error.code } : {})
      });
    }
    res.status(500).json({ error: 'Failed to update attendance' });
  }
};

export const updatePaymentStatus = async (req, res) => {
  const { booking_ref } = req.params;
  const { is_paid, reason, payment_method } = req.body;
  const deviceInfo = getAdminDeviceInfo(req);

  if (typeof is_paid !== 'boolean') {
    return res.status(400).json({ error: 'Invalid payment status' });
  }

  try {
    if (!is_paid) {
      const result = await markUnpaid(booking_ref, reason || '未填原因（舊版畫面）', req.user, deviceInfo);
      return res.json({ message: 'Payment status updated successfully', is_paid: false, ...result });
    } else {
      const billData = await getBookingBill(booking_ref);
      const unpaidPersonNos = (billData.bill.persons || [])
        .filter(p => !p.is_paid && !p.paid && !p.is_frozen && p.status !== 'removed')
        .map(p => p.person_no);

      if (unpaidPersonNos.length === 0) {
        return res.json({ message: '所有顧客皆已完成付款', is_paid: true });
      }

      const result = await collectPayment(
        booking_ref,
        {
          person_nos: unpaidPersonNos,
          method: payment_method || 'cash',
          note: reason || '舊版收款更新'
        },
        req.user,
        deviceInfo
      );
      return res.json({ message: 'Payment status updated successfully', is_paid: true, ...result });
    }
  } catch (error) {
    console.error('Error updating payment status:', error);
    if (error.status) return res.status(error.status).json({ error: error.message });
    res.status(500).json({ error: 'Failed to update payment status' });
  }
};

export const updateAmount = async (req, res) => {
  const { booking_ref } = req.params;
  const { total_amount, reason } = req.body;
  const deviceInfo = getAdminDeviceInfo(req);

  if (total_amount === undefined || isNaN(parseInt(total_amount, 10))) {
    return res.status(400).json({ error: 'Valid total_amount is required' });
  }

  try {
    const billData = await getBookingBill(booking_ref);
    if (billData.status.code === 'paid' || billData.status.code === 'waived') {
      return res.status(409).json({ error: '已結清的訂單請用補收或退款' });
    }

    const draft = billData.draft || {};
    draft.total_override = {
      amount: parseInt(total_amount, 10),
      reason: reason ? String(reason).trim() : '金額手動調整'
    };

    const newBill = await saveDraft(
      booking_ref,
      draft.rev,
      draft,
      req.user?.name || '管理員',
      req.user?.id || null,
      deviceInfo
    );

    return res.json({ message: 'Amount updated successfully', total_amount: parseInt(total_amount, 10), bill: newBill });
  } catch (error) {
    console.error('Error updating amount:', error);
    if (error.status) return res.status(error.status).json({ error: error.message });
    return res.status(500).json({ error: 'Failed to update amount' });
  }
};

async function updateReservationNotesCore(req, res, { actor }) {
  const { booking_ref } = req.params;
  const { customer_note, admin_note } = req.body;
  const userId = req.user?.id;
  const isStaff = actor === 'admin';

  try {
    const reservations = await prisma.reservation.findMany({
      where: { booking_ref }
    });

    if (reservations.length === 0) {
      return res.status(404).json({ error: '找不到該筆預約訂單' });
    }

    if (!isStaff && reservations[0].user_id !== userId) {
      return res.status(403).json({ error: '無權限修改此預約備註' });
    }

    const dataToUpdate = {};
    if (customer_note !== undefined) {
      dataToUpdate.customer_note = customer_note ? String(customer_note).trim() : null;
    }
    if (isStaff && admin_note !== undefined) {
      dataToUpdate.admin_note = admin_note ? String(admin_note).trim() : null;
    }

    await prisma.reservation.updateMany({
      where: { booking_ref },
      data: dataToUpdate
    });

    const responseData = {
      message: '備註已更新！',
      customer_note: dataToUpdate.customer_note !== undefined ? dataToUpdate.customer_note : reservations[0].customer_note
    };
    if (isStaff) {
      responseData.admin_note = dataToUpdate.admin_note !== undefined ? dataToUpdate.admin_note : reservations[0].admin_note;
    }

    res.json(responseData);
  } catch (error) {
    console.error('Error updating reservation notes:', error);
    res.status(500).json({ error: '更新備註失敗' });
  }
}

export const updateReservationNotes = (req, res) => updateReservationNotesCore(req, res, { actor: 'customer' });
export const adminUpdateReservationNotes = (req, res) => updateReservationNotesCore(req, res, { actor: 'admin' });

/**
 * Admin Sidebar Navigation Live Badges
 */
export const getAdminNavBadges = async (req, res) => {
  try {
    const now = new Date();
    const taipeiDateStr = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Taipei',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).format(now);

    const startDate = new Date(`${taipeiDateStr}T00:00:00.000Z`);
    const endDate = new Date(startDate);
    endDate.setDate(endDate.getDate() + 1);

    const [todayReservations, pendingShopVerifyCount, arrivedShopCount, selfPrepayPendingVerifyCount] = await Promise.all([
      prisma.reservation.findMany({
        where: {
          status: 'confirmed',
          session: {
            session_date: {
              gte: startDate,
              lt: endDate
            }
          }
        },
        select: {
          booking_ref: true,
          attendance: true,
          is_paid: true
        }
      }),
      prisma.productOrder ? prisma.productOrder.count({
        where: {
          order_status: { not: 'cancelled' },
          payment_status: 'reported_pending_verify'
        }
      }).catch(() => 0) : Promise.resolve(0),
      prisma.productOrder ? prisma.productOrder.count({
        where: {
          order_status: 'arrived'
        }
      }).catch(() => 0) : Promise.resolve(0),
      prisma.bookingPrepay ? prisma.bookingPrepay.count({
        where: {
          status: { in: ['reported_pending_verify', 'mismatch'] },
          amount_due: { gt: 0 }
        }
      }).catch(() => 0) : Promise.resolve(0)
    ]);

    const refMap = new Map();
    for (const r of todayReservations) {
      const existing = refMap.get(r.booking_ref) || { checked_in: false, is_paid: false };
      if (r.attendance === 'checked_in') existing.checked_in = true;
      if (r.is_paid) existing.is_paid = true;
      refMap.set(r.booking_ref, existing);
    }

    let todayTotalGroups = refMap.size;
    let todayPendingCheckin = 0;
    let todayUnpaid = 0;
    for (const val of refMap.values()) {
      if (!val.checked_in) todayPendingCheckin++;
      if (!val.is_paid) todayUnpaid++;
    }

    res.json({
      today_total_groups: todayTotalGroups,
      today_pending_checkin: todayPendingCheckin,
      today_unpaid: todayUnpaid,
      shop_pending_verify: pendingShopVerifyCount,
      shop_arrived_unpicked: arrivedShopCount,
      self_prepay_pending_verify: selfPrepayPendingVerifyCount
    });
  } catch (error) {
    console.error('getAdminNavBadges error:', error);
    res.json({
      today_total_groups: 0,
      today_pending_checkin: 0,
      today_unpaid: 0,
      shop_pending_verify: 0,
      shop_arrived_unpicked: 0,
      self_prepay_pending_verify: 0
    });
  }
};

/**
 * Admin Universal Counter Quick Lookup (Reservations + Passes + Shop Preorders)
 */
export const adminQuickLookup = async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) {
    return res.json({ reservations: [], passes: [], shop_orders: [] });
  }

  try {
    const shortRefMatch = q.match(/^(?:BK-)?([0-9a-fA-F]{4})-([0-9a-fA-F]{4})$/i);
    const cleanRefPrefix = q.replace(/^BK-/i, '');
    const resOrConditions = [
      { booking_ref: { contains: q, mode: 'insensitive' } },
      { user: activeUserWhere({ name: { contains: q, mode: 'insensitive' } }) },
      { user: activeUserWhere({ phone: { contains: q } }) }
    ];
    if (cleanRefPrefix && cleanRefPrefix !== q) {
      resOrConditions.push({ booking_ref: { contains: cleanRefPrefix, mode: 'insensitive' } });
    }
    if (shortRefMatch) {
      resOrConditions.push({
        AND: [
          { booking_ref: { startsWith: shortRefMatch[1], mode: 'insensitive' } },
          { booking_ref: { endsWith: shortRefMatch[2], mode: 'insensitive' } }
        ]
      });
    }

    const [matchedRefRows, passes, shopOrders] = await Promise.all([
      prisma.reservation.findMany({
        where: { OR: resOrConditions },
        select: { booking_ref: true, created_at: true },
        orderBy: { created_at: 'desc' },
        take: 100
      }),
      prisma.userPass ? prisma.userPass.findMany({
        where: {
          OR: [
            { pass_code: { contains: q, mode: 'insensitive' } },
            { user: activeUserWhere({ name: { contains: q, mode: 'insensitive' } }) },
            { user: activeUserWhere({ phone: { contains: q } }) }
          ]
        },
        include: {
          user: {
            select: { id: true, name: true, phone: true }
          }
        },
        orderBy: { created_at: 'desc' },
        take: 10
      }).catch(() => []) : Promise.resolve([]),
      prisma.productOrder ? prisma.productOrder.findMany({
        where: {
          OR: [
            { order_ref: { contains: q, mode: 'insensitive' } },
            { remittance_last5: { contains: q } },
            { assigned_pool_account: { contains: q } },
            { user: activeUserWhere({ name: { contains: q, mode: 'insensitive' } }) },
            { user: activeUserWhere({ phone: { contains: q } }) }
          ]
        },
        include: {
          user: {
            select: { id: true, name: true, phone: true }
          },
          items: true
        },
        orderBy: { created_at: 'desc' },
        take: 10
      }).catch(() => []) : Promise.resolve([])
    ]);

    const bookingRefs = [...new Set(matchedRefRows.map(r => r.booking_ref))].slice(0, 10);
    const [rawReservations, equipments] = bookingRefs.length > 0
      ? await Promise.all([
          prisma.reservation.findMany({
            where: { booking_ref: { in: bookingRefs } },
            include: {
              session: true,
              user: {
                select: { id: true, name: true, phone: true, line_user_id: true, line_display_name: true }
              }
            },
            orderBy: { created_at: 'desc' }
          }),
          prisma.bookingEquipment.findMany({ where: { booking_ref: { in: bookingRefs } } })
        ])
      : [[], []];

    const equipmentsMap = {};
    equipments.forEach(eq => {
      if (!equipmentsMap[eq.booking_ref]) equipmentsMap[eq.booking_ref] = [];
      equipmentsMap[eq.booking_ref].push(eq);
    });

    const groupedReservations = groupReservations(rawReservations, equipmentsMap);

    res.json({
      reservations: groupedReservations,
      passes,
      shop_orders: shopOrders
    });
  } catch (error) {
    console.error('adminQuickLookup error:', error);
    res.status(500).json({ error: '查詢失敗' });
  }
};

/**
 * 顧客手機進場條碼與狀態端點
 * GET /api/reservations/:booking_ref/entry
 */
export const getReservationEntryPassHandler = async (req, res) => {
  try {
    const { booking_ref } = req.params;
    const userId = req.user?.id;
    const result = await getReservationEntryPass(prisma, { bookingRef: booking_ref, userId });
    return res.json(result);
  } catch (err) {
    if (err.statusCode) {
      return res.status(err.statusCode).json({ error: err.message });
    }
    console.error('getReservationEntryPassHandler error:', err);
    return res.status(500).json({ error: '無法取得進場資訊' });
  }
};
