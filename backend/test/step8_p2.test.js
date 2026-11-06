import test from 'node:test';
import assert from 'node:assert/strict';
import prisma from '../src/prismaClient.js';
import { queuePrintJob } from '../src/services/print/printService.js';
import { buildReceipt } from '../../shared/receipts.js';

test('Step 8 P2 Tests: Test station print & PUBLIC_SITE_URL', async (t) => {
  // 1. Setup a test print station
  const station = await prisma.printStation.upsert({
    where: { id: 99 },
    update: { name: '測試列印機99', is_default: true, is_active: true },
    create: {
      id: 99,
      name: '測試列印機99',
      is_default: true,
      is_active: true,
      secret_hash: 'dummyhash'
    }
  });

  await t.test('8.1 queuePrintJob type=test builds test page and job with station info', async () => {
    const job = await queuePrintJob({
      type: 'test',
      user: { name: '店長測試員' },
      device: { device_label: '店內平板' },
      opts: { station_id: station.id }
    });

    assert.ok(job);
    assert.equal(job.type, 'test');
    assert.equal(job.title, '測試頁');
    assert.equal(job.status, 'queued');
    assert.ok(Array.isArray(job.commands_json));
    assert.ok(job.commands_json.some(c => c.text?.includes('測試') || c.text?.includes('拾光')));
  });

  await t.test('8.2 Receipts QR code reads PUBLIC_SITE_URL properly', async () => {
    const fakePayment = {
      id: 1,
      payment_no: 'PAY-TEST-QR',
      amount_paid: 500,
      payment_method: 'cash',
      created_at: new Date('2026-11-04T16:00:00+08:00'),
      breakdown_json: {
        persons: [{ person_no: 1, seat_code: '1-1', admission_fee: 500 }]
      }
    };
    const fakeBooking = {
      booking_ref: 'BK-TEST-QR01',
      session_date: new Date('2026-11-04T00:00:00Z'),
      start_time: '14:00',
      end_time: '17:00',
      pax: 1
    };

    const commands = buildReceipt(fakePayment, fakeBooking, {
      publicSiteUrl: 'https://test.shiguang.tw'
    });

    const qrCmd = commands.find(c => c.type === 'qr');
    assert.ok(qrCmd, 'QR command must exist');
    assert.ok(
      qrCmd.data.startsWith('https://test.shiguang.tw/history?tab=bookings&ref=BK-TEST-QR01'),
      `QR code URL should match expected host, got: ${qrCmd.data}`
    );
  });
});
