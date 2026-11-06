import fs from 'fs';
import { PrismaClient } from '@prisma/client';

const url = process.env.TEST_DATABASE_URL || 'postgresql://user:password@localhost:5432/booking_db_test?schema=public';
const prisma = new PrismaClient({ datasources: { db: { url } } });

async function main() {
  const sql = fs.readFileSync(new URL('../prisma/sql/accounting_event_guard.sql', import.meta.url), 'utf8');
  
  // Statement 1: function
  const funcSql = `CREATE OR REPLACE FUNCTION prevent_accounting_event_modification()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'AccountingEvent records are append-only and cannot be modified or deleted!';
END;
$$ LANGUAGE plpgsql;`;

  // Statement 2: drop trigger
  const dropSql = `DROP TRIGGER IF EXISTS trg_accounting_event_guard ON "AccountingEvent";`;

  // Statement 3: create trigger
  const createSql = `CREATE TRIGGER trg_accounting_event_guard
BEFORE UPDATE OR DELETE ON "AccountingEvent"
FOR EACH ROW
EXECUTE FUNCTION prevent_accounting_event_modification();`;

  await prisma.$executeRawUnsafe(funcSql);
  await prisma.$executeRawUnsafe(dropSql);
  await prisma.$executeRawUnsafe(createSql);
  console.log('Successfully applied accounting_event_guard to', url);
  await prisma.$disconnect();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
