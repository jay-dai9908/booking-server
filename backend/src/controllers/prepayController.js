import prisma from '../prismaClient.js';
import { toTaipeiDateString } from '../../../shared/time.js';
import { earliestEntry } from '../../../shared/selfService.js';
import { getEffectiveDailyRates } from './reservationController.js';
import { getBookingBill } from '../services/billing/billService.js';
import { getAdminDeviceInfo } from '../utils/deviceParser.js';
import { markPoolAccountUsed } from '../services/selfService/poolAccountService.js';
import {
  sendSelfServiceVerifiedNotification,
  sendSelfServiceMismatchNotification,
  sendSelfServiceRemindNotification
} from '../utils/lineMessaging.js';
import {
  ensureKioskSetting,
  getPrepayOptions,
  computeSelfServiceQuote,
  submitRemittanceLast5,
  settleSelfServiceBooking,
  lockPrepay
} from '../services/selfService/prepayService.js';

export const getPrepayOptionsHandler = async (req, res) => {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: '請先登入' });

  const dateRaw = req.query.date;
  if (!dateRaw || !/^\d{4}-\d{2}-\d{2}$/.test(String(dateRaw))) {
    return res.status(400).json({ error: '請提供正確的日期 (YYYY-MM-DD)' });
  }
  const pax = Math.max(1, parseInt(req.query.pax, 10) || 1);

  try {
    const data = await getPrepayOptions(prisma, {
      userId,
      dateStr: String(dateRaw),
      pax
    });
    res.json(data);
  } catch (err) {
    console.error('[prepayController] getPrepayOptions error:', err);
    res.status(500).json({ error: '取得半自助日付款選項失敗' });
  }
};

export const postPrepayQuoteHandler = async (req, res) => {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: '請先登入' });

  const {
    session_ids = [],
    pax = 1,
    isUnlimited = true,
    equipments = [],
    promo_code = null,
    pass_uses = []
  } = req.body || {};

  const parsedPax = parseInt(pax, 10);
  if (!Array.isArray(session_ids) || session_ids.length === 0 || !Number.isInteger(parsedPax) || parsedPax < 1) {
    return res.status(400).json({ error: '請提供有效的時段與人數' });
  }

  try {
    const sessions = await prisma.session.findMany({
      where: { id: { in: session_ids.map(Number).filter(Boolean) } },
      orderBy: { start_time: 'asc' }
    });
    if (sessions.length !== session_ids.length) {
      return res.status(404).json({ error: '找不到指定的時段' });
    }

    const uniqueDates = new Set(sessions.map((s) => toTaipeiDateString(s.session_date)));
    if (uniqueDates.size > 1) {
      return res.status(400).json({ error: '一筆預約只能包含同一天的時段' });
    }

    const sessionDate = sessions[0].session_date;
    const dateStr = toTaipeiDateString(sessionDate);
    const dateObj = new Date(`${dateStr}T00:00:00.000Z`);

    const [dailySetting, dailyRates, kioskSetting] = await Promise.all([
      prisma.dailySetting.findUnique({ where: { date: dateObj } }),
      getEffectiveDailyRates(prisma, sessionDate),
      ensureKioskSetting(prisma)
    ]);

    if (!dailySetting?.is_self_service) {
      return res.status(400).json({ error: '這天不是半自助日' });
    }

    const quote = await computeSelfServiceQuote(prisma, {
      userId,
      requestedSessions: sessions,
      dailySetting,
      dailyRates,
      kioskSetting,
      pax: parsedPax,
      isUnlimited: isUnlimited === true,
      equipments,
      promoCode: promo_code,
      passUses: pass_uses,
      strict: false,
      skipUsageCheck: false
    });

    res.json({
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
      deadline_at: quote.deadline_at,
      errors: quote.errors
    });
  } catch (err) {
    console.error('[prepayController] postPrepayQuote error:', err);
    if (err.isPrepayError) {
      return res.status(err.status || 400).json({ error: err.message, code: err.code });
    }
    res.status(500).json({ error: '計算半自助預約金額失敗' });
  }
};

export const patchRemittanceLast5Handler = async (req, res) => {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: '請先登入' });

  const { booking_ref } = req.params;
  const { remittance_last5 } = req.body || {};

  try {
    const updated = await submitRemittanceLast5(prisma, {
      bookingRef: booking_ref,
      userId,
      last5: remittance_last5
    });
    res.json({
      message: '已回報匯款末五碼，請等候對帳',
      prepay: updated
    });
  } catch (err) {
    if (err.isPrepayError) {
      return res.status(err.status || 400).json({ error: err.message, code: err.code });
    }
    console.error('[prepayController] patchRemittanceLast5 error:', err);
    res.status(500).json({ error: '回報匯款末五碼失敗' });
  }
};

