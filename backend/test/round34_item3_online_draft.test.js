import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import express from 'express';
import cookieParser from 'cookie-parser';
import prisma from '../src/prismaClient.js';
import authRoutes from '../src/routes/auth.js';
import reservationRoutes from '../src/routes/reservations.js';
import billingRoutes from '../src/routes/billing.js';
import { generateToken } from '../src/middlewares/authMiddleware.js';
import { ensureTestPublishedLayout } from './helpers/seedTestLayout.js';
import { getBookingBill } from '../src/services/billing/billService.js';
import { runBackfillOnlineDrafts } from '../scripts/backfill-online-drafts.mjs';
import { dateOnly } from '../../shared/time.js';

function startLocalApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/auth', authRoutes);
  app.use('/api/reservations', reservationRoutes);
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

test('Round 34 Item 3: normal online booking & walk-in write initial draft, preserve promo_code after collect, and backfill script works', async (t) => {
  const runId = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  // 2099-11-25 is Wednesday
  const futureDate = dateOnly('2099-11-25');
  const promoCode = `R34O90_${runId}`.toUpperCase();
  const legacyNoDraftRef = `R34-I3-LEG-${runId}`;
  const legacyPaidRef = `R34-I3-PAID-${runId}`;

  let customer = null;
  let adminUser = null;
  let sessions = [];
  let dailyWd = null;
  let promo = null;
  let srv = null;
  const createdRefs = [legacyNoDraftRef, legacyPaidRef];

  t.after(async () => {
    if (srv) await srv.close().catch(() => {});
    await prisma.printJob.deleteMany({ where: { booking_ref: { in: createdRefs } } }).catch(() => {});
    await prisma.payment.deleteMany({ where: { booking_ref: { in: createdRefs } } }).catch(() => {});
    await prisma.bookingPerson.deleteMany({ where: { booking_ref: { in: createdRefs } } }).catch(() => {});
    await prisma.reservation.deleteMany({ where: { booking_ref: { in: createdRefs } } }).catch(() => {});
    if (sessions.length) await prisma.session.deleteMany({ where: { id: { in: sessions.map((s) => s.id) } } }).catch(() => {});
    if (dailyWd) await prisma.dailySetting.delete({ where: { date: futureDate } }).catch(() => {});
    if (promo?.id) await prisma.promoCode.delete({ where: { id: promo.id } }).catch(() => {});
    if (customer?.id) await prisma.user.delete({ where: { id: customer.id } }).catch(() => {});
    if (adminUser?.id) await prisma.adminUser.delete({ where: { id: adminUser.id } }).catch(() => {});
  });

  await ensureTestPublishedLayout(prisma);
  srv = await startLocalApp();

  customer = await prisma.user.create({
    data: {
      line_user_id: `r34_i3_cust_${runId}`,
      name: 'R34草稿測試客',
      phone: `09943${String(Date.now()).slice(-5)}` // check-secrets: fake-data
    }
  });
  const adminPass = `r34_i3_adm_${runId}`;
  adminUser = await prisma.adminUser.create({
    data: {
      password: adminPass,
      name: `R34草稿管理員_${runId}`,
      role: 'superadmin',
      permissions: ['all'],
      is_active: true
    }
  });

  const custToken = generateToken({ id: customer.id, typ: 'customer', line_user_id: customer.line_user_id, role: 'customer' });
  const loginRes = await fetch(`${srv.baseUrl}/api/auth/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: adminPass })
  });
  assert.equal(loginRes.status, 200);
  const { token: adminToken } = await loginRes.json();

  dailyWd = await prisma.dailySetting.upsert({
    where: { date: futureDate },
    update: { hourly_price: 150, unlimited_price: 750, allow_unlimited: true, is_self_service: false },
    create: { date: futureDate, hourly_price: 150, unlimited_price: 750, allow_unlimited: true, is_self_service: false }
  });

  for (const [start, end] of [['13:00', '14:00'], ['14:00', '15:00'], ['15:00', '16:00']]) {
    sessions.push(await prisma.session.create({
      data: { session_date: futureDate, start_time: start, end_time: end, max_capacity: 20 }
    }));
  }

  promo = await prisma.promoCode.create({
    data: {
      code: promoCode,
      name: '線上九折',
      discount_type: 'percentage',
      discount_value: 90,
      channel: 'all',
      is_active: true
    }
  });

  // 1) Normal-day online booking: 2 pax * 3h (900) with percentage 90 -> total_amount 810, getBookingBill amount_due 810
  const createOnlineRes = await fetch(`${srv.baseUrl}/api/reservations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${custToken}` },
    body: JSON.stringify({
      session_ids: sessions.map((s) => s.id),
      pax: 2,
      isUnlimited: false,
      promo_code: promoCode,
      equipments: []
    })
  });
  assert.equal(createOnlineRes.status, 201);
  const onlineJson = await createOnlineRes.json();
  const onlineRef = onlineJson.reservation.booking_ref;
  createdRefs.push(onlineRef);
  assert.equal(onlineJson.reservation.total_amount, 810);

  const onlineBill = await getBookingBill(onlineRef, prisma);
  assert.equal(onlineBill.bill.summary.amount_due, 810);
  assert.equal(onlineBill.bill.summary.discounts_total, 90);

  // 2) Collect payment for both persons -> promo_code remains intact on Reservation
  const collectRes = await fetch(`${srv.baseUrl}/api/billing/${onlineRef}/collect`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({
      person_nos: [1, 2],
      method: 'cash',
      cash_received: 810,
      expected_amount: 810,
      client_batch_id: `r34-i3-pay-${runId}`
    })
  });
  assert.equal(collectRes.status, 200);
  const afterPayRow = await prisma.reservation.findFirst({ where: { booking_ref: onlineRef } });
  assert.equal(afterPayRow.promo_code, promoCode);

  // 3) Admin walk-in 2 pax with isUnlimited: true (unlimited_price 750) -> amount_due 1500
  const walkInRes = await fetch(`${srv.baseUrl}/api/reservations/admin`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({
      name: 'R34不限時現場客',
      phone: `09944${String(Date.now()).slice(-5)}`, // check-secrets: fake-data
      session_ids: sessions.map((s) => s.id),
      pax: 2,
      isUnlimited: true,
      isWalkIn: true
    })
  });
  assert.equal(walkInRes.status, 201);
  const walkInJson = await walkInRes.json();
  const walkInRef = walkInJson.reservation.booking_ref;
  createdRefs.push(walkInRef);
  const walkInBill = await getBookingBill(walkInRef, prisma);
  assert.equal(walkInBill.bill.summary.amount_due, 1500);

  // Clean up guest user created by admin walk-in if separate
  const walkInRow = await prisma.reservation.findFirst({ where: { booking_ref: walkInRef }, select: { user_id: true } });

  // 4) Backfill script: old reservation without draft + paid reservation with promo_code
  for (const s of sessions) {
    await prisma.reservation.create({
      data: {
        booking_ref: legacyNoDraftRef,
        session_id: s.id,
        user_id: customer.id,
        pax: 2,
        status: 'confirmed',
        assigned_seats: ['B1-1', 'B1-2'],
        total_amount: 810,
        promo_code: promoCode,
        discount_amount: 90,
        checkout_details: null
      }
    });
    await prisma.reservation.create({
      data: {
        booking_ref: legacyPaidRef,
        session_id: s.id,
        user_id: customer.id,
        pax: 2,
        status: 'confirmed',
        assigned_seats: ['B2-1', 'B2-2'],
        total_amount: 900,
        promo_code: promoCode,
        checkout_details: null
      }
    });
  }
  await prisma.payment.create({
    data: {
      booking_ref: legacyPaidRef,
      payment_no: `R-34I3-${runId.slice(-4)}`,
      batch_no: `B-34I3-${runId}`,
      kind: 'charge',
      status: 'valid',
      method: 'cash',
      amount: 900,
      cash_received: 900,
      change_given: 0,
      person_nos: [1, 2],
      staff_name: '測試員',
      device_label: '櫃檯',
      breakdown_json: { persons: [] }
    }
  });

  const dryRes = await runBackfillOnlineDrafts({ apply: false, client: prisma });
  const dryRefs = dryRes.items.map((it) => it.booking_ref);
  assert.ok(dryRefs.includes(legacyNoDraftRef), 'Dry-run must include legacy booking without draft');
  assert.ok(!dryRefs.includes(legacyPaidRef), 'Dry-run must exclude paid booking');

  const applyRes = await runBackfillOnlineDrafts({ apply: true, client: prisma });
  assert.ok(applyRes.backfilled >= 1);

  const backfilledBill = await getBookingBill(legacyNoDraftRef, prisma);
  assert.equal(backfilledBill.bill.summary.amount_due, 810);

  const paidRowAfter = await prisma.reservation.findFirst({ where: { booking_ref: legacyPaidRef } });
  assert.equal(paidRowAfter.checkout_details, null);

  if (walkInRow?.user_id && walkInRow.user_id !== customer.id) {
    t.after(async () => {
      await prisma.user.delete({ where: { id: walkInRow.user_id } }).catch(() => {});
    });
  }
});
