import cron from 'node-cron';
import prisma from './prismaClient.js';
import { getTaipeiDateParts } from './utils/dateUtils.js';
import { releasePoolAccount } from './services/selfService/poolAccountService.js';
import { releaseExpiredPrepays } from './services/selfService/prepayService.js';
import { checkKioskOfflineAlerts } from './services/kiosk/alertService.js';
import { solidifyDailyPrices } from './services/pricing/solidify.js';
import { expireOverduePasses } from './services/billing/passExpiry.js';
import { runCronOnce, taipeiCronRunKeys } from './services/cron/cronLock.js';
import auditService from './services/audit/auditService.js';

export async function markPastCheckedInAsCompleted(now = new Date()) {
  const { dateObject: todayMidnightUtc } = getTaipeiDateParts(now);

  const pastCheckedIn = await prisma.reservation.findMany({
    where: {
      session: {
        session_date: {
          lt: todayMidnightUtc
        }
      },
      status: 'confirmed',
      attendance: 'checked_in'
    },
    select: { booking_ref: true }
  });

  const refs = [...new Set(pastCheckedIn.map(r => r.booking_ref).filter(Boolean))];
  if (refs.length === 0) return { bookingCount: 0, personCount: 0 };

  return await prisma.$transaction(async (tx) => {
    const resUpdated = await tx.reservation.updateMany({
      where: {
        booking_ref: { in: refs },
        status: 'confirmed',
        attendance: 'checked_in'
      },
      data: {
        attendance: 'completed'
      }
    });

    const personsToClose = await tx.bookingPerson.findMany({
      where: {
        booking_ref: { in: refs },
        left_at: null
      },
      select: { id: true, timer_ended_at: true }
    });

    let personCount = 0;
    for (const bp of personsToClose) {
      await tx.bookingPerson.update({
        where: { id: bp.id },
        data: { left_at: bp.timer_ended_at || now }
      });
      personCount++;
    }

    return { bookingCount: resUpdated.count, personCount };
  });
}

export async function runMidnightJob(now = new Date(), client = prisma) {
  const { dateObject: todayMidnightUtc } = getTaipeiDateParts(now);

  const pastSessions = await client.session.findMany({
    where: {
      session_date: {
        lt: todayMidnightUtc
      }
    },
    select: { id: true }
  });

  const pastSessionIds = pastSessions.map((s) => s.id);
  let noShowCount = 0;
  let skippedPaidCount = 0;

  if (pastSessionIds.length > 0) {
    const candidates = await client.reservation.findMany({
      where: {
        session_id: { in: pastSessionIds },
        status: 'confirmed',
        attendance: null
      },
      select: {
        id: true,
        booking_ref: true,
        billing_status: true,
        is_paid: true
      }
    });

    if (candidates.length > 0) {
      const candidateRefs = [...new Set(candidates.map((c) => c.booking_ref).filter(Boolean))];
      const verifiedPrepays = await client.bookingPrepay.findMany({
        where: {
          booking_ref: { in: candidateRefs },
          status: 'verified'
        },
        select: { booking_ref: true }
      });
      const verifiedRefSet = new Set(verifiedPrepays.map((p) => p.booking_ref));

      const grouped = new Map();
      for (const row of candidates) {
        if (!grouped.has(row.booking_ref)) grouped.set(row.booking_ref, []);
        grouped.get(row.booking_ref).push(row);
      }

      const paidProtectedRefs = [];
      const unpaidRefs = [];
      for (const [ref, rows] of grouped.entries()) {
        const hasPaidStatus =
          rows.some((r) => Boolean(r.is_paid) || ['paid', 'partial', 'waived'].includes(r.billing_status)) ||
          verifiedRefSet.has(ref);
        if (hasPaidStatus) {
          paidProtectedRefs.push(ref);
        } else {
          unpaidRefs.push(ref);
        }
      }

      if (unpaidRefs.length > 0) {
        const result = await client.reservation.updateMany({
          where: {
            booking_ref: { in: unpaidRefs },
            status: 'confirmed',
            attendance: null
          },
          data: {
            attendance: 'no_show'
          }
        });
        noShowCount = result.count;
        console.log(`[Cron Job] Successfully marked ${noShowCount} reservations as no_show.`);
      }

      if (paidProtectedRefs.length > 0) {
        await client.$transaction(async (tx) => {
          for (const ref of paidProtectedRefs) {
            await auditService.log(tx, {
              booking_ref: ref,
              event_type: 'no_show_skipped_paid',
              category: 'status',
              target_type: 'reservation',
              target_ref: ref,
              summary: `午夜排程跳過未到標記（已付款保留待補報到）：${ref}`,
              staff_name: '系統',
              staff_id: null,
              device_label: '系統排程'
            });
          }
        });
        skippedPaidCount = paidProtectedRefs.length;
        console.log(`[Cron Job] Skipped no_show for ${skippedPaidCount} paid/partial/verified reservations.`);
      }
    }
  } else {
    console.log('[Cron Job] No past sessions found.');
  }

  // 2026-11-22 店主定案：前一天以前仍為 checked_in 的預約在 00:00 自動改成 completed，left_at 補為 timer_ended_at 或執行時間
  const completedPast = await markPastCheckedInAsCompleted(now);
  if (completedPast.bookingCount > 0 || completedPast.personCount > 0) {
    console.log(`[Cron Job] Auto-completed ${completedPast.bookingCount} past checked-in bookings (${completedPast.personCount} persons left_at filled).`);
  }

  // 自動釋放逾期未繳費預購單與虛擬帳號
  const expiredPreorders = await releaseExpiredPreorders(now);

  // Clean up UserLoginLog records older than 60 days (2 months)
  const sixtyDaysAgo = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000);
  const deletedLogs = await client.userLoginLog.deleteMany({
    where: {
      created_at: { lt: sixtyDaysAgo }
    }
  });
  if (deletedLogs.count > 0) {
    console.log(`[Cron Job] Cleaned up ${deletedLogs.count} user login logs older than 60 days.`);
  }

  // Clean up CronRun records older than 90 days
  const ninetyDaysAgo = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
  const deletedCronRuns = await client.cronRun.deleteMany({
    where: {
      started_at: { lt: ninetyDaysAgo }
    }
  });

  return {
    noShowCount,
    skippedPaidCount,
    completedBookings: completedPast.bookingCount,
    completedPersons: completedPast.personCount,
    expiredPreorders,
    deletedLoginLogs: deletedLogs.count,
    deletedCronRuns: deletedCronRuns.count
  };
}

