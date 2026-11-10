import test from 'node:test';
import assert from 'node:assert/strict';
import prisma from '../src/prismaClient.js';
import { postCollect } from '../src/controllers/billingController.js';
import { queuePrintJob } from '../src/services/print/printService.js';
import { dateOnly, toTaipeiDateString } from '../../shared/time.js';

function createMockReqRes({ params = {}, body = {}, user = { name: '日期測試員', id: 1 } } = {}) {
  const req = {
    params,
    body,
    user,
    headers: { 'user-agent': 'NodeTestAgent' },
    ip: '127.0.0.1'
  };
  let statusCode = 200;
  let responseData = null;

  const res = {
    status(code) {
      statusCode = code;
      return res;
    },
    json(data) {
      responseData = data;
      return res;
    },
    getStatusCode() {
      return statusCode;
    },
    getResponseData() {
      return responseData;
    }
  };

  return { req, res };
}

test('Round 20 Item 7: Restrict client-supplied dates to test environment only', async (t) => {
  const originalEnv = process.env.NODE_ENV;
  const runId = Math.random().toString(36).slice(2, 8);
  const bookingRef = `R20-7-${runId}`;
  const sessionDate = dateOnly('2026-11-26');
  const createdJobNos = [];

  t.after(async () => {
    process.env.NODE_ENV = originalEnv;
    await prisma.printJob.deleteMany({
      where: {
        OR: [
          { booking_ref: bookingRef },
          { job_no: { in: createdJobNos } }
        ]
      }
    }).catch(() => {});
    await prisma.payment.deleteMany({
      where: { booking_ref: bookingRef }
    }).catch(() => {});
    await prisma.bookingPerson.deleteMany({
      where: { booking_ref: bookingRef }
    }).catch(() => {});
    await prisma.reservation.deleteMany({
      where: { booking_ref: bookingRef }
    }).catch(() => {});
    await prisma.user.deleteMany({
      where: { line_user_id: `test_user_${runId}` }
    }).catch(() => {});
  });

  // Ensure global print is enabled
  const setting = await prisma.globalSetting.findFirst();
  if (setting && setting.print_enabled === false) {
    await prisma.globalSetting.update({
      where: { id: setting.id },
      data: { print_enabled: true }
    });
  }

  // Create test user and session
  const testUser = await prisma.user.upsert({
    where: { line_user_id: `test_user_${runId}` },
    update: { name: '日期測試客' },
    create: {
      line_user_id: `test_user_${runId}`,
      name: '日期測試客',
      phone: '0911223344'
    }
  });

  const session = await prisma.session.upsert({
    where: {
      session_date_start_time: {
        session_date: sessionDate,
        start_time: '14:00'
      }
    },
    update: { end_time: '18:00', max_capacity: 20 },
    create: {
      session_date: sessionDate,
      start_time: '14:00',
      end_time: '18:00',
      max_capacity: 20
    }
  });

  await prisma.reservation.create({
    data: {
      booking_ref: bookingRef,
      user_id: testUser.id,
      session_id: session.id,
      pax: 2,
      assigned_seats: ['1-1', '1-2'],
      status: 'confirmed',
      checkout_details: {
        version: 2,
        order_addons: [],
        order_promos: [],
        persons: [
          { person_no: 1, addons: [] },
          { person_no: 2, addons: [] }
        ]
      }
    }
  });

  await prisma.bookingPerson.create({
    data: {
      booking_ref: bookingRef,
      person_no: 1,
      seat_code: '1-1',
      status: 'active',
      billing_start_at: new Date('2026-11-26T14:00:00+08:00'),
      timer_started_at: new Date('2026-11-26T14:00:00+08:00'),
      timer_ended_at: new Date('2026-11-26T16:00:00+08:00')
    }
  });

  await prisma.bookingPerson.create({
    data: {
      booking_ref: bookingRef,
      person_no: 2,
      seat_code: '1-2',
      status: 'active',
      billing_start_at: new Date('2026-11-26T14:00:00+08:00'),
      timer_started_at: new Date('2026-11-26T14:00:00+08:00'),
      timer_ended_at: new Date('2026-11-26T16:00:00+08:00')
    }
  });

  const todayStr = toTaipeiDateString(new Date());
  const [y, m, d] = todayStr.split('-');
  const todayYYMMDD = `${y.slice(-2)}${m}${d}`;

  await t.test('1. Non-test environment ignores client-supplied now/payment_date and uses today date', async () => {
    process.env.NODE_ENV = 'production';

    const { req, res } = createMockReqRes({
      params: { booking_ref: bookingRef },
      body: {
        person_nos: [1],
        method: 'cash',
        now: '2020-01-01',
        payment_date: '2020-01-01'
      }
    });

    await postCollect(req, res);
    assert.equal(res.getStatusCode(), 200, `postCollect should succeed: ${JSON.stringify(res.getResponseData())}`);
    const data = res.getResponseData();
    const payment = data.payments?.[0];
    assert.ok(payment, 'Payment record should be created');
    assert.ok(
      payment.payment_no.startsWith(`R-${todayYYMMDD}`),
      `Payment serial ${payment.payment_no} must start with today date R-${todayYYMMDD}, got ${payment.payment_no}`
    );
    assert.ok(
      !payment.payment_no.includes('200101'),
      `Payment serial must not use client-supplied date 2020-01-01, got ${payment.payment_no}`
    );
  });

  await t.test('2. Test environment respects client-supplied now/payment_date', async () => {
    process.env.NODE_ENV = 'test';

    const { req, res } = createMockReqRes({
      params: { booking_ref: bookingRef },
      body: {
        person_nos: [2],
        method: 'cash',
        now: '2020-01-01'
      }
    });

    await postCollect(req, res);
    assert.equal(res.getStatusCode(), 200);
    const data = res.getResponseData();
    const payment = data.payments?.[0];
    assert.ok(payment, 'Payment record should be created');
    assert.ok(
      payment.payment_no.startsWith('R-200101'),
      `In test mode, payment serial should use supplied date R-200101, got ${payment.payment_no}`
    );
  });

  await t.test('3. Print job in non-test mode ignores supplied date and uses server date', async () => {
    process.env.NODE_ENV = 'production';

    const job = await queuePrintJob({
      type: 'test',
      now: '2020-01-01',
      opts: { now: '2020-01-01' }
    });

    assert.ok(job);
    createdJobNos.push(job.job_no);
    assert.ok(
      job.job_no.startsWith(`P-${todayYYMMDD}`),
      `PrintJob serial ${job.job_no} must start with today date P-${todayYYMMDD}, got ${job.job_no}`
    );
    assert.ok(
      !job.job_no.includes('200101'),
      `PrintJob serial must not use client-supplied date in production, got ${job.job_no}`
    );
  });
});
