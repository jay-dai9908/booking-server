// shared/__tests__/billing.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { computeEntry, splitAmount, computeBill, billingStatus } from '../billing.js';
import { calculateBoardTotal, chargeableHours } from '../boardPricing.js';

test('Section 4.3.5 Entry pricing examples', () => {
  const pricing = { hourly: 150, unlimited: 750, allow_unlimited: true };
  const rules = { grace: 10, block: 30, early_leave_mode: 'booked' };

  // 林小美第 1 位: 4 小時預約, 實際 3:54 (234 分), 暫停 12 分 -> 4 小時 NT$600
  const l1 = computeEntry({
    bookedMinutes: 240,
    actualMinutes: 234,
    pausedMinutes: 12,
    pricing,
    rules
  });
  assert.equal(l1.hours, 4);
  assert.equal(l1.amount, 600);

  // 林小美第 2 位: 4 小時預約, 實際 4:31 (271 分), 暫停 12 分 -> 4.5 小時 NT$675
  const l2 = computeEntry({
    bookedMinutes: 240,
    actualMinutes: 271,
    pausedMinutes: 12,
    pricing,
    rules
  });
  assert.equal(l2.hours, 4.5);
  assert.equal(l2.amount, 675);

  // 陳大明第 1 位: 3 小時預約, 實際 3:08 (188 分) -> 3 小時 NT$450
  const c1 = computeEntry({
    bookedMinutes: 180,
    actualMinutes: 188,
    pricing,
    rules
  });
  assert.equal(c1.hours, 3);
  assert.equal(c1.amount, 450);

  // 陳大明第 2 位: 3 小時預約, 實際 3:35 (215 分) -> 3.5 小時 NT$525
  const c2 = computeEntry({
    bookedMinutes: 180,
    actualMinutes: 215,
    pausedMinutes: 12,
    pricing,
    rules
  });
  assert.equal(c2.hours, 3.5);
  assert.equal(c2.amount, 525);

  // 陳大明第 3 位: 3 小時預約, 實際 2:05 (125 分, 提早離開) -> 3 小時 NT$450
  const c3 = computeEntry({
    bookedMinutes: 180,
    actualMinutes: 125,
    pricing,
    rules
  });
  assert.equal(c3.hours, 3);
  assert.equal(c3.amount, 450);

  // 封頂: 3 小時預約
  // 5:41 (341 分, 超過 161 分 > 160 分寬限) -> 6 小時 900 -> 封頂 NT$750
  const cap6 = computeEntry({
    bookedMinutes: 180,
    actualMinutes: 341,
    pricing,
    rules
  });
  assert.equal(cap6.hours, 6);
  assert.equal(cap6.amount, 750);
  assert.equal(cap6.isCapped, true);

  // 5:40 (340 分, 超過 160 分在寬限內) -> 5.5 小時 825 -> 亦達封頂 NT$750
  const cap55 = computeEntry({
    bookedMinutes: 180,
    actualMinutes: 340,
    pricing,
    rules
  });
  assert.equal(cap55.hours, 5.5);
  assert.equal(cap55.amount, 750);
  assert.equal(cap55.isCapped, true);

});

test('Section 4.4.2 Smart board pricing examples (Scheme B)', () => {
  const discountConfig = {
    enabled: true,
    buy_hours: 3,
    free_hours: 1,
    stackable: true,
    tier2_enabled: true,
    tier2_buy_hours: 8,
    tier2_free_hours: 4
  };

  // 小板換中板: 小板 1.5h ($90/h, $135), 中板 2.5h ($120/h, $300) -> 合計 4h, 買三送一折 1h * $90 -> NT$345
  const swapResult = calculateBoardTotal({
    segments: [
      { hours: 1.5, rate: 90, name: '小板' },
      { hours: 2.5, rate: 120, name: '中板' },
    ],
    discountConfig
  });
  assert.equal(swapResult.H, 4);
  assert.equal(swapResult.free, 1);
  assert.equal(swapResult.discount, 90);
  assert.equal(swapResult.total, 345);

  // 沒換板: 小板 4h -> NT$270
  const normalResult = calculateBoardTotal({
    segments: [{ hours: 4, rate: 90, name: '小板' }],
    discountConfig
  });
  assert.equal(normalResult.total, 270);

  // 陳大明第 4 位: 小板 3h -> NT$270
  const c4Result = calculateBoardTotal({
    segments: [{ hours: 3, rate: 90, name: '小板' }],
    discountConfig
  });
  assert.equal(c4Result.total, 270);
});

