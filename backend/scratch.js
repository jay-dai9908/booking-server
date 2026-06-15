import prisma from './src/prismaClient.js';
async function test() {
  const reservations = await prisma.reservation.findMany({
    include: {
      session: true,
      user: {
        select: { name: true, phone: true }
      }
    },
    orderBy: { created_at: 'desc' },
    take: 1
  });
  console.log(reservations[0]);
}
test().catch(console.error).finally(() => prisma.$disconnect());
