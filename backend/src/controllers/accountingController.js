import prisma from '../prismaClient.js';
import { toTaipeiDateString, dateOnly } from '../../../shared/time.js';
import { getAdminDeviceInfo } from '../utils/deviceParser.js';
import { log as auditLog } from '../services/audit/auditService.js';
import { queuePrintJob } from '../services/print/printService.js';
import { getShiftLock, canVoidPayment } from '../services/billing/shiftLock.js';
import { computeClosingStats } from '../services/billing/closingStats.js';

export const getAccountingSummary = async (req, res) => {
  const { start_date, end_date } = req.query;

  try {
    const start = start_date ? new Date(`${start_date}T00:00:00+08:00`) : new Date();
    if (!start_date) start.setHours(0, 0, 0, 0);

    const end = end_date ? new Date(`${end_date}T23:59:59.999+08:00`) : new Date();
    if (!end_date) end.setHours(23, 59, 59, 999);

    const payments = await prisma.payment.findMany({
      where: {
        created_at: { gte: start, lte: end }
      }
    });

    const validPayments = payments.filter(p => p.status === 'valid');
    const charges = validPayments.filter(p => (p.kind === 'charge' || p.kind === 'supplement') && p.method !== 'pass');
    const passes = validPayments.filter(p => (p.kind === 'charge' || p.kind === 'supplement') && p.method === 'pass');
    const refunds = validPayments.filter(p => p.kind === 'refund' && p.method !== 'pass');
    const passRefunds = validPayments.filter(p => p.kind === 'refund' && p.method === 'pass');
    const voids = payments.filter(p => p.status === 'voided');

    const totalIncome = charges.reduce((sum, p) => sum + p.amount, 0);
    const totalRefund = refunds.reduce((sum, p) => sum + p.amount, 0);
    const netRevenue = totalIncome - totalRefund;

    const byMethod = {};
    for (const p of charges) {
      if (!byMethod[p.method]) byMethod[p.method] = { count: 0, amount: 0 };
      byMethod[p.method].count += 1;
      byMethod[p.method].amount += p.amount;
    }

    const refundsByMethod = {};
    for (const p of refunds) {
      if (!refundsByMethod[p.method]) refundsByMethod[p.method] = { count: 0, amount: 0 };
      refundsByMethod[p.method].count += 1;
      refundsByMethod[p.method].amount += p.amount;
    }

    const passValue = passes.reduce((sum, p) => sum + p.amount, 0);

    // Unpaid reservations today
    const sessionStartDate = dateOnly(start_date || toTaipeiDateString(start));
    const sessionEndDate = dateOnly(end_date || toTaipeiDateString(end));
    const unpaidReservations = await prisma.reservation.findMany({
      where: {
        status: { not: 'cancelled' },
        session: { session_date: { gte: sessionStartDate, lte: sessionEndDate } },
        billing_status: { in: ['unpaid', 'partial'] }
      }
    });
    const uniqueUnpaid = new Map();
    for (const r of unpaidReservations) {
      if (!uniqueUnpaid.has(r.booking_ref)) {
        uniqueUnpaid.set(r.booking_ref, (r.amount_due || 0) - (r.amount_received || 0));
      }
    }
    const unpaidCount = uniqueUnpaid.size;
    const unpaidAmount = Array.from(uniqueUnpaid.values()).reduce((sum, amt) => sum + Math.max(0, amt), 0);

    return res.json({
      period: { start_date: toTaipeiDateString(start), end_date: toTaipeiDateString(end) },
      total_income: netRevenue,
      net_revenue: netRevenue,
      total_refunds: totalRefund,
      by_method: byMethod,
      refunds: refundsByMethod,
      voids: {
        count: voids.length,
        amount: voids.reduce((sum, p) => sum + p.amount, 0)
      },
      pass_value: passValue,
      pass_refunds: {
        count: passRefunds.length,
        amount: passRefunds.reduce((sum, p) => sum + p.amount, 0)
      },
      unpaid: {
        count: unpaidCount,
        amount: unpaidAmount
      }
    });
  } catch (error) {
    console.error('[getAccountingSummary] Error:', error);
    return res.status(500).json({ error: '無法讀取帳務摘要' });
  }
};

