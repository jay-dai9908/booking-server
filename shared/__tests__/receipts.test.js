// shared/__tests__/receipts.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  fitLine,
  strWidth,
  formatReceiptMoney,
  formatBookingRef,
  extractReceiptSessionInfo,
  buildReceipt,
  buildSupplementReceipt,
  buildRefundSlip,
  buildOrderSummary,
  buildClosingSlip,
  buildTestPage,
  commandsToPreviewHtml
} from '../receipts.js';
import { displayBoardName } from '../billing.js';

test('fitLine width budgeting (Section 8.1, 4.10)', () => {
  // Chinese characters count as 2, English/numbers as 1
  assert.equal(strWidth('拾光製所'), 8);
  assert.equal(strWidth('NT$1,650'), 8);

  const line1 = fitLine('第 1 位 入場 4 小時', 'NT$600', 31);
  assert.ok(strWidth(line1) <= 31, `Expected <= 31, got ${strWidth(line1)} for: ${line1}`);
  assert.ok(line1.endsWith('NT$600'));
  assert.ok(!line1.endsWith('\n'), 'fitLine should not end with newline');

  // Truncation test: very long left item
  const line2 = fitLine('這是一個非常非常非常非常非常非常非常長的商品名稱', 'NT$120', 31);
  assert.ok(strWidth(line2) <= 31, `Expected <= 31, got ${strWidth(line2)} for: ${line2}`);
  assert.ok(line2.includes('…'));
  assert.ok(line2.endsWith('NT$120'));
});

test('formatReceiptMoney negative uses half-width hyphen', () => {
  assert.equal(formatReceiptMoney(-30), '-NT$30');
  assert.equal(formatReceiptMoney(1650), 'NT$1,650');
});

test('displayBoardName replaces 洞洞板 with 智能板', () => {
  assert.equal(displayBoardName('小洞洞板 50x50'), '小智能板 50x50');
  assert.equal(displayBoardName('大智能板'), '大智能板');
});

test('formatBookingRef formats references to BK-XXXX-XXXX (Section 4.5)', () => {
  assert.equal(formatBookingRef('BK-4E1A-90C2'), 'BK-4E1A-90C2');
  assert.equal(formatBookingRef('9d35-74f1'), 'BK-9D35-74F1');
  assert.equal(formatBookingRef('9d35-1234-5678-74f1'), 'BK-9D35-74F1');
  assert.equal(formatBookingRef('9d3574f1'), 'BK-9D35-74F1');
});

test('Section 4.5 & 8.2: Split payment receipt line widths <= 31, session times, ref format, and status line', () => {
  const payment = {
    payment_no: 'R-0001',
    booking_ref: '9d35-1234-5678-74f1',
    created_at: '2026-11-04T16:12:00+08:00',
    staff_name: '小安',
    amount: 1035,
    method: 'cash',
    cash_received: 1100,
    change_given: 65,
    person_nos: [1, 2],
    breakdown_json: {
      persons: [
        {
          label: '第 1 位',
          person_no: 1,
          seat_code: '1-1',
          entry: { hours: 3, amount: 450 },
          addons: [{ name: '鑰匙圈加購', qty: 1, subtotal: 60 }]
        },
        {
          label: '第 2 位',
          person_no: 2,
          seat_code: '1-2',
          entry: { hours: 3.5, amount: 525, paused_minutes: 12 }
        }
      ],
      order: {
        persons_total: 4,
        persons_paid_after: 3
      }
    }
  };

  const booking = {
    booking_ref: '9d35-1234-5678-74f1',
    pax: 4,
    start_time: '13:00',
    end_time: '16:00',
    session_date: '2026-11-04',
    assigned_seats: ['1-1', '1-2', '1-3', '1-4']
  };

  const commands = buildReceipt(payment, booking, { isFullOrder: false });

  // 1. Title and Ref check
  assert.equal(commands[0].text, '拾光製所');
  const refCmd = commands.find(c => c.text?.startsWith('結帳單'));
  assert.ok(refCmd);
  assert.equal(refCmd.text, '結帳單 BK-9D35-74F1');

  // 2. Session time check: must be 13:00-16:00 桌 1, not 16:12-16:12
  const timeCmd = commands.find(c => c.text?.includes('13:00-16:00'));
  assert.ok(timeCmd, 'Session time must use reservation start/end time');
  assert.ok(timeCmd.text.includes('桌 1'), 'Table label must be present');

  // 3. Status line check: must include "整單 4 位：已結 3 位，尚 1 位"
  const statusCmd = commands.find(c => c.text?.includes('整單 4 位：已結 3 位，尚 1 位'));
  assert.ok(statusCmd, 'Split status line must be present');

  // 4. Line width check and no trailing newlines check
  for (const cmd of commands) {
    if (cmd.type === 'text' || cmd.type === 'title') {
      assert.ok(!cmd.text.endsWith('\n'), `Command should not end with newline: ${JSON.stringify(cmd.text)}`);
      for (const line of cmd.text.split('\n')) {
        const w = strWidth(line);
        assert.ok(w <= 31, `Line width exceeds 31 (${w} chars): "${line}"`);
      }
    }
  }
});

