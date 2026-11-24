import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import express from 'express';
import cookieParser from 'cookie-parser';
import prisma from '../src/prismaClient.js';
import authRoutes from '../src/routes/auth.js';
import checkoutRoutes from '../src/routes/checkout.js';

function startLocalApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/auth', authRoutes);
  app.use('/api/checkout', checkoutRoutes);
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

test('Round 34 Item 5: backend percent_off validation (1..100 integer) and discount_value sync', async (t) => {
  const runId = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const validCode = `R34P15_${runId}`.toUpperCase();

  let adminUser = null;
  let srv = null;
  const createdIds = [];

  t.after(async () => {
    if (srv) await srv.close().catch(() => {});
    if (createdIds.length) await prisma.promoCode.deleteMany({ where: { id: { in: createdIds } } }).catch(() => {});
    if (adminUser?.id) await prisma.adminUser.delete({ where: { id: adminUser.id } }).catch(() => {});
  });

  srv = await startLocalApp();
  const adminPass = `r34_i5_adm_${runId}`;
  adminUser = await prisma.adminUser.create({
    data: { password: adminPass, name: `R34P5_${runId}`, role: 'superadmin', permissions: ['all'], is_active: true }
  });
  const loginRes = await fetch(`${srv.baseUrl}/api/auth/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: adminPass })
  });
  assert.equal(loginRes.status, 200);
  const { token: adminToken } = await loginRes.json();

  for (const badVal of [0, 101, 8.5, -5, 'abc', null]) {
    const res = await fetch(`${srv.baseUrl}/api/checkout/promo-codes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({
        code: `${validCode}_BAD_${String(badVal)}`,
        name: '不合法百分比',
        discount_type: 'percentage',
        percent_off: badVal
      })
    });
    assert.equal(res.status, 422, `Expected 422 for percent_off=${String(badVal)}`);
  }

  const okRes = await fetch(`${srv.baseUrl}/api/checkout/promo-codes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({
      code: validCode,
      name: '八五折',
      discount_type: 'percentage',
      percent_off: 15
    })
  });
  assert.equal(okRes.status, 201);
  const okJson = await okRes.json();
  createdIds.push(okJson.id);
  assert.equal(okJson.percent_off, 15);
  assert.equal(okJson.discount_value, 15);

  const badUpd = await fetch(`${srv.baseUrl}/api/checkout/promo-codes/${okJson.id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ percent_off: 8.5 })
  });
  assert.equal(badUpd.status, 422);

  const okUpd = await fetch(`${srv.baseUrl}/api/checkout/promo-codes/${okJson.id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ percent_off: 25 })
  });
  assert.equal(okUpd.status, 200);
  const updJson = await okUpd.json();
  assert.equal(updJson.percent_off, 25);
  assert.equal(updJson.discount_value, 25);
});
