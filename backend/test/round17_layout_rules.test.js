import test from 'node:test';
import assert from 'node:assert/strict';
import prisma from '../src/prismaClient.js';
import { updateLayoutRules, allocatePreview } from '../src/controllers/seatLayoutController.js';

function createMockReqRes({ params = {}, body = {}, user = { name: '店長測試員', id: 1 } } = {}) {
  const req = {
    params,
    body,
    user,
    headers: { 'user-agent': 'NodeTestAgent' },
    ip: '127.0.0.1'
  };
  let statusCode = 200;
  let responseData = null;

  const res = {
    status(code) {
      statusCode = code;
      return res;
    },
    json(data) {
      responseData = data;
      return res;
    },
    getStatusCode() {
      return statusCode;
    },
    getResponseData() {
      return responseData;
    }
  };

  return { req, res };
}

test('Round 17 Item 1: Layout rules zone_mode fill_zone_first vs spread_across_zones (Section 12 spec)', async (t) => {
  const zones = [
    { id: 1, name: '前區', sort_order: 0 },
    { id: 2, name: '後區', sort_order: 1 }
  ];
  const tables = [
    { id: 101, zone_id: 1, label: '桌 1', shape: 'rect', arrangement: 'two_sides', w: 60, h: 150, cx: 100, cy: 100, rotation: 0, sort_order: 0 },
    { id: 102, zone_id: 1, label: '桌 2', shape: 'rect', arrangement: 'two_sides', w: 60, h: 150, cx: 200, cy: 100, rotation: 0, sort_order: 1 },
    { id: 103, zone_id: 1, label: '桌 3', shape: 'rect', arrangement: 'two_sides', w: 60, h: 150, cx: 300, cy: 100, rotation: 0, sort_order: 2 },
    { id: 201, zone_id: 2, label: '長桌', shape: 'long', arrangement: 'one_side', w: 60, h: 300, cx: 100, cy: 300, rotation: 0, sort_order: 0 }
  ];
  const seats = [
    { id: 1, layout_id: 1, zone_id: 1, table_id: 101, code: '1-1', lx: -40, ly: -30, side_mode: 'auto', priority: 'normal', is_active: true, sort_order: 0 },
    { id: 2, layout_id: 1, zone_id: 1, table_id: 101, code: '1-2', lx: -40, ly: 30, side_mode: 'auto', priority: 'normal', is_active: true, sort_order: 1 },
    { id: 3, layout_id: 1, zone_id: 1, table_id: 101, code: '1-3', lx: 40, ly: -30, side_mode: 'auto', priority: 'normal', is_active: true, sort_order: 0 },
    { id: 4, layout_id: 1, zone_id: 1, table_id: 101, code: '1-4', lx: 40, ly: 30, side_mode: 'auto', priority: 'normal', is_active: true, sort_order: 1 },
    { id: 5, layout_id: 1, zone_id: 1, table_id: 102, code: '2-1', lx: -40, ly: -30, side_mode: 'auto', priority: 'normal', is_active: true, sort_order: 0 },
    { id: 6, layout_id: 1, zone_id: 1, table_id: 102, code: '2-2', lx: -40, ly: 30, side_mode: 'auto', priority: 'normal', is_active: true, sort_order: 1 },
    { id: 7, layout_id: 1, zone_id: 1, table_id: 102, code: '2-3', lx: 40, ly: -30, side_mode: 'auto', priority: 'normal', is_active: true, sort_order: 0 },
    { id: 8, layout_id: 1, zone_id: 1, table_id: 102, code: '2-4', lx: 40, ly: 30, side_mode: 'auto', priority: 'normal', is_active: true, sort_order: 1 },
    { id: 9, layout_id: 1, zone_id: 1, table_id: 103, code: '3-1', lx: -40, ly: -30, side_mode: 'auto', priority: 'normal', is_active: true, sort_order: 0 },
    { id: 10, layout_id: 1, zone_id: 1, table_id: 103, code: '3-2', lx: -40, ly: 30, side_mode: 'auto', priority: 'normal', is_active: true, sort_order: 1 },
    { id: 11, layout_id: 1, zone_id: 1, table_id: 103, code: '3-3', lx: 40, ly: -30, side_mode: 'auto', priority: 'normal', is_active: true, sort_order: 0 },
    { id: 12, layout_id: 1, zone_id: 1, table_id: 103, code: '3-4', lx: 40, ly: 30, side_mode: 'auto', priority: 'last', tags: ['vent'], is_active: true, sort_order: 1 },
    { id: 13, layout_id: 1, zone_id: 2, table_id: 201, code: 'L-1', lx: -40, ly: -90, side_mode: 'auto', priority: 'normal', is_active: true, sort_order: 0 },
    { id: 14, layout_id: 1, zone_id: 2, table_id: 201, code: 'L-2', lx: -40, ly: -30, side_mode: 'auto', priority: 'normal', is_active: true, sort_order: 1 },
    { id: 15, layout_id: 1, zone_id: 2, table_id: 201, code: 'L-3', lx: -40, ly: 30, side_mode: 'auto', priority: 'last', tags: ['vent'], is_active: true, sort_order: 2 },
    { id: 16, layout_id: 1, zone_id: 2, table_id: 201, code: 'L-4', lx: -40, ly: 90, side_mode: 'auto', priority: 'last', tags: ['vent'], is_active: true, sort_order: 3 }
  ];
  const draftLayout = { id: 1, zones, tables, seats };
  const mockOccupancy = { '1-1': 'g1', '1-2': 'g1', '2-3': 'g2', '3-1': 'g3', '3-2': 'g3' };

  // Case A: zone_mode = 'fill_zone_first' -> Group 4 stays in Zone 1 (seats 1-3, 1-4)
  const { req: reqA, res: resA } = createMockReqRes({
    body: {
      draft: draftLayout,
      pax: 2,
      occupancy: mockOccupancy,
      rules: {
        spread_tables: true,
        avoid_opposite: true,
        avoid_beside: true,
        zone_mode: 'fill_zone_first'
      }
    }
  });
  await allocatePreview(reqA, resA);
  assert.equal(resA.getStatusCode(), 200);
  const dataA = resA.getResponseData();
  assert.deepEqual((dataA.seats || []).sort(), ['1-3', '1-4'], 'fill_zone_first should allocate to front zone 1-3, 1-4');

  // Case B: zone_mode = 'spread_across_zones' -> Group 4 goes to Zone 2 (seats L-1, L-2)
  const { req: reqB, res: resB } = createMockReqRes({
    body: {
      draft: draftLayout,
      pax: 2,
      occupancy: mockOccupancy,
      rules: {
        spread_tables: true,
        avoid_opposite: true,
        avoid_beside: true,
        zone_mode: 'spread_across_zones'
      }
    }
  });
  await allocatePreview(reqB, resB);
  assert.equal(resB.getStatusCode(), 200);
  const dataB = resB.getResponseData();
  assert.deepEqual((dataB.seats || []).sort(), ['L-1', 'L-2'], 'spread_across_zones should allocate to zone 2 L-1, L-2');
});

