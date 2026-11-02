import cron from 'node-cron';
import prisma from './prismaClient.js';
import { getTaipeiDateParts } from './utils/dateUtils.js';

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

  // 2. 每小時檢查並自動釋放逾期未付款之預購虛擬帳號
  cron.schedule('0 * * * *', async () => {
    try {
      await releaseExpiredPreorders();
    } catch (err) {
      console.error('[Cron Job] Error checking expired preorders hourly:', err);
    }
  }, { timezone: 'Asia/Taipei' });

  // 3. Run every day at 23:59 to solidify today's price (Taipei time)
  cron.schedule('59 23 * * *', async () => {
    console.log('[Cron Job] Solidifying daily settings for today...');
    try {
      const { dateObject: todayDateUtc, isWeekend } = getTaipeiDateParts(new Date());

      const existingSetting = await prisma.dailySetting.findUnique({
        where: { date: todayDateUtc }
      });

      // If there's no setting, or if it lacks prices, pull from global
      if (!existingSetting || existingSetting.hourly_price === null || existingSetting.unlimited_price === null) {
        let globalSetting = await prisma.globalSetting.findUnique({ where: { id: 1 } });
        if (!globalSetting) return;

        const hourly_price = isWeekend ? globalSetting.weekend_hourly_price : globalSetting.weekday_hourly_price;
        const unlimited_price = isWeekend ? globalSetting.weekend_unlimited_price : globalSetting.weekday_unlimited_price;

        await prisma.dailySetting.upsert({
          where: { date: todayDateUtc },
          update: {
            hourly_price: existingSetting?.hourly_price ?? hourly_price,
            unlimited_price: existingSetting?.unlimited_price ?? unlimited_price
          },
          create: {
            date: todayDateUtc,
            allow_unlimited: true,
            hourly_price,
            unlimited_price
          }
        });
        console.log('[Cron Job] Successfully solidified pricing for today.');
      } else {
        console.log('[Cron Job] Pricing for today is already solidified.');
      }
    } catch (error) {
      console.error('[Cron Job] Error solidifying daily settings:', error);
    }
  }, { timezone: 'Asia/Taipei' });

  console.log('[Cron Job] Scheduled midnight attendance check, hourly preorder pool cleaner, and price solidification.');
};

/**
 * 逾期未付款預購單自動取消並釋放虛擬帳號回帳號池
 */
export const releaseExpiredPreorders = async () => {
  const now = new Date();
  const expiredOrders = await prisma.productOrder.findMany({
    where: {
      order_status: 'preorder_placed',
      payment_status: 'pending_payment',
      payment_deadline: { lt: now }
    }
  });

  if (expiredOrders.length === 0) return 0;

  console.log(`[Cron Job] Found ${expiredOrders.length} expired preorders to cancel...`);

  for (const order of expiredOrders) {
    try {
      await prisma.$transaction(async (tx) => {
        await tx.productOrder.update({
          where: { id: order.id },
          data: {
            order_status: 'cancelled',
            admin_note: order.admin_note
              ? `${order.admin_note} (系統自動取消：逾期未繳納訂金)`
              : '系統自動取消：逾期未繳納訂金'
          }
        });

        if (order.assigned_pool_account) {
          await tx.oneTimeAccountPool.updateMany({
            where: {
              account_number: order.assigned_pool_account,
              status: 'ASSIGNED'
            },
            data: {
              status: 'AVAILABLE',
              assigned_order_ref: null,
              assigned_user_id: null,
              assigned_at: null
            }
          });
        }
      });
    } catch (orderErr) {
      console.error(`[Cron Job] Failed to auto-cancel order #${order.order_ref}:`, orderErr);
    }
  }

  console.log(`[Cron Job] Successfully processed ${expiredOrders.length} expired preorders.`);
  return expiredOrders.length;
};
