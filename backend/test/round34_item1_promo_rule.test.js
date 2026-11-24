import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import express from 'express';
import cookieParser from 'cookie-parser';
import prisma from '../src/prismaClient.js';
import authRoutes from '../src/routes/auth.js';
import reservationRoutes from '../src/routes/reservations.js';
import { generateToken } from '../src/middlewares/authMiddleware.js';
import { evaluatePromoCode } from '../src/controllers/checkoutController.js';
import { getBookingBill } from '../src/services/billing/billService.js';
import { runMigratePromoDrafts } from '../scripts/migrate-promo-drafts.mjs';
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

test('Round 34 Item 1: unified promo evaluation, self-service consistency, legacy reconcile compat, and migration script', async (t) => {
  const runId = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  // 2099-11-25 is a Wednesday (weekday)
  const weekdayDate = dateOnly('2099-11-25');
  // 2099-11-26 is a Thursday (self-service test day)
  const selfDate = dateOnly('2099-11-26');

  const weekdayRef = `R34-I1-WD-${runId}`;
  const selfLegacyRef = `R34-I1-SL-${runId}`;
  const selfPendingRef = `R34-I1-SP-${runId}`;

  const promoPct90Code = `R34P90_${runId}`.toUpperCase();
  const promoPct20Cap30Code = `R34C30_${runId}`.toUpperCase();
  const promoFree1HCode = `R34FH1_${runId}`.toUpperCase();

  let customer = null;
  let adminUser = null;
  let normalSessions = [];
  let selfSessions = [];
  let dailySelf = null;
  let dailyWeekday = null;
  const createdPromoIds = [];
  let srv = null;

  t.after(async () => {
    if (srv) await srv.close().catch(() => {});
    const refs = [weekdayRef, selfLegacyRef, selfPendingRef];
    await prisma.payment.deleteMany({ where: { booking_ref: { in: refs } } }).catch(() => {});
    await prisma.bookingPrepay.deleteMany({ where: { booking_ref: { in: refs } } }).catch(() => {});
    await prisma.bookingPerson.deleteMany({ where: { booking_ref: { in: refs } } }).catch(() => {});
    await prisma.reservation.deleteMany({ where: { booking_ref: { in: refs } } }).catch(() => {});
    const sIds = [...normalSessions, ...selfSessions].map((s) => s.id);
    if (sIds.length) await prisma.session.deleteMany({ where: { id: { in: sIds } } }).catch(() => {});
    if (dailySelf) await prisma.dailySetting.delete({ where: { date: selfDate } }).catch(() => {});
    if (dailyWeekday) await prisma.dailySetting.delete({ where: { date: weekdayDate } }).catch(() => {});
    if (createdPromoIds.length) await prisma.promoCode.deleteMany({ where: { id: { in: createdPromoIds } } }).catch(() => {});
    if (customer?.id) await prisma.user.delete({ where: { id: customer.id } }).catch(() => {});
    if (adminUser?.id) await prisma.adminUser.delete({ where: { id: adminUser.id } }).catch(() => {});
  });

  srv = await startLocalApp();

  customer = await prisma.user.create({
    data: {
      line_user_id: `r34_i1_cust_${runId}`,
      name: 'R34測試顧客',
      phone: `09941${String(Date.now()).slice(-5)}` // check-secrets: fake-data
    }
  });
  const adminPass = `r34_i1_adm_pw_${runId}`;
  adminUser = await prisma.adminUser.create({
    data: {
      password: adminPass,
      name: `R34管理員_${runId}`,
      role: 'superadmin',
      permissions: ['all'],
      is_active: true
    }
  });

  const custToken = generateToken({ id: customer.id, typ: 'customer', line_user_id: customer.line_user_id, role: 'customer' });
  const adminLoginRes = await fetch(`${srv.baseUrl}/api/auth/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: adminPass })
  });
  assert.equal(adminLoginRes.status, 200);
  const { token: adminToken } = await adminLoginRes.json();

  dailyWeekday = await prisma.dailySetting.upsert({
    where: { date: weekdayDate },
    update: { hourly_price: 150, unlimited_price: 750, allow_unlimited: true, is_self_service: false },
    create: { date: weekdayDate, hourly_price: 150, unlimited_price: 750, allow_unlimited: true, is_self_service: false }
  });
  dailySelf = await prisma.dailySetting.upsert({
    where: { date: selfDate },
    update: { hourly_price: 150, unlimited_price: 750, allow_unlimited: true, is_self_service: true },
    create: { date: selfDate, hourly_price: 150, unlimited_price: 750, allow_unlimited: true, is_self_service: true }
  });

  for (const [start, end] of [['13:00', '14:00'], ['14:00', '15:00'], ['15:00', '16:00']]) {
    normalSessions.push(await prisma.session.create({
      data: { session_date: weekdayDate, start_time: start, end_time: end, max_capacity: 20 }
    }));
    selfSessions.push(await prisma.session.create({
      data: { session_date: selfDate, start_time: start, end_time: end, max_capacity: 20 }
    }));
  }

  const p90 = await prisma.promoCode.create({
    data: { code: promoPct90Code, name: '九折', discount_type: 'percentage', discount_value: 90, channel: 'all', is_active: true }
  });
  const pCap = await prisma.promoCode.create({
    data: { code: promoPct20Cap30Code, name: '八折上限30', discount_type: 'percentage', discount_value: 20, max_discount_amount: 30, channel: 'all', is_active: true }
  });
  const pFh = await prisma.promoCode.create({
    data: { code: promoFree1HCode, name: '送1小時', discount_type: 'free_hours', discount_value: 1, channel: 'all', is_active: true }
  });
  createdPromoIds.push(p90.id, pCap.id, pFh.id);

  // Create normal-day booking initially with legacy draft (no rule_v)
  for (const s of normalSessions) {
    await prisma.reservation.create({
      data: {
        booking_ref: weekdayRef,
        session_id: s.id,
        user_id: customer.id,
        pax: 2,
        status: 'confirmed',
        assigned_seats: ['A1-1', 'A1-2'],
        total_amount: 90,
        promo_code: promoPct90Code,
        discount_amount: 810,
        checkout_details: {
          version: 2,
          rev: 1,
          persons: [
            { person_no: 1, mode: 'hourly' },
            { person_no: 2, mode: 'hourly' }
          ],
          order_addons: [],
          order_promos: [
            { code: promoPct90Code, name: '九折', discount_type: 'percentage', discount_value: 90, target_scope: 'all' }
          ]
        }
      }
    });
  }

  // 1) Parity check for percentage 90, percentage 20 cap 30, free_hours 1 -> expected 90, 30, 150
  const cases = [
    { code: promoPct90Code, expected: 90 },
    { code: promoPct20Cap30Code, expected: 30 },
    { code: promoFree1HCode, expected: 150 }
  ];
  for (const tc of cases) {
    const evalRes = await evaluatePromoCode(prisma, {
      code: tc.code,
      session_date: weekdayDate,
      pax: 2,
      hours: 3,
      is_unlimited: false,
      base_amount: 900,
      hourly_price: 150,
      user_id: customer.id,
      seating_amount: 900,
      equipment_amount: 0
    });
    assert.equal(evalRes.valid, true);
    assert.equal(evalRes.discount_amount, tc.expected);
    assert.equal(evalRes.rule.rule_v, 2);

    // Put rule into draft and verify getBookingBill discounts_total matches evaluatePromoCode
    await prisma.reservation.updateMany({
      where: { booking_ref: weekdayRef },
      data: {
        checkout_details: {
          version: 2,
          rev: 2,
          persons: [{ person_no: 1, mode: 'hourly' }, { person_no: 2, mode: 'hourly' }],
          order_addons: [],
          order_promos: [evalRes.rule]
        }
      }
    });
    const billRes = await getBookingBill(weekdayRef, prisma);
    assert.equal(billRes.bill.summary.discounts_total, evalRes.discount_amount);
    assert.equal(billRes.bill.summary.discounts_total, tc.expected);
  }

  // Restore legacy draft on weekdayRef for migration script test below
  await prisma.reservation.updateMany({
    where: { booking_ref: weekdayRef },
    data: {
      checkout_details: {
        version: 2,
        rev: 1,
        persons: [{ person_no: 1, mode: 'hourly' }, { person_no: 2, mode: 'hourly' }],
        order_addons: [],
        order_promos: [
          { code: promoPct90Code, name: '九折', discount_type: 'percentage', discount_value: 90, target_scope: 'all' }
        ]
      }
    }
  });

  // 2) Self-service quote with percentage 90 (2 pax unlimited 750*2 = 1500 -> promo.discount === 150, total === 1350, no PROMO_MISMATCH)
  const quoteRes = await fetch(`${srv.baseUrl}/api/reservations/prepay-quote`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${custToken}` },
    body: JSON.stringify({
      session_ids: selfSessions.map((s) => s.id),
      pax: 2,
      isUnlimited: true,
      promo_code: promoPct90Code,
      equipments: [],
      pass_uses: []
    })
  });
  assert.equal(quoteRes.status, 200);
  const quoteJson = await quoteRes.json();
  assert.equal(quoteJson.errors.length, 0);
  assert.equal(quoteJson.promo?.discount, 150);
  assert.equal(quoteJson.total_amount, 1350);

  // 3) Legacy self-service booking (no rule_v in draft, amount_due = 90 by old computeBill 90% off) -> admin verify succeeds (200, not 409)
  const legacySelfDraft = {
    version: 2,
    rev: 1,
    persons: [{ person_no: 1, mode: 'hourly' }, { person_no: 2, mode: 'hourly' }],
    order_addons: [],
    order_promos: [
      { code: promoPct90Code, name: '九折', discount_type: 'percentage', discount_value: 90, target_scope: 'all', person_nos: [1, 2] }
    ]
  };
  for (const s of selfSessions) {
    await prisma.reservation.create({
      data: {
        booking_ref: selfLegacyRef,
        session_id: s.id,
        user_id: customer.id,
        pax: 2,
        status: 'confirmed',
        is_self_service: true,
        assigned_seats: ['B1-1', 'B1-2'],
        total_amount: 90,
        promo_code: promoPct90Code,
        discount_amount: 810,
        checkout_details: legacySelfDraft
      }
    });
  }
  await prisma.bookingPrepay.create({
    data: {
      booking_ref: selfLegacyRef,
      user_id: customer.id,
      payment_method_code: 'transfer',
      total_amount: 90,
      amount_due: 90,
      status: 'reported_pending_verify',
      remittance_last5: '12345',
      deadline_at: new Date('2099-11-25T04:00:00Z'),
      pricing_snapshot: { hourly: 150, unlimited: 750, allow_unlimited: true, is_weekend: false }
    }
  });

  const verifyRes = await fetch(`${srv.baseUrl}/api/reservations/admin/prepays/${selfLegacyRef}/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({})
  });
  assert.equal(verifyRes.status, 200);

  // Also create a pending_payment self-service legacy booking to confirm migration excludes it
  for (const s of selfSessions) {
    await prisma.reservation.create({
      data: {
        booking_ref: selfPendingRef,
        session_id: s.id,
        user_id: customer.id,
        pax: 2,
        status: 'confirmed',
        is_self_service: true,
        assigned_seats: ['B2-1', 'B2-2'],
        total_amount: 90,
        promo_code: promoPct90Code,
        discount_amount: 810,
        checkout_details: legacySelfDraft
      }
    });
  }
  await prisma.bookingPrepay.create({
    data: {
      booking_ref: selfPendingRef,
      user_id: customer.id,
      payment_method_code: 'transfer',
      total_amount: 90,
      amount_due: 90,
      status: 'pending_payment',
      deadline_at: new Date('2099-11-25T04:00:00Z'),
      pricing_snapshot: { hourly: 150, unlimited: 750, allow_unlimited: true, is_weekend: false }
    }
  });

  // 4) Migration script dry-run & apply
  const dryRun = await runMigratePromoDrafts({ apply: false, client: prisma });
  const dryRefs = dryRun.items.map((it) => it.booking_ref);
  assert.ok(dryRefs.includes(weekdayRef), 'Dry-run should include normal-day legacy draft');
  assert.ok(!dryRefs.includes(selfPendingRef), 'Dry-run must exclude pending_payment self-service draft');
  const wdDry = dryRun.items.find((it) => it.booking_ref === weekdayRef);
  assert.equal(wdDry.old_amount_due, 90);
  assert.equal(wdDry.new_amount_due, 810);

  const applyRes = await runMigratePromoDrafts({ apply: true, client: prisma });
  assert.ok(applyRes.migrated >= 1);

  const afterBill = await getBookingBill(weekdayRef, prisma);
  assert.equal(afterBill.bill.summary.amount_due, 810);

  const pendingAfterBill = await getBookingBill(selfPendingRef, prisma);
  assert.equal(pendingAfterBill.bill.summary.amount_due, 90);

  const migEvent = await prisma.accountingEvent.findFirst({
    where: { booking_ref: weekdayRef, event_type: 'promo_rule_migrated' }
  });
  assert.ok(migEvent, 'AccountingEvent promo_rule_migrated should be logged');
});
