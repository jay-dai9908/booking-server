const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const collisions = await prisma.$queryRawUnsafe(`
    select session_id, seat, count(distinct booking_ref)::int as count
    from "Reservation", unnest(assigned_seats) seat
    where status <> 'cancelled' and seat not like 'WAIT-%'
    group by 1, 2 having count(distinct booking_ref) > 1;
  `);
  console.log('Seat collisions:', collisions.length, collisions);
  if (collisions.length > 0) {
    console.error('Fatal: collisions found!');
    process.exit(1);
  } else {
    console.log('Pass: 0 seat collisions in database!');
    process.exit(0);
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
}).finally(() => prisma.$disconnect());
