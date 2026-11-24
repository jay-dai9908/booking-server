import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import express from 'express';
import cookieParser from 'cookie-parser';
import prisma from '../src/prismaClient.js';
import authRoutes from '../src/routes/auth.js';
import billingRoutes from '../src/routes/billing.js';
import reservationRoutes from '../src/routes/reservations.js';
import { ensureTestPublishedLayout, cleanupTestPublishedLayout } from './helpers/seedTestLayout.js';
import { dateOnly } from '../../shared/time.js';

function startLocalApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/auth', authRoutes);
  app.use('/api/billing', billingRoutes);
  app.use('/api/reservations', reservationRoutes);
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

test('Round 35 Item 1: server pass-quote, getMemberPasses skip paid, expected_net_amount, cash change, and legacy PATCH payment', async (t) => {
  const runId = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const futureDate = dateOnly('2099-12-03');
  const ref1 = `R35-I1-A-${runId}`;
  const ref2 = `R35-I1-B-${runId}`;
  const createdRefs = [ref1, ref2];

  let srv = null;
  let user = null;
  let adminUser = null;
  let session = null;
  let dailySetting = null;
  let equip = null;
  let plan = null;
  let pass = null;
  let createdLayoutId = null;

  t.after(async () => {
    if (srv) await srv.close().catch(() => {});
    await prisma.printJob.deleteMany({ where: { booking_ref: { in: createdRefs } } }).catch(() => {});
    await prisma.payment.deleteMany({ where: { booking_ref: { in: createdRefs } } }).catch(() => {});
    await prisma.bookingEquipment.deleteMany({ where: { booking_ref: { in: createdRefs } } }).catch(() => {});
    await prisma.bookingPerson.deleteMany({ where: { booking_ref: { in: createdRefs } } }).catch(() => {});
    await prisma.reservation.deleteMany({ where: { booking_ref: { in: createdRefs } } }).catch(() => {});
    if (pass?.id) await prisma.userPass.delete({ where: { id: pass.id } }).catch(() => {});
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
      line_user_id: `r35_i1_user_${runId}`,
      name: 'R35卡券客',
      phone: `09951${String(Date.now()).slice(-5)}` // check-secrets: fake-data
    }
  });
  const adminPass = `r35_i1_adm_${runId}`;
  adminUser = await prisma.adminUser.create({
    data: {
      password: adminPass,
      name: `R35櫃檯_${runId}`,
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
      id: `r35_board_${runId}`,
      name: 'R35測試板',
      hourly_rate: 200,
      total_stock: 5,
      min_contiguous_hours: 1,
      visibility_status: 'ACTIVE'
    }
  });

  plan = await prisma.passPlan.create({
    data: {
      code: `R35_VISIT_${runId}`,
      name: '單次入場卡',
      pass_type: 'VISIT_PACK',
      price: 500,
      total_quota: 5,
      valid_days: 90,
      checkout_effect: 'entry_full',
      checkout_scope: 'entry'
    }
  });

  pass = await prisma.userPass.create({
    data: {
      user_id: user.id,
      plan_id: plan.id,
      pass_code: `R35P-${runId}`,
      plan_name_snapshot: plan.name,
      pass_type: 'VISIT_PACK',
      total_quota: 5,
      remaining_quota: 5,
      payment_status: 'active',
      status: 'ACTIVE',
      expires_at: dateOnly('2099-12-31')
    }
  });

  // Case 1: 1 pax unlimited entry 800 + board 200 = 1000
  await prisma.reservation.create({
    data: {
      booking_ref: ref1,
      user_id: user.id,
      session_id: session.id,
      pax: 1,
      assigned_seats: ['A1'],
      status: 'confirmed',
      is_unlimited: true,
      checkout_details: {
        version: 2,
        persons: [{ person_no: 1, mode: 'unlimited' }]
      }
    }
  });
  const bp1 = await prisma.bookingPerson.create({
    data: { booking_ref: ref1, person_no: 1, seat_code: 'A1', status: 'active' }
  });
  await prisma.bookingEquipment.create({
    data: {
      booking_ref: ref1,
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

  const passesRes = await fetch(`${srv.baseUrl}/api/billing/${ref1}/passes`, {
    headers: { Authorization: `Bearer ${adminToken}` }
  });
  assert.equal(passesRes.status, 200);
  const passesBody = await passesRes.json();
  const targetPass = passesBody.passes.find((p) => p.id === pass.id);
  assert.ok(targetPass);
  assert.equal(targetPass.suggest[0].value, 800);

  const quoteRes = await fetch(`${srv.baseUrl}/api/billing/${ref1}/pass-quote`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({
      person_nos: [1],
      pass_tenders: [{ user_pass_id: pass.id, person_no: 1, units: 1 }]
    })
  });
  assert.equal(quoteRes.status, 200);
  const quoteData = await quoteRes.json();
  assert.equal(quoteData.gross_due, 1000);
  assert.equal(quoteData.net_due, 200);
  assert.equal(quoteData.tenders[0].value, 800);

  // Stale expected_net_amount (e.g. 850 from old client bug) -> 409
  const staleCollect = await fetch(`${srv.baseUrl}/api/billing/${ref1}/collect`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({
      person_nos: [1],
      expected_amount: 1000,
      expected_net_amount: 850,
      method: 'cash',
      cash_received: 850,
      pass_tenders: [{ user_pass_id: pass.id, person_no: 1, units: 1 }],
      print: false
    })
  });
  assert.equal(staleCollect.status, 409);

  // Correct expected_net_amount 200 with cash_received 300 -> cash 200, change_given 100
  const okCollect = await fetch(`${srv.baseUrl}/api/billing/${ref1}/collect`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({
      person_nos: [1],
      expected_amount: 1000,
      expected_net_amount: 200,
      method: 'cash',
      cash_received: 300,
      pass_tenders: [{ user_pass_id: pass.id, person_no: 1, units: 1 }],
      print: false
    })
  });
  assert.equal(okCollect.status, 200);
  const okData = await okCollect.json();
  const cashPay = okData.payments.find((p) => p.method === 'cash');
  const passPay = okData.payments.find((p) => p.method === 'pass');
  assert.equal(cashPay.amount, 200);
  assert.equal(cashPay.change_given, 100);
  assert.equal(passPay.amount, 800);

  // Case 2: 2 pax booking, person 1 already paid -> getMemberPasses skips person 1, PATCH payment { is_paid: true } only collects person 2
  await prisma.reservation.create({
    data: {
      booking_ref: ref2,
      user_id: user.id,
      session_id: session.id,
      pax: 2,
      assigned_seats: ['A2', 'A3'],
      status: 'confirmed',
      checkout_details: { version: 2, persons: [{ person_no: 1, mode: 'hourly' }, { person_no: 2, mode: 'hourly' }] }
    }
  });
  await prisma.bookingPerson.createMany({
    data: [
      { booking_ref: ref2, person_no: 1, seat_code: 'A2', status: 'active' },
      { booking_ref: ref2, person_no: 2, seat_code: 'A3', status: 'active' }
    ]
  });

  const payP1 = await fetch(`${srv.baseUrl}/api/billing/${ref2}/collect`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ person_nos: [1], method: 'cash', print: false })
  });
  assert.equal(payP1.status, 200);

  const passes2Res = await fetch(`${srv.baseUrl}/api/billing/${ref2}/passes`, {
    headers: { Authorization: `Bearer ${adminToken}` }
  });
  assert.equal(passes2Res.status, 200);
  const passes2Data = await passes2Res.json();
  const suggestPersonNos = passes2Data.passes[0].suggest.map((s) => s.person_no);
  assert.deepEqual(suggestPersonNos, [2]);

  const legacyPatchRes = await fetch(`${srv.baseUrl}/api/reservations/admin/${ref2}/payment`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ is_paid: true, payment_method: 'cash' })
  });
  assert.equal(legacyPatchRes.status, 200);
});
