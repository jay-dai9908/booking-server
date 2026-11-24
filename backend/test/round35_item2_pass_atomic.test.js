import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import express from 'express';
import cookieParser from 'cookie-parser';
import prisma from '../src/prismaClient.js';
import authRoutes from '../src/routes/auth.js';
import billingRoutes from '../src/routes/billing.js';
import reservationRoutes from '../src/routes/reservations.js';
import passRoutes from '../src/routes/passes.js';
import { generateToken } from '../src/middlewares/authMiddleware.js';
import { ensureTestPublishedLayout, cleanupTestPublishedLayout } from './helpers/seedTestLayout.js';
import { dateOnly } from '../../shared/time.js';

function startLocalApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/auth', authRoutes);
  app.use('/api/billing', billingRoutes);
  app.use('/api/reservations', reservationRoutes);
  app.use('/api/passes', passRoutes);
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

test('Round 35 Item 2: atomic deductPass / restorePass lock, self-service pass concurrency, and redeemUserPass validation/audit', async (t) => {
  const runId = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const d1 = dateOnly('2099-12-09');
  const d2 = dateOnly('2099-12-10');
  const dSelf1 = dateOnly('2099-12-11');
  const dSelf2 = dateOnly('2099-12-12');
  const refPos1 = `R35-I2-P1-${runId}`;
  const refPos2 = `R35-I2-P2-${runId}`;
  const createdRefs = [refPos1, refPos2];
  const sessionIds = [];
  const createdPassIds = [];

  let srv = null;
  let user = null;
  let adminUser = null;
  let plan = null;
  let kioskSettingSnapshot = null;
  let createdLayoutId = null;

  t.after(async () => {
    if (srv) await srv.close().catch(() => {});
    await prisma.bookingPrepay.deleteMany({ where: { booking_ref: { in: createdRefs } } }).catch(() => {});
    await prisma.printJob.deleteMany({ where: { booking_ref: { in: createdRefs } } }).catch(() => {});
    await prisma.payment.deleteMany({ where: { booking_ref: { in: createdRefs } } }).catch(() => {});
    await prisma.bookingPerson.deleteMany({ where: { booking_ref: { in: createdRefs } } }).catch(() => {});
    await prisma.reservation.deleteMany({ where: { booking_ref: { in: createdRefs } } }).catch(() => {});
    if (sessionIds.length) await prisma.session.deleteMany({ where: { id: { in: sessionIds } } }).catch(() => {});
    await prisma.dailySetting.deleteMany({ where: { date: { in: [d1, d2, dSelf1, dSelf2] } } }).catch(() => {});
    if (createdPassIds.length) await prisma.userPass.deleteMany({ where: { id: { in: createdPassIds } } }).catch(() => {});
    if (plan?.id) await prisma.passPlan.delete({ where: { id: plan.id } }).catch(() => {});
    if (user?.id) await prisma.user.delete({ where: { id: user.id } }).catch(() => {});
    if (adminUser?.id) await prisma.adminUser.delete({ where: { id: adminUser.id } }).catch(() => {});
    if (kioskSettingSnapshot === null) {
      await prisma.kioskSetting.deleteMany({ where: { id: 1 } }).catch(() => {});
    }
    await cleanupTestPublishedLayout(prisma, createdLayoutId);
  });

  createdLayoutId = await ensureTestPublishedLayout(prisma);
  kioskSettingSnapshot = await prisma.kioskSetting.findUnique({ where: { id: 1 } });
  if (!kioskSettingSnapshot) {
    await prisma.kioskSetting.create({ data: { id: 1, early_minutes: 30, after_close_minutes: 60 } });
  }
  srv = await startLocalApp();

  user = await prisma.user.create({
    data: {
      line_user_id: `r35_i2_user_${runId}`,
      name: 'R35並發客',
      phone: `09952${String(Date.now()).slice(-5)}` // check-secrets: fake-data
    }
  });
  const staffRealName = `R35核銷店員_${runId}`;
  const adminPass = `r35_i2_adm_${runId}`;
  adminUser = await prisma.adminUser.create({
    data: {
      password: adminPass,
      name: staffRealName,
      role: 'superadmin',
      permissions: ['all'],
      is_active: true
    }
  });

  const custToken = generateToken({ id: user.id, typ: 'customer', line_user_id: user.line_user_id, role: 'customer' });
  const loginRes = await fetch(`${srv.baseUrl}/api/auth/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: adminPass })
  });
  assert.equal(loginRes.status, 200);
  const { token: adminToken } = await loginRes.json();

  for (const [dt, isSelf] of [[d1, false], [d2, false], [dSelf1, true], [dSelf2, true]]) {
    await prisma.dailySetting.upsert({
      where: { date: dt },
      update: {
        hourly_price: 150,
        unlimited_price: 750,
        allow_unlimited: true,
        is_self_service: isSelf,
        self_allow_hourly: true
      },
      create: {
        date: dt,
        hourly_price: 150,
        unlimited_price: 750,
        allow_unlimited: true,
        is_self_service: isSelf,
        self_allow_hourly: true
      }
    });
  }

  const s1 = await prisma.session.create({ data: { session_date: d1, start_time: '14:00', end_time: '15:00', max_capacity: 16 } });
  const s2 = await prisma.session.create({ data: { session_date: d2, start_time: '14:00', end_time: '15:00', max_capacity: 16 } });
  const sSelf1 = await prisma.session.create({ data: { session_date: dSelf1, start_time: '14:00', end_time: '15:00', max_capacity: 16 } });
  const sSelf2 = await prisma.session.create({ data: { session_date: dSelf2, start_time: '14:00', end_time: '15:00', max_capacity: 16 } });
  sessionIds.push(s1.id, s2.id, sSelf1.id, sSelf2.id);

  plan = await prisma.passPlan.create({
    data: {
      code: `R35_I2_${runId}`,
      name: 'R35並發卡',
      pass_type: 'PUNCH_CARD',
      price: 500,
      total_quota: 5,
      valid_days: 90,
      checkout_effect: 'entry_full',
      checkout_scope: 'entry'
    }
  });

  // 1. Two concurrent POS collects using same pass with remaining_quota: 1
  const passPos = await prisma.userPass.create({
    data: {
      user_id: user.id,
      plan_id: plan.id,
      pass_code: `R35P2A-${runId}`,
      plan_name_snapshot: plan.name,
      pass_type: 'PUNCH_CARD',
      total_quota: 5,
      remaining_quota: 1,
      payment_status: 'active',
      status: 'ACTIVE',
      expires_at: dateOnly('2099-12-31')
    }
  });
  createdPassIds.push(passPos.id);

  for (const [ref, sess] of [[refPos1, s1], [refPos2, s2]]) {
    await prisma.reservation.create({
      data: {
        booking_ref: ref,
        user_id: user.id,
        session_id: sess.id,
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

  const [colA, colB] = await Promise.all([
    fetch(`${srv.baseUrl}/api/billing/${refPos1}/collect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ person_nos: [1], method: 'cash', pass_tenders: [{ user_pass_id: passPos.id, person_no: 1, units: 1 }], print: false })
    }),
    fetch(`${srv.baseUrl}/api/billing/${refPos2}/collect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ person_nos: [1], method: 'cash', pass_tenders: [{ user_pass_id: passPos.id, person_no: 1, units: 1 }], print: false })
    })
  ]);
  const posStatuses = [colA.status, colB.status].sort((a, b) => a - b);
  assert.deepEqual(posStatuses, [200, 409]);
  const posPassAfter = await prisma.userPass.findUnique({ where: { id: passPos.id } });
  assert.equal(posPassAfter.remaining_quota, 0);
  assert.equal(posPassAfter.usage_logs_json.length, 1);

  // 2. Two concurrent all-pass self-service reservations using same pass with remaining_quota: 1
  const passSelf = await prisma.userPass.create({
    data: {
      user_id: user.id,
      plan_id: plan.id,
      pass_code: `R35P2B-${runId}`,
      plan_name_snapshot: plan.name,
      pass_type: 'PUNCH_CARD',
      total_quota: 5,
      remaining_quota: 1,
      payment_status: 'active',
      status: 'ACTIVE',
      expires_at: dateOnly('2099-12-31')
    }
  });
  createdPassIds.push(passSelf.id);

  const [selfRes1, selfRes2] = await Promise.all([
    fetch(`${srv.baseUrl}/api/reservations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${custToken}` },
      body: JSON.stringify({
        session_ids: [sSelf1.id],
        pax: 1,
        isUnlimited: true,
        self_service_ack: true,
        prepay: { pass_uses: [{ user_pass_id: passSelf.id, units: 1 }], expected_transfer_amount: 0 }
      })
    }),
    fetch(`${srv.baseUrl}/api/reservations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${custToken}` },
      body: JSON.stringify({
        session_ids: [sSelf2.id],
        pax: 1,
        isUnlimited: true,
        self_service_ack: true,
        prepay: { pass_uses: [{ user_pass_id: passSelf.id, units: 1 }], expected_transfer_amount: 0 }
      })
    })
  ]);
  const selfBody1 = await selfRes1.json();
  const selfBody2 = await selfRes2.json();
  if (selfBody1?.reservation?.booking_ref) createdRefs.push(selfBody1.reservation.booking_ref);
  if (selfBody2?.reservation?.booking_ref) createdRefs.push(selfBody2.reservation.booking_ref);
  const selfStatuses = [selfRes1.status, selfRes2.status].sort((a, b) => a - b);
  assert.deepEqual(selfStatuses, [201, 409]);

  // 3. Manual redeem validation & audit
  const passManual = await prisma.userPass.create({
    data: {
      user_id: user.id,
      plan_id: plan.id,
      pass_code: `R35P2M-${runId}`,
      plan_name_snapshot: plan.name,
      pass_type: 'PUNCH_CARD',
      total_quota: 5,
      remaining_quota: 3,
      payment_status: 'active',
      status: 'ACTIVE',
      expires_at: dateOnly('2099-12-31')
    }
  });
  createdPassIds.push(passManual.id);

  for (const badAmt of [-1, 0, 1.5, 'abc']) {
    const badRes = await fetch(`${srv.baseUrl}/api/passes/admin/redeem`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ user_pass_id: passManual.id, deduct_amount: badAmt })
    });
    assert.equal(badRes.status, 422, `Expected 422 for deduct_amount=${badAmt}`);
  }
  const passUnchanged = await prisma.userPass.findUnique({ where: { id: passManual.id } });
  assert.equal(passUnchanged.remaining_quota, 3);

  const okManual = await fetch(`${srv.baseUrl}/api/passes/admin/redeem`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({
      user_pass_id: passManual.id,
      deduct_amount: 1,
      staff_name: '別人',
      note: 'R35手動備註'
    })
  });
  assert.equal(okManual.status, 200);
  const passAfterManual = await prisma.userPass.findUnique({ where: { id: passManual.id } });
  assert.equal(passAfterManual.remaining_quota, 2);
  assert.equal(passAfterManual.usage_logs_json[0].by, staffRealName);

  const evt = await prisma.accountingEvent.findFirst({
    where: {
      event_type: 'pass_redeemed_manual',
      category: 'pass',
      staff_name: staffRealName,
      reason: 'R35手動備註'
    }
  });
  assert.ok(evt);
});
