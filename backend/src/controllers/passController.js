import crypto from 'crypto';
import prisma from '../prismaClient.js';
import { deductPass } from '../services/billing/passTender.js';
import { refundPassSale } from '../services/billing/passSaleRefund.js';
import { assertEnabledPaymentMethod, getNextDailySeq, nextSerialNo, resolveBillingDate } from '../services/billing/billService.js';
import { queuePrintJob } from '../services/print/printService.js';
import { log as auditLog } from '../services/audit/auditService.js';
import { getAdminDeviceInfo } from '../utils/deviceParser.js';
import { toTaipeiDateString } from '../../../shared/time.js';

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
        const matchedMethod = await assertEnabledPaymentMethod(tx, normalizedMethod);
        const canonicalMethod = matchedMethod.key;

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
            method: canonicalMethod,
            amount: rawAmount,
            cash_received: canonicalMethod === 'cash' ? providedCash : null,
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
          summary: `販售卡券 ${planName}（${passCode}）· ${canonicalMethod === 'cash' ? '現金' : canonicalMethod} NT$${rawAmount}`,
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
            method: canonicalMethod
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

async function enrichPassesWithSource(passes = [], client = prisma) {
  if (!Array.isArray(passes) || passes.length === 0) return [];
  const passCodes = [...new Set(passes.map((p) => p.pass_code).filter(Boolean))];
  const [saleCharges, saleRefunds, giftEvents] = passCodes.length > 0
    ? await Promise.all([
        client.payment.findMany({
          where: { source: 'pass_sale', source_ref: { in: passCodes }, kind: 'charge', status: 'valid' },
          orderBy: { id: 'desc' }
        }),
        client.payment.findMany({
          where: { source: 'pass_sale', source_ref: { in: passCodes }, kind: 'refund', status: 'valid' },
          select: { source_ref: true, amount: true }
        }),
        client.accountingEvent.findMany({
          where: { event_type: 'pass_gifted', booking_ref: { in: passCodes } },
          orderBy: { id: 'desc' },
          select: { booking_ref: true, reason: true }
        })
      ])
    : [[], [], []];

  const saleChargeMap = new Map();
  for (const pay of saleCharges) {
    if (pay.source_ref && !saleChargeMap.has(pay.source_ref)) {
      saleChargeMap.set(pay.source_ref, pay);
    }
  }
  const saleRefundSumMap = new Map();
  for (const refPay of saleRefunds) {
    if (refPay.source_ref) {
      saleRefundSumMap.set(
        refPay.source_ref,
        (saleRefundSumMap.get(refPay.source_ref) || 0) + (Number(refPay.amount) || 0)
      );
    }
  }
  const giftMap = new Map();
  for (const ev of giftEvents) {
    if (ev.booking_ref && !giftMap.has(ev.booking_ref)) {
      giftMap.set(ev.booking_ref, ev);
    }
  }

  return passes.map((p) => {
    const salePay = saleChargeMap.get(p.pass_code);
    const giftEv = giftMap.get(p.pass_code);

    let source_type = 'legacy';
    let source_label = '舊資料（來源不明）';
    let sale_amount = null;
    let sale_method = null;
    let refunded_amount = 0;
    let refundable_remaining = 0;
    let gift_reason = null;

    if (salePay) {
      source_type = 'sale';
      source_label = '販售';
      sale_amount = salePay.amount;
      sale_method = salePay.method;
      refunded_amount = saleRefundSumMap.get(p.pass_code) || 0;
      refundable_remaining = Math.max(0, (Number(salePay.amount) || 0) - refunded_amount);
    } else if (giftEv) {
      source_type = 'gift';
      source_label = '贈送';
      gift_reason = giftEv.reason || null;
    } else if (p.order_ref) {
      source_type = 'shop_bonus';
      source_label = '商城贈品';
    }

    return {
      ...p,
      source_type,
      source_label,
      sale_amount,
      sale_method,
      refunded_amount,
      refundable_remaining,
      gift_reason
    };
  });
}

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
    const enriched = await enrichPassesWithSource(passes);
    res.json(enriched);
  } catch (error) {
    res.status(500).json({ error: '獲取會員卡券失敗' });
  }
};

/**
 * Admin: Get store-wide passes overview with filters, pagination, and inferred source
 * GET /api/passes/admin/all
 */
