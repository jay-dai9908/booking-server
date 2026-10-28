import prisma from '../prismaClient.js';
import { format, startOfWeek, endOfWeek, isWithinInterval } from 'date-fns';

/**
 * Helper to check day of week restriction
 */
const checkDayRestriction = (restriction) => {
  if (!restriction || restriction === 'ALL') return true;
  const day = new Date().getDay(); // 0 is Sunday, 6 is Saturday
  const isWeekend = day === 0 || day === 6;
  if (restriction === 'WEEKDAY_ONLY' && isWeekend) {
    return false;
  }
  if (restriction === 'WEEKEND_ONLY' && !isWeekend) {
    return false;
  }
  return true;
};

/**
 * Helper to inspect usage logs for daily / weekly limits
 */
const checkUsageLimits = (usageLogs, maxPerDay, maxDaysPerWeek, maxHoursPerWeek, deductAmount = 1) => {
  if (!Array.isArray(usageLogs) || usageLogs.length === 0) {
    return { ok: true };
  }

  const now = new Date();
  const todayStr = format(now, 'yyyy-MM-dd');
  const weekStart = startOfWeek(now, { weekStartsOn: 1 });
  const weekEnd = endOfWeek(now, { weekStartsOn: 1 });

  let todayUsedHours = 0;
  const weekDaysUsed = new Set();
  let weekUsedHours = 0;

  for (const log of usageLogs) {
    if (!log.date) continue;
    const logDate = new Date(log.date);
    const logDateStr = format(logDate, 'yyyy-MM-dd');
    const amt = parseInt(log.deducted, 10) || 0;

    if (logDateStr === todayStr) {
      todayUsedHours += amt;
    }

    if (isWithinInterval(logDate, { start: weekStart, end: weekEnd })) {
      weekDaysUsed.add(logDateStr);
      weekUsedHours += amt;
    }
  }

  if (maxPerDay && todayUsedHours + deductAmount > maxPerDay) {
    return {
      ok: false,
      error: `已達每日使用上限（本日已使用 ${todayUsedHours} 小時，上限 ${maxPerDay} 小時）`
    };
  }

  if (maxDaysPerWeek && !weekDaysUsed.has(todayStr) && weekDaysUsed.size >= maxDaysPerWeek) {
    return {
      ok: false,
      error: `已達每週可到店天數上限（本週已到店 ${weekDaysUsed.size} 天，上限 ${maxDaysPerWeek} 天）`
    };
  }

  if (maxHoursPerWeek && weekUsedHours + deductAmount > maxHoursPerWeek) {
    return {
      ok: false,
      error: `已達每週總時數上限（本週已使用 ${weekUsedHours} 小時，上限 ${maxHoursPerWeek} 小時）`
    };
  }

  return { ok: true };
};

/**
 * Admin: Grant pass to a user
 */
export const grantUserPass = async (req, res) => {
  const {
    user_id,
    plan_id,
    custom_quota,
    valid_days,
    day_restriction,
    max_hours_per_day,
    max_days_per_week,
    max_hours_per_week,
    note
  } = req.body;

  if (!user_id) {
    return res.status(400).json({ error: '請指定欲發放卡券之會員' });
  }

  try {
    let plan = null;
    if (plan_id) {
      plan = await prisma.passPlan.findUnique({ where: { id: parseInt(plan_id, 10) } });
    }

    const planName = plan ? plan.name : (note || '手動自訂卡券');
    const passType = plan ? plan.pass_type : 'PUNCH_CARD';
    const totalQuota = custom_quota !== undefined
      ? (custom_quota === null ? null : parseInt(custom_quota, 10))
      : (plan ? plan.total_quota : null);

    const effectiveDays = valid_days !== undefined
      ? (valid_days === null ? null : parseInt(valid_days, 10))
      : (plan ? plan.valid_days : null);

    const expiresAt = effectiveDays ? new Date(Date.now() + effectiveDays * 24 * 60 * 60 * 1000) : null;
    const effectiveDayRestriction = day_restriction || plan?.day_restriction || 'ALL';

    const maxDayHours = max_hours_per_day !== undefined ? (max_hours_per_day ? parseInt(max_hours_per_day, 10) : null) : plan?.max_hours_per_day;
    const maxDaysWeek = max_days_per_week !== undefined ? (max_days_per_week ? parseInt(max_days_per_week, 10) : null) : plan?.max_days_per_week;
    const maxHoursWeek = max_hours_per_week !== undefined ? (max_hours_per_week ? parseInt(max_hours_per_week, 10) : null) : plan?.max_hours_per_week;

    // Generate unique pass_code: PASS-XXXXXXXX
    const passCode = `PASS-${Math.floor(10000000 + Math.random() * 90000000)}`;

    const userPass = await prisma.userPass.create({
      data: {
        pass_code: passCode,
        user_id: parseInt(user_id, 10),
        plan_id: plan ? plan.id : (await prisma.passPlan.findFirst()).id,
        plan_name_snapshot: planName,
        pass_type: passType,
        remaining_quota: totalQuota,
        total_quota: totalQuota,
        day_restriction: effectiveDayRestriction,
        max_hours_per_day: maxDayHours || null,
        max_days_per_week: maxDaysWeek || null,
        max_hours_per_week: maxHoursWeek || null,
        payment_status: 'active',
        expires_at: expiresAt,
        status: 'ACTIVE',
        usage_logs_json: []
      },
      include: {
        user: { select: { id: true, name: true, phone: true } },
        plan: true
      }
    });

    res.json({
      message: `卡券「${planName}」已成功發放給會員！`,
      pass: userPass
    });
  } catch (error) {
    console.error('grantUserPass error:', error);
    res.status(500).json({ error: error.message || '發放卡券失敗' });
  }
};

