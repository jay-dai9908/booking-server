import prisma from '../prismaClient.js';
import { deductPass } from '../services/billing/passTender.js';
import { log as auditLog } from '../services/audit/auditService.js';
import { getAdminDeviceInfo } from '../utils/deviceParser.js';

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
  const { pass_code, user_pass_id, deduct_amount = 1, note = '' } = req.body;
  const staffName = req.user?.name || '門市人員';
  const staffId = req.user?.id || null;
  const deviceInfo = getAdminDeviceInfo(req);

  const rawUnits = req.body.deduct_amount === undefined ? 1 : req.body.deduct_amount;
  const parsedUnits = (typeof rawUnits === 'boolean' || rawUnits === null || String(rawUnits).trim() === '')
    ? NaN
    : Number(rawUnits);

  if (req.body.deduct_amount !== undefined && (!Number.isInteger(parsedUnits) || parsedUnits <= 0)) {
    return res.status(422).json({ error: '扣抵數量必須為正整數' });
  }

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
      // Dual-use scanner check: if pass_code matches a reservation booking_ref or short BK-XXXX-XXXX
      if (pass_code) {
        const rawCode = String(pass_code).trim();
        let reservation = await prisma.reservation.findFirst({
          where: {
            booking_ref: rawCode,
            status: { not: 'cancelled' }
          },
          include: { user: true, session: true }
        });

        // Match BK-XXXX-XXXX short code if needed
        if (!reservation && rawCode.startsWith('BK-')) {
          const parts = rawCode.replace('BK-', '').split('-');
          if (parts.length === 2) {
            reservation = await prisma.reservation.findFirst({
              where: {
                booking_ref: {
                  startsWith: parts[0],
                  endsWith: parts[1]
                },
                status: { not: 'cancelled' }
              },
              include: { user: true, session: true }
            });
          }
        }

        if (reservation) {
          const alreadyCheckedIn = reservation.attendance === 'checked_in';

          await prisma.reservation.updateMany({
            where: { booking_ref: reservation.booking_ref },
            data: {
              attendance: 'checked_in',
              checked_in_at: new Date()
            }
          });

          return res.json({
            message: alreadyCheckedIn
              ? `✅ 顧客 ${reservation.user?.name || ''} 原已於稍早報到，再次確認報到成功！`
              : `✅ 預約報到核銷成功！顧客 ${reservation.user?.name || ''} 已完成現場報到。`,
            reservation_checked_in: true,
            reservation: {
              booking_ref: reservation.booking_ref,
              user_name: reservation.user?.name,
              session_date: reservation.session?.session_date,
              time: `${reservation.session?.start_time} - ${reservation.session?.end_time}`,
              pax: reservation.pax
            },
            pass: {
              user: reservation.user,
              remaining_quota: null
            }
          });
        }
      }

      return res.status(404).json({ error: '找不到該張卡券或預約單號，請確認條碼是否正確' });
    }

    if (!Number.isInteger(parsedUnits) || parsedUnits <= 0) {
      return res.status(422).json({ error: '扣抵數量必須為正整數' });
    }

    if (userPass.status === 'REVOKED') {
      return res.status(400).json({ error: '此卡券已遭停用' });
    }

    const updated = await prisma.$transaction(async (tx) => {
      const deducted = await deductPass(tx, {
        user_pass_id: userPass.id,
        units: parsedUnits,
        staff_name: staffName,
        source: 'manual_redeem',
        date: new Date(),
        note
      });

      const codeTail = String(deducted.pass_code || '').slice(-4);
      const unitLabel = deducted.pass_type === 'TIME_PASS' ? '小時' : '次';
      await auditLog(tx, {
        event_type: 'pass_redeemed_manual',
        category: 'pass',
        summary: `手動核銷卡券 · *${codeTail} · ${parsedUnits} ${unitLabel}`,
        reason: note ? String(note).trim() : null,
        before_json: {
          user_pass_id: deducted.id,
          remaining_quota: deducted.remaining_quota !== null ? deducted.remaining_quota + parsedUnits : null
        },
        after_json: {
          user_pass_id: deducted.id,
          units: parsedUnits,
          remaining_quota: deducted.remaining_quota
        },
        staff_name: staffName,
        staff_id: staffId,
        device_id: deviceInfo?.device_id,
        device_label: deviceInfo?.device_label || '管理後台'
      });

      return deducted;
    });

    res.json({
      message: `核銷成功！已成功扣抵 ${parsedUnits} ${updated.pass_type === 'TIME_PASS' ? '小時' : '次'}。`,
      pass: updated
    });
  } catch (error) {
    console.error('redeemUserPass error:', error);
    if (error.status) {
      return res.status(error.status).json({
        error: error.message,
        ...(error.code ? { code: error.code } : {})
      });
    }
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
 * Public: Get active pass plan templates only
 */
export const getPassPlans = async (_req, res) => {
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
 * Admin: Get all pass plan templates (including inactive)
 */
export const getAdminPassPlans = async (_req, res) => {
  try {
    const plans = await prisma.passPlan.findMany({
      where: {},
      orderBy: { id: 'asc' }
    });
    res.json(plans);
  } catch (error) {
    res.status(500).json({ error: '獲取卡券方案失敗' });
  }
};

/**
 * Admin: Create pass plan template
 */
export const createPassPlan = async (req, res) => {
  try {
    const {
      name,
      pass_type,
      price,
      original_value,
      total_quota,
      unit_name,
      description,
      max_hours_per_day,
      max_days_per_week,
      max_hours_per_week,
      valid_days,
      day_restriction,
      is_active,
      checkout_effect,
      checkout_scope,
      checkout_value
    } = req.body;

    if (!name || !pass_type) {
      return res.status(400).json({ error: '方案名稱與類型為必填' });
    }

    const created = await prisma.passPlan.create({
      data: {
        name,
        pass_type,
        price: parseInt(price, 10) || 0,
        original_value: parseInt(original_value, 10) || parseInt(price, 10) || 0,
        total_quota: parseInt(total_quota, 10) || 1,
        unit_name: unit_name || '次',
        description: description || null,
        max_hours_per_day: max_hours_per_day != null && max_hours_per_day !== '' ? parseInt(max_hours_per_day, 10) : null,
        max_days_per_week: max_days_per_week != null && max_days_per_week !== '' ? parseInt(max_days_per_week, 10) : null,
        max_hours_per_week: max_hours_per_week != null && max_hours_per_week !== '' ? parseInt(max_hours_per_week, 10) : null,
        valid_days: valid_days != null && valid_days !== '' ? parseInt(valid_days, 10) : null,
        day_restriction: day_restriction || 'ALL',
        is_active: is_active !== false,
        checkout_effect: checkout_effect || null,
        checkout_scope: checkout_scope || 'entry',
        checkout_value: checkout_value != null && checkout_value !== '' ? parseInt(checkout_value, 10) : null
      }
    });

    res.status(201).json(created);
  } catch (error) {
    console.error('createPassPlan error:', error);
    res.status(500).json({ error: '建立卡券方案失敗' });
  }
};

/**
 * Admin: Update pass plan template
 */
export const updatePassPlan = async (req, res) => {
  const { id } = req.params;
  try {
    const {
      name,
      pass_type,
      price,
      original_value,
      total_quota,
      unit_name,
      description,
      max_hours_per_day,
      max_days_per_week,
      max_hours_per_week,
      valid_days,
      day_restriction,
      is_active,
      checkout_effect,
      checkout_scope,
      checkout_value
    } = req.body;

    const data = {};
    if (name !== undefined) data.name = name;
    if (pass_type !== undefined) data.pass_type = pass_type;
    if (price !== undefined) data.price = parseInt(price, 10) || 0;
    if (original_value !== undefined) data.original_value = parseInt(original_value, 10) || 0;
    if (total_quota !== undefined) data.total_quota = parseInt(total_quota, 10) || 1;
    if (unit_name !== undefined) data.unit_name = unit_name;
    if (description !== undefined) data.description = description;
    if (max_hours_per_day !== undefined) data.max_hours_per_day = max_hours_per_day !== '' && max_hours_per_day !== null ? parseInt(max_hours_per_day, 10) : null;
    if (max_days_per_week !== undefined) data.max_days_per_week = max_days_per_week !== '' && max_days_per_week !== null ? parseInt(max_days_per_week, 10) : null;
    if (max_hours_per_week !== undefined) data.max_hours_per_week = max_hours_per_week !== '' && max_hours_per_week !== null ? parseInt(max_hours_per_week, 10) : null;
    if (valid_days !== undefined) data.valid_days = valid_days !== '' && valid_days !== null ? parseInt(valid_days, 10) : null;
    if (day_restriction !== undefined) data.day_restriction = day_restriction;
    if (is_active !== undefined) data.is_active = Boolean(is_active);
    if (checkout_effect !== undefined) data.checkout_effect = checkout_effect || null;
    if (checkout_scope !== undefined) data.checkout_scope = checkout_scope || 'entry';
    if (checkout_value !== undefined) data.checkout_value = checkout_value !== '' && checkout_value !== null ? parseInt(checkout_value, 10) : null;

    const updated = await prisma.passPlan.update({
      where: { id: parseInt(id, 10) },
      data
    });

    res.json(updated);
  } catch (error) {
    console.error('updatePassPlan error:', error);
    res.status(500).json({ error: '更新卡券方案失敗' });
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

