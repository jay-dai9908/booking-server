import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  const rs = await prisma.reservation.findMany({
    where: { 
      session: { session_date: new Date('2026-06-19T00:00:00.000Z') }
    },
    include: { user: true, session: true }
  });
  
  console.log('--- DB STATE FOR 2026-06-19 ---');
  rs.forEach(r => {
    if (r.user.name === 'KK' || r.user.name === 'Nataile') {
      console.log(`[${r.user.name}] Time: ${r.session.start_time}, Pax: ${r.pax}, Seats Array:`, r.assigned_seats);
    }
  });
}

main().catch(console.error).finally(() => prisma.$disconnect());
