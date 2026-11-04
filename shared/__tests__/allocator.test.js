// shared/__tests__/allocator.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { allocate } from '../allocator/score.js';

test('Section 4.7.6 allocator verification: 9 groups sequentially', () => {
  // Construct the exact layout from spec:
  // Zone 1: Front zone (sort_order: 0)
  // Table 1, 2, 3: 4-person face-to-face tables
  // Table 1: 1-1, 1-2 on L; 1-3, 1-4 on R. (1-1 opp 1-3, 1-2 opp 1-4)
  // Table 2: 2-1, 2-2 on L; 2-3, 2-4 on R.
  // Table 3: 3-1, 3-2 on L; 3-3, 3-4 on R. 3-4 is vent (last)
  // Zone 2: Back zone (sort_order: 1)
  // Table Long: single side L-1, L-2, L-3, L-4. L-3, L-4 are vent (last).

  const zones = [
    { id: 1, name: '前區', sort_order: 0 },
    { id: 2, name: '後區', sort_order: 1 },
  ];

  const tables = [
    { id: 101, zone_id: 1, label: '桌 1', shape: 'rect', arrangement: 'two_sides', w: 60, h: 150, cx: 100, cy: 100, rotation: 0, sort_order: 0 },
    { id: 102, zone_id: 1, label: '桌 2', shape: 'rect', arrangement: 'two_sides', w: 60, h: 150, cx: 200, cy: 100, rotation: 0, sort_order: 1 },
    { id: 103, zone_id: 1, label: '桌 3', shape: 'rect', arrangement: 'two_sides', w: 60, h: 150, cx: 300, cy: 100, rotation: 0, sort_order: 2 },
    { id: 201, zone_id: 2, label: '長桌', shape: 'long', arrangement: 'one_side', w: 60, h: 300, cx: 100, cy: 300, rotation: 0, sort_order: 0 },
  ];

  const seats = [
    // Table 1 (two_sides: h >= w, so longAxis is y, lx < 0 is L, lx > 0 is R)
    { id: 1, layout_id: 1, zone_id: 1, table_id: 101, code: '1-1', lx: -40, ly: -30, side_mode: 'auto', priority: 'normal', is_active: true, sort_order: 0 },
    { id: 2, layout_id: 1, zone_id: 1, table_id: 101, code: '1-2', lx: -40, ly: 30, side_mode: 'auto', priority: 'normal', is_active: true, sort_order: 1 },
    { id: 3, layout_id: 1, zone_id: 1, table_id: 101, code: '1-3', lx: 40, ly: -30, side_mode: 'auto', priority: 'normal', is_active: true, sort_order: 0 },
    { id: 4, layout_id: 1, zone_id: 1, table_id: 101, code: '1-4', lx: 40, ly: 30, side_mode: 'auto', priority: 'normal', is_active: true, sort_order: 1 },

    // Table 2
    { id: 5, layout_id: 1, zone_id: 1, table_id: 102, code: '2-1', lx: -40, ly: -30, side_mode: 'auto', priority: 'normal', is_active: true, sort_order: 0 },
    { id: 6, layout_id: 1, zone_id: 1, table_id: 102, code: '2-2', lx: -40, ly: 30, side_mode: 'auto', priority: 'normal', is_active: true, sort_order: 1 },
    { id: 7, layout_id: 1, zone_id: 1, table_id: 102, code: '2-3', lx: 40, ly: -30, side_mode: 'auto', priority: 'normal', is_active: true, sort_order: 0 },
    { id: 8, layout_id: 1, zone_id: 1, table_id: 102, code: '2-4', lx: 40, ly: 30, side_mode: 'auto', priority: 'normal', is_active: true, sort_order: 1 },

    // Table 3 (3-4 is vent / last)
    { id: 9, layout_id: 1, zone_id: 1, table_id: 103, code: '3-1', lx: -40, ly: -30, side_mode: 'auto', priority: 'normal', is_active: true, sort_order: 0 },
    { id: 10, layout_id: 1, zone_id: 1, table_id: 103, code: '3-2', lx: -40, ly: 30, side_mode: 'auto', priority: 'normal', is_active: true, sort_order: 1 },
    { id: 11, layout_id: 1, zone_id: 1, table_id: 103, code: '3-3', lx: 40, ly: -30, side_mode: 'auto', priority: 'normal', is_active: true, sort_order: 0 },
    { id: 12, layout_id: 1, zone_id: 1, table_id: 103, code: '3-4', lx: 40, ly: 30, side_mode: 'auto', priority: 'last', tags: ['vent'], is_active: true, sort_order: 1 },

    // Long table (L-1 to L-4 on left side; L-3, L-4 are vent / last)
    { id: 13, layout_id: 1, zone_id: 2, table_id: 201, code: 'L-1', lx: -40, ly: -90, side_mode: 'auto', priority: 'normal', is_active: true, sort_order: 0 },
    { id: 14, layout_id: 1, zone_id: 2, table_id: 201, code: 'L-2', lx: -40, ly: -30, side_mode: 'auto', priority: 'normal', is_active: true, sort_order: 1 },
    { id: 15, layout_id: 1, zone_id: 2, table_id: 201, code: 'L-3', lx: -40, ly: 30, side_mode: 'auto', priority: 'last', tags: ['vent'], is_active: true, sort_order: 2 },
    { id: 16, layout_id: 1, zone_id: 2, table_id: 201, code: 'L-4', lx: -40, ly: 90, side_mode: 'auto', priority: 'last', tags: ['vent'], is_active: true, sort_order: 3 },
  ];

  const layout = { id: 1, zones, tables, seats };
  const rules = {
    spread_tables: true,
    avoid_opposite: true,
    avoid_beside: true,
    zone_mode: 'empty_tables_first',
    weights: { zone: 1, zone_fill_first: 50, opposite: 3, beside: 6, second: 20, last: 100, split: 4 }
  };

  const sessionId = 1;
  const occupancy = { [sessionId]: {} };

  // Expected 9 groups from Section 4.7.6:
  const expectedGroups = [
    { group: 1, pax: 2, expected: ['1-1', '1-2'] },
    { group: 2, pax: 1, expected: ['2-3'] },
    { group: 3, pax: 2, expected: ['3-1', '3-2'] },
    { group: 4, pax: 2, expected: ['L-1', 'L-2'] },
    { group: 5, pax: 2, expected: ['1-3', '1-4'] },
    { group: 6, pax: 1, expected: ['2-1'] },
    { group: 7, pax: 1, expected: ['3-3'] },
    { group: 8, pax: 2, expected: ['2-2', '2-4'] },
    { group: 9, pax: 1, expected: ['L-4'] },
  ];

  for (const item of expectedGroups) {
    const res = allocate({
      layout,
      rules,
      pax: item.pax,
      sessionIds: [sessionId],
      occupancy,
      allowSplit: false
    });

    assert.ok(!res.error, `Group ${item.group} failed with error: ${res.error}`);
    assert.deepEqual(res.seats.sort(), item.expected.sort(), `Group ${item.group} (pax ${item.pax}) expected ${item.expected}, got ${res.seats} (reason: ${res.reason})`);

    // Occupy the seats
    for (const seatCode of res.seats) {
      occupancy[sessionId][seatCode] = `BK-G${item.group}`;
    }
  }
});

