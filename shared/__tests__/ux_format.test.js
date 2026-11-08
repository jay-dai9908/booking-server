import test from 'node:test';
import assert from 'node:assert/strict';
import { formatMinus, safeFormatDate, formatDateShort } from '../../frontend/src/utils/customer/format.js';
import { bookingTimeRange } from '../../frontend/src/utils/admin/floorSelectors.js';

test('formatMinus returns NT$0 for 0, and -NT$X for positive numbers (E1)', () => {
  assert.equal(formatMinus(0), 'NT$0');
  assert.equal(formatMinus('0'), 'NT$0');
  assert.equal(formatMinus(null), 'NT$0');
  assert.equal(formatMinus(undefined), 'NT$0');
  assert.equal(formatMinus(100), '-NT$100');
  assert.equal(formatMinus(250.4), '-NT$250');
  assert.equal(formatMinus(-50), '-NT$50');
});

test('safeFormatDate handles invalid dates without crashing (A1)', () => {
  assert.equal(safeFormatDate(null), '—');
  assert.equal(safeFormatDate(undefined), '—');
  assert.equal(safeFormatDate('invalid-date'), '—');
  assert.equal(safeFormatDate(''), '—');
  assert.equal(safeFormatDate('2026-11-10T14:00:00+08:00', 'yyyy-MM-dd'), '2026-11-10');
});

test('formatDateShort does not duplicate weekday (B3)', () => {
  const result = formatDateShort('2026-11-10'); // Tuesday
  assert.equal(result, '11/10 週二');
});

test('bookingTimeRange handles both plain time strings and ISO timestamps (C1)', () => {
  // Plain time strings
  assert.equal(bookingTimeRange('12:00', '15:00'), '12:00 到 15:00');
  // Plain time strings with seconds
  assert.equal(bookingTimeRange('14:00:00', '17:00:00'), '14:00 到 17:00');
  // ISO timestamps
  assert.equal(bookingTimeRange('2026-11-10T14:00:00+08:00', '2026-11-10T17:00:00+08:00'), '14:00 到 17:00');
});
