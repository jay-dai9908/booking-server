// backend/src/scripts/seedSeatLayout.js
import '../loadEnv.js';
import prisma from '../prismaClient.js';

export async function seedSeatLayout() {
  console.log('[Seed SeatLayout] Checking for existing seat layouts...');
  const existing = await prisma.seatLayout.findFirst({
    where: { status: 'published' }
  });

  if (existing) {
    console.log('[Seed SeatLayout] Published layout already exists (id:', existing.id, '). Skipping.');
    return existing;
  }

  console.log('[Seed SeatLayout] Seeding default layout (A1-1 to B2-4)...');

  const defaultRules = {
    spread_tables: true,
    avoid_opposite: true,
    avoid_beside: true,
    zone_mode: 'empty_tables_first',
    weights: {
      zone: 1,
      zone_fill_first: 50,
      opposite: 3,
      beside: 6,
      second: 20,
      last: 100,
      split: 4
    }
  };

  const layout = await prisma.seatLayout.create({
    data: {
      name: '店內格局',
      status: 'published',
      effective_from: new Date('2000-01-01'),
      canvas_w: 1000,
      canvas_h: 625,
      seat_tile_w: 60,
      seat_tile_h: 46,
      grid_size: 10,
      capacity: 16,
      rules_json: defaultRules,
      elements_json: [
        { id: 'w1', type: 'wall', points: [[20, 20], [980, 20], [980, 605], [20, 605], [20, 20]] },
        { id: 'd1', type: 'door', x: 20, y: 100, w: 10, h: 60, label: '大門' },
        { id: 'c1', type: 'counter', x: 80, y: 50, w: 120, h: 50, rotation: 0, label: '服務櫃檯' }
      ]
    }
  });

  // Zones
  const zoneA = await prisma.seatZone.create({
    data: {
      layout_id: layout.id,
      name: 'A 區',
      note: '靠長桌區',
      sort_order: 0,
      polygon: [[50, 100], [450, 100], [450, 580], [50, 580]]
    }
  });

  const zoneB = await prisma.seatZone.create({
    data: {
      layout_id: layout.id,
      name: 'B 區',
      note: '四人桌區',
      sort_order: 1,
      polygon: [[500, 100], [950, 100], [950, 580], [500, 580]]
    }
  });

  // Tables
  const tableA1 = await prisma.seatTable.create({
    data: {
      layout_id: layout.id,
      zone_id: zoneA.id,
      label: 'A1',
      shape: 'long',
      arrangement: 'one_side',
      cx: 250,
      cy: 220,
      w: 60,
      h: 260,
      rotation: 0,
      sort_order: 0
    }
  });

  const tableA2 = await prisma.seatTable.create({
    data: {
      layout_id: layout.id,
      zone_id: zoneA.id,
      label: 'A2',
      shape: 'long',
      arrangement: 'one_side',
      cx: 250,
      cy: 460,
      w: 60,
      h: 260,
      rotation: 0,
      sort_order: 1
    }
  });

  const tableB1 = await prisma.seatTable.create({
    data: {
      layout_id: layout.id,
      zone_id: zoneB.id,
      label: 'B1',
      shape: 'rect',
      arrangement: 'two_sides',
      cx: 720,
      cy: 220,
      w: 70,
      h: 140,
      rotation: 0,
      sort_order: 0
    }
  });

  const tableB2 = await prisma.seatTable.create({
    data: {
      layout_id: layout.id,
      zone_id: zoneB.id,
      label: 'B2',
      shape: 'rect',
      arrangement: 'two_sides',
      cx: 720,
      cy: 460,
      w: 70,
      h: 140,
      rotation: 0,
      sort_order: 1
    }
  });

  // Seats: A1-1 ~ A1-4
  const seatDefs = [
    // A1
    { table_id: tableA1.id, zone_id: zoneA.id, code: 'A1-1', lx: -40, ly: -90, sort_order: 0 },
    { table_id: tableA1.id, zone_id: zoneA.id, code: 'A1-2', lx: -40, ly: -30, sort_order: 1 },
    { table_id: tableA1.id, zone_id: zoneA.id, code: 'A1-3', lx: -40, ly: 30, sort_order: 2 },
    { table_id: tableA1.id, zone_id: zoneA.id, code: 'A1-4', lx: -40, ly: 90, sort_order: 3 },

    // A2
    { table_id: tableA2.id, zone_id: zoneA.id, code: 'A2-1', lx: -40, ly: -90, sort_order: 0 },
    { table_id: tableA2.id, zone_id: zoneA.id, code: 'A2-2', lx: -40, ly: -30, sort_order: 1 },
    { table_id: tableA2.id, zone_id: zoneA.id, code: 'A2-3', lx: -40, ly: 30, sort_order: 2 },
    { table_id: tableA2.id, zone_id: zoneA.id, code: 'A2-4', lx: -40, ly: 90, sort_order: 3 },

    // B1: 2x2
    { table_id: tableB1.id, zone_id: zoneB.id, code: 'B1-1', lx: -45, ly: -35, sort_order: 0 },
    { table_id: tableB1.id, zone_id: zoneB.id, code: 'B1-2', lx: -45, ly: 35, sort_order: 1 },
    { table_id: tableB1.id, zone_id: zoneB.id, code: 'B1-3', lx: 45, ly: -35, sort_order: 0 },
    { table_id: tableB1.id, zone_id: zoneB.id, code: 'B1-4', lx: 45, ly: 35, sort_order: 1 },

    // B2: 2x2
    { table_id: tableB2.id, zone_id: zoneB.id, code: 'B2-1', lx: -45, ly: -35, sort_order: 0 },
    { table_id: tableB2.id, zone_id: zoneB.id, code: 'B2-2', lx: -45, ly: 35, sort_order: 1 },
    { table_id: tableB2.id, zone_id: zoneB.id, code: 'B2-3', lx: 45, ly: -35, sort_order: 0 },
    { table_id: tableB2.id, zone_id: zoneB.id, code: 'B2-4', lx: 45, ly: 35, sort_order: 1 },
  ];

  for (const s of seatDefs) {
    await prisma.seat.create({
      data: {
        layout_id: layout.id,
        table_id: s.table_id,
        zone_id: s.zone_id,
        code: s.code,
        lx: s.lx,
        ly: s.ly,
        side_mode: 'auto',
        priority: 'normal',
        is_active: true,
        sort_order: s.sort_order
      }
    });
  }

  console.log('[Seed SeatLayout] Seed completed successfully with 16 seats.');
  return layout;
}

if (process.argv[1]?.endsWith('seedSeatLayout.js')) {
  seedSeatLayout()
    .then(() => process.exit(0))
    .catch(err => {
      console.error('[Seed SeatLayout] Error:', err);
      process.exit(1);
    });
}
