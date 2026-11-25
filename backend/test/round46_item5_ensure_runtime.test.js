import test from 'node:test';
import assert from 'node:assert/strict';
import prisma from '../src/prismaClient.js';
import { ensureDatabaseSchema } from '../src/db/ensureSchema.js';

test('Round 46 Item 5: ensureDatabaseSchema adds BoardPause/indexes without wiping BannedIP or lockdown mode', async () => {
  const ts = Date.now();
  const fakeIp = `198.51.100.${ts % 250}`;
  const origGlobal = await prisma.globalSetting.findUnique({ where: { id: 1 } });
  let createdBoardPauseId = null;

  try {
    await prisma.bannedIP.create({
      data: {
        ip: fakeIp,
        reason: 'Too many login attempts'
      }
    });

    await prisma.globalSetting.upsert({
      where: { id: 1 },
      update: { is_lockdown_mode: true },
      create: { id: 1, is_lockdown_mode: true }
    });

    await ensureDatabaseSchema(prisma);

    // 1) Startup side effects must NOT wipe BannedIP or disable is_lockdown_mode
    const bannedStill = await prisma.bannedIP.findUnique({ where: { ip: fakeIp } });
    assert.ok(bannedStill, 'BannedIP must remain intact after ensureDatabaseSchema');
    const gsAfter = await prisma.globalSetting.findUnique({ where: { id: 1 } });
    assert.equal(gsAfter.is_lockdown_mode, true, 'is_lockdown_mode must remain true after ensureDatabaseSchema');

    // 2) BoardPause table & indexes exist and BoardPause row can be created
    const bp = await prisma.boardPause.create({
      data: {
        unit_group: `r46-ug-${ts}`,
        started_at: new Date(),
        source: 'solo',
        staff_name: 'R46測試'
      }
    });
    createdBoardPauseId = bp.id;
    assert.ok(bp.id > 0);

    const indexes = await prisma.$queryRaw`
      SELECT indexname FROM pg_indexes WHERE schemaname = 'public'
    `;
    const indexSet = new Set(indexes.map((r) => r.indexname));
    assert.ok(indexSet.has('BoardPause_unit_group_idx'), 'BoardPause_unit_group_idx missing in pg_indexes');
    assert.ok(indexSet.has('Payment_client_batch_id_idx'), 'Payment_client_batch_id_idx missing in pg_indexes');
    assert.ok(indexSet.has('BookingEquipment_booking_ref_idx'), 'BookingEquipment_booking_ref_idx missing in pg_indexes');
    assert.ok(indexSet.has('BookingEquipment_unit_group_idx'), 'BookingEquipment_unit_group_idx missing in pg_indexes');
  } finally {
    if (createdBoardPauseId) {
      await prisma.boardPause.deleteMany({ where: { id: createdBoardPauseId } });
    }
    await prisma.bannedIP.deleteMany({ where: { ip: fakeIp } });
    if (origGlobal) {
      await prisma.globalSetting.update({
        where: { id: 1 },
        data: { is_lockdown_mode: origGlobal.is_lockdown_mode }
      });
    }
  }
});