test('Round 17 Item 1: updateLayoutRules updates zone_order and alters allocation preference', async (t) => {
  const runId = Math.random().toString(36).slice(2, 8);
  // Create a dedicated layout in DB
  const layout = await prisma.seatLayout.create({
    data: {
      name: `排位測試版面_${runId}`,
      status: 'published',
      published_at: new Date(),
      effective_from: new Date(),
      created_by_name: 'test',
      canvas_w: 1000,
      canvas_h: 625,
      grid_size: 10,
      rules_json: { spread_tables: true, zone_mode: 'spread_across_zones' }
    }
  });

  const zoneA = await prisma.seatZone.create({
    data: { layout_id: layout.id, name: '區域A', sort_order: 0 }
  });
  const zoneB = await prisma.seatZone.create({
    data: { layout_id: layout.id, name: '區域B', sort_order: 1 }
  });

  const tableA = await prisma.seatTable.create({
    data: { layout_id: layout.id, zone_id: zoneA.id, label: '桌A', shape: 'rect', arrangement: 'two_sides', cx: 100, cy: 100, w: 60, h: 100, rotation: 0, sort_order: 0 }
  });
  const tableB = await prisma.seatTable.create({
    data: { layout_id: layout.id, zone_id: zoneB.id, label: '桌B', shape: 'rect', arrangement: 'two_sides', cx: 300, cy: 100, w: 60, h: 100, rotation: 0, sort_order: 0 }
  });

  await prisma.seat.createMany({
    data: [
      { layout_id: layout.id, zone_id: zoneA.id, table_id: tableA.id, code: `A-1`, origin_code: `A-1`, lx: -30, ly: 0, side_mode: 'auto', priority: 'normal', is_active: true, sort_order: 0 },
      { layout_id: layout.id, zone_id: zoneA.id, table_id: tableA.id, code: `A-2`, origin_code: `A-2`, lx: 30, ly: 0, side_mode: 'auto', priority: 'normal', is_active: true, sort_order: 1 },
      { layout_id: layout.id, zone_id: zoneB.id, table_id: tableB.id, code: `B-1`, origin_code: `B-1`, lx: -30, ly: 0, side_mode: 'auto', priority: 'normal', is_active: true, sort_order: 0 },
      { layout_id: layout.id, zone_id: zoneB.id, table_id: tableB.id, code: `B-2`, origin_code: `B-2`, lx: 30, ly: 0, side_mode: 'auto', priority: 'normal', is_active: true, sort_order: 1 }
    ]
  });

  try {
    // 1. Initial state: Zone A has sort_order 0, Zone B has sort_order 1
    // Allocating 2 pax when both are empty should choose Zone A
    const { req: req1, res: res1 } = createMockReqRes({
      body: {
        layout_id: layout.id,
        pax: 2
      }
    });
    await allocatePreview(req1, res1);
    assert.equal(res1.getStatusCode(), 200);
    assert.deepEqual(res1.getResponseData().seats.sort(), ['A-1', 'A-2'], 'Initially Zone A is preferred');

    // 2. Call updateLayoutRules to swap zone order: [zoneB.id, zoneA.id]
    const { req: reqUpdate, res: resUpdate } = createMockReqRes({
      params: { id: String(layout.id) },
      body: {
        zone_order: [zoneB.id, zoneA.id],
        rules_json: {
          spread_tables: true,
          avoid_opposite: true,
          avoid_beside: true,
          zone_mode: 'fill_zone_first'
        }
      }
    });
    await updateLayoutRules(reqUpdate, resUpdate);
    assert.equal(resUpdate.getStatusCode(), 200);

    // Verify sort_order in DB
    const updatedZoneA = await prisma.seatZone.findUnique({ where: { id: zoneA.id } });
    const updatedZoneB = await prisma.seatZone.findUnique({ where: { id: zoneB.id } });
    assert.equal(updatedZoneB.sort_order, 0, 'Zone B should now be sort_order 0');
    assert.equal(updatedZoneA.sort_order, 1, 'Zone A should now be sort_order 1');

    // 3. Allocating 2 pax again should now prefer Zone B (B-1, B-2)
    const { req: req2, res: res2 } = createMockReqRes({
      body: {
        layout_id: layout.id,
        pax: 2
      }
    });
    await allocatePreview(req2, res2);
    assert.equal(res2.getStatusCode(), 200);
    assert.deepEqual(res2.getResponseData().seats.sort(), ['B-1', 'B-2'], 'After zone_order swap, Zone B is preferred');

  } finally {
    // Cleanup
    await prisma.seat.deleteMany({ where: { layout_id: layout.id } });
    await prisma.seatTable.deleteMany({ where: { layout_id: layout.id } });
    await prisma.seatZone.deleteMany({ where: { layout_id: layout.id } });
    await prisma.seatLayout.deleteMany({ where: { id: layout.id } });
  }
});
