import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import express from 'express';
import cookieParser from 'cookie-parser';
import prisma from '../src/prismaClient.js';
import authRoutes from '../src/routes/auth.js';
import billingRoutes from '../src/routes/billing.js';
import accountingRoutes from '../src/routes/accounting.js';
import { collectPayment, getBookingBill } from '../src/services/billing/billService.js';
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

test('Round 36 Item 2: cross-day/closed-shift void & mark-unpaid lock, pass void allowed, and cross-day refund shifts net cash/revenue to today', async (t) => {
  const runId = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const futureDate = dateOnly('2099-11-11');
  const todayStr = toTaipeiDateString(new Date());
  const todayDate = dateOnly(todayStr);
  const yesterdayDate = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const yesterdayStr = toTaipeiDateString(yesterdayDate);

  const refYesterdayCash = `R36-I2-YC-${runId}`;
  const refTodayShift = `R36-I2-TS-${runId}`;
  const refYesterdayPass = `R36-I2-YP-${runId}`;
  const refCrossRefund = `R36-I2-CR-${runId}`;
  const createdRefs = [refYesterdayCash, refTodayShift, refYesterdayPass, refCrossRefund];

  let srv = null;
  let user = null;
  let adminUser = null;
  let session = null;
  let dailySetting = 'existing';
  let plan = null;
  let pass1 = null;
  let createdLayoutId = null;
  let createdClosingId = null;
  const createdEventIds = [];

  t.after(async () => {
    if (srv) await srv.close().catch(() => {});
    await prisma.printJob.deleteMany({ where: { booking_ref: { in: createdRefs } } }).catch(() => {});
    if (createdClosingId) {
      await prisma.printJob.deleteMany({ where: { closing_id: createdClosingId } }).catch(() => {});
      await prisma.cashClosing.delete({ where: { id: createdClosingId } }).catch(() => {});
    }
    await prisma.payment.deleteMany({ where: { booking_ref: { in: createdRefs } } }).catch(() => {});
    await prisma.bookingPerson.deleteMany({ where: { booking_ref: { in: createdRefs } } }).catch(() => {});
    await prisma.reservation.deleteMany({ where: { booking_ref: { in: createdRefs } } }).catch(() => {});
    if (pass1?.id) {
      await prisma.userPass.delete({ where: { id: pass1.id } }).catch(() => {});
    }
    if (plan?.id) await prisma.passPlan.delete({ where: { id: plan.id } }).catch(() => {});
    if (session?.id) await prisma.session.delete({ where: { id: session.id } }).catch(() => {});
    if (dailySetting === 'created') await prisma.dailySetting.delete({ where: { date: futureDate } }).catch(() => {});
    if (user?.id) await prisma.user.delete({ where: { id: user.id } }).catch(() => {});
    if (adminUser?.id) await prisma.adminUser.delete({ where: { id: adminUser.id } }).catch(() => {});
    await cleanupTestPublishedLayout(prisma, createdLayoutId);
    // Note: AccountingEvent is append-only (guarded by trigger); unique runId keeps test isolated cleanly.
    void createdEventIds;
  });

  createdLayoutId = await ensureTestPublishedLayout(prisma);
  srv = await startLocalApp();

  user = await prisma.user.create({
    data: {
      line_user_id: `r36_i2_user_${runId}`,
      name: 'R36跨日鎖定客',
      phone: `09962${String(Date.now()).slice(-5)}` // check-secrets: fake-data
    }
  });
  const adminPass = `r36_i2_adm_${runId}`;
  adminUser = await prisma.adminUser.create({
    data: {
      password: adminPass,
      name: `R36鎖定店長_${runId}`,
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
  const staffUser = { id: adminUser.id, name: adminUser.name };
  const deviceInfo = { device_id: 'dev-r36-i2', device_label: 'R36鎖定台' };

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

  plan = await prisma.passPlan.create({
    data: {
      code: `R36_I2_${runId}`,
      name: 'R36計次卡',
      pass_type: 'PUNCH_CARD',
      price: 500,
      total_quota: 5,
      valid_days: 90,
      checkout_effect: 'entry_full',
      checkout_scope: 'entry'
    }
  });

  pass1 = await prisma.userPass.create({
    data: {
      user_id: user.id,
      plan_id: plan.id,
      pass_code: `R36P2-${runId}`,
      plan_name_snapshot: plan.name,
      pass_type: 'PUNCH_CARD',
      total_quota: 5,
      remaining_quota: 3,
      payment_status: 'active',
      status: 'ACTIVE',
      expires_at: dateOnly('2099-12-31')
    }
  });

  for (const ref of createdRefs) {
    await prisma.reservation.create({
      data: {
        booking_ref: ref,
        user_id: user.id,
        session_id: session.id,
        pax: 1,
        assigned_seats: ['A1'],
        status: 'confirmed',
        checkout_details: { version: 2, persons: [{ person_no: 1, mode: 'hourly' }] }
      }
    });
    await prisma.bookingPerson.create({
      data: { booking_ref: ref, person_no: 1, seat_code: 'A1', status: 'active' }
    });
  }

  // Case 1: Yesterday's cash payment -> void returns 409 VOID_LOCKED; mark-unpaid returns 409 VOID_LOCKED; getBookingBill shows can_void = false
  const colYC = await collectPayment(refYesterdayCash, { person_nos: [1], method: 'cash', print: false }, staffUser, deviceInfo);
  const payYC = colYC.payments[0];
  await prisma.payment.update({ where: { id: payYC.id }, data: { created_at: yesterdayDate } });

  const billYC = await getBookingBill(refYesterdayCash);
  const billPayYC = billYC.payments.find((p) => p.id === payYC.id);
  assert.equal(billPayYC.can_void, false);

  const voidYCRes = await fetch(`${srv.baseUrl}/api/billing/payments/${payYC.id}/void`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ reason: '嘗試作廢昨日收款' })
  });
  assert.equal(voidYCRes.status, 409);
  const voidYCBody = await voidYCRes.json();
  assert.equal(voidYCBody.code, 'VOID_LOCKED');

  const markUnpaidRes = await fetch(`${srv.baseUrl}/api/billing/${refYesterdayCash}/mark-unpaid`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ reason: '嘗試改未付昨日收款' })
  });
  assert.equal(markUnpaidRes.status, 409);
  const markUnpaidBody = await markUnpaidRes.json();
  assert.equal(markUnpaidBody.code, 'VOID_LOCKED');

  // Verify /api/accounting/payments attaches can_void: false for yesterday payment
  const listYCRes = await fetch(`${srv.baseUrl}/api/accounting/payments?date_from=${yesterdayStr}&date_to=${yesterdayStr}&q=${refYesterdayCash}`, {
    headers: { Authorization: `Bearer ${adminToken}` }
  });
  assert.equal(listYCRes.status, 200);
  const listYCBody = await listYCRes.json();
  const listedYC = listYCBody.payments.find((p) => p.id === payYC.id);
  assert.equal(listedYC.can_void, false);

  // Case 2: Today's payment before vs after CashClosing
  const colTSBefore = await collectPayment(refTodayShift, { person_nos: [1], method: 'cash', print: false }, staffUser, deviceInfo);
  const payTSBefore = colTSBefore.payments[0];
  const earlyToday = new Date(Date.now() - 60 * 1000);
  await prisma.payment.update({ where: { id: payTSBefore.id }, data: { created_at: earlyToday } });

  const closingRow = await prisma.cashClosing.create({
    data: {
      business_date: todayDate,
      float_amount: 2000,
      expected_cash: 2500,
      counted_cash: 2500,
      difference: 0,
      totals_json: {},
      staff_name: adminUser.name,
      device_label: 'R36鎖定台',
      created_at: new Date(earlyToday.getTime() + 10 * 1000)
    }
  });
  createdClosingId = closingRow.id;

  const voidTSBeforeRes = await fetch(`${srv.baseUrl}/api/billing/payments/${payTSBefore.id}/void`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ reason: '交班前收款應被鎖定' })
  });
  assert.equal(voidTSBeforeRes.status, 409);
  assert.equal((await voidTSBeforeRes.json()).code, 'VOID_LOCKED');

  // Supplement after closing -> can_void is true and void succeeds
  const supAfterRes = await fetch(`${srv.baseUrl}/api/billing/${refTodayShift}/supplement`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ person_no: 1, items: [{ type: 'other', label: '交班後補收', amount: 100 }], method: 'cash', print: false })
  });
  assert.equal(supAfterRes.status, 200);
  const supAfterBody = await supAfterRes.json();
  const payTSAfter = supAfterBody.payment;
  await prisma.payment.update({
    where: { id: payTSAfter.id },
    data: { created_at: new Date(closingRow.created_at.getTime() + 10 * 1000) }
  });

  const billTS = await getBookingBill(refTodayShift);
  assert.equal(billTS.payments.find((p) => p.id === payTSAfter.id).can_void, true);

  const voidTSAfterRes = await fetch(`${srv.baseUrl}/api/billing/payments/${payTSAfter.id}/void`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ reason: '同班次作廢' })
  });
  assert.equal(voidTSAfterRes.status, 200);

  // Case 3: Yesterday's method === 'pass' payment CAN be voided and restores quota
  const colYP = await collectPayment(refYesterdayPass, {
    person_nos: [1],
    method: 'pass',
    pass_tenders: [{ user_pass_id: pass1.id, units: 1, person_no: 1 }],
    print: false
  }, staffUser, deviceInfo);
  const payYP = colYP.payments[0];
  await prisma.payment.update({ where: { id: payYP.id }, data: { created_at: yesterdayDate } });
  const passAfterCharge = await prisma.userPass.findUnique({ where: { id: pass1.id } });
  assert.equal(passAfterCharge.remaining_quota, 2);

  const voidYPRes = await fetch(`${srv.baseUrl}/api/billing/payments/${payYP.id}/void`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ reason: '昨日次卡退回額度' })
  });
  assert.equal(voidYPRes.status, 200);
  const passAfterVoid = await prisma.userPass.findUnique({ where: { id: pass1.id } });
  assert.equal(passAfterVoid.remaining_quota, 3);

  // Case 4: Cross-day refund: yesterday +500 cash, today -200 cash refund -> yesterday net_revenue retains +500; today summary records -200 cash refund & closing expected cash reflects refund -200
  const colCR = await collectPayment(refCrossRefund, { person_nos: [1], method: 'cash', print: false }, staffUser, deviceInfo);
  const payCR = colCR.payments[0];
  await prisma.payment.update({ where: { id: payCR.id }, data: { created_at: yesterdayDate } });

  // Measure baseline today & yesterday summaries right before today's 200 refund
  const [baseTodayRes, baseYestRes, basePreviewRes] = await Promise.all([
    fetch(`${srv.baseUrl}/api/accounting/summary?start_date=${todayStr}&end_date=${todayStr}`, { headers: { Authorization: `Bearer ${adminToken}` } }),
    fetch(`${srv.baseUrl}/api/accounting/summary?start_date=${yesterdayStr}&end_date=${yesterdayStr}`, { headers: { Authorization: `Bearer ${adminToken}` } }),
    fetch(`${srv.baseUrl}/api/accounting/closing/preview?date=${todayStr}`, { headers: { Authorization: `Bearer ${adminToken}` } })
  ]);
  const baseToday = await baseTodayRes.json();
  const baseYest = await baseYestRes.json();
  const basePreview = await basePreviewRes.json();

  const refundCRRes = await fetch(`${srv.baseUrl}/api/billing/${refCrossRefund}/refund`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ person_no: 1, amount: 200, method: 'cash', reason: '隔日退差額', print: false })
  });
  assert.equal(refundCRRes.status, 200);

  const [afterTodayRes, afterYestRes, afterPreviewRes] = await Promise.all([
    fetch(`${srv.baseUrl}/api/accounting/summary?start_date=${todayStr}&end_date=${todayStr}`, { headers: { Authorization: `Bearer ${adminToken}` } }),
    fetch(`${srv.baseUrl}/api/accounting/summary?start_date=${yesterdayStr}&end_date=${yesterdayStr}`, { headers: { Authorization: `Bearer ${adminToken}` } }),
    fetch(`${srv.baseUrl}/api/accounting/closing/preview?date=${todayStr}`, { headers: { Authorization: `Bearer ${adminToken}` } })
  ]);
  const afterToday = await afterTodayRes.json();
  const afterYest = await afterYestRes.json();
  const afterPreview = await afterPreviewRes.json();

  assert.equal(afterYest.net_revenue, baseYest.net_revenue);
  assert.equal((afterToday.refunds?.cash?.amount || 0) - (baseToday.refunds?.cash?.amount || 0), 200);
  assert.equal(afterToday.net_revenue - baseToday.net_revenue, -200);
  assert.equal((afterPreview.refunds?.cash?.amount || 0) - (basePreview.refunds?.cash?.amount || 0), 200);
  assert.equal(afterPreview.expected_cash - basePreview.expected_cash, -200);
});
