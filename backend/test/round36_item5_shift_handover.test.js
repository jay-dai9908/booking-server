import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import express from 'express';
import cookieParser from 'cookie-parser';
import prisma from '../src/prismaClient.js';
import authRoutes from '../src/routes/auth.js';
import billingRoutes from '../src/routes/billing.js';
import accountingRoutes from '../src/routes/accounting.js';
import { ensureTestPublishedLayout, cleanupTestPublishedLayout } from './helpers/seedTestLayout.js';
import { dateOnly, toTaipeiDateString } from '../../shared/time.js';

function startLocalApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/auth', authRoutes);
  app.use('/api/billing', billingRoutes);
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

test('Round 36 Item 5: mid-shift handover computes [last_end, now] interval, carries left_in_drawer float, ignores overridden float_amount, validates handed_over_amount, handles legacy closing, and locks void by period_end_at', async (t) => {
  const runId = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const todayStr = toTaipeiDateString(new Date());
  const yestStr = toTaipeiDateString(new Date(Date.now() - 24 * 60 * 60 * 1000));
  const twoDaysAgoStr = toTaipeiDateString(new Date(Date.now() - 2 * 24 * 60 * 60 * 1000));
  const futureDate = dateOnly('2099-11-14');
  const refA = `R36-I5-A-${runId}`;

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
      line_user_id: `r36_i5_user_${runId}`,
      name: 'R36中途交班客',
      phone: `09965${String(Date.now()).slice(-5)}` // check-secrets: fake-data
    }
  });
  const adminPass = `r36_i5_adm_${runId}`;
  adminUser = await prisma.adminUser.create({
    data: {
      password: adminPass,
      name: `R36中途店員_${runId}`,
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

  const makePay = (amount, createdAtIso) => prisma.payment.create({
    data: {
      payment_no: `R36-I5-${Math.random().toString(36).slice(2, 8)}`,
      batch_no: `B-${runId}-${Math.random().toString(36).slice(2, 7)}`,
      booking_ref: refA,
      kind: 'charge',
      status: 'valid',
      method: 'cash',
      amount,
      person_nos: [1],
      breakdown_json: {},
      staff_name: adminUser.name,
      device_label: 'R36交班台',
      created_at: new Date(createdAtIso)
    }
  });

  // --- Group 1: today shifts (10:00 +300 -> 13:00 close, handed 300 -> left 2000; 15:00 +200 -> 21:00 close -> expected 2200) ---
  await makePay(300, `${todayStr}T10:00:00+08:00`);
  const pay1230 = await makePay(0, `${todayStr}T12:30:00+08:00`); // create a 100 payment below for void check
  await prisma.payment.update({ where: { id: pay1230.id }, data: { amount: 100 } });
  // Fix 10:00 + 12:30 -> wait let's keep 10:00=300 and test void on pay1230 after Group 1 or include it cleanly!
  // Let's keep 10:00=200 + 12:30=100 = 300 so expected_cash is 2300!
  const pay1000 = await prisma.payment.findFirst({ where: { booking_ref: refA, amount: 300 } });
  await prisma.payment.update({ where: { id: pay1000.id }, data: { amount: 200 } });

  const close1300Res = await fetch(`${srv.baseUrl}/api/accounting/closing`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      date: todayStr,
      now: `${todayStr}T13:00:00+08:00`,
      float_amount: 2000,
      counted_cash: 2300,
      handed_over_amount: 300,
      print: true
    })
  });
  assert.equal(close1300Res.status, 200);
  const close1300Body = await close1300Res.json();
  createdClosingIds.push(close1300Body.closing.id);
  assert.equal(close1300Body.closing.expected_cash, 2300);
  assert.equal(close1300Body.closing.left_in_drawer, 2000);
  const slip1Text = (close1300Body.print_job?.commands_json || []).map(c => c.text || '').join('\n');
  assert.ok(slip1Text.includes('交班單') && slip1Text.includes('00:00～13:00'));
  assert.ok(slip1Text.includes('交出金額') && slip1Text.includes('留在抽屜'));

  // Case 8 check: void 12:30 payment -> 409 VOID_LOCKED; create 14:00 payment -> wait first check void on 12:30 (since period_end_at was 13:00)!
  // Note: void needs shiftLockAt for real `new Date()` date (todayStr === today)! Wait 13:00 close has business_date = todayStr & period_end_at = todayStr 13:00!
  // Create 14:00 payment only if 14:00 is AFTER 13:00, and check if current wall clock is after 13:00 -> if running test earlier than 13:00, skip wall-clock check? Wait 14:00 vs 13:00 comparison doesn't depend on wall clock, only payDateStr === todayStr && payment.created_at > shiftLockAt!
  const pay1400 = await makePay(200, `${todayStr}T14:00:00+08:00`);
  const pay1500 = await makePay(200, `${todayStr}T15:00:00+08:00`);

  const void1230Res = await fetch(`${srv.baseUrl}/api/billing/payments/${pay1230.id}/void`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ reason: '13點交班前的收款應被鎖定' })
  });
  assert.equal(void1230Res.status, 409);

  // Void pay1400 (14:00 > 13:00 lock) -> 200 (so pay1400 becomes voided and doesn't affect 21:00 shift cash!)
  const void1400Res = await fetch(`${srv.baseUrl}/api/billing/payments/${pay1400.id}/void`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ reason: '14點在交班後可作廢' })
  });
  assert.equal(void1400Res.status, 200);

  // Case 4 & Case 5: handed_over_amount 2400 > counted 2300 -> 422; passing float_amount: 5000 on 2nd shift -> ignored!
  const badHandedRes = await fetch(`${srv.baseUrl}/api/accounting/closing`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      date: todayStr,
      now: `${todayStr}T21:00:00+08:00`,
      float_amount: 5000,
      counted_cash: 2300,
      handed_over_amount: 2400,
      note: '測試超額交出',
      print: false
    })
  });
  assert.equal(badHandedRes.status, 422);

  // Case 2 & Case 4: 15:00 cash 200 -> 21:00 close, float_amount: 5000 sent in body is IGNORED, uses 2000 from 13:00 -> expected 2200!
  const prev2100Res = await fetch(`${srv.baseUrl}/api/accounting/closing/preview?date=${todayStr}&now=${encodeURIComponent(`${todayStr}T21:00:00+08:00`)}`, { headers });
  const prev2100 = await prev2100Res.json();
  assert.equal(prev2100.float_amount, 2000);
  assert.equal(prev2100.float_source, 'previous_shift');
  assert.equal(prev2100.cash_income, 200);
  assert.equal(prev2100.expected_cash, 2200);

  const close2100Res = await fetch(`${srv.baseUrl}/api/accounting/closing`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      date: todayStr,
      now: `${todayStr}T21:00:00+08:00`,
      float_amount: 5000,
      counted_cash: 2200,
      handed_over_amount: 200,
      print: false
    })
  });
  assert.equal(close2100Res.status, 200);
  const close2100Body = await close2100Res.json();
  createdClosingIds.push(close2100Body.closing.id);
  assert.equal(close2100Body.closing.float_amount, 2000);
  assert.equal(close2100Body.closing.expected_cash, 2200);
  assert.equal(close2100Body.closing.totals_json.cash_income, 200);
  assert.equal(close2100Body.closing.totals_json.period.start_at, new Date(`${todayStr}T13:00:00+08:00`).toISOString());

  // Case 6: 21:01 immediately close again -> cash_income 0, expected_cash 2000
  const close2101Res = await fetch(`${srv.baseUrl}/api/accounting/closing`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      date: todayStr,
      now: `${todayStr}T21:01:00+08:00`,
      counted_cash: 2000,
      handed_over_amount: 0,
      print: false
    })
  });
  assert.equal(close2101Res.status, 200);
  const close2101Body = await close2101Res.json();
  createdClosingIds.push(close2101Body.closing.id);
  assert.equal(close2101Body.closing.totals_json.cash_income, 0);
  assert.equal(close2101Body.closing.expected_cash, 2000);

  // --- Group 2 (yesterday): Case 3 (handed_over_amount 0 -> left_in_drawer 2300 -> 15:00 +200 -> expected 2500) ---
  await makePay(300, `${yestStr}T10:00:00+08:00`);
  const yClose1Res = await fetch(`${srv.baseUrl}/api/accounting/closing`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      date: yestStr,
      float_amount: 2000,
      counted_cash: 2300,
      handed_over_amount: 0,
      print: false
    })
  });
  assert.equal(yClose1Res.status, 200);
  const yClose1 = (await yClose1Res.json()).closing;
  createdClosingIds.push(yClose1.id);
  assert.equal(yClose1.left_in_drawer, 2300);

  // Move yClose1 period_end_at/created_at to 13:00 yesterday and add 15:00 yesterday payment 200
  const yEnd13 = new Date(`${yestStr}T13:00:00+08:00`);
  await prisma.cashClosing.update({
    where: { id: yClose1.id },
    data: { period_end_at: yEnd13, created_at: yEnd13 }
  });
  await makePay(200, `${yestStr}T15:00:00+08:00`);

  const yPrevRes = await fetch(`${srv.baseUrl}/api/accounting/closing/preview?date=${yestStr}`, { headers });
  const yPrev = await yPrevRes.json();
  assert.equal(yPrev.float_amount, 2300);
  assert.equal(yPrev.cash_income, 200);
  assert.equal(yPrev.expected_cash, 2500);

  // --- Group 3 (2 days ago): Case 7 Legacy closing (null period/drawer columns, created_at 12:00) -> preview starts 12:00, float uses setting ---
  const legacyNoon = new Date(`${twoDaysAgoStr}T12:00:00+08:00`);
  const legacyClosing = await prisma.cashClosing.create({
    data: {
      business_date: dateOnly(twoDaysAgoStr),
      float_amount: 2000,
      expected_cash: 2100,
      counted_cash: 2100,
      difference: 0,
      totals_json: {},
      staff_name: '舊系統店員',
      device_label: '舊櫃檯',
      created_at: legacyNoon
    }
  });
  createdClosingIds.push(legacyClosing.id);
  await makePay(400, `${twoDaysAgoStr}T10:00:00+08:00`); // before 12:00 -> excluded!
  await makePay(150, `${twoDaysAgoStr}T14:00:00+08:00`); // after 12:00 -> included!

  const legacyPrevRes = await fetch(`${srv.baseUrl}/api/accounting/closing/preview?date=${twoDaysAgoStr}`, { headers });
  const legacyPrev = await legacyPrevRes.json();
  assert.equal(legacyPrev.period_start_at, legacyNoon.toISOString());
  assert.equal(legacyPrev.float_source, 'setting');
  assert.equal(legacyPrev.float_amount, 2000);
  assert.equal(legacyPrev.cash_income, 150);
  assert.equal(legacyPrev.expected_cash, 2150);

  void pay1500;
});