export const getLedger = async (req, res) => {
  const { start_date, end_date } = req.query;

  try {
    const start = start_date ? new Date(`${start_date}T00:00:00+08:00`) : new Date();
    if (!start_date) start.setHours(0, 0, 0, 0);

    const end = end_date ? new Date(`${end_date}T23:59:59.999+08:00`) : new Date();
    if (!end_date) end.setHours(23, 59, 59, 999);

    const payments = await prisma.payment.findMany({
      where: {
        created_at: { gte: start, lte: end }
      },
      orderBy: { created_at: 'desc' }
    });

    const bookingRefs = [...new Set(payments.map(p => p.booking_ref))];
    const reservations = await prisma.reservation.findMany({
      where: { booking_ref: { in: bookingRefs } },
      include: { user: true, session: true }
    });

    const resMap = new Map();
    for (const r of reservations) {
      if (!resMap.has(r.booking_ref)) resMap.set(r.booking_ref, r);
    }

    const ledger = payments.map(p => {
      const r = resMap.get(p.booking_ref);
      const isPassSale = p.source === 'pass_sale';
      const refStr = p.source_ref || p.booking_ref || '';
      const passTargetLabel = isPassSale ? `卡券販售 · *${String(refStr).slice(-4)}` : null;
      return {
        id: p.id,
        payment_no: p.payment_no,
        booking_ref: p.booking_ref,
        source: p.source,
        source_ref: p.source_ref,
        kind: p.kind,
        status: p.status,
        method: p.method,
        amount: p.amount,
        // Compatibility fields
        total_amount: p.amount,
        payment_method: p.method,
        paid_at: p.created_at,
        created_at: p.created_at,
        staff_name: p.staff_name,
        device_label: p.device_label,
        user_name: passTargetLabel || r?.user?.name || p.breakdown_json?.customer_name || '客人',
        phone: r?.user?.phone || p.breakdown_json?.customer_phone || '',
        person_nos: p.person_nos
      };
    });

    return res.json({ ledger });
  } catch (error) {
    console.error('[getLedger] Error:', error);
    return res.status(500).json({ error: '無法讀取交易流水帳' });
  }
};

export const getPaymentsList = async (req, res) => {
  const { date_from, date_to, method, kind, status, staff, q, cursor } = req.query;

  try {
    const where = {};
    if (date_from || date_to) {
      where.created_at = {};
      if (date_from) where.created_at.gte = new Date(`${date_from}T00:00:00+08:00`);
      if (date_to) where.created_at.lte = new Date(`${date_to}T23:59:59.999+08:00`);
    }
    if (method) where.method = method;
    if (kind) where.kind = kind;
    if (status) where.status = status;
    if (staff) where.staff_name = { contains: staff, mode: 'insensitive' };

    if (q) {
      const qTrim = q.trim();
      where.OR = [
        { booking_ref: { contains: qTrim, mode: 'insensitive' } },
        { payment_no: { contains: qTrim, mode: 'insensitive' } }
      ];
    }

    const take = 50;
    const payments = await prisma.payment.findMany({
      where,
      orderBy: { created_at: 'desc' },
      take: take + 1,
      ...(cursor ? { skip: 1, cursor: { id: Number(cursor) } } : {})
    });

    const hasMore = payments.length > take;
    const rawItems = hasMore ? payments.slice(0, take) : payments;
    const nowTs = new Date();
    const shiftLockAt = await getShiftLock(prisma, nowTs);
    const items = rawItems.map(p => {
      const refStr = p.source_ref || p.booking_ref || '';
      const target_label = p.source === 'pass_sale'
        ? `卡券販售 · *${String(refStr).slice(-4)}`
        : p.source === 'shop'
          ? `商城訂單 · ${refStr}`
          : null;
      return {
        ...p,
        target_label,
        can_void: canVoidPayment(p, { shiftLockAt, now: nowTs })
      };
    });
    const nextCursor = hasMore ? items[items.length - 1].id : null;

    return res.json({ payments: items, next_cursor: nextCursor });
  } catch (error) {
    console.error('[getPaymentsList] Error:', error);
    return res.status(500).json({ error: '無法讀取收款清單' });
  }
};

