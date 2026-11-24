import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePromoRule, computePromoDiscount } from '../promo.js';
import { computeBill } from '../billing.js';

const baseRules = {
  grace: 10,
  block: 30,
  early_leave_mode: 'booked',
  default_split_mode: 'proportional'
};

test('shared/promo: 1 pax entry 600, percentage 90 -> discounts 60, total 540', () => {
  const rule = normalizePromoRule({
    id: 1,
    code: 'VIP90',
    name: 'VIP 九折',
    discount_type: 'percentage',
    discount_value: 90,
    target_scope: 'all'
  }, { hourly_price: 200 });

  assert.equal(rule.rule_v, 2);
  assert.equal(rule.pct_off, 10);

  const res = computePromoDiscount(rule, [{ person_no: 1, entry_amount: 600, board_amount: 0, base_amount: 600 }]);
  assert.equal(res.total, 60);

  const bill = computeBill({
    pricing: { hourly: 200, unlimited: 750, allow_unlimited: true },
    rules: baseRules,
    booking: { booked_minutes: 180 },
    persons: [{ person_no: 1, status: 'active', mode: 'hourly' }],
    orderPromos: [rule]
  });
  assert.equal(bill.summary.discounts_total, 60);
  assert.equal(bill.summary.amount_due, 540);
});

test('shared/promo: 1 pax entry 600, percentage 20 with max_discount_amount 30 -> discounts 30', () => {
  const rule = normalizePromoRule({
    id: 2,
    code: 'OFF20CAP30',
    discount_type: 'percentage',
    discount_value: 20,
    max_discount_amount: 30
  });
  const bill = computeBill({
    pricing: { hourly: 200, unlimited: 750, allow_unlimited: true },
    rules: baseRules,
    booking: { booked_minutes: 180 },
    persons: [{ person_no: 1, status: 'active', mode: 'hourly' }],
    orderPromos: [rule]
  });
  assert.equal(bill.summary.discounts_total, 30);
  assert.equal(bill.summary.amount_due, 570);
});

test('shared/promo: hourly_price 150, free_hours 2 -> discounts 300', () => {
  const rule = normalizePromoRule({
    id: 3,
    code: 'FREE2H',
    discount_type: 'free_hours',
    discount_value: 2
  }, { hourly_price: 150 });

  assert.equal(rule.free_hours_amount, 300);

  const bill = computeBill({
    pricing: { hourly: 150, unlimited: 750, allow_unlimited: true },
    rules: baseRules,
    booking: { booked_minutes: 240 },
    persons: [{ person_no: 1, status: 'active', mode: 'hourly' }],
    orderPromos: [rule]
  });
  assert.equal(bill.summary.discounts_total, 300);
  assert.equal(bill.summary.amount_due, 300);
});

test('shared/promo: percentage 10 -> 60, 50 -> 300, 51 -> 294 on base 600', () => {
  const person = [{ person_no: 1, entry_amount: 600, board_amount: 0, base_amount: 600 }];
  const r10 = normalizePromoRule({ code: 'P10', discount_type: 'percentage', discount_value: 10 });
  const r50 = normalizePromoRule({ code: 'P50', discount_type: 'percentage', discount_value: 50 });
  const r51 = normalizePromoRule({ code: 'P51', discount_type: 'percentage', discount_value: 51 });
  assert.equal(computePromoDiscount(r10, person).total, 60);
  assert.equal(computePromoDiscount(r50, person).total, 300);
  assert.equal(computePromoDiscount(r51, person).total, 294);
});

test('shared/promo: target_scope seating, entry 450 + board 200, percentage 80 -> discounts 90 only on entry', () => {
  const rule = normalizePromoRule({
    code: 'SEAT80',
    discount_type: 'percentage',
    discount_value: 80,
    target_scope: 'seating'
  });
  const res = computePromoDiscount(rule, [{ person_no: 1, entry_amount: 450, board_amount: 200, base_amount: 650 }]);
  assert.equal(res.total, 90);
});

test('shared/promo: fixed_per_pax 50 across scopes 300/300/30 -> 50/50/30', () => {
  const rule = normalizePromoRule({
    code: 'PAX50',
    discount_type: 'fixed_per_pax',
    discount_value: 50
  });
  const res = computePromoDiscount(rule, [
    { person_no: 1, entry_amount: 300, board_amount: 0, base_amount: 300 },
    { person_no: 2, entry_amount: 300, board_amount: 0, base_amount: 300 },
    { person_no: 3, entry_amount: 30, board_amount: 0, base_amount: 30 }
  ]);
  assert.deepEqual(res.per_person, [
    { person_no: 1, amount: 50 },
    { person_no: 2, amount: 50 },
    { person_no: 3, amount: 30 }
  ]);
  assert.equal(res.total, 130);
});

test('shared/promo: two persons 300 each, fixed_order 1000 -> total 600, no negative totals', () => {
  const rule = normalizePromoRule({
    code: 'ORDER1000',
    discount_type: 'fixed_order',
    discount_value: 1000
  });
  const bill = computeBill({
    pricing: { hourly: 150, unlimited: 750, allow_unlimited: true },
    rules: baseRules,
    booking: { booked_minutes: 120 },
    persons: [
      { person_no: 1, status: 'active', mode: 'hourly' },
      { person_no: 2, status: 'active', mode: 'hourly' }
    ],
    orderPromos: [rule]
  });
  assert.equal(bill.summary.discounts_total, 600);
  assert.equal(bill.summary.amount_due, 0);
  assert.ok(bill.persons.every(p => p.total >= 0));
});

test('shared/promo: legacy draft without rule_v keeps old percentage behavior unchanged in computeBill', () => {
  const bill = computeBill({
    pricing: { hourly: 200, unlimited: 750, allow_unlimited: true },
    rules: baseRules,
    booking: { booked_minutes: 180 },
    persons: [{ person_no: 1, status: 'active', mode: 'hourly' }],
    orderPromos: [
      { code: 'LEGACY90', name: 'Legacy', discount_type: 'percentage', discount_value: 90, target_scope: 'all' }
    ]
  });
  assert.equal(bill.summary.discounts_total, 540);
  assert.equal(bill.summary.amount_due, 60);
});