export const startCronJobs = () => {
  // 1. Run every day at midnight (00:00) Taipei time
  cron.schedule('0 0 * * *', async () => {
    const now = new Date();
    const { daily } = taipeiCronRunKeys(now);
    console.log('[Cron Job] Running midnight attendance check & expired preorder cleanup...');
    try {
      await runCronOnce('midnight', daily, () => runMidnightJob(now));
    } catch (error) {
      console.error('[Cron Job] Error during midnight attendance check:', error);
    }
  }, { timezone: 'Asia/Taipei' });

  // 1b. Every day at 00:10 Taipei time: mark overdue ACTIVE passes as EXPIRED
  cron.schedule('10 0 * * *', async () => {
    const now = new Date();
    const { daily } = taipeiCronRunKeys(now);
    try {
      await runCronOnce('pass_expiry', daily, () => expireOverduePasses(now));
    } catch (error) {
      console.error('[Cron Job] Error marking overdue passes as EXPIRED:', error);
    }
  }, { timezone: 'Asia/Taipei' });

  // Print lease timeout checker: every 30 seconds (spec 5.7)
  // 列印租約超時檢查為冪等的 updateMany (WHERE status = 'claimed' AND lease_until < now)，
  // 多行程同時執行結果一致且每 30 秒執行一次，不需使用 CronRun 資料庫鎖。
  setInterval(async () => {
    try {
      const now = new Date();
      await prisma.printJob.updateMany({
        where: {
          status: 'claimed',
          lease_until: { lt: now }
        },
        data: {
          status: 'failed',
          error_code: 'no_report',
          error_message: '沒有回報結果，請確認是否已印出'
        }
      });
    } catch (err) {
      // silence transient DB check errors
    }
  }, 30000);

  // 2. 每小時檢查並自動釋放逾期未付款之預購虛擬帳號
  cron.schedule('0 * * * *', async () => {
    const now = new Date();
    const { hourly } = taipeiCronRunKeys(now);
    try {
      await runCronOnce('shop_expiry', hourly, () => releaseExpiredPreorders(now));
    } catch (err) {
      console.error('[Cron Job] Error checking expired preorders hourly:', err);
    }
  }, { timezone: 'Asia/Taipei' });

  // 2b. 每小時第 5 分鐘檢查並自動取消逾期未付款之半自助日預約
  cron.schedule('5 * * * *', async () => {
    const now = new Date();
    const { hourly } = taipeiCronRunKeys(now);
    try {
      await runCronOnce('prepay_expiry', hourly, () => releaseExpiredPrepays());
    } catch (err) {
      console.error('[Cron Job] Error releasing expired self-service prepays:', err);
    }
  }, { timezone: 'Asia/Taipei' });

  // 3. Run every day at 23:59 to solidify daily prices through today (Taipei time)
  cron.schedule('59 23 * * *', async () => {
    const now = new Date();
    const { daily } = taipeiCronRunKeys(now);
    console.log('[Cron Job] Solidifying daily settings through today...');
    try {
      const { dateObject: todayDateUtc } = getTaipeiDateParts(now);
      await runCronOnce('solidify_prices', daily, () => solidifyDailyPrices({ through: todayDateUtc }));
    } catch (error) {
      console.error('[Cron Job] Error solidifying daily settings:', error);
    }
  }, { timezone: 'Asia/Taipei' });

  // 4. Kiosk Offline Alert Check (every 5 minutes, Taipei timezone)
  cron.schedule('*/5 * * * *', async () => {
    const now = new Date();
    const { fiveMin } = taipeiCronRunKeys(now);
    try {
      await runCronOnce('kiosk_offline_alert', fiveMin, () => checkKioskOfflineAlerts(prisma, now));
    } catch (err) {
      console.error('[Cron Job] checkKioskOfflineAlerts error:', err);
    }
  }, { timezone: 'Asia/Taipei' });

  console.log('[Cron Job] Scheduled midnight attendance check, 00:10 pass expiry, hourly preorder/prepay cleaners, price solidification, and kiosk offline monitor.');
};

