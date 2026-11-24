import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import express from 'express';
import cookieParser from 'cookie-parser';
import prisma from '../src/prismaClient.js';
import authRoutes from '../src/routes/auth.js';
import checkoutRoutes from '../src/routes/checkout.js';
import billingRoutes from '../src/routes/billing.js';
import { generateToken } from '../src/middlewares/authMiddleware.js';
import { dateOnly } from '../../shared/time.js';

function startLocalApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/auth', authRoutes);
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

test('Round 34 Item 2: server-side POS billing promos, validation limits, duplicate 409, and saveDraft tamper rejection', async (t) => {
  const runId = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  // 2099-11-25 is Wednesday (weekday); 2099-11-28 is Saturday (weekend)
  const weekdayDate = dateOnly('2099-11-25');
  const saturdayDate = dateOnly('2099-11-28');

  const refWeekday = `R34-I2-WD-${runId}`;
  const refSaturday = `R34-I2-SAT-${runId}`;
  const refPrevUsed = `R34-I2-PREV-${runId}`;

  const posCode = `R34POS200_${runId}`.toUpperCase();
  const weekdayOnlyCode = `R34WDONLY_${runId}`.toUpperCase();
  const min1000Code = `R34MIN1K_${runId}`.toUpperCase();
  const onceUserCode = `R34ONCE_${runId}`.toUpperCase();
  const pct10Code = `R34PCT10_${runId}`.toUpperCase();

  let customer = null;
  let adminUser = null;
  let sessionsWd = [];
  let sessionsSat = [];
  let dailyWd = null;
  let dailySat = null;
  const createdPromoIds = [];
  let srv = null;

  t.after(async () => {
    if (srv) await srv.close().catch(() => {});
    const refs = [refWeekday, refSaturday, refPrevUsed];
    await prisma.payment.deleteMany({ where: { booking_ref: { in: refs } } }).catch(() => {});
    await prisma.bookingPerson.deleteMany({ where: { booking_ref: { in: refs } } }).catch(() => {});
    await prisma.reservation.deleteMany({ where: { booking_ref: { in: refs } } }).catch(() => {});
    const sIds = [...sessionsWd, ...sessionsSat].map((s) => s.id);
    if (sIds.length) await prisma.session.deleteMany({ where: { id: { in: sIds } } }).catch(() => {});
    if (dailyWd) await prisma.dailySetting.delete({ where: { date: weekdayDate } }).catch(() => {});
    if (dailySat) await prisma.dailySetting.delete({ where: { date: saturdayDate } }).catch(() => {});
    if (createdPromoIds.length) await prisma.promoCode.deleteMany({ where: { id: { in: createdPromoIds } } }).catch(() => {});
    if (customer?.id) await prisma.user.delete({ where: { id: customer.id } }).catch(() => {});
    if (adminUser?.id) await prisma.adminUser.delete({ where: { id: adminUser.id } }).catch(() => {});
  });

  srv = await startLocalApp();

  customer = await prisma.user.create({
    data: {
      line_user_id: `r34_i2_cust_${runId}`,
      name: 'R34櫃檯優惠測試員',
      phone: `09942${String(Date.now()).slice(-5)}` // check-secrets: fake-data
    }
  });

  const adminPass = `r34_i2_adm_pw_${runId}`;
  adminUser = await prisma.adminUser.create({
    data: {
      password: adminPass,
      name: `R34櫃檯管理員_${runId}`,
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
    where: { date: weekdayDate },
    update: { hourly_price: 150, unlimited_price: 750, allow_unlimited: true, is_self_service: false },
    create: { date: weekdayDate, hourly_price: 150, unlimited_price: 750, allow_unlimited: true, is_self_service: false }
  });
  dailySat = await prisma.dailySetting.upsert({
    where: { date: saturdayDate },
    update: { hourly_price: 150, unlimited_price: 750, allow_unlimited: true, is_self_service: false },
    create: { date: saturdayDate, hourly_price: 150, unlimited_price: 750, allow_unlimited: true, is_self_service: false }
  });

  for (const [start, end] of [['13:00', '14:00'], ['14:00', '15:00'], ['15:00', '16:00']]) {
    sessionsWd.push(await prisma.session.create({
      data: { session_date: weekdayDate, start_time: start, end_time: end, max_capacity: 20 }
    }));
    sessionsSat.push(await prisma.session.create({
      data: { session_date: saturdayDate, start_time: start, end_time: end, max_capacity: 20 }
    }));
  }

  // Booking on weekday: 2 pax * 3h * 150 = 900
  for (const s of sessionsWd) {
    await prisma.reservation.create({
      data: {
        booking_ref: refWeekday,
        session_id: s.id,
        user_id: customer.id,
        pax: 2,
        status: 'confirmed',
        assigned_seats: ['A1-1', 'A1-2'],
        total_amount: 900
      }
    });
  }
  // Booking on Saturday: 2 pax * 3h * 150 = 900
  for (const s of sessionsSat) {
    await prisma.reservation.create({
      data: {
        booking_ref: refSaturday,
        session_id: s.id,
        user_id: customer.id,
        pax: 2,
        status: 'confirmed',
        assigned_seats: ['A2-1', 'A2-2'],
        total_amount: 900
      }
    });
  }
  // Previous confirmed booking by same customer using onceUserCode
  await prisma.reservation.create({
    data: {
      booking_ref: refPrevUsed,
      session_id: sessionsWd[0].id,
      user_id: customer.id,
      pax: 1,
      status: 'confirmed',
      assigned_seats: ['A3-1'],
      total_amount: 150,
      promo_code: onceUserCode
    }
  });

  // 1) Create channel:'pos' fixed_order 200 via /api/checkout/promo-codes (same payload as QuickPromoModal)
  const createPosRes = await fetch(`${srv.baseUrl}/api/checkout/promo-codes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({
      code: posCode,
      name: '櫃檯現折200',
      discount_type: 'fixed_order',
      discount_value: 200,
      channel: 'pos',
      is_pos_quick_select: true,
      is_active: true
    })
  });
  assert.equal(createPosRes.status, 201);
  createdPromoIds.push((await createPosRes.json()).id);

  const pWdOnly = await prisma.promoCode.create({
    data: { code: weekdayOnlyCode, name: '限平日50', discount_type: 'fixed_order', discount_value: 50, day_type_limit: 'weekday', channel: 'all', is_active: true }
  });
  const pMin1K = await prisma.promoCode.create({
    data: { code: min1000Code, name: '滿千折百', discount_type: 'fixed_order', discount_value: 100, min_amount: 1000, channel: 'all', is_active: true }
  });
  const pOnce = await prisma.promoCode.create({
    data: { code: onceUserCode, name: '每人一次', discount_type: 'fixed_order', discount_value: 50, max_uses_per_user: 1, channel: 'all', is_active: true }
  });
  const pPct10 = await prisma.promoCode.create({
    data: { code: pct10Code, name: '九折', discount_type: 'percentage', discount_value: 10, channel: 'all', is_active: true }
  });
  createdPromoIds.push(pWdOnly.id, pMin1K.id, pOnce.id, pPct10.id);

  // Customer validate on POS-only code -> 400; customer validate sending is_pos:true in body -> STILL 400 (body ignored)
  const custPosRes = await fetch(`${srv.baseUrl}/api/checkout/promo-codes/validate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${custToken}` },
    body: JSON.stringify({ code: posCode, base_amount: 900, pax: 2, hours: 3 })
  });
  assert.equal(custPosRes.status, 400);
  const custPosJson = await custPosRes.json();
  assert.ok(custPosJson.error.includes('僅供現場櫃檯'));

  const spoofPosRes = await fetch(`${srv.baseUrl}/api/checkout/promo-codes/validate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${custToken}` },
    body: JSON.stringify({ code: posCode, base_amount: 900, pax: 2, hours: 3, is_pos: true })
  });
  assert.equal(spoofPosRes.status, 400);

  // Apply POS promo to refWeekday via POST /api/billing/:ref/promos -> 200, discounts 200 (amount_due 700)
  const addPosRes = await fetch(`${srv.baseUrl}/api/billing/${refWeekday}/promos`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ code: posCode, base_rev: 0 })
  });
  assert.equal(addPosRes.status, 200);
  const addPosJson = await addPosRes.json();
  assert.equal(addPosJson.bill.summary.discounts_total, 200);
  assert.equal(addPosJson.bill.summary.amount_due, 700);
  assert.equal(addPosJson.rev, 1);

  // Same promo applied twice -> 409
  const dupRes = await fetch(`${srv.baseUrl}/api/billing/${refWeekday}/promos`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ code: posCode, base_rev: 1 })
  });
  assert.equal(dupRes.status, 409);

  // Remove promo -> 200, amount_due back to 900
  const delRes = await fetch(`${srv.baseUrl}/api/billing/${refWeekday}/promos/${posCode}`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ base_rev: 1 })
  });
  assert.equal(delRes.status, 200);
  const delJson = await delRes.json();
  assert.equal(delJson.bill.summary.amount_due, 900);
  assert.equal(delJson.rev, 2);

  // Weekday-only promo applied to Saturday booking -> 400
  const satFailRes = await fetch(`${srv.baseUrl}/api/billing/${refSaturday}/promos`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ code: weekdayOnlyCode, base_rev: 0 })
  });
  assert.equal(satFailRes.status, 400);

  // Min amount 1000 on 900 bill -> 400
  const minFailRes = await fetch(`${srv.baseUrl}/api/billing/${refWeekday}/promos`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ code: min1000Code, base_rev: 2 })
  });
  assert.equal(minFailRes.status, 400);

  // max_uses_per_user: 1 when booking customer already used it (staff has not) -> 400
  const onceFailRes = await fetch(`${srv.baseUrl}/api/billing/${refWeekday}/promos`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ code: onceUserCode, base_rev: 2 })
  });
  assert.equal(onceFailRes.status, 400);

  // Apply 10% promo then tamper order_promos via saveDraft (attempt pct_off: 100) -> server keeps pct_off: 10
  const addPctRes = await fetch(`${srv.baseUrl}/api/billing/${refWeekday}/promos`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ code: pct10Code, base_rev: 2 })
  });
  assert.equal(addPctRes.status, 200);
  const addPctJson = await addPctRes.json();
  assert.equal(addPctJson.bill.summary.discounts_total, 90);
  assert.equal(addPctJson.rev, 3);

  const tamperedOrderPromos = addPctJson.draft.order_promos.map((op) => ({ ...op, pct_off: 100 }));
  const draftRes = await fetch(`${srv.baseUrl}/api/billing/${refWeekday}/draft`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({
      base_rev: 3,
      draft: {
        ...addPctJson.draft,
        order_promos: tamperedOrderPromos
      }
    })
  });
  assert.equal(draftRes.status, 200);
  const draftJson = await draftRes.json();
  assert.equal(draftJson.draft.order_promos[0].pct_off, 10);
  assert.equal(draftJson.bill.summary.discounts_total, 90);
  assert.equal(draftJson.bill.summary.amount_due, 810);
});
