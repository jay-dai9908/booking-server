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

test('Round 35 Item 3: per-person pass refund excludes pass from cash limit, blocks duplicates/cross-person, and excludes pass refunds from net revenue', async (t) => {
  const runId = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const futureDate = dateOnly('2099-12-15');
  const todayStr = toTaipeiDateString(new Date());
  const ref = `R35-I3-${runId}`;
  const createdRefs = [ref];

  let srv = null;
  let user = null;
  let adminUser = null;
  let session = null;
  let dailySetting = null;
  let equip = null;
  let plan = null;
  let pass1 = null;
  let pass2 = null;
  let createdLayoutId = null;

  t.after(async () => {
    if (srv) await srv.close().catch(() => {});
    await prisma.printJob.deleteMany({ where: { booking_ref: { in: createdRefs } } }).catch(() => {});
    await prisma.payment.deleteMany({ where: { booking_ref: { in: createdRefs } } }).catch(() => {});
    await prisma.bookingEquipment.deleteMany({ where: { booking_ref: { in: createdRefs } } }).catch(() => {});
    await prisma.bookingPerson.deleteMany({ where: { booking_ref: { in: createdRefs } } }).catch(() => {});
    await prisma.reservation.deleteMany({ where: { booking_ref: { in: createdRefs } } }).catch(() => {});
    if (pass1?.id) await prisma.userPass.delete({ where: { id: pass1.id } }).catch(() => {});
    if (pass2?.id) await prisma.userPass.delete({ where: { id: pass2.id } }).catch(() => {});
    if (plan?.id) await prisma.passPlan.delete({ where: { id: plan.id } }).catch(() => {});
    if (equip?.id) await prisma.equipmentConfig.delete({ where: { id: equip.id } }).catch(() => {});
    if (session?.id) await prisma.session.delete({ where: { id: session.id } }).catch(() => {});
    if (dailySetting) await prisma.dailySetting.delete({ where: { date: futureDate } }).catch(() => {});
    if (user?.id) await prisma.user.delete({ where: { id: user.id } }).catch(() => {});
    if (adminUser?.id) await prisma.adminUser.delete({ where: { id: adminUser.id } }).catch(() => {});
    await cleanupTestPublishedLayout(prisma, createdLayoutId);
  });

  createdLayoutId = await ensureTestPublishedLayout(prisma);
  srv = await startLocalApp();

  user = await prisma.user.create({
    data: {
      line_user_id: `r35_i3_user_${runId}`,
      name: 'R35退卡客',
      phone: `09953${String(Date.now()).slice(-5)}` // check-secrets: fake-data
    }
  });
  const adminPass = `r35_i3_adm_${runId}`;
  adminUser = await prisma.adminUser.create({
    data: {
      password: adminPass,
      name: `R35退卡櫃檯_${runId}`,
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

  dailySetting = await prisma.dailySetting.upsert({
    where: { date: futureDate },
    update: { hourly_price: 150, unlimited_price: 800, allow_unlimited: true, is_self_service: false },
    create: { date: futureDate, hourly_price: 150, unlimited_price: 800, allow_unlimited: true, is_self_service: false }
  });

  session = await prisma.session.create({
    data: { session_date: futureDate, start_time: '14:00', end_time: '15:00', max_capacity: 16 }
  });

  equip = await prisma.equipmentConfig.create({
    data: {
      id: `r35_i3_eq_${runId}`,
      name: 'R35大板',
      hourly_rate: 200,
      total_stock: 5,
      min_contiguous_hours: 1,
      visibility_status: 'ACTIVE'
    }
  });

  plan = await prisma.passPlan.create({
    data: {
      code: `R35_I3_${runId}`,
      name: '計次不限時卡',
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
      pass_code: `R35P3A-${runId}`,
      plan_name_snapshot: plan.name,
      pass_type: 'PUNCH_CARD',
      total_quota: 5,
      remaining_quota: 3,
      payment_status: 'active',
      status: 'ACTIVE',
      expires_at: dateOnly('2099-12-31')
    }
  });

  pass2 = await prisma.userPass.create({
    data: {
      user_id: user.id,
      plan_id: plan.id,
      pass_code: `R35P3B-${runId}`,
      plan_name_snapshot: plan.name,
      pass_type: 'PUNCH_CARD',
      total_quota: 5,
      remaining_quota: 3,
      payment_status: 'active',
      status: 'ACTIVE',
      expires_at: dateOnly('2099-12-31')
    }
  });

  await prisma.reservation.create({
    data: {
      booking_ref: ref,
      user_id: user.id,
      session_id: session.id,
      pax: 2,
      assigned_seats: ['A1', 'A2'],
      status: 'confirmed',
      is_unlimited: true,
      checkout_details: {
        version: 2,
        persons: [{ person_no: 1, mode: 'unlimited' }, { person_no: 2, mode: 'unlimited' }]
      }
    }
  });
  const bp1 = await prisma.bookingPerson.create({
    data: { booking_ref: ref, person_no: 1, seat_code: 'A1', status: 'active' }
  });
  await prisma.bookingPerson.create({
    data: { booking_ref: ref, person_no: 2, seat_code: 'A2', status: 'active' }
  });
  await prisma.bookingEquipment.create({
    data: {
      booking_ref: ref,
      equipment_id: equip.id,
      equipment_name_snapshot: equip.name,
      quantity: 1,
      rental_hours: 1,
      unit_rate: 200,
      subtotal_price: 200,
      person_id: bp1.id,
      covered_sessions: ['14:00-15:00']
    }
  });

  // Collect person 1: cash 200 + pass1 800
  const col1 = await fetch(`${srv.baseUrl}/api/billing/${ref}/collect`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({
      person_nos: [1],
      method: 'cash',
      pass_tenders: [{ user_pass_id: pass1.id, person_no: 1, units: 1 }],
      print: false
    })
  });
  assert.equal(col1.status, 200);
  const col1Body = await col1.json();
  const p1PassPay = col1Body.payments.find((p) => p.method === 'pass');
  assert.equal(p1PassPay.amount, 800);

  // Also collect person 2 using pass2 (pass 800) so person 2 has their own pass
  const col2 = await fetch(`${srv.baseUrl}/api/billing/${ref}/collect`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({
      person_nos: [2],
      method: 'cash',
      pass_tenders: [{ user_pass_id: pass2.id, person_no: 2, units: 1 }],
      print: false
    })
  });
  assert.equal(col2.status, 200);

  // 1. Trying to refund 300 cash for person 1 -> 400 (max cash refundable is 200, pass 800 excluded)
  const overCashRefund = await fetch(`${srv.baseUrl}/api/billing/${ref}/refund`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({
      person_no: 1,
      amount: 300,
      method: 'cash',
      reason: '測試超退現金',
      print: false
    })
  });
  assert.equal(overCashRefund.status, 400);

  // 2. Trying to refund person 1's pass as person 2 -> 422
  const crossPersonRefund = await fetch(`${srv.baseUrl}/api/billing/${ref}/refund`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({
      person_no: 2,
      amount: 800,
      method: 'pass',
      payment_id: p1PassPay.id,
      reason: '跨人錯退',
      print: false
    })
  });
  assert.equal(crossPersonRefund.status, 422);

  // 3. Refund person 1's pass -> 200, pass1 quota restored 2 -> 3, related_payment_id matches p1PassPay.id
  const okPassRefund = await fetch(`${srv.baseUrl}/api/billing/${ref}/refund`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({
      person_no: 1,
      amount: 0,
      method: 'pass',
      payment_id: p1PassPay.id,
      reason: '退還第 1 位卡券',
      print: false
    })
  });
  assert.equal(okPassRefund.status, 200);
  const okRefundBody = await okPassRefund.json();
  assert.equal(okRefundBody.payment.related_payment_id, p1PassPay.id);
  assert.equal(okRefundBody.payment.amount, 800);

  const pass1After = await prisma.userPass.findUnique({ where: { id: pass1.id } });
  const pass2After = await prisma.userPass.findUnique({ where: { id: pass2.id } });
  assert.equal(pass1After.remaining_quota, 3);
  assert.equal(pass2After.remaining_quota, 2);

  // 4. Repeat refund of the same pass payment -> 409, quota unchanged
  const dupPassRefund = await fetch(`${srv.baseUrl}/api/billing/${ref}/refund`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({
      person_no: 1,
      amount: 800,
      method: 'pass',
      payment_id: p1PassPay.id,
      reason: '重複退',
      print: false
    })
  });
  assert.equal(dupPassRefund.status, 409);
  const pass1AfterDup = await prisma.userPass.findUnique({ where: { id: pass1.id } });
  assert.equal(pass1AfterDup.remaining_quota, 3);

  // 5. Accounting summary: cash 200 collected, pass refund 800 -> net_revenue 200, total_refunds 0, pass_refunds.amount 800
  const sumRes = await fetch(`${srv.baseUrl}/api/accounting/summary?start_date=${todayStr}&end_date=${todayStr}`, {
    headers: { Authorization: `Bearer ${adminToken}` }
  });
  assert.equal(sumRes.status, 200);
  const sumData = await sumRes.json();
  assert.equal(sumData.net_revenue, 200);
  assert.equal(sumData.total_refunds, 0);
  assert.equal(sumData.pass_refunds.count, 1);
  assert.equal(sumData.pass_refunds.amount, 800);
});