export const getEventsList = async (req, res) => {
  const { date_from, date_to, category, staff, q, cursor } = req.query;

  try {
    const where = {};
    if (date_from || date_to) {
      where.created_at = {};
      if (date_from) where.created_at.gte = new Date(`${date_from}T00:00:00+08:00`);
      if (date_to) where.created_at.lte = new Date(`${date_to}T23:59:59.999+08:00`);
    }
    if (category) where.category = category;
    if (staff) where.staff_name = { contains: staff, mode: 'insensitive' };
    if (q) {
      where.OR = [
        { booking_ref: { contains: q.trim(), mode: 'insensitive' } },
        { summary: { contains: q.trim(), mode: 'insensitive' } }
      ];
    }

    const take = 50;
    const events = await prisma.accountingEvent.findMany({
      where,
      orderBy: { created_at: 'desc' },
      take: take + 1,
      ...(cursor ? { skip: 1, cursor: { id: Number(cursor) } } : {})
    });

    const hasMore = events.length > take;
    const items = hasMore ? events.slice(0, take) : events;
    const nextCursor = hasMore ? items[items.length - 1].id : null;

    return res.json({ events: items, next_cursor: nextCursor });
  } catch (error) {
    console.error('[getEventsList] Error:', error);
    return res.status(500).json({ error: '無法讀取異動清單' });
  }
};

export const getPrintJobsList = async (req, res) => {
  const { date, status, cursor } = req.query;

  try {
    const where = {};
    if (status) where.status = status;
    if (date) {
      where.created_at = {
        gte: new Date(`${date}T00:00:00+08:00`),
        lte: new Date(`${date}T23:59:59.999+08:00`)
      };
    }

    const take = 50;
    const jobs = await prisma.printJob.findMany({
      where,
      orderBy: { created_at: 'desc' },
      take: take + 1,
      ...(cursor ? { skip: 1, cursor: { id: Number(cursor) } } : {})
    });

    const hasMore = jobs.length > take;
    const items = hasMore ? jobs.slice(0, take) : jobs;
    const nextCursor = hasMore ? items[items.length - 1].id : null;

    return res.json({ print_jobs: items, next_cursor: nextCursor });
  } catch (error) {
    console.error('[getPrintJobsList] Error:', error);
    return res.status(500).json({ error: '無法讀取列印清單' });
  }
};

