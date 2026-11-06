import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBillInput } from '../src/services/billing/billInput.js';
import { computeBill } from '../../shared/billing.js';

test('buildBillInput constructs accurate inputs for computeBill', () => {
  const reservations = [
    {
      id: 1,
      booking_ref: 'BK-TEST-0001',
      pax: 2,
      is_walk_in: false,
      session_date: '2026-11-04',
      session: { session_date: '2026-11-04', start_time: '14:00', end_time: '18:00' },
      assigned_seats: ['2-3', '2-4'],
      checkout_details: {
        version: 2,
        order_addons: [{ key: 'a1', name: '夜光吊飾扣', price: 60, qty: 1, split: { mode: 'proportional' } }],
        order_promos: [{ key: 'p1', code: 'IG50', name: 'IG 打卡折', discount_type: 'fixed_order', discount_value: 50, split: { mode: 'proportional' } }],
        manual_discount: { amount: 30, reason: '熟客優惠', split: { mode: 'proportional' } },
        persons: [
          { person_no: 1, addons: [] },
          { person_no: 2, addons: [{ key: 'iron_m', name: '代燙 中板', price: 50, qty: 1 }] }
        ]
      }
    }
  ];

  const bookingPersons = [
    {
      id: 101,
      person_no: 1,
      seat_code: '2-3',
      status: 'active',
      billing_start_at: new Date('2026-11-04T14:00:00+08:00'),
      timer_started_at: new Date('2026-11-04T14:00:00+08:00'),
      timer_ended_at: new Date('2026-11-04T18:06:00+08:00'),
      paused_seconds: 720,
      paused_at: null
    },
    {
      id: 102,
      person_no: 2,
      seat_code: '2-4',
      status: 'active',
      billing_start_at: new Date('2026-11-04T14:00:00+08:00'),
      timer_started_at: new Date('2026-11-04T14:00:00+08:00'),
      timer_ended_at: new Date('2026-11-04T18:43:00+08:00'),
      paused_seconds: 720,
      paused_at: null
    }
  ];

  const bookingEquipments = [
    {
      id: 201,
      booking_ref: 'BK-TEST-0001',
      equipment_id: 'pegboard_s',
      equipment_name_snapshot: '小板',
      unit_group: 'b1',
      segment_no: 1,
      person_id: 102,
      start_at: new Date('2026-11-04T14:00:00+08:00'),
      end_at: new Date('2026-11-04T15:30:00+08:00'),
      ended_reason: 'swapped',
      unit_rate: 90
    },
    {
      id: 202,
      booking_ref: 'BK-TEST-0001',
      equipment_id: 'pegboard_m',
      equipment_name_snapshot: '中板',
      unit_group: 'b1',
      segment_no: 2,
      person_id: 102,
      start_at: new Date('2026-11-04T15:30:00+08:00'),
      end_at: new Date('2026-11-04T18:00:00+08:00'),
      ended_reason: null,
      unit_rate: 120
    }
  ];

  const globalSetting = {
    billing_grace_minutes: 10,
    billing_block_minutes: 30,
    early_leave_mode: 'booked',
    default_split_mode: 'proportional',
    equipment_discount_enabled: true,
    equipment_discount_buy_hours: 3,
    equipment_discount_free_hours: 1,
    equipment_discount_stackable: true
  };

  const pricing = {
    hourly_price: 150,
    unlimited_price: 750,
    allow_unlimited: true,
    is_weekend: false
  };

  const input = buildBillInput({
    bookingRef: 'BK-TEST-0001',
    reservations,
    bookingPersons,
    bookingEquipments,
    payments: [],
    globalSetting,
    pricing,
    now: new Date('2026-11-04T19:00:00+08:00').getTime()
  });

  const bill = computeBill(input);

  const p1 = bill.persons.find(p => p.person_no === 1);
  const p2 = bill.persons.find(p => p.person_no === 2);

  assert.equal(p1.entry.amount, 600);
  assert.equal(p2.entry.amount, 675);
  assert.equal(p2.board.amount, 345);
  assert.equal(p1.total, 593);
  assert.equal(p2.total, 1057);
  assert.equal(bill.summary.amount_due, 1650);
  assert.equal(bill.summary.regular_hours_total, 8.5);
});
