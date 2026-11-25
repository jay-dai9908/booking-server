import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import express from 'express';
import cookieParser from 'cookie-parser';
import prisma from '../src/prismaClient.js';
import authRoutes from '../src/routes/auth.js';
import accountingRoutes from '../src/routes/accounting.js';
import { ensureTestPublishedLayout, cleanupTestPublishedLayout } from './helpers/seedTestLayout.js';
import { dateOnly, toTaipeiDateString } from '../../shared/time.js';

function startLocalApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/auth', authRoutes);
  app.use('/api/accounting', accountingRoutes);
  const server = http.createServer(app);
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', (err) => {
      if (err) return reject(err);
      resolve({
        baseUrl: `http://127.0.0.1:${server.address().port}`,
        close: () => new Promise((r) => server.close(r))
      });
    });
  });
}

test('Round 36 Item 4: closing snapshot stores complete totals_json, drives PrintJob, rejects future date, handles missing float_amount, and logs diff reason', async (t) => {
  const runId = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const todayStr = toTaipeiDateString(new Date());
  const tomorrowStr = toTaipeiDateString(new Date(Date.now() + 24 * 60 * 60 * 1000));
  const futureDate = dateOnly('2099-11-13');
  const refA = `R36-I4-A-${runId}`;

  let srv = null;
  let user = null;
  let adminUser = null;
  let session = null;
  let dailySetting = 'existing';
  let createdLayoutId = null;
  let origFloat = null;
  let globalSettingId = null;
  const createdClosingIds = [];

  t.after(async () => {
    if (srv) await srv.close().catch(() => {});
    for (const cid of createdClosingIds) {
      await prisma.printJob.deleteMany({ where: { closing_id: cid } }).catch(() => {});
      await prisma.cashClosing.delete({ where: { id: cid } }).catch(() => {});
    }
    await prisma.payment.deleteMany({ where: { booking_ref: refA } }).catch(() => {});
    await prisma.bookingPerson.deleteMany({ where: { booking_ref: refA } }).catch(() => {});
    await prisma.reservation.deleteMany({ where: { booking_ref: refA } }).catch(() => {});
    if (session?.id) await prisma.session.delete({ where: { id: session.id } }).catch(() => {});
    if (dailySetting === 'created') await prisma.dailySetting.delete({ where: { date: futureDate } }).catch(() => {});
    if (user?.id) await prisma.user.delete({ where: { id: user.id } }).catch(() => {});
    if (adminUser?.id) await prisma.adminUser.delete({ where: { id: adminUser.id } }).catch(() => {});
    if (globalSettingId != null) {
      await prisma.globalSetting.update({ where: { id: globalSettingId }, data: { cash_float_amount: origFloat } }).catch(() => {});
    }
    await cleanupTestPublishedLayout(prisma, createdLayoutId);
  });

  createdLayoutId = await ensureTestPublishedLayout(prisma);
  srv = await startLocalApp();

  const gs = await prisma.globalSetting.findFirst();
  if (gs) {
    globalSettingId = gs.id;
    origFloat = gs.cash_float_amount;
    await prisma.globalSetting.update({ where: { id: gs.id }, data: { cash_float_amount: 2000 } });
  } else {
    const createdGs = await prisma.globalSetting.create({ data: { cash_float_amount: 2000 } });
    globalSettingId = createdGs.id;
    origFloat = 2000;
  }

  user = await prisma.user.create({
    data: {
      line_user_id: `r36_i4_user_${runId}`,
      name: 'R36交班客',
      phone: `09964${String(Date.now()).slice(-5)}` // check-secrets: fake-data
    }
  });
  const adminPass = `r36_i4_adm_${runId}`;
  adminUser = await prisma.adminUser.create({
    data: {
      password: adminPass,
      name: `R36交班店長_${runId}`,
      role: 'superadmin',
      permissions: ['all'],
      is_active: true
    }
  });

  const loginRes = await fetch(`${srv.baseUrl}/api/auth/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: adminPass })
  });
  assert.equal(loginRes.status, 200);
  const { token: adminToken } = await loginRes.json();
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` };

  const existingDaily = await prisma.dailySetting.findUnique({ where: { date: futureDate } });
  if (!existingDaily) {
    await prisma.dailySetting.create({
      data: { date: futureDate, hourly_price: 250, unlimited_price: 900, allow_unlimited: true, is_self_service: false }
    });
    dailySetting = 'created';
  }

  session = await prisma.session.create({
    data: { session_date: futureDate, start_time: '13:00', end_time: '15:00', max_capacity: 20 }
  });

  await prisma.reservation.create({
    data: {
      booking_ref: refA,
      user_id: user.id,
      session_id: session.id,
      pax: 1,
      assigned_seats: ['A1'],
      status: 'confirmed',
      checkout_details: { version: 2, persons: [{ person_no: 1, mode: 'hourly' }] }
    }
  });
  await prisma.bookingPerson.create({
    data: { booking_ref: refA, person_no: 1, seat_code: 'A1', status: 'active' }
  });

  const now = new Date();
  const createPay = (overrides) => prisma.payment.create({
    data: {
      payment_no: `R36-I4-${Math.random().toString(36).slice(2, 8)}`,
      batch_no: `B-${runId}`,
      booking_ref: refA,
      kind: 'charge',
      status: 'valid',
      method: 'cash',
      amount: 500,
      person_nos: [1],
      breakdown_json: {},
      staff_name: adminUser.name,
      device_label: 'R36測試台',
      created_at: now,
      ...overrides
    }
  });

  // Cash 500, LINE Pay 300, Cash Refund 100, Pass 800, Void 200
  await createPay({ method: 'cash', amount: 500, kind: 'charge' });
  await createPay({ method: 'line_pay', amount: 300, kind: 'charge' });
  await createPay({ method: 'cash', amount: 100, kind: 'refund', reason: '部分退款' });
  await createPay({ method: 'pass', amount: 800, kind: 'charge' });
  await createPay({ method: 'cash', amount: 200, kind: 'charge', status: 'voided', void_reason: '打錯金額' });

  // 1. Future date rejected with 422 on both preview and submit
  const futurePrevRes = await fetch(`${srv.baseUrl}/api/accounting/closing/preview?date=${tomorrowStr}`, { headers });
  assert.equal(futurePrevRes.status, 422);
  const futurePostRes = await fetch(`${srv.baseUrl}/api/accounting/closing`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ date: tomorrowStr, float_amount: 2000, counted_cash: 2000, print: false })
  });
  assert.equal(futurePostRes.status, 422);

  // 2. Omit float_amount -> uses GlobalSetting 2000, expected_cash = 2000 + 500 - 100 = 2400; short 50 -> event.reason = '少找'
  const closeRes = await fetch(`${srv.baseUrl}/api/accounting/closing`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      date: todayStr,
      counted_cash: 2350,
      handed_over_amount: 350,
      note: '少找',
      print: true
    })
  });
  assert.equal(closeRes.status, 200);
  const closeBody = await closeRes.json();
  assert.equal(closeBody.success, true);
  const closing = closeBody.closing;
  createdClosingIds.push(closing.id);

  assert.equal(closing.float_amount, 2000);
  assert.equal(closing.expected_cash, 2400);
  assert.equal(closing.counted_cash, 2350);
  assert.equal(closing.difference, -50);

  assert.equal(closing.totals_json.by_method.cash.amount, 500);
  // Round 44 Item 2: legacy line_pay and canonical linepay merge under normalized key 'linepay'
  assert.equal(closing.totals_json.by_method.linepay.amount, 300);
  assert.equal(closing.totals_json.by_method.line_pay, undefined);
  assert.equal(closing.totals_json.refund_amount, 100);
  assert.equal(closing.totals_json.pass_amount, 800);
  assert.equal(closing.totals_json.actual_received, 700);
  assert.equal(closing.totals_json.shop_cash_income, 0);

  // PrintJob commands_json contains 700
  const printJob = closeBody.print_job;
  assert.ok(printJob, 'should create PrintJob for closing');
  const slipText = (printJob.commands_json || []).map(c => c.text || '').join('\n');
  assert.ok(slipText.includes('NT$700'), `expected slip to include NT$700, got:\n${slipText}`);

  // AccountingEvent for day_closed has reason === '少找'
  const evt = await prisma.accountingEvent.findFirst({
    where: { event_type: 'day_closed', staff_name: adminUser.name },
    orderBy: { id: 'desc' }
  });
  assert.ok(evt);
  assert.equal(evt.reason, '少找');
});
