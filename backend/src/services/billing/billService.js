import crypto from 'crypto';
import prisma from '../../prismaClient.js';
import { computeBill, billingStatus, calculatePersonRefundInfo } from '../../../../shared/billing.js';
import { computePassTenderValue, resolvePassCheckoutEffect } from '../../../../shared/passValue.js';
import { toTaipeiDateString, blocksBy1030, dateOnly } from '../../../../shared/time.js';
import { getEffectiveDailyRates } from '../../controllers/reservationController.js';
import { evaluatePromoCode } from '../../controllers/checkoutController.js';
import { redeemPromo, releasePromo } from '../promo/redemption.js';
import { log as auditLog } from '../audit/auditService.js';
import { deductPass, restorePass, validatePassUsage } from './passTender.js';
import { getShiftLock, canVoidPayment } from './shiftLock.js';
import { buildBillInput } from './billInput.js';
import { queuePrintJob } from '../print/printService.js';

export function buildInitialDraft({
  pax = 1,
  isUnlimited = false,
  promoRule = null,
  promoPersonNos = null,
  updatedBy = '系統',
  splitMode = 'proportional'
} = {}) {
  const count = Math.max(1, parseInt(pax, 10) || 1);
  const personMode = isUnlimited ? 'unlimited' : 'hourly';
  const persons = Array.from({ length: count }, (_, i) => ({
    person_no: i + 1,
    mode: personMode
  }));

  const order_promos = promoRule
    ? [
        {
          ...promoRule,
          ...(Array.isArray(promoPersonNos) ? { person_nos: promoPersonNos } : {})
        }
      ]
    : [];

  return {
    version: 2,
    persons,
    order_addons: [],
    order_promos,
    manual_discount: null,
    total_override: null,
    pending_supplements: [],
    note: '',
    rev: 1,
    updated_at: new Date().toISOString(),
    updated_by: updatedBy,
    split_mode: splitMode
  };
}

export async function getNextDailySeq(tx, key, date = new Date()) {
  const client = tx || prisma;
  const d = dateOnly(date);
  const counter = await client.dailyCounter.upsert({
    where: {
      date_key: {
        date: d,
        key
      }
    },
    update: {
      value: { increment: 1 }
    },
    create: {
      date: d,
      key,
      value: 1
    }
  });
  return counter.value;
}

export function resolveBillingDate(payload) {
  if (process.env.NODE_ENV === 'test') {
    return payload?.now || payload?.payment_date || null;
  }
  return null;
}

/**
 * Generate unique serial number with Taipei date prefix:
 * - payment: R-YYMMDD-XXXX (e.g. R-261110-0001)
 * - job:     P-YYMMDD-XXXX (e.g. P-261110-0001)
 * Scoped by Taipei date aligning with getNextDailySeq.
 */
export async function nextSerialNo(tx, type = 'payment', customDate = null) {
  const rawDate = customDate ? (customDate instanceof Date ? customDate : new Date(customDate)) : new Date();
  const dateObj = isNaN(rawDate.getTime()) ? new Date() : rawDate;
  const dateStr = toTaipeiDateString(dateObj);
  const normalizedType = String(type || 'payment').toLowerCase();
  const seq = await getNextDailySeq(tx, normalizedType, dateObj);
  const [y, m, d] = dateStr.split('-');
  const yymmdd = `${y.slice(-2)}${m}${d}`;
  const prefix = normalizedType === 'job' || normalizedType === 'print' ? 'P' : 'R';
  return `${prefix}-${yymmdd}-${String(seq).padStart(4, '0')}`;
}

export function currentRevOf(checkout_details) {
  if (!checkout_details || typeof checkout_details !== 'object') return 0;
  if (checkout_details.version !== 2) return 0;
  if (typeof checkout_details.rev !== 'number') return 0;
  return checkout_details.rev;
}

/**
 * Get the full bill and related entities for a booking
 */
export async function getBookingBill(booking_ref, tx = prisma, now = new Date()) {
  const reservations = await tx.reservation.findMany({
    where: { booking_ref, status: { not: 'cancelled' } },
    include: { user: true, session: true },
    orderBy: { session: { start_time: 'asc' } }
  });

  if (!reservations.length) {
    throw { status: 404, message: '找不到此筆預約' };
  }

  const firstRes = reservations[0];
  const lastRes = reservations[reservations.length - 1];
  const user = firstRes.user || {};
  const sessionDate = firstRes.session.session_date;
  const dStr = typeof sessionDate === 'string' ? sessionDate.slice(0, 10) : sessionDate.toISOString().slice(0, 10);

  // Pricing
  const globalSetting = await tx.globalSetting.findFirst() || {};
  let effectiveRates = null;
  if (firstRes.is_self_service) {
    const prepaySnapRow = await tx.bookingPrepay.findUnique({
      where: { booking_ref },
      select: { pricing_snapshot: true }
    });
    const snap = prepaySnapRow?.pricing_snapshot;
    if (snap && typeof snap === 'object' && snap.hourly !== undefined && snap.unlimited !== undefined) {
      effectiveRates = {
        hourly_price: Number(snap.hourly),
        unlimited_price: Number(snap.unlimited),
        allow_unlimited: Boolean(snap.allow_unlimited),
        is_weekend: Boolean(snap.is_weekend)
      };
    }
  }
  if (!effectiveRates) {
    effectiveRates = await getEffectiveDailyRates(tx, sessionDate);
  }
  const { hourly_price, unlimited_price, allow_unlimited, is_weekend } = effectiveRates;

  const pricing = {
    hourly: hourly_price,
    unlimited: unlimited_price,
    allow_unlimited: allow_unlimited,
    day_type: is_weekend ? 'weekend' : 'weekday',
    billing_grace_minutes: globalSetting.billing_grace_minutes ?? 10,
    billing_block_minutes: globalSetting.billing_block_minutes ?? 30,
    early_leave_mode: globalSetting.early_leave_mode || 'booked',
    default_split_mode: globalSetting.default_split_mode || 'proportional'
  };

  // Draft from checkout_details
  const rawDraft = firstRes.checkout_details;
  let draft = {
    version: 2,
    persons: [],
    order_addons: [],
    order_promos: [],
    manual_discount: null,
    total_override: null,
    pending_supplements: [],
    note: '',
    updated_at: new Date().toISOString(),
    updated_by: firstRes.checked_in_by || '系統',
    rev: currentRevOf(rawDraft)
  };

  if (rawDraft && typeof rawDraft === 'object' && rawDraft.version === 2) {
    draft = { ...rawDraft, rev: currentRevOf(rawDraft) };
  }

  // Persons
  const persons = await tx.bookingPerson.findMany({
    where: { booking_ref },
    include: { pauses: true },
    orderBy: { person_no: 'asc' }
  });

  // Equipments / Boards
  const bookingEquipments = await tx.bookingEquipment.findMany({
    where: { booking_ref },
    include: { equipment: true },
    orderBy: [{ unit_group: 'asc' }, { segment_no: 'asc' }]
  });

  const unitGroups = [...new Set(bookingEquipments.map(be => be.unit_group).filter(Boolean))];
  const boardPauses = unitGroups.length ? await tx.boardPause.findMany({
    where: { unit_group: { in: unitGroups } },
    orderBy: { started_at: 'asc' }
  }) : [];

  // Payments
  const payments = await tx.payment.findMany({
    where: { booking_ref },
    orderBy: { created_at: 'asc' }
  });

  const billInput = buildBillInput({
    bookingRef: booking_ref,
    reservations,
    bookingPersons: persons,
    bookingEquipments,
    boardPauses,
    payments,
    globalSetting,
    pricing: {
      hourly_price,
      unlimited_price,
      allow_unlimited,
      is_weekend
    },
    now,
    draft
  });

  const bill = computeBill(billInput);

  const hasRefund = Boolean(firstRes.has_refund) || payments.some(p => p.status === 'valid' && p.kind === 'refund');

  const status = billingStatus({
    persons: billInput.persons,
    payments,
    hasRefund
  });

  const shiftLockAt = await getShiftLock(tx, now);
  const paymentsWithVoidFlag = payments.map(p => ({
    ...p,
    can_void: canVoidPayment(p, { shiftLockAt, now })
  }));

  const validPayments = paymentsWithVoidFlag.filter(p => p.status === 'valid');
  for (const ep of (billInput.effectivePersons || [])) {
    const rInfo = calculatePersonRefundInfo(validPayments, ep.person_no);
    ep.paid_amount = rInfo.paid_amount;
    ep.refunded_amount = rInfo.refunded_amount;
    ep.max_refundable = rInfo.max_refundable;
    ep.pass_refundable = rInfo.pass_refundable;
  }

  return {
    bill,
    booking: {
      booking_ref,
      ref_display: `BK-${booking_ref.replace(/^BK-/i, '').slice(0, 4).toUpperCase()}-${booking_ref.replace(/^BK-/i, '').slice(-4).toUpperCase()}`,
      name: user.name || (firstRes.is_walk_in ? '現場客人' : '現場客人'),
      customer_name: user.name || null,
      phone: user.phone || '',
      pax: firstRes.pax,
      session_date: dStr,
      start_time: firstRes.session.start_time,
      end_time: lastRes.session.end_time,
      start_at: `${dStr}T${firstRes.session.start_time}:00+08:00`,
      end_at: `${dStr}T${lastRes.session.end_time}:00+08:00`,
      is_walk_in: Boolean(firstRes.is_walk_in),
      attendance: firstRes.attendance,
      checked_in_at: firstRes.checked_in_at,
      checked_in_by: firstRes.checked_in_by,
      seat_source: firstRes.seat_source || 'auto',
      is_seat_locked: Boolean(firstRes.is_seat_locked),
      assigned_seats: firstRes.assigned_seats || [],
      booked_minutes: billInput.booking.booked_minutes
    },
    draft,
    pricing,
    rules: billInput.rules,
    discountConfig: billInput.discountConfig,
    billInput,
    persons: billInput.effectivePersons,
    boards: billInput.boards,
    payments: paymentsWithVoidFlag,
    status
  };
}