export const getAllPassesAdmin = async (req, res) => {
  try {
    const {
      status,
      plan_id,
      q,
      expiring_days,
      page = '1',
      limit = '30'
    } = req.query || {};

    const parsedPage = Math.max(1, parseInt(page, 10) || 1);
    const parsedLimit = Math.min(100, Math.max(1, parseInt(limit, 10) || 30));
    const now = new Date();

    const where = {};
    if (status && status !== 'ALL' && status !== 'all') {
      where.status = String(status).trim().toUpperCase();
    }
    if (plan_id !== undefined && plan_id !== '' && plan_id !== 'all') {
      const parsedPlanId = parseInt(plan_id, 10);
      if (Number.isInteger(parsedPlanId) && parsedPlanId > 0) {
        where.plan_id = parsedPlanId;
      }
    }
    if (expiring_days !== undefined && expiring_days !== '') {
      const days = parseInt(expiring_days, 10);
      if (Number.isInteger(days) && days > 0) {
        const cutoff = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
        where.status = 'ACTIVE';
        where.expires_at = { gte: now, lte: cutoff };
      }
    }
    if (q && String(q).trim()) {
      const qTrim = String(q).trim();
      where.OR = [
        { pass_code: { contains: qTrim, mode: 'insensitive' } },
        { user: { name: { contains: qTrim, mode: 'insensitive' } } },
        { user: { phone: { contains: qTrim } } }
      ];
    }

    const [total, rawPasses] = await Promise.all([
      prisma.userPass.count({ where }),
      prisma.userPass.findMany({
        where,
        include: {
          user: { select: { id: true, name: true, phone: true, line_display_name: true } },
          plan: { select: { id: true, code: true, name: true, pass_type: true, unit_name: true, price: true } }
        },
        orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
        skip: (parsedPage - 1) * parsedLimit,
        take: parsedLimit
      })
    ]);

    const enriched = await enrichPassesWithSource(rawPasses);
    res.json({
      passes: enriched,
      total,
      page: parsedPage,
      limit: parsedLimit,
      totalPages: Math.max(1, Math.ceil(total / parsedLimit))
    });
  } catch (error) {
    console.error('getAllPassesAdmin error:', error);
    res.status(500).json({ error: '獲取全店卡券總表失敗' });
  }
};

/**
 * Admin: Store-wide pass summary counts grouped overall & by plan
 * GET /api/passes/admin/summary
 */
