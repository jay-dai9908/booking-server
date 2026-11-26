import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { taipeiToday, taipeiAddDays, sessionStartAt } from '../src/utils/customer/taipeiTime.js';
import { isSessionPast } from '../src/utils/customer/availability.js';

describe('Round 49 Item 4: Taipei date and session start checks across timezones', () => {
  test('taipeiToday returns 2026-12-02 at 2026-12-01T17:30:00Z regardless of host TZ', () => {
    const now = new Date('2026-12-01T17:30:00Z'); // Taipei 2026-12-02 01:30
    assert.equal(taipeiToday(now), '2026-12-02');
    assert.equal(taipeiAddDays('2026-12-02', 1), '2026-12-03');
    assert.equal(taipeiAddDays('2026-12-02', 30), '2027-01-01');
  });

  test('isSessionPast evaluates start_time against +08:00 Taipei wall clock', () => {
    const now = new Date('2026-12-01T17:30:00Z'); // Taipei 2026-12-02 01:30
    assert.equal(isSessionPast('2026-12-02', { start_time: '01:00' }, now), true);
    assert.equal(isSessionPast('2026-12-02', { start_time: '02:00' }, now), false);
    assert.equal(sessionStartAt('2026-12-02', '01:30').getTime(), now.getTime());
  });
});
