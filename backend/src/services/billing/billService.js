import crypto from 'crypto';
import prisma from '../../prismaClient.js';
import { computeBill, billingStatus } from '../../../../shared/billing.js';
import { toTaipeiDateString, blocksBy1030, dateOnly } from '../../../../shared/time.js';
import { getEffectiveDailyRates } from '../../controllers/reservationController.js';
import { log as auditLog } from '../audit/auditService.js';
import { deductPass, restorePass } from './passTender.js';

export async function getNextDailySeq(tx, key, date = new Date()) {
  const d = dateOnly(date);
  const counter = await tx.dailyCounter.upsert({
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

/**
 * Get the full bill and related entities for a booking
 */
export async function getBookingBill(booking_ref, tx = prisma) {
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
  const { hourly_price, unlimited_price, allow_unlimited, is_weekend } = await getEffectiveDailyRates(tx, sessionDate);

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
    rev: 1
  };

  if (rawDraft && typeof rawDraft === 'object' && rawDraft.version === 2) {
    draft = rawDraft;
  }

  // Persons
  const persons = await tx.bookingPerson.findMany({
    where: { booking_ref },
    include: { pauses: true },
    orderBy: { person_no: 'asc' }
  });

  const now = new Date();
  const bookingStartDt = new Date(`${dStr}T${firstRes.session.start_time}:00+08:00`);
  const bookingEndDt = new Date(`${dStr}T${lastRes.session.end_time}:00+08:00`);
  const bookedMinutes = Math.max(0, Math.floor((bookingEndDt.getTime() - bookingStartDt.getTime()) / 60000));
  const bookedHours = reservations.length; // sessions count

  // Fallback to pax if no persons in db
  const effectivePersons = persons.length > 0
    ? persons
    : Array.from({ length: firstRes.pax }, (_, i) => ({
        person_no: i + 1,
        seat_code: firstRes.assigned_seats?.[i] || null,
        status: 'active',
        billing_start_at: bookingStartDt,
        timer_started_at: null,
        timer_ended_at: null,
        paused_seconds: 0
      }));

  const personInputs = effectivePersons.map(p => {
    let actualMinutes = bookedMinutes;
    if (p.timer_started_at) {
      const startDt = p.billing_start_at ? new Date(p.billing_start_at) : new Date(p.timer_started_at);
      const endDt = p.timer_ended_at ? new Date(p.timer_ended_at) : now;
      let durationMs = endDt.getTime() - startDt.getTime();
      const pausedSec = p.paused_seconds || 0;
      durationMs -= pausedSec * 1000;
      actualMinutes = Math.max(0, Math.floor(durationMs / 60000));
    }

    const pDraft = draft.persons?.find(dp => dp.person_no === p.person_no) || {};

    return {
      person_no: p.person_no,
      seat_code: p.seat_code,
      status: p.status,
      booked_hours: bookedHours,
      actual_minutes: actualMinutes,
      mode: pDraft.mode || 'hourly',
      hours_override: pDraft.hours_override ?? null,
      addons: pDraft.addons || [],
      promos: pDraft.promos || [],
      adjust: pDraft.adjust || null
    };
  });

  // Equipments / Boards
  const bookingEquipments = await tx.bookingEquipment.findMany({
    where: { booking_ref },
    include: { equipment: true },
    orderBy: [{ unit_group: 'asc' }, { segment_no: 'asc' }]
  });

  const boardGroups = new Map();
  for (const be of bookingEquipments) {
    const uGroup = be.unit_group || `single-${be.id}`;
    if (!boardGroups.has(uGroup)) {
      boardGroups.set(uGroup, {
        unit_group: be.unit_group,
        person_no: be.person_id ? persons.find(p => p.id === be.person_id)?.person_no || null : null,
        segments: []
      });
    }
    boardGroups.get(uGroup).segments.push({
      equipment_id: be.equipment_id,
      name: be.equipment?.name || be.equipment_name_snapshot,
      rate: be.unit_rate || be.equipment?.hourly_rate || 60,
      hours: be.rental_hours,
      start_at: be.start_at,
      end_at: be.end_at,
      ended_reason: be.ended_reason,
      planned_end_at: be.planned_end_at
    });
  }

  // Equipment discount rules from global setting
  const boardRules = {
    discount_enabled: globalSetting.equipment_discount_enabled ?? true,
    buy_hours: globalSetting.equipment_discount_buy_hours ?? 3,
    free_hours: globalSetting.equipment_discount_free_hours ?? 1,
    discount2_enabled: globalSetting.equipment_discount2_enabled ?? false,
    buy_hours2: globalSetting.equipment_discount2_buy_hours ?? 8,
    free_hours2: globalSetting.equipment_discount2_free_hours ?? 4
  };

  // Payments
  const payments = await tx.payment.findMany({
    where: { booking_ref },
    orderBy: { created_at: 'asc' }
  });

  const bill = computeBill({
    booking: {
      booking_ref,
      pax: firstRes.pax,
      start_time: firstRes.session.start_time,
      end_time: lastRes.session.end_time,
      is_walk_in: Boolean(firstRes.is_walk_in)
    },
    pricing,
    draft,
    persons: personInputs,
    boards: Array.from(boardGroups.values()),
    boardRules,
    payments
  });

  const status = billingStatus({
    persons: effectivePersons,
    payments
  });

  return {
    bill,
    booking: {
      booking_ref,
      ref_display: `BK-${booking_ref.replace(/^BK-/i, '').slice(0, 4).toUpperCase()}-${booking_ref.replace(/^BK-/i, '').slice(-4).toUpperCase()}`,
      name: user.name || '現場客人',
      phone: user.phone || '',
      pax: firstRes.pax,
      session_date: dStr,
      start_time: firstRes.session.start_time,
      end_time: lastRes.session.end_time,
      is_walk_in: Boolean(firstRes.is_walk_in),
      attendance: firstRes.attendance,
      checked_in_at: firstRes.checked_in_at,
      checked_in_by: firstRes.checked_in_by,
      seat_source: firstRes.seat_source || 'auto',
      is_seat_locked: Boolean(firstRes.is_seat_locked),
      assigned_seats: firstRes.assigned_seats || []
    },
    draft,
    pricing,
    persons: effectivePersons,
    boards: Array.from(boardGroups.values()),
    payments,
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
  const currentRev = currentDetails?.rev || 0;

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

  const updatedRev = currentRev + 1;
  const draftToSave = {
    ...newDraft,
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
  return result.bill;
}

/**
 * Refresh cached billing columns on Reservation rows (spec 4.6.2)
 */
export async function refreshBillingCache(tx = prisma, booking_ref) {
  const { bill, status, payments } = await getBookingBill(booking_ref, tx);

  const validPayments = payments.filter(p => p.status === 'valid');
  const latestPayment = validPayments[validPayments.length - 1];

  const hasRefund = validPayments.some(p => p.kind === 'refund');
  const paidPersons = bill.persons ? bill.persons.filter(p => p.paid).length : 0;
  const amountDue = bill.order?.due_total ?? bill.amount ?? 0;
  const amountReceived = bill.amount_received ?? 0;

  const isPaid = status.code === 'paid' || status.code === 'waived';

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
      paid_at: isPaid ? (latestPayment?.created_at || new Date()) : null,
      payment_method: latestPayment?.method || null
    }
  });

  return { bill, status };
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

    // Recalculate bill
    const billData = await getBookingBill(booking_ref, tx);
    const { bill, pricing } = billData;

    // Filter target persons
    const targetPersonNos = person_nos.map(Number);
    const targetPersons = bill.persons.filter(p => targetPersonNos.includes(p.person_no));

    // Verify none is already paid
    for (const tp of targetPersons) {
      if (tp.paid) {
        throw { status: 400, message: `第 ${tp.person_no} 位已經結清，不可重複收款` };
      }
    }

    const calculatedTotal = targetPersons.reduce((sum, p) => sum + (p.total || 0), 0);
    if (expected_amount !== undefined && expected_amount !== null && calculatedTotal !== Number(expected_amount)) {
      throw {
        status: 409,
        code: 'AMOUNT_CHANGED',
        message: '金額剛剛有變動，請確認後再收款',
        bill
      };
    }

    const batchNo = `B-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    const createdPayments = [];
    let remainingAmount = calculatedTotal;

    // Handle pass tenders (4.5.7)
    const passRecords = [];
    if (Array.isArray(pass_tenders) && pass_tenders.length) {
      for (const pt of pass_tenders) {
        const pass = await tx.userPass.findUnique({
          where: { id: pt.user_pass_id },
          include: { plan: true }
        });
        if (!pass) continue;

        const pBill = targetPersons.find(p => p.person_no === pt.person_no) || targetPersons[0];
        let discountValue = 0;
        const effect = pass.plan?.checkout_effect || (pass.pass_type === 'TIME_PASS' ? 'entry_hours' : 'entry_full');

        if (effect === 'entry_hours') {
          discountValue = Math.min(pBill.entry?.amount || 0, pt.units * (pricing.hourly || 150));
        } else if (effect === 'entry_full') {
          discountValue = pBill.entry?.amount || 0;
        } else if (effect === 'percent_off') {
          const baseScope = pass.plan?.checkout_scope === 'all' ? (pBill.total || 0) : (pBill.entry?.amount || 0);
          discountValue = Math.round(baseScope * (pass.plan?.discount_percent || 0) / 100);
        } else if (effect === 'fixed_amount') {
          const baseScope = pass.plan?.checkout_scope === 'all' ? (pBill.total || 0) : (pBill.entry?.amount || 0);
          discountValue = Math.min(pass.plan?.checkout_value || 0, baseScope);
        }

        discountValue = Math.min(discountValue, remainingAmount);
        if (discountValue > 0) {
          const passSeq = await getNextDailySeq(tx, 'payment');
          const passPayNo = `R-${String(passSeq).padStart(4, '0')}`;

          await deductPass(tx, {
            user_pass_id: pass.id,
            units: pt.units || 1,
            booking_ref,
            payment_no: passPayNo,
            person_no: pt.person_no,
            staff_name: staffName
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
              person_nos: [pt.person_no],
              breakdown_json: {
                persons: [pBill],
                pricing,
                snapshot_at: new Date().toISOString()
              },
              pass_json: [{
                user_pass_id: pass.id,
                pass_code: pass.pass_code,
                plan_name: pass.plan_name_snapshot,
                units: pt.units || 1,
                unit_label: pass.pass_type === 'TIME_PASS' ? '小時' : '次',
                value: discountValue,
                person_no: pt.person_no
              }],
              staff_name: staffName,
              staff_id: staffId,
              device_id: deviceInfo?.device_id,
              device_label: deviceInfo?.device_label || '櫃檯'
            }
          });

          createdPayments.push(passPay);
          passRecords.push({ pass_code: pass.pass_code, value: discountValue });
          remainingAmount -= discountValue;

          await auditLog(tx, {
            booking_ref,
            event_type: 'pass_redeemed',
            category: 'pass',
            summary: `卡券折抵 第 ${pt.person_no} 位 · ${pass.plan_name_snapshot} · NT$${discountValue}`,
            amount: discountValue,
            payment_id: passPay.id,
            staff_name: staffName,
            staff_id: staffId,
            device_id: deviceInfo?.device_id,
            device_label: deviceInfo?.device_label
          });
        }
      }
    }

    // Collect remaining amount with chosen method
    if (remainingAmount > 0 || (calculatedTotal === 0 && createdPayments.length === 0)) {
      const paySeq = await getNextDailySeq(tx, 'payment');
      const payNo = `R-${String(paySeq).padStart(4, '0')}`;

      let change = 0;
      if (method === 'cash') {
        const cashAmt = cash_received !== null && cash_received !== undefined ? Number(cash_received) : remainingAmount;
        if (cashAmt < remainingAmount) {
          throw { status: 400, message: `實收現金（NT$${cashAmt}）不足（應收 NT$${remainingAmount}）` };
        }
        change = cashAmt - remainingAmount;
      }

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
          cash_received: method === 'cash' ? (cash_received ?? remainingAmount) : null,
          change_given: method === 'cash' ? change : null,
          person_nos: targetPersonNos,
          breakdown_json: {
            persons: targetPersons,
            pricing,
            order: bill.order,
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

    return {
      payments: createdPayments,
      bill: finalBill,
      status: finalStatus,
      print_jobs: []
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
  const { person_no, items = [], method = 'cash', cash_received = null, note = '' } = payload;
  const pNo = Number(person_no);

  return await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${booking_ref}))`;

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

    let supplementAmount = 0;
    const itemSummaries = [];

    for (const it of items) {
      if (it.type === 'addon') {
        const cost = (it.price || 0) * (it.qty || 1);
        supplementAmount += cost;
        itemSummaries.push(`${it.name} ×${it.qty || 1}`);
      } else if (it.type === 'hours') {
        const hourlyRate = priorPayment.breakdown_json?.pricing?.hourly || 150;
        const cost = Math.round((it.hours || 0) * hourlyRate);
        supplementAmount += cost;
        itemSummaries.push(`時數 +${it.hours} 小時`);
      } else if (it.type === 'unlimited_diff') {
        const diff = (it.unlimited_price || 750) - (priorPayment.breakdown_json?.persons?.[0]?.entry?.amount || 0);
        if (diff > 0) {
          supplementAmount += diff;
          itemSummaries.push('升級不限時差額');
        }
      } else if (it.type === 'other') {
        supplementAmount += Number(it.amount || 0);
        itemSummaries.push(it.label || '其他');
      } else if (it.type === 'pending') {
        supplementAmount += Number(it.amount || 0);
        itemSummaries.push(it.label || '結清待補收');
      }
    }

    const paySeq = await getNextDailySeq(tx, 'payment');
    const payNo = `R-${String(paySeq).padStart(4, '0')}`;
    const batchNo = `B-${Date.now()}-${Math.floor(Math.random() * 1000)}`;

    let change = 0;
    if (method === 'cash') {
      const cashAmt = cash_received !== null && cash_received !== undefined ? Number(cash_received) : supplementAmount;
      change = Math.max(0, cashAmt - supplementAmount);
    }

    const payment = await tx.payment.create({
      data: {
        payment_no: payNo,
        batch_no: batchNo,
        booking_ref,
        kind: 'supplement',
        status: 'valid',
        method,
        amount: supplementAmount,
        cash_received: method === 'cash' ? (cash_received ?? supplementAmount) : null,
        change_given: method === 'cash' ? change : null,
        person_nos: [pNo],
        breakdown_json: {
          items,
          snapshot_at: new Date().toISOString()
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

    const { bill, status } = await refreshBillingCache(tx, booking_ref);
    return { payment, bill, status };
  });
}

/**
 * Record refund (spec 5.4 POST /refund)
 */
export async function refundPayment(booking_ref, payload, staffUser, deviceInfo) {
  const staffName = staffUser?.name || '門市人員';
  const staffId = staffUser?.id || null;
  const { person_no, amount, method = 'cash', reason, note = '' } = payload;
  const pNo = Number(person_no);
  const refundAmt = Math.round(Number(amount));

  if (!reason || !String(reason).trim()) {
    throw { status: 422, message: '退款請填寫原因' };
  }
  if (!(refundAmt > 0)) {
    throw { status: 400, message: '退款金額必須大於 0' };
  }

  return await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${booking_ref}))`;

    const priorPayments = await tx.payment.findMany({
      where: {
        booking_ref,
        status: 'valid',
        person_nos: { has: pNo }
      }
    });

    const paidTotal = priorPayments
      .filter(p => p.kind === 'charge' || p.kind === 'supplement')
      .reduce((sum, p) => sum + p.amount, 0);

    const refundedTotal = priorPayments
      .filter(p => p.kind === 'refund')
      .reduce((sum, p) => sum + p.amount, 0);

    const maxRefundable = paidTotal - refundedTotal;
    if (refundAmt > maxRefundable) {
      throw { status: 400, message: `退款金額超過此顧客已付金額上限（最多可退 NT$${maxRefundable}）` };
    }

    const paySeq = await getNextDailySeq(tx, 'payment');
    const payNo = `R-${String(paySeq).padStart(4, '0')}`;
    const batchNo = `B-${Date.now()}-${Math.floor(Math.random() * 1000)}`;

    const payment = await tx.payment.create({
      data: {
        payment_no: payNo,
        batch_no: batchNo,
        booking_ref,
        kind: 'refund',
        status: 'valid',
        method,
        amount: refundAmt,
        person_nos: [pNo],
        breakdown_json: {
          refund_amount: refundAmt,
          reason,
          snapshot_at: new Date().toISOString()
        },
        reason: String(reason).trim(),
        note: note ? String(note).trim() : null,
        staff_name: staffName,
        staff_id: staffId,
        device_id: deviceInfo?.device_id,
        device_label: deviceInfo?.device_label || '櫃檯'
      }
    });

    await auditLog(tx, {
      booking_ref,
      event_type: 'refund_created',
      category: 'refund',
      summary: `退款 第 ${pNo} 位 NT$${refundAmt} · ${method === 'cash' ? '現金退回' : method}。原因「${reason}」`,
      amount: refundAmt,
      payment_id: payment.id,
      reason,
      staff_name: staffName,
      staff_id: staffId,
      device_id: deviceInfo?.device_id,
      device_label: deviceInfo?.device_label
    });

    const { bill, status } = await refreshBillingCache(tx, booking_ref);
    return { payment, bill, status };
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

    // Void entire batch
    const batchPayments = await tx.payment.findMany({
      where: { batch_no: payment.batch_no, status: 'valid' }
    });

    const now = new Date();
    for (const bp of batchPayments) {
      await tx.payment.update({
        where: { id: bp.id },
        data: {
          status: 'voided',
          voided_at: now,
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

    const now = new Date();
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
          }
        }
      }
    }

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

    const { bill, pricing } = await getBookingBill(booking_ref, tx);
    const targetPersonNos = person_nos.map(Number);
    const targetPersons = bill.persons.filter(p => targetPersonNos.includes(p.person_no));

    for (const tp of targetPersons) {
      if (tp.paid) {
        throw { status: 400, message: `第 ${tp.person_no} 位已經結清` };
      }
    }

    const waiveAmount = targetPersons.reduce((sum, p) => sum + (p.total || 0), 0);
    const paySeq = await getNextDailySeq(tx, 'payment');
    const payNo = `R-${String(paySeq).padStart(4, '0')}`;
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
