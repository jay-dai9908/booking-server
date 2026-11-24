import cron from 'node-cron';
import prisma from './prismaClient.js';
import { getTaipeiDateParts } from './utils/dateUtils.js';
import { releasePoolAccount } from './services/selfService/poolAccountService.js';
import { releaseExpiredPrepays } from './services/selfService/prepayService.js';
import { checkKioskOfflineAlerts } from './services/kiosk/alertService.js';
import { solidifyDailyPrices } from './services/pricing/solidify.js';

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
 * 逾期未付款預購單自動取消並釋放虛擬帳號回帳號池（僅針對 ctbc_pool 且真正佔用帳號之訂單）
 */
export const releaseExpiredPreorders = async () => {
  const now = new Date();
  const expiredOrders = await prisma.productOrder.findMany({
    where: {
      payment_method_code: 'ctbc_pool',
      assigned_pool_account: { not: null },
      order_status: 'preorder_placed',
      payment_status: 'pending_payment',
      payment_deadline: { lt: now }
    }
  });

  if (expiredOrders.length === 0) return 0;

  console.log(`[Cron Job] Found ${expiredOrders.length} expired ctbc_pool preorders to cancel...`);
  let cancelledCount = 0;

  for (const order of expiredOrders) {
    try {
      await prisma.$transaction(async (tx) => {
        // 原子性 updateMany 確保狀態在交易執行時仍為 preorder_placed 才進行取消
        const updateResult = await tx.productOrder.updateMany({
          where: {
            id: order.id,
            order_status: 'preorder_placed',
            payment_status: 'pending_payment'
          },
          data: {
            order_status: 'cancelled',
            admin_note: order.admin_note
              ? `${order.admin_note} (系統自動取消：逾期未繳納訂金)`
              : '系統自動取消：逾期未繳納訂金'
          }
        });

        // 僅在訂單成功被更新為 cancelled 且確有佔用帳號時，才釋放帳號回帳號池
        if (updateResult.count > 0 && order.assigned_pool_account) {
          await releasePoolAccount(tx, {
            accountNumber: order.assigned_pool_account,
            orderRef: order.order_ref
          });
          cancelledCount++;
        }
      });
    } catch (orderErr) {
      console.error(`[Cron Job] Failed to auto-cancel order #${order.order_ref}:`, orderErr);
    }
  }

  console.log(`[Cron Job] Successfully processed ${cancelledCount} expired ctbc_pool preorders.`);
  return cancelledCount;
};
