import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import express from 'express';
import cookieParser from 'cookie-parser';
import prisma from '../src/prismaClient.js';
import authRoutes from '../src/routes/auth.js';
import floorRoutes from '../src/routes/floor.js';
import kioskRoutes from '../src/routes/kiosk.js';
import { ensureKioskSetting } from '../src/controllers/dailySettingController.js';
import { getLiveFloorData } from '../src/services/floor/liveService.js';
import { dateOnly, toTaipeiDateString } from '../../shared/time.js';
import { ensureTestPublishedLayout, cleanupTestPublishedLayout } from './helpers/seedTestLayout.js';

function startLocalServer() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/auth', authRoutes);
  app.use('/api/floor', floorRoutes);
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
        close: () => new Promise((r) => server.close(r))
      });
    });
  });
}

test('Round 42 Item 5: floor read-only kiosk endpoints enforce permissions, redact secrets/QR code, and explain entry states', async (t) => {
  const runId = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const todayStr = toTaipeiDateString(new Date());
  const todayDate = dateOnly(todayStr);
  const futureStr = '2099-11-27';
  const futureDate = dateOnly(futureStr);
  const bRef = `R42-I5-${runId}`;

  let server = null;
  let staffSeating = null;
  let customer = null;
  let layoutId = null;
  let sessionFuture = null;
  const createdLogIds = [];
  let prevKioskSetting = null;
  let createdKioskSetting = false;
  let prevTodayDaily = null;

  t.after(async () => {
    if (server) await server.close();
    if (createdLogIds.length > 0) {
      await prisma.kioskAccessLog.deleteMany({ where: { id: { in: createdLogIds } } }).catch(() => {});
    }
    await prisma.bookingPrepay.deleteMany({ where: { booking_ref: bRef } }).catch(() => {});
    await prisma.reservation.deleteMany({ where: { booking_ref: bRef } }).catch(() => {});
    if (sessionFuture) {
      await prisma.session.deleteMany({ where: { id: sessionFuture.id } }).catch(() => {});
    }
    await prisma.dailySetting.deleteMany({ where: { date: futureDate } }).catch(() => {});
    if (prevTodayDaily) {
      await prisma.dailySetting.upsert({
        where: { date: todayDate },
        update: { is_self_service: prevTodayDaily.is_self_service },
        create: prevTodayDaily
      }).catch(() => {});
    } else {
      await prisma.dailySetting.deleteMany({ where: { date: todayDate } }).catch(() => {});
    }
    if (createdKioskSetting) {
      await prisma.kioskSetting.deleteMany({ where: { id: 1 } }).catch(() => {});
    } else if (prevKioskSetting) {
      await prisma.kioskSetting.update({
        where: { id: 1 },
        data: {
          backup_code: prevKioskSetting.backup_code,
          setup_pin: prevKioskSetting.setup_pin
        }
      }).catch(() => {});
    }
    if (staffSeating?.id) await prisma.adminUser.deleteMany({ where: { id: staffSeating.id } }).catch(() => {});
    if (customer?.id) await prisma.user.deleteMany({ where: { id: customer.id } }).catch(() => {});
    if (layoutId) await cleanupTestPublishedLayout(prisma, layoutId).catch(() => {});
    await prisma.$disconnect();
  });

  layoutId = await ensureTestPublishedLayout(prisma, {
    name: `R42 Item5 Layout ${runId}`,
    effectiveFrom: '2020-01-01',
    effectiveDate: futureStr,
    codePrefix: 'A1-',
    seatCount: 4,
    alwaysCreate: true
  });

  prevTodayDaily = await prisma.dailySetting.findUnique({ where: { date: todayDate } });
  await prisma.dailySetting.upsert({
    where: { date: todayDate },
    update: { is_self_service: true },
    create: { date: todayDate, is_self_service: true }
  });
  await prisma.dailySetting.deleteMany({ where: { date: futureDate } });
  await prisma.dailySetting.create({
    data: { date: futureDate, is_self_service: false }
  });

  // Check is_self_service_day in getLiveFloorData
  const liveSelf = await getLiveFloorData(todayStr, new Date(`${todayStr}T12:00:00+08:00`));
  assert.equal(liveSelf.is_self_service_day, true);
  const liveNormal = await getLiveFloorData(futureStr, new Date(`${futureStr}T12:00:00+08:00`));
  assert.equal(liveNormal.is_self_service_day, false);

  // Set fake backup_code '1234567890' and setup_pin '2468'
  const existingKs = await prisma.kioskSetting.findUnique({ where: { id: 1 } });
  if (existingKs) {
    prevKioskSetting = existingKs;
    await prisma.kioskSetting.update({
      where: { id: 1 },
      data: { backup_code: '1234567890', setup_pin: '2468' }
    });
  } else {
    createdKioskSetting = true;
    await ensureKioskSetting(prisma);
    await prisma.kioskSetting.update({
      where: { id: 1 },
      data: { backup_code: '1234567890', setup_pin: '2468' }
    });
  }

  const staffPass = `r42_seating_${runId}`;
  staffSeating = await prisma.adminUser.create({
    data: { name: 'R42外場店員', password: staffPass, role: 'staff', permissions: ['seating'], is_active: true }
  });
  customer = await prisma.user.create({
    data: { line_user_id: `U_r42_i5_${runId}`, name: '王報到', phone: '0987654678' }
  });

  // Seed 22 access logs today (Asia/Taipei) to verify take 20 & desc order
  const baseMs = new Date(`${todayStr}T09:00:00+08:00`).getTime();
  for (let i = 0; i < 22; i++) {
    const row = await prisma.kioskAccessLog.create({
      data: {
        device_id: 99,
        at: new Date(baseMs + i * 60000),
        method: i % 2 === 0 ? 'phone' : 'qr',
        result: i === 21 ? 'UNVERIFIED' : 'FIRST_CHECKIN',
        open_door: i !== 21,
        booking_ref: bRef,
        user_id: customer.id,
        hint: '***678',
        event_id: `evt-${runId}-${i}`
      }
    });
    createdLogIds.push(row.id);
  }

  // Seed a paid reservation for futureStr 15:00-17:00
  await prisma.session.deleteMany({ where: { session_date: futureDate } });
  sessionFuture = await prisma.session.create({
    data: { session_date: futureDate, start_time: '15:00', end_time: '17:00', max_capacity: 16 }
  });
  await prisma.reservation.create({
    data: {
      booking_ref: bRef,
      session_id: sessionFuture.id,
      user_id: customer.id,
      pax: 2,
      status: 'confirmed',
      assigned_seats: ['A1-1', 'A1-2'],
      is_self_service: true,
      is_paid: true,
      total_amount: 400
    }
  });
  await prisma.bookingPrepay.create({
    data: {
      booking_ref: bRef,
      user_id: customer.id,
      status: 'verified',
      total_amount: 400,
      amount_due: 400
    }
  });

  server = await startLocalServer();

  const loginRes = await fetch(`${server.baseUrl}/api/auth/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: staffPass })
  });
  assert.equal(loginRes.status, 200);
  const { token: seatingToken } = await loginRes.json();

  const custLogin = await fetch(`${server.baseUrl}/api/auth/test-login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: customer.id, role: 'customer' })
  });
  assert.equal(custLogin.status, 200);
  const { token: custToken } = await custLogin.json();

  // 1. Seating permission staff gets 200 on /api/floor/kiosk/recent, max 20, desc
  const recentRes = await fetch(`${server.baseUrl}/api/floor/kiosk/recent?now=${encodeURIComponent(`${todayStr}T12:00:00+08:00`)}`, {
    headers: { Authorization: `Bearer ${seatingToken}` }
  });
  assert.equal(recentRes.status, 200);
  const recentJson = await recentRes.json();
  assert.equal(recentJson.logs.length, 20, 'Should cap at 20 logs');
  assert.equal(recentJson.logs[0].result, 'UNVERIFIED', 'Newest log must come first');
  assert.ok(new Date(recentJson.logs[0].at).getTime() >= new Date(recentJson.logs[1].at).getTime());
  assert.equal(recentJson.logs[0].user_name, '王報到');
  assert.equal(recentJson.logs[0].device_id, undefined);
  assert.equal(recentJson.logs[0].event_id, undefined);
  assert.equal(recentJson.logs[0].user_id, undefined);

  // 2. Seating-only staff still gets 403 on /api/kiosk/admin/backup-code
  const backupRes = await fetch(`${server.baseUrl}/api/kiosk/admin/backup-code`, {
    headers: { Authorization: `Bearer ${seatingToken}` }
  });
  assert.equal(backupRes.status, 403);

  // 3. Paid booking before open_at -> state: confirmed, reason contains 還沒到可進場時間
  const statusRes = await fetch(`${server.baseUrl}/api/floor/kiosk/booking/${bRef}?now=${encodeURIComponent(`${futureStr}T13:00:00+08:00`)}`, {
    headers: { Authorization: `Bearer ${seatingToken}` }
  });
  assert.equal(statusRes.status, 200);
  const statusJson = await statusRes.json();
  assert.equal(statusJson.state, 'confirmed');
  assert.ok(statusJson.reason.includes('還沒到可進場時間'), `Unexpected reason: ${statusJson.reason}`);
  assert.equal(statusJson.code, undefined);
  assert.equal(statusJson.code_expires_at, undefined);

  // 4. Secret scan on both payloads
  const combinedRaw = JSON.stringify({ recentJson, statusJson });
  assert.equal(combinedRaw.includes('1234567890'), false, 'Backup code leaked');
  assert.equal(combinedRaw.includes('2468'), false, 'Setup PIN leaked');
  assert.equal(combinedRaw.includes('code_expires_at'), false, 'QR expiry field leaked');

  // 5. Customer token blocked with 401 or 403
  const custRecent = await fetch(`${server.baseUrl}/api/floor/kiosk/recent`, {
    headers: { Authorization: `Bearer ${custToken}` }
  });
  assert.ok(custRecent.status === 401 || custRecent.status === 403, `Expected 401/403, got ${custRecent.status}`);
  const custStatus = await fetch(`${server.baseUrl}/api/floor/kiosk/booking/${bRef}`, {
    headers: { Authorization: `Bearer ${custToken}` }
  });
  assert.ok(custStatus.status === 401 || custStatus.status === 403, `Expected 401/403, got ${custStatus.status}`);
});
