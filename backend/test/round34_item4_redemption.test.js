import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import express from 'express';
import cookieParser from 'cookie-parser';
import prisma from '../src/prismaClient.js';
import authRoutes from '../src/routes/auth.js';
import reservationsRoutes from '../src/routes/reservations.js';
import checkoutRoutes from '../src/routes/checkout.js';
import billingRoutes from '../src/routes/billing.js';
import { generateToken } from '../src/middlewares/authMiddleware.js';
import { ensureTestPublishedLayout, cleanupTestPublishedLayout } from './helpers/seedTestLayout.js';
import { getBookingBill } from '../src/services/billing/billService.js';
import { runBackfillPromoRedemptions } from '../scripts/backfill-promo-redemptions.mjs';
import { dateOnly } from '../../shared/time.js';

function startLocalApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/auth', authRoutes);
  app.use('/api/reservations', reservationsRoutes);
  app.use('/api/checkout', checkoutRoutes);
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

test('Round 34 Item 4: PromoRedemption concurrency, exact code match, lifecycle release, archive delete, rename checks, and backfill', async (t) => {
  const runId = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const futureDate = dateOnly('2099-11-25');

  const raceCode = `R34RACE_${runId}`.toUpperCase();
  const codeA = `R34A_${runId}`.toUpperCase();
  const codeAB = `R34A_${runId}B`.toUpperCase(); // Starts with codeA! Tests exact match vs substring bug
  const posCode = `R34POSR_${runId}`.toUpperCase();
  const dupCode = `R34DUP_${runId}`.toUpperCase();

  let cust1 = null;
  let cust2 = null;
  let adminUser = null;
  let sessions = [];
  let dailyWd = null;
  let srv = null;
  let createdLayoutId = null;
  let origGlobal = null;
  const createdPromoIds = [];
  const createdRefs = [];

  t.after(async () => {
    if (srv) await srv.close().catch(() => {});
    if (createdPromoIds.length) {
      await prisma.promoRedemption.deleteMany({ where: { promo_id: { in: createdPromoIds } } }).catch(() => {});
    }
    if (createdRefs.length) {
      await prisma.promoRedemption.deleteMany({ where: { booking_ref: { in: createdRefs } } }).catch(() => {});
      await prisma.printJob.deleteMany({ where: { booking_ref: { in: createdRefs } } }).catch(() => {});
      await prisma.payment.deleteMany({ where: { booking_ref: { in: createdRefs } } }).catch(() => {});
      await prisma.bookingPerson.deleteMany({ where: { booking_ref: { in: createdRefs } } }).catch(() => {});
      await prisma.reservation.deleteMany({ where: { booking_ref: { in: createdRefs } } }).catch(() => {});
    }
    if (sessions.length) await prisma.session.deleteMany({ where: { id: { in: sessions.map((s) => s.id) } } }).catch(() => {});
    if (dailyWd) await prisma.dailySetting.delete({ where: { date: futureDate } }).catch(() => {});
    if (createdPromoIds.length) await prisma.promoCode.deleteMany({ where: { id: { in: createdPromoIds } } }).catch(() => {});
    if (cust1?.id) await prisma.user.delete({ where: { id: cust1.id } }).catch(() => {});
    if (cust2?.id) await prisma.user.delete({ where: { id: cust2.id } }).catch(() => {});
    if (adminUser?.id) await prisma.adminUser.delete({ where: { id: adminUser.id } }).catch(() => {});
    await cleanupTestPublishedLayout(prisma, createdLayoutId);
    if (origGlobal) {
      await prisma.globalSetting.update({
        where: { id: 1 },
        data: { max_active_bookings_per_user: origGlobal.max_active_bookings_per_user }
      }).catch(() => {});
    }
  });

  origGlobal = await prisma.globalSetting.findUnique({ where: { id: 1 } });
  await prisma.globalSetting.upsert({
    where: { id: 1 },
    update: { max_active_bookings_per_user: 0 },
    create: { id: 1, max_active_bookings_per_user: 0 }
  });
  createdLayoutId = await ensureTestPublishedLayout(prisma);
  srv = await startLocalApp();

  cust1 = await prisma.user.create({
    data: { line_user_id: `r34_i4_c1_${runId}`, name: 'R34會員一', phone: `09945${String(Date.now()).slice(-5)}` } // check-secrets: fake-data
  });
  cust2 = await prisma.user.create({
    data: { line_user_id: `r34_i4_c2_${runId}`, name: 'R34會員二', phone: `09946${String(Date.now()).slice(-5)}` } // check-secrets: fake-data
  });

  const adminPass = `r34_i4_adm_${runId}`;
  adminUser = await prisma.adminUser.create({
    data: { password: adminPass, name: `R34次數管理員_${runId}`, role: 'superadmin', permissions: ['all'], is_active: true }
  });

  const tok1 = generateToken({ id: cust1.id, typ: 'customer', line_user_id: cust1.line_user_id, role: 'customer' });
  const tok2 = generateToken({ id: cust2.id, typ: 'customer', line_user_id: cust2.line_user_id, role: 'customer' });
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

  for (const [start, end] of [['11:00', '12:00'], ['12:00', '13:00']]) {
    sessions.push(await prisma.session.create({
      data: { session_date: futureDate, start_time: start, end_time: end, max_capacity: 20 }
    }));
  }

  const pRace = await prisma.promoCode.create({
    data: { code: raceCode, name: '限量一次', discount_type: 'fixed_order', discount_value: 50, max_uses: 1, channel: 'all', is_active: true }
  });
  const pA = await prisma.promoCode.create({
    data: { code: codeA, name: '碼A', discount_type: 'fixed_order', discount_value: 30, max_uses_per_user: 1, channel: 'all', is_active: true }
  });
  const pAB = await prisma.promoCode.create({
    data: { code: codeAB, name: '碼AB', discount_type: 'fixed_order', discount_value: 40, max_uses_per_user: 1, channel: 'all', is_active: true }
  });
  const pPos = await prisma.promoCode.create({
    data: { code: posCode, name: '櫃檯碼', discount_type: 'fixed_order', discount_value: 50, channel: 'pos', is_active: true }
  });
  const pDup = await prisma.promoCode.create({
    data: { code: dupCode, name: '既有碼', discount_type: 'fixed_order', discount_value: 10, channel: 'pos', is_active: true }
  });
  createdPromoIds.push(pRace.id, pA.id, pAB.id, pPos.id, pDup.id);

  // 1) max_uses: 1, Promise.all concurrent bookings -> one 201, one 400, used_count === 1
  const [raceRes1, raceRes2] = await Promise.all([
    fetch(`${srv.baseUrl}/api/reservations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok1}` },
      body: JSON.stringify({ session_ids: [sessions[0].id], pax: 1, isUnlimited: false, promo_code: raceCode })
    }),
    fetch(`${srv.baseUrl}/api/reservations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok2}` },
      body: JSON.stringify({ session_ids: [sessions[0].id], pax: 1, isUnlimited: false, promo_code: raceCode })
    })
  ]);
  const statuses = [raceRes1.status, raceRes2.status].sort();
  assert.deepEqual(statuses, [201, 400]);
  const r1j = await raceRes1.json();
  const r2j = await raceRes2.json();
  if (r1j.reservation?.booking_ref) createdRefs.push(r1j.reservation.booking_ref);
  if (r2j.reservation?.booking_ref) createdRefs.push(r2j.reservation.booking_ref);
  const pRaceAfter = await prisma.promoCode.findUnique({ where: { id: pRace.id } });
  assert.equal(pRaceAfter.used_count, 1);

  // 2) max_uses_per_user: 1 — cust1 uses codeA, then uses codeAB (201!), then tries codeA again (400!)
  const useARes = await fetch(`${srv.baseUrl}/api/reservations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok1}` },
    body: JSON.stringify({ session_ids: [sessions[0].id], pax: 1, isUnlimited: false, promo_code: codeA })
  });
  assert.equal(useARes.status, 201);
  const refA = (await useARes.json()).reservation.booking_ref;
  createdRefs.push(refA);

  const useABRes = await fetch(`${srv.baseUrl}/api/reservations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok1}` },
    body: JSON.stringify({ session_ids: [sessions[0].id], pax: 1, isUnlimited: false, promo_code: codeAB })
  });
  assert.equal(useABRes.status, 201);
  const refAB = (await useABRes.json()).reservation.booking_ref;
  createdRefs.push(refAB);

  const useA2Res = await fetch(`${srv.baseUrl}/api/reservations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok1}` },
    body: JSON.stringify({ session_ids: [sessions[0].id], pax: 1, isUnlimited: false, promo_code: codeA })
  });
  assert.equal(useA2Res.status, 400);

  // 3) Online booking refA collected at POS -> used_count stays 1 (not 2)
  const billA = await getBookingBill(refA, prisma);
  const payARes = await fetch(`${srv.baseUrl}/api/billing/${refA}/collect`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({
      person_nos: [1],
      method: 'cash',
      cash_received: billA.bill.summary.amount_due,
      expected_amount: billA.bill.summary.amount_due,
      client_batch_id: `r34-i4-payA-${runId}`
    })
  });
  assert.equal(payARes.status, 200);
  const payAJson = await payARes.json();
  const pAAfterPay = await prisma.promoCode.findUnique({ where: { id: pA.id } });
  assert.equal(pAAfterPay.used_count, 1);

  // 4) Void payment on online booking refA -> used_count still 1; cancel booking refA -> used_count becomes 0 and cust1 can reuse codeA!
  const voidARes = await fetch(`${srv.baseUrl}/api/billing/payments/${payAJson.payments[0].id}/void`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ reason: '測作廢' })
  });
  assert.equal(voidARes.status, 200);
  assert.equal((await prisma.promoCode.findUnique({ where: { id: pA.id } })).used_count, 1);

  const cancelARes = await fetch(`${srv.baseUrl}/api/reservations/${refA}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${tok1}` }
  });
  assert.equal(cancelARes.status, 200);
  assert.equal((await prisma.promoCode.findUnique({ where: { id: pA.id } })).used_count, 0);

  const reuseARes = await fetch(`${srv.baseUrl}/api/reservations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok1}` },
    body: JSON.stringify({ session_ids: [sessions[0].id], pax: 1, isUnlimited: false, promo_code: codeA })
  });
  assert.equal(reuseARes.status, 201);
  createdRefs.push((await reuseARes.json()).reservation.booking_ref);

  // 5) POS promo applied on non-promo booking and collected -> used_count 1; void payment -> used_count 0
  const plainRes = await fetch(`${srv.baseUrl}/api/reservations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok2}` },
    body: JSON.stringify({ session_ids: [sessions[0].id], pax: 1, isUnlimited: false })
  });
  assert.equal(plainRes.status, 201);
  const refPlain = (await plainRes.json()).reservation.booking_ref;
  createdRefs.push(refPlain);

  const addPosRes = await fetch(`${srv.baseUrl}/api/billing/${refPlain}/promos`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ code: posCode, base_rev: 1 })
  });
  assert.equal(addPosRes.status, 200);
  assert.equal((await prisma.promoCode.findUnique({ where: { id: pPos.id } })).used_count, 0);

  const collectPlainRes = await fetch(`${srv.baseUrl}/api/billing/${refPlain}/collect`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({
      person_nos: [1],
      method: 'cash',
      cash_received: 100,
      expected_amount: 100,
      client_batch_id: `r34-i4-pos-${runId}`
    })
  });
  assert.equal(collectPlainRes.status, 200);
  const collectPlainJson = await collectPlainRes.json();
  assert.equal((await prisma.promoCode.findUnique({ where: { id: pPos.id } })).used_count, 1);

  const voidPlainRes = await fetch(`${srv.baseUrl}/api/billing/payments/${collectPlainJson.payments[0].id}/void`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ reason: '測作廢POS' })
  });
  assert.equal(voidPlainRes.status, 200);
  assert.equal((await prisma.promoCode.findUnique({ where: { id: pPos.id } })).used_count, 0);

  // 6) Archive (soft delete) keeps row & is_active=false; unpaid booking draft total unchanged
  const billABBefore = await getBookingBill(refAB, prisma);
  const delABRes = await fetch(`${srv.baseUrl}/api/checkout/promo-codes/${pAB.id}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${adminToken}` }
  });
  assert.equal(delABRes.status, 200);
  const pABRow = await prisma.promoCode.findUnique({ where: { id: pAB.id } });
  assert.ok(pABRow);
  assert.equal(pABRow.is_active, false);
  assert.ok(pABRow.archived_at);
  const billABAfter = await getBookingBill(refAB, prisma);
  assert.equal(billABAfter.bill.summary.amount_due, billABBefore.bill.summary.amount_due);

  // 7) Rename validation: rename to existing code -> 409; rename promo with redemption history -> 422
  const dupCreate = await fetch(`${srv.baseUrl}/api/checkout/promo-codes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ code: dupCode, name: '撞碼', discount_type: 'fixed_order', discount_value: 10 })
  });
  assert.equal(dupCreate.status, 409);

  const dupRename = await fetch(`${srv.baseUrl}/api/checkout/promo-codes/${pDup.id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ code: posCode })
  });
  assert.equal(dupRename.status, 409);

  const usedRename = await fetch(`${srv.baseUrl}/api/checkout/promo-codes/${pA.id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ code: `R34NEW_${runId}` })
  });
  assert.equal(usedRename.status, 422);

  // 8) Backfill script: put 3 legacy reservations without PromoRedemption (two A, one AB), verify exact dry-run count
  const legCodeA = `R34LGA_${runId}`.toUpperCase();
  const legCodeAB = `R34LGA_${runId}B`.toUpperCase();
  const pLegA = await prisma.promoCode.create({ data: { code: legCodeA, name: '舊A', discount_type: 'fixed_order', discount_value: 10, is_active: true } });
  const pLegAB = await prisma.promoCode.create({ data: { code: legCodeAB, name: '舊AB', discount_type: 'fixed_order', discount_value: 10, is_active: true } });
  createdPromoIds.push(pLegA.id, pLegAB.id);

  for (let i = 1; i <= 2; i++) {
    const ref = `R34-I4-LGA-${i}-${runId}`;
    createdRefs.push(ref);
    await prisma.reservation.create({
      data: { booking_ref: ref, session_id: sessions[1].id, user_id: cust1.id, pax: 1, status: 'confirmed', promo_code: legCodeA }
    });
  }
  const refLgAB = `R34-I4-LGAB-${runId}`;
  createdRefs.push(refLgAB);
  await prisma.reservation.create({
    data: { booking_ref: refLgAB, session_id: sessions[1].id, user_id: cust1.id, pax: 1, status: 'confirmed', promo_code: legCodeAB }
  });

  const bfDry = await runBackfillPromoRedemptions({ apply: false, client: prisma });
  const sumA = bfDry.summary.find((s) => s.code === legCodeA);
  const sumAB = bfDry.summary.find((s) => s.code === legCodeAB);
  assert.equal(sumA.derived_count, 2);
  assert.equal(sumAB.derived_count, 1);
});
