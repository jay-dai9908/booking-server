import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { execFile } from 'child_process';
import { promisify } from 'util';
import prisma from '../src/prismaClient.js';
import { createTestApp } from './helpers/testServer.js';
import {
  encryptTotpSecret,
  generateBackupCodes,
  generateSecret,
  hashBackupCode,
  totpAt
} from '../src/services/auth/totp.js';

const execFileAsync = promisify(execFile);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const backendDir = path.resolve(__dirname, '..');

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

test('Round 31 Item 3: TOTP & backup code unlock, replay guard, rate limiting, unconfigured 409, and CLI unlock', async (t) => {
  const origAdminPass = process.env.ADMIN_PASSWORD;
  const fakeAdminPass = `R31_I3_Admin_${Date.now()}`;
  process.env.ADMIN_PASSWORD = fakeAdminPass;

  const app = createTestApp();
  const srv = await startAppServer(app);

  t.after(async () => {
    await srv.close().catch(() => {});
    await clearGuardTables().catch(() => {});
    if (origAdminPass === undefined) delete process.env.ADMIN_PASSWORD;
    else process.env.ADMIN_PASSWORD = origAdminPass;
  });

  const baseUrl = srv.baseUrl;

  const postLogin = (password) =>
    fetch(`${baseUrl}/api/auth/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'R31-Unlock-Test' },
      body: JSON.stringify({ password })
    });

  const postUnlock = (code) =>
    fetch(`${baseUrl}/api/auth/admin/unlock`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'R31-Unlock-Test' },
      body: JSON.stringify({ code })
    });

  const lockOutWith3WrongPasswords = async () => {
    await postLogin('bad-1');
    await postLogin('bad-2');
    const r3 = await postLogin('bad-3');
    assert.equal(r3.status, 423);
  };

  // Setup: seed encrypted TOTP secret and 8 hashed backup codes
  await clearGuardTables();
  const secret = generateSecret();
  const backupCodes = generateBackupCodes(8);
  await prisma.adminLoginGuard.create({
    data: {
      id: 1,
      totp_secret_enc: encryptTotpSecret(secret),
      totp_enabled: true,
      totp_enabled_at: new Date(),
      backup_codes_json: backupCodes.map((c) => ({ hash: hashBackupCode(c), used_at: null }))
    }
  });

  // 1. Lock out, try wrong code -> 401 and still locked
  await lockOutWith3WrongPasswords();

  const wrongUnlock = await postUnlock('000000');
  assert.equal(wrongUnlock.status, 401);
  assert.equal((await wrongUnlock.json()).code, 'UNLOCK_CODE_INVALID');
  assert.ok((await prisma.adminLoginGuard.findUnique({ where: { id: 1 } })).locked_at);

  // 2. Valid current TOTP code -> 200, unlocked, unlocked_totp event, login works again
  const stepNow = Math.floor(Date.now() / 1000 / 30);
  const codeNow = totpAt(secret, stepNow);
  const okUnlock = await postUnlock(codeNow);
  assert.equal(okUnlock.status, 200);
  const okData = await okUnlock.json();
  assert.equal(okData.unlocked, true);
  assert.equal(okData.backup_codes_remaining, 8);

  const guardAfterUnlock = await prisma.adminLoginGuard.findUnique({ where: { id: 1 } });
  assert.equal(guardAfterUnlock.locked_at, null);
  assert.equal(guardAfterUnlock.totp_last_step, stepNow);

  const totpEvent = await prisma.adminLoginGuardEvent.findFirst({
    where: { type: 'unlocked_totp' },
    orderBy: { id: 'desc' }
  });
  assert.ok(totpEvent);

  assert.equal((await postLogin(fakeAdminPass)).status, 200);

  // 3. Replay same TOTP code -> 401; next step (stepNow + 1) -> 200
  await lockOutWith3WrongPasswords();
  const replayUnlock = await postUnlock(codeNow);
  assert.equal(replayUnlock.status, 401);

  const codeNext = totpAt(secret, stepNow + 1);
  const nextStepUnlock = await postUnlock(codeNext);
  assert.equal(nextStepUnlock.status, 200);

  // 4. Backup codes are single-use
  await lockOutWith3WrongPasswords();
  const backupAUnlock = await postUnlock(backupCodes[0]);
  assert.equal(backupAUnlock.status, 200);
  assert.equal((await backupAUnlock.json()).backup_codes_remaining, 7);

  await lockOutWith3WrongPasswords();
  const backupAReuse = await postUnlock(backupCodes[0]);
  assert.equal(backupAReuse.status, 401);

  const backupBUnlock = await postUnlock(backupCodes[1].replace('-', '').toLowerCase());
  assert.equal(backupBUnlock.status, 200);
  assert.equal((await backupBUnlock.json()).backup_codes_remaining, 6);

  // 5. Unlock rate limit: 5 wrong codes -> 5th returns 429 UNLOCK_BLOCKED, valid code still 429; after expiry -> 200
  await lockOutWith3WrongPasswords();
  for (let i = 0; i < 4; i += 1) {
    const r = await postUnlock('999999');
    assert.equal(r.status, 401);
  }
  const r5 = await postUnlock('999999');
  assert.equal(r5.status, 429);
  assert.equal((await r5.json()).code, 'UNLOCK_BLOCKED');

  const validWhileBlocked = await postUnlock(backupCodes[2]);
  assert.equal(validWhileBlocked.status, 429);
  assert.equal((await validWhileBlocked.json()).code, 'UNLOCK_BLOCKED');

  await prisma.adminLoginGuard.update({
    where: { id: 1 },
    data: { unlock_blocked_until: new Date(Date.now() - 1000) }
  });
  const afterBlockExpiry = await postUnlock(backupCodes[2]);
  assert.equal(afterBlockExpiry.status, 200);
  assert.equal((await afterBlockExpiry.json()).backup_codes_remaining, 5);

  // 6. Unconfigured TOTP: 3 wrong passwords still lock (423), unlock returns 409 TOTP_NOT_CONFIGURED
  await clearGuardTables();
  await lockOutWith3WrongPasswords();
  const unconfUnlock = await postUnlock('123456');
  assert.equal(unconfUnlock.status, 409);
  assert.equal((await unconfUnlock.json()).code, 'TOTP_NOT_CONFIGURED');

  // 7. CLI unlock & --status via child_process
  const cliEnv = { ...process.env, NODE_ENV: 'test', TZ: 'Asia/Taipei' };
  const { stdout: unlockOut } = await execFileAsync('node', ['scripts/admin-unlock.mjs'], {
    cwd: backendDir,
    env: cliEnv
  });
  assert.ok(unlockOut.includes('已解除後台登入鎖定'), `Unexpected CLI unlock output: ${unlockOut}`);

  const guardAfterCli = await prisma.adminLoginGuard.findUnique({ where: { id: 1 } });
  assert.equal(guardAfterCli.locked_at, null);
  const cliEvent = await prisma.adminLoginGuardEvent.findFirst({
    where: { type: 'unlocked_cli' },
    orderBy: { id: 'desc' }
  });
  assert.ok(cliEvent);

  // Also verify --status does not leak secret or backup codes
  await prisma.adminLoginGuard.update({
    where: { id: 1 },
    data: {
      totp_secret_enc: encryptTotpSecret(secret),
      totp_enabled: true,
      backup_codes_json: backupCodes.map((c) => ({ hash: hashBackupCode(c), used_at: null }))
    }
  });
  const { stdout: statusOut } = await execFileAsync('node', ['scripts/admin-unlock.mjs', '--status'], {
    cwd: backendDir,
    env: cliEnv
  });
  assert.ok(statusOut.includes('驗證器狀態: 已啟用'));
  assert.equal(statusOut.includes(secret), false);
  for (const c of backupCodes) {
    assert.equal(statusOut.includes(c), false);
  }
});