export const getPassesSummaryAdmin = async (_req, res) => {
  try {
    const now = new Date();
    const cutoff30 = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

    const allPasses = await prisma.userPass.findMany({
      select: {
        id: true,
        plan_id: true,
        plan_name_snapshot: true,
        status: true,
        remaining_quota: true,
        expires_at: true,
        plan: { select: { id: true, name: true } }
      }
    });

    let active_count = 0;
    let active_remaining_quota = 0;
    let expiring_30d_count = 0;
    let expired_count = 0;
    let revoked_count = 0;
    const planMap = new Map();

    for (const p of allPasses) {
      const planKey = p.plan_id ?? `name:${p.plan_name_snapshot || '自訂'}`;
      const planName = p.plan?.name || p.plan_name_snapshot || '自訂方案';
      if (!planMap.has(planKey)) {
        planMap.set(planKey, {
          plan_id: p.plan_id,
          plan_name: planName,
          active_count: 0,
          active_remaining_quota: 0,
          expiring_30d_count: 0,
          expired_count: 0,
          revoked_count: 0
        });
      }
      const bucket = planMap.get(planKey);

      if (p.status === 'ACTIVE') {
        active_count += 1;
        bucket.active_count += 1;
        if (typeof p.remaining_quota === 'number') {
          active_remaining_quota += p.remaining_quota;
          bucket.active_remaining_quota += p.remaining_quota;
        }
        if (p.expires_at && p.expires_at >= now && p.expires_at <= cutoff30) {
          expiring_30d_count += 1;
          bucket.expiring_30d_count += 1;
        }
      } else if (p.status === 'EXPIRED') {
        expired_count += 1;
        bucket.expired_count += 1;
      } else if (p.status === 'REVOKED') {
        revoked_count += 1;
        bucket.revoked_count += 1;
      }
    }

    res.json({
      active_count,
      active_remaining_quota,
      expiring_30d_count,
      expired_count,
      revoked_count,
      by_plan: Array.from(planMap.values())
    });
  } catch (error) {
    console.error('getPassesSummaryAdmin error:', error);
    res.status(500).json({ error: '獲取卡券摘要失敗' });
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

const PASS_PLAN_CODE_RE = /^[a-z0-9_]{3,40}$/;
const VALID_PASS_TYPES = new Set(['PUNCH_CARD', 'DISCOUNT_VOUCHER', 'MONTHLY_PASS', 'TIME_PASS']);
const VALID_DAY_RESTRICTIONS = new Set(['ALL', 'WEEKDAY_ONLY', 'WEEKEND_ONLY']);
const VALID_CHECKOUT_EFFECTS = new Set(['entry_hours', 'entry_full', 'percent_off', 'fixed_amount']);
const VALID_CHECKOUT_SCOPES = new Set(['entry', 'all']);

function parseStrictInt(val) {
  if (typeof val === 'number') {
    return Number.isInteger(val) ? val : null;
  }
  if (typeof val === 'string') {
    const trimmed = val.trim();
    if (!/^-?\d+$/.test(trimmed)) return null;
    const parsed = Number(trimmed);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  return null;
}

function parseOptionalIntMin(val, min, field, label) {
  if (val === null || val === '') {
    return { ok: true, value: null };
  }
  const parsed = parseStrictInt(val);
  if (parsed === null || parsed < min) {
    return { ok: false, error: `${label}須為 ${min} 以上的整數`, field };
  }
  return { ok: true, value: parsed };
}

function parseRequiredIntMin(val, min, field, label) {
  const parsed = parseStrictInt(val);
  if (parsed === null || parsed < min) {
    return { ok: false, error: `${label}須為 ${min} 以上的整數`, field };
  }
  return { ok: true, value: parsed };
}

function passPlanValuesEqual(a, b) {
  return (a ?? null) === (b ?? null);
}

/**
 * Admin: Create pass plan template
 */
export const createPassPlan = async (req, res) => {
  const staffName = req.user?.name || '門市人員';
  const staffId = req.user?.id || null;
  const deviceInfo = getAdminDeviceInfo(req);

  try {
    const body = req.body || {};
    const {
      code,
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
      discount_percent,
      is_purchasable_online,
      checkout_effect,
      checkout_scope,
      checkout_value
    } = body;

    let explicitCode = null;
    if (code !== undefined && code !== null && String(code).trim() !== '') {
      const trimmedCode = String(code).trim();
      if (!PASS_PLAN_CODE_RE.test(trimmedCode)) {
        return res.status(422).json({ error: '方案代碼僅能包含小寫英文、數字與底線（3～40 字）', field: 'code' });
      }
      explicitCode = trimmedCode;
    }

    const trimmedName = typeof name === 'string' ? name.trim() : '';
    if (!trimmedName || trimmedName.length > 40) {
      return res.status(422).json({ error: '方案名稱須為 1～40 字', field: 'name' });
    }

    if (!VALID_PASS_TYPES.has(pass_type)) {
      return res.status(422).json({ error: '卡券類型必須為 PUNCH_CARD、DISCOUNT_VOUCHER、MONTHLY_PASS 或 TIME_PASS', field: 'pass_type' });
    }

    const priceRes = parseRequiredIntMin(price === undefined ? 0 : price, 0, 'price', '售價');
    if (!priceRes.ok) return res.status(422).json({ error: priceRes.error, field: priceRes.field });

    const origValRes = original_value === undefined
      ? { ok: true, value: null }
      : parseOptionalIntMin(original_value, 0, 'original_value', '參考原價');
    if (!origValRes.ok) return res.status(422).json({ error: origValRes.error, field: origValRes.field });

    const allowNullQuota = pass_type === 'MONTHLY_PASS' || pass_type === 'TIME_PASS';
    let parsedQuota = null;
    if (total_quota === undefined || total_quota === null || total_quota === '') {
      if (!allowNullQuota) {
        return res.status(422).json({ error: '次數卡／折扣券的額度必須為 1 以上的整數', field: 'total_quota' });
      }
    } else {
      const quotaRes = parseRequiredIntMin(total_quota, 1, 'total_quota', '額度');
      if (!quotaRes.ok) return res.status(422).json({ error: quotaRes.error, field: quotaRes.field });
      parsedQuota = quotaRes.value;
    }

    const trimmedUnit = unit_name === undefined ? '次' : (typeof unit_name === 'string' ? unit_name.trim() : '');
    if (!trimmedUnit || trimmedUnit.length > 4) {
      return res.status(422).json({ error: '單位名稱須為 1～4 字', field: 'unit_name' });
    }

    const validDaysRes = valid_days === undefined
      ? { ok: true, value: null }
      : parseOptionalIntMin(valid_days, 1, 'valid_days', '有效天數');
    if (!validDaysRes.ok) return res.status(422).json({ error: validDaysRes.error, field: validDaysRes.field });

    const normalizedDayRestr = day_restriction === undefined || day_restriction === null || day_restriction === ''
      ? 'ALL'
      : day_restriction;
    if (!VALID_DAY_RESTRICTIONS.has(normalizedDayRestr)) {
      return res.status(422).json({ error: '適用日期限制不正確', field: 'day_restriction' });
    }

    const maxHoursDayRes = max_hours_per_day === undefined
      ? { ok: true, value: null }
      : parseOptionalIntMin(max_hours_per_day, 1, 'max_hours_per_day', '每日最高時數');
    if (!maxHoursDayRes.ok) return res.status(422).json({ error: maxHoursDayRes.error, field: maxHoursDayRes.field });

    const maxDaysWeekRes = max_days_per_week === undefined
      ? { ok: true, value: null }
      : parseOptionalIntMin(max_days_per_week, 1, 'max_days_per_week', '每週最高天數');
    if (!maxDaysWeekRes.ok) return res.status(422).json({ error: maxDaysWeekRes.error, field: maxDaysWeekRes.field });

    const maxHoursWeekRes = max_hours_per_week === undefined
      ? { ok: true, value: null }
      : parseOptionalIntMin(max_hours_per_week, 1, 'max_hours_per_week', '每週最高時數');
    if (!maxHoursWeekRes.ok) return res.status(422).json({ error: maxHoursWeekRes.error, field: maxHoursWeekRes.field });

    const discountRes = discount_percent === undefined
      ? { ok: true, value: null }
      : parseOptionalIntMin(discount_percent, 1, 'discount_percent', '折扣百分比');
    if (!discountRes.ok || (discountRes.value !== null && discountRes.value > 100)) {
      return res.status(422).json({ error: '折扣百分比須為 1～100 的整數', field: 'discount_percent' });
    }

    const normalizedEffect = (checkout_effect === undefined || checkout_effect === null || checkout_effect === '')
      ? null
      : checkout_effect;
    if (normalizedEffect !== null && !VALID_CHECKOUT_EFFECTS.has(normalizedEffect)) {
      return res.status(422).json({ error: '折抵方式不正確', field: 'checkout_effect' });
    }

    const normalizedScope = (checkout_scope === undefined || checkout_scope === null || checkout_scope === '')
      ? 'entry'
      : checkout_scope;
    if (!VALID_CHECKOUT_SCOPES.has(normalizedScope)) {
      return res.status(422).json({ error: '折抵範圍必須為 entry 或 all', field: 'checkout_scope' });
    }

    const checkoutValRes = checkout_value === undefined
      ? { ok: true, value: null }
      : parseOptionalIntMin(checkout_value, 1, 'checkout_value', '折抵金額');
    if (!checkoutValRes.ok) return res.status(422).json({ error: checkoutValRes.error, field: checkoutValRes.field });

    if (normalizedEffect === 'fixed_amount' && (checkoutValRes.value === null || checkoutValRes.value < 1)) {
      return res.status(422).json({ error: '固定金額折抵必須填寫折抵金額（1 以上的整數）', field: 'checkout_value' });
    }

    const now = resolveBillingDate(body) || new Date();
    const dateCompact = toTaipeiDateString(now).replace(/-/g, '');

    const created = await prisma.$transaction(async (tx) => {
      let finalCode = explicitCode;
      if (finalCode) {
        const dup = await tx.passPlan.findUnique({ where: { code: finalCode } });
        if (dup) {
          throw { status: 409, message: '方案代碼已存在', field: 'code' };
        }
      } else {
        do {
          const seq = await getNextDailySeq(tx, 'pass_plan', now);
          finalCode = `plan_${dateCompact}_${String(seq).padStart(3, '0')}`;
        } while (await tx.passPlan.findUnique({ where: { code: finalCode } }));
      }

      const plan = await tx.passPlan.create({
        data: {
          code: finalCode,
          name: trimmedName,
          pass_type,
          price: priceRes.value,
          original_value: origValRes.value,
          total_quota: parsedQuota,
          unit_name: trimmedUnit,
          description: description != null && String(description).trim() !== '' ? String(description).trim() : null,
          max_hours_per_day: maxHoursDayRes.value,
          max_days_per_week: maxDaysWeekRes.value,
          max_hours_per_week: maxHoursWeekRes.value,
          valid_days: validDaysRes.value,
          day_restriction: normalizedDayRestr,
          is_active: is_active !== false,
          is_purchasable_online: Boolean(is_purchasable_online),
          discount_percent: discountRes.value,
          checkout_effect: normalizedEffect,
          checkout_scope: normalizedScope,
          checkout_value: checkoutValRes.value
        }
      });

      await auditLog(tx, {
        event_type: 'pass_plan_created',
        category: 'pass',
        summary: `新增卡券方案「${plan.name}」（${plan.code}）`,
        before_json: null,
        after_json: {
          id: plan.id,
          code: plan.code,
          name: plan.name,
          pass_type: plan.pass_type,
          price: plan.price,
          original_value: plan.original_value,
          total_quota: plan.total_quota,
          unit_name: plan.unit_name
        },
        staff_name: staffName,
        staff_id: staffId,
        ...deviceInfo
      });

      return plan;
    });

    res.status(201).json(created);
  } catch (error) {
    if (error?.status) {
      return res.status(error.status).json({ error: error.message, ...(error.field ? { field: error.field } : {}) });
    }
    if (error?.code === 'P2002') {
      return res.status(409).json({ error: '方案代碼已存在', field: 'code' });
    }
    console.error('createPassPlan error:', error);
    res.status(500).json({ error: '建立卡券方案失敗' });
  }
};

/**
 * Admin: Update pass plan template
 */
export const updatePassPlan = async (req, res) => {
  const planId = parseStrictInt(req.params?.id);
  if (!planId || planId < 1) {
    return res.status(404).json({ error: '找不到指定的卡券方案' });
  }

  const staffName = req.user?.name || '門市人員';
  const staffId = req.user?.id || null;
  const deviceInfo = getAdminDeviceInfo(req);

  try {
    const existing = await prisma.passPlan.findUnique({ where: { id: planId } });
    if (!existing) {
      return res.status(404).json({ error: '找不到指定的卡券方案' });
    }

    const body = req.body || {};
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
      discount_percent,
      is_purchasable_online,
      checkout_effect,
      checkout_scope,
      checkout_value
    } = body;

    const data = {};

    if (name !== undefined) {
      const trimmedName = typeof name === 'string' ? name.trim() : '';
      if (!trimmedName || trimmedName.length > 40) {
        return res.status(422).json({ error: '方案名稱須為 1～40 字', field: 'name' });
      }
      data.name = trimmedName;
    }

    if (pass_type !== undefined) {
      if (!VALID_PASS_TYPES.has(pass_type)) {
        return res.status(422).json({ error: '卡券類型必須為 PUNCH_CARD、DISCOUNT_VOUCHER、MONTHLY_PASS 或 TIME_PASS', field: 'pass_type' });
      }
      data.pass_type = pass_type;
    }

    if (price !== undefined) {
      const priceRes = parseRequiredIntMin(price, 0, 'price', '售價');
      if (!priceRes.ok) return res.status(422).json({ error: priceRes.error, field: priceRes.field });
      data.price = priceRes.value;
    }

    if (original_value !== undefined) {
      const origRes = parseOptionalIntMin(original_value, 0, 'original_value', '參考原價');
      if (!origRes.ok) return res.status(422).json({ error: origRes.error, field: origRes.field });
      data.original_value = origRes.value;
    }

    const effectivePassType = data.pass_type ?? existing.pass_type;
    const allowNullQuota = effectivePassType === 'MONTHLY_PASS' || effectivePassType === 'TIME_PASS';
    if (total_quota !== undefined) {
      if (total_quota === null || total_quota === '') {
        if (!allowNullQuota) {
          return res.status(422).json({ error: '次數卡／折扣券的額度必須為 1 以上的整數', field: 'total_quota' });
        }
        data.total_quota = null;
      } else {
        const quotaRes = parseRequiredIntMin(total_quota, 1, 'total_quota', '額度');
        if (!quotaRes.ok) return res.status(422).json({ error: quotaRes.error, field: quotaRes.field });
        data.total_quota = quotaRes.value;
      }
    } else if (data.pass_type !== undefined && !allowNullQuota && existing.total_quota === null) {
      return res.status(422).json({ error: '改為次數卡／折扣券時必須設定額度', field: 'total_quota' });
    }

    if (unit_name !== undefined) {
      const trimmedUnit = typeof unit_name === 'string' ? unit_name.trim() : '';
      if (!trimmedUnit || trimmedUnit.length > 4) {
        return res.status(422).json({ error: '單位名稱須為 1～4 字', field: 'unit_name' });
      }
      data.unit_name = trimmedUnit;
    }

    if (description !== undefined) {
      data.description = description != null && String(description).trim() !== '' ? String(description).trim() : null;
    }

    if (max_hours_per_day !== undefined) {
      const r = parseOptionalIntMin(max_hours_per_day, 1, 'max_hours_per_day', '每日最高時數');
      if (!r.ok) return res.status(422).json({ error: r.error, field: r.field });
      data.max_hours_per_day = r.value;
    }
    if (max_days_per_week !== undefined) {
      const r = parseOptionalIntMin(max_days_per_week, 1, 'max_days_per_week', '每週最高天數');
      if (!r.ok) return res.status(422).json({ error: r.error, field: r.field });
      data.max_days_per_week = r.value;
    }
    if (max_hours_per_week !== undefined) {
      const r = parseOptionalIntMin(max_hours_per_week, 1, 'max_hours_per_week', '每週最高時數');
      if (!r.ok) return res.status(422).json({ error: r.error, field: r.field });
      data.max_hours_per_week = r.value;
    }
    if (valid_days !== undefined) {
      const r = parseOptionalIntMin(valid_days, 1, 'valid_days', '有效天數');
      if (!r.ok) return res.status(422).json({ error: r.error, field: r.field });
      data.valid_days = r.value;
    }
    if (day_restriction !== undefined) {
      const val = day_restriction || 'ALL';
      if (!VALID_DAY_RESTRICTIONS.has(val)) {
        return res.status(422).json({ error: '適用日期限制不正確', field: 'day_restriction' });
      }
      data.day_restriction = val;
    }
    if (discount_percent !== undefined) {
      const r = parseOptionalIntMin(discount_percent, 1, 'discount_percent', '折扣百分比');
      if (!r.ok || (r.value !== null && r.value > 100)) {
        return res.status(422).json({ error: '折扣百分比須為 1～100 的整數', field: 'discount_percent' });
      }
      data.discount_percent = r.value;
    }
    if (is_active !== undefined) data.is_active = Boolean(is_active);
    if (is_purchasable_online !== undefined) data.is_purchasable_online = Boolean(is_purchasable_online);

    if (checkout_effect !== undefined) {
      const eff = (checkout_effect === null || checkout_effect === '') ? null : checkout_effect;
      if (eff !== null && !VALID_CHECKOUT_EFFECTS.has(eff)) {
        return res.status(422).json({ error: '折抵方式不正確', field: 'checkout_effect' });
      }
      data.checkout_effect = eff;
    }
    if (checkout_scope !== undefined) {
      const sc = checkout_scope || 'entry';
      if (!VALID_CHECKOUT_SCOPES.has(sc)) {
        return res.status(422).json({ error: '折抵範圍必須為 entry 或 all', field: 'checkout_scope' });
      }
      data.checkout_scope = sc;
    }
    if (checkout_value !== undefined) {
      const r = parseOptionalIntMin(checkout_value, 1, 'checkout_value', '折抵金額');
      if (!r.ok) return res.status(422).json({ error: r.error, field: r.field });
      data.checkout_value = r.value;
    }

    const effectiveEffect = data.checkout_effect !== undefined ? data.checkout_effect : existing.checkout_effect;
    const effectiveCheckoutValue = data.checkout_value !== undefined ? data.checkout_value : existing.checkout_value;
    if (effectiveEffect === 'fixed_amount' && (effectiveCheckoutValue === null || effectiveCheckoutValue < 1)) {
      return res.status(422).json({ error: '固定金額折抵必須填寫折抵金額（1 以上的整數）', field: 'checkout_value' });
    }

    const beforeChanged = {};
    const afterChanged = {};
    for (const key of Object.keys(data)) {
      if (!passPlanValuesEqual(existing[key], data[key])) {
        beforeChanged[key] = existing[key] ?? null;
        afterChanged[key] = data[key] ?? null;
      }
    }

    const updated = await prisma.$transaction(async (tx) => {
      const plan = await tx.passPlan.update({
        where: { id: planId },
        data
      });

      const changedKeys = Object.keys(afterChanged);
      if (changedKeys.length > 0) {
        await auditLog(tx, {
          event_type: 'pass_plan_updated',
          category: 'pass',
          summary: `修改卡券方案「${plan.name}」（${plan.code}）：${changedKeys.join('、')}`,
          before_json: beforeChanged,
          after_json: afterChanged,
          staff_name: staffName,
          staff_id: staffId,
          ...deviceInfo
        });
      }

      return plan;
    });

    res.json(updated);
  } catch (error) {
    console.error('updatePassPlan error:', error);
    res.status(500).json({ error: '更新卡券方案失敗' });
  }
};

/**
 * Admin: Revoke or restore pass status (only ACTIVE | REVOKED allowed, reason required)
 */
export const togglePassStatus = async (req, res) => {
  const { id } = req.params;
  const { status, reason } = req.body || {};

  if (status !== 'ACTIVE' && status !== 'REVOKED') {
    return res.status(422).json({
      error: status === 'EXPIRED' || status === 'EXHAUSTED'
        ? `${status} 只能由系統自動設定，不可手動修改`
        : '卡券狀態僅可設為 ACTIVE（恢復）或 REVOKED（作廢）'
    });
  }

  const trimmedReason = reason ? String(reason).trim() : '';
  if (!trimmedReason) {
    return res.status(422).json({ error: '修改卡券狀態必須填寫原因' });
  }

  const passId = parseInt(id, 10);
  if (!Number.isInteger(passId) || passId <= 0) {
    return res.status(400).json({ error: '無效的卡券編號' });
  }

  const staffName = req.user?.name || '管理員';
  const staffId = req.user?.id || null;
  const deviceInfo = getAdminDeviceInfo(req);

  try {
    const result = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "UserPass" WHERE id = ${passId} FOR UPDATE`;
      const before = await tx.userPass.findUnique({ where: { id: passId } });
      if (!before) {
        return { notFound: true };
      }

      if (before.status === status) {
        return { pass: before, unchanged: true };
      }

      const updated = await tx.userPass.update({
        where: { id: passId },
        data: { status }
      });

      const codeTail = String(updated.pass_code || '').slice(-4);
      await auditLog(tx, {
        booking_ref: updated.pass_code,
        event_type: 'pass_status_changed',
        category: 'pass',
        target_type: 'user_pass',
        target_ref: updated.pass_code,
        summary: `調整卡券 *${codeTail} 狀態（${before.status} → ${updated.status}）· ${trimmedReason}`,
        reason: trimmedReason,
        before_json: {
          status: before.status,
          remaining_quota: before.remaining_quota
        },
        after_json: {
          status: updated.status,
          remaining_quota: updated.remaining_quota
        },
        staff_name: staffName,
        staff_id: staffId,
        device_id: deviceInfo.device_id,
        device_label: deviceInfo.device_label
      });

      return { pass: updated, unchanged: false };
    });

    if (result.notFound) {
      return res.status(404).json({ error: '找不到該張卡券' });
    }

    res.json({ message: '卡券狀態已更新', pass: result.pass });
  } catch (error) {
    console.error('togglePassStatus error:', error);
    res.status(500).json({ error: '更新卡券狀態失敗' });
  }
};

/**
 * Admin: Refund a purchased pass (source: 'pass_sale')
 * POST /api/passes/admin/:id/refund
 */
export const refundUserPassSaleHandler = async (req, res) => {
  const { id } = req.params;
  const { amount, method, reason, client_batch_id } = req.body || {};

  const staff = {
    id: req.user?.id || null,
    name: req.user?.name || '管理員'
  };
  const device = getAdminDeviceInfo(req);

  try {
    const result = await prisma.$transaction((tx) =>
      refundPassSale(tx, {
        userPassId: id,
        amount,
        method,
        reason,
        clientBatchId: client_batch_id || null,
        staff,
        device
      })
    );

    res.json({
      message: result.deduplicated ? '已處理相同退費請求（略過重複送出）' : '卡券退費完成並已作廢',
      pass: result.pass,
      payment: result.payment,
      deduplicated: result.deduplicated
    });
  } catch (error) {
    console.error('refundUserPassSaleHandler error:', error);
    if (error.status) {
      return res.status(error.status).json({
        error: error.message,
        ...(error.code ? { code: error.code } : {})
      });
    }
    res.status(500).json({ error: '卡券退費失敗' });
  }
};