/**
 * Save bill draft (spec 4.6.5 & 5.4 PUT /draft)
 */
export async function saveDraft(booking_ref, base_rev, newDraft, staffName, staffId, deviceInfo, tx = prisma) {
  const reservations = await tx.reservation.findMany({
    where: { booking_ref, status: { not: 'cancelled' } }
  });
  if (!reservations.length) throw { status: 404, message: '找不到此筆預約' };

  const currentDetails = reservations[0].checkout_details;
  const currentRev = currentRevOf(currentDetails);

  if (base_rev !== undefined && base_rev !== null && base_rev !== currentRev) {
    throw {
      status: 409,
      code: 'REV_CONFLICT',
      message: '另一台裝置剛改過這筆帳，已重新載入'
    };
  }

  // Validate reasons for changes (spec 5.4 PUT /draft)
  if (newDraft.manual_discount && !newDraft.manual_discount.reason) {
    throw { status: 422, message: '手動折讓請選擇原因' };
  }
  if (newDraft.total_override && !newDraft.total_override.reason) {
    throw { status: 422, message: '直接改應收金額請選擇原因' };
  }
  if (Array.isArray(newDraft.persons)) {
    for (const p of newDraft.persons) {
      if (p.adjust && p.adjust.amount !== 0 && !p.adjust.reason) {
        throw { status: 422, message: `第 ${p.person_no} 位金額調整請選擇原因` };
      }
    }
  }

  // Detect differences and write audit logs
  if (newDraft.manual_discount?.amount !== currentDetails?.manual_discount?.amount) {
    await auditLog(tx, {
      booking_ref,
      event_type: 'amount_adjusted',
      category: 'amount',
      summary: `手動折讓 NT$${Math.abs(newDraft.manual_discount?.amount || 0)}。原因「${newDraft.manual_discount?.reason || '優惠'}」`,
      amount: newDraft.manual_discount?.amount || 0,
      reason: newDraft.manual_discount?.reason,
      staff_name: staffName,
      staff_id: staffId,
      device_id: deviceInfo?.device_id,
      device_label: deviceInfo?.device_label
    });
  }

  if (newDraft.total_override?.amount !== currentDetails?.total_override?.amount) {
    await auditLog(tx, {
      booking_ref,
      event_type: 'amount_adjusted',
      category: 'amount',
      summary: `直接改應收金額 NT$${newDraft.total_override?.amount || 0}。原因「${newDraft.total_override?.reason || '調整'}」`,
      amount: newDraft.total_override?.amount || 0,
      reason: newDraft.total_override?.reason,
      staff_name: staffName,
      staff_id: staffId,
      device_id: deviceInfo?.device_id,
      device_label: deviceInfo?.device_label
    });
  }

  const existingPromos = Array.isArray(currentDetails?.order_promos) ? currentDetails.order_promos : [];
  const incomingPromos = Array.isArray(newDraft?.order_promos) ? newDraft.order_promos : [];
  const incomingPromoByCode = new Map(
    incomingPromos
      .filter((p) => p && p.code)
      .map((p) => [String(p.code).trim().toUpperCase(), p])
  );
  const preservedOrderPromos = existingPromos.map((ep) => {
    const match = incomingPromoByCode.get(String(ep?.code || '').trim().toUpperCase());
    if (!match) return ep;
    const nextSplitMode = match.split?.mode || match.split_mode;
    if (!nextSplitMode) return ep;
    return {
      ...ep,
      split_mode: nextSplitMode,
      ...(ep.split ? { split: { ...ep.split, mode: nextSplitMode } } : {})
    };
  });

  const updatedRev = currentRev + 1;
  const draftToSave = {
    ...newDraft,
    order_promos: preservedOrderPromos,
    version: 2,
    rev: updatedRev,
    updated_at: new Date().toISOString(),
    updated_by: staffName
  };

  await tx.reservation.updateMany({
    where: { booking_ref },
    data: { checkout_details: draftToSave }
  });

  await refreshBillingCache(tx, booking_ref);
  const result = await getBookingBill(booking_ref, tx);
  return {
    bill: result.bill,
    draft: draftToSave,
    billInput: result.billInput,
    rev: updatedRev
  };
}

/**
 * Add promo code onto a booking bill server-side (Round 34 Item 2)
 */