const PREPAY_SORT_PRIORITY = {
  reported_pending_verify: 0,
  mismatch: 1,
  pending_payment: 2,
  verified: 3,
  expired: 4,
  cancelled: 5
};

/**
 * 後台：取得半自助預約預付對帳清單
 */
export const getAdminPrepaysHandler = async (req, res) => {
  const { status = '', date = '' } = req.query;

  try {
    const [prepays, methodConfigs] = await Promise.all([
      prisma.bookingPrepay.findMany({
        orderBy: [{ created_at: 'desc' }]
      }),
      prisma.paymentMethodConfig.findMany({
        select: { code: true, name: true }
      })
    ]);

    const methodMap = new Map(methodConfigs.map((m) => [m.code, m.name]));
    const refs = prepays.map((p) => p.booking_ref);

    const [reservations, equipments] = refs.length
      ? await Promise.all([
          prisma.reservation.findMany({
            where: { booking_ref: { in: refs } },
            include: {
              session: true,
              user: {
                select: { id: true, name: true, phone: true, line_user_id: true }
              }
            },
            orderBy: { session: { start_time: 'asc' } }
          }),
          prisma.bookingEquipment.findMany({
            where: { booking_ref: { in: refs } }
          })
        ])
      : [[], []];

    const resByRef = new Map();
    for (const r of reservations) {
      if (!resByRef.has(r.booking_ref)) {
        resByRef.set(r.booking_ref, []);
      }
      resByRef.get(r.booking_ref).push(r);
    }

    const eqCountByRef = new Map();
    for (const eq of equipments) {
      if (eq.equipment_id === 'bring_own') continue;
      eqCountByRef.set(eq.booking_ref, (eqCountByRef.get(eq.booking_ref) || 0) + (eq.quantity || 1));
    }

    const now = new Date();
    const enriched = [];

    for (const p of prepays) {
      const rList = resByRef.get(p.booking_ref) || [];
      const sortedSess = rList
        .map((r) => r.session)
        .filter(Boolean)
        .sort((a, b) => a.start_time.localeCompare(b.start_time));
      const firstSess = sortedSess[0];
      const lastSess = sortedSess[sortedSess.length - 1];
      const sessionDateStr = firstSess ? toTaipeiDateString(firstSess.session_date) : '';

      if (date && sessionDateStr !== String(date)) {
        continue;
      }

      const firstRes = rList[0];
      const user = firstRes?.user || null;
      const isOverdue =
        Boolean(p.deadline_at) &&
        now > new Date(p.deadline_at) &&
        (p.status === 'reported_pending_verify' || p.status === 'mismatch');

      enriched.push({
        id: p.id,
        booking_ref: p.booking_ref,
        user_id: p.user_id,
        user_name: user?.name || '未設定',
        user_phone: user?.phone || '',
        session_date: sessionDateStr,
        start_time: firstSess?.start_time || '',
        end_time: lastSess?.end_time || '',
        pax: firstRes?.pax || 1,
        pass_persons: p.pass_persons || 0,
        pass_holds: p.pass_holds || [],
        board_count: eqCountByRef.get(p.booking_ref) || 0,
        total_amount: p.total_amount,
        amount_due: p.amount_due,
        status: p.status,
        is_overdue: isOverdue,
        payment_method_code: p.payment_method_code,
        payment_method_name: p.payment_method_code
          ? methodMap.get(p.payment_method_code) || p.payment_method_code
          : p.amount_due === 0
          ? '計次卡全額折抵'
          : '銀行匯款',
        selected_bank_info: p.selected_bank_info,
        assigned_pool_account: p.assigned_pool_account,
        remittance_last5: p.remittance_last5,
        remittance_reported_at: p.remittance_reported_at,
        deadline_at: p.deadline_at,
        verified_at: p.verified_at,
        verified_by_name: p.verified_by_name,
        reminded_at: p.reminded_at,
        admin_note: p.admin_note,
        created_at: p.created_at
      });
    }

    const counts = {
      pending_payment: enriched.filter((x) => x.status === 'pending_payment' && x.amount_due > 0).length,
      reported_pending_verify: enriched.filter(
        (x) => (x.status === 'reported_pending_verify' || x.status === 'mismatch') && x.amount_due > 0
      ).length,
      verified: enriched.filter((x) => x.status === 'verified').length,
      expired: enriched.filter((x) => x.status === 'expired').length
    };

    const filtered = enriched.filter((x) => {
      if (!status || status === 'all') {
        return true;
      }
      if (status === 'pending_payment') {
        return x.status === 'pending_payment' && x.amount_due > 0;
      }
      if (status === 'reported_pending_verify' || status === 'reported') {
        return (x.status === 'reported_pending_verify' || x.status === 'mismatch') && x.amount_due > 0;
      }
      return x.status === status;
    });

    filtered.sort((a, b) => {
      const pa = PREPAY_SORT_PRIORITY[a.status] ?? 99;
      const pb = PREPAY_SORT_PRIORITY[b.status] ?? 99;
      if (pa !== pb) return pa - pb;
      if (a.session_date && b.session_date && a.session_date !== b.session_date) {
        return a.session_date.localeCompare(b.session_date);
      }
      return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
    });

    res.json({ items: filtered, counts });
  } catch (err) {
    console.error('[prepayController] getAdminPrepays error:', err);
    res.status(500).json({ error: '取得半自助對帳清單失敗' });
  }
};

