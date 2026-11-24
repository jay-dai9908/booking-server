import crypto from 'crypto';
import prisma from '../prismaClient.js';
import { deductPass } from '../services/billing/passTender.js';
import { assertEnabledPaymentMethod, nextSerialNo, resolveBillingDate } from '../services/billing/billService.js';
import { queuePrintJob } from '../services/print/printService.js';
import { log as auditLog } from '../services/audit/auditService.js';
import { getAdminDeviceInfo } from '../utils/deviceParser.js';

/**
 * Admin: Grant or sell pass to a user (mode: 'sale' | 'gift')
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
    note,
    mode,
    method,
    amount,
    reason,
    client_batch_id,
    cash_received,
    print
  } = req.body || {};

  const staffName = req.user?.name || '門市人員';
  const staffId = req.user?.id || null;
  const deviceInfo = getAdminDeviceInfo(req);

  if (!user_id) {
    return res.status(400).json({ error: '請指定欲發放卡券之會員' });
  }

  if (mode !== 'sale' && mode !== 'gift') {
    return res.status(422).json({ error: '請選擇發放方式（販售或贈送）' });
  }

  const trimmedReason = reason ? String(reason).trim() : '';
  if (mode === 'gift' && !trimmedReason) {
    return res.status(422).json({ error: '贈送卡券必須填寫原因' });
  }

  try {
    const targetUserId = parseInt(user_id, 10);
    const targetUser = await prisma.user.findUnique({ where: { id: targetUserId } });
    if (!targetUser) {
      return res.status(404).json({ error: '找不到指定會員' });
    }

    let plan = null;
    if (plan_id) {
      plan = await prisma.passPlan.findUnique({ where: { id: parseInt(plan_id, 10) } });
      if (!plan) {
        return res.status(404).json({ error: '找不到指定卡券方案' });
      }
    }

    const planName = plan ? plan.name : (note?.trim() || '手動自訂卡券');
    const passType = plan ? plan.pass_type : 'PUNCH_CARD';
    const totalQuota = custom_quota !== undefined
      ? (custom_quota === null || custom_quota === '' ? null : parseInt(custom_quota, 10))
      : (plan ? plan.total_quota : null);

    const effectiveDays = valid_days !== undefined
      ? (valid_days === null || valid_days === '' ? null : parseInt(valid_days, 10))
      : (plan ? plan.valid_days : null);

    const expiresAt = effectiveDays ? new Date(Date.now() + effectiveDays * 24 * 60 * 60 * 1000) : null;
    const effectiveDayRestriction = day_restriction || plan?.day_restriction || 'ALL';

    const maxDayHours = max_hours_per_day !== undefined ? (max_hours_per_day ? parseInt(max_hours_per_day, 10) : null) : plan?.max_hours_per_day;
    const maxDaysWeek = max_days_per_week !== undefined ? (max_days_per_week ? parseInt(max_days_per_week, 10) : null) : plan?.max_days_per_week;
    const maxHoursWeek = max_hours_per_week !== undefined ? (max_hours_per_week ? parseInt(max_hours_per_week, 10) : null) : plan?.max_hours_per_week;

    if (mode === 'sale') {
      const normalizedMethod = String(method || '').trim().toLowerCase();
      if (!normalizedMethod) {
        return res.status(422).json({ error: '請選擇販售付款方式' });
      }
      if (normalizedMethod === 'pass') {
        return res.status(422).json({ error: '販售卡券不可使用卡券付款' });
      }

      const rawAmount = (amount !== undefined && amount !== null && amount !== '')
        ? Number(amount)
        : (plan ? Number(plan.price) : NaN);

      if (!Number.isInteger(rawAmount) || rawAmount <= 0) {
        return res.status(422).json({ error: '販售金額必須為正整數' });
      }

      if (plan && rawAmount !== Number(plan.price) && !trimmedReason) {
        return res.status(422).json({ error: '售價與方案定價不同時請填寫原因' });
      }

      const providedCash = (cash_received !== undefined && cash_received !== null && cash_received !== '')
        ? Number(cash_received)
        : rawAmount;
      if (normalizedMethod === 'cash') {
        if (!Number.isFinite(providedCash) || providedCash < rawAmount) {
          return res.status(400).json({ error: `實收現金（NT$${Number.isFinite(providedCash) ? providedCash : 0}）不足（應收 NT$${rawAmount}）` });
        }
      }

      if (client_batch_id) {
        const existingPay = await prisma.payment.findFirst({
          where: { client_batch_id: String(client_batch_id), source: 'pass_sale', status: 'valid' }
        });
        if (existingPay) {
          const existingPass = await prisma.userPass.findUnique({
            where: { pass_code: existingPay.source_ref || existingPay.booking_ref },
            include: { user: { select: { id: true, name: true, phone: true } }, plan: true }
          });
          return res.json({
            message: `已販售卡券「${planName}」`,
            pass: existingPass,
            payment: existingPay,
            print_job: null,
            idempotent: true
          });
        }
      }

      const result = await prisma.$transaction(async (tx) => {
        await assertEnabledPaymentMethod(tx, normalizedMethod);

        const defaultPlan = plan || await tx.passPlan.findFirst();
        if (!defaultPlan) {
          throw { status: 422, message: '尚未建立任何卡券方案，請先新增卡券方案' };
        }

        let passCode = `PASS-${Math.floor(10000000 + Math.random() * 90000000)}`;
        while (await tx.userPass.findUnique({ where: { pass_code: passCode } })) {
          passCode = `PASS-${Math.floor(10000000 + Math.random() * 90000000)}`;
        }

        const userPass = await tx.userPass.create({
          data: {
            pass_code: passCode,
            user_id: targetUserId,
            plan_id: defaultPlan.id,
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

        const payDate = resolveBillingDate(req.body);
        const payNo = await nextSerialNo(tx, 'payment', payDate);
        const batchNo = crypto.randomUUID();
        const changeGiven = normalizedMethod === 'cash' ? (providedCash - rawAmount) : null;

        const pay = await tx.payment.create({
          data: {
            payment_no: payNo,
            batch_no: batchNo,
            client_batch_id: client_batch_id ? String(client_batch_id) : null,
            booking_ref: passCode,
            source: 'pass_sale',
            source_ref: passCode,
            kind: 'charge',
            status: 'valid',
            method: normalizedMethod,
            amount: rawAmount,
            cash_received: normalizedMethod === 'cash' ? providedCash : null,
            change_given: changeGiven,
            person_nos: [],
            breakdown_json: {
              type: 'pass_sale',
              user_pass_id: userPass.id,
              pass_code: passCode,
              plan_name: planName,
              total_quota: totalQuota,
              valid_days: effectiveDays,
              expires_at: expiresAt ? expiresAt.toISOString() : null,
              customer_name: userPass.user?.name || targetUser.name,
              customer_phone: userPass.user?.phone || targetUser.phone
            },
            reason: trimmedReason || null,
            note: note ? String(note).trim() : null,
            staff_name: staffName,
            staff_id: staffId,
            device_id: deviceInfo.device_id,
            device_label: deviceInfo.device_label || '櫃檯'
          }
        });

        await auditLog(tx, {
          booking_ref: passCode,
          event_type: 'pass_sold',
          category: 'payment',
          summary: `販售卡券 ${planName}（${passCode}）· ${normalizedMethod === 'cash' ? '現金' : normalizedMethod} NT$${rawAmount}`,
          amount: rawAmount,
          payment_id: pay.id,
          reason: trimmedReason || null,
          after_json: {
            user_pass_id: userPass.id,
            pass_code: passCode,
            plan_name: planName,
            total_quota: totalQuota,
            expires_at: expiresAt ? expiresAt.toISOString() : null,
            amount: rawAmount,
            method: normalizedMethod
          },
          staff_name: staffName,
          staff_id: staffId,
          device_id: deviceInfo.device_id,
          device_label: deviceInfo.device_label
        });

        let printJob = null;
        const globalSetting = await tx.globalSetting.findFirst() || {};
        if (print !== false && globalSetting.print_enabled !== false && globalSetting.auto_print_receipt !== false) {
          printJob = await queuePrintJob({
            type: 'receipt',
            booking_ref: passCode,
            payment_id: pay.id,
            user: req.user,
            device: deviceInfo,
            now: payDate
          }, tx);
        }

        return { userPass, pay, printJob };
      });

      return res.json({
        message: `卡券「${planName}」販售收款成功！`,
        pass: result.userPass,
        payment: result.pay,
        print_job: result.printJob
      });
    }

    // mode === 'gift'
    const giftedPass = await prisma.$transaction(async (tx) => {
      const defaultPlan = plan || await tx.passPlan.findFirst();
      if (!defaultPlan) {
        throw { status: 422, message: '尚未建立任何卡券方案，請先新增卡券方案' };
      }

      let passCode = `PASS-${Math.floor(10000000 + Math.random() * 90000000)}`;
      while (await tx.userPass.findUnique({ where: { pass_code: passCode } })) {
        passCode = `PASS-${Math.floor(10000000 + Math.random() * 90000000)}`;
      }

      const userPass = await tx.userPass.create({
        data: {
          pass_code: passCode,
          user_id: targetUserId,
          plan_id: defaultPlan.id,
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

      await auditLog(tx, {
        booking_ref: passCode,
        event_type: 'pass_gifted',
        category: 'pass',
        summary: `贈送卡券 ${planName}（${passCode}）給 ${userPass.user?.name || targetUser.name} · 原因「${trimmedReason}」`,
        reason: trimmedReason,
        after_json: {
          user_pass_id: userPass.id,
          pass_code: passCode,
          plan_name: planName,
          total_quota: totalQuota,
          expires_at: expiresAt ? expiresAt.toISOString() : null
        },
        staff_name: staffName,
        staff_id: staffId,
        device_id: deviceInfo.device_id,
        device_label: deviceInfo.device_label
      });

      return userPass;
    });

    return res.json({
      message: `卡券「${planName}」已贈送給會員！`,
      pass: giftedPass
    });
  } catch (error) {
    console.error('grantUserPass error:', error);
    if (error.status) return res.status(error.status).json({ error: error.message });
    res.status(500).json({ error: '發放卡券失敗' });
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

