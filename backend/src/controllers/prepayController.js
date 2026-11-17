import prisma from '../prismaClient.js';
import { toTaipeiDateString } from '../../../shared/time.js';
import { getEffectiveDailyRates } from './reservationController.js';
import {
  ensureKioskSetting,
  getPrepayOptions,
  computeSelfServiceQuote,
  submitRemittanceLast5
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
