import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { execFile } from 'child_process';
import { promisify } from 'util';
import prisma from '../src/prismaClient.js';
import sessionRoutes from '../src/routes/sessions.js';
import shopRoutes from '../src/routes/shop.js';
import { createTestApp } from './helpers/testServer.js';

const execFileAsync = promisify(execFile);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const backendDir = path.resolve(__dirname, '..');

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

test('Round 32 Item 5: 1MB global JSON limit, 15MB upload route bypass, session range cap, and prismaClient test-env guard', async (t) => {
  const runId = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const adminPass = `r32_i5_adm_${runId}`;
  let adminUser = null;
  let srv = null;

  t.after(async () => {
    if (srv) await srv.close().catch(() => {});
    if (adminUser?.id) {
      await prisma.adminUser.delete({ where: { id: adminUser.id } }).catch(() => {});
    }
  });

  adminUser = await prisma.adminUser.create({
    data: {
      name: 'R32 I5 Shop Admin',
      password: adminPass,
      role: 'staff',
      permissions: ['shop'],
      is_active: true
    }
  });

  const app = createTestApp();
  app.use('/api/sessions', sessionRoutes);
  app.use('/api/shop', shopRoutes);
  srv = await startAppServer(app);
  const baseUrl = srv.baseUrl;

  // 1. Unauthenticated 2MB JSON to POST /api/auth/register -> 413
  const bigBlob = 'a'.repeat(2 * 1024 * 1024);
  const regBigRes = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Big', phone: '0900000001', pad: bigBlob })
  });
  assert.equal(regBigRes.status, 413);
  const regBigData = await regBigRes.json();
  assert.equal(regBigData.error, '資料太大');

  // 2. Admin 2MB JSON to POST /api/shop/admin/products -> NOT 413 (reaches controller validation -> 400)
  const loginRes = await fetch(`${baseUrl}/api/auth/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: adminPass })
  });
  assert.equal(loginRes.status, 200);
  const { token: shopToken } = await loginRes.json();

  const shopBigRes = await fetch(`${baseUrl}/api/shop/admin/products`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${shopToken}` },
    body: JSON.stringify({ code: '', name: '', price: 100, image_url: bigBlob })
  });
  assert.notEqual(shopBigRes.status, 413);
  assert.equal(shopBigRes.status, 400);

  // 3. GET /api/sessions range & format validation
  const rTooWide = await fetch(`${baseUrl}/api/sessions?start_date=2026-01-01&end_date=2027-12-31`);
  assert.equal(rTooWide.status, 400);

  const rReversed = await fetch(`${baseUrl}/api/sessions?start_date=2026-12-10&end_date=2026-12-01`);
  assert.equal(rReversed.status, 400);

  const rBadDate = await fetch(`${baseUrl}/api/sessions?date=abc`);
  assert.equal(rBadDate.status, 400);

  const r90Days = await fetch(`${baseUrl}/api/sessions?start_date=2026-09-01&end_date=2026-11-30`);
  assert.equal(r90Days.status, 200);

  // 4. child_process loading prismaClient.js with NODE_ENV=production and /test/ in argv throws & exits without setting NODE_ENV='test'
  let failedAsExpected = false;
  let observedStderr = '';
  try {
    await execFileAsync(
      process.execPath,
      ['-e', "import('./src/prismaClient.js').then(() => console.log('RESOLVED_NODE_ENV=' + process.env.NODE_ENV))", '/test/fake.test.js'],
      {
        cwd: backendDir,
        env: { ...process.env, NODE_ENV: 'production' }
      }
    );
  } catch (err) {
    failedAsExpected = true;
    observedStderr = `${err.stdout || ''}\n${err.stderr || ''}\n${err.message || ''}`;
  }
  assert.equal(failedAsExpected, true, 'prismaClient.js must reject test-like argv when NODE_ENV !== test');
  assert.ok(observedStderr.includes('測試必須設定 NODE_ENV=test'), `Unexpected stderr: ${observedStderr}`);
  assert.equal(observedStderr.includes('RESOLVED_NODE_ENV=test'), false);
});
