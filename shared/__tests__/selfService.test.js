// shared/__tests__/selfService.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  prepayDeadline,
  earliestEntry,
  ironText,
  selfEquipmentTerms
} from '../selfService.js';

test('prepayDeadline computes previous day in Asia/Taipei including month and year boundaries', () => {
  const d1 = prepayDeadline('2026-11-22', 12);
  assert.equal(d1.toISOString(), '2026-11-21T04:00:00.000Z'); // 2026-11-21 12:00+08:00

  // 跨月: 2026-12-01 -> 2026-11-30 12:00+08:00
  const dMonth = prepayDeadline('2026-12-01', 12);
  assert.equal(dMonth.toISOString(), '2026-11-30T04:00:00.000Z');

  // 跨年: 2026-01-01 -> 2025-12-31 12:00+08:00
  const dYear = prepayDeadline('2026-01-01', 12);
  assert.equal(dYear.toISOString(), '2025-12-31T04:00:00.000Z');
});

test('earliestEntry subtracts earlyMinutes and clamps at 00:00 without crossing day', () => {
  assert.equal(earliestEntry('09:00', 30), '08:30');
  assert.equal(earliestEntry('13:00', 30), '12:30');
  assert.equal(earliestEntry('00:10', 30), '00:00');
});

test('ironText handles today, next, and date modes', () => {
  assert.equal(
    ironText({ iron_mode: 'today', date: '2026-11-22', today: '2026-11-22' }),
    '店員會在今天下午到店協助熨燙'
  );
  assert.equal(
    ironText({ iron_mode: 'today', date: '2026-11-25', today: '2026-11-22' }),
    '店員會在當天下午到店協助熨燙'
  );
  assert.equal(
    ironText({ iron_mode: 'next', date: '2026-11-22', today: '2026-11-22' }),
    '店員會在隔天協助熨燙'
  );
  assert.equal(
    ironText({ iron_mode: 'date', iron_date: '2026-11-25' }),
    '店員會在 11/25（三）協助熨燙'
  );
  assert.equal(
    ironText({ iron_mode: 'date', iron_date: '2025-11-25' }),
    '店員會在 11/25（二）協助熨燙'
  );
});

test('selfEquipmentTerms falls back to regular terms and caps stock to total_stock', () => {
  const fallbackTerms = selfEquipmentTerms({
    id: 'pegboard_m',
    hourly_rate: 120,
    daily_cap: 500,
    total_stock: 5,
    self_hourly_rate: null,
    self_daily_cap: null,
    self_stock: null
  });
  assert.deepEqual(fallbackTerms, { hourly_rate: 120, daily_cap: 500, stock: 5 });

  const cappedTerms = selfEquipmentTerms({
    id: 'pegboard_m',
    hourly_rate: 120,
    daily_cap: 500,
    total_stock: 5,
    self_hourly_rate: 100,
    self_daily_cap: 400,
    self_stock: 8
  });
  assert.deepEqual(cappedTerms, { hourly_rate: 100, daily_cap: 400, stock: 5 });

  const smallerTerms = selfEquipmentTerms({
    id: 'pegboard_m',
    hourly_rate: 120,
    daily_cap: 500,
    total_stock: 5,
    self_hourly_rate: 100,
    self_daily_cap: null,
    self_stock: 2
  });
  assert.deepEqual(smallerTerms, { hourly_rate: 100, daily_cap: 500, stock: 2 });
});
