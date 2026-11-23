import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import prisma from '../src/prismaClient.js';
import { createTestApp } from './helpers/testServer.js';
import { totpAt } from '../src/services/auth/totp.js';

async function clearGuardTables() {
  await prisma.adminLoginFailure.deleteMany({});
  await prisma.adminLoginGuardEvent.deleteMany({});
  await prisma.adminLoginGuard.deleteMany({});
}

function startAppServer(app) {
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

test('Round 31 Item 4: superadmin-only guard endpoints, TOTP setup/confirm/rotate/disable, backup codes, and zero secret leak', async (t) => {
  const origAdminPass = process.env.ADMIN_PASSWORD;
  const fakeSuperPass = `R31_I4_Super_${Date.now()}`;
  const fakeStaffPass = `R31_I4_Staff_${Date.now()}`;
  process.env.ADMIN_PASSWORD = fakeSuperPass;

  let settingsStaff = null;
  const app = createTestApp();
  const srv = await startAppServer(app);

  t.after(async () => {
    await srv.close().catch(() => {});
    await clearGuardTables().catch(() => {});
    if (settingsStaff?.id) {
      await prisma.adminUser.delete({ where: { id: settingsStaff.id } }).catch(() => {});
    }
    if (origAdminPass === undefined) delete process.env.ADMIN_PASSWORD;
    else process.env.ADMIN_PASSWORD = origAdminPass;
  });

  await clearGuardTables();

  settingsStaff = await prisma.adminUser.create({
    data: {
      name: 'R31 I4 Settings Staff',
      password: fakeStaffPass,
      role: 'staff',
      permissions: ['settings'],
      is_active: true
    }
  });

  const baseUrl = srv.baseUrl;

  const login = async (password) => {
    const r = await fetch(`${baseUrl}/api/auth/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password })
    });
    assert.equal(r.status, 200);
    return (await r.json()).token;
  };

  const superToken = await login(fakeSuperPass);
  const staffToken = await login(fakeStaffPass);

  // 1. Staff with 'settings' permission (non-superadmin) gets 403 on ALL /api/auth/admin/guard* endpoints
  const guardRoutes = [
    { method: 'GET', path: '/api/auth/admin/guard' },
    { method: 'POST', path: '/api/auth/admin/guard/totp/setup', body: {} },
    { method: 'POST', path: '/api/auth/admin/guard/totp/confirm', body: { code: '123456' } },
    { method: 'POST', path: '/api/auth/admin/guard/backup-codes/regenerate', body: { code: '123456' } },
    { method: 'POST', path: '/api/auth/admin/guard/totp/disable', body: { code: '123456' } }
  ];

  for (const r of guardRoutes) {
    const res = await fetch(`${baseUrl}${r.path}`, {
      method: r.method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${staffToken}` },
      body: r.body ? JSON.stringify(r.body) : undefined
    });
    assert.equal(res.status, 403, `Expected 403 for settings staff on ${r.method} ${r.path}`);
  }

  // 2. Superadmin setup -> wrong confirm (401) -> valid confirm (200 + 8 backup codes)
  const setupRes = await fetch(`${baseUrl}/api/auth/admin/guard/totp/setup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${superToken}` },
    body: JSON.stringify({})
  });
  assert.equal(setupRes.status, 200);
  const { secret, otpauth_uri } = await setupRes.json();
  assert.match(secret, /^[A-Z2-7]{32}$/);
  assert.ok(otpauth_uri.includes(`secret=${secret}`));

  const badConfirm = await fetch(`${baseUrl}/api/auth/admin/guard/totp/confirm`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${superToken}` },
    body: JSON.stringify({ code: '000000' })
  });
  assert.equal(badConfirm.status, 401);

  const baseStep = Math.floor(Date.now() / 1000 / 30);
  const confirmCode = totpAt(secret, baseStep - 1);
  const okConfirm = await fetch(`${baseUrl}/api/auth/admin/guard/totp/confirm`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${superToken}` },
    body: JSON.stringify({ code: confirmCode })
  });
  assert.equal(okConfirm.status, 200);
  const { backup_codes: codes1 } = await okConfirm.json();
  assert.equal(codes1.length, 8);
  for (const c of codes1) {
    assert.match(c, /^[A-Z2-9]{5}-[A-Z2-9]{5}$/);
  }

  // 3. DB must NOT store plaintext secret or plaintext backup codes
  const guardRow = await prisma.adminLoginGuard.findUnique({ where: { id: 1 } });
  assert.equal(guardRow.totp_enabled, true);
  assert.ok(guardRow.totp_secret_enc);
  assert.equal(guardRow.totp_secret_enc.includes(secret), false);
  const backupJsonStr = JSON.stringify(guardRow.backup_codes_json);
  for (const c of codes1) {
    assert.equal(backupJsonStr.includes(c), false);
    assert.equal(backupJsonStr.includes(c.replace('-', '')), false);
  }

  // 4. GET /api/auth/admin/guard omits secret and backup codes
  const overviewRes = await fetch(`${baseUrl}/api/auth/admin/guard`, {
    headers: { Authorization: `Bearer ${superToken}` }
  });
  assert.equal(overviewRes.status, 200);
  const overviewData = await overviewRes.json();
  assert.equal(overviewData.totp_enabled, true);
  assert.equal(overviewData.totp_broken, false);
  assert.equal(overviewData.backup_codes_remaining, 8);
  assert.ok(Array.isArray(overviewData.recent_events));
  assert.ok(overviewData.recent_events.some((e) => e.type === 'totp_enabled'));

  const overviewStr = JSON.stringify(overviewData);
  assert.equal(overviewStr.includes(secret), false);
  assert.equal(overviewStr.includes('totp_secret_enc'), false);
  assert.equal(overviewStr.includes('backup_codes_json'), false);
  for (const c of codes1) {
    assert.equal(overviewStr.includes(c), false);
  }

  // 5. Setup while already enabled without code -> 401
  const setupNoCode = await fetch(`${baseUrl}/api/auth/admin/guard/totp/setup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${superToken}` },
    body: JSON.stringify({})
  });
  assert.equal(setupNoCode.status, 401);

  // 6. Regenerate backup codes with current step code -> 200 and 8 new codes
  const regenRes = await fetch(`${baseUrl}/api/auth/admin/guard/backup-codes/regenerate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${superToken}` },
    body: JSON.stringify({ code: totpAt(secret, baseStep) })
  });
  assert.equal(regenRes.status, 200);
  const { backup_codes: codes2 } = await regenRes.json();
  assert.equal(codes2.length, 8);
  assert.notDeepEqual(codes2, codes1);

  // 7. Disable with wrong code -> 401 and stays enabled; disable with valid next step -> 200
  const badDisable = await fetch(`${baseUrl}/api/auth/admin/guard/totp/disable`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${superToken}` },
    body: JSON.stringify({ code: '000000' })
  });
  assert.equal(badDisable.status, 401);
  assert.equal((await prisma.adminLoginGuard.findUnique({ where: { id: 1 } })).totp_enabled, true);

  const okDisable = await fetch(`${baseUrl}/api/auth/admin/guard/totp/disable`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${superToken}` },
    body: JSON.stringify({ code: totpAt(secret, baseStep + 1) })
  });
  assert.equal(okDisable.status, 200);
  assert.equal((await okDisable.json()).disabled, true);
  assert.equal((await prisma.adminLoginGuard.findUnique({ where: { id: 1 } })).totp_enabled, false);
});