export async function addPromoToBill(booking_ref, { code, base_rev }, staffUser, deviceInfo) {
  const staffName = staffUser?.name || '門市人員';
  const staffId = staffUser?.id || null;
  const cleanCode = (code || '').trim().toUpperCase();
  if (!cleanCode) {
    throw { status: 400, message: '請輸入折扣碼' };
  }

  return await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${booking_ref}))`;

    const reservations = await tx.reservation.findMany({
      where: { booking_ref, status: { not: 'cancelled' } }
    });
    if (!reservations.length) {
      throw { status: 404, message: '找不到此筆預約' };
    }

    const currentDetails = reservations[0].checkout_details;
    const currentRev = currentRevOf(currentDetails);
    if (base_rev !== undefined && base_rev !== null && Number(base_rev) !== currentRev) {
      throw {
        status: 409,
        code: 'REV_CONFLICT',
        message: '另一台裝置剛改過這筆帳，已重新載入'
      };
    }

    const currentData = await getBookingBill(booking_ref, tx);
    const existingPromos = Array.isArray(currentData.draft?.order_promos)
      ? currentData.draft.order_promos
      : [];
    if (existingPromos.some((op) => String(op?.code || '').trim().toUpperCase() === cleanCode)) {
      throw {
        status: 409,
        code: 'PROMO_ALREADY_APPLIED',
        message: `優惠碼 ${cleanCode} 已經套用在此帳單上`
      };
    }

    const unpaidPersons = (currentData.bill?.persons || []).filter(
      (p) => !p.is_paid && p.status !== 'removed'
    );
    if (unpaidPersons.length === 0) {
      throw { status: 400, message: '沒有未付款的人員，無法套用優惠碼' };
    }

    const allUnlimited = unpaidPersons.every((p) => p.entry?.mode === 'unlimited');
    const allHourly = unpaidPersons.every((p) => p.entry?.mode !== 'unlimited');
    const hasMixedModes = !allUnlimited && !allHourly;

    const unpaidBase = unpaidPersons.reduce((s, p) => s + (p.base_amount || 0), 0);
    const unpaidSeating = unpaidPersons.reduce((s, p) => s + (p.entry?.amount || 0), 0);
    const unpaidBoard = unpaidPersons.reduce((s, p) => s + (p.board?.amount || 0), 0);
    const bookedHours = Math.max(1, (currentData.booking?.booked_minutes || 60) / 60);

    const evalRes = await evaluatePromoCode(tx, {
      code: cleanCode,
      session_date: currentData.booking?.session_date,
      pax: unpaidPersons.length,
      hours: bookedHours,
      is_unlimited: allUnlimited,
      has_mixed_modes: hasMixedModes,
      base_amount: unpaidBase,
      hourly_price: currentData.pricing?.hourly,
      user_id: reservations[0].user_id,
      is_pos: true,
      skip_usage_check: false,
      exclude_booking_ref: booking_ref,
      seating_amount: unpaidSeating,
      equipment_amount: unpaidBoard,
      persons: unpaidPersons.map((p) => ({
        person_no: p.person_no,
        entry_amount: p.entry?.amount || 0,
        board_amount: p.board?.amount || 0,
        base_amount: p.base_amount || 0
      }))
    });

    if (!evalRes.valid) {
      throw { status: 400, message: evalRes.error || '折扣碼無效或未達門檻' };
    }

    const defaultSplitMode = currentData.draft?.split_mode || currentData.rules?.default_split_mode || 'proportional';
    const nextPromos = [
      ...existingPromos,
      {
        ...evalRes.rule,
        split_mode: defaultSplitMode
      }
    ];
    const updatedRev = currentRev + 1;
    const draftToSave = {
      ...currentData.draft,
      version: 2,
      order_promos: nextPromos,
      rev: updatedRev,
      updated_at: new Date().toISOString(),
      updated_by: staffName
    };

    await tx.reservation.updateMany({
      where: { booking_ref },
      data: { checkout_details: draftToSave }
    });

    await refreshBillingCache(tx, booking_ref);

    const nextPromoCodeStr = [...new Set(nextPromos.map((op) => op?.code).filter(Boolean))].join(',') || null;
    await tx.reservation.updateMany({
      where: { booking_ref },
      data: { promo_code: nextPromoCodeStr }
    });

    await auditLog(tx, {
      booking_ref,
      event_type: 'promo_applied',
      category: 'amount',
      summary: `套用優惠碼 ${evalRes.rule.code}（折抵 NT$${evalRes.discount_amount}）`,
      amount: -evalRes.discount_amount,
      after_json: { code: evalRes.rule.code, discount_amount: evalRes.discount_amount },
      staff_name: staffName,
      staff_id: staffId,
      device_id: deviceInfo?.device_id,
      device_label: deviceInfo?.device_label
    });

    const finalData = await getBookingBill(booking_ref, tx);
    return {
      bill: finalData.bill,
      draft: draftToSave,
      billInput: finalData.billInput,
      rev: updatedRev
    };
  });
}

/**
 * Remove promo code from a booking bill server-side (Round 34 Item 2)
 */
export async function removePromoFromBill(booking_ref, { code, base_rev }, staffUser, deviceInfo) {
  const staffName = staffUser?.name || '門市人員';
  const staffId = staffUser?.id || null;
  const cleanCode = decodeURIComponent(code || '').trim().toUpperCase();
  if (!cleanCode) {
    throw { status: 400, message: '請指定要移除的優惠碼' };
  }

  return await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${booking_ref}))`;

    const reservations = await tx.reservation.findMany({
      where: { booking_ref, status: { not: 'cancelled' } }
    });
    if (!reservations.length) {
      throw { status: 404, message: '找不到此筆預約' };
    }

    const currentDetails = reservations[0].checkout_details;
    const currentRev = currentRevOf(currentDetails);
    if (base_rev !== undefined && base_rev !== null && Number(base_rev) !== currentRev) {
      throw {
        status: 409,
        code: 'REV_CONFLICT',
        message: '另一台裝置剛改過這筆帳，已重新載入'
      };
    }

    const currentData = await getBookingBill(booking_ref, tx);
    const existingPromos = Array.isArray(currentData.draft?.order_promos)
      ? currentData.draft.order_promos
      : [];
    const targetPromo = existingPromos.find(
      (op) => String(op?.code || '').trim().toUpperCase() === cleanCode
    );
    if (!targetPromo) {
      throw { status: 404, message: `帳單未套用優惠碼 ${cleanCode}` };
    }

    const nextPromos = existingPromos.filter(
      (op) => String(op?.code || '').trim().toUpperCase() !== cleanCode
    );
    const updatedRev = currentRev + 1;
    const draftToSave = {
      ...currentData.draft,
      version: 2,
      order_promos: nextPromos,
      rev: updatedRev,
      updated_at: new Date().toISOString(),
      updated_by: staffName
    };

    await tx.reservation.updateMany({
      where: { booking_ref },
      data: { checkout_details: draftToSave }
    });

    await refreshBillingCache(tx, booking_ref);

    const nextPromoCodeStr = [...new Set(nextPromos.map((op) => op?.code).filter(Boolean))].join(',') || null;
    await tx.reservation.updateMany({
      where: { booking_ref },
      data: { promo_code: nextPromoCodeStr }
    });

    // Release PromoRedemption if no frozen paid person's snapshot references this promo
    const usedInFrozenPaid = (currentData.bill?.persons || [])
      .filter((p) => p.is_frozen || p.is_paid)
      .some(
        (p) =>
          (p.promos || []).some((pr) => String(pr?.code || '').trim().toUpperCase() === cleanCode) ||
          (p.shares || []).some((sh) => sh?.source_key === `promo:${cleanCode}`)
      );
    if (!usedInFrozenPaid) {
      let targetPromoId = targetPromo.promo_id ?? null;
      if (targetPromoId == null) {
        const foundPromo = await tx.promoCode.findUnique({ where: { code: cleanCode }, select: { id: true } });
        targetPromoId = foundPromo?.id ?? null;
      }
      if (targetPromoId != null) {
        await releasePromo(tx, {
          booking_ref,
          promo_id: targetPromoId,
          reason: 'promo_removed_from_bill'
        });
      }
    }

    await auditLog(tx, {
      booking_ref,
      event_type: 'promo_removed',
      category: 'amount',
      summary: `移除優惠碼 ${cleanCode}`,
      before_json: { code: cleanCode, rule: targetPromo },
      staff_name: staffName,
      staff_id: staffId,
      device_id: deviceInfo?.device_id,
      device_label: deviceInfo?.device_label
    });

    const finalData = await getBookingBill(booking_ref, tx);
    return {
      bill: finalData.bill,
      draft: draftToSave,
      billInput: finalData.billInput,
      rev: updatedRev
    };
  });
}

/**
 * Refresh cached billing columns on Reservation rows (spec 4.6.2)
 */
export async function refreshBillingCache(tx = prisma, booking_ref) {
  const { bill, status, payments } = await getBookingBill(booking_ref, tx);

  const validPayments = payments.filter(p => p.status === 'valid');
  const latestPayment = validPayments[validPayments.length - 1];

  const hasRefund = validPayments.some(p => p.kind === 'refund');
  const paidPersons = status.covered ?? 0;
  const amountDue = bill.summary?.amount_due ?? 0;
  const amountReceived = bill.summary?.amount_received ?? 0;

  const isPaid = status.code === 'paid' || status.code === 'waived';

  // Determine payment method
  const chargeMethods = [...new Set(
    validPayments
      .filter(p => p.kind === 'charge' || p.kind === 'supplement')
      .map(p => p.method)
      .filter(m => m && m !== 'none')
  )];
  let paymentMethod = null;
  if (chargeMethods.length > 1) {
    paymentMethod = 'mixed';
  } else if (chargeMethods.length === 1) {
    paymentMethod = chargeMethods[0];
  } else if (status.code === 'waived') {
    paymentMethod = 'none';
  }

  // Preserve paid_at if already set, or set if newly paid, null if not paid
  const existingRes = await tx.reservation.findFirst({
    where: { booking_ref },
    select: { paid_at: true, is_paid: true, checkout_details: true }
  });

  let paidAt = existingRes?.paid_at || null;
  if (isPaid) {
    if (!paidAt) {
      paidAt = latestPayment?.created_at || new Date();
    }
  } else {
    paidAt = null;
  }

  // Emit bill_reopened audit event if previously is_paid was true and now is false
  if (existingRes?.is_paid && !isPaid) {
    await auditLog(tx, {
      booking_ref,
      event_type: 'bill_reopened',
      category: 'status',
      summary: `帳單重新開啟（未結清），目前應收 NT$${amountDue}，已收 NT$${amountReceived}`,
      amount: Math.max(0, amountDue - amountReceived),
      staff_name: '系統',
      device_label: '系統'
    });
  }

  await tx.reservation.updateMany({
    where: { booking_ref },
    data: {
      billing_status: status.code,
      has_refund: hasRefund,
      paid_persons: paidPersons,
      amount_due: amountDue,
      amount_received: amountReceived,
      is_paid: isPaid,
      total_amount: amountDue,
      paid_at: paidAt,
      payment_method: paymentMethod,
      checkout_unlimited_pax: isPaid ? (bill.summary?.unlimited_pax_total ?? 0) : null,
      checkout_regular_hours: isPaid ? (bill.summary?.regular_hours_total ?? 0) : null,
      discount_amount: bill.summary?.discounts_total ?? 0,
      addons_amount: bill.summary?.addons_total ?? 0
    }
  });

  return { bill, status };
}

/**
 * Plan pass tenders on server without mutating quota or payment records.
 */
