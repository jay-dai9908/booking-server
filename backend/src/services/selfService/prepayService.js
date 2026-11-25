import prisma from '../../prismaClient.js';
import { computeBill, computeEntry } from '../../../../shared/billing.js';
import { toTaipeiDateString } from '../../../../shared/time.js';
import {
  prepayDeadline,
  earliestEntry,
  ironText,
  selfEquipmentTerms
} from '../../../../shared/selfService.js';
import { validatePassUsage, restorePass } from '../billing/passTender.js';
import { buildBillInput } from '../billing/billInput.js';
import {
  getBookingBill,
  nextSerialNo,
  refreshBillingCache,
  buildInitialDraft
} from '../billing/billService.js';
import { log as auditLog } from '../audit/auditService.js';
import { releasePromo } from '../promo/redemption.js';
import { calculateEquipmentChargeableHours } from '../../utils/equipmentPricing.js';
import { resolveEquipmentWindow } from '../../utils/equipmentWindow.js';
import { evaluatePromoCode } from '../../controllers/checkoutController.js';
import { releasePoolAccount } from './poolAccountService.js';
import { sendSelfServiceExpiredNotification } from '../../utils/lineMessaging.js';
import { bookableSessionWhere } from '../calendar/sessionFilters.js';

export function makePrepayError(code, message, status = 400, extra = {}) {
  const err = new Error(message);
  err.isPrepayError = true;
  err.code = code;
  err.status = status;
  Object.assign(err, extra);
  return err;
}

export async function ensureKioskSetting(txOrPrisma = prisma) {
  let setting = await txOrPrisma.kioskSetting.findUnique({ where: { id: 1 } });
  if (!setting) {
    setting = await txOrPrisma.kioskSetting.upsert({
      where: { id: 1 },
      update: {},
      create: {
        id: 1,
        early_minutes: 30,
        after_close_minutes: 60,
        prepay_deadline_hour: 12,
        max_unpaid_self_bookings: 2
      }
    });
  }
  return setting;
}

export function buildSelfServiceMeta({
  dailySetting,
  kioskSetting,
  targetDateStr,
  now = new Date()
}) {
  const isSelfService = Boolean(dailySetting?.is_self_service);
  const earlyMinutes = kioskSetting?.early_minutes ?? 30;
  const deadlineHour = kioskSetting?.prepay_deadline_hour ?? 12;
  const maxUnpaid = kioskSetting?.max_unpaid_self_bookings ?? 2;
  const deadlineAt = prepayDeadline(targetDateStr, deadlineHour);
  const transferOpen = !isNaN(deadlineAt.getTime()) && now <= deadlineAt;

  return {
    is_self_service: isSelfService,
    allow_hourly: Boolean(dailySetting?.self_allow_hourly),
    allow_equipment: Boolean(dailySetting?.self_allow_equipment),
    early_minutes: earlyMinutes,
    deadline_hour: deadlineHour,
    deadline_at: deadlineAt,
    transfer_open: transferOpen,
    iron_text: isSelfService
      ? ironText({
          iron_mode: dailySetting?.iron_mode,
          iron_date: dailySetting?.iron_date,
          date: targetDateStr
        })
      : '',
    max_unpaid: maxUnpaid
  };
}

export function isEligibleSelfServicePass(userPass) {
  if (!userPass) return false;
  if (userPass.pass_type !== 'PUNCH_CARD') return false;
  const effect = userPass.plan?.checkout_effect;
  return !effect || effect === 'entry_full';
}

export function computeUsableUnitsOnDate(userPass, targetDate) {
  if (!isEligibleSelfServicePass(userPass)) {
    return { usable_units: 0, reason: '僅限計次不限時卡可使用' };
  }
  const firstCheck = validatePassUsage(userPass, { date: targetDate, units: 1 });
  if (!firstCheck.usable) {
    return { usable_units: 0, reason: firstCheck.reason };
  }
  const maxCap = userPass.remaining_quota != null ? Math.min(userPass.remaining_quota, 20) : 20;
  let usableUnits = 0;
  for (let u = 1; u <= maxCap; u++) {
    const check = validatePassUsage(userPass, { date: targetDate, units: u });
    if (check.usable) {
      usableUnits = u;
    } else {
      break;
    }
  }
  return { usable_units: usableUnits, reason: null };
}

