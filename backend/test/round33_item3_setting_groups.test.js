import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import cookieParser from 'cookie-parser';
import prisma from '../src/prismaClient.js';
import { generateToken } from '../src/middlewares/authMiddleware.js';
import dailySettingsRoutes from '../src/routes/dailySettings.js';
import kioskRoutes from '../src/routes/kiosk.js';

function startLocalApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/daily-settings', dailySettingsRoutes);
  app.use('/api/kiosk', kioskRoutes);

  const server = http.createServer(app);
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', (err) => {
      if (err) return reject(err);
      const port = server.address().port;
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        close: () => new Promise((res) => server.close(res)),
      });
    });
  });
}

test('Round 33 Item 3: GlobalSetting field-group diff check and Kiosk settings settings-only write', async (t) => {
  const runId = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  let srv = null;
  let origGlobal = null;
  let origKiosk = null;
  const createdAdmins = [];

  t.after(async () => {
    if (srv) await srv.close().catch(() => {});
    if (createdAdmins.length > 0) {
      await prisma.adminUser.deleteMany({ where: { id: { in: createdAdmins.map((a) => a.id) } } }).catch(() => {});
    }
    if (origGlobal) {
      await prisma.globalSetting.update({
        where: { id: 1 },
        data: {
          weekday_hourly_price: origGlobal.weekday_hourly_price,
          equipment_discount_buy_hours: origGlobal.equipment_discount_buy_hours,
          line_messaging_token: origGlobal.line_messaging_token,
          payment_methods_json: origGlobal.payment_methods_json,
        },
      }).catch(() => {});
    }
    if (origKiosk) {
      await prisma.kioskSetting.update({
        where: { id: 1 },
        data: {
          early_minutes: origKiosk.early_minutes,
        },
      }).catch(() => {});
    }
  });

  origGlobal = await prisma.globalSetting.findUnique({ where: { id: 1 } });
  if (!origGlobal) {
    origGlobal = await prisma.globalSetting.create({
      data: {
        id: 1,
        weekday_hourly_price: 100,
        weekday_unlimited_price: 550,
        weekend_hourly_price: 150,
        weekend_unlimited_price: 800,
      },
    });
  } else {
    await prisma.globalSetting.update({
      where: { id: 1 },
      data: {
        weekday_hourly_price: 100,
        equipment_discount_buy_hours: 3,
      },
    });
  }

  origKiosk = await prisma.kioskSetting.findUnique({ where: { id: 1 } });
  if (!origKiosk) {
    origKiosk = await prisma.kioskSetting.create({
      data: {
        id: 1,
        early_minutes: 30,
        after_close_minutes: 60,
        prepay_deadline_hour: 12,
        max_unpaid_self_bookings: 2,
      },
    });
  }

  const tokens = {};
  for (const perm of ['sessions', 'equipment', 'settings', 'seating']) {
    const staff = await prisma.adminUser.create({
      data: {
        name: `r33i3_${perm}_${runId}`,
        password: `r33i3_pw_${perm}_${runId}`,
        role: 'staff',
        permissions: [perm],
        is_active: true,
      },
    });
    createdAdmins.push(staff);
    tokens[perm] = generateToken({
      id: staff.id,
      role: 'admin',
      isSuperAdmin: false,
      token_version: staff.token_version,
    });
  }

  srv = await startLocalApp();
  const baseUrl = srv.baseUrl;
  const authHeaders = (perm) => ({
    'Content-Type': 'application/json',
    Authorization: `Bearer ${tokens[perm]}`,
  });

  // 1. sessions-only: update weekday_hourly_price 100 -> 120 succeeds (200)
  const resPriceOk = await fetch(`${baseUrl}/api/daily-settings/global`, {
    method: 'PUT',
    headers: authHeaders('sessions'),
    body: JSON.stringify({ weekday_hourly_price: 120 }),
  });
  assert.equal(resPriceOk.status, 200);
  let dbGlobal = await prisma.globalSetting.findUnique({ where: { id: 1 } });
  assert.equal(dbGlobal.weekday_hourly_price, 120);

  // 2. sessions-only: update line_messaging_token fails with 403 and leaves DB unchanged
  const tokenBefore = dbGlobal.line_messaging_token;
  const resTokenDenied = await fetch(`${baseUrl}/api/daily-settings/global`, {
    method: 'PUT',
    headers: authHeaders('sessions'),
    body: JSON.stringify({ line_messaging_token: 'unauthorized-line-token-value' }),
  });
  assert.equal(resTokenDenied.status, 403);
  const bodyTokenDenied = await resTokenDenied.json();
  assert.equal(bodyTokenDenied.code, 'PERMISSION_REQUIRED');
  assert.ok(bodyTokenDenied.fields.includes('line_messaging_token'));
  dbGlobal = await prisma.globalSetting.findUnique({ where: { id: 1 } });
  assert.equal(dbGlobal.line_messaging_token, tokenBefore);

  // 3. sessions-only: update price + payment_methods_json together -> 403, price NOT saved either
  const resMixedDenied = await fetch(`${baseUrl}/api/daily-settings/global`, {
    method: 'PUT',
    headers: authHeaders('sessions'),
    body: JSON.stringify({
      weekday_hourly_price: 199,
      payment_methods_json: [{ key: 'cash', label: '現金', enabled: true }],
    }),
  });
  assert.equal(resMixedDenied.status, 403);
  const bodyMixedDenied = await resMixedDenied.json();
  assert.equal(bodyMixedDenied.code, 'PERMISSION_REQUIRED');
  assert.ok(bodyMixedDenied.fields.includes('payment_methods_json'));
  assert.equal(bodyMixedDenied.fields.includes('weekday_hourly_price'), false);
  dbGlobal = await prisma.globalSetting.findUnique({ where: { id: 1 } });
  assert.equal(dbGlobal.weekday_hourly_price, 120);

  // 4. sessions-only: submit full GET /global payload with unchanged other fields + weekday_hourly_price: 130 -> 200
  const curGlobalRes = await fetch(`${baseUrl}/api/daily-settings/global`);
  assert.equal(curGlobalRes.status, 200);
  const curGlobal = await curGlobalRes.json();

  const resFullFormPrice = await fetch(`${baseUrl}/api/daily-settings/global`, {
    method: 'PUT',
    headers: authHeaders('sessions'),
    body: JSON.stringify({
      ...curGlobal,
      line_messaging_token: '••••••••1234',
      cancel_pending_jobs: false,
      weekday_hourly_price: 130,
    }),
  });
  assert.equal(resFullFormPrice.status, 200, `Expected full unchanged form + price edit to succeed, got ${resFullFormPrice.status}`);
  dbGlobal = await prisma.globalSetting.findUnique({ where: { id: 1 } });
  assert.equal(dbGlobal.weekday_hourly_price, 130);

  // 5. sessions-only: GET /api/kiosk/settings -> 200; PUT /api/kiosk/settings -> 403
  const resKioskGet = await fetch(`${baseUrl}/api/kiosk/settings`, {
    headers: authHeaders('sessions'),
  });
  assert.equal(resKioskGet.status, 200);

  const earlyBefore = (await prisma.kioskSetting.findUnique({ where: { id: 1 } })).early_minutes;
  const resKioskPutDenied = await fetch(`${baseUrl}/api/kiosk/settings`, {
    method: 'PUT',
    headers: authHeaders('sessions'),
    body: JSON.stringify({ early_minutes: 45 }),
  });
  assert.equal(resKioskPutDenied.status, 403);
  const bodyKioskDenied = await resKioskPutDenied.json();
  assert.equal(bodyKioskDenied.code, 'PERMISSION_REQUIRED');
  assert.deepEqual(bodyKioskDenied.required, ['settings']);
  assert.equal((await prisma.kioskSetting.findUnique({ where: { id: 1 } })).early_minutes, earlyBefore);

  // 6. equipment-only: update equipment_discount_buy_hours -> 200; update price -> 403
  const resEquipOk = await fetch(`${baseUrl}/api/daily-settings/global`, {
    method: 'PUT',
    headers: authHeaders('equipment'),
    body: JSON.stringify({ equipment_discount_buy_hours: 4 }),
  });
  assert.equal(resEquipOk.status, 200);
  dbGlobal = await prisma.globalSetting.findUnique({ where: { id: 1 } });
  assert.equal(dbGlobal.equipment_discount_buy_hours, 4);

  const resEquipPriceDenied = await fetch(`${baseUrl}/api/daily-settings/global`, {
    method: 'PUT',
    headers: authHeaders('equipment'),
    body: JSON.stringify({ weekday_hourly_price: 140 }),
  });
  assert.equal(resEquipPriceDenied.status, 403);
  const bodyEquipDenied = await resEquipPriceDenied.json();
  assert.equal(bodyEquipDenied.code, 'PERMISSION_REQUIRED');
  assert.deepEqual(bodyEquipDenied.fields, ['weekday_hourly_price']);
  assert.deepEqual(bodyEquipDenied.required, ['sessions']);

  // 7. seating-only: cannot modify global settings -> 403
  const resSeatingDenied = await fetch(`${baseUrl}/api/daily-settings/global`, {
    method: 'PUT',
    headers: authHeaders('seating'),
    body: JSON.stringify({ weekday_hourly_price: 145 }),
  });
  assert.equal(resSeatingDenied.status, 403);

  // 8. settings-only: updates all 3 groups + PUT /api/kiosk/settings -> 200
  const resSettingsAll = await fetch(`${baseUrl}/api/daily-settings/global`, {
    method: 'PUT',
    headers: authHeaders('settings'),
    body: JSON.stringify({
      weekday_hourly_price: 160,
      equipment_discount_buy_hours: 5,
      line_messaging_token: 'settings-role-token-9999',
    }),
  });
  assert.equal(resSettingsAll.status, 200);
  dbGlobal = await prisma.globalSetting.findUnique({ where: { id: 1 } });
  assert.equal(dbGlobal.weekday_hourly_price, 160);
  assert.equal(dbGlobal.equipment_discount_buy_hours, 5);
  assert.equal(dbGlobal.line_messaging_token, 'settings-role-token-9999');

  const resKioskPutOk = await fetch(`${baseUrl}/api/kiosk/settings`, {
    method: 'PUT',
    headers: authHeaders('settings'),
    body: JSON.stringify({ early_minutes: 25 }),
  });
  assert.equal(resKioskPutOk.status, 200);
  assert.equal((await prisma.kioskSetting.findUnique({ where: { id: 1 } })).early_minutes, 25);
});