test('Section 4.5.4 Lin Hsiao-mei 2-person order calculation', () => {
  const pricing = { hourly: 150, unlimited: 750, allow_unlimited: true, day_type: 'weekday' };
  const rules = { grace: 10, block: 30, early_leave_mode: 'booked', default_split_mode: 'proportional' };
  const discountConfig = {
    enabled: true,
    buy_hours: 3,
    free_hours: 1,
    stackable: true
  };

  // Person 1: Entry 4h NT$600
  // Person 2: Entry 4.5h NT$675, Board NT$345, Addon NT$50 -> Subtotal NT$1,070
  // Order addon: 夜光吊飾扣 NT$60 (proportional)
  // Order promo: IG 打卡折 NT$50 (fixed_order, proportional)
  // Manual discount: NT$30 (熟客優惠, proportional)
  const bill = computeBill({
    pricing,
    rules,
    discountConfig,
    booking: { booked_minutes: 240 },
    persons: [
      {
        person_no: 1,
        seat_code: '2-3',
        status: 'active',
        timer: { timer_started_at: '2026-11-04T14:00:00Z', timer_ended_at: '2026-11-04T18:06:00Z', paused_seconds: 720 },
        addons: [],
      },
      {
        person_no: 2,
        seat_code: '2-4',
        status: 'active',
        timer: { timer_started_at: '2026-11-04T14:00:00Z', timer_ended_at: '2026-11-04T18:43:00Z', paused_seconds: 720 },
        addons: [{ key: 'iron_m', name: '代燙 中板', price: 50, qty: 1 }],
      }
    ],
    boards: [
      {
        unit_group: 'b1',
        person_no: 2,
        segments: [
          { hours: 1.5, rate: 90, name: '小板' },
          { hours: 2.5, rate: 120, name: '中板' }
        ]
      }
    ],
    orderAddons: [
      { key: 'a1', name: '夜光吊飾扣', price: 60, qty: 1, split: { mode: 'proportional' } }
    ],
    orderPromos: [
      { key: 'p1', code: 'IG50', name: 'IG 打卡折', discount_type: 'fixed_order', discount_value: 50, target_scope: 'all', split: { mode: 'proportional' } }
    ],
    manualDiscount: {
      amount: 30,
      reason: '熟客優惠',
      split: { mode: 'proportional' }
    }
  });

  const p1 = bill.persons.find(p => p.person_no === 1);
  const p2 = bill.persons.find(p => p.person_no === 2);

  assert.equal(p1.entry.amount, 600);
  assert.equal(p2.entry.amount, 675);
  assert.equal(p2.board.amount, 345);

  // Person 1: 593, Person 2: 1057, Total: 1650
  assert.equal(p1.total, 593);
  assert.equal(p2.total, 1057);
  assert.equal(bill.summary.amount_due, 1650);

  // Regular hours total: 8.5
  assert.equal(bill.summary.regular_hours_total, 8.5);
  assert.equal(bill.summary.unlimited_pax_total, 0);
});

