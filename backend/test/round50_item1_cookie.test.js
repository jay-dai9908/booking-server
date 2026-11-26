import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import cookieParser from 'cookie-parser';
import prisma from '../src/prismaClient.js';
import { generateToken } from '../src/middlewares/authMiddleware.js';
import authRoutes from '../src/routes/auth.js';

function startLocalApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/auth', authRoutes);
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

test('Round 50 Item 1: cookieSecure respects HTTP production & COOKIE_SECURE, and register errors use Chinese codes', async () => {
  const prevNodeEnv = process.env.NODE_ENV;
  const prevCookieSecure = process.env.COOKIE_SECURE;
  const ts = Date.now();
  const phone = `0966${String(ts).slice(-6)}`;
  const lineUserId = `r50_i1_${ts}`;

  let srv = null;
  try {
    srv = await startLocalApp();

    const tempToken = generateToken({
      line_user_id: lineUserId,
      line_display_name: 'R50註冊測試',
      isTemp: true,
      typ: 'line_temp'
    }, { expiresIn: '30m' });

    const customerToken = generateToken({
      id: 999999,
      role: 'customer',
      typ: 'customer',
      line_user_id: lineUserId
    });

    // 1. Missing token -> 401
    let res = await fetch(`${srv.baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '測試', phone })
    });
    assert.equal(res.status, 401);

    // 2. Non-temp token -> 401 TEMP_SESSION_EXPIRED in Chinese
    res = await fetch(`${srv.baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: `token=${customerToken}`
      },
      body: JSON.stringify({ name: '測試', phone })
    });
    assert.equal(res.status, 401);
    const expiredBody = await res.json();
    assert.equal(expiredBody.code, 'TEMP_SESSION_EXPIRED');
    assert.ok(/[\u4e00-\u9fff]/.test(expiredBody.error));

    // 3. Missing phone -> 400 REGISTER_FIELDS_REQUIRED
    res = await fetch(`${srv.baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: `token=${tempToken}`
      },
      body: JSON.stringify({ name: '測試' })
    });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).code, 'REGISTER_FIELDS_REQUIRED');

    // 4. NODE_ENV=production + unset COOKIE_SECURE + plain HTTP -> NO Secure attribute
    process.env.NODE_ENV = 'production';
    delete process.env.COOKIE_SECURE;
    res = await fetch(`${srv.baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: `token=${tempToken}`
      },
      body: JSON.stringify({ name: 'R50純HTTP客', phone })
    });
    assert.equal(res.status, 200);
    const setCookieUnset = res.headers.get('set-cookie') || '';
    assert.ok(setCookieUnset.includes('token='), 'Must set token cookie');
    assert.equal(/;\s*Secure\b/i.test(setCookieUnset), false, `Must NOT include Secure on plain HTTP: ${setCookieUnset}`);

    // 5. COOKIE_SECURE=true -> includes Secure
    process.env.COOKIE_SECURE = 'true';
    res = await fetch(`${srv.baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: `token=${tempToken}`
      },
      body: JSON.stringify({ name: 'R50開啟Secure客', phone })
    });
    assert.equal(res.status, 200);
    const setCookieTrue = res.headers.get('set-cookie') || '';
    assert.equal(/;\s*Secure\b/i.test(setCookieTrue), true, `Must include Secure when COOKIE_SECURE=true: ${setCookieTrue}`);

    // 6. COOKIE_SECURE=false -> omits Secure even if proxied HTTPS header present
    process.env.COOKIE_SECURE = 'false';
    res = await fetch(`${srv.baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-forwarded-proto': 'https',
        Cookie: `token=${tempToken}`
      },
      body: JSON.stringify({ name: 'R50強制關Secure客', phone })
    });
    assert.equal(res.status, 200);
    const setCookieFalse = res.headers.get('set-cookie') || '';
    assert.equal(/;\s*Secure\b/i.test(setCookieFalse), false, `Must omit Secure when COOKIE_SECURE=false: ${setCookieFalse}`);
  } finally {
    process.env.NODE_ENV = prevNodeEnv;
    if (prevCookieSecure === undefined) {
      delete process.env.COOKIE_SECURE;
    } else {
      process.env.COOKIE_SECURE = prevCookieSecure;
    }
    if (srv) await srv.close().catch(() => {});
    await prisma.userLoginLog.deleteMany({ where: { user: { line_user_id: lineUserId } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { line_user_id: lineUserId } }).catch(() => {});
  }
});