/**
 * 逾期未付款預購單自動取消排程。
 * 店主已決定：所有付款方式皆適用付款期限（包括到店付款）；
 * 僅取消 pending_payment 且已過期之訂單（reported_pending_verify 不自動取消），
 * 新單（auto_expire = true）一律適用，舊單則維持僅取消有佔用 POOL_ACCOUNT 帳號池之訂單。
 */
export const releaseExpiredPreorders = async (nowOverride = null) => {
  const now = (process.env.NODE_ENV === 'test' && nowOverride)
    ? new Date(nowOverride)
    : new Date();

  const poolMethodConfigs = await prisma.paymentMethodConfig.findMany({
    where: { method_type: 'POOL_ACCOUNT' },
    select: { code: true }
  });
  const poolMethodCodes = Array.from(
    new Set(['ctbc_pool', ...poolMethodConfigs.map((m) => m.code).filter(Boolean)])
  );

  const expiredOrders = await prisma.productOrder.findMany({
    where: {
      order_status: 'preorder_placed',
      payment_status: 'pending_payment',
      payment_deadline: { lt: now },
      OR: [
        { auto_expire: true },
        {
          payment_method_code: { in: poolMethodCodes },
          assigned_pool_account: { not: null }
        }
      ]
    }
  });

  if (expiredOrders.length === 0) return 0;

  console.log(`[Cron Job] Found ${expiredOrders.length} expired preorders to cancel...`);
  let cancelledCount = 0;

  for (const order of expiredOrders) {
    try {
      await prisma.$transaction(async (tx) => {
        // 原子性 updateMany 確保狀態在交易執行時仍為 preorder_placed & pending_payment 才進行取消
        const updateResult = await tx.productOrder.updateMany({
          where: {
            id: order.id,
            order_status: 'preorder_placed',
            payment_status: 'pending_payment'
          },
          data: {
            order_status: 'cancelled',
            admin_note: order.admin_note
              ? `${order.admin_note} (系統自動取消：逾期未付款)`
              : '系統自動取消：逾期未付款'
          }
        });

        if (updateResult.count > 0) {
          if (order.assigned_pool_account) {
            await releasePoolAccount(tx, {
              accountNumber: order.assigned_pool_account,
              orderRef: order.order_ref
            });
          }

          await auditService.log(tx, {
            booking_ref: order.order_ref,
            event_type: 'shop_order_expired',
            category: 'shop',
            summary: `商城訂單 ${order.order_ref} 逾期未付款系統自動取消`,
            reason: `超過付款期限未付款（付款方式：${order.payment_method_code}）`,
            before_json: {
              order_status: order.order_status,
              payment_status: order.payment_status
            },
            after_json: {
              order_status: 'cancelled',
              payment_status: order.payment_status
            },
            staff_name: '系統排程'
          });

          cancelledCount++;
        }
      });
    } catch (orderErr) {
      console.error(`[Cron Job] Failed to auto-cancel order #${order.order_ref}:`, orderErr);
    }
  }

  console.log(`[Cron Job] Successfully processed ${cancelledCount} expired preorders.`);
  return cancelledCount;
};
