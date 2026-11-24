import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import prisma from '../src/prismaClient.js';
import reservationRoutes from '../src/routes/reservations.js';
import { createTestApp } from './helpers/testServer.js';

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

test('Round 31 Item 2: DB-backed admin login failure counting, global lock, concurrency, and restart persistence', async (t) => {
  const origAdminPass = process.env.ADMIN_PASSWORD;
  const fakeAdminPass = `R31_Test_Admin_${Date.now()}`;
  process.env.ADMIN_PASSWORD = fakeAdminPass;

  const servers = [];

  t.after(async () => {
    for (const s of servers) {
      await s.close().catch(() => {});
    }
    await clearGuardTables().catch(() => {});
    if (origAdminPass === undefined) delete process.env.ADMIN_PASSWORD;
    else process.env.ADMIN_PASSWORD = origAdminPass;
  });

  await clearGuardTables();

  const app = createTestApp();
  app.use('/api/reservations', reservationRoutes);
  const srv = await startAppServer(app);
  servers.push(srv);
  const baseUrl = srv.baseUrl;

  const postLogin = (url, password) =>
    fetch(`${url}/api/auth/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'R31-Test-Agent' },
      body: JSON.stringify({ password })
    });

  // 1. Lock status before lock -> { locked: false, can_unlock_with_code: false }
  const statusBefore = await fetch(`${baseUrl}/api/auth/admin/lock-status`);
  assert.equal(statusBefore.status, 200);
  assert.deepEqual(await statusBefore.json(), { locked: false, can_unlock_with_code: false });

  // 2. Login before lock to get an existing token
  const preLockLogin = await postLogin(baseUrl, fakeAdminPass);
  assert.equal(preLockLogin.status, 200);
  const existingToken = (await preLockLogin.json()).token;
  assert.ok(existingToken);

  // 3. Empty password returns 400 and does NOT count as failure
  const emptyRes = await postLogin(baseUrl, '   ');
  assert.equal(emptyRes.status, 400);
  assert.equal(await prisma.adminLoginFailure.count({ where: { kind: 'password' } }), 0);

  // 4. 2 wrong passwords -> 401; 3rd wrong password -> 423 ADMIN_LOCKED
  const fail1 = await postLogin(baseUrl, 'wrong-1');
  assert.equal(fail1.status, 401);
  const fail2 = await postLogin(baseUrl, 'wrong-2');
  assert.equal(fail2.status, 401);
  const fail3 = await postLogin(baseUrl, 'wrong-3');
  assert.equal(fail3.status, 423);
  assert.equal((await fail3.json()).code, 'ADMIN_LOCKED');

  const lockEvents = await prisma.adminLoginGuardEvent.findMany({ where: { type: 'locked' } });
  assert.equal(lockEvents.length, 1);

  const countAtLock = await prisma.adminLoginFailure.count({ where: { kind: 'password' } });
  assert.equal(countAtLock, 3);

  // 5. 4th attempt with CORRECT password -> still 423 ADMIN_LOCKED
  const correctWhileLocked = await postLogin(baseUrl, fakeAdminPass);
  assert.equal(correctWhileLocked.status, 423);
  assert.equal((await correctWhileLocked.json()).code, 'ADMIN_LOCKED');

  // 6. Wrong password while locked -> 423 and AdminLoginFailure does NOT increase
  const wrongWhileLocked = await postLogin(baseUrl, 'wrong-4');
  assert.equal(wrongWhileLocked.status, 423);
  assert.equal(await prisma.adminLoginFailure.count({ where: { kind: 'password' } }), 3);

  // 7. Lock status while locked -> { locked: true, can_unlock_with_code: false }
  const statusLocked = await fetch(`${baseUrl}/api/auth/admin/lock-status`);
  assert.equal(statusLocked.status, 200);
  assert.deepEqual(await statusLocked.json(), { locked: true, can_unlock_with_code: false });

  // 8. Existing admin token still works while login is locked
  const meRes = await fetch(`${baseUrl}/api/auth/me`, {
    headers: { Authorization: `Bearer ${existingToken}` }
  });
  assert.equal(meRes.status, 200);

  const badgesRes = await fetch(`${baseUrl}/api/reservations/admin/nav-badges`, {
    headers: { Authorization: `Bearer ${existingToken}` }
  });
  assert.equal(badgesRes.status, 200);

  // 9. Restart persistence: reload auth route module and mount fresh app -> still 423
  const reloadedAuthRoutes = (await import(`../src/routes/auth.js?reload=${Date.now()}`)).default;
  const freshApp = (await import('express')).default();
  freshApp.use((await import('express')).default.json());
  freshApp.use((await import('cookie-parser')).default());
  freshApp.use('/api/auth', reloadedAuthRoutes);
  const srvReloaded = await startAppServer(freshApp);
  servers.push(srvReloaded);

  const afterRestartLogin = await postLogin(srvReloaded.baseUrl, fakeAdminPass);
  assert.equal(afterRestartLogin.status, 423);
  assert.equal((await afterRestartLogin.json()).code, 'ADMIN_LOCKED');

  // 10. Reset, 2 failures -> 1 success -> 2 more failures -> still 401 (count reset on success)
  await clearGuardTables();
  assert.equal((await postLogin(baseUrl, 'bad-1')).status, 401);
  assert.equal((await postLogin(baseUrl, 'bad-2')).status, 401);
  assert.equal((await postLogin(baseUrl, fakeAdminPass)).status, 200);
  assert.equal((await postLogin(baseUrl, 'bad-3')).status, 401);
  assert.equal((await postLogin(baseUrl, 'bad-4')).status, 401);

  // 11. Reset, 2 failures aged to 11 minutes ago -> 1 more failure -> still 401 (outside 10m window)
  await clearGuardTables();
  assert.equal((await postLogin(baseUrl, 'old-1')).status, 401);
  assert.equal((await postLogin(baseUrl, 'old-2')).status, 401);
  const elevenMinsAgo = new Date(Date.now() - 11 * 60 * 1000);
  await prisma.adminLoginFailure.updateMany({
    where: { kind: 'password' },
    data: { created_at: elevenMinsAgo }
  });
  const afterWindowFail = await postLogin(baseUrl, 'fresh-1');
  assert.equal(afterWindowFail.status, 401);

  // 12. Reset, 5 concurrent wrong attempts via Promise.all -> locked_at set, >=3 failures (actually 3), exactly 1 locked event
  await clearGuardTables();
  const concurrentResults = await Promise.all([
    postLogin(baseUrl, 'c-1'),
    postLogin(baseUrl, 'c-2'),
    postLogin(baseUrl, 'c-3'),
    postLogin(baseUrl, 'c-4'),
    postLogin(baseUrl, 'c-5')
  ]);
  const statuses = concurrentResults.map((r) => r.status).sort((a, b) => a - b);
  assert.deepEqual(statuses, [401, 401, 423, 423, 423]);

  const guardAfterConcurrent = await prisma.adminLoginGuard.findUnique({ where: { id: 1 } });
  assert.ok(guardAfterConcurrent?.locked_at);
  const failureCountConcurrent = await prisma.adminLoginFailure.count({ where: { kind: 'password' } });
  assert.equal(failureCountConcurrent, 3);
  const lockedEventsConcurrent = await prisma.adminLoginGuardEvent.count({ where: { type: 'locked' } });
  assert.equal(lockedEventsConcurrent, 1);
});
