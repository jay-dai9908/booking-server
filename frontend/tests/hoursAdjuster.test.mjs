import test from 'node:test';
import assert from 'node:assert/strict';
import { getPersonHoursData } from '../src/utils/admin/hoursAdjuster.js';
import { computeEntry } from '../../shared/billing.js';

test('Round 37 Item 4: getPersonHoursData derives intHours=3 and overtimeChip=0.5 directly from entry', () => {
  const entry = computeEntry({
    bookedMinutes: 180,
    actualMinutes: 205,
    pausedMinutes: 0,
    mode: 'hourly',
    pricing: { hourly: 150, unlimited: 750, allow_unlimited: true },
    rules: { grace: 10, block: 30, early_leave_mode: 'booked' }
  });

  const data = getPersonHoursData(
    { person_no: 1, entry },
    { booking: { booked_minutes: 180 }, draftPersons: [] }
  );

  assert.equal(data.bookedHours, 3);
  assert.equal(data.defaultIntHours, 3);
  assert.equal(data.defaultOvertimeChip, 0.5);
  assert.equal(data.intHours, 3);
  assert.equal(data.overtimeChip, 0.5);
  assert.equal(data.totalHours, 3.5);
  assert.equal(data.actualMinutes, 205);
  assert.equal(data.pausedMinutes, 0);
});
