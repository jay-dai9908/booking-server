import prisma from '../prismaClient.js';
import { toTaipeiDateString, dateOnly } from '../../../shared/time.js';
import { buildPaymentsCsv, buildEventsCsv } from '../../../shared/accountingExport.js';
import { getAdminDeviceInfo } from '../utils/deviceParser.js';
import { log as auditLog } from '../services/audit/auditService.js';
import { queuePrintJob } from '../services/print/printService.js';
import { getShiftLock, canVoidPayment } from '../services/billing/shiftLock.js';
import { computeClosingStats } from '../services/billing/closingStats.js';
import { REVENUE_PAYMENT_SOURCES, revenuePaymentWhere, isRevenuePayment } from '../services/accounting/revenueScope.js';
import {
  getConfiguredPaymentMethods,
  buildMethodBreakdown,
  resolveRawMethodsMatchingFilter
} from '../services/accounting/methodAggregation.js';
import { getUnpaidBookings } from '../services/accounting/unpaidQuery.js';

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
    const storePayments = validPayments.filter(isRevenuePayment);
    const shopPayments = validPayments.filter(p => !isRevenuePayment(p));

    const charges = storePayments.filter(p => (p.kind === 'charge' || p.kind === 'supplement') && p.method !== 'pass');
    const passes = storePayments.filter(p => (p.kind === 'charge' || p.kind === 'supplement') && p.method === 'pass');
    const refunds = storePayments.filter(p => p.kind === 'refund' && p.method !== 'pass');
    const passRefunds = storePayments.filter(p => p.kind === 'refund' && p.method === 'pass');
    const voids = payments.filter(p => p.status === 'voided' && isRevenuePayment(p));

    const totalIncome = charges.reduce((sum, p) => sum + p.amount, 0);
    const totalRefund = refunds.reduce((sum, p) => sum + p.amount, 0);
    const netRevenue = totalIncome - totalRefund;
    const paidBookingRefs = new Set(
      charges.filter(p => p.source === 'booking' && p.booking_ref).map(p => p.booking_ref)
    );
    const paidBookingCount = paidBookingRefs.size;
    const avgTicket = paidBookingCount > 0 ? Math.round(netRevenue / paidBookingCount) : 0;

    const configuredMethods = await getConfiguredPaymentMethods(prisma);
    const { by_method: byMethod, refunds: refundsByMethod, methods } = buildMethodBreakdown(
      charges,
      refunds,
      configuredMethods
    );

    const shopCharges = shopPayments.filter(p => p.kind === 'charge' || p.kind === 'supplement');
    const shopRefundsList = shopPayments.filter(p => p.kind === 'refund');
    const shopByMethod = {};
    for (const p of shopCharges) {
      if (!shopByMethod[p.method]) shopByMethod[p.method] = { count: 0, amount: 0 };
      shopByMethod[p.method].count += 1;
      shopByMethod[p.method].amount += p.amount;
    }
    const shopRefundsByMethod = {};
    for (const p of shopRefundsList) {
      if (!shopRefundsByMethod[p.method]) shopRefundsByMethod[p.method] = { count: 0, amount: 0 };
      shopRefundsByMethod[p.method].count += 1;
      shopRefundsByMethod[p.method].amount += p.amount;
    }
    const shopChargeTotal = shopCharges.reduce((sum, p) => sum + p.amount, 0);
    const shopRefundTotal = shopRefundsList.reduce((sum, p) => sum + p.amount, 0);

    const passValue = passes.reduce((sum, p) => sum + p.amount, 0);

    // Unpaid reservations in range (unified formula excluding no_show & deducting pass)
    const sessionStartDate = dateOnly(start_date || toTaipeiDateString(start));
    const sessionEndDate = dateOnly(end_date || toTaipeiDateString(end));
    const unpaidStats = await getUnpaidBookings(prisma, {
      dateFrom: sessionStartDate,
      dateTo: sessionEndDate
    });

    return res.json({
      period: { start_date: toTaipeiDateString(start), end_date: toTaipeiDateString(end) },
      total_income: netRevenue,
      net_revenue: netRevenue,
      total_refunds: totalRefund,
      paid_booking_count: paidBookingCount,
      avg_ticket: avgTicket,
      by_method: byMethod,
      refunds: refundsByMethod,
      methods,
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
        count: unpaidStats.count,
        amount: unpaidStats.amount,
        no_show_count: unpaidStats.no_show_count
      },
      shop: {
        count: shopCharges.length,
        amount: shopChargeTotal - shopRefundTotal,
        by_method: shopByMethod,
        refunds: shopRefundsByMethod
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

const VALID_PAYMENT_SOURCES = new Set(['booking', 'pass_sale', 'shop']);
const CSV_MAX_ROWS = 20000;
const DATE_YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

async function buildPaymentsFilterWhere(query = {}, defaultSources = REVENUE_PAYMENT_SOURCES, client = prisma) {
  const { date_from, date_to, method, kind, status, staff, q, source } = query;
  const where = {};

  if (source !== undefined && source !== '') {
    const rawList = Array.isArray(source) ? source : String(source).split(',');
    const sources = rawList
      .map(s => String(s || '').trim())
      .filter(s => VALID_PAYMENT_SOURCES.has(s));
    const finalSources = sources.length > 0 ? sources : defaultSources;
    where.source = finalSources.length === 1 ? finalSources[0] : { in: finalSources };
  } else {
    where.source = defaultSources.length === 1 ? defaultSources[0] : { in: defaultSources };
  }

  if (date_from || date_to) {
    where.created_at = {};
    if (date_from) where.created_at.gte = new Date(`${date_from}T00:00:00+08:00`);
    if (date_to) where.created_at.lte = new Date(`${date_to}T23:59:59.999+08:00`);
  }
  if (method && method !== 'all') {
    const matchedRaw = await resolveRawMethodsMatchingFilter(client, method);
    where.method = matchedRaw.length === 1 ? matchedRaw[0] : { in: matchedRaw };
  }
  if (kind) where.kind = kind;
  if (status) where.status = status;
  if (staff) where.staff_name = { contains: staff, mode: 'insensitive' };

  if (q) {
    const qTrim = String(q).trim();
    if (qTrim) {
      where.OR = [
        { booking_ref: { contains: qTrim, mode: 'insensitive' } },
        { source_ref: { contains: qTrim, mode: 'insensitive' } },
        { payment_no: { contains: qTrim, mode: 'insensitive' } }
      ];
    }
  }
  return where;
}

function buildEventsFilterWhere(query = {}) {
  const { date_from, date_to, category, staff, q } = query;
  const where = {};
  if (date_from || date_to) {
    where.created_at = {};
    if (date_from) where.created_at.gte = new Date(`${date_from}T00:00:00+08:00`);
    if (date_to) where.created_at.lte = new Date(`${date_to}T23:59:59.999+08:00`);
  }
  if (category) where.category = category;
  if (staff) where.staff_name = { contains: staff, mode: 'insensitive' };
  if (q) {
    const qTrim = String(q).trim();
    if (qTrim) {
      where.OR = [
        { booking_ref: { contains: qTrim, mode: 'insensitive' } },
        { summary: { contains: qTrim, mode: 'insensitive' } }
      ];
    }
  }
  return where;
}

export const getDailyRevenue = async (req, res) => {
  try {
    const todayStr = toTaipeiDateString(new Date());
    const fromStr = req.query.date_from || todayStr;
    const toStr = req.query.date_to || todayStr;

    if (!DATE_YMD_RE.test(fromStr) || !DATE_YMD_RE.test(toStr)) {
      return res.status(400).json({ error: '日期格式必須為 YYYY-MM-DD' });
    }
    const startUtc = new Date(`${fromStr}T00:00:00.000Z`);
    const endUtc = new Date(`${toStr}T00:00:00.000Z`);
    const daySpan = Math.round((endUtc.getTime() - startUtc.getTime()) / 86400000) + 1;
    if (!Number.isFinite(daySpan) || daySpan < 1) {
      return res.status(400).json({ error: '結束日期不可早於開始日期' });
    }
    if (daySpan > 366) {
      return res.status(400).json({ error: '查詢區間最多 366 天' });
    }

    const start = new Date(`${fromStr}T00:00:00+08:00`);
    const end = new Date(`${toStr}T23:59:59.999+08:00`);
    const [payments, configuredMethods] = await Promise.all([
      prisma.payment.findMany({
        where: revenuePaymentWhere({
          status: 'valid',
          created_at: { gte: start, lte: end }
        }),
        select: { kind: true, method: true, amount: true, created_at: true }
      }),
      getConfiguredPaymentMethods(prisma)
    ]);

    const dailyMap = new Map();
    const cur = new Date(startUtc);
    while (cur <= endUtc) {
      const dStr = cur.toISOString().slice(0, 10);
      dailyMap.set(dStr, {
        date: dStr,
        revenue: 0,
        refunds: 0,
        net: 0,
        count: 0,
        _charges: [],
        _refunds: []
      });
      cur.setUTCDate(cur.getUTCDate() + 1);
    }

    for (const p of payments) {
      if (p.method === 'pass') continue;
      const dStr = toTaipeiDateString(p.created_at);
      const row = dailyMap.get(dStr);
      if (!row) continue;

      if (p.kind === 'charge' || p.kind === 'supplement') {
        row.revenue += p.amount;
        row.net += p.amount;
        row.count += 1;
        row._charges.push(p);
      } else if (p.kind === 'refund') {
        row.refunds += p.amount;
        row.net -= p.amount;
        row._refunds.push(p);
      }
    }

    const daily = Array.from(dailyMap.values()).map((row) => {
      const breakdown = buildMethodBreakdown(row._charges, row._refunds, configuredMethods);
      return {
        date: row.date,
        revenue: row.revenue,
        refunds: row.refunds,
        net: row.net,
        count: row.count,
        by_method: breakdown.by_method,
        methods: breakdown.methods
      };
    });

    return res.json({
      date_from: fromStr,
      date_to: toStr,
      daily
    });
  } catch (error) {
    console.error('[getDailyRevenue] Error:', error);
    return res.status(500).json({ error: '無法計算每日營收' });
  }
};

export const getPaymentsList = async (req, res) => {
  const { cursor } = req.query;

  try {
    const where = await buildPaymentsFilterWhere(req.query, REVENUE_PAYMENT_SOURCES);

    const take = 50;
    const [totalCount, payments] = await Promise.all([
      prisma.payment.count({ where }),
      prisma.payment.findMany({
        where,
        orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
        take: take + 1,
        ...(cursor ? { skip: 1, cursor: { id: Number(cursor) } } : {})
      })
    ]);

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

    return res.json({ payments: items, next_cursor: nextCursor, total_count: totalCount });
  } catch (error) {
    console.error('[getPaymentsList] Error:', error);
    return res.status(500).json({ error: '無法讀取收款清單' });
  }
};

export const getPaymentsCsv = async (req, res) => {
  try {
    const where = await buildPaymentsFilterWhere(req.query, REVENUE_PAYMENT_SOURCES);
    const totalCount = await prisma.payment.count({ where });
    if (totalCount > CSV_MAX_ROWS) {
      return res.status(413).json({ error: `資料共 ${totalCount} 筆，超過單次 ${CSV_MAX_ROWS} 筆匯出上限，請縮小日期範圍` });
    }

    const [rows, gs] = await Promise.all([
      prisma.payment.findMany({
        where,
        orderBy: [{ created_at: 'desc' }, { id: 'desc' }]
      }),
      prisma.globalSetting.findUnique({ where: { id: 1 }, select: { payment_methods_json: true } })
    ]);

    const methods = Array.isArray(gs?.payment_methods_json) ? gs.payment_methods_json : [];
    const csv = buildPaymentsCsv(rows, methods);
    const todayStr = toTaipeiDateString(new Date());
    const fromTag = req.query.date_from || todayStr;
    const toTag = req.query.date_to || todayStr;
    const filename = encodeURIComponent(`收款明細_${fromTag}_${toTag}.csv`);

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${filename}`);
    return res.status(200).send(csv);
  } catch (error) {
    console.error('[getPaymentsCsv] Error:', error);
    return res.status(500).json({ error: '無法匯出收款明細 CSV' });
  }
};

export const getEventsList = async (req, res) => {
  const { cursor } = req.query;

  try {
    const where = buildEventsFilterWhere(req.query);

    const take = 50;
    const [totalCount, events] = await Promise.all([
      prisma.accountingEvent.count({ where }),
      prisma.accountingEvent.findMany({
        where,
        orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
        take: take + 1,
        ...(cursor ? { skip: 1, cursor: { id: Number(cursor) } } : {})
      })
    ]);

    const hasMore = events.length > take;
    const items = hasMore ? events.slice(0, take) : events;
    const nextCursor = hasMore ? items[items.length - 1].id : null;

    return res.json({ events: items, next_cursor: nextCursor, total_count: totalCount });
  } catch (error) {
    console.error('[getEventsList] Error:', error);
    return res.status(500).json({ error: '無法讀取異動清單' });
  }
};

export const getEventsCsv = async (req, res) => {
  try {
    const where = buildEventsFilterWhere(req.query);
    const totalCount = await prisma.accountingEvent.count({ where });
    if (totalCount > CSV_MAX_ROWS) {
      return res.status(413).json({ error: `資料共 ${totalCount} 筆，超過單次 ${CSV_MAX_ROWS} 筆匯出上限，請縮小日期範圍` });
    }

    const events = await prisma.accountingEvent.findMany({
      where,
      orderBy: [{ created_at: 'desc' }, { id: 'desc' }]
    });

    const csv = buildEventsCsv(events);
    const todayStr = toTaipeiDateString(new Date());
    const fromTag = req.query.date_from || todayStr;
    const toTag = req.query.date_to || todayStr;
    const filename = encodeURIComponent(`異動紀錄_${fromTag}_${toTag}.csv`);

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${filename}`);
    return res.status(200).send(csv);
  } catch (error) {
    console.error('[getEventsCsv] Error:', error);
    return res.status(500).json({ error: '無法匯出異動紀錄 CSV' });
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
    const { date_from, date_to } = req.query;
    const result = await getUnpaidBookings(prisma, {
      dateFrom: date_from || null,
      dateTo: date_to || null
    });

    return res.json({
      unpaid: result.items,
      count: result.count,
      amount: result.amount,
      no_show_count: result.no_show_count,
      summary: {
        count: result.count,
        amount: result.amount,
        no_show_count: result.no_show_count
      }
    });
  } catch (error) {
    console.error('[getUnpaidFollowUp] Error:', error);
    return res.status(500).json({ error: '無法讀取未結清追蹤' });
  }
};

export default {
  getAccountingSummary,
  getDailyRevenue,
  getLedger,
  getPaymentsList,
  getPaymentsCsv,
  getEventsList,
  getEventsCsv,
  getPrintJobsList,
  getClosingPreview,
  postClosing,
  getClosingsList,
  getUnpaidFollowUp
};
