import cron from 'node-cron';
import prisma from './prismaClient.js';

export const startCronJobs = () => {
  // Run every day at midnight (00:00)
  cron.schedule('0 0 * * *', async () => {
    console.log('[Cron Job] Running midnight attendance check...');
    try {
      // Find all sessions from yesterday or earlier
      const today = new Date();
      today.setHours(0, 0, 0, 0); // Start of today

      const pastSessions = await prisma.session.findMany({
        where: {
          session_date: {
            lt: today
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
    } catch (error) {
      console.error('[Cron Job] Error during midnight attendance check:', error);
    }
  });

  // Run every day at 23:59 to solidify today's price
  cron.schedule('59 23 * * *', async () => {
    console.log('[Cron Job] Solidifying daily settings for today...');
    try {
      const today = new Date();
      // Ensure we are working with today's date at 00:00:00 for the database
      today.setHours(0, 0, 0, 0);

      const existingSetting = await prisma.dailySetting.findUnique({
        where: { date: today }
      });

      // If there's no setting, or if it lacks prices, pull from global
      if (!existingSetting || existingSetting.hourly_price === null || existingSetting.unlimited_price === null) {
        let globalSetting = await prisma.globalSetting.findUnique({ where: { id: 1 } });
        if (!globalSetting) return;

        const dayOfWeek = today.getDay();
        const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;

        const hourly_price = isWeekend ? globalSetting.weekend_hourly_price : globalSetting.weekday_hourly_price;
        const unlimited_price = isWeekend ? globalSetting.weekend_unlimited_price : globalSetting.weekday_unlimited_price;

        await prisma.dailySetting.upsert({
          where: { date: today },
          update: {
            hourly_price: existingSetting?.hourly_price ?? hourly_price,
            unlimited_price: existingSetting?.unlimited_price ?? unlimited_price
          },
          create: {
            date: today,
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
  });

  console.log('[Cron Job] Scheduled midnight attendance check and price solidification.');
};