export async function getPrepayOptions(txOrPrisma = prisma, { userId, dateStr, pax = 1 }) {
  const client = txOrPrisma || prisma;
  const ymd = toTaipeiDateString(dateStr);
  const dateObj = new Date(`${ymd}T00:00:00.000Z`);
  const targetDateForPass = new Date(`${ymd}T00:00:00+08:00`);

  const [kioskSetting, dailySetting, methods, ctbcPoolAvailableCount, rawPasses, unpaidCount] =
    await Promise.all([
      ensureKioskSetting(client),
      client.dailySetting.findUnique({ where: { date: dateObj } }),
      client.paymentMethodConfig.findMany({
        where: {
          is_enabled: true,
          method_type: { not: 'ONSITE' }
        },
        orderBy: [{ sort_order: 'asc' }, { id: 'asc' }]
      }),
      client.oneTimeAccountPool.count({
        where: { payment_method_code: 'ctbc_pool', status: 'AVAILABLE' }
      }),
      client.userPass.findMany({
        where: {
          user_id: Number(userId),
          pass_type: 'PUNCH_CARD'
        },
        include: { plan: true },
        orderBy: [{ expires_at: 'asc' }, { id: 'asc' }]
      }),
      client.bookingPrepay.count({
        where: {
          user_id: Number(userId),
          status: 'pending_payment'
        }
      })
    ]);

  const meta = buildSelfServiceMeta({
    dailySetting,
    kioskSetting,
    targetDateStr: ymd
  });

  const transferMethods = methods.map((m) => ({
    ...m,
    pool_available: m.code === 'ctbc_pool' ? ctbcPoolAvailableCount : undefined
  }));

  const passes = rawPasses
    .filter(isEligibleSelfServicePass)
    .map((p) => {
      const { usable_units, reason } = computeUsableUnitsOnDate(p, targetDateForPass);
      const maxAllowed = Math.min(usable_units, Math.max(1, Number(pax) || 1));
      return {
        user_pass_id: p.id,
        name: p.plan_name_snapshot || p.plan?.name || '計次不限時卡',
        remaining: p.remaining_quota ?? 0,
        remaining_uses: p.remaining_quota ?? 0,
        usable_units: maxAllowed,
        max_date_units: usable_units,
        reason
      };
    });

  return {
    date: ymd,
    is_self_service: meta.is_self_service,
    allow_hourly: meta.allow_hourly,
    allow_equipment: meta.allow_equipment,
    early_minutes: meta.early_minutes,
    deadline_hour: meta.deadline_hour,
    deadline_at: meta.deadline_at,
    transfer_open: meta.transfer_open,
    iron_text: meta.iron_text,
    transfer_methods: transferMethods,
    ctbc_pool_available_count: ctbcPoolAvailableCount,
    passes,
    max_unpaid: meta.max_unpaid,
    unpaid_count: unpaidCount
  };
}

function normalizePassUses(rawPassUses = []) {
  if (!Array.isArray(rawPassUses)) return [];
  const merged = new Map();
  for (const item of rawPassUses) {
    if (!item) continue;
    const passId = parseInt(item.user_pass_id, 10);
    const units = parseInt(item.persons ?? item.units, 10) || 0;
    if (!Number.isInteger(passId) || passId <= 0 || units <= 0) continue;
    merged.set(passId, (merged.get(passId) || 0) + units);
  }
  return Array.from(merged.entries()).map(([user_pass_id, units]) => ({ user_pass_id, units }));
}

export function buildSelfCheckoutDraft({ pax, isUnlimited, promoEval, unpaidCount }) {
  const unpaidNos = Array.from({ length: Math.max(0, unpaidCount) }, (_, i) => i + 1);
  return buildInitialDraft({
    pax,
    isUnlimited,
    promoRule: promoEval?.rule || null,
    promoPersonNos: promoEval?.rule ? unpaidNos : null
  });
}

/**
 * 計算半自助日預約試算結果（用於 prepay-quote 與 createReservation）
 * strict = true 時遇檢核失敗即拋出錯誤；strict = false 時收集 errors 陣列
 */