test('Section 12: Change zone_mode to fill_zone_first alters Group 4 to front zone opposite', () => {
  const zones = [
    { id: 1, name: '前區', sort_order: 0 },
    { id: 2, name: '後區', sort_order: 1 },
  ];
  const tables = [
    { id: 101, zone_id: 1, label: '桌 1', shape: 'rect', arrangement: 'two_sides', w: 60, h: 150, cx: 100, cy: 100, rotation: 0, sort_order: 0 },
    { id: 102, zone_id: 1, label: '桌 2', shape: 'rect', arrangement: 'two_sides', w: 60, h: 150, cx: 200, cy: 100, rotation: 0, sort_order: 1 },
    { id: 103, zone_id: 1, label: '桌 3', shape: 'rect', arrangement: 'two_sides', w: 60, h: 150, cx: 300, cy: 100, rotation: 0, sort_order: 2 },
    { id: 201, zone_id: 2, label: '長桌', shape: 'long', arrangement: 'one_side', w: 60, h: 300, cx: 100, cy: 300, rotation: 0, sort_order: 0 },
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
    { id: 16, layout_id: 1, zone_id: 2, table_id: 201, code: 'L-4', lx: -40, ly: 90, side_mode: 'auto', priority: 'last', tags: ['vent'], is_active: true, sort_order: 3 },
  ];
  const layout = { id: 1, zones, tables, seats };
  const rules = {
    spread_tables: true,
    avoid_opposite: true,
    avoid_beside: true,
    zone_mode: 'fill_zone_first',
    weights: { zone: 1, zone_fill_first: 50, opposite: 3, beside: 6, second: 20, last: 100, split: 4 }
  };
  const occupancy = { 1: { '1-1': 'g1', '1-2': 'g1', '2-3': 'g2', '3-1': 'g3', '3-2': 'g3' } };
  const res = allocate({
    layout,
    rules,
    pax: 2,
    sessionIds: [1],
    occupancy,
    allowSplit: false
  });
  assert.deepEqual(res.seats.sort(), ['1-3', '1-4'].sort());
});