/**
 * Admin: Redeem / deduct pass quota (via barcode scan or manual click)
 */
export const redeemUserPass = async (req, res) => {
  const { pass_code, user_pass_id, deduct_amount = 1, staff_name = 'admin', note = '' } = req.body;

  try {
    let userPass = null;
    if (pass_code) {
      userPass = await prisma.userPass.findUnique({
        where: { pass_code: String(pass_code).trim() },
        include: { user: true, plan: true }
      });
    } else if (user_pass_id) {
      userPass = await prisma.userPass.findUnique({
        where: { id: parseInt(user_pass_id, 10) },
        include: { user: true, plan: true }
      });
    }

    if (!userPass) {
      return res.status(404).json({ error: '找不到該張卡券或條碼無效' });
    }

    if (userPass.status !== 'ACTIVE') {
      const statusMap = {
        EXHAUSTED: '此卡券次數已全數使用完畢',
        EXPIRED: '此卡券已逾期失效',
        REVOKED: '此卡券已遭停用'
      };
      return res.status(400).json({ error: statusMap[userPass.status] || '此卡券目前非有效狀態' });
    }

    // 1. Check expiration
    if (userPass.expires_at && new Date() > new Date(userPass.expires_at)) {
      await prisma.userPass.update({
        where: { id: userPass.id },
        data: { status: 'EXPIRED' }
      });
      return res.status(400).json({ error: '此卡券已逾期失效' });
    }

    // 2. Check day restriction (weekday vs weekend)
    if (!checkDayRestriction(userPass.day_restriction)) {
      const msg = userPass.day_restriction === 'WEEKDAY_ONLY'
        ? '此卡券僅限週一至週五平日使用，今日為假日不適用！'
        : '此卡券僅限週六週日假日使用，今日為平日不適用！';
      return res.status(400).json({ error: msg });
    }

    // 3. Check daily/weekly usage limits
    const usageLogs = Array.isArray(userPass.usage_logs_json) ? userPass.usage_logs_json : [];
    const limitCheck = checkUsageLimits(
      usageLogs,
      userPass.max_hours_per_day,
      userPass.max_days_per_week,
      userPass.max_hours_per_week,
      deduct_amount
    );
    if (!limitCheck.ok) {
      return res.status(400).json({ error: limitCheck.error });
    }

    // 4. Deduct quota
    let newQuota = userPass.remaining_quota;
    let newStatus = 'ACTIVE';

    if (userPass.remaining_quota !== null) {
      if (userPass.remaining_quota < deduct_amount) {
        return res.status(400).json({
          error: `剩餘次數不足（僅剩 ${userPass.remaining_quota} 次，欲扣抵 ${deduct_amount} 次）`
        });
      }
      newQuota = userPass.remaining_quota - deduct_amount;
      if (newQuota <= 0) {
        newStatus = 'EXHAUSTED';
      }
    }

    const newLog = {
      date: format(new Date(), 'yyyy-MM-dd HH:mm:ss'),
      deducted: deduct_amount,
      staff: staff_name || '門市人員',
      note: note || ''
    };
    const updatedLogs = [...usageLogs, newLog];

    const updated = await prisma.userPass.update({
      where: { id: userPass.id },
      data: {
        remaining_quota: newQuota,
        status: newStatus,
        usage_logs_json: updatedLogs
      },
      include: { user: true, plan: true }
    });

    res.json({
      message: `核銷成功！已成功扣抵 ${deduct_amount} ${userPass.pass_type === 'TIME_PASS' ? '小時' : '次'}。`,
      pass: updated
    });
  } catch (error) {
    console.error('redeemUserPass error:', error);
    res.status(500).json({ error: '卡券核銷失敗' });
  }
};

/**
 * Admin: Get passes of a specific member
 */
export const getUserPassesAdmin = async (req, res) => {
  const { userId } = req.params;
  try {
    const passes = await prisma.userPass.findMany({
      where: { user_id: parseInt(userId, 10) },
      include: { plan: true },
      orderBy: { created_at: 'desc' }
    });
    res.json(passes);
  } catch (error) {
    res.status(500).json({ error: '獲取會員卡券失敗' });
  }
};

/**
 * Customer: Get my passes
 */
export const getMyPasses = async (req, res) => {
  const userId = req.user?.id;
  if (!userId) {
    return res.status(401).json({ error: '尚未登入' });
  }

  try {
    const passes = await prisma.userPass.findMany({
      where: { user_id: userId },
      include: { plan: true },
      orderBy: [{ status: 'asc' }, { created_at: 'desc' }]
    });

    res.json(passes);
  } catch (error) {
    console.error('getMyPasses error:', error);
    res.status(500).json({ error: '獲取我的卡券失敗' });
  }
};

/**
 * Public/Admin: Get pass plan templates
 */
export const getPassPlans = async (req, res) => {
  try {
    const plans = await prisma.passPlan.findMany({
      where: { is_active: true },
      orderBy: { id: 'asc' }
    });
    res.json(plans);
  } catch (error) {
    res.status(500).json({ error: '獲取卡券方案失敗' });
  }
};

/**
 * Admin: Revoke or toggle pass status
 */
export const togglePassStatus = async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;

  try {
    const updated = await prisma.userPass.update({
      where: { id: parseInt(id, 10) },
      data: { status }
    });
    res.json({ message: '卡券狀態已更新', pass: updated });
  } catch (error) {
    res.status(500).json({ error: '更新卡券狀態失敗' });
  }
};
