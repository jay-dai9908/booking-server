import prisma from '../prismaClient.js';
import { toTaipeiDateString } from '../../../shared/time.js';
import { getAdminDeviceInfo } from '../utils/deviceParser.js';
import { log as auditLog } from '../services/audit/auditService.js';
import { queuePrintJob } from '../services/print/printService.js';

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
    const passes = validPayments.filter(p => p.method === 'pass');
    const refunds = validPayments.filter(p => p.kind === 'refund');
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
    const unpaidReservations = await prisma.reservation.findMany({
      where: {
        status: { not: 'cancelled' },
        session: { session_date: { gte: start, lte: end } },
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
      unpaid: {
        count: unpaidCount,
        amount: unpaidAmount
      }
    });
  } catch (error) {
    console.error('[getAccountingSummary] Error:', error);
    return res.status(500).json({ error: '無法讀取帳務摘要', details: error.message });
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
      return {
        id: p.id,
        payment_no: p.payment_no,
        booking_ref: p.booking_ref,
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
        user_name: r?.user?.name || '客人',
        phone: r?.user?.phone || '',
        person_nos: p.person_nos
      };
    });

    return res.json({ ledger });
  } catch (error) {
    console.error('[getLedger] Error:', error);
    return res.status(500).json({ error: '無法讀取交易流水帳', details: error.message });
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
    const items = hasMore ? payments.slice(0, take) : payments;
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

export const getClosingPreview = async (req, res) => {
  const targetDateStr = req.query.date || toTaipeiDateString(new Date());

  try {
    const start = new Date(`${targetDateStr}T00:00:00+08:00`);
    const end = new Date(`${targetDateStr}T23:59:59.999+08:00`);

    const globalSetting = await prisma.globalSetting.findFirst() || {};
    const floatAmount = globalSetting.cash_float_amount ?? 2000;

    const payments = await prisma.payment.findMany({
      where: { created_at: { gte: start, lte: end } }
    });

    const validPayments = payments.filter(p => p.status === 'valid');
    const charges = validPayments.filter(p => (p.kind === 'charge' || p.kind === 'supplement') && p.method !== 'pass');
    const passes = validPayments.filter(p => p.method === 'pass');
    const refunds = validPayments.filter(p => p.kind === 'refund');
    const voids = payments.filter(p => p.status === 'voided');

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

    const totalIncome = charges.reduce((sum, p) => sum + p.amount, 0);
    const totalRefund = refunds.reduce((sum, p) => sum + p.amount, 0);
    const netRevenue = totalIncome - totalRefund;

    const cashIncome = charges.filter(p => p.method === 'cash').reduce((sum, p) => sum + p.amount, 0);
    const cashRefund = refunds.filter(p => p.method === 'cash').reduce((sum, p) => sum + p.amount, 0);
    const expectedCash = floatAmount + cashIncome - cashRefund;

    // Unpaid today
    const unpaidRes = await prisma.reservation.findMany({
      where: {
        status: { not: 'cancelled' },
        session: { session_date: { gte: start, lte: end } },
        billing_status: { in: ['unpaid', 'partial'] }
      }
    });

    const unpaidMap = new Map();
    for (const r of unpaidRes) {
      if (!unpaidMap.has(r.booking_ref)) {
        unpaidMap.set(r.booking_ref, (r.amount_due || 0) - (r.amount_received || 0));
      }
    }
    const unpaidCount = unpaidMap.size;
    const unpaidAmount = Array.from(unpaidMap.values()).reduce((sum, amt) => sum + Math.max(0, amt), 0);

    return res.json({
      date: targetDateStr,
      float_amount: floatAmount,
      expected_cash: expectedCash,
      net_revenue: netRevenue,
      by_method: byMethod,
      refunds: refundsByMethod,
      voids: {
        count: voids.length,
        amount: voids.reduce((sum, p) => sum + p.amount, 0)
      },
      passes: {
        count: passes.length,
        amount: passes.reduce((sum, p) => sum + p.amount, 0)
      },
      unpaid: {
        count: unpaidCount,
        amount: unpaidAmount
      }
    });
  } catch (error) {
    console.error('[getClosingPreview] Error:', error);
    return res.status(500).json({ error: '無法計算日結預覽' });
  }
};

export const postClosing = async (req, res) => {
  const { date, float_amount, counted_cash, note = '', print = true } = req.body;
  const staffName = req.user?.name || '門市人員';
  const staffId = req.user?.id || null;
  const deviceInfo = getAdminDeviceInfo(req);

  try {
    const targetDateStr = date || toTaipeiDateString(new Date());
    const previewData = await (async () => {
      const start = new Date(`${targetDateStr}T00:00:00+08:00`);
      const end = new Date(`${targetDateStr}T23:59:59.999+08:00`);
      const payments = await prisma.payment.findMany({
        where: { created_at: { gte: start, lte: end } }
      });
      const validPayments = payments.filter(p => p.status === 'valid');
      const charges = validPayments.filter(p => (p.kind === 'charge' || p.kind === 'supplement') && p.method !== 'pass');
      const refunds = validPayments.filter(p => p.kind === 'refund');
      const cashIncome = charges.filter(p => p.method === 'cash').reduce((sum, p) => sum + p.amount, 0);
      const cashRefund = refunds.filter(p => p.method === 'cash').reduce((sum, p) => sum + p.amount, 0);
      const floatAmt = Number(float_amount);
      const expCash = floatAmt + cashIncome - cashRefund;
      return { expCash, floatAmt };
    })();

    const counted = Number(counted_cash);
    const difference = counted - previewData.expCash;

    const closing = await prisma.$transaction(async (tx) => {
      const created = await tx.cashClosing.create({
        data: {
          business_date: new Date(`${targetDateStr}T00:00:00+08:00`),
          float_amount: previewData.floatAmt,
          expected_cash: previewData.expCash,
          counted_cash: counted,
          difference,
          totals_json: {
            date: targetDateStr,
            difference,
            snapshot_at: new Date().toISOString()
          },
          note: note ? String(note).trim() : null,
          staff_name: staffName,
          device_label: deviceInfo.device_label
        }
      });

      await auditLog(tx, {
        event_type: 'day_closed',
        category: 'closing',
        summary: `日結交班完成 · 實點現金 NT$${counted}（${difference >= 0 ? '+' : ''}${difference}）`,
        amount: counted,
        staff_name: staffName,
        staff_id: staffId,
        device_id: deviceInfo.device_id,
        device_label: deviceInfo.device_label
      });

      return created;
    });

    let printJob = null;
    if (print) {
      try {
        printJob = await queuePrintJob({
          type: 'closing',
          closing_id: closing.id,
          user: req.user,
          device: deviceInfo
        });
      } catch (err) {
        console.error('[postClosing] Print error:', err);
      }
    }

    return res.json({ success: true, closing, print_job: printJob });
  } catch (error) {
    console.error('[postClosing] Error:', error);
    return res.status(500).json({ error: '日結存檔失敗', details: error.message });
  }
};

export const getClosingsList = async (req, res) => {
  try {
    const closings = await prisma.cashClosing.findMany({
      orderBy: { business_date: 'desc' },
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
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const unpaidRes = await prisma.reservation.findMany({
      where: {
        status: { not: 'cancelled' },
        session: { session_date: { lte: today } },
        billing_status: { in: ['unpaid', 'partial'] }
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
          user: r.user,
          date: r.session.session_date,
          status: r.billing_status || 'unpaid',
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