export async function planPassTenders(txOrPrisma = prisma, {
  booking_ref,
  bill,
  pricing,
  targetPersonNos = [],
  pass_tenders = [],
  reservation = null
} = {}) {
  const normalizedNos = Array.isArray(targetPersonNos) ? targetPersonNos.map(Number).filter(n => !Number.isNaN(n)) : [];
  const targetPersons = (bill?.persons || []).filter(p => normalizedNos.includes(p.person_no));
  const grossDue = targetPersons.reduce((sum, p) => sum + (p.total || 0), 0);

  if (!Array.isArray(pass_tenders) || pass_tenders.length === 0 || targetPersons.length === 0) {
    return {
      tenders: [],
      gross_due: grossDue,
      total_discount: 0,
      net_due: grossDue
    };
  }

  const firstRes = reservation || await txOrPrisma.reservation.findFirst({
    where: { booking_ref, status: { not: 'cancelled' } },
    include: { session: true }
  });
  const sessionDate = firstRes?.session?.session_date || firstRes?.session_date || new Date();

  const usedPassIds = new Set();
  const personCovered = new Map();
  const plannedTenders = [];
  let totalDiscount = 0;

  for (const pt of pass_tenders) {
    const passId = Number(pt?.user_pass_id);
    if (!passId || usedPassIds.has(passId)) {
      throw { status: 422, message: '同一次收款不能重複使用同一張卡券' };
    }
    usedPassIds.add(passId);

    const pass = await txOrPrisma.userPass.findUnique({
      where: { id: passId },
      include: { plan: true }
    });
    if (!pass) {
      throw { status: 422, message: '找不到卡券' };
    }
    if (firstRes && pass.user_id !== firstRes.user_id) {
      throw { status: 422, message: '此卡券不屬於此預約會員' };
    }

    const effect = resolvePassCheckoutEffect(pass.plan?.checkout_effect, pass.pass_type);
    const effectiveUnits = effect === 'entry_full' ? 1 : (Number(pt.units) || 1);

    const validation = validatePassUsage(pass, {
      date: sessionDate,
      units: effectiveUnits,
      hours: effectiveUnits
    });
    if (!validation.usable) {
      throw { status: 422, message: validation.reason };
    }

    const tenderPersonNo = Number(pt?.person_no);
    if (!Number.isInteger(tenderPersonNo) || !normalizedNos.includes(tenderPersonNo)) {
      throw { status: 422, message: '卡券對應的人不在這次收款名單' };
    }
    const pBill = targetPersons.find(p => p.person_no === tenderPersonNo);
    if (!pBill) {
      throw { status: 422, message: '卡券對應的人不在這次收款名單' };
    }
    const alreadyCovered = personCovered.get(pBill.person_no) || 0;
    const rawValue = computePassTenderValue({
      checkout_effect: pass.plan?.checkout_effect,
      pass_type: pass.pass_type,
      checkout_scope: pass.plan?.checkout_scope,
      discount_percent: pass.plan?.discount_percent,
      checkout_value: pass.plan?.checkout_value,
      units: effectiveUnits,
      person: pBill,
      hourly_price: pricing?.hourly || 150,
      already_covered: alreadyCovered
    });

    const remainingOrderDue = Math.max(0, grossDue - totalDiscount);
    const value = Math.min(rawValue, remainingOrderDue);
    personCovered.set(pBill.person_no, alreadyCovered + value);
    totalDiscount += value;

    plannedTenders.push({
      user_pass_id: pass.id,
      person_no: pBill.person_no,
      units: effectiveUnits,
      value,
      pass,
      plan_name: pass.plan_name_snapshot,
      pass_type: pass.pass_type,
      pass_code: pass.pass_code
    });
  }

  return {
    tenders: plannedTenders,
    gross_due: grossDue,
    total_discount: totalDiscount,
    net_due: Math.max(0, grossDue - totalDiscount)
  };
}

/**
 * Quote endpoint helper for POST /api/billing/:booking_ref/pass-quote
 */
export async function quotePassTenders(booking_ref, payload = {}) {
  const { person_nos = [], pass_tenders = [] } = payload || {};
  const billData = await getBookingBill(booking_ref, prisma);
  const { bill, pricing } = billData;
  const normalizedNos = Array.isArray(person_nos) ? person_nos.map(Number).filter(n => !Number.isNaN(n)) : [];

  const planned = await planPassTenders(prisma, {
    booking_ref,
    bill,
    pricing,
    targetPersonNos: normalizedNos,
    pass_tenders: Array.isArray(pass_tenders) ? pass_tenders : []
  });

  return {
    gross_due: planned.gross_due,
    net_due: planned.net_due,
    total_discount: planned.total_discount,
    tenders: planned.tenders.map(({ user_pass_id, person_no, units, value, plan_name, pass_type }) => ({
      user_pass_id,
      person_no,
      units,
      value,
      plan_name,
      pass_type
    }))
  };
}

/**
 * Collect payment for one or more persons (spec 5.4 POST /collect)
 */
