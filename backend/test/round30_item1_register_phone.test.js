import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import express from 'express';
import cookieParser from 'cookie-parser';
import axios from 'axios';
import jwt from 'jsonwebtoken';
import prisma from '../src/prismaClient.js';
import authRoutes from '../src/routes/auth.js';
import reservationRoutes from '../src/routes/reservations.js';
import userRoutes from '../src/routes/users.js';
import { generateToken } from '../src/middlewares/authMiddleware.js';
import { isPlainString, normalizeTwMobile } from '../src/utils/phone.js';

function startLocalTestServer() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/auth', authRoutes);
  app.use('/api/reservations', reservationRoutes);
  app.use('/api/users', userRoutes);
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

test('Round 30 Item 1: phone utils unit checks', () => {
  assert.equal(isPlainString('0900000001'), true);
  assert.equal(isPlainString(''), true);
  assert.equal(isPlainString({ gte: '' }), false);
  assert.equal(isPlainString(['0900000001']), false);
  assert.equal(isPlainString(900000001), false);
  assert.equal(isPlainString(null), false);
  assert.equal(isPlainString(undefined), false);

  assert.equal(normalizeTwMobile(' 0900-000-002 '), '0900000002');
  assert.equal(normalizeTwMobile('0900 000 003'), '0900000003');
  assert.equal(normalizeTwMobile('0800000000'), null);
  assert.equal(normalizeTwMobile('090000000'), null);
  assert.equal(normalizeTwMobile('09000000001'), null);
  assert.equal(normalizeTwMobile({ gte: '' }), null);
  assert.equal(normalizeTwMobile(['0900000001']), null);
  assert.equal(normalizeTwMobile(900000001), null);
});

