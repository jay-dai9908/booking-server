import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import express from 'express';
import cookieParser from 'cookie-parser';
import prisma from '../src/prismaClient.js';
import authRoutes from '../src/routes/auth.js';
import billingRoutes from '../src/routes/billing.js';
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

test('Round 37 Item 5: concurrent PUT /draft with same base_rev allows only one 200 and returns 409 with current_draft for the loser', async (t) => {
  const runId = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const testDate = dateOnly('2099-10-12');
  const bookingRef = `R37-I5-${runId}`;

  let srv = null;
  let user = null;
  let adminUser = null;
  let session = null;
  let dailyCreated = false;
  let createdLayoutId = null;

  t.after(async () => {
    if (srv) await srv.close().catch(() => {});
    await prisma.bookingPerson.deleteMany({ where: { booking_ref: bookingRef } }).catch(() => {});
    await prisma.reservation.deleteMany({ where: { booking_ref: bookingRef } }).catch(() => {});
    if (session?.id) await prisma.session.delete({ where: { id: session.id } }).catch(() => {});
    if (dailyCreated) await prisma.dailySetting.delete({ where: { date: testDate } }).catch(() => {});
    if (user?.id) await prisma.user.delete({ where: { id: user.id } }).catch(() => {});
    if (adminUser?.id) await prisma.adminUser.delete({ where: { id: adminUser.id } }).catch(() => {});
    await cleanupTestPublishedLayout(prisma, createdLayoutId);
  });

  createdLayoutId = await ensureTestPublishedLayout(prisma);
  srv = await startLocalApp();

  user = await prisma.user.create({
    data: {
      line_user_id: `r37_i5_user_${runId}`,
      name: 'R37草稿併發客',
      phone: `09975${String(Date.now()).slice(-5)}` // check-secrets: fake-data
    }
  });
  const adminPass = `r37_i5_adm_${runId}`;
  adminUser = await prisma.adminUser.create({
    data: {
      password: adminPass,
      name: `R37草稿店員_${runId}`,
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
  const adminCookie = loginRes.headers.get('set-cookie').split(';')[0];

  const existingDaily = await prisma.dailySetting.findUnique({ where: { date: testDate } });
  if (!existingDaily) {
    await prisma.dailySetting.create({
      data: { date: testDate, hourly_price: 150, unlimited_price: 750, allow_unlimited: true, is_self_service: false }
    });
    dailyCreated = true;
  }
  session = await prisma.session.create({
    data: { session_date: testDate, start_time: '14:00', end_time: '16:00', max_capacity: 20 }
  });

  await prisma.reservation.create({
    data: {
      booking_ref: bookingRef,
      session_id: session.id,
      user_id: user.id,
      pax: 1,
      status: 'confirmed',
      assigned_seats: ['A1-1'],
      checkout_details: {
        version: 2,
        rev: 0,
        split_mode: 'proportional',
        persons: [],
        order_addons: [],
        order_promos: [],
        manual_discount: null,
        total_override: null,
        note: ''
      }
    }
  });
  await prisma.bookingPerson.create({
    data: { booking_ref: bookingRef, person_no: 1, seat_code: 'A1-1', status: 'active' }
  });

  const payloadA = {
    base_rev: 0,
    draft: {
      version: 2,
      split_mode: 'proportional',
      persons: [],
      order_addons: [{ key: 'k-a', name: '鑰匙圈', price: 100, qty: 1, split_mode: 'proportional' }],
      order_promos: [],
      manual_discount: null,
      total_override: null,
      note: 'from A'
    }
  };
  const payloadB = {
    base_rev: 0,
    draft: {
      version: 2,
      split_mode: 'proportional',
      persons: [],
      order_addons: [{ key: 'k-b', name: '磁鐵', price: 80, qty: 1, split_mode: 'proportional' }],
      order_promos: [],
      manual_discount: null,
      total_override: null,
      note: 'from B'
    }
  };

  const [resA, resB] = await Promise.all([
    fetch(`${srv.baseUrl}/api/billing/${bookingRef}/draft`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify(payloadA)
    }),
    fetch(`${srv.baseUrl}/api/billing/${bookingRef}/draft`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify(payloadB)
    })
  ]);

  const dataA = await resA.json();
  const dataB = await resB.json();
  const statuses = [resA.status, resB.status].sort((x, y) => x - y);
  assert.deepEqual(statuses, [200, 409]);

  const winnerData = resA.status === 200 ? dataA : dataB;
  const loserData = resA.status === 409 ? dataA : dataB;
  assert.equal(winnerData.rev, 1);
  assert.equal(loserData.code, 'REV_CONFLICT');
  assert.ok(loserData.current_draft, '409 response must carry current_draft');
  assert.equal(loserData.current_draft.rev, 1);
  assert.equal(loserData.rev, 1);
  assert.ok(loserData.updated_by);

  const dbRes = await prisma.reservation.findFirst({ where: { booking_ref: bookingRef } });
  assert.equal(dbRes.checkout_details.rev, 1);
});