export async function collectPayment(booking_ref, payload, staffUser, deviceInfo) {
  const staffName = staffUser?.name || '門市人員';
  const staffId = staffUser?.id || null;
  const {
    client_batch_id,
    person_nos = [],
    expected_amount,
    expected_net_amount,
    method = 'cash',
    cash_received = null,
    pass_tenders = [],
    note = '',
    print = true
  } = payload;

  const result = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${booking_ref}))`;

    // Idempotency: check client_batch_id
    if (client_batch_id) {
      const existingPayments = await tx.payment.findMany({
        where: { client_batch_id }
      });
      if (existingPayments.length > 0) {
        const { bill, status } = await getBookingBill(booking_ref, tx);
        return { payments: existingPayments, bill, status, print_jobs: [] };
      }
    }

    // Count prior valid payments (for promo used_count trigger)
    const priorValidPayments = await tx.payment.findMany({
      where: { booking_ref, status: 'valid' }
    });
    const priorValidCount = priorValidPayments.length;

    // Recalculate bill
    const billData = await getBookingBill(booking_ref, tx);
    const { bill, pricing, draft } = billData;

    // Filter target persons
    const targetPersonNos = person_nos.map(Number);
    if (!targetPersonNos.length) {
      throw { status: 400, message: '請選擇收款人數' };
    }

    // Verify each person: exists, not removed, not already paid (Section 3.5)
    for (const pno of targetPersonNos) {
      const pObj = billData.persons?.find(p => p.person_no === pno);
      if (!pObj) {
        throw { status: 409, message: `第 ${pno} 位不存在` };
      }
      if (pObj.status === 'removed') {
        throw { status: 409, message: `第 ${pno} 位已移除，無法收款` };
      }
      const computedP = bill.persons.find(p => p.person_no === pno);
      if (computedP?.is_paid) {
        throw { status: 409, message: `第 ${pno} 位已經付過款` };
      }
    }

    // Direct Payment check in transaction: reject if any valid charge/waive includes this person
    const priorPaidPersons = new Set();
    for (const p of priorValidPayments) {
      if ((p.kind === 'charge' || p.kind === 'waive') && Array.isArray(p.person_nos)) {
        for (const pno of p.person_nos) priorPaidPersons.add(pno);
      }
    }
    for (const pno of targetPersonNos) {
      if (priorPaidPersons.has(pno)) {
        throw { status: 409, message: `第 ${pno} 位已經付過款` };
      }
    }

    const hasPassTenders = Array.isArray(pass_tenders) && pass_tenders.length > 0;

    // pass is tender-only, not a direct payment method (Spec round 18b)
    if (!hasPassTenders && String(method || '').trim().toLowerCase() === 'pass') {
      throw { status: 422, message: '卡券請用卡券折抵' };
    }

    // Validate payment method against GlobalSetting.payment_methods_json
    const gs = await tx.globalSetting.findUnique({ where: { id: 1 } });
    const rawMethods = (Array.isArray(gs?.payment_methods_json) && gs.payment_methods_json.length > 0
      ? gs.payment_methods_json
      : [
          { key: 'cash', label: '現金', enabled: true },
          { key: 'linepay', label: 'LINE Pay', enabled: true },
          { key: 'transfer', label: '銀行轉帳', enabled: true },
          { key: 'card', label: '信用卡', enabled: true }
        ]
    ).filter(m => String(m.key || m.code || '').trim().toLowerCase() !== 'pass');

    const enabledMethods = rawMethods.filter(m => {
      const k = String(m.key || m.code || '').toLowerCase();
      return k === 'cash' ? true : Boolean(m.enabled);
    });

    const validateMethod = (mToValidate) => {
      const reqMethodNorm = String(mToValidate || 'cash').toLowerCase().replace(/[-_]/g, '');
      const isMethodAllowed = enabledMethods.some(m => {
        const k = String(m.key || m.code || '').toLowerCase().replace(/[-_]/g, '');
        return k === reqMethodNorm;
      });
      if (!isMethodAllowed) {
        throw { status: 422, message: `付款方式「${mToValidate}」未啟用或不支援` };
      }
    };

    if (!hasPassTenders) {
      validateMethod(method);
    }

    const targetPersons = bill.persons.filter(p => targetPersonNos.includes(p.person_no));
    const calculatedTotal = targetPersons.reduce((sum, p) => sum + (p.total || 0), 0);
    if (expected_amount !== undefined && expected_amount !== null && calculatedTotal !== Number(expected_amount)) {
      throw {
        status: 409,
        code: 'AMOUNT_CHANGED',
        message: '金額剛剛有變動，請確認後再收款',
        bill
      };
    }

    const firstRes = hasPassTenders
      ? await tx.reservation.findFirst({ where: { booking_ref }, include: { session: true } })
      : null;

    const passQuote = await planPassTenders(tx, {
      booking_ref,
      bill,
      pricing,
      targetPersonNos,
      pass_tenders,
      reservation: firstRes
    });

    if (expected_net_amount !== undefined && expected_net_amount !== null && passQuote.net_due !== Number(expected_net_amount)) {
      throw {
        status: 409,
        code: 'AMOUNT_CHANGED',
        message: '金額剛剛有變動，請確認後再收款',
        bill,
        quote: {
          tenders: passQuote.tenders.map(({ user_pass_id, person_no, units, value, plan_name, pass_type }) => ({
            user_pass_id, person_no, units, value, plan_name, pass_type
          })),
          gross_due: passQuote.gross_due,
          net_due: passQuote.net_due
        }
      };
    }

    const batchNo = `B-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    const createdPayments = [];
    let remainingAmount = passQuote.net_due;

    // Apply server-computed pass tenders (Section 3.7 & 4.5.7)
    const passRecords = [];
    const personPassDiscounts = new Map();
    for (const tender of passQuote.tenders) {
      const { pass, value: discountValue, units: usedUnits, person_no: tenderPersonNo } = tender;
      const pBill = targetPersons.find(p => p.person_no === tenderPersonNo) || targetPersons[0];
      if (discountValue > 0) {
        personPassDiscounts.set(pBill.person_no, (personPassDiscounts.get(pBill.person_no) || 0) + discountValue);
        const passPayNo = await nextSerialNo(tx, 'payment', resolveBillingDate(payload));

        await deductPass(tx, {
          user_pass_id: pass.id,
          units: usedUnits,
          booking_ref,
          payment_no: passPayNo,
          person_no: pBill.person_no,
          staff_name: staffName,
          date: firstRes?.session?.session_date || firstRes?.session_date || new Date()
        });

        const passPay = await tx.payment.create({
          data: {
            payment_no: passPayNo,
            batch_no: batchNo,
            client_batch_id,
            booking_ref,
            kind: 'charge',
            status: 'valid',
            method: 'pass',
            amount: discountValue,
            person_nos: [pBill.person_no],
            breakdown_json: {
              persons: [{ ...pBill, amount: discountValue }],
              pricing,
              snapshot_at: new Date().toISOString()
            },
            pass_json: [{
              user_pass_id: pass.id,
              pass_code: pass.pass_code,
              plan_name: pass.plan_name_snapshot,
              units: usedUnits,
              unit_label: pass.pass_type === 'TIME_PASS' ? '小時' : '次',
              value: discountValue,
              person_no: pBill.person_no
            }],
            staff_name: staffName,
            staff_id: staffId,
            device_id: deviceInfo?.device_id,
            device_label: deviceInfo?.device_label || '櫃檯'
          }
        });

        createdPayments.push(passPay);
        passRecords.push({ pass_code: pass.pass_code, value: discountValue });

        await auditLog(tx, {
          booking_ref,
          event_type: 'pass_redeemed',
          category: 'pass',
          summary: `卡券折抵 第 ${pBill.person_no} 位 · ${pass.plan_name_snapshot} · NT$${discountValue}`,
          amount: discountValue,
          payment_id: passPay.id,
          staff_name: staffName,
          staff_id: staffId,
          device_id: deviceInfo?.device_id,
          device_label: deviceInfo?.device_label
        });
      }
    }

    // Collect remaining amount with chosen method
    if (remainingAmount > 0 || (calculatedTotal === 0 && createdPayments.length === 0)) {
      if (hasPassTenders) {
        if (String(method || '').trim().toLowerCase() === 'pass') {
          throw { status: 422, message: '卡券請用卡券折抵' };
        }
        validateMethod(method);
      }
      const payNo = await nextSerialNo(tx, 'payment', resolveBillingDate(payload));

      let change = 0;
      const providedCash = (cash_received !== null && cash_received !== undefined && cash_received !== '')
        ? Number(cash_received)
        : remainingAmount;
      if (method === 'cash') {
        if (!Number.isFinite(providedCash) || providedCash < remainingAmount) {
          throw { status: 400, message: `實收現金（NT$${Number.isFinite(providedCash) ? providedCash : 0}）不足（應收 NT$${remainingAmount}）` };
        }
        change = providedCash - remainingAmount;
      }

      const targetPersonsWithNet = targetPersons.map(tp => ({
        ...tp,
        amount: Math.max(0, (tp.total || 0) - (personPassDiscounts.get(tp.person_no) || 0))
      }));

      const mainPay = await tx.payment.create({
        data: {
          payment_no: payNo,
          batch_no: batchNo,
          client_batch_id,
          booking_ref,
          kind: 'charge',
          status: 'valid',
          method,
          amount: remainingAmount,
          cash_received: method === 'cash' ? providedCash : null,
          change_given: method === 'cash' ? change : null,
          person_nos: targetPersonNos,
          breakdown_json: {
            persons: targetPersonsWithNet,
            pricing,
            order: {
              persons_total: bill.status?.total ?? targetPersons.length,
              persons_paid_after: priorPaidPersons.size + targetPersonNos.length,
              amount_due: bill.summary?.amount_due,
              amount_received: bill.summary?.amount_received
            },
            snapshot_at: new Date().toISOString()
          },
          note: note ? String(note).trim() : null,
          staff_name: staffName,
          staff_id: staffId,
          device_id: deviceInfo?.device_id,
          device_label: deviceInfo?.device_label || '櫃檯'
        }
      });
      createdPayments.push(mainPay);

      await auditLog(tx, {
        booking_ref,
        event_type: 'payment_created',
        category: 'payment',
        summary: `收款 第 ${targetPersonNos.join('、')} 位 · ${method === 'cash' ? '現金' : method} NT$${remainingAmount}`,
        amount: remainingAmount,
        payment_id: mainPay.id,
        staff_name: staffName,
        staff_id: staffId,
        device_id: deviceInfo?.device_id,
        device_label: deviceInfo?.device_label
      });
    }

    // First time covered by payment: record PromoRedemption (channel='pos'; idempotent if already active from online/self)
    if (priorValidCount === 0 && createdPayments.length > 0) {
      const promoCodes = [];
      for (const op of draft?.order_promos || []) if (op.code) promoCodes.push(op.code);
      for (const p of draft?.persons || []) {
        for (const pr of p.promos || []) if (pr.code) promoCodes.push(pr.code);
      }
      const uniqueCodes = [...new Set(promoCodes.map((c) => String(c).trim().toUpperCase()).filter(Boolean))];
      if (uniqueCodes.length > 0) {
        const bookingMeta = await tx.reservation.findFirst({
          where: { booking_ref },
          select: { user_id: true }
        });
        for (const c of uniqueCodes) {
          const promoRow = await tx.promoCode.findUnique({ where: { code: c } });
          if (promoRow) {
            await redeemPromo(tx, {
              promo: promoRow,
              booking_ref,
              user_id: bookingMeta?.user_id ?? null,
              channel: 'pos'
            });
          }
        }
      }
    }

    // End timer for these persons if still running
    const now = new Date();
    await tx.bookingPerson.updateMany({
      where: {
        booking_ref,
        person_no: { in: targetPersonNos },
        timer_started_at: { not: null },
        timer_ended_at: null
      },
      data: {
        timer_ended_at: now
      }
    });

    // Refresh billing cache
    const { bill: finalBill, status: finalStatus } = await refreshBillingCache(tx, booking_ref);

    // Automatic print handling (Section 3.8)
    const print_jobs = [];
    const globalSetting = await tx.globalSetting.findFirst() || {};

    if (print !== false && globalSetting.print_enabled !== false && globalSetting.auto_print_receipt !== false) {
      for (const pay of createdPayments) {
        const job = await queuePrintJob({
          type: 'receipt',
          booking_ref,
          payment_id: pay.id,
          user: staffUser,
          device: deviceInfo,
          now: resolveBillingDate(payload)
        }, tx);
        if (job) print_jobs.push(job);
      }
    }

    // Auto print summary if fully settled after multiple payments
    if (
      print !== false &&
      globalSetting.print_enabled !== false &&
      globalSetting.auto_print_summary !== false &&
      (finalStatus.code === 'paid' || finalStatus.code === 'waived')
    ) {
      const allValid = await tx.payment.findMany({
        where: { booking_ref, status: 'valid', kind: { in: ['charge', 'waive'] } }
      });
      const batchSet = new Set(allValid.map(p => p.batch_no));
      if (batchSet.size > 1 || allValid.length > 1) {
        const sumJob = await queuePrintJob({
          type: 'summary',
          booking_ref,
          user: staffUser,
          device: deviceInfo,
          now: resolveBillingDate(payload)
        }, tx);
        if (sumJob) print_jobs.push(sumJob);
      }
    }

    return {
      payments: createdPayments,
      bill: finalBill,
      status: finalStatus,
      print_jobs
    };
  });

  return result;
}

/**
 * Record supplement payment (spec 5.4 POST /supplement)
 */
