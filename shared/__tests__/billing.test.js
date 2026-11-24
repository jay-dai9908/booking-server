// shared/__tests__/billing.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { computeEntry, splitAmount, computeBill, billingStatus, calculatePersonRefundInfo } from '../billing.js';
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

test('Section 4.5.5 Three split options for items added after payment (Round 14 Item 3)', () => {
  const pricing = { hourly: 150, unlimited: 750, allow_unlimited: true };
  const rules = { grace: 10, block: 30, early_leave_mode: 'booked', default_split_mode: 'proportional' };

  const p1Snapshot = {
    person_no: 1,
    seat_code: '2-3',
    label: '第 1 位',
    entry: { mode: 'hourly', hours: 4, amount: 600 },
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

  const discountConfig = {
    enabled: true,
    buy_hours: 3,
    free_hours: 1,
    stackable: false,
    board_discounts: {
      pegboard_s: { enabled: true, buy_hours: 3, free_hours: 1 },
      pegboard_m: { enabled: true, buy_hours: 3, free_hours: 1 }
    }
  };

  const baseInput = {
    pricing,
    rules,
    discountConfig,
    booking: { booked_minutes: 240 },
    persons: [
      { person_no: 1, seat_code: '2-3', status: 'active' },
      {
        person_no: 2,
        seat_code: '2-4',
        status: 'active',
        timer: { timer_started_at: '2026-11-04T14:00:00Z', timer_ended_at: '2026-11-04T18:43:00Z', paused_seconds: 720 },
        addons: [
          { key: 'iron_m', name: '代燙 中板', price: 50, qty: 1 }
        ]
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
    orderPromos: [
      { key: 'p1', code: 'IG50', name: 'IG 打卡折', discount_type: 'fixed_order', discount_value: 50, target_scope: 'all', split: { mode: 'proportional' } }
    ],
    manualDiscount: {
      amount: 30,
      reason: '熟客優惠',
      split: { mode: 'proportional' }
    },
    payments: [payment1]
  };

  // Option 1: 只算給還沒付的人 (預設)
  const billOpt1 = computeBill({
    ...baseInput,
    orderAddons: [
      { key: 'a1', name: '夜光吊飾扣', price: 60, qty: 1, split: { mode: 'proportional' } },
      { key: 'a_post_iron', name: '代燙大板', price: 80, qty: 1, added_after_payment: true, include_paid: false, split: { mode: 'proportional' } }
    ]
  });
  const p1_1 = billOpt1.persons.find(p => p.person_no === 1);
  const p2_1 = billOpt1.persons.find(p => p.person_no === 2);
  assert.equal(p1_1.pending_supplement || 0, 0, 'Option 1: Person 1 pending supplement is 0');
  assert.equal(p2_1.total, 1137, 'Option 1: Person 2 total is 1057 + 80 = 1137');

  // Option 2: 也分給已付的人 (Section 4.5.5 範例)
  const billOpt2 = computeBill({
    ...baseInput,
    orderAddons: [
      { key: 'a1', name: '夜光吊飾扣', price: 60, qty: 1, split: { mode: 'proportional' } },
      { key: 'a_post_iron', name: '代燙大板', price: 80, qty: 1, added_after_payment: true, include_paid: true, split: { mode: 'proportional' } }
    ]
  });
  const p1_2 = billOpt2.persons.find(p => p.person_no === 1);
  const p2_2 = billOpt2.persons.find(p => p.person_no === 2);
  assert.equal(p1_2.pending_supplement, 29, 'Option 2: Person 1 pending supplement is 29 (80 * 600 / 1670)');
  assert.equal(p2_2.total, 1108, 'Option 2: Person 2 total is 1057 + 51 = 1108');

  // Option 3a: 指定給某一位（指定給第 1 位已付者）
  const billOpt3a = computeBill({
    ...baseInput,
    orderAddons: [
      { key: 'a1', name: '夜光吊飾扣', price: 60, qty: 1, split: { mode: 'proportional' } },
      { key: 'a_post_iron', name: '代燙大板', price: 80, qty: 1, added_after_payment: true, split_mode: 'person', target_person_no: 1 }
    ]
  });
  const p1_3a = billOpt3a.persons.find(p => p.person_no === 1);
  const p2_3a = billOpt3a.persons.find(p => p.person_no === 2);
  assert.equal(p1_3a.pending_supplement, 80, 'Option 3a: Person 1 pending supplement is 80');
  assert.equal(p2_3a.total, 1057, 'Option 3a: Person 2 total is unchanged at 1057');

  // Option 3b: 指定給某一位（指定給第 2 位未付者）
  const billOpt3b = computeBill({
    ...baseInput,
    orderAddons: [
      { key: 'a1', name: '夜光吊飾扣', price: 60, qty: 1, split: { mode: 'proportional' } },
      { key: 'a_post_iron', name: '代燙大板', price: 80, qty: 1, added_after_payment: true, split_mode: 'person', target_person_no: 2 }
    ]
  });
  const p1_3b = billOpt3b.persons.find(p => p.person_no === 1);
  const p2_3b = billOpt3b.persons.find(p => p.person_no === 2);
  assert.equal(p1_3b.pending_supplement || 0, 0, 'Option 3b: Person 1 pending supplement is 0');
  assert.equal(p2_3b.total, 1137, 'Option 3b: Person 2 total is 1057 + 80 = 1137');
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

test('Round 21 Item 1: calculatePersonRefundInfo per-person paid and max_refundable calculation', () => {
  // 1. Two persons pay 400 together (each 200 via breakdown_json.persons)
  const payCharge = {
    kind: 'charge',
    status: 'valid',
    amount: 400,
    person_nos: [1, 2],
    breakdown_json: {
      persons: [
        { person_no: 1, total: 200 },
        { person_no: 2, total: 200 }
      ]
    }
  };

  const p1Initial = calculatePersonRefundInfo([payCharge], 1);
  assert.equal(p1Initial.paid_amount, 200);
  assert.equal(p1Initial.refunded_amount, 0);
  assert.equal(p1Initial.max_refundable, 200);

  const p2Initial = calculatePersonRefundInfo([payCharge], 2);
  assert.equal(p2Initial.paid_amount, 200);
  assert.equal(p2Initial.refunded_amount, 0);
  assert.equal(p2Initial.max_refundable, 200);

  // 2. Person 1 refunds 100
  const payRefund1 = {
    kind: 'refund',
    status: 'valid',
    amount: 100,
    person_nos: [1]
  };

  const p1AfterRefund = calculatePersonRefundInfo([payCharge, payRefund1], 1);
  assert.equal(p1AfterRefund.paid_amount, 200);
  assert.equal(p1AfterRefund.refunded_amount, 100);
  assert.equal(p1AfterRefund.max_refundable, 100);

  // Person 2 is unaffected by Person 1's refund
  const p2AfterP1Refund = calculatePersonRefundInfo([payCharge, payRefund1], 2);
  assert.equal(p2AfterP1Refund.paid_amount, 200);
  assert.equal(p2AfterP1Refund.refunded_amount, 0);
  assert.equal(p2AfterP1Refund.max_refundable, 200);

  // 3. Person 1 and Person 2 each refund remaining
  const payRefund1b = { kind: 'refund', status: 'valid', amount: 100, person_nos: [1] };
  const payRefund2 = { kind: 'refund', status: 'valid', amount: 200, person_nos: [2] };
  const allPayments = [payCharge, payRefund1, payRefund1b, payRefund2];

  const p1Final = calculatePersonRefundInfo(allPayments, 1);
  assert.equal(p1Final.max_refundable, 0);
  const p2Final = calculatePersonRefundInfo(allPayments, 2);
  assert.equal(p2Final.max_refundable, 0);

  const totalRefunded = allPayments.filter(p => p.kind === 'refund').reduce((s, p) => s + p.amount, 0);
  assert.equal(totalRefunded, 400);

  // 4. Legacy data without breakdown_json.persons uses splitAmount
  const legacyPay = {
    kind: 'charge',
    status: 'valid',
    amount: 400,
    person_nos: [1, 2]
    // no breakdown_json
  };
  const leg1 = calculatePersonRefundInfo([legacyPay], 1);
  const leg2 = calculatePersonRefundInfo([legacyPay], 2);
  assert.equal(leg1.paid_amount, 200);
  assert.equal(leg1.max_refundable, 200);
  assert.equal(leg2.paid_amount, 200);
  assert.equal(leg2.max_refundable, 200);

  // Odd amount split test (NT$500 between 3 persons without breakdown_json)
  const legacy500 = {
    kind: 'charge',
    status: 'valid',
    amount: 500,
    person_nos: [1, 2, 3]
  };
  const leg500_1 = calculatePersonRefundInfo([legacy500], 1);
  const leg500_2 = calculatePersonRefundInfo([legacy500], 2);
  const leg500_3 = calculatePersonRefundInfo([legacy500], 3);
  assert.equal(leg500_1.paid_amount + leg500_2.paid_amount + leg500_3.paid_amount, 500);
  assert.equal(leg500_1.paid_amount, 167);
  assert.equal(leg500_2.paid_amount, 167);
  assert.equal(leg500_3.paid_amount, 166);

  // 5. Explicit bp.amount in breakdown_json takes precedence over bp.total
  const explicitPay = {
    kind: 'charge',
    status: 'valid',
    amount: 400,
    person_nos: [1, 2],
    breakdown_json: {
      persons: [
        { person_no: 1, amount: 150, total: 300 },
        { person_no: 2, amount: 250, total: 300 }
      ]
    }
  };
  const exp1 = calculatePersonRefundInfo([explicitPay], 1);
  const exp2 = calculatePersonRefundInfo([explicitPay], 2);
  assert.equal(exp1.paid_amount, 150);
  assert.equal(exp2.paid_amount, 250);
  assert.equal(exp1.paid_amount + exp2.paid_amount, 400);

  // 6. When bpSum exceeds p.amount (e.g. partial payment), split proportionally so sum <= p.amount
  const partialPay = {
    kind: 'charge',
    status: 'valid',
    amount: 300,
    person_nos: [1, 2],
    breakdown_json: {
      persons: [
        { person_no: 1, total: 400 },
        { person_no: 2, total: 200 }
      ]
    }
  };
  const part1 = calculatePersonRefundInfo([partialPay], 1);
  const part2 = calculatePersonRefundInfo([partialPay], 2);
  assert.equal(part1.paid_amount + part2.paid_amount, 300);
  assert.equal(part1.paid_amount, 200);
  assert.equal(part2.paid_amount, 100);

  // 7. Round 35 Item 3: cash 200 + pass 800 -> max_refundable 200, pass_refundable has 1 item units 1
  const cash200 = { kind: 'charge', status: 'valid', method: 'cash', amount: 200, person_nos: [1] };
  const pass800 = {
    id: 901,
    payment_no: 'P-TEST-901',
    kind: 'charge',
    status: 'valid',
    method: 'pass',
    amount: 800,
    person_nos: [1],
    pass_json: [{ user_pass_id: 55, plan_name: '單次入場', units: 1, value: 800, person_no: 1 }]
  };
  const mixedR35 = calculatePersonRefundInfo([cash200, pass800], 1);
  assert.equal(mixedR35.paid_amount, 200);
  assert.equal(mixedR35.max_refundable, 200);
  assert.equal(mixedR35.pass_refundable.length, 1);
  assert.equal(mixedR35.pass_refundable[0].units, 1);
  assert.equal(mixedR35.pass_refundable[0].value, 800);
});

test('Round 25 Item 1: orderPromos person_nos targets only listed unpaid persons', () => {
  const pricing = { hourly: 150, unlimited: 550, allow_unlimited: true };
  const rules = { grace: 10, block: 30, early_leave_mode: 'booked', default_split_mode: 'proportional' };
  const threeUnlimitedPersons = [
    { person_no: 1, status: 'active', mode: 'unlimited' },
    { person_no: 2, status: 'active', mode: 'unlimited' },
    { person_no: 3, status: 'active', mode: 'unlimited' }
  ];

  // 1) Percentage 10% with person_nos: [1, 2] -> person 3 gets 0 discount
  const pctBill = computeBill({
    pricing,
    rules,
    booking: { booked_minutes: 240 },
    persons: threeUnlimitedPersons,
    orderPromos: [
      { code: 'VIP90', name: '9折', discount_type: 'percentage', discount_value: 10, target_scope: 'all', person_nos: [1, 2] }
    ]
  });
  assert.equal(pctBill.persons[0].total, 495);
  assert.equal(pctBill.persons[1].total, 495);
  assert.equal(pctBill.persons[2].total, 550);

  // 2) Fixed order $100 with person_nos: [1, 2] -> $100 split only across person 1 & 2; person 3 unchanged
  const fixedBill = computeBill({
    pricing,
    rules,
    booking: { booked_minutes: 240 },
    persons: threeUnlimitedPersons,
    orderPromos: [
      { code: 'OFF100', name: '整單折100', discount_type: 'fixed_order', discount_value: 100, target_scope: 'all', person_nos: [1, 2] }
    ]
  });
  assert.equal(fixedBill.persons[0].total, 500);
  assert.equal(fixedBill.persons[1].total, 500);
  assert.equal(fixedBill.persons[2].total, 550);
  assert.equal(fixedBill.summary.amount_due, 1550);

  // 3) Fixed per pax $50 with person_nos: [1, 2] -> person 3 unchanged
  const perPaxBill = computeBill({
    pricing,
    rules,
    booking: { booked_minutes: 240 },
    persons: threeUnlimitedPersons,
    orderPromos: [
      { code: 'PAX50', name: '每人折50', discount_type: 'fixed_per_pax', discount_value: 50, target_scope: 'all', person_nos: [1, 2] }
    ]
  });
  assert.equal(perPaxBill.persons[0].total, 500);
  assert.equal(perPaxBill.persons[1].total, 500);
  assert.equal(perPaxBill.persons[2].total, 550);
});

test('Round 36 Item 3: pending_supplement deducts matching valid supplements, restores on void, and computes board_addon difference', () => {
  const pricing = { hourly: 150, unlimited: 750, allow_unlimited: true };
  const rules = { grace: 10, block: 30, early_leave_mode: 'booked', default_split_mode: 'even' };
  const booking = { start_at: '2026-11-04T14:00:00+08:00', end_at: '2026-11-04T16:00:00+08:00', booked_minutes: 120 };

  const initialCharge = {
    id: 101,
    kind: 'charge',
    status: 'valid',
    method: 'cash',
    amount: 300,
    person_nos: [1],
    breakdown_json: {
      persons: [
        { person_no: 1, seat_code: 'A1', entry: { mode: 'hourly', hours: 2, amount: 300 }, board: { amount: 0, units: [] }, addons: [], shares: [], promos: [], total: 300 }
      ]
    }
  };

  // Case A: 1 person paid, post-payment order_addon 120 -> pending_supplement 120 -> valid supplement 120 -> 0 -> voided -> 120
  const baseParams = {
    pricing,
    rules,
    booking,
    persons: [{ person_no: 1, seat_code: 'A1', status: 'active' }],
    orderAddons: [
      { key: 'post_addon_1', name: '加購大包材料', price: 120, qty: 1, added_after_payment: true, include_paid: true, split: { mode: 'even' } }
    ]
  };

  const billPending = computeBill({ ...baseParams, payments: [initialCharge] });
  assert.equal(billPending.persons[0].pending_supplement, 120);
  assert.equal(billPending.persons[0].pending_items[0].source_key, 'order_addon:post_addon_1');
  assert.equal(billPending.persons[0].pending_items[0].source_type, 'order_item');

  const supPaymentValid = {
    id: 102,
    kind: 'supplement',
    status: 'valid',
    method: 'cash',
    amount: 120,
    person_nos: [1],
    breakdown_json: {
      pending_items: [{ person_no: 1, source_key: 'order_addon:post_addon_1', source_type: 'order_item', amount: 120 }]
    }
  };
  const billAfterSup = computeBill({ ...baseParams, payments: [initialCharge, supPaymentValid] });
  assert.equal(billAfterSup.persons[0].pending_supplement, 0);
  assert.equal(billAfterSup.pending_supplements.length, 0);

  const billAfterVoid = computeBill({ ...baseParams, payments: [initialCharge, { ...supPaymentValid, status: 'voided' }] });
  assert.equal(billAfterVoid.persons[0].pending_supplement, 120);

  // Case B: board_addon reserved mechanism: paid person has a board computed to 16:00 = 120 (1h * 120), already supplemented 60 -> pending_supplement = 60
  const boardAddonBill = computeBill({
    now: '2026-11-04T16:00:00+08:00',
    pricing,
    rules,
    discountConfig: { enabled: false },
    booking,
    persons: [{ person_no: 1, seat_code: 'A1', status: 'active' }],
    boards: [
      {
        unit_group: 'ug-late-1',
        person_no: 1,
        added_after_payment: true,
        segments: [
          { name: '中板', rate: 120, start_at: '2026-11-04T15:00:00+08:00' }
        ]
      }
    ],
    payments: [
      initialCharge,
      {
        id: 103,
        kind: 'supplement',
        status: 'valid',
        method: 'cash',
        amount: 60,
        person_nos: [1],
        breakdown_json: {
          pending_items: [{ person_no: 1, source_key: 'board:ug-late-1', source_type: 'board_addon', amount: 60 }]
        }
      }
    ]
  });
  assert.equal(boardAddonBill.persons[0].pending_supplement, 60);
  assert.equal(boardAddonBill.persons[0].pending_items[0].source_type, 'board_addon');
  assert.equal(boardAddonBill.persons[0].pending_items[0].source_key, 'board:ug-late-1');
});

test('Round 37 Item 1: calculateBoardTotal enforces dailyCap across swapped/paused segments', () => {
  // Swapped two 2.5h segments at 100/hr without promo => gross 500, capped at 300
  const swappedCap = calculateBoardTotal({
    segments: [
      { hours: 2.5, rate: 100, name: '小板' },
      { hours: 2.5, rate: 100, name: '小板' }
    ],
    discountConfig: { enabled: false },
    dailyCap: 300
  });
  assert.equal(swappedCap.total, 300);
  assert.equal(swappedCap.capped, true);

  // Single 5h segment with 30m pause (4.5h effective) at 100/hr => 450, capped at 300
  const pausedCap = calculateBoardTotal({
    segments: [
      {
        rate: 100,
        name: '小板',
        start_at: '2026-11-24T14:00:00+08:00',
        end_at: '2026-11-24T19:00:00+08:00'
      }
    ],
    pauses: [
      {
        started_at: '2026-11-24T15:00:00+08:00',
        ended_at: '2026-11-24T15:30:00+08:00'
      }
    ],
    discountConfig: { enabled: false },
    dailyCap: 300
  });
  assert.equal(pausedCap.total, 300);
  assert.equal(pausedCap.capped, true);

  // Without dailyCap: exact same behavior as before
  const uncapped = calculateBoardTotal({
    segments: [
      { hours: 2.5, rate: 100, name: '小板' },
      { hours: 2.5, rate: 100, name: '小板' }
    ],
    discountConfig: { enabled: false }
  });
  assert.equal(uncapped.total, 500);
  assert.equal(uncapped.capped, false);
});

test('Round 37 Item 2: zero prices are honored and not replaced by 150/750/60 defaults', () => {
  const zeroHourlyEntry = computeEntry({
    bookedMinutes: 180,
    actualMinutes: 180,
    pausedMinutes: 0,
    mode: 'hourly',
    pricing: { hourly: 0, unlimited: 750, allow_unlimited: true },
    rules: { grace: 10, block: 30, early_leave_mode: 'booked' }
  });
  assert.equal(zeroHourlyEntry.amount, 0);

  const zeroUnlimitedEntry = computeEntry({
    bookedMinutes: 180,
    actualMinutes: null,
    pausedMinutes: 0,
    mode: 'unlimited',
    pricing: { hourly: 150, unlimited: 0, allow_unlimited: true },
    rules: { grace: 10, block: 30, early_leave_mode: 'booked' }
  });
  assert.equal(zeroUnlimitedEntry.amount, 0);

  const zeroBoard = calculateBoardTotal({
    segments: [{ hours: 2, rate: 0, name: '贈送板' }],
    discountConfig: { enabled: false }
  });
  assert.equal(zeroBoard.total, 0);
});

test('Round 37 Item 3: bill_until_return uses 10/30 rounding on effective minutes, with promo and dailyCap', () => {
  const promoBuy3Get1 = { enabled: true, buy_hours: 3, free_hours: 1, stackable: true };

  // Booked 14:00-18:00 unreturned -> 4h chargeable 3h -> 180
  const fullBooked = calculateBoardTotal({
    segments: [{
      hours: 4,
      rate: 60,
      start_at: '2026-11-24T14:00:00+08:00',
      planned_end_at: '2026-11-24T18:00:00+08:00'
    }],
    discountConfig: promoBuy3Get1
  });
  assert.equal(fullBooked.total, 180);

  // Returned at 16:00 with bill_until_return -> 2h -> 120
  const returned16 = calculateBoardTotal({
    segments: [{
      rate: 60,
      start_at: '2026-11-24T14:00:00+08:00',
      end_at: '2026-11-24T16:00:00+08:00',
      planned_end_at: '2026-11-24T18:00:00+08:00',
      ended_reason: 'returned',
      bill_until_return: true
    }],
    discountConfig: promoBuy3Get1,
    graceMinutes: 10
  });
  assert.equal(returned16.H, 2);
  assert.equal(returned16.total, 120);

  // Used 2h12m (132 mins) with grace 10 -> 2.5h -> 150
  const returned212 = calculateBoardTotal({
    segments: [{
      rate: 60,
      start_at: '2026-11-24T14:00:00+08:00',
      end_at: '2026-11-24T16:12:00+08:00',
      ended_reason: 'returned',
      bill_until_return: true
    }],
    discountConfig: promoBuy3Get1,
    graceMinutes: 10
  });
  assert.equal(returned212.H, 2.5);
  assert.equal(returned212.total, 150);

  // Returned at 16:30 with 20m pause -> 150 - 20 = 130m (10m remainder <= grace 10 -> 2h) -> 120
  const pausedReturn = calculateBoardTotal({
    segments: [{
      rate: 60,
      start_at: '2026-11-24T14:00:00+08:00',
      end_at: '2026-11-24T16:30:00+08:00',
      ended_reason: 'returned',
      bill_until_return: true
    }],
    pauses: [{ started_at: '2026-11-24T15:00:00+08:00', ended_at: '2026-11-24T15:20:00+08:00' }],
    discountConfig: promoBuy3Get1,
    graceMinutes: 10
  });
  assert.equal(pausedReturn.H, 2);
  assert.equal(pausedReturn.total, 120);

  // Rate 100, cap 300, booked 6h, returned after 4.5h (3.5h chargeable * 100 = 350 -> capped at 300)
  const cappedReturn = calculateBoardTotal({
    segments: [{
      rate: 100,
      start_at: '2026-11-24T14:00:00+08:00',
      end_at: '2026-11-24T18:30:00+08:00',
      ended_reason: 'returned',
      bill_until_return: true
    }],
    discountConfig: promoBuy3Get1,
    dailyCap: 300,
    graceMinutes: 10
  });
  assert.equal(cappedReturn.H, 4.5);
  assert.equal(cappedReturn.total, 300);
  assert.equal(cappedReturn.capped, true);
});

test('Round 37 Item 4: computeEntry returns actual_minutes, paused_minutes, and booked_minutes', () => {
  const entry = computeEntry({
    bookedMinutes: 180,
    actualMinutes: 205,
    pausedMinutes: 0,
    mode: 'hourly',
    pricing: { hourly: 150, unlimited: 750, allow_unlimited: true },
    rules: { grace: 10, block: 30, early_leave_mode: 'booked' }
  });
  assert.equal(entry.hours, 3.5);
  assert.equal(entry.actual_minutes, 205);
  assert.equal(entry.paused_minutes, 0);
  assert.equal(entry.booked_minutes, 180);
});

test('Round 40 Item 1: computeBill counts 120 actual minutes for person 1 left at 15:00 while group ends at 15:30', () => {
  const bill = computeBill({
    booking: {
      booking_ref: 'R40-SHARED-1',
      pax: 3,
      booked_hours: 3,
      early_leave_mode: 'actual',
      sessions: [{ start_at: '2099-11-10T13:00:00+08:00', end_at: '2099-11-10T16:00:00+08:00' }]
    },
    persons: [
      {
        person_no: 1,
        status: 'active',
        timer: {
          billing_start_at: '2099-11-10T13:00:00+08:00',
          timer_started_at: '2099-11-10T13:00:00+08:00',
          timer_ended_at: '2099-11-10T15:00:00+08:00',
          paused_at: null,
          paused_seconds: 0
        }
      },
      {
        person_no: 2,
        status: 'active',
        timer: {
          billing_start_at: '2099-11-10T13:00:00+08:00',
          timer_started_at: '2099-11-10T13:00:00+08:00',
          timer_ended_at: '2099-11-10T15:30:00+08:00',
          paused_at: null,
          paused_seconds: 1200
        }
      },
      {
        person_no: 3,
        status: 'active',
        timer: {
          billing_start_at: '2099-11-10T13:00:00+08:00',
          timer_started_at: '2099-11-10T13:00:00+08:00',
          timer_ended_at: '2099-11-10T15:30:00+08:00',
          paused_at: null,
          paused_seconds: 1200
        }
      }
    ],
    pricing: { hourly_price: 150, unlimited_price: 750, allow_unlimited: true, discount: {} },
    now: new Date('2099-11-10T15:30:00+08:00')
  });
  const p1 = bill.persons.find(p => p.person_no === 1);
  const p2 = bill.persons.find(p => p.person_no === 2);
  assert.equal(p1.entry.actual_minutes, 120);
  assert.equal(p2.entry.actual_minutes, 130);
});






