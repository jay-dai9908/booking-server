import { PrismaClient } from '@prisma/client';
import { installAccountingGuard } from '../src/db/accountingGuard.js';

const url = process.env.TEST_DATABASE_URL || 'postgresql://user:password@localhost:5432/booking_db_test?schema=public';
const prisma = new PrismaClient({ datasources: { db: { url } } });

async function main() {
  await installAccountingGuard(prisma);
  console.log('Successfully applied accounting_event_guard to', url);
  await prisma.$disconnect();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
