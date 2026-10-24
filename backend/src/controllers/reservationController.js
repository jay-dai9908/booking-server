import prisma from '../prismaClient.js';
import { Prisma } from '@prisma/client';
import crypto from 'crypto';
import { allocateSeats } from '../utils/SeatAllocator.js';
import { calculateEquipmentChargeableHours } from '../utils/equipmentPricing.js';
import { evaluatePromoCode } from './checkoutController.js';
import {
  sendBookingConfirmationNotification,
  sendBookingCancellationNotification
} from '../utils/lineMessaging.js';

// Helper function to group reservations by booking_ref
const groupReservations = (reservations, equipmentsMap = {}) => {
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
        cancelled_at: r.cancelled_at || null,
        cancelled_by: r.cancelled_by || null
      };
    } else {
      // Synchronize attendance and check-in timestamp across all segments
      if (r.attendance === 'checked_in') {
        groups[ref].attendance = 'checked_in';
      } else if (!groups[ref].attendance && r.attendance) {
        groups[ref].attendance = r.attendance;
      }

      if (r.checked_in_at) {
        if (!groups[ref].checked_in_at || new Date(r.checked_in_at) < new Date(groups[ref].checked_in_at)) {
          groups[ref].checked_in_at = r.checked_in_at;
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
          // contiguous
          current_block.end_time = session.end_time;
        } else {
          // gap
          time_blocks.push(current_block);
          current_block = { start_time: session.start_time, end_time: session.end_time };
        }
      }
    }
    if (current_block) time_blocks.push(current_block);
    
    return {
      booking_ref: group.booking_ref,
      user_id: group.user_id,
      user: group.user,
      pax: group.pax,
      status: group.status,
      attendance: group.attendance,
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
      cancelled_at: group.cancelled_at,
      cancelled_by: group.cancelled_by,
      checked_in_at: group.checked_in_at || null,
      equipments: equipmentsMap[group.booking_ref] || []
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
  const dailySetting = await tx.dailySetting.findUnique({
    where: { date: sessionDate }
  });

  let hourly_price = dailySetting?.hourly_price;
  let unlimited_price = dailySetting?.unlimited_price;
  const allow_unlimited = dailySetting?.allow_unlimited ?? true;

  const dateObj = new Date(sessionDate);
  const dayOfWeek = isNaN(dateObj.getTime()) ? 0 : dateObj.getUTCDay();
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

// Helper function to calculate total amount based on pricing rules
export const calculateTotalAmount = async (tx, sessionDate, pax, sessionCount, is_unlimited) => {
  const { hourly_price, unlimited_price, allow_unlimited } = await getEffectiveDailyRates(tx, sessionDate);

  const calculatedHourlyTotal = pax * hourly_price * sessionCount;
  const calculatedUnlimitedTotal = pax * unlimited_price;

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

export const createReservation = async (req, res) => {
  const { session_ids, pax, forceSplit } = req.body;
  const userId = req.user.id;

  if (!Array.isArray(session_ids) || session_ids.length === 0 || !pax || pax <= 0) {
    return res.status(400).json({ error: 'Valid session_ids array and pax are required.' });
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

      const sessionDate = requestedSessions[0].session_date;

      // Lock ALL sessions for the same date to prevent race conditions across the day
      const allSessionsOfDay = await tx.$queryRaw`
        SELECT id
        FROM "Session"
        WHERE session_date = ${sessionDate}
        FOR UPDATE
      `;
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
      const allocResult = allocateSeats(currentReservations, newReservationBlock, forceSplit === true);

      if (!allocResult.success) {
        if (allocResult.error === 'INSUFFICIENT_SEATS') throw new Error('INSUFFICIENT_CAPACITY');
        if (allocResult.error === 'SPLIT_REQUIRED') throw new Error('SPLIT_REQUIRED');
        throw new Error('ALLOCATION_FAILED');
      }

      // Apply Reshuffle Updates to existing reservations
      const sessionUpdates = []; 
      const newReservationsData = [];
      const mySeats = allocResult.updates.find(u => u.booking_ref === 'NEW_RES')?.assigned_seats || [];
      
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

        // Verify total requested boards against pax quota
        let totalNonOwnBoards = 0;
        for (const eq of equipments) {
          const qty = parseInt(eq.quantity, 10) || 0;
          if (qty > 0 && eq.equipment_id !== 'bring_own') {
            totalNonOwnBoards += qty;
          }
        }
        if (!allowExceedPax && totalNonOwnBoards > parseInt(pax, 10)) {
          throw new Error('EQUIPMENT_EXCEED_PAX');
        }

        const discountConfig = {
          enabled: globalSetting ? globalSetting.equipment_discount_enabled !== false : true,
          buy_hours: globalSetting?.equipment_discount_buy_hours ?? 3,
          free_hours: globalSetting?.equipment_discount_free_hours ?? 1,
          tier2_enabled: !!globalSetting?.equipment_discount2_enabled,
          tier2_buy_hours: globalSetting?.equipment_discount2_buy_hours ?? 8,
          tier2_free_hours: globalSetting?.equipment_discount2_free_hours ?? 4
        };

        const totalHours = session_ids.length;
        const sortedReqSessions = [...requestedSessions].sort((a, b) => a.start_time.localeCompare(b.start_time));

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

        for (const eq of equipments) {
          const qty = parseInt(eq.quantity, 10) || 0;
          if (qty <= 0) continue;

          const config = configMap[eq.equipment_id];
          if (!config) continue;

          if (eq.equipment_id !== 'bring_own' && config.visibility_status !== 'ACTIVE') {
            throw new Error(`EQUIPMENT_UNAVAILABLE:智能拼豆板「${config.name}」目前維護中，暫停借用。`);
          }

          const minHours = config.min_contiguous_hours || 2;
          const rentalHours = totalHours < minHours 
            ? totalHours 
            : Math.max(minHours, Math.min(totalHours, parseInt(eq.rental_hours, 10) || totalHours));

          // Accurately cover ONLY the first rentalHours sessions
          const eqCoveredSessions = sortedReqSessions.slice(0, rentalHours).map(s => `${s.start_time}-${s.end_time}`);

          // Real-time stock verification across each covered session
          if (eq.equipment_id !== 'bring_own') {
            const totalStock = config.total_stock || 0;
            for (const sess of sortedReqSessions.slice(0, rentalHours)) {
              const sessTimeStr = `${sess.start_time}-${sess.end_time}`;
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

              if (bookedInThisSession + qty > totalStock) {
                throw new Error(`EQUIPMENT_OUT_OF_STOCK:智能拼豆板「${config.name}」在 ${sess.start_time} 時段庫存不足（僅剩 ${Math.max(0, totalStock - bookedInThisSession)} 台）`);
              }
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
            subtotal_price: subtotal,
            covered_sessions: eqCoveredSessions
          });
        }
      }

      const is_unlimited = req.body.isUnlimited === true;
      const { hourly_price } = await getEffectiveDailyRates(tx, sessionDate);
      const baseSeatingPrice = await calculateTotalAmount(tx, sessionDate, parseInt(pax, 10), session_ids.length, is_unlimited);
      let subtotalAmount = baseSeatingPrice + totalEquipmentFee;

      // Promo code evaluation if provided by customer
      let appliedPromoCode = null;
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
        appliedDiscountAmount = promoEval.discount_amount;
        await tx.promoCode.update({
          where: { id: promoEval.promo.id },
          data: { used_count: { increment: 1 } }
        });
      }

      const totalAmount = Math.max(0, subtotalAmount - appliedDiscountAmount);

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
          discount_amount: appliedDiscountAmount
        });
      }

      for (const update of allocResult.updates) {
        if (update.booking_ref !== 'NEW_RES') {
          // Update all session records for this reshuffled booking_ref
          sessionUpdates.push(
            tx.reservation.updateMany({
              where: { booking_ref: update.booking_ref },
              data: { assigned_seats: update.assigned_seats }
            })
          );
        }
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

      const sortedRequestedSessions = [...requestedSessions].sort((a, b) => a.start_time.localeCompare(b.start_time));

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

    res.status(201).json({ message: 'Reservation successful', reservation: result });

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

            const equipments = req.body.equipments;
            let equipmentSummary = '';
            if (Array.isArray(equipments) && equipments.length > 0) {
              const eqConfigs = await prisma.equipmentConfig.findMany({
                where: { id: { in: equipments.map(e => e.equipment_id) } },
                select: { id: true, name: true }
              });
              const eqMap = Object.fromEntries(eqConfigs.map(c => [c.id, c.name]));
              equipmentSummary = equipments
                .map(e => `${eqMap[e.equipment_id] || e.name || e.equipment_id}×${e.quantity}`)
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
      return res.status(400).json({ error: 'Not enough capacity remaining for one or more selected sessions.' });
    }
    if (error.message === 'SPLIT_REQUIRED') {
      return res.status(409).json({ error: '連續座位不足，同行者將被拆散。是否確認預約？' });
    }
    res.status(500).json({ error: 'Failed to create reservation.' });
  }
};

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
      // If we already have a whereClause.session, we need to combine them with AND
      // The easiest way is to just assign the OR array directly to whereClause.OR
      whereClause.OR = [
        { booking_ref: { contains: search } },
        { user: { name: { contains: search } } },
        { user: { phone: { contains: search } } }
      ];
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

    let pricingInfo = null;
    await prisma.$transaction(async (tx) => {
      const sessionDate = firstRes.session.session_date;
      pricingInfo = await getEffectiveDailyRates(tx, sessionDate);

      // Auto-recalculate if unpaid and not manually overridden
      if (!firstRes.is_paid && !firstRes.is_amount_manual) {
        const pax = firstRes.pax;
        const is_unlimited = firstRes.is_unlimited;
        const baseAmount = await calculateTotalAmount(tx, sessionDate, pax, reservations.length, is_unlimited);
        const discountAmt = firstRes.discount_amount || 0;
        const addonsAmt = firstRes.addons_amount || 0;
        const totalAmount = Math.max(0, baseAmount + eqTotal + addonsAmt - discountAmt);
        
        if (totalAmount !== firstRes.total_amount) {
          await tx.reservation.updateMany({
            where: { booking_ref },
            data: { total_amount: totalAmount }
          });
          reservations.forEach(r => r.total_amount = totalAmount);
        }
      }
    });

    const equipmentsMap = { [booking_ref]: eqRecords };
    const grouped = groupReservations(reservations, equipmentsMap);
    const result = {
      ...grouped[0],
      pricing_info: pricingInfo
    };

    // If attendance was desynced across session segments in database, auto-heal them
    if (result && result.attendance) {
      const needsSync = reservations.some(r => r.attendance !== result.attendance || (result.checked_in_at && !r.checked_in_at));
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
        user: true
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

    const grouped = groupReservations(reservations, equipmentsMap);
    res.json(grouped);
  } catch (error) {
    console.error('Error fetching my reservations:', error);
    res.status(500).json({ error: 'Failed to fetch your reservations' });
  }
};