export async function computeSelfServiceQuote(
  txOrPrisma,
  {
    userId,
    requestedSessions,
    dailySetting,
    dailyRates,
    kioskSetting,
    pax,
    isUnlimited,
    equipments = [],
    promoCode = null,
    passUses = [],
    strict = false,
    skipUsageCheck = false,
    now = new Date()
  }
) {
  const client = txOrPrisma || prisma;
  const errors = [];
  const pushOrThrow = (code, message, status = 400) => {
    if (strict) {
      throw makePrepayError(code, message, status);
    }
    errors.push({ code, message, status });
  };

  const sortedSessions = [...requestedSessions].sort((a, b) =>
    a.start_time.localeCompare(b.start_time)
  );
  if (sortedSessions.some((s) => Boolean(s.closed_at))) {
    pushOrThrow('SESSION_CLOSED', '這個時段已關閉', 409);
  }
  const sessionDate = sortedSessions[0].session_date;
  const dateStr = toTaipeiDateString(sessionDate);
  const targetDateForPass = new Date(`${dateStr}T00:00:00+08:00`);

  const meta = buildSelfServiceMeta({
    dailySetting,
    kioskSetting,
    targetDateStr: dateStr,
    now
  });

  if (!meta.allow_hourly && !isUnlimited) {
    pushOrThrow('SELF_HOURLY_NOT_OPEN', '半自助日目前僅開放當日不限時暢玩', 400);
  }

  // 1. Validate pass selections
  const normalizedPassUses = normalizePassUses(passUses);
  const totalPassUnits = normalizedPassUses.reduce((s, item) => s + item.units, 0);

  if (totalPassUnits > pax) {
    pushOrThrow('PASS_NOT_USABLE', '使用計次卡的人數不可超過總預約人數', 422);
  }

  const validatedPasses = [];
  if (normalizedPassUses.length > 0) {
    const passIds = normalizedPassUses.map((x) => x.user_pass_id);
    const dbPasses = await client.userPass.findMany({
      where: { id: { in: passIds } },
      include: { plan: true }
    });
    const dbPassMap = new Map(dbPasses.map((p) => [p.id, p]));

    for (const item of normalizedPassUses) {
      const userPass = dbPassMap.get(item.user_pass_id);
      if (!userPass || userPass.user_id !== Number(userId)) {
        pushOrThrow('PASS_NOT_USABLE', '找不到可用的會員卡券', 422);
        continue;
      }
      if (!isEligibleSelfServicePass(userPass)) {
        pushOrThrow('PASS_NOT_USABLE', '僅限使用計次不限時卡折抵入場費', 422);
        continue;
      }
      const check = validatePassUsage(userPass, {
        date: targetDateForPass,
        units: item.units
      });
      if (!check.usable) {
        pushOrThrow('PASS_NOT_USABLE', check.reason || '此卡券目前無法於這天使用', 422);
        continue;
      }
      if (userPass.remaining_quota !== null && userPass.remaining_quota < item.units) {
        pushOrThrow(
          'PASS_NOT_USABLE',
          `「${userPass.plan_name_snapshot || '計次卡'}」剩餘 ${userPass.remaining_quota} 次，不足扣抵 ${item.units} 次`,
          422
        );
        continue;
      }
      validatedPasses.push({
        userPass,
        user_pass_id: userPass.id,
        pass_code: userPass.pass_code,
        plan_name: userPass.plan_name_snapshot || userPass.plan?.name || '計次不限時卡',
        units: item.units
      });
    }
  }

  // 2. Equipments validation & self-service pricing
  const globalSetting = await client.globalSetting.findUnique({ where: { id: 1 } });
  const requestedEqList = Array.isArray(equipments)
    ? equipments.filter((e) => (parseInt(e?.quantity, 10) || 0) > 0)
    : [];

  let boardAmount = 0;
  const equipmentRecordsSpec = [];

  if (requestedEqList.length > 0) {
    if (!meta.allow_equipment) {
      pushOrThrow('SELF_EQUIPMENT_NOT_OPEN', '這天半自助時段不開放租借智能拼豆板', 400);
    } else {
      const allConfigs = await client.equipmentConfig.findMany();
      const configMap = new Map(allConfigs.map((c) => [c.id, c]));
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

      if (!allowExceedPax) {
        for (const session of sortedSessions) {
          let concurrentBoards = 0;
          for (const eq of requestedEqList) {
            if (eq.equipment_id === 'bring_own') continue;
            const qty = parseInt(eq.quantity, 10) || 0;
            const config = configMap.get(eq.equipment_id);
            const minHours = config?.min_contiguous_hours || 2;
            const { windowSessions } = resolveEquipmentWindow(sortedSessions, eq, minHours);
            if (windowSessions.some((ws) => ws.id === session.id)) {
              concurrentBoards += qty;
            }
          }
          if (concurrentBoards > pax) {
            pushOrThrow('EQUIPMENT_EXCEED_PAX', '預約之智能拼豆板總數不得超過同行人數上限。', 400);
            break;
          }
        }
      }

      const dateReservations = await client.reservation.findMany({
        where: {
          session: { session_date: sessionDate },
          status: 'confirmed'
        },
        include: { session: true }
      });
      const activeBookingRefs = Array.from(new Set(dateReservations.map((r) => r.booking_ref)));
      const bookedEquipments = activeBookingRefs.length
        ? await client.bookingEquipment.findMany({
            where: { booking_ref: { in: activeBookingRefs } }
          })
        : [];

      const requestUsage = {};

      for (const eq of requestedEqList) {
        const qty = parseInt(eq.quantity, 10) || 0;
        if (qty <= 0) continue;
        const config = configMap.get(eq.equipment_id);
        if (!config) {
          pushOrThrow('SELF_EQUIPMENT_NOT_OPEN', `找不到智能板設定 ${eq.equipment_id}`, 400);
          continue;
        }
        if (eq.equipment_id !== 'bring_own') {
          if (config.visibility_status !== 'ACTIVE' || !config.self_enabled) {
            pushOrThrow(
              'SELF_EQUIPMENT_NOT_OPEN',
              `「${config.name}」目前未開放半自助日租借`,
              400
            );
            continue;
          }
        }

        const terms = selfEquipmentTerms(config);
        const minHours = config.min_contiguous_hours || 2;
        const { rentalHours, windowSessions, coveredSessions } = resolveEquipmentWindow(
          sortedSessions,
          eq,
          minHours
        );

        if (eq.equipment_id !== 'bring_own') {
          const maxStock = terms.stock ?? 0;
          for (const sess of windowSessions) {
            const sessTimeStr = `${sess.start_time}-${sess.end_time}`;
            const usageKey = `${eq.equipment_id}|${sess.start_time}`;
            let bookedInThisSession = 0;
            for (const be of bookedEquipments) {
              if (be.equipment_id !== eq.equipment_id) continue;
              let isCovered = false;
              if (Array.isArray(be.covered_sessions) && be.covered_sessions.length > 0) {
                isCovered = be.covered_sessions.some(
                  (cs) =>
                    cs === sess.start_time ||
                    cs === sessTimeStr ||
                    cs.startsWith(sess.start_time)
                );
              } else {
                const bRes = dateReservations.filter((r) => r.booking_ref === be.booking_ref);
                isCovered = bRes.some((r) => r.session?.start_time === sess.start_time);
              }
              if (isCovered) {
                bookedInThisSession += be.quantity;
              }
            }

            if (bookedInThisSession + (requestUsage[usageKey] || 0) + qty > maxStock) {
              const remain = Math.max(0, maxStock - bookedInThisSession - (requestUsage[usageKey] || 0));
              pushOrThrow(
                'EQUIPMENT_OUT_OF_STOCK',
                `智能拼豆板「${config.name}」在 ${sess.start_time} 時段庫存不足（僅剩 ${remain} 台）`,
                409
              );
              break;
            }
          }
          for (const sess of windowSessions) {
            const usageKey = `${eq.equipment_id}|${sess.start_time}`;
            requestUsage[usageKey] = (requestUsage[usageKey] || 0) + qty;
          }
        }

        const chargeableHours = calculateEquipmentChargeableHours(rentalHours, discountConfig);
        const singlePrice =
          terms.daily_cap != null && terms.daily_cap > 0
            ? Math.min(terms.hourly_rate * chargeableHours, terms.daily_cap)
            : terms.hourly_rate * chargeableHours;
        const subtotal = singlePrice * qty;
        boardAmount += subtotal;

        equipmentRecordsSpec.push({
          equipment_id: eq.equipment_id,
          equipment_name_snapshot: config.name,
          quantity: qty,
          rental_hours: rentalHours,
          unit_rate: terms.hourly_rate,
          daily_cap_snapshot: terms.daily_cap ?? null,
          subtotal_price: subtotal,
          covered_sessions: coveredSessions,
          equipment: config
        });
      }
    }
  }

  // 3. Determine person splits: unpaid first, pass holders last
  const clampedPassUnits = Math.min(totalPassUnits, pax);
  const unpaidCount = Math.max(0, pax - clampedPassUnits);

  const pricing = {
    hourly: dailyRates.hourly_price,
    hourly_price: dailyRates.hourly_price,
    unlimited: dailyRates.unlimited_price,
    unlimited_price: dailyRates.unlimited_price,
    allow_unlimited: dailyRates.allow_unlimited,
    is_weekend: dailyRates.is_weekend
  };
  const billingRules = {
    grace: globalSetting?.billing_grace_minutes ?? 10,
    block: globalSetting?.billing_block_minutes ?? 30,
    early_leave_mode: globalSetting?.early_leave_mode || 'booked',
    default_split_mode: globalSetting?.default_split_mode || 'proportional'
  };

  const firstStart = sortedSessions[0].start_time;
  const lastEnd = sortedSessions[sortedSessions.length - 1].end_time;
  const startDt = new Date(`${dateStr}T${firstStart}:00+08:00`);
  const endDt = new Date(`${dateStr}T${lastEnd}:00+08:00`);
  const bookedMinutes = Math.max(0, Math.floor((endDt.getTime() - startDt.getTime()) / 60000));

  const perPersonEntry = computeEntry({
    bookedMinutes,
    actualMinutes: null,
    pausedMinutes: 0,
    mode: isUnlimited ? 'unlimited' : 'hourly',
    hoursOverride: null,
    pricing: {
      hourly: dailyRates.hourly_price,
      unlimited: dailyRates.unlimited_price,
      allow_unlimited: dailyRates.allow_unlimited
    },
    rules: billingRules
  });
  const unpaidEntryAmount = unpaidCount * perPersonEntry.amount;

  // 4. Promo code evaluation (only on unpaid persons + boards)
  let promoEval = null;
  if (promoCode && String(promoCode).trim()) {
    if (unpaidCount <= 0) {
      pushOrThrow('PROMO_WITH_PASS', '全部人都使用計次不限時卡時，不能使用優惠碼', 400);
    } else {
      promoEval = await evaluatePromoCode(client, {
        code: promoCode,
        session_date: sessionDate,
        pax: unpaidCount,
        hours: sortedSessions.length,
        is_unlimited: isUnlimited || perPersonEntry.mode === 'unlimited',
        base_amount: unpaidEntryAmount + boardAmount,
        hourly_price: dailyRates.hourly_price,
        user_id: userId,
        skip_usage_check: skipUsageCheck,
        seating_amount: unpaidEntryAmount,
        equipment_amount: boardAmount
      });
      if (!promoEval.valid) {
        pushOrThrow('PROMO_ERROR', promoEval.error || '優惠碼無效或不符合條件', 400);
        promoEval = null;
      }
    }
  }

  // 5. Authoritative calculation via computeBill(buildBillInput(...))
  const draft = buildSelfCheckoutDraft({
    pax,
    isUnlimited,
    promoEval,
    unpaidCount
  });

  const virtualReservations = sortedSessions.map((s) => ({
    booking_ref: 'QUOTE_PREVIEW',
    pax,
    assigned_seats: [],
    checkout_details: draft,
    session: s,
    session_date: sessionDate,
    is_walk_in: false
  }));

  const virtualEquipments = equipmentRecordsSpec.map((eq, idx) => ({
    id: idx + 1,
    unit_group: `quote-eq-${idx + 1}`,
    segment_no: 1,
    equipment_id: eq.equipment_id,
    equipment_name_snapshot: eq.equipment_name_snapshot,
    quantity: eq.quantity,
    rental_hours: eq.rental_hours,
    unit_rate: eq.unit_rate,
    daily_cap_snapshot: eq.daily_cap_snapshot ?? null,
    subtotal_price: eq.subtotal_price,
    covered_sessions: eq.covered_sessions,
    person_id: null,
    equipment: eq.equipment
  }));

  const billInput = buildBillInput({
    bookingRef: 'QUOTE_PREVIEW',
    reservations: virtualReservations,
    bookingPersons: [],
    bookingEquipments: virtualEquipments,
    boardPauses: [],
    payments: [],
    globalSetting: globalSetting || {},
    pricing,
    now,
    draft
  });

  const bill = computeBill(billInput);

  // Map pass assignments onto trailing person_nos (unpaidCount + 1 .. pax)
  const passAssignByPersonNo = new Map();
  let nextPassPersonNo = unpaidCount + 1;
  const passHoldsPlan = [];
  for (const vp of validatedPasses) {
    const personNosForPass = [];
    for (let u = 0; u < vp.units && nextPassPersonNo <= pax; u++) {
      passAssignByPersonNo.set(nextPassPersonNo, {
        user_pass_id: vp.user_pass_id,
        pass_code: vp.pass_code,
        plan_name: vp.plan_name
      });
      personNosForPass.push(nextPassPersonNo);
      nextPassPersonNo++;
    }
    if (personNosForPass.length > 0) {
      passHoldsPlan.push({
        user_pass_id: vp.user_pass_id,
        pass_code: vp.pass_code,
        plan_name: vp.plan_name,
        units: personNosForPass.length,
        person_nos: personNosForPass
      });
    }
  }

  let passTotalCover = 0;
  const quotePersons = bill.persons.map((p) => {
    const usesPass = p.person_no > unpaidCount && passAssignByPersonNo.has(p.person_no);
    const entryAmt = p.entry?.amount || 0;
    if (usesPass) {
      passTotalCover += entryAmt;
    }
    return {
      person_no: p.person_no,
      entry_amount: entryAmt,
      board_amount: p.board?.amount || 0,
      total: p.total,
      uses_pass: usesPass
    };
  });

  const totalAmount = bill.summary?.amount_due ?? 0;
  const promoDiscount = bill.summary?.discounts_total ?? 0;
  const finalBoardAmount = bill.summary?.board_total ?? 0;
  const transferAmount = Math.max(0, totalAmount - passTotalCover);

  if (promoEval && Math.abs((promoEval.discount_amount || 0) - promoDiscount) > 0) {
    throw makePrepayError('PROMO_MISMATCH', '優惠碼試算與帳單折抵不一致', 500);
  }

  const appliedPersonNos = promoEval
    ? Array.from({ length: unpaidCount }, (_, i) => i + 1)
    : [];

  return {
    total_amount: totalAmount,
    persons: quotePersons,
    pass_persons: passTotalCover > 0 ? passAssignByPersonNo.size : 0,
    unpaid_entry_persons: unpaidCount,
    entry_amount: unpaidCount > 0
      ? quotePersons
          .filter((p) => !p.uses_pass)
          .reduce((s, p) => s + p.entry_amount, 0)
      : 0,
    board_amount: finalBoardAmount,
    promo: promoEval
      ? {
          code: promoEval.promo.code,
          discount: promoDiscount,
          applies_to_persons: appliedPersonNos,
          promo_row: promoEval.promo
        }
      : null,
    pass_units: totalPassUnits,
    pass_holds_plan: passHoldsPlan,
    transfer_amount: transferAmount,
    transfer_open: meta.transfer_open,
    deadline_at: meta.deadline_at,
    draft,
    equipmentRecordsSpec,
    errors
  };
}

