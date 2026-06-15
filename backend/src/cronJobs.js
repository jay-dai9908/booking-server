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

  console.log('[Cron Job] Scheduled midnight attendance check.');
};