export const cancelReservation = async (req, res) => {
  // We use :id parameter, but it actually receives booking_ref now.
  const { id: booking_ref } = req.params;
  const userId = req.user.id;
  const isAdmin = req.user.role === 'admin';

  try {
    // Find all reservations with this booking_ref
    const reservations = await prisma.reservation.findMany({
      where: { booking_ref }
    });

    if (reservations.length === 0) {
      return res.status(404).json({ error: 'Reservation not found' });
    }

    // Check ownership (only need to check first one since they share booking_ref)
    if (!isAdmin && reservations[0].user_id !== userId) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    if (reservations[0].status === 'cancelled') {
      return res.status(400).json({ error: 'Reservation is already cancelled' });
    }

    // Cancel all related rows
    const updated = await prisma.reservation.updateMany({
      where: { booking_ref },
      data: { 
        status: 'cancelled',
        cancelled_at: new Date(),
        cancelled_by: isAdmin ? 'admin' : 'customer'
      }
    });

    // Return promo code usage quota if order used promo codes
    if (reservations[0].promo_code) {
      const promoCodes = reservations[0].promo_code.split(',').map(c => c.trim().toUpperCase()).filter(Boolean);
      for (const code of promoCodes) {
        await prisma.promoCode.updateMany({
          where: { code, used_count: { gt: 0 } },
          data: { used_count: { decrement: 1 } }
        });
      }
    }

    res.json({ message: 'Reservation cancelled successfully', count: updated.count });

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
};

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

export const handleCollisionsAndReshuffle = async (sessionIds, updatedBookingRefs) => {
  // Find all confirmed reservations in the affected sessions
  const currentReservations = await prisma.reservation.findMany({
    where: { session_id: { in: sessionIds }, status: 'confirmed' }
  });

  // Collect newly assigned seats for the updated refs
  const updatedSeatsMap = new Map();
  for (const r of currentReservations) {
    if (updatedBookingRefs.includes(r.booking_ref)) {
      if (!updatedSeatsMap.has(r.session_id)) updatedSeatsMap.set(r.session_id, new Set());
      r.assigned_seats?.forEach(s => updatedSeatsMap.get(r.session_id).add(s));
    }
  }

  // Find colliding reservations
  const collidingRefs = new Set();
  for (const r of currentReservations) {
    if (updatedBookingRefs.includes(r.booking_ref)) continue;
    
    const updatedSeatsForSession = updatedSeatsMap.get(r.session_id);
    if (updatedSeatsForSession && r.assigned_seats) {
      if (r.assigned_seats.some(seat => updatedSeatsForSession.has(seat))) {
        collidingRefs.add(r.booking_ref);
      }
    }
  }

  let displacedCount = collidingRefs.size;

  if (displacedCount > 0) {
    let allDayReservations = currentReservations;
    const sampleSession = await prisma.session.findFirst({
      where: { id: { in: sessionIds } },
      select: { session_date: true }
    });

    if (sampleSession) {
      const allSessionsOfDay = await prisma.session.findMany({
        where: { session_date: sampleSession.session_date },
        select: { id: true }
      });
      const allSessionIdsOfDay = allSessionsOfDay.map(s => s.id);
      allDayReservations = await prisma.reservation.findMany({
        where: { session_id: { in: allSessionIdsOfDay }, status: 'confirmed' }
      });
    }

    // Unpin colliding reservations in memory across allDayReservations
    for (const r of allDayReservations) {
      if (collidingRefs.has(r.booking_ref)) {
        r.is_seat_locked = false;
        r.assigned_seats = []; // Strip to force reshuffle
      }
    }

    // Run allocation algorithm (pure reshuffle)
    const allocResult = allocateSeats(allDayReservations, null, false);

    if (allocResult.updates && allocResult.updates.length > 0) {
      const sessionUpdates = [];
      for (const update of allocResult.updates) {
        sessionUpdates.push(
          prisma.reservation.updateMany({
            where: { booking_ref: update.booking_ref },
            data: { assigned_seats: update.assigned_seats }
          })
        );
      }
      if (sessionUpdates.length > 0) {
        await prisma.$transaction(sessionUpdates);
      }
    } else {
      // Very edge case: completely full, couldn't reshuffle. Put them in wait area
      const sessionUpdates = [];
      
      let maxWait = 0;
      for (const res of allDayReservations) {
        if (res.assigned_seats) {
          for (const seat of res.assigned_seats) {
            if (seat.startsWith('WAIT-')) {
              const num = parseInt(seat.replace('WAIT-', ''), 10);
              if (!isNaN(num) && num > maxWait) maxWait = num;
            }
          }
        }
      }
      let waitCounter = maxWait + 1;
      for (const ref of collidingRefs) {
        const r = allDayReservations.find(res => res.booking_ref === ref);
        const waitSeats = [];
        const paxCount = r ? r.pax : 1;
        for (let i = 0; i < paxCount; i++) {
          waitSeats.push(`WAIT-${waitCounter++}`);
        }
        sessionUpdates.push(
          prisma.reservation.updateMany({
            where: { booking_ref: ref },
            data: { assigned_seats: waitSeats }
          })
        );
      }
      await prisma.$transaction(sessionUpdates);
    }
  }

  return displacedCount;
};

export const moveSeat = async (req, res) => {
  const { id, assigned_seats } = req.body;

  if (!id || !assigned_seats || !Array.isArray(assigned_seats)) {
    return res.status(400).json({ error: 'Valid reservation id and assigned_seats array are required.' });
  }

  try {
    const targetRes = await prisma.reservation.findUnique({ where: { id: parseInt(id, 10) } });
    if (!targetRes) {
      return res.status(404).json({ error: 'Reservation not found' });
    }

    const group = await prisma.reservation.findMany({ 
      where: { booking_ref: targetRes.booking_ref }
    });
    const sessionIds = group.map(r => r.session_id);

    // Force update the target reservation
    await prisma.reservation.updateMany({
      where: { booking_ref: targetRes.booking_ref },
      data: {
        assigned_seats,
        is_seat_locked: true
      }
    });

    const displacedCount = await handleCollisionsAndReshuffle(sessionIds, [targetRes.booking_ref]);

    const singleUpdated = await prisma.reservation.findUnique({ where: { id: parseInt(id, 10) } });

    res.json({ 
      message: 'Seat moved successfully', 
      reservation: singleUpdated,
      displacedCount
    });
  } catch (error) {
    console.error('Error moving seat:', error);
    res.status(500).json({ error: 'Failed to move seat' });
  }
};

export const swapSeats = async (req, res) => {
  const { source_booking_ref, source_assigned_seats, target_booking_ref, target_assigned_seats } = req.body;

  if (!source_booking_ref || !target_booking_ref || !Array.isArray(source_assigned_seats) || !Array.isArray(target_assigned_seats)) {
    return res.status(400).json({ error: 'Invalid parameters for swapping seats' });
  }

  try {
    const sourceGroup = await prisma.reservation.findMany({ where: { booking_ref: source_booking_ref } });
    const targetGroup = await prisma.reservation.findMany({ where: { booking_ref: target_booking_ref } });
    
    const sessionIdsSet = new Set([...sourceGroup.map(r => r.session_id), ...targetGroup.map(r => r.session_id)]);
    const sessionIds = Array.from(sessionIdsSet);

    await prisma.$transaction([
      prisma.reservation.updateMany({
        where: { booking_ref: source_booking_ref },
        data: { assigned_seats: source_assigned_seats, is_seat_locked: true }
      }),
      prisma.reservation.updateMany({
        where: { booking_ref: target_booking_ref },
        data: { assigned_seats: target_assigned_seats, is_seat_locked: true }
      })
    ]);

    const displacedCount = await handleCollisionsAndReshuffle(sessionIds, [source_booking_ref, target_booking_ref]);

    res.json({ message: 'Seats swapped successfully', displacedCount });
  } catch (error) {
    console.error('Error swapping seats:', error);
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
  const { session_ids, pax, name, phone, forceSplit, isForceWait, isWalkIn, attendance, autoCheckIn } = req.body;
  
  if (!Array.isArray(session_ids) || session_ids.length === 0 || !pax || pax <= 0) {
    return res.status(400).json({ error: 'Valid session_ids array and pax are required.' });
  }

  if (!name) {
    return res.status(400).json({ error: 'Name is required for manual booking.' });
  }

  try {
    const booking_ref = crypto.randomUUID();

    const result = await prisma.$transaction(async (tx) => {
      // 0. Handle user finding / creation
      let targetUser = null;
      if (phone) {
        targetUser = await tx.user.findFirst({
          where: { phone }
        });
      }

      if (!targetUser) {
        // Create manual user
        targetUser = await tx.user.create({
          data: {
            line_user_id: `manual_${crypto.randomUUID()}`,
            name,
            phone: phone || null
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

      const sessionDate = requestedSessions[0].session_date;

      // Lock ALL sessions for the same date to prevent race conditions across the day
      const allSessionsOfDay = await tx.$queryRaw`
        SELECT id
        FROM "Session"
        WHERE session_date = ${sessionDate}
        FOR UPDATE
      `;
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
        const allocResult = allocateSeats(currentReservations, newReservationBlock, forceSplit === true || forceSplit === 'true');

        if (!allocResult.success) {
          if (allocResult.error === 'INSUFFICIENT_SEATS') throw new Error('INSUFFICIENT_CAPACITY');
          if (allocResult.error === 'SPLIT_REQUIRED') throw new Error('SPLIT_REQUIRED');
          throw new Error('ALLOCATION_FAILED');
        }

        mySeats = allocResult.updates.find(u => u.booking_ref === 'NEW_RES').assigned_seats;

        for (const update of allocResult.updates) {
          if (update.booking_ref !== 'NEW_RES') {
            sessionUpdates.push(
              tx.reservation.updateMany({
                where: { booking_ref: update.booking_ref },
                data: { assigned_seats: update.assigned_seats }
              })
            );
          }
        }
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
        const discountConfig = {
          enabled: globalSetting ? globalSetting.equipment_discount_enabled !== false : true,
          buy_hours: globalSetting?.equipment_discount_buy_hours ?? 3,
          free_hours: globalSetting?.equipment_discount_free_hours ?? 1,
          tier2_enabled: !!globalSetting?.equipment_discount2_enabled,
          tier2_buy_hours: globalSetting?.equipment_discount2_buy_hours ?? 8,
          tier2_free_hours: globalSetting?.equipment_discount2_free_hours ?? 4
        };

        const totalHours = session_ids.length;
        const coveredSessionsStrings = requestedSessions.map(s => `${s.start_time}-${s.end_time}`);

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

          newEquipmentRecords.push({
            booking_ref,
            equipment_id: eq.equipment_id,
            equipment_name_snapshot: config.name,
            quantity: qty,
            rental_hours: rentalHours,
            subtotal_price: subtotal,
            covered_sessions: coveredSessionsStrings
          });
        }
      }

      const newReservationsData = [];
      const is_unlimited = req.body.isUnlimited === true || req.body.isUnlimited === 'true';
      const baseSeatingPrice = await calculateTotalAmount(tx, sessionDate, parseInt(pax, 10), session_ids.length, is_unlimited);
      const totalAmount = baseSeatingPrice + totalEquipmentFee;

      const shouldAutoCheckIn = attendance === 'checked_in' || autoCheckIn === true || autoCheckIn === 'true' || isWalkIn === true || isWalkIn === 'true' || isForceWait === true || isForceWait === 'true';
      const checkInStatus = shouldAutoCheckIn ? 'checked_in' : (attendance || null);
      const checkInTime = shouldAutoCheckIn ? new Date() : null;

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
          is_walk_in: isWalkIn === true || isWalkIn === 'true',
          is_unlimited: is_unlimited,
          total_amount: totalAmount
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

      return { booking_ref, count: newReservations.count };
    });

    res.status(201).json({ message: 'Manual reservation successful', reservation: result });

  } catch (error) {
    console.error('Manual Reservation error:', error);
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

export const extendReservation = async (req, res) => {
  const { booking_ref } = req.params;
  const { session_ids, extendMode, forceSplit } = req.body;
  
  if (!Array.isArray(session_ids) || session_ids.length === 0) {
    return res.status(400).json({ error: 'Valid session_ids array is required.' });
  }

  try {
    const result = await prisma.$transaction(async (tx) => {
      // Find the existing reservation details
      const existingReservations = await tx.reservation.findMany({
        where: { booking_ref, status: 'confirmed' },
        orderBy: { session_id: 'desc' }
      });

      if (existingReservations.length === 0) {
        throw new Error('RESERVATION_NOT_FOUND');
      }

      const baseReservation = existingReservations[0];
      const { user_id, pax, assigned_seats, is_walk_in } = baseReservation;

      // Inherit attendance, checked_in_at, and payment details
      const checkedInRes = existingReservations.find(r => r.attendance === 'checked_in') || existingReservations.find(r => r.attendance != null);
      const inheritedAttendance = checkedInRes ? checkedInRes.attendance : (baseReservation.attendance || null);
      const inheritedCheckedInAt = checkedInRes ? checkedInRes.checked_in_at : (baseReservation.checked_in_at || null);

      const paidRes = existingReservations.find(r => r.is_paid) || baseReservation;
      const inheritedIsPaid = paidRes.is_paid || false;
      const inheritedPaidAt = paidRes.paid_at || null;
      const inheritedIsAmountManual = baseReservation.is_amount_manual || false;

      // Ensure all existing segments have consistent attendance & checked_in_at
      if (inheritedAttendance) {
        await tx.reservation.updateMany({
          where: { booking_ref },
          data: {
            attendance: inheritedAttendance,
            checked_in_at: inheritedCheckedInAt
          }
        });
      }

      // Ensure sessions exist
      const sessions = await tx.session.findMany({
        where: { id: { in: session_ids } },
        include: { reservations: { where: { status: 'confirmed' }, select: { pax: true, assigned_seats: true } } }
      });

      if (sessions.length !== session_ids.length) {
        throw new Error('SOME_SESSIONS_NOT_FOUND');
      }

      let mySeats = [];
      const sessionUpdates = [];

      // Fetch current reservations for all affected sessions for allocator
      const allCurrentReservations = await tx.reservation.findMany({
        where: { session_id: { in: session_ids }, status: 'confirmed' }
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
        // Capacity check for non-wait modes
        for (const session of sessions) {
          const bookedPax = session.reservations.reduce((sum, res) => {
            return sum + res.pax;
          }, 0);
          if (session.max_capacity - bookedPax < pax) {
            throw new Error('INSUFFICIENT_CAPACITY');
          }
        }

        if (extendMode === 'keep_seat') {
          mySeats = assigned_seats || [];
        } else if (extendMode === 'system_allocate') {
          const newBlock = { booking_ref: 'NEW_RES', pax, session_ids };
          const allocResult = allocateSeats(allCurrentReservations, newBlock, forceSplit === true || forceSplit === 'true');
          
          if (!allocResult.success) {
            if (allocResult.error === 'INSUFFICIENT_SEATS') throw new Error('INSUFFICIENT_CAPACITY');
            if (allocResult.error === 'SPLIT_REQUIRED') throw new Error('SPLIT_REQUIRED');
            throw new Error('ALLOCATION_FAILED');
          }

          mySeats = allocResult.updates.find(u => u.booking_ref === 'NEW_RES').assigned_seats;

          for (const update of allocResult.updates) {
            if (update.booking_ref !== 'NEW_RES') {
              sessionUpdates.push(
                tx.reservation.updateMany({
                  where: { booking_ref: update.booking_ref },
                  data: { assigned_seats: update.assigned_seats }
                })
              );
            }
          }
        }
      }

      const newReservationsData = [];
      for (const sessionId of session_ids) {
        newReservationsData.push({
          booking_ref,
          session_id: sessionId,
          user_id,
          pax,
          status: 'confirmed',
          assigned_seats: mySeats,
          is_force_split: forceSplit === true || forceSplit === 'true',
          is_walk_in,
          is_unlimited: baseReservation.is_unlimited,
          total_amount: baseReservation.total_amount,
          attendance: inheritedAttendance,
          checked_in_at: inheritedCheckedInAt,
          is_paid: inheritedIsPaid,
          paid_at: inheritedPaidAt,
          is_amount_manual: inheritedIsAmountManual,
          payment_method: baseReservation.payment_method,
          checkout_unlimited_pax: baseReservation.checkout_unlimited_pax,
          checkout_regular_hours: baseReservation.checkout_regular_hours,
          checkout_details: baseReservation.checkout_details,
          promo_code: baseReservation.promo_code,
          discount_amount: baseReservation.discount_amount,
          addons_amount: baseReservation.addons_amount
        });
      }

      if (sessionUpdates.length > 0) {
        await Promise.all(sessionUpdates);
      }

      // Create the new extended reservations
      const newReservations = await tx.reservation.createMany({
        data: newReservationsData
      });

      // Recalculate unified total without wiping equipment or discounts
      const finalTotal = await recalculateReservationTotal(tx, booking_ref);

      // If keep_seat, we must trigger reshuffle NOW to push colliding reservations
      if (extendMode === 'keep_seat') {
        // We do this outside the createMany but inside the tx, but handleCollisionsAndReshuffle uses its own queries/txs.
        // Wait, handleCollisionsAndReshuffle uses `prisma` directly! We cannot run it inside `tx` if it uses `prisma`.
        // So we just return success, and we'll run reshuffle AFTER the tx commits!
      }

      return { count: newReservations.count };
    });

    if (extendMode === 'keep_seat') {
      await handleCollisionsAndReshuffle(session_ids, [booking_ref]);
    }

    res.status(201).json({ message: 'Reservation extended successfully', result });

  } catch (error) {
    console.error('Extend Reservation error:', error);
    if (error.message === 'RESERVATION_NOT_FOUND') {
      return res.status(404).json({ error: 'Original reservation not found.' });
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
    res.status(500).json({ error: 'Failed to extend reservation.' });
  }
};

export const updateAttendance = async (req, res) => {
  const { id: booking_ref } = req.params;
  const { attendance } = req.body; // 'checked_in', 'no_show', or null

  try {
    const dataToUpdate = { attendance };
    if (attendance === 'checked_in') {
      dataToUpdate.checked_in_at = new Date();
    } else {
      dataToUpdate.checked_in_at = null;
    }

    const updated = await prisma.reservation.updateMany({
      where: { booking_ref },
      data: dataToUpdate
    });

    if (updated.count === 0) {
      return res.status(404).json({ error: 'Reservation not found' });
    }

    res.json({ 
      message: 'Attendance updated successfully', 
      count: updated.count,
      attendance,
      checked_in_at: dataToUpdate.checked_in_at
    });
  } catch (error) {
    console.error('Error updating attendance:', error);
    res.status(500).json({ error: 'Failed to update attendance' });
  }
};

export const updatePaymentStatus = async (req, res) => {
  const { booking_ref } = req.params;
  const { is_paid } = req.body;

  if (typeof is_paid !== 'boolean') {
    return res.status(400).json({ error: 'Invalid payment status' });
  }

  try {
    let totalAmount = undefined;

    if (is_paid) {
      // Recalculate amount using unified engine
      await prisma.$transaction(async (tx) => {
        totalAmount = await recalculateReservationTotal(tx, booking_ref);

        const updated = await tx.reservation.updateMany({
          where: { booking_ref },
          data: { 
            is_paid, 
            paid_at: new Date()
          }
        });

        if (updated.count === 0) {
          throw new Error('NOT_FOUND');
        }
      });
      res.json({ message: 'Payment status updated successfully', total_amount: totalAmount });
    } else {
      await prisma.$transaction(async (tx) => {
        const updated = await tx.reservation.updateMany({
          where: { booking_ref },
          data: { 
            is_paid: false,
            paid_at: null,
            payment_method: null,
            is_amount_manual: false
          }
        });
        
        if (updated.count === 0) {
          throw new Error('NOT_FOUND');
        }

        totalAmount = await recalculateReservationTotal(tx, booking_ref);
      });
      
      res.json({ message: 'Payment status updated successfully', is_paid: false, total_amount: totalAmount });
    }
  } catch (error) {
    console.error('Error updating payment status:', error);
    if (error.message === 'NOT_FOUND') {
      return res.status(404).json({ error: 'Reservation not found' });
    }
    res.status(500).json({ error: 'Failed to update payment status' });
  }
};

export const updateAmount = async (req, res) => {
  const { booking_ref } = req.params;
  const { total_amount } = req.body;

  if (total_amount === undefined || isNaN(parseInt(total_amount))) {
    return res.status(400).json({ error: 'Valid total_amount is required' });
  }

  try {
    const updated = await prisma.reservation.updateMany({
      where: { booking_ref },
      data: { 
        total_amount: parseInt(total_amount),
        is_amount_manual: true
      }
    });

    if (updated.count === 0) {
      return res.status(404).json({ error: 'Reservation not found' });
    }

    res.json({ message: 'Amount updated successfully', total_amount: parseInt(total_amount) });
  } catch (error) {
    console.error('Error updating amount:', error);
    res.status(500).json({ error: 'Failed to update amount' });
  }
};
