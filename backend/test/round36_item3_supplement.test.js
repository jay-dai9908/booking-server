import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import express from 'express';
import cookieParser from 'cookie-parser';
import prisma from '../src/prismaClient.js';
import authRoutes from '../src/routes/auth.js';
import billingRoutes from '../src/routes/billing.js';
import { collectPayment, getBookingBill } from '../src/services/billing/billService.js';
import { ensureTestPublishedLayout, cleanupTestPublishedLayout } from './helpers/seedTestLayout.js';
import { dateOnly } from '../../shared/time.js';

function startLocalApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/auth', authRoutes);
  app.use('/api/billing', billingRoutes);
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

test('Round 36 Item 3: supplement & refund client_batch_id idempotency, server-trusted prices, pending deduction, and cash validation/change', async (t) => {
  const runId = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const futureDate = dateOnly('2099-11-12');
  const refA = `R36-I3-A-${runId}`;
  const refB = `R36-I3-B-${runId}`;
  const createdRefs = [refA, refB];

  let srv = null;
  let user = null;
  let adminUser = null;
  let session = null;
  let dailySetting = 'existing';
  let activeAddon = null;
  let inactiveAddon = null;
  let createdLayoutId = null;

  t.after(async () => {
    if (srv) await srv.close().catch(() => {});
    await prisma.printJob.deleteMany({ where: { booking_ref: { in: createdRefs } } }).catch(() => {});
    await prisma.payment.deleteMany({ where: { booking_ref: { in: createdRefs } } }).catch(() => {});
    await prisma.bookingPerson.deleteMany({ where: { booking_ref: { in: createdRefs } } }).catch(() => {});
    await prisma.reservation.deleteMany({ where: { booking_ref: { in: createdRefs } } }).catch(() => {});
    if (activeAddon?.id) await prisma.addonItem.delete({ where: { id: activeAddon.id } }).catch(() => {});
    if (inactiveAddon?.id) await prisma.addonItem.delete({ where: { id: inactiveAddon.id } }).catch(() => {});
    if (session?.id) await prisma.session.delete({ where: { id: session.id } }).catch(() => {});
    if (dailySetting === 'created') await prisma.dailySetting.delete({ where: { date: futureDate } }).catch(() => {});
    if (user?.id) await prisma.user.delete({ where: { id: user.id } }).catch(() => {});
    if (adminUser?.id) await prisma.adminUser.delete({ where: { id: adminUser.id } }).catch(() => {});
    await cleanupTestPublishedLayout(prisma, createdLayoutId);
  });

  createdLayoutId = await ensureTestPublishedLayout(prisma);
  srv = await startLocalApp();

  user = await prisma.user.create({
    data: {
      line_user_id: `r36_i3_user_${runId}`,
      name: 'R36補收客',
      phone: `09963${String(Date.now()).slice(-5)}` // check-secrets: fake-data
    }
  });
  const adminPass = `r36_i3_adm_${runId}`;
  adminUser = await prisma.adminUser.create({
    data: {
      password: adminPass,
      name: `R36補收店長_${runId}`,
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
  const deviceInfo = { device_id: 'dev-r36-i3', device_label: 'R36補收台' };

  const existingDaily = await prisma.dailySetting.findUnique({ where: { date: futureDate } });
  if (!existingDaily) {
    await prisma.dailySetting.create({
      data: { date: futureDate, hourly_price: 200, unlimited_price: 900, allow_unlimited: true, is_self_service: false }
    });
    dailySetting = 'created';
  }

  session = await prisma.session.create({
    data: { session_date: futureDate, start_time: '13:00', end_time: '15:00', max_capacity: 20 }
  });

  activeAddon = await prisma.addonItem.create({
    data: { name: `R36加購50_${runId}`, price: 50, category: 'charm', is_active: true, sort_order: 99 }
  });
  inactiveAddon = await prisma.addonItem.create({
    data: { name: `R36停用品_${runId}`, price: 70, category: 'charm', is_active: false, sort_order: 100 }
  });

  // Booking A: person 1 pays 400 first, then order_addon (120) is added after payment (person 1 only -> pending_supplement = 120)
  await prisma.reservation.create({
    data: {
      booking_ref: refA,
      user_id: user.id,
      session_id: session.id,
      pax: 1,
      assigned_seats: ['A1'],
      status: 'confirmed',
      checkout_details: {
        version: 2,
        persons: [{ person_no: 1, mode: 'hourly' }],
        order_addons: [
          { key: 'post_120', name: '補掛手工材', price: 120, qty: 1, added_after_payment: true, include_paid: true, split: { mode: 'even' } }
        ]
      }
    }
  });
  await prisma.bookingPerson.create({
    data: { booking_ref: refA, person_no: 1, seat_code: 'A1', status: 'active' }
  });

  await collectPayment(refA, { person_nos: [1], method: 'cash', print: false }, staffUser, deviceInfo);

  // Verify initial pending_supplement === 120
  const billA0 = await getBookingBill(refA);
  assert.equal(billA0.bill.persons[0].pending_supplement, 120);

  // 1. cash_received < amount (100 < 120) -> 400
  const shortCashRes = await fetch(`${srv.baseUrl}/api/billing/${refA}/supplement`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      client_batch_id: `r36-short-${runId}`,
      person_no: 1,
      items: [{ type: 'pending', amount: 999 }],
      method: 'cash',
      cash_received: 100,
      print: false
    })
  });
  assert.equal(shortCashRes.status, 400);

  // 2. pending_supplement = 120, client sends amount: 999 -> server charges 120; cash_received 200 -> change 80; idempotent retry keeps 1 row
  const supBatchId = `r36-sup-pending-${runId}`;
  const supReqBody = JSON.stringify({
    client_batch_id: supBatchId,
    person_no: 1,
    items: [{ type: 'pending', amount: 999 }],
    method: 'cash',
    cash_received: 200,
    print: false
  });
  const [supRes1, supRes2] = await Promise.all([
    fetch(`${srv.baseUrl}/api/billing/${refA}/supplement`, { method: 'POST', headers, body: supReqBody }),
    fetch(`${srv.baseUrl}/api/billing/${refA}/supplement`, { method: 'POST', headers, body: supReqBody })
  ]);
  assert.equal(supRes1.status, 200);
  assert.equal(supRes2.status, 200);
  const supBody1 = await supRes1.json();
  const supBody2 = await supRes2.json();
  assert.equal(supBody1.payment.amount, 120);
  assert.equal(supBody1.payment.cash_received, 200);
  assert.equal(supBody1.payment.change_given, 80);
  assert.equal(supBody2.payment.id, supBody1.payment.id);
  assert.equal(supBody1.bill.persons[0].pending_supplement, 0);

  const supCount = await prisma.payment.count({ where: { booking_ref: refA, client_batch_id: supBatchId } });
  assert.equal(supCount, 1);

  // 3. pending_supplement now 0 -> sending pending returns 422
  const zeroPendingRes = await fetch(`${srv.baseUrl}/api/billing/${refA}/supplement`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      person_no: 1,
      items: [{ type: 'pending' }],
      method: 'cash',
      print: false
    })
  });
  assert.equal(zeroPendingRes.status, 422);

  // 4. other <= 0 returns 422; empty label returns 422; inactive addon returns 422; bad hours returns 422
  for (const badBody of [
    { person_no: 1, items: [{ type: 'other', label: '負數', amount: -50 }], method: 'cash', print: false },
    { person_no: 1, items: [{ type: 'other', label: '零元', amount: 0 }], method: 'cash', print: false },
    { person_no: 1, items: [{ type: 'other', label: '   ', amount: 50 }], method: 'cash', print: false },
    { person_no: 1, items: [{ type: 'addon', addon_id: inactiveAddon.id, qty: 1 }], method: 'cash', print: false },
    { person_no: 1, items: [{ type: 'hours', hours: 0.3 }], method: 'cash', print: false }
  ]) {
    const r = await fetch(`${srv.baseUrl}/api/billing/${refA}/supplement`, {
      method: 'POST',
      headers,
      body: JSON.stringify(badBody)
    });
    assert.equal(r.status, 422);
  }

  // 5. addon_id points to NT$50 item while client sends price: 1 -> server bills NT$50
  const addonSupRes = await fetch(`${srv.baseUrl}/api/billing/${refA}/supplement`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      person_no: 1,
      items: [{ type: 'addon', addon_id: activeAddon.id, name: activeAddon.name, price: 1, qty: 1 }],
      method: 'cash',
      cash_received: 50,
      print: false
    })
  });
  assert.equal(addonSupRes.status, 200);
  const addonSupBody = await addonSupRes.json();
  assert.equal(addonSupBody.payment.amount, 50);

  // 6. Void pending supplement restores pending_supplement to 120
  const voidSupRes = await fetch(`${srv.baseUrl}/api/billing/payments/${supBody1.payment.id}/void`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ reason: '作廢待補收檢查恢復' })
  });
  assert.equal(voidSupRes.status, 200);
  const billAfterVoid = await getBookingBill(refA);
  assert.equal(billAfterVoid.bill.persons[0].pending_supplement, 120);

  // 7. Refund idempotency via client_batch_id on Booking B
  await prisma.reservation.create({
    data: {
      booking_ref: refB,
      user_id: user.id,
      session_id: session.id,
      pax: 1,
      assigned_seats: ['A2'],
      status: 'confirmed',
      checkout_details: { version: 2, persons: [{ person_no: 1, mode: 'hourly' }] }
    }
  });
  await prisma.bookingPerson.create({
    data: { booking_ref: refB, person_no: 1, seat_code: 'A2', status: 'active' }
  });
  await collectPayment(refB, { person_nos: [1], method: 'cash', print: false }, staffUser, deviceInfo);

  const refBatchId = `r36-ref-${runId}`;
  const refReqBody = JSON.stringify({
    client_batch_id: refBatchId,
    person_no: 1,
    amount: 100,
    method: 'cash',
    reason: '重複點擊防呆測試',
    print: false
  });
  const [refRes1, refRes2] = await Promise.all([
    fetch(`${srv.baseUrl}/api/billing/${refB}/refund`, { method: 'POST', headers, body: refReqBody }),
    fetch(`${srv.baseUrl}/api/billing/${refB}/refund`, { method: 'POST', headers, body: refReqBody })
  ]);
  assert.equal(refRes1.status, 200);
  assert.equal(refRes2.status, 200);
  const refBody1 = await refRes1.json();
  const refBody2 = await refRes2.json();
  assert.equal(refBody2.payment.id, refBody1.payment.id);
  const refCount = await prisma.payment.count({ where: { booking_ref: refB, kind: 'refund', client_batch_id: refBatchId } });
  assert.equal(refCount, 1);
});
