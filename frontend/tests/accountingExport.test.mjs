import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPaymentsCsv, buildEventsCsv, computeDailyRevenue } from '../src/utils/admin/accountingExport.js';

test('accountingExport pure functions', async (t) => {
  await t.test('1. buildPaymentsCsv includes UTF-8 BOM and correct headers', () => {
    const payments = [
      {
        payment_no: 'PAY-001',
        booking_ref: 'BK-1234-5678',
        kind: 'charge',
        method: 'cash',
        amount: 350,
        staff_name: '店長',
        created_at: '2026-11-08T10:00:00.000Z',
        breakdown_json: { customer_name: '王小明' }
      }
    ];

    const csv = buildPaymentsCsv(payments, (m) => (m === 'cash' ? '現金' : m));
    assert.ok(csv.startsWith('\uFEFF'), 'Must start with UTF-8 BOM');
    assert.ok(csv.includes('"付款編號","預約單號"'), 'Must have headers');
    assert.ok(csv.includes('"PAY-001"'), 'Must contain payment no');
    assert.ok(csv.includes('"現金"'), 'Must contain method');
    assert.ok(csv.includes('"350"'), 'Must contain amount');
  });

  await t.test('2. buildEventsCsv includes UTF-8 BOM', () => {
    const events = [
      {
        created_at: '2026-11-08T10:00:00.000Z',
        staff_name: '門市人員',
        device_label: '櫃檯平板',
        booking_ref: 'BK-ABCD-EFGH',
        summary: '作廢收款',
        category: 'void',
        reason: '收錯方式'
      }
    ];

    const csv = buildEventsCsv(events);
    assert.ok(csv.startsWith('\uFEFF'), 'Must start with UTF-8 BOM');
    assert.ok(csv.includes('"作廢收款"'));
    assert.ok(csv.includes('"收錯方式"'));
  });

  await t.test('3. computeDailyRevenue calculates net daily amounts', () => {
    const payments = [
      { created_at: '2026-11-08T10:00:00.000Z', kind: 'charge', method: 'cash', amount: 500, status: 'valid' },
      { created_at: '2026-11-08T12:00:00.000Z', kind: 'refund', method: 'cash', amount: 100, status: 'valid' },
      { created_at: '2026-11-08T14:00:00.000Z', kind: 'charge', method: 'cash', amount: 300, status: 'voided' }, // ignored
      { created_at: '2026-11-09T10:00:00.000Z', kind: 'charge', method: 'line_pay', amount: 400, status: 'valid' }
    ];

    const daily = computeDailyRevenue(payments, '2026-11-08', '2026-11-09');
    assert.strictEqual(daily.length, 2);
    assert.strictEqual(daily[0].date, '2026-11-08');
    assert.strictEqual(daily[0].revenue, 400); // 500 - 100
    assert.strictEqual(daily[1].date, '2026-11-09');
    assert.strictEqual(daily[1].revenue, 400);
  });
});
