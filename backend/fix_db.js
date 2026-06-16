import { PrismaClient } from '@prisma/client';
import { allocateSeats } from './src/utils/SeatAllocator.js';

const prisma = new PrismaClient();

async function main() {
  const dates = await prisma.session.findMany({
    select: { session_date: true },
    distinct: ['session_date']
  });

  for (const { session_date } of dates) {
    console.log(`Processing date: ${session_date.toISOString().split('T')[0]}`);
    
    await prisma.$transaction(async (tx) => {
      const sessionsOfDay = await tx.session.findMany({
        where: { session_date }
      });
      const sessionIds = sessionsOfDay.map(s => s.id);

      const currentReservations = await tx.reservation.findMany({
        where: { session_id: { in: sessionIds }, status: 'confirmed' }
      });

      if (currentReservations.length === 0) return;

      // Pass a dummy new reservation with 0 pax to trigger reshuffle without adding anyone
      const dummyNewRes = { booking_ref: 'DUMMY', pax: 0, session_ids: [] };

      const allocResult = allocateSeats(currentReservations, dummyNewRes, true);

      if (allocResult.success && allocResult.updates) {
        let count = 0;
        for (const update of allocResult.updates) {
          if (update.booking_ref === 'DUMMY') continue;
          await tx.reservation.updateMany({
            where: { booking_ref: update.booking_ref },
            data: { assigned_seats: update.assigned_seats }
          });
          count++;
        }
        if (count > 0) {
          console.log(`  -> Fixed ${count} inconsistent blocks.`);
        }
      } else {
        console.log(`  -> Failed to allocate:`, allocResult.error);
      }
    });
  }
}

main()
  .catch(e => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