test('Round 30 Item 1: register phone type checks, temp token ttl/typ, rate limiter, and admin phone checks', async (t) => {
  const runId = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const manualLineId = `manual_test-1_${runId}`;
  const manualPhone = '0900000001';
  const tempLineId1 = `U_r30_temp1_${runId}`;
  const tempLineIdOther = (n) => `U_r30_other_${n}_${runId}`;
  const cleanupPhones = ['0900000001', '0900000002', '0900000003', '02-23456789'];
  const cleanupLineIds = [
    manualLineId,
    tempLineId1,
    tempLineIdOther(1),
    tempLineIdOther(2),
    tempLineIdOther(3),
    tempLineIdOther(4),
    tempLineIdOther(5)
  ];

  const origAxiosPost = axios.post;
  const origAxiosGet = axios.get;
  const origEnv = {
    LINE_CHANNEL_ID: process.env.LINE_CHANNEL_ID,
    LINE_CHANNEL_SECRET: process.env.LINE_CHANNEL_SECRET,
    LINE_CALLBACK_URL: process.env.LINE_CALLBACK_URL
  };

  let testServer = null;
  let adminUser = null;
  let manualUser = null;

  t.after(async () => {
    axios.post = origAxiosPost;
    axios.get = origAxiosGet;
    for (const [k, v] of Object.entries(origEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }

    if (testServer) {
      await testServer.close();
    }

    const usersToDelete = await prisma.user.findMany({
      where: {
        OR: [
          { line_user_id: { in: cleanupLineIds } },
          { phone: { in: cleanupPhones } }
        ]
      },
      select: { id: true }
    });
    const userIds = usersToDelete.map((u) => u.id);
    if (userIds.length > 0) {
      await prisma.userLoginLog.deleteMany({ where: { user_id: { in: userIds } } }).catch(() => {});
      await prisma.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => {});
    }
    if (adminUser?.id) {
      await prisma.adminUser.delete({ where: { id: adminUser.id } }).catch(() => {});
    }
  });

  // Clean up any leftover test phone rows from previous failed runs
  const staleUsers = await prisma.user.findMany({
    where: { phone: { in: cleanupPhones } },
    select: { id: true }
  });
  if (staleUsers.length > 0) {
    const staleIds = staleUsers.map((u) => u.id);
    await prisma.userLoginLog.deleteMany({ where: { user_id: { in: staleIds } } });
    await prisma.user.deleteMany({ where: { id: { in: staleIds } } });
  }

  // Seed manual user (line_user_id starts with manual_test-1)
  manualUser = await prisma.user.create({
    data: {
      line_user_id: manualLineId,
      name: 'Manual Member',
      phone: manualPhone
    }
  });

  // Seed admin user for adminCreateReservation & updateUser checks
  const adminPass = `r30_i1_pass_${runId}`;
  adminUser = await prisma.adminUser.create({
    data: {
      name: 'R30 I1 Admin',
      password: adminPass,
      role: 'staff',
      permissions: ['reservations', 'members'],
      is_active: true
    }
  });

  testServer = await startLocalTestServer();
  const baseUrl = testServer.baseUrl;

  // 1. Verify lineCallback issues temp token with typ: 'line_temp' and exp - iat === 1800
  process.env.LINE_CHANNEL_ID = process.env.LINE_CHANNEL_ID || 'test-channel-id';
  process.env.LINE_CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET || 'test-channel-secret';
  process.env.LINE_CALLBACK_URL = process.env.LINE_CALLBACK_URL || 'http://localhost/callback';

  axios.post = async () => ({ data: { access_token: 'fake-line-access-token' } });
  axios.get = async () => ({
    data: {
      userId: tempLineId1,
      displayName: 'Temp User',
      pictureUrl: null,
      statusMessage: null
    }
  });

  const startRes = await fetch(`${baseUrl}/api/auth/line/start?return=/booking`, {
    redirect: 'manual'
  });
  assert.equal(startRes.status, 302);
  const startLocation = startRes.headers.get('location');
  const startState = new URL(startLocation).searchParams.get('state');
  const setCookies = startRes.headers.getSetCookie ? startRes.headers.getSetCookie() : [startRes.headers.get('set-cookie')];
  const cookieHeader = setCookies.map((c) => c.split(';')[0]).join('; ');

  const cbRes = await fetch(`${baseUrl}/api/auth/line/callback`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: cookieHeader
    },
    body: JSON.stringify({ code: 'fake-code', state: startState })
  });
  assert.equal(cbRes.status, 200);
  const cbData = await cbRes.json();
  assert.equal(cbData.isNewUser, true);
  assert.ok(cbData.token);

  const decodedTemp = jwt.verify(cbData.token, process.env.JWT_SECRET);
  assert.equal(decodedTemp.isTemp, true);
  assert.equal(decodedTemp.typ, 'line_temp');
  assert.equal(decodedTemp.line_user_id, tempLineId1);
  assert.equal(decodedTemp.exp - decodedTemp.iat, 1800);

  const tempToken1 = cbData.token;

  // 2. Send phone: { gte: '' } -> 400 INVALID_PHONE, manualUser line_user_id unchanged
  const rObj = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${tempToken1}`
    },
    body: JSON.stringify({ name: 'Attacker', phone: { gte: '' } })
  });
  assert.equal(rObj.status, 400);
  const dObj = await rObj.json();
  assert.equal(dObj.code, 'INVALID_PHONE');

  const manualAfterObj = await prisma.user.findUnique({ where: { id: manualUser.id } });
  assert.equal(manualAfterObj.line_user_id, manualLineId);

  // 3. Send phone: ['0900000001'], 900000001 (number), '0800000000' -> all 400 INVALID_PHONE
  for (const badPhone of [['0900000001'], 900000001, '0800000000']) {
    const rBad = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tempToken1}`
      },
      body: JSON.stringify({ name: 'Tester', phone: badPhone })
    });
    assert.equal(rBad.status, 400, `Expected 400 for phone=${JSON.stringify(badPhone)}`);
    const dBad = await rBad.json();
    assert.equal(dBad.code, 'INVALID_PHONE');
  }

  // 4. Send phone: '0900-000-002' -> 200, DB stores '0900000002'
  const rValid = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${tempToken1}`
    },
    body: JSON.stringify({ name: '  Valid User  ', phone: '0900-000-002' })
  });
  assert.equal(rValid.status, 200);
  const dValid = await rValid.json();
  assert.equal(dValid.user.phone, '0900000002');
  assert.equal(dValid.user.name, 'Valid User');

  const createdUser = await prisma.user.findUnique({ where: { line_user_id: tempLineId1 } });
  assert.ok(createdUser);
  assert.equal(createdUser.phone, '0900000002');
  assert.equal(createdUser.name, 'Valid User');

  // 5. 6th request with same tempToken1 -> 429 (per-line_user_id limit = 5, while IP count = 6 <= 10)
  const rSixthSameUser = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${tempToken1}`
    },
    body: JSON.stringify({ name: 'Valid User', phone: '0900-000-002' })
  });
  assert.equal(rSixthSameUser.status, 429);

  // 6. Test name validation + per-IP limit (requests 7..10 allowed, 11th -> 429)
  const makeTempToken = (lineId) =>
    generateToken({ line_user_id: lineId, isTemp: true, typ: 'line_temp' }, { expiresIn: '30m' });

  const nameTests = [
    { token: makeTempToken(tempLineIdOther(1)), body: { name: { gte: '' }, phone: '0900000003' }, expected: 400 },
    { token: makeTempToken(tempLineIdOther(2)), body: { name: '   ', phone: '0900000003' }, expected: 400 },
    { token: makeTempToken(tempLineIdOther(3)), body: { name: 'a'.repeat(31), phone: '0900000003' }, expected: 400 },
    { token: makeTempToken(tempLineIdOther(4)), body: { name: 'Other User', phone: '0900 000 003' }, expected: 200 }
  ];

  for (const nt of nameTests) {
    const r = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${nt.token}`
      },
      body: JSON.stringify(nt.body)
    });
    assert.equal(r.status, nt.expected, `Unexpected status for ${JSON.stringify(nt.body)}`);
  }

  // 11th request from same IP with a fresh line_user_id -> 429
  const rIpLimit = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${makeTempToken(tempLineIdOther(5))}`
    },
    body: JSON.stringify({ name: 'IP Limit', phone: '0900000004' })
  });
  assert.equal(rIpLimit.status, 429);

  // 7. Admin login and verify adminCreateReservation & updateUser reject non-string phone
  const loginRes = await fetch(`${baseUrl}/api/auth/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: adminPass })
  });
  assert.equal(loginRes.status, 200);
  const { token: adminToken } = await loginRes.json();

  const rAdminBookObj = await fetch(`${baseUrl}/api/reservations/admin`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${adminToken}`
    },
    body: JSON.stringify({
      session_ids: [1],
      pax: 1,
      name: 'Walk In',
      phone: { contains: '09' }
    })
  });
  assert.equal(rAdminBookObj.status, 400);

  const rAdminBookArr = await fetch(`${baseUrl}/api/reservations/admin`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${adminToken}`
    },
    body: JSON.stringify({
      session_ids: [1],
      pax: 1,
      name: 'Walk In',
      phone: ['0900000001']
    })
  });
  assert.equal(rAdminBookArr.status, 400);

  const rUpdateUserObj = await fetch(`${baseUrl}/api/users/${manualUser.id}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${adminToken}`
    },
    body: JSON.stringify({ phone: { gte: '' } })
  });
  assert.equal(rUpdateUserObj.status, 400);

  // Admin can still save a landline phone number
  const rUpdateUserLandline = await fetch(`${baseUrl}/api/users/${manualUser.id}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${adminToken}`
    },
    body: JSON.stringify({ phone: '02-23456789' })
  });
  assert.equal(rUpdateUserLandline.status, 200);
  const dLandline = await rUpdateUserLandline.json();
  assert.equal(dLandline.user.phone, '02-23456789');
});
