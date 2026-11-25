import cron from 'node-cron';
import prisma from './prismaClient.js';
import { getTaipeiDateParts } from './utils/dateUtils.js';
import { releasePoolAccount } from './services/selfService/poolAccountService.js';
import { releaseExpiredPrepays } from './services/selfService/prepayService.js';
import { checkKioskOfflineAlerts } from './services/kiosk/alertService.js';
import { solidifyDailyPrices } from './services/pricing/solidify.js';
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

export const startCronJobs = () => {
  // 1. Run every day at midnight (00:00) Taipei time
  cron.schedule('0 0 * * *', async () => {
    console.log('[Cron Job] Running midnight attendance check & expired preorder cleanup...');
    try {
      // Find all sessions from yesterday or earlier using precise Taipei midnight
      const { dateObject: todayMidnightUtc } = getTaipeiDateParts(new Date());

      const pastSessions = await prisma.session.findMany({
        where: {
          session_date: {
            lt: todayMidnightUtc
          }
        },
        select: { id: true }
      });

      const pastSessionIds = pastSessions.map(s => s.id);

      if (pastSessionIds.length > 0) {
        // Update all reservations for these sessions that are confirmed and attendance is null
        const result = await prisma.reservation.updateMany({
          where: {
            session_id: { in: pastSessionIds },
            status: 'confirmed',
            attendance: null
          },
          data: {
            attendance: 'no_show'
          }
        });

        console.log(`[Cron Job] Successfully marked ${result.count} reservations as no_show.`);
      } else {
        console.log('[Cron Job] No past sessions found.');
      }

      // 2026-11-22 店主定案：前一天以前仍為 checked_in 的預約在 00:00 自動改成 completed，left_at 補為 timer_ended_at 或執行時間
      const completedPast = await markPastCheckedInAsCompleted(new Date());
      if (completedPast.bookingCount > 0 || completedPast.personCount > 0) {
        console.log(`[Cron Job] Auto-completed ${completedPast.bookingCount} past checked-in bookings (${completedPast.personCount} persons left_at filled).`);
      }

      // 自動釋放逾期未繳費預購單與虛擬帳號
      await releaseExpiredPreorders();

      // Clean up UserLoginLog records older than 60 days (2 months)
      const sixtyDaysAgo = new Date();
      sixtyDaysAgo.setDate(sixtyDaysAgo.getDate() - 60);
      const deletedLogs = await prisma.userLoginLog.deleteMany({
        where: {
          created_at: { lt: sixtyDaysAgo }
        }
      });
      if (deletedLogs.count > 0) {
        console.log(`[Cron Job] Cleaned up ${deletedLogs.count} user login logs older than 60 days.`);
      }
    } catch (error) {
      console.error('[Cron Job] Error during midnight attendance check:', error);
    }
  }, { timezone: 'Asia/Taipei' });

  // Print lease timeout checker: every 30 seconds (spec 5.7)
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
    try {
      await releaseExpiredPreorders();
    } catch (err) {
      console.error('[Cron Job] Error checking expired preorders hourly:', err);
    }
  }, { timezone: 'Asia/Taipei' });

  // 2b. 每小時第 5 分鐘檢查並自動取消逾期未付款之半自助日預約
  cron.schedule('5 * * * *', async () => {
    try {
      await releaseExpiredPrepays();
    } catch (err) {
      console.error('[Cron Job] Error releasing expired self-service prepays:', err);
    }
  }, { timezone: 'Asia/Taipei' });

  // 3. Run every day at 23:59 to solidify daily prices through today (Taipei time)
  cron.schedule('59 23 * * *', async () => {
    console.log('[Cron Job] Solidifying daily settings through today...');
    try {
      const { dateObject: todayDateUtc } = getTaipeiDateParts(new Date());
      await solidifyDailyPrices({ through: todayDateUtc });
    } catch (error) {
      console.error('[Cron Job] Error solidifying daily settings:', error);
    }
  }, { timezone: 'Asia/Taipei' });

  // 4. Kiosk Offline Alert Check (every 5 minutes)
  cron.schedule('*/5 * * * *', async () => {
    try {
      await checkKioskOfflineAlerts(prisma);
    } catch (err) {
      console.error('[Cron Job] checkKioskOfflineAlerts error:', err);
    }
  });

  console.log('[Cron Job] Scheduled midnight attendance check, hourly preorder pool cleaner, price solidification, and kiosk offline monitor.');
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
