import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import express from 'express';
import cookieParser from 'cookie-parser';
import prisma from '../src/prismaClient.js';
import authRoutes from '../src/routes/auth.js';
import { createLineCallbackHandler, lineStart } from '../src/controllers/authController.js';

function startLocalApp(mountExtra) {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  if (mountExtra) mountExtra(app);
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

function parseCookieHeaderFromSetCookies(setCookies = []) {
  return setCookies
    .map((c) => String(c).split(';')[0])
    .filter(Boolean)
    .join('; ');
}

function findCookieEntry(setCookies = [], name) {
  return setCookies.find((c) => String(c).startsWith(`${name}=`));
}

test('Round 32 Item 1: LINE OAuth state is generated server-side, bound to signed HttpOnly cookie, and strictly consumed', async (t) => {
  const runId = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const fakeLineUserId = `U_r32_i1_${runId}`;
  const origEnv = {
    LINE_CHANNEL_ID: process.env.LINE_CHANNEL_ID,
    LINE_CHANNEL_SECRET: process.env.LINE_CHANNEL_SECRET,
    LINE_CALLBACK_URL: process.env.LINE_CALLBACK_URL
  };

  process.env.LINE_CHANNEL_ID = 'test-r32-channel-id';
  process.env.LINE_CHANNEL_SECRET = 'test-r32-channel-secret';
  process.env.LINE_CALLBACK_URL = 'http://localhost:5173/';

  let mockNowMs = Date.now();
  let lineApiCallCount = 0;

  const mockCallbackHandler = createLineCallbackHandler({
    now: () => mockNowMs,
    exchangeCodeForToken: async () => {
      lineApiCallCount += 1;
      return 'mock-access-token';
    },
    fetchLineProfile: async () => ({
      userId: fakeLineUserId,
      displayName: 'R32 LINE User',
      pictureUrl: null,
      statusMessage: null
    })
  });

  const srv = await startLocalApp((app) => {
    app.get('/test-line/start', lineStart);
    app.post('/test-line/callback', mockCallbackHandler);
  });

  t.after(async () => {
    await srv.close().catch(() => {});
    for (const [k, v] of Object.entries(origEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    const u = await prisma.user.findUnique({ where: { line_user_id: fakeLineUserId } });
    if (u) {
      await prisma.userLoginLog.deleteMany({ where: { user_id: u.id } }).catch(() => {});
      await prisma.user.delete({ where: { id: u.id } }).catch(() => {});
    }
  });

  const baseUrl = srv.baseUrl;

  // 1. GET /api/auth/line/start?return=/preorder&prefix=preorder
  const startRes = await fetch(`${baseUrl}/api/auth/line/start?return=/preorder&prefix=preorder`, {
    redirect: 'manual'
  });
  assert.equal(startRes.status, 302);
  const location = startRes.headers.get('location');
  assert.ok(location.startsWith('https://access.line.me/oauth2/v2.1/authorize?'));
  const locUrl = new URL(location);
  const state1 = locUrl.searchParams.get('state');
  assert.ok(state1 && state1.startsWith('preorder_'));
  assert.match(state1, /^preorder_[0-9a-f]{32}$/);

  const setCookies1 = startRes.headers.getSetCookie ? startRes.headers.getSetCookie() : [startRes.headers.get('set-cookie')];
  const stateCookieLine = findCookieEntry(setCookies1, 'sg_line_state');
  assert.ok(stateCookieLine, 'sg_line_state cookie must be set');
  assert.ok(/HttpOnly/i.test(stateCookieLine));
  assert.ok(/SameSite=Lax/i.test(stateCookieLine));
  assert.ok(/Path=\/api\/auth\/line/i.test(stateCookieLine));

  const cookieHeader1 = parseCookieHeaderFromSetCookies(setCookies1);

  // 2. Callback WITHOUT cookie -> 400 LINE_STATE_INVALID, mock LINE API NOT called
  lineApiCallCount = 0;
  const noCookieRes = await fetch(`${baseUrl}/test-line/callback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: 'fake-code', state: state1 })
  });
  assert.equal(noCookieRes.status, 400);
  assert.equal((await noCookieRes.json()).code, 'LINE_STATE_INVALID');
  assert.equal(lineApiCallCount, 0);

  // 3. Callback WITH cookie but mismatched state -> 400 LINE_STATE_INVALID, mock NOT called
  const mismatchRes = await fetch(`${baseUrl}/test-line/callback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieHeader1 },
    body: JSON.stringify({ code: 'fake-code', state: 'preorder_wrongstate0000000000000000' })
  });
  assert.equal(mismatchRes.status, 400);
  assert.equal((await mismatchRes.json()).code, 'LINE_STATE_INVALID');
  assert.equal(lineApiCallCount, 0);

  // 4. Tampered cookie (flip 1 character) -> 400 LINE_STATE_INVALID, mock NOT called
  const rawPair = cookieHeader1.split('=')[1];
  const tamperedVal = rawPair.slice(0, -1) + (rawPair.slice(-1) === 'A' ? 'B' : 'A');
  const tamperedRes = await fetch(`${baseUrl}/test-line/callback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: `sg_line_state=${tamperedVal}` },
    body: JSON.stringify({ code: 'fake-code', state: state1 })
  });
  assert.equal(tamperedRes.status, 400);
  assert.equal((await tamperedRes.json()).code, 'LINE_STATE_INVALID');
  assert.equal(lineApiCallCount, 0);

  // 5. Expired cookie (advance mock clock by 31 minutes) -> 400 LINE_STATE_INVALID, mock NOT called
  mockNowMs += 31 * 60 * 1000;
  const expiredRes = await fetch(`${baseUrl}/test-line/callback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieHeader1 },
    body: JSON.stringify({ code: 'fake-code', state: state1 })
  });
  assert.equal(expiredRes.status, 400);
  assert.equal((await expiredRes.json()).code, 'LINE_STATE_INVALID');
  assert.equal(lineApiCallCount, 0);
  mockNowMs = Date.now(); // restore clock

  // 6. Valid cookie + matching state -> 200, return_path === '/preorder', LINE API called once
  const validRes = await fetch(`${baseUrl}/test-line/callback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieHeader1 },
    body: JSON.stringify({ code: 'fake-code', state: state1 })
  });
  assert.equal(validRes.status, 200);
  const validData = await validRes.json();
  assert.equal(validData.return_path, '/preorder');
  assert.equal(lineApiCallCount, 1);

  // 7. Replay same state with updated cookie -> 400 LINE_STATE_INVALID, LINE API NOT called again
  const setCookiesAfterConsume = validRes.headers.getSetCookie
    ? validRes.headers.getSetCookie()
    : [validRes.headers.get('set-cookie')];
  const consumedCookieOnly = findCookieEntry(setCookiesAfterConsume, 'sg_line_state');
  assert.ok(consumedCookieOnly);
  const cookieAfterConsume = consumedCookieOnly.split(';')[0];

  const replayRes = await fetch(`${baseUrl}/test-line/callback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieAfterConsume },
    body: JSON.stringify({ code: 'fake-code', state: state1 })
  });
  assert.equal(replayRes.status, 400);
  assert.equal((await replayRes.json()).code, 'LINE_STATE_INVALID');
  assert.equal(lineApiCallCount, 1);

  // 8. Unsafe return paths (//evil.example, https://evil.example) coerce to '/booking'
  for (const unsafeRet of ['//evil.example', 'https://evil.example']) {
    const sRes = await fetch(`${baseUrl}/api/auth/line/start?return=${encodeURIComponent(unsafeRet)}`, {
      redirect: 'manual'
    });
    assert.equal(sRes.status, 302);
    const st = new URL(sRes.headers.get('location')).searchParams.get('state');
    const cHdr = parseCookieHeaderFromSetCookies(sRes.headers.getSetCookie());

    const cb = await fetch(`${baseUrl}/test-line/callback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cHdr },
      body: JSON.stringify({ code: 'fake-code', state: st })
    });
    assert.equal(cb.status, 200);
    assert.equal((await cb.json()).return_path, '/booking');
  }

  // 9. Opening /start 6 times keeps only newest 5 states; oldest (1st) is rejected with 400
  let rollingCookie = '';
  const sixStates = [];
  for (let i = 0; i < 6; i += 1) {
    const sRes = await fetch(`${baseUrl}/api/auth/line/start?return=/booking`, {
      redirect: 'manual',
      headers: rollingCookie ? { Cookie: rollingCookie } : {}
    });
    assert.equal(sRes.status, 302);
    sixStates.push(new URL(sRes.headers.get('location')).searchParams.get('state'));
    rollingCookie = parseCookieHeaderFromSetCookies(sRes.headers.getSetCookie());
  }

  const oldestRes = await fetch(`${baseUrl}/test-line/callback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: rollingCookie },
    body: JSON.stringify({ code: 'fake-code', state: sixStates[0] })
  });
  assert.equal(oldestRes.status, 400);
  assert.equal((await oldestRes.json()).code, 'LINE_STATE_INVALID');

  const newestRes = await fetch(`${baseUrl}/test-line/callback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: rollingCookie },
    body: JSON.stringify({ code: 'fake-code', state: sixStates[5] })
  });
  assert.equal(newestRes.status, 200);
  assert.equal((await newestRes.json()).return_path, '/booking');
});
