import prisma from './src/prismaClient.js';
import { allocateSeats } from './src/utils/seatAllocator.js';

async function fix() {
  const start = new Date('2026-06-20T00:00:00Z');
  const end = new Date('2026-06-21T00:00:00Z');

  const sessions = await prisma.session.findMany({
    where: { session_date: { gte: start, lt: end } }
  });
  const sessionIds = sessions.map(s => s.id);

  const reservations = await prisma.reservation.findMany({
    where: { session_id: { in: sessionIds }, status: 'confirmed' }
  });

  // Detect overlapping seats per session
  const occupied = new Map(); // sessionId_seat -> booking_ref
  const overlappingRefs = new Set();

  for (const r of reservations) {
    if (!r.assigned_seats) continue;
    for (const seat of r.assigned_seats) {
      const key = `${r.session_id}_${seat}`;
      if (occupied.has(key) && occupied.get(key) !== r.booking_ref) {
        overlappingRefs.add(r.booking_ref);
      } else {
        occupied.set(key, r.booking_ref);
      }
    }
  }

  console.log('Overlapping Refs to Reshuffle:', Array.from(overlappingRefs));

  if (overlappingRefs.size > 0) {
    for (const r of reservations) {
      if (overlappingRefs.has(r.booking_ref)) {
        r.is_seat_locked = false;
        r.assigned_seats = [];
      }
    }

    const allocResult = allocateSeats(reservations, null, true);
    console.log('Reshuffle Result:', allocResult.success);
    
    if (allocResult.updates && allocResult.updates.length > 0) {
      for (const update of allocResult.updates) {
        await prisma.reservation.updateMany({
          where: { booking_ref: update.booking_ref },
          data: { assigned_seats: update.assigned_seats }
        });
        console.log(`Updated ${update.booking_ref} to ${update.assigned_seats}`);
      }
    } else {
       for (const ref of overlappingRefs) {
          await prisma.reservation.updateMany({
             where: { booking_ref: ref },
             data: { assigned_seats: ['WAIT-1'] }
          });
       }
    }
  } else {
    console.log('No overlapping seats found.');
  }
}

fix()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
