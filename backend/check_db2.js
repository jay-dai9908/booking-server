import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
prisma.$connect()
  .then(() => {
    console.log('DB OK');
    process.exit(0);
  })
  .catch(e => {
    console.error('DB FAIL:', e);
    process.exit(1);
  });