test('Section 4.5.5 Paid freeze and items added after payment', () => {
  const pricing = { hourly: 150, unlimited: 750, allow_unlimited: true };
  const rules = { grace: 10, block: 30, early_leave_mode: 'booked', default_split_mode: 'proportional' };

  // Person 1 has paid NT$593. Snapshot is stored in payment.
  const p1Snapshot = {
    person_no: 1,
    seat_code: '2-3',
    label: '第 1 位',
    entry: { mode: 'hourly', hours: 4, amount: 600, explain: '計時 3:54 → 收 4 小時' },
    board: { amount: 0, units: [] },
    addons: [],
    shares: [
      { source_key: 'order_addon:a1', label: '夜光吊飾扣', amount: 22 },
      { source_key: 'promo:IG50', label: 'IG 打卡折', amount: -18 },
      { source_key: 'manual', label: '手動折讓（熟客優惠）', amount: -11 }
    ],
    promos: [],
    adjust: null,
    total: 593
  };

  const payment1 = {
    id: 1,
    payment_no: 'R-0001',
    batch_no: 'B-001',
    kind: 'charge',
    status: 'valid',
    method: 'cash',
    amount: 593,
    person_nos: [1],
    breakdown_json: { persons: [p1Snapshot] }
  };

  // Person 2 adds keychain NT$60 and adjust -NT$17 (抹零)
  const bill = computeBill({
    pricing,
    rules,
    booking: { booked_minutes: 240 },
    persons: [
      { person_no: 1, seat_code: '2-3', status: 'active' },
      {
        person_no: 2,
        seat_code: '2-4',
        status: 'active',
        timer: { timer_started_at: '2026-11-04T14:00:00Z', timer_ended_at: '2026-11-04T18:43:00Z', paused_seconds: 720 },
        addons: [
          { key: 'iron_m', name: '代燙 中板', price: 50, qty: 1 },
          { key: 'kc', name: '鑰匙圈', price: 60, qty: 1 }
        ],
        adjust: { amount: -17, reason: '抹零' }
      }
    ],
    boards: [
      {
        unit_group: 'b1',
        person_no: 2,
        segments: [
          { hours: 1.5, rate: 90, name: '小板' },
          { hours: 2.5, rate: 120, name: '中板' }
        ]
      }
    ],
    orderAddons: [
      { key: 'a1', name: '夜光吊飾扣', price: 60, qty: 1, split: { mode: 'proportional' } }
    ],
    orderPromos: [
      { key: 'p1', code: 'IG50', name: 'IG 打卡折', discount_type: 'fixed_order', discount_value: 50, target_scope: 'all', split: { mode: 'proportional' } }
    ],
    manualDiscount: {
      amount: 30,
      reason: '熟客優惠',
      split: { mode: 'proportional' }
    },
    payments: [payment1]
  });

  const p1 = bill.persons.find(p => p.person_no === 1);
  const p2 = bill.persons.find(p => p.person_no === 2);

  assert.equal(p1.total, 593);
  assert.equal(p1.is_frozen, true);
  // Person 2應付: 1,070 - 13 + 60 - 17 = NT$1,100!
  assert.equal(p2.total, 1100);
});

