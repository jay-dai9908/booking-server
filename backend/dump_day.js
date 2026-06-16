import { PrismaClient } from '@prisma/client';
import fs from 'fs';

const prisma = new PrismaClient();

async function main() {
  const rs = await prisma.reservation.findMany({
    where: { 
      session: { session_date: new Date('2026-06-19T00:00:00.000Z') },
      status: 'confirmed'
    },
    include: { user: true, session: true },
    orderBy: [
      { session: { start_time: 'asc' } }
    ]
  });

  const blocksMap = new Map();
  for (const r of rs) {
    if (!blocksMap.has(r.booking_ref)) {
      blocksMap.set(r.booking_ref, {
        name: r.user.name,
        pax: r.pax,
        assigned_seats: r.assigned_seats || [],
        sessions: []
      });
    }
    blocksMap.get(r.booking_ref).sessions.push(r.session.start_time);
  }

  let output = '=== 2026-06-19 Reservations ===\n';
  
  for (const block of blocksMap.values()) {
    const timeSpan = `${block.sessions[0]} ~ ${block.sessions[block.sessions.length - 1]}`;
    output += `${block.name} | Pax: ${block.pax} | Time: ${timeSpan} (${block.sessions.length} hr) | Seats: ${block.assigned_seats.join(', ')}\n`;
  }

  console.log(output);
}

main().catch(console.error).finally(() => prisma.$disconnect());
