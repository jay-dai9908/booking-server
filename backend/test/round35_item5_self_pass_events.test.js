import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import express from 'express';
import cookieParser from 'cookie-parser';
import prisma from '../src/prismaClient.js';
import authRoutes from '../src/routes/auth.js';
import reservationRoutes from '../src/routes/reservations.js';
import { generateToken } from '../src/middlewares/authMiddleware.js';
import { releaseExpiredPrepays } from '../src/services/selfService/prepayService.js';
import { ensureTestPublishedLayout, cleanupTestPublishedLayout } from './helpers/seedTestLayout.js';
import { dateOnly } from '../../shared/time.js';

function startLocalApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/auth', authRoutes);
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

test('Round 35 Item 5: self-service pass_held and pass_restored (cancel & expired) audit events and trigger immutability', async (t) => {
  const runId = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const futureDate1 = dateOnly('2099-12-17');
  const futureDate2 = dateOnly('2099-12-18');
  const createdRefs = [];
  const createdSessionIds = [];

  let srv = null;
  let user = null;
  let equip = null;
  let plan = null;
  let userPass = null;
  let methodCfg = null;
  let kioskSnapshot = null;
  let createdLayoutId = null;

  t.after(async () => {
    if (srv) await srv.close().catch(() => {});
    if (createdRefs.length) {
      await prisma.bookingPrepay.deleteMany({ where: { booking_ref: { in: createdRefs } } }).catch(() => {});
      await prisma.printJob.deleteMany({ where: { booking_ref: { in: createdRefs } } }).catch(() => {});
      await prisma.payment.deleteMany({ where: { booking_ref: { in: createdRefs } } }).catch(() => {});
      await prisma.bookingEquipment.deleteMany({ where: { booking_ref: { in: createdRefs } } }).catch(() => {});
      await prisma.bookingPerson.deleteMany({ where: { booking_ref: { in: createdRefs } } }).catch(() => {});
      await prisma.reservation.deleteMany({ where: { booking_ref: { in: createdRefs } } }).catch(() => {});
    }
    if (createdSessionIds.length) {
      await prisma.session.deleteMany({ where: { id: { in: createdSessionIds } } }).catch(() => {});
    }
    await prisma.dailySetting.deleteMany({ where: { date: { in: [futureDate1, futureDate2] } } }).catch(() => {});
    if (equip?.id) await prisma.equipmentConfig.delete({ where: { id: equip.id } }).catch(() => {});
    if (userPass?.id) await prisma.userPass.delete({ where: { id: userPass.id } }).catch(() => {});
    if (plan?.id) await prisma.passPlan.delete({ where: { id: plan.id } }).catch(() => {});
    if (methodCfg) await prisma.paymentMethodConfig.delete({ where: { code: methodCfg.code } }).catch(() => {});
    if (user?.id) await prisma.user.delete({ where: { id: user.id } }).catch(() => {});
    if (kioskSnapshot === null) await prisma.kioskSetting.deleteMany({ where: { id: 1 } }).catch(() => {});
    await cleanupTestPublishedLayout(prisma, createdLayoutId);
  });

  createdLayoutId = await ensureTestPublishedLayout(prisma);
  kioskSnapshot = await prisma.kioskSetting.findUnique({ where: { id: 1 } });
  if (!kioskSnapshot) {
    await prisma.kioskSetting.create({ data: { id: 1, early_minutes: 30, after_close_minutes: 60 } });
  }
  srv = await startLocalApp();

  user = await prisma.user.create({
    data: {
      line_user_id: `r35_i5_user_${runId}`,
      name: 'R35半自助事件客',
      phone: `09955${String(Date.now()).slice(-5)}` // check-secrets: fake-data
    }
  });
  const custToken = generateToken({ id: user.id, typ: 'customer', line_user_id: user.line_user_id, role: 'customer' });

  const transferCode = `r35_tr_${runId}`;
  methodCfg = await prisma.paymentMethodConfig.create({
    data: {
      code: transferCode,
      name: 'R35測試銀行',
      method_type: 'MULTI_BANK',
      is_enabled: true,
      bank_accounts_json: [{ bank_code: '007', bank_name: 'R35測試銀行', account_number: '1234567890' }] // check-secrets: fake-data
    }
  });

  for (const dt of [futureDate1, futureDate2]) {
    await prisma.dailySetting.upsert({
      where: { date: dt },
      update: { hourly_price: 150, unlimited_price: 750, allow_unlimited: true, is_self_service: true, self_allow_hourly: true, self_allow_equipment: true },
      create: { date: dt, hourly_price: 150, unlimited_price: 750, allow_unlimited: true, is_self_service: true, self_allow_hourly: true, self_allow_equipment: true }
    });
  }

  const s1 = await prisma.session.create({ data: { session_date: futureDate1, start_time: '13:00', end_time: '14:00', max_capacity: 16 } });
  const s2 = await prisma.session.create({ data: { session_date: futureDate2, start_time: '13:00', end_time: '14:00', max_capacity: 16 } });
  createdSessionIds.push(s1.id, s2.id);

  equip = await prisma.equipmentConfig.create({
    data: {
      id: `r35_i5_eq_${runId}`,
      name: 'R35租借板',
      hourly_rate: 60,
      total_stock: 5,
      min_contiguous_hours: 1,
      visibility_status: 'ACTIVE',
      self_enabled: true
    }
  });

  plan = await prisma.passPlan.create({
    data: {
      code: `R35_I5_P_${runId}`,
      name: 'R35半自助計次卡',
      pass_type: 'PUNCH_CARD',
      price: 500,
      total_quota: 5,
      valid_days: 90,
      checkout_effect: 'entry_full',
      checkout_scope: 'entry'
    }
  });

  userPass = await prisma.userPass.create({
    data: {
      user_id: user.id,
      plan_id: plan.id,
      pass_code: `R35I5-${runId}`,
      plan_name_snapshot: plan.name,
      pass_type: 'PUNCH_CARD',
      total_quota: 5,
      remaining_quota: 5,
      payment_status: 'active',
      status: 'ACTIVE',
      expires_at: dateOnly('2099-12-31')
    }
  });

  // 1. Booking A: 2 pax using pass (units=2) + equipment so prepay is pending_payment -> pass_held event
  const resA = await fetch(`${srv.baseUrl}/api/reservations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${custToken}` },
    body: JSON.stringify({
      session_ids: [s1.id],
      pax: 2,
      isUnlimited: true,
      equipments: [{ equipment_id: equip.id, quantity: 1 }],
      self_service_ack: true,
      prepay: {
        pass_uses: [{ user_pass_id: userPass.id, units: 2 }],
        transfer: { payment_method_code: transferCode },
        expected_transfer_amount: 60
      }
    })
  });
  assert.equal(resA.status, 201);
  const bodyA = await resA.json();
  const refA = bodyA.reservation.booking_ref;
  createdRefs.push(refA);

  const heldEvt = await prisma.accountingEvent.findFirst({
    where: { booking_ref: refA, event_type: 'pass_held', category: 'pass' }
  });
  assert.ok(heldEvt);
  assert.equal(heldEvt.staff_name, 'customer');
  assert.equal(heldEvt.device_label, '線上預約');
  assert.equal(heldEvt.after_json?.user_pass_id, userPass.id);
  assert.equal(heldEvt.after_json?.units, 2);
  assert.equal(heldEvt.after_json?.remaining_after, 3);
  assert.ok(heldEvt.summary.includes('2099-12-17'));

  // 2. Cancel unpaid booking A -> pass_restored event & quota back to 5
  const cancelRes = await fetch(`${srv.baseUrl}/api/reservations/${refA}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${custToken}` }
  });
  assert.equal(cancelRes.status, 200);

  const restoredCancelEvt = await prisma.accountingEvent.findFirst({
    where: { booking_ref: refA, event_type: 'pass_restored', category: 'pass' }
  });
  assert.ok(restoredCancelEvt);
  assert.ok(restoredCancelEvt.summary.includes('取消預約'));
  assert.equal(restoredCancelEvt.after_json?.units, 2);
  assert.equal(restoredCancelEvt.after_json?.remaining_after, 5);
  assert.equal((await prisma.userPass.findUnique({ where: { id: userPass.id } })).remaining_quota, 5);

  // 3. Booking B: expire prepay -> releaseExpiredPrepays emits pass_restored event
  const resB = await fetch(`${srv.baseUrl}/api/reservations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${custToken}` },
    body: JSON.stringify({
      session_ids: [s2.id],
      pax: 2,
      isUnlimited: true,
      equipments: [{ equipment_id: equip.id, quantity: 1 }],
      self_service_ack: true,
      prepay: {
        pass_uses: [{ user_pass_id: userPass.id, units: 2 }],
        transfer: { payment_method_code: transferCode },
        expected_transfer_amount: 60
      }
    })
  });
  assert.equal(resB.status, 201);
  const bodyB = await resB.json();
  const refB = bodyB.reservation.booking_ref;
  createdRefs.push(refB);

  await prisma.bookingPrepay.update({
    where: { booking_ref: refB },
    data: { deadline_at: new Date(Date.now() - 60_000) }
  });

  await releaseExpiredPrepays();

  const restoredExpEvt = await prisma.accountingEvent.findFirst({
    where: { booking_ref: refB, event_type: 'pass_restored', category: 'pass' }
  });
  assert.ok(restoredExpEvt);
  assert.equal(restoredExpEvt.staff_name, '系統');
  assert.ok(restoredExpEvt.summary.includes('逾期未付款'));
  assert.equal(restoredExpEvt.after_json?.units, 2);
  assert.equal(restoredExpEvt.after_json?.remaining_after, 5);
  assert.equal((await prisma.userPass.findUnique({ where: { id: userPass.id } })).remaining_quota, 5);

  // 4. Verify append-only trigger blocks UPDATE and DELETE on all 3 AccountingEvents
  for (const evt of [heldEvt, restoredCancelEvt, restoredExpEvt]) {
    await assert.rejects(
      () => prisma.$executeRawUnsafe(`UPDATE "AccountingEvent" SET summary = 'tamper' WHERE id = $1`, evt.id),
      /append-only/i
    );
    await assert.rejects(
      () => prisma.$executeRawUnsafe(`DELETE FROM "AccountingEvent" WHERE id = $1`, evt.id),
      /append-only/i
    );
  }
});