test('Section 4.4.2 1-24 hours comparison between shared board pricing and legacy DP', () => {
  function legacyDP(hours, discountConfig) {
    if (hours <= 0) return 0;
    const t1Enabled = discountConfig.enabled !== false;
    const t1Buy = Math.max(1, parseInt(discountConfig.buy_hours, 10) || 3);
    const t1Free = Math.max(1, parseInt(discountConfig.free_hours, 10) || 1);
    const t2Enabled = discountConfig.tier2_enabled === true;
    const t2Buy = Math.max(1, parseInt(discountConfig.tier2_buy_hours, 10) || 8);
    const t2Free = Math.max(1, parseInt(discountConfig.tier2_free_hours, 10) || 4);
    const isStackable = discountConfig.stackable !== false;

    if (!isStackable) {
      let best = hours;
      if (t1Enabled) {
        if (hours >= t1Buy && hours < t1Buy + t1Free) best = Math.min(best, t1Buy);
        else if (hours >= t1Buy + t1Free) best = Math.min(best, hours - t1Free);
      }
      if (t2Enabled) {
        if (hours >= t2Buy && hours < t2Buy + t2Free) best = Math.min(best, t2Buy);
        else if (hours >= t2Buy + t2Free) best = Math.min(best, hours - t2Free);
      }
      return Math.max(0, best);
    }

    const maxH = Math.max(hours, 24);
    const cost = new Array(maxH + 1).fill(0);
    for (let h = 1; h <= maxH; h++) {
      cost[h] = cost[h - 1] + 1;
      if (t1Enabled) {
        const cycle1 = t1Buy + t1Free;
        const prev1 = Math.max(0, h - cycle1);
        cost[h] = Math.min(cost[h], cost[prev1] + t1Buy);
        if (h <= cycle1 && h >= t1Buy) cost[h] = Math.min(cost[h], t1Buy);
      }
      if (t2Enabled) {
        const cycle2 = t2Buy + t2Free;
        const prev2 = Math.max(0, h - cycle2);
        cost[h] = Math.min(cost[h], cost[prev2] + t2Buy);
        if (h <= cycle2 && h >= t2Buy) cost[h] = Math.min(cost[h], t2Buy);
      }
    }
    for (let h = maxH - 1; h >= 1; h--) cost[h] = Math.min(cost[h], cost[h + 1]);
    return Math.min(hours, cost[hours]);
  }

  const testConfigs = [
    { enabled: true, buy_hours: 3, free_hours: 1, stackable: true, tier2_enabled: true, tier2_buy_hours: 8, tier2_free_hours: 4 },
    { enabled: true, buy_hours: 3, free_hours: 1, stackable: false, tier2_enabled: false },
    { enabled: true, buy_hours: 2, free_hours: 1, stackable: true, tier2_enabled: false }
  ];

  for (const cfg of testConfigs) {
    for (let h = 1; h <= 24; h++) {
      const leg = legacyDP(h, cfg);
      const actual = chargeableHours(h, cfg);
      assert.equal(actual, leg, `Mismatch at h=${h} for cfg ${JSON.stringify(cfg)}: expected ${leg}, got ${actual}`);
    }
  }
});

test('Section 4.6 billingStatus transitions', () => {
  const pList = [
    { person_no: 1, status: 'active' },
    { person_no: 2, status: 'active' },
    { person_no: 3, status: 'active' },
    { person_no: 4, status: 'active' }
  ];

  // 1. Unpaid: 0 covered
  const s0 = billingStatus({ persons: pList, payments: [] });
  assert.equal(s0.code, 'unpaid');
  assert.equal(s0.label, '未結帳');

  // 2. Partial: 1 covered (Person 3)
  const pay1 = { kind: 'charge', status: 'valid', person_nos: [3] };
  const s1 = billingStatus({ persons: pList, payments: [pay1] });
  assert.equal(s1.code, 'partial');
  assert.equal(s1.label, '已結 1/4');

  // 3. Partial: 3 covered (Person 1, 2, 3)
  const pay2 = { kind: 'charge', status: 'valid', person_nos: [1, 2] };
  const s2 = billingStatus({ persons: pList, payments: [pay1, pay2] });
  assert.equal(s2.code, 'partial');
  assert.equal(s2.label, '已結 3/4');

  // 4. Paid: 4 covered (Person 4)
  const pay3 = { kind: 'charge', status: 'valid', person_nos: [4] };
  const s3 = billingStatus({ persons: pList, payments: [pay1, pay2, pay3] });
  assert.equal(s3.code, 'paid');
  assert.equal(s3.label, '已結清');

  // 5. Waived: all 4 covered by waive
  const payWaive = { kind: 'waive', status: 'valid', person_nos: [1, 2, 3, 4] };
  const sWaive = billingStatus({ persons: pList, payments: [payWaive] });
  assert.equal(sWaive.code, 'waived');
  assert.equal(sWaive.label, '免收');

  // 6. With refund tag
  const sRefund = billingStatus({ persons: pList, payments: [pay1, pay2, pay3], hasRefund: true });
  assert.ok(sRefund.tags.some(t => t.code === 'refund' && t.label === '有退款'));

  // 7. With pending supplement tag
  const sPending = billingStatus({ persons: pList, payments: [pay1, pay2, pay3], pendingSupplements: [{ amount: 29 }] });
  assert.ok(sPending.tags.some(t => t.code === 'pending' && t.label === '待補收 NT$29'));
});

