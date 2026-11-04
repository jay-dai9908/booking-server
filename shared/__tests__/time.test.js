// shared/__tests__/time.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { blocksBy1030, swapBoundaryOptions } from '../time.js';

test('10/30 rule verification table (Section 4.2.1)', () => {
  const table = [
    { minutes: 8, blocks: 0, hours: 0 },
    { minutes: 10, blocks: 0, hours: 0 },
    { minutes: 11, blocks: 1, hours: 0.5 },
    { minutes: 31, blocks: 1, hours: 0.5 },
    { minutes: 40, blocks: 1, hours: 0.5 },
    { minutes: 41, blocks: 2, hours: 1 },
    { minutes: 100, blocks: 3, hours: 1.5 },
    { minutes: 105, blocks: 4, hours: 2 },
  ];

  for (const row of table) {
    const blocks = blocksBy1030(row.minutes);
    assert.equal(blocks, row.blocks, `Failed for minutes=${row.minutes}: expected ${row.blocks}, got ${blocks}`);
    assert.equal(blocks * 0.5, row.hours, `Failed hours for minutes=${row.minutes}`);
  }
});

test('swapBoundaryOptions (Section 4.2.2)', () => {
  // 小板 14:00 開始
  const start = new Date('2026-11-04T14:00:00+08:00').getTime();

  // 15:40 換板：已用 100 分鐘，取 3 格，建議 15:30。選項是 15:30、16:00，預設選 15:30
  const at1 = new Date('2026-11-04T15:40:00+08:00').getTime();
  const res1 = swapBoundaryOptions(start, at1);
  const opt1Str = res1.options.map(t => new Date(t).toISOString());
  assert.equal(res1.suggested, new Date('2026-11-04T15:30:00+08:00').getTime());
  assert.equal(res1.options.length, 2);
  assert.equal(res1.options[0], new Date('2026-11-04T15:30:00+08:00').getTime());
  assert.equal(res1.options[1], new Date('2026-11-04T16:00:00+08:00').getTime());

  // 15:45 換板：已用 105 分鐘，取 4 格，建議 16:00。選項 15:30、16:00，預設選 16:00
  const at2 = new Date('2026-11-04T15:45:00+08:00').getTime();
  const res2 = swapBoundaryOptions(start, at2);
  assert.equal(res2.suggested, new Date('2026-11-04T16:00:00+08:00').getTime());
  assert.equal(res2.options[0], new Date('2026-11-04T15:30:00+08:00').getTime());
  assert.equal(res2.options[1], new Date('2026-11-04T16:00:00+08:00').getTime());

  // 14:08 換板：已用 8 分鐘，0 格，建議 14:00
  const at3 = new Date('2026-11-04T14:08:00+08:00').getTime();
  const res3 = swapBoundaryOptions(start, at3);
  assert.equal(res3.suggested, new Date('2026-11-04T14:00:00+08:00').getTime());
  assert.equal(res3.options[0], new Date('2026-11-04T14:00:00+08:00').getTime());
  assert.equal(res3.options[1], new Date('2026-11-04T14:30:00+08:00').getTime());
});