test('Section 8.3: Full order receipt matches spec template and widths <= 31', () => {
  const payment = {
    payment_no: 'R-0001',
    booking_ref: '4e1a-1234-5678-90c2',
    created_at: '2026-11-04T18:35:00+08:00',
    staff_name: '阿哲',
    amount: 1650,
    method: 'cash',
    cash_received: 2000,
    change_given: 350,
    person_nos: [1, 2],
    breakdown_json: {
      persons: [
        { label: '第 1 位', entry: { hours: 4, amount: 600 } },
        { label: '第 2 位', entry: { hours: 4.5, amount: 675 }, board: { amount: 345 } }
      ],
      order: { persons_total: 2, persons_paid_after: 2 }
    }
  };

  const booking = {
    booking_ref: '4e1a-1234-5678-90c2',
    pax: 2,
    start_time: '14:00',
    end_time: '18:00',
    session_date: '2026-11-04',
    table_label: '桌 2'
  };

  const commands = buildReceipt(payment, booking, { isFullOrder: true });
  assert.equal(commands[0].type, 'title');
  assert.equal(commands[0].text, '拾光製所');

  const refCmd = commands.find(c => c.text?.startsWith('結帳單'));
  assert.equal(refCmd.text, '結帳單 BK-4E1A-90C2');

  const statusCmd = commands.find(c => c.text?.includes('狀態 已結清 2/2'));
  assert.ok(statusCmd);

  // Width check
  for (const cmd of commands) {
    if (cmd.type === 'text' || cmd.type === 'title') {
      assert.ok(!cmd.text.endsWith('\n'), `Command should not end with newline: ${JSON.stringify(cmd.text)}`);
      for (const line of cmd.text.split('\n')) {
        const w = strWidth(line);
        assert.ok(w <= 31, `Line width exceeds 31 (${w} chars): "${line}"`);
      }
    }
  }

  const html = commandsToPreviewHtml(commands);
  assert.ok(html.includes('拾光製所'));
  assert.ok(html.includes('BK-4E1A-90C2'));
});

test('Section 8.4 buildSupplementReceipt generates valid supplement slip', () => {
  const payment = {
    payment_no: 'R-0002',
    booking_ref: 'BK-4E1A-90C2',
    created_at: '2026-11-04T18:52:00Z',
    staff_name: '阿哲',
    amount: 60,
    method: 'cash',
    cash_received: 100,
    change_given: 40,
    person_nos: [1],
    breakdown_json: {
      items: [{ name: '鑰匙圈', qty: 1, amount: 60 }],
      person_total_paid: 653
    }
  };
  const booking = {
    booking_ref: 'BK-4E1A-90C2',
    pax: 2,
    start_at: '2026-11-04T14:00:00Z',
    end_at: '2026-11-04T18:00:00Z',
    table_label: '桌 2'
  };

  const commands = buildSupplementReceipt(payment, booking);
  assert.ok(commands.some(c => c.text && c.text.includes('補收單')));
  assert.ok(commands.some(c => c.text && c.text.includes('NT$60')));

  for (const cmd of commands) {
    if (cmd.type === 'text' || cmd.type === 'title') {
      assert.ok(!cmd.text.endsWith('\n'), `No trailing newline in ${cmd.text}`);
      for (const line of cmd.text.split('\n')) {
        assert.ok(strWidth(line) <= 31);
      }
    }
  }
});

