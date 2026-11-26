import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import cookieParser from 'cookie-parser';
import prisma from '../src/prismaClient.js';
import { ensureDatabaseSchema } from '../src/db/ensureSchema.js';
import { generateToken } from '../src/middlewares/authMiddleware.js';
import dailySettingRoutes from '../src/routes/dailySettings.js';
import reservationRoutes from '../src/routes/reservations.js';
import { dateOnly, toTaipeiDateString } from '../../shared/time.js';
import { ensureTestPublishedLayout, cleanupTestPublishedLayout } from './helpers/seedTestLayout.js';

function startLocalApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/daily-settings', dailySettingRoutes);
  app.use('/api/reservations', reservationRoutes);

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

test('Round 48 Item 4: store_phone GlobalSetting CRUD & customer cancel requires confirm_no_transfer when assigned_pool_account exists', async () => {
  const TS = Date.now();
  await ensureDatabaseSchema();
  const srv = await startLocalApp();

  const origGlobal = await prisma.globalSetting.findUnique({ where: { id: 1 } });
  let createdLayoutId = null;
  let adminUser = null;
  let customer = null;
  const createdSessionIds = [];
  const createdDates = [];
  const createdPoolIds = [];
  const createdBookingRefs = [];
  let createdBankMethod = false;
  let createdPoolMethod = false;
  const bankMethodCode = `r48i4_bank_${TS}`;
  const poolMethodCode = 'ctbc_pool';

  try {
    createdLayoutId = await ensureTestPublishedLayout(prisma);

    adminUser = await prisma.adminUser.create({
      data: {
        name: `R48I4管理員_${TS}`,
        password: `R48I4_${TS}_Pass!`,
        permissions: ['settings', 'reservations'],
        is_active: true
      }
    });
    const adminToken = generateToken({
      id: adminUser.id,
      role: 'admin',
      name: adminUser.name,
      permissions: ['settings', 'reservations'],
      token_version: adminUser.token_version
    });
    const adminHdr = { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` };

    customer = await prisma.user.create({
      data: {
        name: 'R48I4顧客',
        phone: `0977${String(TS).slice(-6)}`,
        line_user_id: `r48_i4_cust_${TS}`
      }
    });
    const custToken = generateToken({
      id: customer.id,
      typ: 'customer',
      line_user_id: customer.line_user_id,
      role: 'customer',
      name: customer.name
    });
    const custHdr = { 'Content-Type': 'application/json', Authorization: `Bearer ${custToken}` };

    // 1. store_phone roundtrip via PUT & GET /api/daily-settings/global
    const putPhone = await fetch(`${srv.baseUrl}/api/daily-settings/global`, {
      method: 'PUT',
      headers: adminHdr,
      body: JSON.stringify({ store_phone: '02-0000-0000' })
    });
    assert.equal(putPhone.status, 200);
    const getGlobal = await fetch(`${srv.baseUrl}/api/daily-settings/global`);
    assert.equal(getGlobal.status, 200);
    const globalBody = await getGlobal.json();
    assert.equal(globalBody.store_phone, '02-0000-0000');

    // Setup payment methods + pool accounts + future self-service days
    const existingPoolCfg = await prisma.paymentMethodConfig.findUnique({ where: { code: poolMethodCode } });
    if (!existingPoolCfg) {
      await prisma.paymentMethodConfig.create({
        data: { code: poolMethodCode, name: '專屬帳號', method_type: 'POOL_ACCOUNT', is_enabled: true }
      });
      createdPoolMethod = true;
    }
    await prisma.paymentMethodConfig.create({
      data: {
        code: bankMethodCode,
        name: '一般轉帳',
        method_type: 'MULTI_BANK',
        is_enabled: true,
        bank_accounts_json: [{ bank_name: '測試銀', bank_code: '007', account: '00000000000999' }]
      }
    });
    createdBankMethod = true;

    const poolAcc1 = await prisma.oneTimeAccountPool.create({
      data: {
        payment_method_code: poolMethodCode,
        bank_code: '822',
        bank_name: '測試專戶銀',
        account_number: `00000401${String(TS).slice(-6)}`,
        status: 'AVAILABLE'
      }
    });
    const poolAcc2 = await prisma.oneTimeAccountPool.create({
      data: {
        payment_method_code: poolMethodCode,
        bank_code: '822',
        bank_name: '測試專戶銀',
        account_number: `00000402${String(TS).slice(-6)}`,
        status: 'AVAILABLE'
      }
    });
    createdPoolIds.push(poolAcc1.id, poolAcc2.id);

    const fut1 = toTaipeiDateString(new Date(Date.now() + 70 * 86400000));
    const fut2 = toTaipeiDateString(new Date(Date.now() + 71 * 86400000));
    const sessMap = {};
    for (const dStr of [fut1, fut2]) {
      const dObj = dateOnly(dStr);
      const exists = await prisma.dailySetting.findUnique({ where: { date: dObj } });
      if (!exists) createdDates.push(dObj);
      await prisma.dailySetting.upsert({
        where: { date: dObj },
        update: { is_self_service: true, allow_unlimited: true, day_type: 'self', day_type_source: 'manual' },
        create: { date: dObj, is_self_service: true, allow_unlimited: true, day_type: 'self', day_type_source: 'manual' }
      });
      sessMap[dStr] = [];
      for (const [start_time, end_time] of [['13:00', '14:00'], ['14:00', '15:00'], ['15:00', '16:00'], ['16:00', '17:00']]) {
        let s = await prisma.session.findUnique({ where: { session_date_start_time: { session_date: dObj, start_time } } });
        if (!s) {
          s = await prisma.session.create({ data: { session_date: dObj, start_time, end_time, max_capacity: 10 } });
          createdSessionIds.push(s.id);
        }
        sessMap[dStr].push(s);
      }
    }

    // Create customer pool booking A (day 1)
    const createPoolRes = await fetch(`${srv.baseUrl}/api/reservations`, {
      method: 'POST',
      headers: custHdr,
      body: JSON.stringify({
        session_ids: sessMap[fut1].map((s) => s.id),
        pax: 1,
        isUnlimited: true,
        self_service_ack: true,
        prepay: { pass_uses: [], transfer: { payment_method_code: poolMethodCode } }
      })
    });
    assert.equal(createPoolRes.status, 201);
    const poolResA = await createPoolRes.json();
    const refA = poolResA.reservation.booking_ref;
    createdBookingRefs.push(refA);

    const assignedNumA = (await prisma.bookingPrepay.findUnique({ where: { booking_ref: refA } })).assigned_pool_account;
    assert.ok(assignedNumA);

    // 2. Customer cancel without confirm_no_transfer -> 409 CONFIRM_NO_TRANSFER
    const cancelNoFlag = await fetch(`${srv.baseUrl}/api/reservations/${refA}`, {
      method: 'DELETE',
      headers: custHdr
    });
    assert.equal(cancelNoFlag.status, 409);
    const bodyNoFlag = await cancelNoFlag.json();
    assert.equal(bodyNoFlag.code, 'CONFIRM_NO_TRANSFER');

    const rowAStill = await prisma.reservation.findFirst({ where: { booking_ref: refA } });
    assert.equal(rowAStill.status, 'confirmed');
    const poolStill = await prisma.oneTimeAccountPool.findUnique({ where: { account_number: assignedNumA } });
    assert.equal(poolStill.status, 'ASSIGNED');

    // 3. Customer cancel WITH { confirm_no_transfer: true } -> 200 & pool returns AVAILABLE
    const cancelWithFlag = await fetch(`${srv.baseUrl}/api/reservations/${refA}`, {
      method: 'DELETE',
      headers: custHdr,
      body: JSON.stringify({ confirm_no_transfer: true })
    });
    assert.equal(cancelWithFlag.status, 200);
    const poolReleased = await prisma.oneTimeAccountPool.findUnique({ where: { account_number: assignedNumA } });
    assert.equal(poolReleased.status, 'AVAILABLE');

    // 4. Customer cancel MULTI_BANK (no assigned_pool_account) without flag -> 200
    const createBankRes = await fetch(`${srv.baseUrl}/api/reservations`, {
      method: 'POST',
      headers: custHdr,
      body: JSON.stringify({
        session_ids: sessMap[fut1].map((s) => s.id),
        pax: 1,
        isUnlimited: true,
        self_service_ack: true,
        prepay: { pass_uses: [], transfer: { payment_method_code: bankMethodCode } }
      })
    });
    assert.equal(createBankRes.status, 201);
    const refB = (await createBankRes.json()).reservation.booking_ref;
    createdBookingRefs.push(refB);
    const cancelBankNoFlag = await fetch(`${srv.baseUrl}/api/reservations/${refB}`, {
      method: 'DELETE',
      headers: custHdr
    });
    assert.equal(cancelBankNoFlag.status, 200);

    // 5. Admin cancel pool booking WITHOUT confirm_no_transfer -> 200
    const createPoolRes2 = await fetch(`${srv.baseUrl}/api/reservations`, {
      method: 'POST',
      headers: custHdr,
      body: JSON.stringify({
        session_ids: sessMap[fut2].map((s) => s.id),
        pax: 1,
        isUnlimited: true,
        self_service_ack: true,
        prepay: { pass_uses: [], transfer: { payment_method_code: poolMethodCode } }
      })
    });
    assert.equal(createPoolRes2.status, 201);
    const refC = (await createPoolRes2.json()).reservation.booking_ref;
    createdBookingRefs.push(refC);
    const adminCancelRes = await fetch(`${srv.baseUrl}/api/reservations/admin/${refC}/cancel`, {
      method: 'POST',
      headers: adminHdr
    });
    assert.equal(adminCancelRes.status, 200);
  } finally {
    await srv.close();
    if (createdBookingRefs.length > 0) {
      await prisma.reservation.deleteMany({ where: { booking_ref: { in: createdBookingRefs } } }).catch(() => {});
      await prisma.bookingPrepay.deleteMany({ where: { booking_ref: { in: createdBookingRefs } } }).catch(() => {});
      await prisma.accountingEvent.deleteMany({ where: { booking_ref: { in: createdBookingRefs } } }).catch(() => {});
    }
    if (createdPoolIds.length > 0) {
      await prisma.oneTimeAccountPool.deleteMany({ where: { id: { in: createdPoolIds } } }).catch(() => {});
    }
    if (createdSessionIds.length > 0) {
      await prisma.session.deleteMany({ where: { id: { in: createdSessionIds } } }).catch(() => {});
    }
    if (createdDates.length > 0) {
      await prisma.dailySetting.deleteMany({ where: { date: { in: createdDates } } }).catch(() => {});
    }
    if (createdBankMethod) {
      await prisma.paymentMethodConfig.deleteMany({ where: { code: bankMethodCode } }).catch(() => {});
    }
    if (createdPoolMethod) {
      await prisma.paymentMethodConfig.deleteMany({ where: { code: poolMethodCode } }).catch(() => {});
    }
    if (customer) {
      await prisma.user.deleteMany({ where: { id: customer.id } }).catch(() => {});
    }
    if (adminUser) {
      await prisma.adminUser.deleteMany({ where: { id: adminUser.id } }).catch(() => {});
    }
    if (origGlobal) {
      await prisma.globalSetting.update({ where: { id: 1 }, data: { store_phone: origGlobal.store_phone ?? null } }).catch(() => {});
      await prisma.accountingEvent.deleteMany({ where: { category: 'setting', event_type: 'setting_changed', staff_id: adminUser?.id || -1 } }).catch(() => {});
    }
    await cleanupTestPublishedLayout(prisma, createdLayoutId);
  }
});
