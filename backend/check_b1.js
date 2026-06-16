import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  const rs = await prisma.reservation.findMany({
    where: { 
      session: { session_date: new Date('2026-06-19T00:00:00.000Z') },
      status: 'confirmed'
    },
    include: { user: true, session: true },
    orderBy: { session: { start_time: 'asc' } }
  });
  
  console.log('--- Who is sitting at B1-3 and B1-4 on 2026-06-19? ---');
  let found = false;
  rs.forEach(r => {
    if (r.assigned_seats && (r.assigned_seats.includes('B1-3') || r.assigned_seats.includes('B1-4'))) {
      console.log(`Time: ${r.session.start_time}, User: ${r.user.name}, Seats:`, r.assigned_seats);
      found = true;
    }
  });
  if (!found) console.log("NO ONE is sitting at B1-3 or B1-4 all day.");
}

main().catch(console.error).finally(() => prisma.$disconnect());
