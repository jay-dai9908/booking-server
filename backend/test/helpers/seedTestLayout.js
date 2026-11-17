import { dateOnly } from '../../../shared/time.js';

/**
 * Ensures a published SeatLayout with at least one zone, table, and seats exists
 * for the given effective test date when running against an empty database.
 * Returns the newly created layout id (or null if a valid published layout already existed).
 *
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {object} [options]
 * @param {string} [options.name]
 * @param {string|Date} [options.effectiveFrom]
 * @param {string|Date} [options.effectiveDate]
 * @param {string} [options.codePrefix]
 * @param {number} [options.seatCount]
 * @returns {Promise<number|null>}
 */
export async function ensureTestPublishedLayout(prisma, {
  name = 'R25 Test Layout',
  effectiveFrom = '2020-01-01',
  effectiveDate = '2099-12-31',
  codePrefix = 'A',
  seatCount = 16
} = {}) {
  const targetDate = dateOnly(effectiveDate);
  const existing = await prisma.seatLayout.findFirst({
    where: {
      status: 'published',
      effective_from: { lte: targetDate }
    },
    orderBy: [
      { effective_from: 'desc' },
      { id: 'desc' }
    ],
    include: {
      seats: { where: { is_active: true }, select: { id: true } }
    }
  });

  if (existing && existing.seats.length > 0) {
    return null;
  }

  const layout = await prisma.seatLayout.create({
    data: {
      name,
      status: 'published',
      effective_from: dateOnly(effectiveFrom),
      capacity: seatCount
    }
  });

  const zone = await prisma.seatZone.create({
    data: {
      layout_id: layout.id,
      name: '測試前區',
      sort_order: 1
    }
  });

  const table = await prisma.seatTable.create({
    data: {
      layout_id: layout.id,
      zone_id: zone.id,
      label: 'T1',
      shape: 'rect',
      arrangement: 'two_sides',
      cx: 300,
      cy: 250,
      sort_order: 1
    }
  });

  await prisma.seat.createMany({
    data: Array.from({ length: seatCount }, (_, i) => ({
      layout_id: layout.id,
      zone_id: zone.id,
      table_id: table.id,
      code: `${codePrefix}${i + 1}`,
      lx: (i % 2 === 0 ? -45 : 45),
      ly: Math.floor(i / 2) * 35 - 100,
      side_mode: 'auto',
      is_active: true,
      sort_order: i + 1
    }))
  });

  return layout.id;
}

/**
 * Deletes a layout created by ensureTestPublishedLayout in FK-safe dependency order
 * (Seat -> SeatTable -> SeatZone -> SeatLayout).
 *
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {number|null|undefined} layoutId
 */
export async function cleanupTestPublishedLayout(prisma, layoutId) {
  if (!layoutId) return;
  await prisma.seat.deleteMany({ where: { layout_id: layoutId } });
  await prisma.seatTable.deleteMany({ where: { layout_id: layoutId } });
  await prisma.seatZone.deleteMany({ where: { layout_id: layoutId } });
  await prisma.seatLayout.deleteMany({ where: { id: layoutId } });
}
