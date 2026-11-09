import { createRequire } from 'node:module';
import { toTaipeiDateString, dateOnly } from '../../../shared/time.js';

const require = createRequire(import.meta.url);
let PrismaClient;
try {
  ({ PrismaClient } = require('@prisma/client'));
} catch (e) {
  ({ PrismaClient } = require('../../../backend/node_modules/@prisma/client/index.js'));
}

export async function cleanOperationalData(customPrisma) {
  const testDbUrl = process.env.TEST_DATABASE_URL;
  if (!testDbUrl || !testDbUrl.trim()) return;
  const cleanDbUrl = testDbUrl.split('?')[0];
  const dbName = cleanDbUrl.split('/').pop();
  if (!dbName || !dbName.endsWith('_test')) return;

  const prisma = customPrisma || new PrismaClient({ datasources: { db: { url: testDbUrl.trim() } } });
  await prisma.timerPause.deleteMany({}).catch(() => {});
  await prisma.payment.deleteMany({}).catch(() => {});
  await prisma.bookingEquipment.deleteMany({}).catch(() => {});
  await prisma.bookingPerson.deleteMany({}).catch(() => {});
  await prisma.reservation.deleteMany({}).catch(() => {});
  await prisma.printJob.deleteMany({}).catch(() => {});
  await prisma.cashClosing.deleteMany({}).catch(() => {});
  await prisma.userLoginLog.deleteMany({}).catch(() => {});
  if (!customPrisma) {
    await prisma.$disconnect().catch(() => {});
  }
}