/**
 * 取得同一筆 booking_ref 的交易層級互斥鎖（PostgreSQL advisory xact lock），並回傳最新的 BookingPrepay 紀錄
 */
export async function lockPrepay(tx, booking_ref) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${booking_ref}))`;
  return tx.bookingPrepay.findUnique({ where: { booking_ref } });
}

/**
 * 預約建立/對帳確認後內部一次性入帳（不使用 collectPayment，避免二次扣卡或重複累加優惠碼）
 */
export async function settleSelfServiceBooking(
  tx,
  {
    booking_ref,
    staffName = '系統',
    staffId = null,
    deviceInfo = null,
    note = null
  }
) {
  const prepay = await lockPrepay(tx, booking_ref);
  if (!prepay) {
    throw makePrepayError('PREPAY_NOT_FOUND', '找不到此筆預約的預付紀錄', 404);
  }
  if (prepay.status === 'verified' && prepay.settled_at) {
    const existingRes = await tx.reservation.findFirst({ where: { booking_ref } });
    return { alreadySettled: true, prepay, billing_status: existingRes?.billing_status || 'paid' };
  }

  const billData = await getBookingBill(booking_ref, tx);
  const { bill } = billData;
  const pricing = billData.pricing;
  const now = new Date();
  const batchNo = await nextSerialNo(tx, 'payment', now);

  const passHolds = Array.isArray(prepay.pass_holds) ? prepay.pass_holds : [];
  const personPassMap = new Map();
  let nextFallbackPassPersonNo = Math.max(1, (bill.persons?.length || 1) - (prepay.pass_persons || 0) + 1);

  for (const hold of passHolds) {
    const pNos = Array.isArray(hold.person_nos) && hold.person_nos.length > 0
      ? hold.person_nos
      : Array.from({ length: hold.units || 0 }, () => nextFallbackPassPersonNo++);
    for (const pNo of pNos) {
      personPassMap.set(Number(pNo), {
        user_pass_id: hold.user_pass_id,
        pass_code: hold.pass_code || '',
        plan_name: hold.plan_name || '計次不限時卡'
      });
    }
  }

  let totalPassDiscount = 0;
  const passCoverByPerson = new Map();
  const createdPayments = [];

  for (const pBill of bill.persons || []) {
    const holdInfo = personPassMap.get(Number(pBill.person_no));
    if (!holdInfo) continue;

    const entryAmt = Math.min(pBill.entry?.amount || 0, pBill.total || pBill.entry?.amount || 0);
    if (entryAmt <= 0) continue;

    const passPayNo = await nextSerialNo(tx, 'payment', now);
    const passPay = await tx.payment.create({
      data: {
        payment_no: passPayNo,
        batch_no: batchNo,
        booking_ref,
        kind: 'charge',
        status: 'valid',
        method: 'pass',
        amount: entryAmt,
        person_nos: [pBill.person_no],
        breakdown_json: {
          source: 'self_prepay',
          persons: [{ ...pBill, amount: entryAmt }],
          pricing,
          snapshot_at: now.toISOString()
        },
        pass_json: [
          {
            user_pass_id: holdInfo.user_pass_id,
            pass_code: holdInfo.pass_code,
            plan_name: holdInfo.plan_name,
            units: 1,
            unit_label: '次',
            value: entryAmt,
            person_no: pBill.person_no
          }
        ],
        note: '半自助預約預付計次卡折抵',
        staff_name: staffName,
        staff_id: staffId,
        device_id: deviceInfo?.device_id || null,
        device_label: deviceInfo?.device_label || '系統'
      }
    });

    createdPayments.push(passPay);
    totalPassDiscount += entryAmt;
    passCoverByPerson.set(Number(pBill.person_no), entryAmt);

    await auditLog(tx, {
      booking_ref,
      event_type: 'pass_redeemed',
      category: 'pass',
      summary: `半自助預付卡券折抵 第 ${pBill.person_no} 位 · ${holdInfo.plan_name} · NT$${entryAmt}`,
      amount: entryAmt,
      payment_id: passPay.id,
      staff_name: staffName,
      staff_id: staffId,
      device_id: deviceInfo?.device_id || null,
      device_label: deviceInfo?.device_label || '系統'
    });
  }

  const totalDue = bill.summary?.amount_due ?? 0;
  const remainderAmount = Math.max(0, totalDue - totalPassDiscount);

  if (remainderAmount > 0) {
    const unpaidPersonBills = [];
    for (const pBill of bill.persons || []) {
      const covered = passCoverByPerson.get(Number(pBill.person_no)) || 0;
      const owed = Math.max(0, (pBill.total || 0) - covered);
      if (owed > 0) {
        unpaidPersonBills.push({ ...pBill, amount: owed });
      }
    }
    const targetPersonNos = unpaidPersonBills.length > 0
      ? unpaidPersonBills.map((p) => p.person_no)
      : (bill.persons || []).map((p) => p.person_no);

    const transferPayNo = await nextSerialNo(tx, 'payment', now);
    const transferPay = await tx.payment.create({
      data: {
        payment_no: transferPayNo,
        batch_no: batchNo,
        booking_ref,
        kind: 'charge',
        status: 'valid',
        method: 'transfer',
        amount: remainderAmount,
        person_nos: targetPersonNos,
        breakdown_json: {
          persons: unpaidPersonBills.length > 0 ? unpaidPersonBills : bill.persons,
          pricing,
          snapshot_at: now.toISOString()
        },
        note: note || '半自助預約匯款入帳',
        staff_name: staffName,
        staff_id: staffId,
        device_id: deviceInfo?.device_id || null,
        device_label: deviceInfo?.device_label || '系統'
      }
    });
    createdPayments.push(transferPay);

    await auditLog(tx, {
      booking_ref,
      event_type: 'payment_created',
      category: 'payment',
      summary: `半自助預付入帳 第 ${targetPersonNos.join('、')} 位 · transfer NT$${remainderAmount}`,
      amount: remainderAmount,
      payment_id: transferPay.id,
      staff_name: staffName,
      staff_id: staffId,
      device_id: deviceInfo?.device_id || null,
      device_label: deviceInfo?.device_label || '系統'
    });
  }

  const updatedPrepay = await tx.bookingPrepay.update({
    where: { booking_ref },
    data: {
      status: 'verified',
      settled_at: now,
      verified_at: now,
      verified_by_name: staffName
    }
  });

  const { status: finalStatus } = await refreshBillingCache(tx, booking_ref);

  return {
    alreadySettled: false,
    prepay: updatedPrepay,
    payments: createdPayments,
    billing_status: finalStatus?.code || 'paid'
  };
}

/**
 * 顧客回報匯款末五碼
 */
export async function submitRemittanceLast5(prismaClient, { bookingRef, userId, last5 }) {
  const cleanLast5 = String(last5 || '').trim();
  if (!/^\d{5}$/.test(cleanLast5)) {
    throw makePrepayError('INVALID_LAST5', '帳號末五碼必須為 5 位數字', 400);
  }

  const runInTx = typeof prismaClient.$transaction === 'function'
    ? (fn) => prismaClient.$transaction(fn)
    : (fn) => fn(prismaClient);

  return runInTx(async (tx) => {
    const prepay = await lockPrepay(tx, bookingRef);
    if (!prepay) {
      throw makePrepayError('PREPAY_NOT_FOUND', '找不到此筆預約的付款紀錄', 404);
    }
    if (prepay.user_id !== Number(userId)) {
      throw makePrepayError('FORBIDDEN', '無權限修改此筆預約的匯款資料', 403);
    }

    const allowedStatuses = ['pending_payment', 'reported_pending_verify', 'mismatch'];
    if (!allowedStatuses.includes(prepay.status)) {
      throw makePrepayError('INVALID_PREPAY_STATUS', '此筆預約目前的付款狀態不可填寫末五碼', 409);
    }

    const activeRes = await tx.reservation.findFirst({
      where: { booking_ref: bookingRef, status: 'confirmed' }
    });
    if (!activeRes) {
      throw makePrepayError('BOOKING_CANCELLED', '此預約已取消，無法回報匯款末五碼', 409);
    }

    const now = new Date();
    return tx.bookingPrepay.update({
      where: { booking_ref: bookingRef },
      data: {
        remittance_last5: cleanLast5,
        remittance_reported_at: now,
        status: 'reported_pending_verify'
      }
    });
  });
}

/**
 * 為已分組的顧客預約附上 is_self_service、prepay（不含 admin_note）、self_info
 */
export async function attachSelfInfoToReservations(groupedReservations = [], txOrPrisma = prisma) {
  if (!Array.isArray(groupedReservations) || groupedReservations.length === 0) {
    return groupedReservations;
  }

  const client = txOrPrisma || prisma;
  const refs = groupedReservations.map((g) => g.booking_ref).filter(Boolean);
  const dateStrs = [
    ...new Set(
      groupedReservations
        .map((g) => (g.session_date ? toTaipeiDateString(g.session_date) : ''))
        .filter(Boolean)
    )
  ];
  const dateObjs = dateStrs.map((d) => new Date(`${d}T00:00:00.000Z`));

  const [prepays, dailySettings, kioskSetting, allDaySessions] = await Promise.all([
    client.bookingPrepay.findMany({ where: { booking_ref: { in: refs } } }),
    dateObjs.length
      ? client.dailySetting.findMany({ where: { date: { in: dateObjs } } })
      : [],
    ensureKioskSetting(client),
    dateObjs.length
      ? client.session.findMany({
          where: { session_date: { in: dateObjs }, ...bookableSessionWhere() },
          select: { session_date: true, end_time: true }
        })
      : []
  ]);

  const prepayByRef = new Map(prepays.map((p) => [p.booking_ref, p]));
  const dailyByDate = new Map(
    dailySettings.map((d) => [toTaipeiDateString(d.date), d])
  );
  const maxEndByDate = new Map();
  for (const s of allDaySessions) {
    const dStr = toTaipeiDateString(s.session_date);
    const cur = maxEndByDate.get(dStr) || '';
    if (s.end_time && s.end_time > cur) {
      maxEndByDate.set(dStr, s.end_time);
    }
  }

  const earlyMinutes = kioskSetting?.early_minutes ?? 30;

  return groupedReservations.map((g) => {
    const prepay = prepayByRef.get(g.booking_ref) || null;
    const isSelf = Boolean(g.is_self_service || prepay);
    if (!isSelf) {
      return { ...g, is_self_service: false };
    }

    const dStr = g.session_date ? toTaipeiDateString(g.session_date) : '';
    const dailySetting = dailyByDate.get(dStr) || null;
    const openAt = earliestEntry(g.start_time, earlyMinutes);
    const until = maxEndByDate.get(dStr) || g.end_time || '';
    const iText = ironText({
      iron_mode: dailySetting?.iron_mode,
      iron_date: dailySetting?.iron_date,
      date: dStr
    });

    const sanitizedPrepay = prepay
      ? {
          id: prepay.id,
          booking_ref: prepay.booking_ref,
          total_amount: prepay.total_amount,
          pass_persons: prepay.pass_persons,
          pass_holds: prepay.pass_holds,
          amount_due: prepay.amount_due,
          status: prepay.status,
          deadline_at: prepay.deadline_at,
          payment_method_code: prepay.payment_method_code,
          selected_bank_info: prepay.selected_bank_info,
          assigned_pool_account: prepay.assigned_pool_account,
          assigned_pool_url: prepay.assigned_pool_url,
          remittance_last5: prepay.remittance_last5,
          remittance_reported_at: prepay.remittance_reported_at,
          agreed_terms_at: prepay.agreed_terms_at,
          settled_at: prepay.settled_at,
          verified_at: prepay.verified_at
        }
      : null;

    return {
      ...g,
      is_self_service: true,
      prepay: sanitizedPrepay,
      self_info: {
        open_at: openAt,
        earliest_entry: openAt,
        until,
        iron_text: iText,
        early_minutes: earlyMinutes
      }
    };
  });
}

/**
 * 逾期未付款半自助預約自動取消並釋放資源（僅處理 status = 'pending_payment'）
 */
export async function releaseExpiredPrepays(now = new Date()) {
  const expiredPrepays = await prisma.bookingPrepay.findMany({
    where: {
      status: 'pending_payment',
      deadline_at: { lt: now }
    }
  });

  if (expiredPrepays.length === 0) return 0;

  let cancelledCount = 0;
  const globalSetting = await prisma.globalSetting.findUnique({
    where: { id: 1 },
    select: { line_auto_notify_cancel: true }
  });

  for (const prepay of expiredPrepays) {
    try {
      const outcome = await prisma.$transaction(async (tx) => {
        const lockedPrepay = await lockPrepay(tx, prepay.booking_ref);
        if (
          !lockedPrepay ||
          lockedPrepay.status !== 'pending_payment' ||
          !lockedPrepay.deadline_at ||
          lockedPrepay.deadline_at >= now
        ) {
          return null;
        }

        await tx.bookingPrepay.update({
          where: { booking_ref: lockedPrepay.booking_ref },
          data: { status: 'expired' }
        });

        const reservations = await tx.reservation.findMany({
          where: { booking_ref: lockedPrepay.booking_ref },
          include: { session: true }
        });

        await tx.reservation.updateMany({
          where: { booking_ref: lockedPrepay.booking_ref, status: 'confirmed' },
          data: {
            status: 'cancelled',
            cancelled_at: now,
            cancelled_by: 'system:prepay_expired'
          }
        });

        if (lockedPrepay.assigned_pool_account) {
          await releasePoolAccount(tx, {
            accountNumber: lockedPrepay.assigned_pool_account,
            orderRef: lockedPrepay.booking_ref
          });
        }

        const holds = Array.isArray(lockedPrepay.pass_holds) ? lockedPrepay.pass_holds : [];
        let passRestored = false;
        for (const h of holds) {
          if (h?.user_pass_id && (Number(h.units) || 0) > 0) {
            const restoredPass = await restorePass(tx, {
              user_pass_id: Number(h.user_pass_id),
              units: Number(h.units),
              booking_ref: lockedPrepay.booking_ref,
              payment_no: null,
              person_no: null,
              staff_name: 'system:prepay_expired'
            });
            await auditLog(tx, {
              booking_ref: lockedPrepay.booking_ref,
              event_type: 'pass_restored',
              category: 'pass',
              summary: `半自助卡券退回（逾期未付款）· ${h.plan_name || '計次卡'} · ${Number(h.units)} 次`,
              after_json: {
                user_pass_id: Number(h.user_pass_id),
                units: Number(h.units),
                remaining_after: restoredPass?.remaining_quota ?? null
              },
              staff_name: '系統',
              device_label: '系統排程'
            });
            passRestored = true;
          }
        }

        await releasePromo(tx, {
          booking_ref: lockedPrepay.booking_ref,
          reason: 'prepay_expired'
        });

        const sortedSess = reservations
          .map((r) => r.session)
          .filter(Boolean)
          .sort((a, b) => a.start_time.localeCompare(b.start_time));
        const timeRange =
          sortedSess.length > 0
            ? `${sortedSess[0].start_time}-${sortedSess[sortedSess.length - 1].end_time}`
            : '';

        return {
          userId: lockedPrepay.user_id,
          session_date: sortedSess[0]?.session_date || null,
          time_range: timeRange,
          pass_restored: passRestored
        };
      });

      if (outcome) {
        cancelledCount++;
        if (globalSetting?.line_auto_notify_cancel) {
          try {
            const user = await prisma.user.findUnique({
              where: { id: outcome.userId },
              select: { id: true, name: true, line_user_id: true }
            });
            await sendSelfServiceExpiredNotification(
              {
                booking_ref: prepay.booking_ref,
                session_date: outcome.session_date,
                time_range: outcome.time_range,
                pass_restored: outcome.pass_restored
              },
              user
            );
          } catch (notifyErr) {
            console.warn(
              `[Cron Job] Failed LINE notify for expired prepay ${prepay.booking_ref}:`,
              notifyErr.message
            );
          }
        }
      }
    } catch (err) {
      console.error(`[Cron Job] Failed to expire prepay ${prepay.booking_ref}:`, err);
    }
  }

  return cancelledCount;
}
