import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import express from 'express';
import cookieParser from 'cookie-parser';
import prisma from '../src/prismaClient.js';
import authRoutes from '../src/routes/auth.js';
import dailySettingsRoutes from '../src/routes/dailySettings.js';
import shopRoutes from '../src/routes/shop.js';
import equipmentRoutes from '../src/routes/equipment.js';
import kioskRoutes from '../src/routes/kiosk.js';
import { getGlobalSetting } from '../src/controllers/dailySettingController.js';
import { sanitizeGlobalSetting } from '../src/utils/sanitizeGlobalSetting.js';
import { getMessagingToken } from '../src/utils/lineMessaging.js';

function startLocalTestServer() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/auth', authRoutes);
  app.use('/api/daily-settings', dailySettingsRoutes);
  app.get('/api/global-settings', getGlobalSetting);
  app.use('/api/shop', shopRoutes);
  app.use('/api/equipment', equipmentRoutes);
  app.use('/api/kiosk', kioskRoutes);
  app.use((err, req, res, next) => {
    res.status(500).json({ error: err?.message || 'Internal error' });
  });

  const server = http.createServer(app);
  return new Promise((resolve, reject) => {
    server.listen(0, (err) => {
      if (err) return reject(err);
      const port = server.address().port;
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        close: () => new Promise((res) => server.close(res))
      });
    });
  });
}

test('Round 30 Item 3: sanitizeGlobalSetting unit checks', () => {
  assert.equal(sanitizeGlobalSetting(null), null);

  const origEnv = process.env.LINE_MESSAGING_ACCESS_TOKEN;
  try {
    delete process.env.LINE_MESSAGING_ACCESS_TOKEN;
    const sanitized = sanitizeGlobalSetting({ id: 1, line_messaging_token: 'TEST-LINE-TOKEN-0000-abcd', print_enabled: true });
    assert.equal('line_messaging_token' in sanitized, false);
    assert.equal(sanitized.has_line_messaging_token, true);
    assert.equal(sanitized.line_messaging_token_masked, '••••••••abcd');

    process.env.LINE_MESSAGING_ACCESS_TOKEN = 'ENV-TOKEN-9999-wxyz';
    const envSanitized = sanitizeGlobalSetting({ id: 1, line_messaging_token: null });
    assert.equal('line_messaging_token' in envSanitized, false);
    assert.equal(envSanitized.has_line_messaging_token, true);
    assert.equal(envSanitized.line_messaging_token_masked, '••••••••wxyz');
  } finally {
    if (origEnv === undefined) delete process.env.LINE_MESSAGING_ACCESS_TOKEN;
    else process.env.LINE_MESSAGING_ACCESS_TOKEN = origEnv;
  }
});

test('Round 30 Item 3: all global setting & config endpoints strip line_messaging_token while push helper still reads it', async (t) => {
  const fakeToken = 'TEST-LINE-TOKEN-0000-abcd';
  const runId = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

  let savedGlobal = null;
  let savedKiosk = null;
  let adminUser = null;
  let testServer = null;

  t.after(async () => {
    if (testServer) await testServer.close();
    if (adminUser?.id) {
      await prisma.adminUser.delete({ where: { id: adminUser.id } }).catch(() => {});
    }
    if (savedGlobal) {
      await prisma.globalSetting.update({
        where: { id: 1 },
        data: { line_messaging_token: savedGlobal.line_messaging_token ?? null }
      }).catch(() => {});
    } else {
      await prisma.globalSetting.deleteMany({ where: { id: 1 } }).catch(() => {});
    }
    if (!savedKiosk) {
      await prisma.kioskSetting.deleteMany({ where: { id: 1 } }).catch(() => {});
    }
  });

  savedGlobal = await prisma.globalSetting.findUnique({ where: { id: 1 } });
  savedKiosk = await prisma.kioskSetting.findUnique({ where: { id: 1 } });

  await prisma.globalSetting.upsert({
    where: { id: 1 },
    update: { line_messaging_token: fakeToken },
    create: { id: 1, line_messaging_token: fakeToken }
  });

  const adminPass = `r30_i3_pass_${runId}`;
  adminUser = await prisma.adminUser.create({
    data: {
      name: 'R30 I3 LowPerm Staff',
      password: adminPass,
      role: 'staff',
      permissions: ['shop', 'equipment', 'settings', 'sessions'],
      is_active: true
    }
  });

  testServer = await startLocalTestServer();
  const baseUrl = testServer.baseUrl;

  const loginRes = await fetch(`${baseUrl}/api/auth/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: adminPass })
  });
  assert.equal(loginRes.status, 200);
  const { token: adminToken } = await loginRes.json();

  const endpoints = [
    { method: 'GET', path: '/api/global-settings', auth: false, checkMasked: (d) => d },
    { method: 'GET', path: '/api/daily-settings/global', auth: false, checkMasked: (d) => d },
    { method: 'PUT', path: '/api/daily-settings/global', body: {}, auth: true, checkMasked: (d) => d.setting },
    { method: 'POST', path: '/api/shop/admin/settings', body: {}, auth: true, checkMasked: (d) => d.setting },
    { method: 'GET', path: '/api/shop/admin/payment-methods', auth: true },
    { method: 'GET', path: '/api/shop/payment-methods', auth: false },
    { method: 'PATCH', path: '/api/equipment/admin/settings', body: {}, auth: true, checkMasked: (d) => d },
    { method: 'GET', path: '/api/equipment/admin/configs', auth: true },
    { method: 'GET', path: '/api/equipment/admin', auth: true },
    { method: 'GET', path: '/api/equipment/availability', auth: false },
    { method: 'GET', path: '/api/kiosk/settings', auth: true },
    { method: 'PUT', path: '/api/kiosk/settings', body: {}, auth: true },
    { method: 'GET', path: '/api/kiosk/admin/overview', auth: true }
  ];

  for (const ep of endpoints) {
    const headers = { 'Content-Type': 'application/json' };
    if (ep.auth) headers.Authorization = `Bearer ${adminToken}`;

    const res = await fetch(`${baseUrl}${ep.path}`, {
      method: ep.method,
      headers,
      body: ep.body !== undefined ? JSON.stringify(ep.body) : undefined
    });
    assert.equal(res.status, 200, `${ep.method} ${ep.path} expected 200, got ${res.status}`);

    const data = await res.json();
    const rawJson = JSON.stringify(data);

    assert.equal(rawJson.includes(fakeToken), false, `${ep.method} ${ep.path} leaked raw token!`);
    assert.equal(rawJson.includes('"line_messaging_token"'), false, `${ep.method} ${ep.path} leaked line_messaging_token key!`);

    if (ep.checkMasked) {
      const settingObj = ep.checkMasked(data);
      assert.equal(settingObj.has_line_messaging_token, true, `${ep.method} ${ep.path} missing has_line_messaging_token=true`);
      assert.ok(
        typeof settingObj.line_messaging_token_masked === 'string' && settingObj.line_messaging_token_masked.endsWith('abcd'),
        `${ep.method} ${ep.path} masked token must end with abcd`
      );
    }
  }

  // Push helper must still be able to read the raw token from DB
  const readBackToken = await getMessagingToken();
  assert.equal(readBackToken, fakeToken);
});
