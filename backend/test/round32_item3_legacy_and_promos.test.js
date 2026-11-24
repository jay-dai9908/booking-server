import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { execFile } from 'child_process';
import { promisify } from 'util';
import express from 'express';
import cookieParser from 'cookie-parser';
import prisma from '../src/prismaClient.js';
import authRoutes from '../src/routes/auth.js';
import checkoutRoutes from '../src/routes/checkout.js';
import reservationRoutes from '../src/routes/reservations.js';
import { DEFAULT_PROMO_CODES, ensureDefaultCheckoutConfigs } from '../src/controllers/checkoutController.js';
import { dateOnly } from '../../shared/time.js';

const execFileAsync = promisify(execFile);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const backendDir = path.resolve(__dirname, '..');

function startLocalApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/auth', authRoutes);
  app.use('/api/checkout', checkoutRoutes);
  app.use('/api/reservations', reservationRoutes);

  const server = http.createServer(app);
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', (err) => {
      if (err) return reject(err);
      const port = server.address().port;
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        close: () => new Promise((res) => server.close(res))
      });
    });
  });
}

test('Round 32 Item 3: legacy checkout endpoint returns 410 and default promos are POS-only with migration script', async (t) => {
  const runId = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const futureDateStr = '2099-11-22';
  const futureDate = dateOnly(futureDateStr);
  const bookingRef = `R32-I3-${runId}`;

  let savedPromos = [];
  let savedDaily = null;
  let savedGlobal = null;
  let createdSession = null;
  let customer = null;
  let couponStaff = null;
  let srv = null;

  t.after(async () => {
    if (srv) await srv.close().catch(() => {});
    await prisma.reservation.deleteMany({ where: { booking_ref: bookingRef } }).catch(() => {});
    if (createdSession?.id) {
      await prisma.session.delete({ where: { id: createdSession.id } }).catch(() => {});
    }
    if (customer?.id) {
      await prisma.user.delete({ where: { id: customer.id } }).catch(() => {});
    }
    if (couponStaff?.id) {
      await prisma.adminUser.delete({ where: { id: couponStaff.id } }).catch(() => {});
    }
    if (savedDaily) {
      await prisma.dailySetting.update({
        where: { date: futureDate },
        data: { is_self_service: savedDaily.is_self_service }
      }).catch(() => {});
    } else {
      await prisma.dailySetting.deleteMany({ where: { date: futureDate } }).catch(() => {});
    }
    if (!savedGlobal) {
      await prisma.globalSetting.deleteMany({ where: { id: 1 } }).catch(() => {});
    }

    await prisma.promoCode.deleteMany({});
    if (savedPromos.length > 0) {
      for (const p of savedPromos) {
        const { id, ...rest } = p;
        await prisma.promoCode.create({ data: rest }).catch(() => {});
      }
    }
  });

  savedPromos = await prisma.promoCode.findMany();
  savedDaily = await prisma.dailySetting.findUnique({ where: { date: futureDate } });
  savedGlobal = await prisma.globalSetting.findUnique({ where: { id: 1 } });
  if (!savedGlobal) {
    await prisma.globalSetting.create({ data: { id: 1 } });
  }
  await prisma.dailySetting.upsert({
    where: { date: futureDate },
    update: { is_self_service: true },
    create: { date: futureDate, is_self_service: true }
  });

  createdSession = await prisma.session.findUnique({
    where: { session_date_start_time: { session_date: futureDate, start_time: '14:00' } }
  });
  if (!createdSession) {
    createdSession = await prisma.session.create({
      data: { session_date: futureDate, start_time: '14:00', end_time: '15:00', max_capacity: 16 }
    });
  } else {
    createdSession = null;
  }
  const sessionRow = createdSession || await prisma.session.findUnique({
    where: { session_date_start_time: { session_date: futureDate, start_time: '14:00' } }
  });

  customer = await prisma.user.create({
    data: {
      line_user_id: `U_r32_i3_${runId}`,
      name: 'R32 I3 Customer',
      phone: '0900000323'
    }
  });

  const staffPass = `r32_i3_pass_${runId}`;
  couponStaff = await prisma.adminUser.create({
    data: {
      name: 'R32 I3 Coupon Staff',
      password: staffPass,
      role: 'staff',
      permissions: ['coupons'],
      is_active: true
    }
  });

  await prisma.reservation.create({
    data: {
      booking_ref: bookingRef,
      session_id: sessionRow.id,
      user_id: customer.id,
      pax: 2,
      status: 'confirmed',
      is_paid: false,
      total_amount: 400,
      billing_status: 'unpaid'
    }
  });

  srv = await startLocalApp();
  const baseUrl = srv.baseUrl;

  const loginAdmin = await fetch(`${baseUrl}/api/auth/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: staffPass })
  });
  assert.equal(loginAdmin.status, 200);
  const { token: staffToken } = await loginAdmin.json();

  const loginCust = await fetch(`${baseUrl}/api/auth/test-login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: customer.id, role: 'customer' })
  });
  assert.equal(loginCust.status, 200);
  const { token: custToken } = await loginCust.json();

  // 1. Legacy endpoint POST /api/checkout/reservations/:ref returns 410 and leaves reservation untouched
  const legacyRes = await fetch(`${baseUrl}/api/checkout/reservations/${bookingRef}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${staffToken}` },
    body: JSON.stringify({ is_paid: true, total_amount: 1 })
  });
  assert.equal(legacyRes.status, 410);
  assert.equal((await legacyRes.json()).code, 'ENDPOINT_REMOVED');

  const resAfterLegacy = await prisma.reservation.findFirst({ where: { booking_ref: bookingRef } });
  assert.equal(resAfterLegacy.is_paid, false);
  assert.equal(resAfterLegacy.total_amount, 400);
  assert.equal(resAfterLegacy.billing_status, 'unpaid');

  // 2. Empty PromoCode table + ensureDefaultCheckoutConfigs() -> all 4 have channel: 'pos'
  await prisma.promoCode.deleteMany({});
  await ensureDefaultCheckoutConfigs();
  const seeded = await prisma.promoCode.findMany({ orderBy: { code: 'asc' } });
  assert.equal(seeded.length, 4);
  for (const p of seeded) {
    assert.equal(p.channel, 'pos', `Expected ${p.code} channel to be 'pos'`);
  }

  // 3. Customer validate CHECKIN30 -> valid: false with POS-only message
  const custVal = await fetch(`${baseUrl}/api/checkout/promo-codes/validate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${custToken}` },
    body: JSON.stringify({ code: 'CHECKIN30', base_amount: 400, pax: 2, hours: 1 })
  });
  assert.equal(custVal.status, 400);
  const custValData = await custVal.json();
  assert.equal(custValData.valid, false);
  assert.equal(custValData.error, '此優惠券僅供現場櫃檯結帳使用');

  // 4. Deprecated admin validate endpoint returns 410 GONE (Round 34 Item 2 moved POS promo application to /api/billing/:ref/promos)
  const adminVal = await fetch(`${baseUrl}/api/checkout/admin/promo-codes/validate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${staffToken}` },
    body: JSON.stringify({ code: 'CHECKIN30', base_amount: 400, pax: 2, hours: 1 })
  });
  assert.equal(adminVal.status, 410);
  const adminValData = await adminVal.json();
  assert.equal(adminValData.code, 'GONE');

  // 5. Self-service prepay-quote with CHECKIN30 -> rejected
  const quoteRes = await fetch(`${baseUrl}/api/reservations/prepay-quote`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${custToken}` },
    body: JSON.stringify({
      session_ids: [sessionRow.id],
      pax: 1,
      isUnlimited: true,
      promo_code: 'CHECKIN30'
    })
  });
  assert.equal(quoteRes.status, 200);
  const quoteData = await quoteRes.json();
  assert.equal(quoteData.promo, null);
  assert.ok(
    Array.isArray(quoteData.errors) &&
      quoteData.errors.some((e) => e.code === 'PROMO_ERROR' && e.message.includes('此優惠券僅供現場櫃檯結帳使用')),
    `Expected PROMO_ERROR in quote errors, got: ${JSON.stringify(quoteData)}`
  );

  // 6. fix-default-promos-pos.mjs dry-run & --apply
  await prisma.promoCode.deleteMany({});
  const defCheckin = DEFAULT_PROMO_CODES.find((d) => d.code === 'CHECKIN30');
  const defReview = DEFAULT_PROMO_CODES.find((d) => d.code === 'REVIEW50');
  const defVip = DEFAULT_PROMO_CODES.find((d) => d.code === 'VIP90');

  await prisma.promoCode.createMany({
    data: [
      { ...defCheckin, channel: 'all' },
      { ...defReview, channel: 'all', discount_value: 80 },
      { ...defVip, channel: 'pos' }
      // CHECKIN20P intentionally absent
    ]
  });

  const scriptEnv = { ...process.env, NODE_ENV: 'test', TZ: 'Asia/Taipei' };
  const { stdout: dryOut } = await execFileAsync('node', ['scripts/fix-default-promos-pos.mjs'], {
    cwd: backendDir,
    env: scriptEnv
  });
  assert.ok(dryOut.includes('CHECKIN30: 仍是預設值'), `dry-run output: ${dryOut}`);
  assert.ok(dryOut.includes('REVIEW50: 已被店主改過'), `dry-run output: ${dryOut}`);
  assert.ok(dryOut.includes('VIP90: 已經是 pos'), `dry-run output: ${dryOut}`);
  assert.ok(dryOut.includes('CHECKIN20P: 不存在'), `dry-run output: ${dryOut}`);

  // Dry-run must NOT mutate DB
  assert.equal((await prisma.promoCode.findUnique({ where: { code: 'CHECKIN30' } })).channel, 'all');

  const { stdout: applyOut } = await execFileAsync('node', ['scripts/fix-default-promos-pos.mjs', '--apply'], {
    cwd: backendDir,
    env: scriptEnv
  });
  assert.ok(applyOut.includes('CHECKIN30: 仍是預設值 -> 已改為 channel: pos'));
  assert.equal((await prisma.promoCode.findUnique({ where: { code: 'CHECKIN30' } })).channel, 'pos');
  assert.equal((await prisma.promoCode.findUnique({ where: { code: 'REVIEW50' } })).channel, 'all');

  const promoAudit = await prisma.accountingEvent.findFirst({
    where: { category: 'setting', event_type: 'promo_channel_changed' },
    orderBy: { id: 'desc' }
  });
  assert.ok(promoAudit);
});
