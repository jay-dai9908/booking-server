import prisma from '../prismaClient.js';

export const GUARD_FUNCTION_SQL = `CREATE OR REPLACE FUNCTION prevent_accounting_event_modification()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'AccountingEvent records are append-only and cannot be modified or deleted!';
END;
$$ LANGUAGE plpgsql;`;

export const DROP_GUARD_TRIGGER_SQL = `DROP TRIGGER IF EXISTS trg_accounting_event_guard ON "AccountingEvent";`;

export const CREATE_GUARD_TRIGGER_SQL = `CREATE TRIGGER trg_accounting_event_guard
BEFORE UPDATE OR DELETE ON "AccountingEvent"
FOR EACH ROW
EXECUTE FUNCTION prevent_accounting_event_modification();`;

export const GUARD_TRIGGER_SQL = `${DROP_GUARD_TRIGGER_SQL}\n${CREATE_GUARD_TRIGGER_SQL}`;

let startupGuardCheckFailed = false;

export function setStartupAccountingGuardMissing(missing) {
  startupGuardCheckFailed = Boolean(missing);
}

export async function installAccountingGuard(prismaClient = prisma) {
  await prismaClient.$executeRawUnsafe(GUARD_FUNCTION_SQL);
  await prismaClient.$executeRawUnsafe(DROP_GUARD_TRIGGER_SQL);
  await prismaClient.$executeRawUnsafe(CREATE_GUARD_TRIGGER_SQL);
}

export async function isAccountingGuardInstalled(prismaClient = prisma) {
  const rows = await prismaClient.$queryRaw`
    SELECT t.tgname
    FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    WHERE c.relname = 'AccountingEvent'
      AND t.tgname = 'trg_accounting_event_guard'
      AND NOT t.tgisinternal
  `;
  return Array.isArray(rows) && rows.length > 0;
}

export async function getAccountingGuardWarnings(prismaClient = prisma) {
  let installed = false;
  try {
    installed = await isAccountingGuardInstalled(prismaClient);
    if (installed) startupGuardCheckFailed = false;
  } catch {
    installed = false;
  }
  if (!installed || startupGuardCheckFailed) {
    return [
      {
        code: 'ACCOUNTING_EVENT_GUARD_MISSING',
        message: 'AccountingEvent 不可竄改觸發器（trg_accounting_event_guard）未安裝，請檢查資料庫權限與結構初始化'
      }
    ];
  }
  return [];
}