/**
 * 後台：確認收款並一次入帳
 */
export const verifyAdminPrepayHandler = async (req, res) => {
  const { booking_ref } = req.params;
  const staffName = req.user?.name || '管理員';
  const staffId = req.user?.id || null;
  const deviceInfo = getAdminDeviceInfo(req);

  try {
    const txResult = await prisma.$transaction(async (tx) => {
      const prepay = await lockPrepay(tx, booking_ref);
      if (!prepay) {
        return { errorStatus: 404, errorBody: { error: '找不到這筆半自助預付紀錄' } };
      }

      if (prepay.status === 'verified' && prepay.settled_at) {
        return { alreadyVerified: true, prepay };
      }

      const resRows = await tx.reservation.findMany({
        where: { booking_ref },
        select: { id: true, status: true }
      });
      if (resRows.length === 0 || resRows.some((r) => r.status !== 'confirmed')) {
        return { errorStatus: 409, errorBody: { error: '這筆預約已取消，不能入帳' } };
      }

      if (!['pending_payment', 'reported_pending_verify', 'mismatch'].includes(prepay.status)) {
        return {
          errorStatus: 409,
          errorBody: { error: `目前狀態 (${prepay.status}) 不可執行對帳確認` }
        };
      }

      // Recompute authoritative bill before settling
      const billData = await getBookingBill(booking_ref, tx);
      const bill = billData.bill;
      const passHolds = Array.isArray(prepay.pass_holds) ? prepay.pass_holds : [];
      const passPersonNos = new Set();
      let nextFallbackNo = Math.max(1, (bill.persons?.length || 1) - (prepay.pass_persons || 0) + 1);
      for (const hold of passHolds) {
        const pNos = Array.isArray(hold.person_nos) && hold.person_nos.length > 0
          ? hold.person_nos
          : Array.from({ length: hold.units || 0 }, () => nextFallbackNo++);
        for (const pNo of pNos) passPersonNos.add(Number(pNo));
      }

      let recalcPassCover = 0;
      for (const pBill of bill.persons || []) {
        if (passPersonNos.has(Number(pBill.person_no))) {
          recalcPassCover += Math.min(pBill.entry?.amount || 0, pBill.total || pBill.entry?.amount || 0);
        }
      }
      const recalcTransfer = Math.max(0, (bill.summary?.amount_due ?? 0) - recalcPassCover);

      if (recalcTransfer !== prepay.amount_due) {
        return {
          errorStatus: 409,
          errorBody: {
            error: `帳單應匯金額（NT$${recalcTransfer}）與預付金額（NT$${prepay.amount_due}）不符，請檢查明細`,
            code: 'AMOUNT_CHANGED',
            expected_amount: prepay.amount_due,
            recalculated_amount: recalcTransfer
          }
        };
      }

      const settled = await settleSelfServiceBooking(tx, {
        booking_ref,
        staffName,
        staffId,
        deviceInfo
      });

      if (prepay.assigned_pool_account) {
        await markPoolAccountUsed(tx, {
          accountNumber: prepay.assigned_pool_account,
          orderRef: booking_ref
        });
      }

      return { alreadyVerified: false, prepay: settled.prepay, billing_status: settled.billing_status };
    });

    if (txResult.errorStatus) {
      return res.status(txResult.errorStatus).json(txResult.errorBody);
    }

    if (!txResult.alreadyVerified) {
      // Push LINE confirmation best-effort
      try {
        const [resRows, kioskSetting] = await Promise.all([
          prisma.reservation.findMany({
            where: { booking_ref },
            include: {
              session: true,
              user: { select: { id: true, name: true, line_user_id: true } }
            }
          }),
          ensureKioskSetting(prisma)
        ]);
        const user = resRows[0]?.user;
        const sortedSess = resRows
          .map((r) => r.session)
          .filter(Boolean)
          .sort((a, b) => a.start_time.localeCompare(b.start_time));
        if (user?.line_user_id && sortedSess.length > 0) {
          const openAt = earliestEntry(sortedSess[0].start_time, kioskSetting?.early_minutes ?? 30);
          const timeRange = `${sortedSess[0].start_time}-${sortedSess[sortedSess.length - 1].end_time}`;
          await sendSelfServiceVerifiedNotification(
            {
              booking_ref,
              session_date: sortedSess[0].session_date,
              time_range: timeRange,
              open_at: openAt
            },
            user
          );
        }
      } catch (lineErr) {
        console.warn('[prepayController] verify LINE notify failed:', lineErr.message);
      }
    }

    res.json({
      message: txResult.alreadyVerified ? '此筆款項已完成對帳' : '確認收款完成並已入帳',
      alreadyVerified: txResult.alreadyVerified,
      prepay: txResult.prepay
    });
  } catch (err) {
    if (err.isPrepayError) {
      return res.status(err.status || 400).json({ error: err.message, code: err.code });
    }
    console.error('[prepayController] verifyAdminPrepay error:', err);
    res.status(500).json({ error: '對帳確認失敗' });
  }
};

