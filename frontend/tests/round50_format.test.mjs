import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatBookingRef,
  formatDateTime,
  formatDateShort,
} from '../src/utils/customer/format.js';

describe('Round 50 Item 3: booking ref & Taipei timestamp formatters', () => {
  test('formatBookingRef formats long UUID/alphanumeric refs into BK-XXXX-XXXX consistently', () => {
    assert.equal(
      formatBookingRef('a1b2c3d4-e5f6-7890-abcd-ef1234567890'),
      'BK-A1B2-7890'
    );
    assert.equal(formatBookingRef('BK-A1B2-7890'), 'BK-A1B2-7890');
    assert.equal(formatBookingRef('abcd1234'), 'BK-ABCD-1234');
  });

  test('formatDateTime formats ISO timestamps in Asia/Taipei regardless of host timezone', () => {
    const iso = '2026-12-01T17:30:00Z'; // Taipei: 2026-12-02 01:30
    assert.equal(formatDateTime(iso, 'MM/dd HH:mm'), '12/02 01:30');
    assert.equal(formatDateTime(iso, 'yyyy/MM/dd'), '2026/12/02');
  });

  test('formatDateShort formats pure YYYY-MM-DD calendar strings', () => {
    assert.equal(formatDateShort('2026-12-02'), '12/02 週三');
  });
});
