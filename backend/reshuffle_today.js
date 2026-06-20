import prisma from './src/prismaClient.js';
import { allocateSeats } from './src/utils/seatAllocator.js';

async function reshuffle() {
  const start = new Date('2026-06-20T00:00:00Z');
  const end = new Date('2026-06-21T00:00:00Z');

  const sessions = await prisma.session.findMany({
    where: { session_date: { gte: start, lt: end } }
  });
  const sessionIds = sessions.map(s => s.id);

  const reservations = await prisma.reservation.findMany({
    where: { session_id: { in: sessionIds }, status: 'confirmed' }
  });

  // 解開所有人的手動鎖定（除了已經報到的）
  for (const r of reservations) {
    if (r.attendance !== 'checked_in') {
      r.is_seat_locked = false;
      r.assigned_seats = []; // 清空座位讓系統重抓
    }
  }

  // 呼叫我們的智能演算法重新洗牌
  const allocResult = allocateSeats(reservations, null, true);
  console.log('Reshuffle Success:', allocResult.success);

  if (allocResult.updates && allocResult.updates.length > 0) {
    const txs = allocResult.updates.map(update => 
      prisma.reservation.updateMany({
        where: { booking_ref: update.booking_ref },
        data: { 
          assigned_seats: update.assigned_seats,
          is_seat_locked: false // 恢復預設
        }
      })
    );
    await prisma.$transaction(txs);
    console.log(`Successfully reallocated ${allocResult.updates.length} groups.`);
  } else {
    console.log('No updates needed or no space available.');
  }
}

reshuffle()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