export async function supplementPayment(booking_ref, payload, staffUser, deviceInfo) {
  const staffName = staffUser?.name || '門市人員';
  const staffId = staffUser?.id || null;
  const { client_batch_id, person_no, items = [], method = 'cash', cash_received = null, note = '' } = payload;
  const pNo = Number(person_no);

  return await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${booking_ref}))`;

    if (client_batch_id) {
      const existing = await tx.payment.findFirst({
        where: { client_batch_id }
      });
      if (existing) {
        const { bill, status } = await getBookingBill(booking_ref, tx);
        return { payment: existing, bill, status, print_jobs: [] };
      }
    }

    // Must have prior valid charge payment
    const priorPayment = await tx.payment.findFirst({
      where: {
        booking_ref,
        status: 'valid',
        kind: 'charge',
        person_nos: { has: pNo }
      },
      orderBy: { created_at: 'desc' }
    });

    if (!priorPayment) {
      throw { status: 400, message: `第 ${pNo} 位尚未付款，請直接在帳單結帳` };
    }

    // pass is tender-only, not a direct payment method (Spec round 18b)
    if (String(method || '').trim().toLowerCase() === 'pass') {
      throw { status: 422, message: '卡券請用卡券折抵' };
    }

    const now = new Date();
    const billData = await getBookingBill(booking_ref, tx, now);
    const serverPricing = billData.pricing || {};
    const targetPersonBill = (billData.bill?.persons || []).find(p => Number(p.person_no) === pNo);
    const hourly_price = serverPricing.hourly || priorPayment.breakdown_json?.pricing?.hourly || 150;
    const unlimited_price = serverPricing.unlimited || priorPayment.breakdown_json?.pricing?.unlimited || 750;

    let supplementAmount = 0;
    const itemSummaries = [];
    const sanitizedItems = [];
    const collectedPendingItems = [];

    for (const it of (Array.isArray(items) ? items : [])) {
      if (it.type === 'addon') {
        const addonId = Number(it.addon_id);
        const qty = it.qty === undefined || it.qty === null ? 1 : Number(it.qty);
        if (!Number.isInteger(addonId) || addonId <= 0) {
          throw { status: 422, message: '加購品項必須指定有效的 addon_id' };
        }
        if (!Number.isInteger(qty) || qty <= 0) {
          throw { status: 422, message: '加購數量必須為正整數' };
        }
        const addonRow = await tx.addonItem.findUnique({ where: { id: addonId } });
        if (!addonRow || !addonRow.is_active) {
          throw { status: 422, message: '找不到或已停用的加購品項' };
        }
        const cost = addonRow.price * qty;
        supplementAmount += cost;
        itemSummaries.push(`${addonRow.name} ×${qty}`);
        sanitizedItems.push({
          type: 'addon',
          addon_id: addonRow.id,
          name: addonRow.name,
          price: addonRow.price,
          qty,
          amount: cost
        });
      } else if (it.type === 'hours') {
        const hrs = Number(it.hours);
        if (!Number.isFinite(hrs) || hrs <= 0 || Math.abs((hrs * 2) - Math.round(hrs * 2)) > 1e-9) {
          throw { status: 422, message: '加時時數必須是 0.5 的正倍數' };
        }
        const cost = Math.round(hrs * hourly_price);
        supplementAmount += cost;
        itemSummaries.push(`時數 +${hrs} 小時`);
        sanitizedItems.push({
          type: 'hours',
          hours: hrs,
          hourly_rate: hourly_price,
          label: `時數 +${hrs} 小時`,
          amount: cost
        });
      } else if (it.type === 'unlimited_diff') {
        const targetPerson = (priorPayment.breakdown_json?.persons || []).find(
          p => Number(p.person_no) === pNo
        ) || priorPayment.breakdown_json?.persons?.[0];
        const targetEntryPaid = targetPerson?.entry?.amount || 0;
        const diff = Math.max(0, unlimited_price - targetEntryPaid);
        if (diff > 0) {
          supplementAmount += diff;
          itemSummaries.push('升級不限時差額');
          sanitizedItems.push({
            type: 'unlimited_diff',
            unlimited_price,
            entry_paid: targetEntryPaid,
            label: '升級不限時差額',
            amount: diff
          });
        }
      } else if (it.type === 'other') {
        const amt = Number(it.amount);
        const cleanLabel = String(it.label || '').trim();
        if (!Number.isInteger(amt) || amt <= 0) {
          throw { status: 422, message: '其他補收金額必須為正整數' };
        }
        if (!cleanLabel) {
          throw { status: 422, message: '請填寫補收項目說明' };
        }
        supplementAmount += amt;
        itemSummaries.push(cleanLabel);
        sanitizedItems.push({
          type: 'other',
          label: cleanLabel,
          amount: amt
        });
      } else if (it.type === 'pending') {
        const personPendingItems = Array.isArray(targetPersonBill?.pending_items) ? targetPersonBill.pending_items : [];
        const pendingTotal = Math.max(0, Number(targetPersonBill?.pending_supplement) || 0);
        if (pendingTotal > 0) {
          supplementAmount += pendingTotal;
          itemSummaries.push('結清待補收');
          sanitizedItems.push({
            type: 'pending',
            label: '結清待補收',
            amount: pendingTotal
          });
          for (const pi of personPendingItems) {
            if (pi && pi.source_key && Number(pi.amount) > 0) {
              collectedPendingItems.push({
                person_no: pNo,
                source_key: pi.source_key,
                source_type: pi.source_type || 'order_item',
                label: pi.label || '待補收項目',
                amount: Number(pi.amount),
                ...(pi.computed_until ? { computed_until: pi.computed_until } : {})
              });
            }
          }
        }
      }
    }

    if (!(supplementAmount > 0)) {
      throw { status: 422, message: '沒有需要補收的金額' };
    }

    const payNo = await nextSerialNo(tx, 'payment', resolveBillingDate(payload));
    const batchNo = `B-${Date.now()}-${Math.floor(Math.random() * 1000)}`;

    let effectiveCashReceived = null;
    let change = null;
    if (method === 'cash') {
      const hasCashInput = cash_received !== null && cash_received !== undefined && cash_received !== '';
      const cashAmt = hasCashInput ? Number(cash_received) : supplementAmount;
      if (!Number.isFinite(cashAmt) || cashAmt < supplementAmount) {
        throw { status: 400, message: `實收現金（NT$${cashAmt}）不可小於補收金額（NT$${supplementAmount}）` };
      }
      effectiveCashReceived = Math.round(cashAmt);
      change = effectiveCashReceived - supplementAmount;
    }

    const payment = await tx.payment.create({
      data: {
        payment_no: payNo,
        batch_no: batchNo,
        client_batch_id: client_batch_id || null,
        booking_ref,
        kind: 'supplement',
        status: 'valid',
        method,
        amount: supplementAmount,
        cash_received: effectiveCashReceived,
        change_given: change,
        person_nos: [pNo],
        breakdown_json: {
          items: sanitizedItems,
          ...(collectedPendingItems.length > 0 ? { pending_items: collectedPendingItems } : {}),
          snapshot_at: now.toISOString()
        },
        related_payment_id: priorPayment.id,
        note: note ? String(note).trim() : null,
        staff_name: staffName,
        staff_id: staffId,
        device_id: deviceInfo?.device_id,
        device_label: deviceInfo?.device_label || '櫃檯'
      }
    });

    await auditLog(tx, {
      booking_ref,
      event_type: 'supplement_created',
      category: 'payment',
      summary: `補收 第 ${pNo} 位 · ${itemSummaries.join('、')} · ${method === 'cash' ? '現金' : method} NT$${supplementAmount}`,
      amount: supplementAmount,
      payment_id: payment.id,
      staff_name: staffName,
      staff_id: staffId,
      device_id: deviceInfo?.device_id,
      device_label: deviceInfo?.device_label
    });

    // Automatic print receipt (Section 3.8)
    const print_jobs = [];
    const globalSetting = await tx.globalSetting.findFirst() || {};
    if (payload.print !== false && globalSetting.print_enabled !== false && globalSetting.auto_print_receipt !== false) {
      const job = await queuePrintJob({
        type: 'supplement',
        booking_ref,
        payment_id: payment.id,
        user: staffUser,
        device: deviceInfo,
        now: resolveBillingDate(payload)
      }, tx);
      if (job) print_jobs.push(job);
    }

    const { bill, status } = await refreshBillingCache(tx, booking_ref);
    return { payment, bill, status, print_jobs };
  });
}

/**
 * Record refund (spec 5.4 POST /refund)
 */
export async function refundPayment(booking_ref, payload, staffUser, deviceInfo) {
  const staffName = staffUser?.name || '門市人員';
  const staffId = staffUser?.id || null;
  const { client_batch_id, person_no, amount, method = 'cash', reason, note = '', payment_id } = payload;
  const pNo = Number(person_no);
  const refundAmt = Math.round(Number(amount));

  if (!reason || !String(reason).trim()) {
    throw { status: 422, message: '退款請填寫原因' };
  }
  if (method === 'pass') {
    if (!payment_id) {
      throw { status: 422, message: '卡券退回必須指定要退回的卡券收款紀錄' };
    }
  } else if (!(refundAmt > 0)) {
    throw { status: 400, message: '退款金額必須大於 0' };
  }

  return await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${booking_ref}))`;

    if (client_batch_id) {
      const existing = await tx.payment.findFirst({
        where: { client_batch_id }
      });
      if (existing) {
        const { bill, status } = await getBookingBill(booking_ref, tx);
        return { payment: existing, bill, status, print_jobs: [] };
      }
    }

    const priorPayments = await tx.payment.findMany({
      where: {
        booking_ref,
        status: 'valid'
      }
    });

    let effectiveRefundAmt = refundAmt;
    let relatedPaymentId = null;
    let passRestoreTarget = null;
    let extraBreakdown = {};

    if (method === 'pass') {
      const targetPassPay = priorPayments.find(
        p => p.id === Number(payment_id) && p.kind === 'charge' && p.method === 'pass'
      );
      if (!targetPassPay || !Array.isArray(targetPassPay.person_nos) || !targetPassPay.person_nos.includes(pNo)) {
        throw { status: 422, message: '找不到該位顧客的有效卡券收款紀錄' };
      }

      const pj = Array.isArray(targetPassPay.pass_json)
        ? (targetPassPay.pass_json.find(x => Number(x?.person_no) === pNo) || targetPassPay.pass_json[0])
        : null;
      if (!pj || !pj.user_pass_id) {
        throw { status: 422, message: '該筆收款紀錄缺少卡券明細' };
      }

      const origUnits = Math.max(1, Number(pj.units || 1));
      const origValue = Number(pj.value ?? targetPassPay.amount) || 0;
      const alreadyRefundedUnits = priorPayments
        .filter(r => r.kind === 'refund' && r.method === 'pass' && r.related_payment_id === targetPassPay.id)
        .reduce((s, r) => s + (Number(r.breakdown_json?.restored_units ?? origUnits) || 0), 0);
      const remainingUnits = Math.max(0, origUnits - alreadyRefundedUnits);

      if (remainingUnits <= 0) {
        throw { status: 409, message: '這筆卡券已經退回過' };
      }

      effectiveRefundAmt = Math.round(origValue * remainingUnits / origUnits);
      relatedPaymentId = targetPassPay.id;
      passRestoreTarget = {
        user_pass_id: pj.user_pass_id,
        plan_name: pj.plan_name,
        units: remainingUnits,
        orig_payment_no: targetPassPay.payment_no
      };
      extraBreakdown = {
        restored_units: remainingUnits,
        orig_units: origUnits,
        user_pass_id: pj.user_pass_id
      };
    } else {
      const cashEligible = (p) =>
        p.status === 'valid' &&
        p.method !== 'pass' &&
        (p.kind === 'charge' || p.kind === 'supplement') &&
        Array.isArray(p.person_nos) &&
        p.person_nos.includes(pNo);

      if (payment_id !== undefined && payment_id !== null && payment_id !== '') {
        const targetCashPay = priorPayments.find((p) => p.id === Number(payment_id) && cashEligible(p));
        if (!targetCashPay) {
          throw { status: 422, message: '找不到該位顧客的有效收款紀錄' };
        }
        relatedPaymentId = targetCashPay.id;
      } else {
        const latestCashPay = [...priorPayments].reverse().find(cashEligible);
        relatedPaymentId = latestCashPay?.id || null;
      }

      const refundInfo = calculatePersonRefundInfo(priorPayments, pNo);
      const maxRefundable = refundInfo.max_refundable;
      if (effectiveRefundAmt > maxRefundable) {
        throw { status: 400, message: `退款金額超過此顧客已付金額上限（最多可退 NT$${maxRefundable}）` };
      }
    }

    const payNo = await nextSerialNo(tx, 'payment', resolveBillingDate(payload));
    const batchNo = `B-${Date.now()}-${Math.floor(Math.random() * 1000)}`;

    const payment = await tx.payment.create({
      data: {
        payment_no: payNo,
        batch_no: batchNo,
        client_batch_id: client_batch_id || null,
        booking_ref,
        kind: 'refund',
        status: 'valid',
        method,
        amount: effectiveRefundAmt,
        related_payment_id: relatedPaymentId,
        person_nos: [pNo],
        breakdown_json: {
          refund_amount: effectiveRefundAmt,
          reason,
          snapshot_at: new Date().toISOString(),
          ...extraBreakdown
        },
        reason: String(reason).trim(),
        note: note ? String(note).trim() : null,
        staff_name: staffName,
        staff_id: staffId,
        device_id: deviceInfo?.device_id,
        device_label: deviceInfo?.device_label || '櫃檯'
      }
    });

    const refundMethodName = method === 'cash' ? '現金退回' : (method === 'linepay' || method === 'line_pay' ? 'LINE Pay 退回' : (method === 'transfer' ? '銀行轉帳退回' : (method === 'pass' ? '卡券退回' : `${method}退回`)));

    await auditLog(tx, {
      booking_ref,
      event_type: 'refund_created',
      category: 'refund',
      summary: `退款 第 ${pNo} 位 NT$${effectiveRefundAmt} · ${refundMethodName}。原因「${reason}」`,
      amount: effectiveRefundAmt,
      payment_id: payment.id,
      reason,
      staff_name: staffName,
      staff_id: staffId,
      device_id: deviceInfo?.device_id,
      device_label: deviceInfo?.device_label
    });

    // Restore only the targeted pass payment (Round 35 Item 3)
    if (method === 'pass' && passRestoreTarget) {
      await restorePass(tx, {
        user_pass_id: passRestoreTarget.user_pass_id,
        units: passRestoreTarget.units,
        booking_ref,
        payment_no: payNo,
        orig_payment_no: passRestoreTarget.orig_payment_no,
        person_no: pNo,
        staff_name: staffName
      });
      await auditLog(tx, {
        booking_ref,
        event_type: 'pass_restored',
        category: 'pass',
        summary: `卡券退款退回 · ${passRestoreTarget.plan_name || '卡券'} · ${passRestoreTarget.units} 單位`,
        payment_id: payment.id,
        staff_name: staffName,
        staff_id: staffId,
        device_id: deviceInfo?.device_id,
        device_label: deviceInfo?.device_label
      });
    }

    // Automatic print receipt (Section 3.8)
    const print_jobs = [];
    const globalSetting = await tx.globalSetting.findFirst() || {};
    if (payload.print !== false && globalSetting.print_enabled !== false && globalSetting.auto_print_receipt !== false) {
      const job = await queuePrintJob({
        type: 'refund',
        booking_ref,
        payment_id: payment.id,
        user: staffUser,
        device: deviceInfo,
        now: resolveBillingDate(payload)
      }, tx);
      if (job) print_jobs.push(job);
    }

    const { bill, status } = await refreshBillingCache(tx, booking_ref);
    return { payment, bill, status, print_jobs };
  });
}