test('Section 12: Change vent seat 3-4 to normal alters Group 9 to 3-4', () => {
  const zones = [
    { id: 1, name: '前區', sort_order: 0 },
    { id: 2, name: '後區', sort_order: 1 },
  ];
  const tables = [
    { id: 101, zone_id: 1, label: '桌 1', shape: 'rect', arrangement: 'two_sides', w: 60, h: 150, cx: 100, cy: 100, rotation: 0, sort_order: 0 },
    { id: 102, zone_id: 1, label: '桌 2', shape: 'rect', arrangement: 'two_sides', w: 60, h: 150, cx: 200, cy: 100, rotation: 0, sort_order: 1 },
    { id: 103, zone_id: 1, label: '桌 3', shape: 'rect', arrangement: 'two_sides', w: 60, h: 150, cx: 300, cy: 100, rotation: 0, sort_order: 2 },
    { id: 201, zone_id: 2, label: '長桌', shape: 'long', arrangement: 'one_side', w: 60, h: 300, cx: 100, cy: 300, rotation: 0, sort_order: 0 },
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
    { id: 12, layout_id: 1, zone_id: 1, table_id: 103, code: '3-4', lx: 40, ly: 30, side_mode: 'auto', priority: 'normal', tags: [], is_active: true, sort_order: 1 },
    { id: 13, layout_id: 1, zone_id: 2, table_id: 201, code: 'L-1', lx: -40, ly: -90, side_mode: 'auto', priority: 'normal', is_active: true, sort_order: 0 },
    { id: 14, layout_id: 1, zone_id: 2, table_id: 201, code: 'L-2', lx: -40, ly: -30, side_mode: 'auto', priority: 'normal', is_active: true, sort_order: 1 },
    { id: 15, layout_id: 1, zone_id: 2, table_id: 201, code: 'L-3', lx: -40, ly: 30, side_mode: 'auto', priority: 'last', tags: ['vent'], is_active: true, sort_order: 2 },
    { id: 16, layout_id: 1, zone_id: 2, table_id: 201, code: 'L-4', lx: -40, ly: 90, side_mode: 'auto', priority: 'last', tags: ['vent'], is_active: true, sort_order: 3 },
  ];
  const layout = { id: 1, zones, tables, seats };
  const rules = {
    spread_tables: true,
    avoid_opposite: true,
    avoid_beside: true,
    zone_mode: 'empty_tables_first',
    weights: { zone: 1, zone_fill_first: 50, opposite: 3, beside: 6, second: 20, last: 100, split: 4 }
  };
  const occupancy = { 1: { '1-1': 'g1', '1-2': 'g1', '2-3': 'g2', '3-1': 'g3', '3-2': 'g3', 'L-1': 'g4', 'L-2': 'g4', '1-3': 'g5', '1-4': 'g5', '2-1': 'g6', '3-3': 'g7', '2-2': 'g8', '2-4': 'g8' } };
  const res = allocate({
    layout,
    rules,
    pax: 1,
    sessionIds: [1],
    occupancy,
    allowSplit: false
  });
  assert.deepEqual(res.seats, ['3-4']);
});

