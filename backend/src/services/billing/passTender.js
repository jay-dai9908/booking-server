import prisma from '../../prismaClient.js';
import { toTaipeiDateString } from '../../../../shared/time.js';

function toDateStrTaipei(dateInput = new Date()) {
  if (typeof dateInput === 'string') {
    const trimmed = dateInput.trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
    if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(trimmed)) return trimmed.slice(0, 10);
  }
  return toTaipeiDateString(dateInput);
}

function getWeekdayFromYmd(ymd) {
  const [y, m, d] = String(ymd).split('-').map(Number);
  if (!y || !m || !d) return new Date().getUTCDay();
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

function getTaipeiWeekBounds(ymd) {
  const [y, m, d] = String(ymd).split('-').map(Number);
  const utcDay = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  const diffToMonday = utcDay === 0 ? -6 : 1 - utcDay;
  const monday = new Date(Date.UTC(y, m - 1, d + diffToMonday));
  const sunday = new Date(Date.UTC(y, m - 1, d + diffToMonday + 6));
  return {
    mondayStr: monday.toISOString().slice(0, 10),
    sundayStr: sunday.toISOString().slice(0, 10)
  };
}

export function checkDayRestrictionForDate(restriction, dateInput) {
  if (!restriction || restriction === 'ALL') return { ok: true };
  const ymd = toDateStrTaipei(dateInput);
  const day = getWeekdayFromYmd(ymd); // 0 is Sunday, 6 is Saturday
  const isWeekend = day === 0 || day === 6;
  if (restriction === 'WEEKDAY_ONLY' && isWeekend) {
    return { ok: false, reason: '今天是假日，這張限平日' };
  }
  if (restriction === 'WEEKEND_ONLY' && !isWeekend) {
    return { ok: false, reason: '這張限假日' };
  }
  return { ok: true };
}

/**
 * Validate pass eligibility for a specific date and intended units (spec 4.5.7)
 */
export function validatePassUsage(userPass, { date = new Date(), units = 1 } = {}) {
  if (!userPass) {
    return { usable: false, reason: '找不到卡券' };
  }

  if (userPass.payment_status && userPass.payment_status !== 'active') {
    return { usable: false, reason: '還沒付款' };
  }

  if (userPass.status === 'EXHAUSTED' || (userPass.remaining_quota !== null && userPass.remaining_quota <= 0)) {
    return { usable: false, reason: '額度用完' };
  }

  if (userPass.status === 'EXPIRED') {
    return { usable: false, reason: '已過期' };
  }

  const targetDateStr = toDateStrTaipei(date);
  if (userPass.expires_at && targetDateStr > toDateStrTaipei(userPass.expires_at)) {
    return { usable: false, reason: '已過期' };
  }

  const dayCheck = checkDayRestrictionForDate(userPass.day_restriction, targetDateStr);
  if (!dayCheck.ok) {
    return { usable: false, reason: dayCheck.reason };
  }

  const usageLogs = Array.isArray(userPass.usage_logs_json) ? userPass.usage_logs_json : [];
  const { mondayStr, sundayStr } = getTaipeiWeekBounds(targetDateStr);

  const dailyNetMap = new Map();
  let weekUsedHours = 0;

  for (const log of usageLogs) {
    const rawLogDate = log.use_date ?? log.date ?? log.at;
    if (!rawLogDate) continue;
    const logDateStr = toDateStrTaipei(rawLogDate);
    if (!logDateStr) continue;
    const rawAmt = Number(log.units ?? log.deducted) || 0;
    const signedAmt = log.type === 'restore' ? -Math.abs(rawAmt) : Math.abs(rawAmt);

    dailyNetMap.set(logDateStr, (dailyNetMap.get(logDateStr) || 0) + signedAmt);
    if (logDateStr >= mondayStr && logDateStr <= sundayStr) {
      weekUsedHours += signedAmt;
    }
  }

  const dateUsedHours = Math.max(0, dailyNetMap.get(targetDateStr) || 0);
  weekUsedHours = Math.max(0, weekUsedHours);
  const weekDaysUsed = new Set();
  for (const [dStr, netVal] of dailyNetMap.entries()) {
    if (dStr >= mondayStr && dStr <= sundayStr && netVal > 0) {
      weekDaysUsed.add(dStr);
    }
  }

  if (userPass.max_hours_per_day && (dateUsedHours + units) > userPass.max_hours_per_day) {
    return {
      usable: false,
      reason: `今天已用 ${dateUsedHours} 小時，達到每日上限`,
      max_units: Math.max(0, userPass.max_hours_per_day - dateUsedHours)
    };
  }

  if (userPass.max_days_per_week && !weekDaysUsed.has(targetDateStr) && weekDaysUsed.size >= userPass.max_days_per_week) {
    return {
      usable: false,
      reason: `這週已用 ${weekDaysUsed.size} 天，達到每週上限`
    };
  }

  if (userPass.max_hours_per_week && (weekUsedHours + units) > userPass.max_hours_per_week) {
    return {
      usable: false,
      reason: `這週已用 ${weekUsedHours} 小時，達到每週上限`
    };
  }

  return { usable: true };
}

/**
 * Deduct pass quota in a transaction (atomic row lock via SELECT ... FOR UPDATE)
 */
export async function deductPass(tx, {
  user_pass_id,
  units = 1,
  booking_ref,
  payment_no,
  person_no,
  staff_name,
  source = 'checkout',
  date = null,
  note = ''
}) {
  if (!Number.isInteger(units) || units <= 0) {
    throw { status: 422, message: '扣抵數量必須為正整數' };
  }

  const run = async (client) => {
    const passId = Number(user_pass_id);
    await client.$queryRaw`SELECT id FROM "UserPass" WHERE id = ${passId} FOR UPDATE`;

    const pass = await client.userPass.findUnique({
      where: { id: passId },
      include: { plan: true }
    });

    if (!pass) {
      throw { status: 404, message: '找不到該卡券' };
    }

    if (pass.status === 'EXHAUSTED' || (pass.remaining_quota !== null && pass.remaining_quota < units)) {
      throw {
        status: 409,
        code: 'PASS_QUOTA_CHANGED',
        message: `卡券額度不足（剩餘 ${pass.remaining_quota ?? 0}，需扣 ${units}）`
      };
    }

    const validation = validatePassUsage(pass, { date: date || new Date(), units });
    if (!validation.usable) {
      throw { status: 422, message: validation.reason };
    }

    let newQuota = pass.remaining_quota;
    let newStatus = pass.status;
    if (pass.remaining_quota !== null) {
      newQuota = pass.remaining_quota - units;
      if (newQuota <= 0) {
        newStatus = 'EXHAUSTED';
      }
    }

    const useDateStr = toDateStrTaipei(date || new Date());
    const usageLogs = Array.isArray(pass.usage_logs_json) ? [...pass.usage_logs_json] : [];
    usageLogs.push({
      at: new Date().toISOString(),
      use_date: useDateStr,
      booking_ref,
      payment_no,
      person_no,
      units,
      by: staff_name || '櫃檯人員',
      source,
      ...(note ? { note: String(note).trim() } : {})
    });

    return await client.userPass.update({
      where: { id: passId },
      data: {
        remaining_quota: newQuota,
        status: newStatus,
        usage_logs_json: usageLogs
      },
      include: { user: true, plan: true }
    });
  };

  if (tx) return await run(tx);
  return await prisma.$transaction(run);
}

/**
 * Restore pass quota when payment is voided or refunded (atomic row lock)
 */
export async function restorePass(tx, {
  user_pass_id,
  units = 1,
  booking_ref,
  payment_no,
  orig_payment_no = null,
  person_no,
  staff_name,
  date = null
}) {
  if (!Number.isInteger(units) || units <= 0) {
    throw { status: 422, message: '退回數量必須為正整數' };
  }

  const run = async (client) => {
    const passId = Number(user_pass_id);
    await client.$queryRaw`SELECT id FROM "UserPass" WHERE id = ${passId} FOR UPDATE`;

    const pass = await client.userPass.findUnique({
      where: { id: passId }
    });

    if (!pass) return null;

    let newQuota = pass.remaining_quota;
    let newStatus = pass.status;
    if (pass.remaining_quota !== null) {
      newQuota = pass.remaining_quota + units;
      if (pass.status === 'EXHAUSTED' && newQuota > 0) {
        newStatus = 'ACTIVE';
      }
    }

    const usageLogs = Array.isArray(pass.usage_logs_json) ? [...pass.usage_logs_json] : [];
    const reversedDeducts = [...usageLogs].reverse().filter(l => l.type !== 'restore');
    const matchedDeduct =
      (orig_payment_no && reversedDeducts.find(l => l.payment_no === orig_payment_no)) ||
      (payment_no && reversedDeducts.find(l => l.payment_no === payment_no)) ||
      (booking_ref && reversedDeducts.find(l => l.booking_ref === booking_ref && (person_no == null || Number(l.person_no) === Number(person_no)))) ||
      (booking_ref && reversedDeducts.find(l => l.booking_ref === booking_ref)) ||
      null;
    const inheritedUseDate = matchedDeduct
      ? toDateStrTaipei(matchedDeduct.use_date ?? matchedDeduct.date ?? matchedDeduct.at)
      : toDateStrTaipei(date || new Date());

    usageLogs.push({
      type: 'restore',
      at: new Date().toISOString(),
      use_date: inheritedUseDate,
      booking_ref,
      payment_no,
      person_no,
      units,
      by: staff_name || '系統'
    });

    return await client.userPass.update({
      where: { id: passId },
      data: {
        remaining_quota: newQuota,
        status: newStatus,
        usage_logs_json: usageLogs
      }
    });
  };

  if (tx) return await run(tx);
  return await prisma.$transaction(run);
}

export default {
  validatePassUsage,
  deductPass,
  restorePass
};