/**
 * Void payment batch (spec 5.4 POST /payments/:id/void)
 */
export async function voidPayment(paymentId, reason, staffUser, deviceInfo) {
  const staffName = staffUser?.name || '門市人員';
  const staffId = staffUser?.id || null;

  if (!reason || !String(reason).trim()) {
    throw { status: 422, message: '作廢請填寫原因' };
  }

  return await prisma.$transaction(async (tx) => {
    const payment = await tx.payment.findUnique({
      where: { id: Number(paymentId) }
    });
    if (!payment) throw { status: 404, message: '找不到此筆收款' };
    if (payment.status === 'voided') throw { status: 400, message: '此收款已經作廢' };

    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${payment.booking_ref}))`;

    // Check connected active supplements or refunds
    const connected = await tx.payment.findFirst({
      where: {
        related_payment_id: payment.id,
        status: 'valid'
      }
    });
    if (connected) {
      throw { status: 409, message: '請先作廢這筆的補收或退款' };
    }

    // Void entire batch (scoped strictly to this booking_ref)
    const batchPayments = await tx.payment.findMany({
      where: {
        booking_ref: payment.booking_ref,
        batch_no: payment.batch_no,
        status: 'valid'
      }
    });

    // Cross-day / post-shift void lock check (Round 36 Item 2)
    const now = new Date();
    const shiftLockAt = await getShiftLock(tx, now);
    for (const bp of batchPayments) {
      if (!canVoidPayment(bp, { shiftLockAt, now })) {
        throw {
          status: 409,
          code: 'VOID_LOCKED',
          message: '這筆收款已跨日或已交班，請改用退款'
        };
      }
    }

    // Block voiding charge/supplement if any covered person still has an active cash-like refund (including legacy unlinked refunds)
    const nonRefundBatch = batchPayments.filter((bp) => bp.kind !== 'refund');
    if (nonRefundBatch.length > 0) {
      const activeCashRefunds = await tx.payment.findMany({
        where: {
          booking_ref: payment.booking_ref,
          status: 'valid',
          kind: 'refund',
          method: { not: 'pass' }
        }
      });
      const coveredPersons = new Set();
      for (const bp of nonRefundBatch) {
        if (Array.isArray(bp.person_nos)) {
          for (const pno of bp.person_nos) coveredPersons.add(Number(pno));
        }
      }
      for (const pno of coveredPersons) {
        const hasCashRefund = activeCashRefunds.some(
          (r) => Array.isArray(r.person_nos) && r.person_nos.includes(pno)
        );
        if (hasCashRefund) {
          throw { status: 409, message: `第 ${pno} 位有退款紀錄，請先作廢退款` };
        }
      }
    }

    const nowVoidedAt = new Date();
    for (const bp of batchPayments) {
      await tx.payment.update({
        where: { id: bp.id },
        data: {
          status: 'voided',
          voided_at: nowVoidedAt,
          voided_by_name: staffName,
          void_reason: String(reason).trim()
        }
      });

      // Restore pass if this payment used pass
      if (bp.method === 'pass' && bp.pass_json && Array.isArray(bp.pass_json)) {
        for (const pj of bp.pass_json) {
          if (pj.user_pass_id) {
            await restorePass(tx, {
              user_pass_id: pj.user_pass_id,
              units: pj.units || 1,
              booking_ref: bp.booking_ref,
              payment_no: bp.payment_no,
              person_no: pj.person_no,
              staff_name: staffName
            });
            await auditLog(tx, {
              booking_ref: bp.booking_ref,
              event_type: 'pass_restored',
              category: 'pass',
              summary: `卡券退回 · ${pj.plan_name || '卡券'} · ${pj.units || 1} 單位`,
              payment_id: bp.id,
              staff_name: staffName,
              staff_id: staffId,
              device_id: deviceInfo?.device_id,
              device_label: deviceInfo?.device_label
            });
          }
        }
      }

      await auditLog(tx, {
        booking_ref: bp.booking_ref,
        event_type: 'payment_voided',
        category: 'void',
        summary: `作廢 ${bp.payment_no} · ${bp.method === 'cash' ? '現金' : bp.method} NT$${bp.amount}。原因「${reason}」`,
        amount: bp.amount,
        payment_id: bp.id,
        reason,
        staff_name: staffName,
        staff_id: staffId,
        device_id: deviceInfo?.device_id,
        device_label: deviceInfo?.device_label
      });
    }

    // Release POS promo redemptions when all valid payments are voided (online/self redemptions stay active until reservation cancel)
    const remainingValid = await tx.payment.count({
      where: { booking_ref: payment.booking_ref, status: 'valid' }
    });
    if (remainingValid === 0) {
      await releasePromo(tx, {
        booking_ref: payment.booking_ref,
        reason: 'payment_voided',
        channels: ['pos']
      });
    }

    const { bill, status } = await refreshBillingCache(tx, payment.booking_ref);
    return { voided_count: batchPayments.length, bill, status };
  });
}

/**
 * Mark booking unpaid by voiding all valid payments (spec 5.4 POST /mark-unpaid)
 */
export async function markUnpaid(booking_ref, reason, staffUser, deviceInfo) {
  const staffName = staffUser?.name || '門市人員';
  const staffId = staffUser?.id || null;

  if (!reason || !String(reason).trim()) {
    throw { status: 422, message: '標記未結帳請填寫原因' };
  }

  return await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${booking_ref}))`;

    const activeRefund = await tx.payment.findFirst({
      where: { booking_ref, status: 'valid', kind: 'refund' }
    });
    if (activeRefund) {
      throw { status: 409, message: '已有退款紀錄，請先處理退款' };
    }

    const validPayments = await tx.payment.findMany({
      where: { booking_ref, status: 'valid' }
    });

    // Cross-day / post-shift void lock check (Round 36 Item 2)
    const now = new Date();
    const shiftLockAt = await getShiftLock(tx, now);
    for (const p of validPayments) {
      if (!canVoidPayment(p, { shiftLockAt, now })) {
        throw {
          status: 409,
          code: 'VOID_LOCKED',
          message: '這筆收款已跨日或已交班，請改用退款'
        };
      }
    }

    let voidedTotal = 0;

    for (const p of validPayments) {
      voidedTotal += p.amount;
      await tx.payment.update({
        where: { id: p.id },
        data: {
          status: 'voided',
          voided_at: now,
          voided_by_name: staffName,
          void_reason: String(reason).trim()
        }
      });

      if (p.method === 'pass' && p.pass_json && Array.isArray(p.pass_json)) {
        for (const pj of p.pass_json) {
          if (pj.user_pass_id) {
            await restorePass(tx, {
              user_pass_id: pj.user_pass_id,
              units: pj.units || 1,
              booking_ref,
              payment_no: p.payment_no,
              person_no: pj.person_no,
              staff_name: staffName
            });
            await auditLog(tx, {
              booking_ref,
              event_type: 'pass_restored',
              category: 'pass',
              summary: `卡券退回 · ${pj.plan_name || '卡券'} · ${pj.units || 1} 單位`,
              payment_id: p.id,
              staff_name: staffName,
              staff_id: staffId,
              device_id: deviceInfo?.device_id,
              device_label: deviceInfo?.device_label
            });
          }
        }
      }
    }

    // Release POS promo redemptions on full mark unpaid (online/self redemptions remain until reservation cancel)
    await releasePromo(tx, {
      booking_ref,
      reason: 'marked_unpaid',
      channels: ['pos']
    });

    await auditLog(tx, {
      booking_ref,
      event_type: 'marked_unpaid',
      category: 'void',
      summary: `標記未結帳：作廢共 NT$${voidedTotal}。原因「${reason}」`,
      amount: voidedTotal,
      reason,
      staff_name: staffName,
      staff_id: staffId,
      device_id: deviceInfo?.device_id,
      device_label: deviceInfo?.device_label
    });

    const { bill, status } = await refreshBillingCache(tx, booking_ref);
    return { voided_count: validPayments.length, bill, status };
  });
}