test('Section 8.5 buildRefundSlip generates merchant and customer copy', () => {
  const refundPayment = {
    payment_no: 'R-0003',
    booking_ref: 'BK-4E1A-90C2',
    created_at: '2026-11-04T19:05:00Z',
    staff_name: '阿哲',
    amount: 100,
    method: 'cash',
    reason: '提早結束',
    person_nos: [1],
    breakdown_json: {
      original_amount: 593,
      seat_code: '2-3'
    }
  };
  const booking = {
    booking_ref: 'BK-4E1A-90C2',
    pax: 2
  };

  const commands = buildRefundSlip(refundPayment, booking);
  assert.ok(commands.some(c => c.text && c.text.includes('退款單')));
  assert.ok(commands.some(c => c.text && c.text.includes('顧客聯')));

  for (const cmd of commands) {
    if (cmd.type === 'text' || cmd.type === 'title') {
      assert.ok(!cmd.text.endsWith('\n'));
      for (const line of cmd.text.split('\n')) {
        assert.ok(strWidth(line) <= 31);
      }
    }
  }
});

test('Section 8.6 buildOrderSummary generates store summary slip', () => {
  const booking = {
    booking_ref: 'BK-9D35-74F1',
    customer_name: '陳大明',
    pax: 4,
    start_at: '2026-11-04T13:00:00Z',
    end_at: '2026-11-04T16:00:00Z',
    table_label: '桌 1'
  };
  const payments = [
    { person_nos: [1], method: 'cash', amount: 510, created_at: '2026-11-04T16:12:00Z' },
    { person_nos: [2], method: 'cash', amount: 525, created_at: '2026-11-04T16:12:00Z' },
    { person_nos: [3], method: 'cash', amount: 450, created_at: '2026-11-04T15:05:00Z' },
    { person_nos: [4], method: 'line_pay', amount: 720, created_at: '2026-11-04T16:20:00Z' },
  ];

  const commands = buildOrderSummary(booking, payments);
  assert.ok(commands.some(c => c.text && c.text.includes('整單總表（店家留存）')));
  assert.ok(commands.some(c => c.text && c.text.includes('NT$2,205')));

  for (const cmd of commands) {
    if (cmd.type === 'text' || cmd.type === 'title') {
      assert.ok(!cmd.text.endsWith('\n'));
      for (const line of cmd.text.split('\n')) {
        assert.ok(strWidth(line) <= 31);
      }
    }
  }
});

test('Section 8.7 buildClosingSlip generates daily cash closing slip', () => {
  const closing = {
    business_date: '2026-11-04',
    created_at: '2026-11-04T21:10:00Z',
    staff_name: '小安',
    float_amount: 2000,
    expected_cash: 14480,
    counted_cash: 14480,
    difference: 0,
    totals_json: {
      by_method: {
        cash: { count: 14, amount: 12480 },
        line_pay: { count: 6, amount: 6300 },
        transfer: { count: 2, amount: 2100 }
      },
      refunds: { count: 1, amount: 450 },
      net_sales: 20430,
      pass_value: 1800,
      pass_count: 3,
      voids_amount: 525,
      voids_count: 1,
      unpaid_amount: 1170,
      unpaid_count: 2
    }
  };

  const commands = buildClosingSlip(closing);
  assert.ok(commands.some(c => c.text && c.text.includes('日結單')));
  assert.ok(commands.some(c => c.text && c.text.includes('NT$20,430')));
  assert.ok(commands.some(c => c.text && c.text.includes('NT$14,480')));

  for (const cmd of commands) {
    if (cmd.type === 'text' || cmd.type === 'title') {
      assert.ok(!cmd.text.endsWith('\n'));
      for (const line of cmd.text.split('\n')) {
        assert.ok(strWidth(line) <= 31);
      }
    }
  }
});
