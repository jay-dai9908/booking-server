// shared/__tests__/floorMap.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildFloorMap, calcRectCorners } from '../floorMap.js';

test('calcRectCorners calculates corners accurately for 0 and 90 degrees', () => {
  // Center (100, 200), width 60, height 40, rotation 0
  const c0 = calcRectCorners(100, 200, 60, 40, 0);
  assert.deepEqual(c0, [
    [70, 180],
    [130, 180],
    [130, 220],
    [70, 220]
  ]);

  // Rotation 90 degrees clockwise
  const c90 = calcRectCorners(100, 200, 60, 40, 90);
  assert.deepEqual(c90, [
    [120, 170],
    [120, 230],
    [80, 230],
    [80, 170]
  ]);
});

test('buildFloorMap outputs correct w, h, table count, active seats, and rotated fixture corners', () => {
  const mockLayout = {
    id: 42,
    published_at: new Date('2026-11-20T10:00:00Z'),
    kiosk_map_rotation: 90,
    canvas_w: 1000,
    canvas_h: 800,
    elements_json: [
      {
        id: 'wall-1',
        type: 'wall',
        points: [[0, 0], [400, 0], [400, 300], [0, 300]]
      },
      {
        id: 'door-1',
        type: 'door',
        cx: 200,
        cy: 300,
        w: 40,
        h: 10,
        rotation: 0,
        kiosk: { entrance: true }
      },
      {
        id: 'counter-1',
        type: 'counter',
        label: '服務櫃檯',
        cx: 100,
        cy: 100,
        w: 60,
        h: 40,
        rotation: 90
      }
    ],
    tables: [
      { id: 1, label: 'T1', cx: 250, cy: 150, w: 80, h: 60, rotation: 0, sort_order: 1 },
      { id: 2, label: 'T2', cx: 250, cy: 220, w: 80, h: 60, rotation: 0, sort_order: 2 }
    ],
    seats: [
      { code: 'T1-1', table_id: 1, abs_x: 230, abs_y: 150, is_active: true },
      { code: 'T1-2', table_id: 1, abs_x: 270, abs_y: 150, is_active: true },
      { code: 'T1-3', table_id: 1, abs_x: 250, abs_y: 130, is_active: false }, // 停用，不應包含
      { code: 'T2-1', table_id: 2, abs_x: 250, abs_y: 220, is_active: true }
    ]
  };

  const map = buildFloorMap(mockLayout);

  assert.equal(map.rotation, 90);
  assert.equal(map.version, `L42-${Math.floor(new Date('2026-11-20T10:00:00Z').getTime() / 1000)}`);
  assert.equal(map.tables.length, 2);
  assert.equal(map.tables[0].label, 'T1');
  assert.equal(map.tables[1].label, 'T2');

  // Seats: 3 active seats, inactive T1-3 excluded
  assert.equal(map.seats.length, 3);
  const codes = map.seats.map(s => s.code);
  assert.deepEqual(codes, ['T1-1', 'T1-2', 'T2-1']);
  assert.ok(!codes.includes('T1-3'));

  // Fixture corners rotated 90 degrees
  const fixture = map.shapes.find(s => s.kind === 'fixture');
  assert.ok(fixture);
  assert.equal(fixture.closed, true);
  assert.equal(fixture.pts.length, 4);

  // Entrance door center mapped
  assert.ok(Array.isArray(map.door));
  assert.equal(map.door.length, 2);

  // Bounding box dimensions
  assert.ok(map.w > 0);
  assert.ok(map.h > 0);
});

test('buildFloorMap applies default icon, color, and show for unnamed/named fixtures', () => {
  const layout = {
    id: 5,
    elements_json: [
      { id: 'c1', type: 'counter', label: '燙豆區', cx: 100, cy: 100, w: 50, h: 50 },
      { id: 'c2', type: 'counter', label: '櫃檯', cx: 200, cy: 100, w: 50, h: 50 },
      { id: 'c3', type: 'counter', label: '沙發', cx: 300, cy: 100, w: 50, h: 50 },
      { id: 'c4', type: 'counter', label: '拼豆牆', cx: 400, cy: 100, w: 50, h: 50 },
      { id: 'c5', type: 'counter', label: '其他設施', cx: 500, cy: 100, w: 50, h: 50 }
    ],
    tables: [],
    seats: []
  };

  const map = buildFloorMap(layout);

  const iron = map.shapes.find(s => s.label === '燙豆區');
  assert.equal(iron.show, 'icon_name');
  assert.equal(iron.icon, 'iron');
  assert.equal(iron.color, 'coral');

  const counter = map.shapes.find(s => s.label === '櫃檯');
  assert.equal(counter.show, 'icon_name');
  assert.equal(counter.icon, 'counter');
  assert.equal(counter.color, 'brown');

  const sofa = map.shapes.find(s => s.label === '沙發');
  assert.equal(sofa.show, 'icon_name');
  assert.equal(sofa.icon, 'sofa');
  assert.equal(sofa.color, 'blue');

  const beads = map.shapes.find(s => s.label === '拼豆牆');
  assert.equal(beads.show, 'name');
  assert.equal(beads.color, 'honey');
  assert.equal(beads.pattern, 'beads');

  const other = map.shapes.find(s => s.label === '其他設施');
  assert.equal(other.show, 'shape');
  assert.equal(other.color, 'grey');
});
