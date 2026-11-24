import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import express from 'express';
import cookieParser from 'cookie-parser';
import prisma from '../src/prismaClient.js';
import authRoutes from '../src/routes/auth.js';
import dailySettingsRoutes from '../src/routes/dailySettings.js';
import shopRoutes from '../src/routes/shop.js';
import kioskRoutes from '../src/routes/kiosk.js';

function startLocalApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/auth', authRoutes);
  app.use('/api/daily-settings', dailySettingsRoutes);
  app.use('/api/shop', shopRoutes);
  app.use('/api/kiosk', kioskRoutes);

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

test('Round 32 Item 2: admin-entered URL endpoints reject non-http(s) URLs with 422 and accept https://', async (t) => {
  const runId = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const acctGood = `999001${runId.slice(-6)}`;
  const acctBad = `999002${runId.slice(-6)}`;
  const adminPass = `r32_i2_adm_${runId}`;

  let savedGlobal = null;
  let savedKiosk = null;
  let adminUser = null;
  let srv = null;

  t.after(async () => {
    if (srv) await srv.close().catch(() => {});
    await prisma.oneTimeAccountPool.deleteMany({
      where: { account_number: { in: [acctGood, acctBad] } }
    }).catch(() => {});
    if (adminUser?.id) {
      await prisma.adminUser.delete({ where: { id: adminUser.id } }).catch(() => {});
    }
    if (savedGlobal) {
      await prisma.globalSetting.update({
        where: { id: 1 },
        data: {
          line_button_url: savedGlobal.line_button_url,
          official_line_url: savedGlobal.official_line_url
        }
      }).catch(() => {});
    } else {
      await prisma.globalSetting.deleteMany({ where: { id: 1 } }).catch(() => {});
    }
    if (savedKiosk) {
      await prisma.kioskSetting.update({
        where: { id: 1 },
        data: { line_url: savedKiosk.line_url }
      }).catch(() => {});
    } else {
      await prisma.kioskSetting.deleteMany({ where: { id: 1 } }).catch(() => {});
    }
  });

  savedGlobal = await prisma.globalSetting.findUnique({ where: { id: 1 } });
  savedKiosk = await prisma.kioskSetting.findUnique({ where: { id: 1 } });
  await prisma.globalSetting.upsert({
    where: { id: 1 },
    update: { line_button_url: 'https://lin.ee/orig', official_line_url: 'https://lin.ee/orig' },
    create: { id: 1, line_button_url: 'https://lin.ee/orig', official_line_url: 'https://lin.ee/orig' }
  });

  adminUser = await prisma.adminUser.create({
    data: {
      name: 'R32 I2 Admin',
      password: adminPass,
      role: 'staff',
      permissions: ['settings', 'shop', 'sessions'],
      is_active: true
    }
  });

  srv = await startLocalApp();
  const baseUrl = srv.baseUrl;

  const loginRes = await fetch(`${baseUrl}/api/auth/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: adminPass })
  });
  assert.equal(loginRes.status, 200);
  const { token } = await loginRes.json();

  // 1. PUT /api/daily-settings/global rejects javascript:alert(1) with 422 and leaves DB untouched
  const gsBad = await fetch(`${baseUrl}/api/daily-settings/global`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ line_button_url: 'javascript:alert(1)' })
  });
  assert.equal(gsBad.status, 422);
  assert.equal((await gsBad.json()).code, 'INVALID_URL');
  const gsAfterBad = await prisma.globalSetting.findUnique({ where: { id: 1 } });
  assert.equal(gsAfterBad.line_button_url, 'https://lin.ee/orig');

  // 2. POST /api/shop/admin/settings rejects javascript:x with 422
  const shopBad = await fetch(`${baseUrl}/api/shop/admin/settings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ official_line_url: 'javascript:x' })
  });
  assert.equal(shopBad.status, 422);
  assert.equal((await shopBad.json()).code, 'INVALID_URL');

  // 3. Batch import 2 lines: line 1 valid https, line 2 javascript:x -> addedCount 1, skippedCount 1, invalid_url_lines: [2]
  const batchRes = await fetch(`${baseUrl}/api/shop/admin/account-pool/batch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      text_lines: `${acctGood},https://lin.ee/abc,good\n${acctBad},javascript:x,bad`
    })
  });
  assert.equal(batchRes.status, 200);
  const batchData = await batchRes.json();
  assert.equal(batchData.addedCount, 1);
  assert.equal(batchData.skippedCount, 1);
  assert.deepEqual(batchData.invalid_url_lines, [2]);

  const goodRow = await prisma.oneTimeAccountPool.findUnique({ where: { account_number: acctGood } });
  assert.ok(goodRow);
  assert.equal(goodRow.payment_url, 'https://lin.ee/abc');
  const badRow = await prisma.oneTimeAccountPool.findUnique({ where: { account_number: acctBad } });
  assert.equal(badRow, null);

  // 4. PATCH /api/shop/admin/account-pool/:id rejects javascript:x with 422, accepts https://lin.ee/abc
  const poolBad = await fetch(`${baseUrl}/api/shop/admin/account-pool/${goodRow.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ payment_url: 'javascript:x' })
  });
  assert.equal(poolBad.status, 422);
  assert.equal((await poolBad.json()).code, 'INVALID_URL');

  const poolGood = await fetch(`${baseUrl}/api/shop/admin/account-pool/${goodRow.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ payment_url: ' https://lin.ee/abc ' })
  });
  assert.equal(poolGood.status, 200);
  assert.equal((await poolGood.json()).item.payment_url, 'https://lin.ee/abc');

  // 5. PUT /api/kiosk/settings rejects javascript:x with 422, accepts https://lin.ee/abc
  const kioskBad = await fetch(`${baseUrl}/api/kiosk/settings`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ line_url: 'javascript:x' })
  });
  assert.equal(kioskBad.status, 422);
  assert.equal((await kioskBad.json()).code, 'INVALID_URL');

  // 6. Valid https://lin.ee/abc saves on daily-settings/global, shop/admin/settings, and kiosk/settings; '' clears
  const gsGood = await fetch(`${baseUrl}/api/daily-settings/global`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ line_button_url: 'https://lin.ee/abc' })
  });
  assert.equal(gsGood.status, 200);
  assert.equal((await gsGood.json()).setting.line_button_url, 'https://lin.ee/abc');

  const shopGood = await fetch(`${baseUrl}/api/shop/admin/settings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ official_line_url: 'https://lin.ee/abc' })
  });
  assert.equal(shopGood.status, 200);
  assert.equal((await shopGood.json()).setting.official_line_url, 'https://lin.ee/abc');

  const kioskGood = await fetch(`${baseUrl}/api/kiosk/settings`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ line_url: 'https://lin.ee/abc' })
  });
  assert.equal(kioskGood.status, 200);
  assert.equal((await kioskGood.json()).setting.line_url, 'https://lin.ee/abc');

  const kioskClear = await fetch(`${baseUrl}/api/kiosk/settings`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ line_url: '' })
  });
  assert.equal(kioskClear.status, 200);
});