export async function ensureFreshDbSeeded(customPrisma) {
  const testDbUrl = process.env.TEST_DATABASE_URL;
  if (!testDbUrl || !testDbUrl.trim()) {
    console.error('TEST_DATABASE_URL is not set. Refusing to run tests on production/dev database.');
    process.exit(1);
  }
  const cleanDbUrl = testDbUrl.split('?')[0];
  const dbName = cleanDbUrl.split('/').pop();
  if (!dbName || !dbName.endsWith('_test')) {
    console.error(`TEST_DATABASE_URL database name "${dbName}" must end with "_test"! Refusing to run tests.`);
    process.exit(1);
  }

  const prisma = customPrisma || new PrismaClient({ datasources: { db: { url: testDbUrl.trim() } } });

  // 0. Clean operational tables for fresh DB state
  await cleanOperationalData(prisma);

  // 1. Seed GlobalSetting
  await prisma.globalSetting.upsert({
    where: { id: 1 },
    update: {
      weekday_hourly_price: 150,
      weekday_unlimited_price: 750,
      weekend_hourly_price: 180,
      weekend_unlimited_price: 900,
      equipment_discount_enabled: true,
      equipment_discount_buy_hours: 3,
      equipment_discount_free_hours: 1,
      equipment_discount_stackable: true,
      business_hours_json: {
        weekday: { open: '10:00', close: '21:00' },
        saturday: { open: '09:00', close: '21:00' },
        sunday: { open: '09:00', close: '21:00' }
      }
    },
    create: {
      id: 1,
      weekday_hourly_price: 150,
      weekday_unlimited_price: 750,
      weekend_hourly_price: 180,
      weekend_unlimited_price: 900,
      equipment_discount_enabled: true,
      equipment_discount_buy_hours: 3,
      equipment_discount_free_hours: 1,
      equipment_discount_stackable: true,
      business_hours_json: {
        weekday: { open: '10:00', close: '21:00' },
        saturday: { open: '09:00', close: '21:00' },
        sunday: { open: '09:00', close: '21:00' }
      }
    }
  });

  // 2. Seed EquipmentConfig
  const equipmentConfigs = [
    { id: 'pegboard_s', name: '小板 (52×52)', hourly_rate: 100, daily_cap: 500, min_contiguous_hours: 2, total_stock: 5, visibility_status: 'ACTIVE', sort_order: 1 },
    { id: 'pegboard_m', name: '中板 (78×78)', hourly_rate: 120, daily_cap: 600, min_contiguous_hours: 2, total_stock: 2, visibility_status: 'ACTIVE', sort_order: 2 },
    { id: 'pegboard_l', name: '大板 (104×104)', hourly_rate: 140, daily_cap: 700, min_contiguous_hours: 2, total_stock: 3, visibility_status: 'ACTIVE', sort_order: 3 },
    { id: 'bring_own', name: '自帶智能拼豆板', hourly_rate: 50, daily_cap: 400, min_contiguous_hours: 1, total_stock: null, visibility_status: 'ACTIVE', sort_order: 4 }
  ];
  for (const eq of equipmentConfigs) {
    await prisma.equipmentConfig.upsert({
      where: { id: eq.id },
      update: {
        name: eq.name,
        hourly_rate: eq.hourly_rate,
        daily_cap: eq.daily_cap,
        min_contiguous_hours: eq.min_contiguous_hours,
        total_stock: eq.total_stock,
        visibility_status: eq.visibility_status
      },
      create: eq
    });
  }

  // 3. Seed SeatLayout (Always re-seed fresh layout and clean up stale drafts)
  await prisma.seatLayout.deleteMany({});
  console.log('[Seed] Seeding fresh published seat layout...');
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

    const tableA1 = await prisma.seatTable.create({
      data: { layout_id: layout.id, zone_id: zoneA.id, label: 'A1', shape: 'long', arrangement: 'one_side', cx: 250, cy: 220, w: 60, h: 260, rotation: 0, sort_order: 0 }
    });
    const tableA2 = await prisma.seatTable.create({
      data: { layout_id: layout.id, zone_id: zoneA.id, label: 'A2', shape: 'long', arrangement: 'one_side', cx: 250, cy: 460, w: 60, h: 260, rotation: 0, sort_order: 1 }
    });
    const tableB1 = await prisma.seatTable.create({
      data: { layout_id: layout.id, zone_id: zoneB.id, label: 'B1', shape: 'rect', arrangement: 'two_sides', cx: 720, cy: 220, w: 70, h: 140, rotation: 0, sort_order: 0 }
    });
    const tableB2 = await prisma.seatTable.create({
      data: { layout_id: layout.id, zone_id: zoneB.id, label: 'B2', shape: 'rect', arrangement: 'two_sides', cx: 720, cy: 460, w: 70, h: 140, rotation: 0, sort_order: 1 }
    });

    const seatDefs = [
      { table_id: tableA1.id, zone_id: zoneA.id, code: 'A1-1', lx: -40, ly: -90, sort_order: 0 },
      { table_id: tableA1.id, zone_id: zoneA.id, code: 'A1-2', lx: -40, ly: -30, sort_order: 1 },
      { table_id: tableA1.id, zone_id: zoneA.id, code: 'A1-3', lx: -40, ly: 30, sort_order: 2 },
      { table_id: tableA1.id, zone_id: zoneA.id, code: 'A1-4', lx: -40, ly: 90, sort_order: 3 },
      { table_id: tableA2.id, zone_id: zoneA.id, code: 'A2-1', lx: -40, ly: -90, sort_order: 0 },
      { table_id: tableA2.id, zone_id: zoneA.id, code: 'A2-2', lx: -40, ly: -30, sort_order: 1 },
      { table_id: tableA2.id, zone_id: zoneA.id, code: 'A2-3', lx: -40, ly: 30, sort_order: 2 },
      { table_id: tableA2.id, zone_id: zoneA.id, code: 'A2-4', lx: -40, ly: 90, sort_order: 3 },
      { table_id: tableB1.id, zone_id: zoneB.id, code: 'B1-1', lx: -45, ly: -35, sort_order: 0 },
      { table_id: tableB1.id, zone_id: zoneB.id, code: 'B1-2', lx: -45, ly: 35, sort_order: 1 },
      { table_id: tableB1.id, zone_id: zoneB.id, code: 'B1-3', lx: 45, ly: -35, sort_order: 0 },
      { table_id: tableB1.id, zone_id: zoneB.id, code: 'B1-4', lx: 45, ly: 35, sort_order: 1 },
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

  // 4. Seed User (Customer id: 1)
  const existingUser = await prisma.user.findFirst({ where: { id: 1 } });
  if (!existingUser) {
    await prisma.user.create({
      data: {
        id: 1,
        line_user_id: 'test_user_line_1',
        name: '測試顧客',
        phone: '0912345678'
      }
    });
  }

  // 5. Seed Sessions for today and next 7 days (10:00 to 21:00)
  const now = new Date();
  for (let dayOffset = 0; dayOffset <= 7; dayOffset++) {
    const targetDate = new Date(now.getTime() + dayOffset * 24 * 60 * 60 * 1000);
    const dateStr = toTaipeiDateString(targetDate);
    const dbDate = dateOnly(dateStr);

    for (let h = 10; h < 21; h++) {
      const startTime = `${h.toString().padStart(2, '0')}:00`;
      const endTime = `${(h + 1).toString().padStart(2, '0')}:00`;

      await prisma.session.upsert({
        where: {
          session_date_start_time: {
            session_date: dbDate,
            start_time: startTime
          }
        },
        update: {
          end_time: endTime,
          max_capacity: 16
        },
        create: {
          session_date: dbDate,
          start_time: startTime,
          end_time: endTime,
          max_capacity: 16
        }
      });
    }
  }

  // 6. Ensure default products, payment methods, checkout config
  try {
    if (prisma.product) {
      const pCount = await prisma.product.count();
      if (pCount === 0) {
        await prisma.product.create({
          data: {
            code: 'bead_kit_basic',
            name: '基礎拼豆材料包',
            price: 250,
            category: 'bundle',
            is_preorder: false,
            deposit_amount: 0,
            visibility_status: 'ACTIVE',
            sort_order: 1
          }
        });
      }
    }
  } catch (e) {}

  console.log('[Seed] Fresh DB seed complete.');
  if (!customPrisma) {
    await prisma.$disconnect();
  }
}

if (process.argv[1]?.includes('seedFreshDb.js')) {
  ensureFreshDbSeeded()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('[Seed] Error:', err);
      process.exit(1);
    });
}
