import test from 'node:test';
import assert from 'node:assert/strict';
import prisma from '../src/prismaClient.js';
import { ensureDatabaseSchema } from '../src/db/ensureSchema.js';
import {
  isAccountingGuardInstalled,
  getAccountingGuardWarnings,
  setStartupAccountingGuardMissing
} from '../src/db/accountingGuard.js';
import { getStatus } from '../src/controllers/printController.js';

function createMockRes() {
  return {
    statusCode: 200,
    body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; }
  };
}

test('Round 38 Item 1: ensureDatabaseSchema installs AccountingEvent guard idempotently and getStatus surfaces missing guard warning', async () => {
  try {
    // 1. Simulate DB before guard exists (drop trigger + function)
    await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS trg_accounting_event_guard ON "AccountingEvent";');
    await prisma.$executeRawUnsafe('DROP FUNCTION IF EXISTS prevent_accounting_event_modification();');

    assert.equal(await isAccountingGuardInstalled(prisma), false);

    // 2. While guard is missing, GET /api/print/status warns clearly
    const warnRes = createMockRes();
    await getStatus({}, warnRes);
    assert.equal(warnRes.statusCode, 200);
    assert.ok(Array.isArray(warnRes.body.warnings));
    assert.equal(warnRes.body.warnings.length, 1);
    assert.equal(warnRes.body.warnings[0].code, 'ACCOUNTING_EVENT_GUARD_MISSING');

    // 3. Running ensureDatabaseSchema automatically installs the guard (no manual script needed)
    await ensureDatabaseSchema(prisma);
    assert.equal(await isAccountingGuardInstalled(prisma), true);

    // 4. Running ensureDatabaseSchema a second time is idempotent and leaves exactly 1 trigger
    await ensureDatabaseSchema(prisma);
    const triggerRows = await prisma.$queryRaw`
      SELECT t.tgname
      FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      WHERE c.relname = 'AccountingEvent'
        AND t.tgname = 'trg_accounting_event_guard'
        AND NOT t.tgisinternal
    `;
    assert.equal(triggerRows.length, 1);

    // 5. getStatus warnings clear once guard is installed
    const okRes = createMockRes();
    await getStatus({}, okRes);
    assert.equal(okRes.statusCode, 200);
    assert.deepEqual(okRes.body.warnings, []);

    // 6. Trigger rejects UPDATE and DELETE on AccountingEvent with append-only error
    const ev = await prisma.accountingEvent.create({
      data: {
        event_type: 'guard_test',
        category: 'status',
        summary: 'R38 guard immutability verification',
        staff_name: 'R38測試員',
        device_label: 'R38測試機'
      }
    });

    await assert.rejects(
      () => prisma.$executeRaw`UPDATE "AccountingEvent" SET summary = 'tampered' WHERE id = ${ev.id}`,
      (err) => /append-only/i.test(err.message || '')
    );

    await assert.rejects(
      () => prisma.$executeRaw`DELETE FROM "AccountingEvent" WHERE id = ${ev.id}`,
      (err) => /append-only/i.test(err.message || '')
    );
  } finally {
    // Always restore trigger & clear startup warning flag for subsequent tests
    await ensureDatabaseSchema(prisma);
    setStartupAccountingGuardMissing(false);
    const warnings = await getAccountingGuardWarnings(prisma);
    assert.deepEqual(warnings, []);
  }
});
