import test from 'node:test';
import assert from 'node:assert/strict';
import { computePassTenderValue } from '../../shared/passValue.js';

test('shared/passValue: entry_full returns full entry 800 on unlimited', () => {
  const value = computePassTenderValue({
    checkout_effect: 'entry_full',
    pass_type: 'VISIT_PACK',
    units: 1,
    person: { entry: { amount: 800 }, total: 1000 },
    hourly_price: 150,
    already_covered: 0
  });
  assert.equal(value, 800);
});

test('shared/passValue: entry_hours with 2 units returns 300 when entry is 800 and hourly is 150', () => {
  const value = computePassTenderValue({
    checkout_effect: 'entry_hours',
    pass_type: 'TIME_PASS',
    units: 2,
    person: { entry: { amount: 800 }, total: 1000 },
    hourly_price: 150,
    already_covered: 0
  });
  assert.equal(value, 300);
});

test('shared/passValue: fixed_amount 500 scope all respects already_covered 800 out of total 1000 -> 200', () => {
  const value = computePassTenderValue({
    checkout_effect: 'fixed_amount',
    pass_type: 'VISIT_PACK',
    checkout_scope: 'all',
    checkout_value: 500,
    units: 1,
    person: { entry: { amount: 800 }, total: 1000 },
    hourly_price: 150,
    already_covered: 800
  });
  assert.equal(value, 200);
});