function resolveClosingNow(rawNow) {
  if (process.env.NODE_ENV === 'test' && rawNow) {
    const parsed = new Date(rawNow);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return new Date();
}

async function computeShiftWindowAndFloat({ targetDateStr, requestFloatAmount, now, txOrPrisma }) {
  const [dayClosings, globalSettingRow] = await Promise.all([
    txOrPrisma.cashClosing.findMany({
      where: { business_date: dateOnly(targetDateStr) }
    }),
    txOrPrisma.globalSetting.findFirst()
  ]);

  const globalSetting = globalSettingRow || {};

  // Avoid Postgres NULLS FIRST when mixing legacy null period_end_at and new rows
  let lastClosing = null;
  let lastEndMs = -1;
  for (const c of dayClosings) {
    const candidate = c.period_end_at ?? c.created_at;
    if (!candidate) continue;
    const ms = new Date(candidate).getTime();
    if (ms > lastEndMs) {
      lastEndMs = ms;
      lastClosing = c;
    }
  }

  const periodStartAt = lastClosing
    ? new Date(lastClosing.period_end_at ?? lastClosing.created_at)
    : new Date(`${targetDateStr}T00:00:00+08:00`);

  const todayStr = toTaipeiDateString(now);
  const rawEnd = targetDateStr === todayStr
    ? now
    : new Date(`${targetDateStr}T23:59:59.999+08:00`);
  const periodEndAt = rawEnd.getTime() < periodStartAt.getTime() ? periodStartAt : rawEnd;

  const hasPreviousLeft = lastClosing != null && lastClosing.left_in_drawer != null;
  let floatAmount;
  let floatSource;
  if (hasPreviousLeft) {
    floatAmount = lastClosing.left_in_drawer;
    floatSource = 'previous_shift';
  } else {
    floatAmount = (
      requestFloatAmount !== undefined &&
      requestFloatAmount !== null &&
      requestFloatAmount !== '' &&
      Number.isFinite(Number(requestFloatAmount))
    )
      ? Math.round(Number(requestFloatAmount))
      : (globalSetting.cash_float_amount ?? 2000);
    floatSource = 'setting';
  }

  return {
    periodStartAt,
    periodEndAt,
    isToday: targetDateStr === todayStr,
    floatAmount,
    floatSource,
    shiftCountToday: dayClosings.length,
    lastClosedAt: lastClosing ? (lastClosing.period_end_at ?? lastClosing.created_at) : null
  };
}

export const getClosingPreview = async (req, res) => {
  const now = resolveClosingNow(req.query.now);
  const todayStr = toTaipeiDateString(now);
  const targetDateStr = req.query.date || todayStr;

  if (targetDateStr > todayStr) {
    return res.status(422).json({ error: '不能交未來日期' });
  }

  try {
    const shift = await computeShiftWindowAndFloat({
      targetDateStr,
      requestFloatAmount: undefined,
      now,
      txOrPrisma: prisma
    });

    const stats = await computeClosingStats({
      start: shift.periodStartAt,
      end: shift.periodEndAt,
      businessDate: targetDateStr,
      txOrPrisma: prisma
    });
    const expectedCash = shift.floatAmount + stats.cash_income - stats.cash_refund + stats.shop_cash_income - stats.shop_cash_refund;

    return res.json({
      date: targetDateStr,
      period_start_at: shift.periodStartAt.toISOString(),
      period_end_at: shift.periodEndAt.toISOString(),
      is_today: shift.isToday,
      float_amount: shift.floatAmount,
      float_source: shift.floatSource,
      shift_count_today: shift.shiftCountToday,
      last_closed_at: shift.lastClosedAt ? new Date(shift.lastClosedAt).toISOString() : null,
      expected_cash: expectedCash,
      ...stats
    });
  } catch (error) {
    console.error('[getClosingPreview] Error:', error);
    return res.status(500).json({ error: '無法計算交班預覽' });
  }
};

export const postClosing = async (req, res) => {
  const { date, float_amount, counted_cash, handed_over_amount, note = '', print = true } = req.body;
  const now = resolveClosingNow(req.body?.now);
  const staffName = req.user?.name || '門市人員';
  const staffId = req.user?.id || null;
  const deviceInfo = getAdminDeviceInfo(req);

  try {
    const todayStr = toTaipeiDateString(now);
    const targetDateStr = date || todayStr;
    if (targetDateStr > todayStr) {
      return res.status(422).json({ error: '不能交未來日期' });
    }

    if (counted_cash === undefined || counted_cash === null || counted_cash === '') {
      return res.status(422).json({ error: '請填寫實點現金金額' });
    }
    const countedNum = Number(counted_cash);
    if (!Number.isInteger(countedNum) || countedNum < 0) {
      return res.status(422).json({ error: '實點現金必須為非負整數' });
    }

    if (handed_over_amount === undefined || handed_over_amount === null || handed_over_amount === '') {
      return res.status(422).json({ error: '請填寫交出去的金額' });
    }
    const handedNum = Number(handed_over_amount);
    if (!Number.isInteger(handedNum) || handedNum < 0) {
      return res.status(422).json({ error: '交出去的金額必須為非負整數' });
    }

    const leftInDrawer = countedNum - handedNum;
    if (leftInDrawer < 0) {
      return res.status(422).json({ error: '交出去的金額不能超過實點現金' });
    }

    const txResult = await prisma.$transaction(async (tx) => {
      const shift = await computeShiftWindowAndFloat({
        targetDateStr,
        requestFloatAmount: float_amount,
        now,
        txOrPrisma: tx
      });

      if (shift.floatAmount < 0) {
        return { errorStatus: 422, errorBody: { error: '起始零用金不能為負數' } };
      }

      const stats = await computeClosingStats({
        start: shift.periodStartAt,
        end: shift.periodEndAt,
        businessDate: targetDateStr,
        txOrPrisma: tx
      });
      const expCash = shift.floatAmount + stats.cash_income - stats.cash_refund + stats.shop_cash_income - stats.shop_cash_refund;
      const difference = countedNum - expCash;
      const trimmedNote = note ? String(note).trim() : '';

      if (difference !== 0 && !trimmedNote) {
        return { errorStatus: 422, errorBody: { error: '有差額，請先填寫備註' } };
      }

      const periodObj = {
        start_at: shift.periodStartAt.toISOString(),
        end_at: shift.periodEndAt.toISOString()
      };
      const snapshotTotals = {
        ...stats,
        date: targetDateStr,
        period: periodObj,
        float_amount: shift.floatAmount,
        float_source: shift.floatSource,
        expected_cash: expCash,
        counted_cash: countedNum,
        handed_over_amount: handedNum,
        left_in_drawer: leftInDrawer,
        difference,
        note: trimmedNote || null,
        snapshot_at: now.toISOString()
      };

      const created = await tx.cashClosing.create({
        data: {
          business_date: dateOnly(targetDateStr),
          period_start_at: shift.periodStartAt,
          period_end_at: shift.periodEndAt,
          float_amount: shift.floatAmount,
          expected_cash: expCash,
          counted_cash: countedNum,
          handed_over_amount: handedNum,
          left_in_drawer: leftInDrawer,
          difference,
          totals_json: snapshotTotals,
          note: trimmedNote || null,
          staff_name: staffName,
          device_label: deviceInfo.device_label,
          ...(process.env.NODE_ENV === 'test' && req.body?.now ? { created_at: shift.periodEndAt } : {})
        }
      });

      const diffLabel = difference === 0 ? '無差額' : `差額 ${difference > 0 ? '+' : ''}${difference}`;
      await auditLog(tx, {
        event_type: 'day_closed',
        category: 'closing',
        summary: `交班完成 · 實點 NT$${countedNum}／交出 NT$${handedNum}／留在抽屜 NT$${leftInDrawer}（應有 NT$${expCash}，${diffLabel}）`,
        amount: countedNum,
        reason: difference !== 0 ? trimmedNote : null,
        staff_name: staffName,
        staff_id: staffId,
        device_id: deviceInfo.device_id,
        device_label: deviceInfo.device_label
      });

      return { closing: created };
    });

    if (txResult.errorStatus) {
      return res.status(txResult.errorStatus).json(txResult.errorBody);
    }
    const closing = txResult.closing;

    let printJob = null;
    if (print) {
      try {
        printJob = await queuePrintJob({
          type: 'closing',
          closing_id: closing.id,
          user: req.user,
          device: deviceInfo,
          now
        });
      } catch (err) {
        console.error('[postClosing] Print error:', err);
      }
    }

    return res.json({ success: true, closing, print_job: printJob });
  } catch (error) {
    console.error('[postClosing] Error:', error);
    return res.status(500).json({ error: '交班存檔失敗' });
  }
};

export const getClosingsList = async (req, res) => {
  try {
    const { date } = req.query;
    const closings = await prisma.cashClosing.findMany({
      where: date ? { business_date: dateOnly(date) } : undefined,
      orderBy: [{ business_date: 'desc' }, { id: 'desc' }],
      take: 60
    });
    return res.json({ closings });
  } catch (error) {
    console.error('[getClosingsList] Error:', error);
    return res.status(500).json({ error: '無法讀取交班紀錄' });
  }
};

export const getUnpaidFollowUp = async (req, res) => {
  try {
    const today = dateOnly(new Date());

    const unpaidRes = await prisma.reservation.findMany({
      where: {
        status: { not: 'cancelled' },
        session: { session_date: { lte: today } },
        OR: [
          { billing_status: { in: ['unpaid', 'partial'] } },
          { billing_status: null, is_paid: false }
        ]
      },
      include: {
        user: true,
        session: true
      },
      orderBy: { session: { session_date: 'desc' } }
    });

    const map = new Map();
    for (const r of unpaidRes) {
      if (!map.has(r.booking_ref)) {
        map.set(r.booking_ref, {
          booking_ref: r.booking_ref,
          ref_display: r.booking_ref,
          user: r.user,
          name: r.user?.name || '現場貴賓',
          pax: r.pax,
          date: r.session.session_date,
          session_date: r.session.session_date,
          status: r.billing_status || 'unpaid',
          billing_status: r.billing_status || 'unpaid',
          amount_due: r.amount_due ?? 0,
          amount_received: r.amount_received ?? 0,
          unpaid_amount: Math.max(0, (r.amount_due ?? 0) - (r.amount_received ?? 0))
        });
      }
    }

    return res.json({ unpaid: Array.from(map.values()) });
  } catch (error) {
    console.error('[getUnpaidFollowUp] Error:', error);
    return res.status(500).json({ error: '無法讀取未結清追蹤' });
  }
};

export default {
  getAccountingSummary,
  getLedger,
  getPaymentsList,
  getEventsList,
  getPrintJobsList,
  getClosingPreview,
  postClosing,
  getClosingsList,
  getUnpaidFollowUp
};
