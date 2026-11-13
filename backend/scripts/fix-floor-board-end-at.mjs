import '../src/loadEnv.js';
import prisma from '../src/prismaClient.js';

/**
 * 一次性修復腳本：修正 addBoardRental 誤填 end_at = planned_end_at 的進行中智能板紀錄。
 * 預設為乾跑 (dry-run)，僅印出符合筆數；傳入 --apply 時才將 end_at 清成 null。
 */
async function main() {
  const apply = process.argv.includes('--apply');
  const candidates = await prisma.bookingEquipment.findMany({
    where: {
      ended_reason: null,
      end_at: { not: null },
      planned_end_at: { not: null }
    },
    select: {
      id: true,
      booking_ref: true,
      unit_group: true,
      end_at: true,
      planned_end_at: true
    }
  });

  const matching = candidates.filter(
    (row) => row.planned_end_at && row.end_at && row.end_at.getTime() === row.planned_end_at.getTime()
  );

  console.log(`Found ${matching.length} BookingEquipment rows where ended_reason IS NULL AND end_at IS NOT NULL AND end_at = planned_end_at.`);

  if (!apply) {
    console.log('Dry-run mode: no rows updated. Pass --apply to update end_at to null.');
    return;
  }

  if (matching.length === 0) {
    console.log('Nothing to update.');
    return;
  }

  const ids = matching.map((r) => r.id);
  const res = await prisma.bookingEquipment.updateMany({
    where: { id: { in: ids } },
    data: { end_at: null }
  });
  console.log(`Updated ${res.count} BookingEquipment rows (end_at = null).`);
}

main()
  .catch((err) => {
    console.error('[fix-floor-board-end-at] Error:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