/**
 * Waive payment for one or more persons (spec 5.4 POST /waive)
 */
export async function waivePayment(booking_ref, payload, staffUser, deviceInfo) {
  const staffName = staffUser?.name || '門市人員';
  const staffId = staffUser?.id || null;
  const { person_nos = [], reason } = payload;

  if (!reason || !String(reason).trim()) {
    throw { status: 422, message: '免收請填寫原因' };
  }

  return await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${booking_ref}))`;

    const billData = await getBookingBill(booking_ref, tx);
    const { bill, pricing } = billData;
    const targetPersonNos = person_nos.map(Number);
    if (!targetPersonNos.length) {
      throw { status: 400, message: '請選擇免收人數' };
    }

    // Verify each person: exists, not removed, not already paid (Section 3.5)
    for (const pno of targetPersonNos) {
      const pObj = billData.persons?.find(p => p.person_no === pno);
      if (!pObj) {
        throw { status: 409, message: `第 ${pno} 位不存在` };
      }
      if (pObj.status === 'removed') {
        throw { status: 409, message: `第 ${pno} 位已移除，無法免收` };
      }
      const computedP = bill.persons.find(p => p.person_no === pno);
      if (computedP?.is_paid) {
        throw { status: 409, message: `第 ${pno} 位已經付過款` };
      }
    }

    // Direct Payment check in transaction
    const priorValidPayments = await tx.payment.findMany({
      where: { booking_ref, status: 'valid' }
    });
    for (const p of priorValidPayments) {
      if ((p.kind === 'charge' || p.kind === 'waive') && Array.isArray(p.person_nos)) {
        for (const pno of targetPersonNos) {
          if (p.person_nos.includes(pno)) {
            throw { status: 409, message: `第 ${pno} 位已經付過款` };
          }
        }
      }
    }

    const targetPersons = bill.persons.filter(p => targetPersonNos.includes(p.person_no));
    const waiveAmount = targetPersons.reduce((sum, p) => sum + (p.total || 0), 0);
    const payNo = await nextSerialNo(tx, 'payment', resolveBillingDate(payload));
    const batchNo = `B-${Date.now()}-${Math.floor(Math.random() * 1000)}`;

    const payment = await tx.payment.create({
      data: {
        payment_no: payNo,
        batch_no: batchNo,
        booking_ref,
        kind: 'waive',
        status: 'valid',
        method: 'none',
        amount: 0,
        waived_amount: waiveAmount,
        person_nos: targetPersonNos,
        breakdown_json: {
          persons: targetPersons,
          pricing,
          snapshot_at: new Date().toISOString()
        },
        reason: String(reason).trim(),
        staff_name: staffName,
        staff_id: staffId,
        device_id: deviceInfo?.device_id,
        device_label: deviceInfo?.device_label || '櫃檯'
      }
    });

    await auditLog(tx, {
      booking_ref,
      event_type: 'waived',
      category: 'status',
      summary: `免收 第 ${targetPersonNos.join('～')} 位 NT$${waiveAmount}。原因「${reason}」`,
      amount: waiveAmount,
      payment_id: payment.id,
      reason,
      staff_name: staffName,
      staff_id: staffId,
      device_id: deviceInfo?.device_id,
      device_label: deviceInfo?.device_label
    });

    const { bill: finalBill, status: finalStatus } = await refreshBillingCache(tx, booking_ref);
    return { payment, bill: finalBill, status: finalStatus };
  });
}

export default {
  getNextDailySeq,
  getBookingBill,
  saveDraft,
  refreshBillingCache,
  collectPayment,
  supplementPayment,
  refundPayment,
  voidPayment,
  markUnpaid,
  waivePayment
};