/**
 * 後台：標記匯款金額不符
 */
export const mismatchAdminPrepayHandler = async (req, res) => {
  const { booking_ref } = req.params;
  const { note = '' } = req.body || {};
  const cleanNote = String(note || '').trim();

  if (!cleanNote) {
    return res.status(400).json({ error: '請填寫金額不符說明／備註' });
  }

  try {
    const txResult = await prisma.$transaction(async (tx) => {
      const prepay = await lockPrepay(tx, booking_ref);
      if (!prepay) {
        return { errorStatus: 404, errorBody: { error: '找不到這筆預付紀錄' } };
      }
      const resRows = await tx.reservation.findMany({
        where: { booking_ref },
        select: { id: true, status: true }
      });
      if (resRows.length === 0 || resRows.some((r) => r.status !== 'confirmed')) {
        return { errorStatus: 409, errorBody: { error: '這筆預約已取消，不可標記金額不符' } };
      }
      if (!['pending_payment', 'reported_pending_verify', 'mismatch'].includes(prepay.status)) {
        return { errorStatus: 409, errorBody: { error: `目前狀態 (${prepay.status}) 不可標記金額不符` } };
      }

      const updated = await tx.bookingPrepay.update({
        where: { booking_ref },
        data: {
          status: 'mismatch',
          admin_note: cleanNote
        }
      });
      return { updated };
    });

    if (txResult.errorStatus) {
      return res.status(txResult.errorStatus).json(txResult.errorBody);
    }

    const updated = txResult.updated;

    try {
      const user = await prisma.user.findUnique({
        where: { id: updated.user_id },
        select: { id: true, name: true, line_user_id: true }
      });
      await sendSelfServiceMismatchNotification(
        {
          booking_ref,
          amount_due: updated.amount_due,
          note: cleanNote
        },
        user
      );
    } catch (lineErr) {
      console.warn('[prepayController] mismatch LINE notify failed:', lineErr.message);
    }

    res.json({ message: '已標記金額不符並通知顧客', prepay: updated });
  } catch (err) {
    console.error('[prepayController] mismatchAdminPrepay error:', err);
    res.status(500).json({ error: '標記金額不符失敗' });
  }
};

/**
 * 後台：催款提醒（限 pending_payment，一小時內限按一次）
 */
export const remindAdminPrepayHandler = async (req, res) => {
  const { booking_ref } = req.params;

  try {
    const prepay = await prisma.bookingPrepay.findUnique({ where: { booking_ref } });
    if (!prepay) {
      return res.status(404).json({ error: '找不到這筆預付紀錄' });
    }
    if (prepay.status !== 'pending_payment') {
      return res.status(409).json({ error: '僅待付款狀態可發送匯款提醒' });
    }

    const now = new Date();
    if (prepay.reminded_at && now.getTime() - new Date(prepay.reminded_at).getTime() < 60 * 60 * 1000) {
      return res.status(429).json({ error: '一小時內已提醒過，請稍後再試', code: 'REMIND_COOLDOWN' });
    }

    const updated = await prisma.bookingPrepay.update({
      where: { booking_ref },
      data: { reminded_at: now }
    });

    try {
      const [firstRes, user] = await Promise.all([
        prisma.reservation.findFirst({
          where: { booking_ref },
          include: { session: true }
        }),
        prisma.user.findUnique({
          where: { id: prepay.user_id },
          select: { id: true, name: true, line_user_id: true }
        })
      ]);
      await sendSelfServiceRemindNotification(
        {
          booking_ref,
          session_date: firstRes?.session?.session_date,
          amount_due: prepay.amount_due,
          deadline_at: prepay.deadline_at
        },
        user
      );
    } catch (lineErr) {
      console.warn('[prepayController] remind LINE notify failed:', lineErr.message);
    }

    res.json({ message: '已發送匯款提醒', prepay: updated });
  } catch (err) {
    console.error('[prepayController] remindAdminPrepay error:', err);
    res.status(500).json({ error: '發送匯款提醒失敗' });
  }
};
