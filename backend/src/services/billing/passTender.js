import prisma from '../../prismaClient.js';
import { toTaipeiDateString } from '../../../../shared/time.js';

export function checkDayRestrictionForDate(restriction, dateInput) {
  if (!restriction || restriction === 'ALL') return { ok: true };
  const d = new Date(dateInput);
  const day = d.getDay(); // 0 is Sunday, 6 is Saturday
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

  if (userPass.expires_at && new Date(date) > new Date(userPass.expires_at)) {
    return { usable: false, reason: '已過期' };
  }

  const dayCheck = checkDayRestrictionForDate(userPass.day_restriction, date);
  if (!dayCheck.ok) {
    return { usable: false, reason: dayCheck.reason };
  }

  const usageLogs = Array.isArray(userPass.usage_logs_json) ? userPass.usage_logs_json : [];
  const targetDateStr = typeof date === 'string' ? date.slice(0, 10) : toTaipeiDateString(date);

  // Compute usage on target date and target week
  const d = new Date(date);
  const dayOfWeek = d.getDay();
  const diffToMonday = d.getDate() - dayOfWeek + (dayOfWeek === 0 ? -6 : 1);
  const monday = new Date(d);
  monday.setDate(diffToMonday);
  monday.setHours(0, 0, 0, 0);
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  sunday.setHours(23, 59, 59, 999);

  let dateUsedHours = 0;
  const weekDaysUsed = new Set();
  let weekUsedHours = 0;

  for (const log of usageLogs) {
    if (!log.date && !log.at) continue;
    const logDate = new Date(log.date || log.at);
    const logDateStr = toTaipeiDateString(logDate);
    const amt = parseInt(log.deducted || log.units, 10) || 0;

    if (logDateStr === targetDateStr) {
      dateUsedHours += amt;
    }
    if (logDate >= monday && logDate <= sunday) {
      weekDaysUsed.add(logDateStr);
      weekUsedHours += amt;
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
 * Deduct pass quota in a transaction
 */
export async function deductPass(tx, {
  user_pass_id,
  units = 1,
  booking_ref,
  payment_no,
  person_no,
  staff_name
}) {
  const client = tx || prisma;
  const pass = await client.userPass.findUnique({
    where: { id: user_pass_id },
    include: { plan: true }
  });

  if (!pass) throw new Error('找不到該卡券');

  let newQuota = pass.remaining_quota;
  let newStatus = pass.status;
  if (pass.remaining_quota !== null) {
    if (pass.remaining_quota < units) {
      throw new Error(`卡券額度不足（剩餘 ${pass.remaining_quota}，需扣 ${units}）`);
    }
    newQuota = pass.remaining_quota - units;
    if (newQuota <= 0) {
      newStatus = 'EXHAUSTED';
    }
  }

  const usageLogs = Array.isArray(pass.usage_logs_json) ? [...pass.usage_logs_json] : [];
  usageLogs.push({
    at: new Date().toISOString(),
    booking_ref,
    payment_no,
    person_no,
    units,
    by: staff_name || '櫃檯人員',
    source: 'checkout'
  });

  return await client.userPass.update({
    where: { id: user_pass_id },
    data: {
      remaining_quota: newQuota,
      status: newStatus,
      usage_logs_json: usageLogs
    }
  });
}

/**
 * Restore pass quota when payment is voided or refunded
 */
export async function restorePass(tx, {
  user_pass_id,
  units = 1,
  booking_ref,
  payment_no,
  person_no,
  staff_name
}) {
  const client = tx || prisma;
  const pass = await client.userPass.findUnique({
    where: { id: user_pass_id }
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
  usageLogs.push({
    type: 'restore',
    at: new Date().toISOString(),
    booking_ref,
    payment_no,
    person_no,
    units,
    by: staff_name || '系統'
  });

  return await client.userPass.update({
    where: { id: user_pass_id },
    data: {
      remaining_quota: newQuota,
      status: newStatus,
      usage_logs_json: usageLogs
    }
  });
}

export default {
  validatePassUsage,
  deductPass,
  restorePass
};
