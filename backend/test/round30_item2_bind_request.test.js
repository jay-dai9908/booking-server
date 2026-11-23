import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import crypto from 'crypto';
import express from 'express';
import cookieParser from 'cookie-parser';
import prisma from '../src/prismaClient.js';
import authRoutes from '../src/routes/auth.js';
import userRoutes from '../src/routes/users.js';
import reservationRoutes from '../src/routes/reservations.js';
import passRoutes from '../src/routes/passes.js';
import shopRoutes from '../src/routes/shop.js';
import { generateToken } from '../src/middlewares/authMiddleware.js';
import { getBookingBill } from '../src/services/billing/billService.js';
import { processKioskAccess } from '../src/services/kiosk/accessService.js';
import { wrapPairKey } from '../src/services/kiosk/sgk1.js';
import { dateOnly, toTaipeiDateString } from '../../shared/time.js';
import { ensureTestPublishedLayout, cleanupTestPublishedLayout } from './helpers/seedTestLayout.js';

function startLocalTestServer() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/auth', authRoutes);
  app.use('/api/users', userRoutes);
  app.use('/api/reservations', reservationRoutes);
  app.use('/api/passes', passRoutes);
  app.use('/api/shop', shopRoutes);
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

test('Round 30 Item 2: manual member bind request flow, approval merge, and merged user exclusion across all phone lookups', async (t) => {
  const runId = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const phone1 = '0900000011';
  const phone2 = '0900000012';
  const todayStr = toTaipeiDateString(new Date());
  const todayDate = dateOnly(todayStr);

  const manualLineId = `manual_r30_i2_${runId}`;
  const manualLineIdReject = `manual_r30_i2_rej_${runId}`;
  const newLineId1 = `U_r30_i2_new1_${runId}`;
  const newLineId2 = `U_r30_i2_new2_${runId}`;
  const newLineId3 = `U_r30_i2_new3_${runId}`;
  const newLineIdReject = `U_r30_i2_rej_${runId}`;
  const phoneReject = '0900000013';

  const cleanupBookingRefs = [];
  const cleanupLineIds = [manualLineId, manualLineIdReject, newLineId1, newLineId2, newLineId3, newLineIdReject];
  const cleanupPhones = [phone1, phone2, phoneReject];

  let testServer = null;
  let createdLayoutId = null;
  let createdSession = null;
  let savedDailySetting = null;
  let savedGlobalSetting = null;
  let savedKioskSetting = null;
  let adminMembers = null;
  let adminNoMembers = null;
  let passPlan = null;
  let product = null;
  let kioskDevice = null;

  t.after(async () => {
    if (testServer) await testServer.close();

    // Clean up audit logs created during test
    await prisma.accountingEvent.deleteMany({
      where: {
        category: 'member',
        event_type: { in: ['member_merged', 'member_bind_rejected'] },
        staff_name: { in: ['R30 I2 Members Admin'] }
      }
    }).catch(() => {});

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
      await prisma.memberBindRequest.deleteMany({
        where: { OR: [{ new_user_id: { in: userIds } }, { manual_user_id: { in: userIds } }] }
      }).catch(() => {});
      await prisma.kioskAccessLog.deleteMany({ where: { user_id: { in: userIds } } }).catch(() => {});
      await prisma.bookingPrepay.deleteMany({ where: { user_id: { in: userIds } } }).catch(() => {});
      await prisma.userPass.deleteMany({ where: { user_id: { in: userIds } } }).catch(() => {});
      const orders = await prisma.productOrder.findMany({ where: { user_id: { in: userIds } }, select: { id: true } });
      if (orders.length > 0) {
        await prisma.productOrderItem.deleteMany({ where: { order_id: { in: orders.map((o) => o.id) } } }).catch(() => {});
        await prisma.productOrder.deleteMany({ where: { id: { in: orders.map((o) => o.id) } } }).catch(() => {});
      }
      await prisma.bookingPerson.deleteMany({ where: { booking_ref: { in: cleanupBookingRefs } } }).catch(() => {});
      await prisma.reservation.deleteMany({
        where: { OR: [{ user_id: { in: userIds } }, { booking_ref: { in: cleanupBookingRefs } }] }
      }).catch(() => {});
      await prisma.userLoginLog.deleteMany({ where: { user_id: { in: userIds } } }).catch(() => {});
      await prisma.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => {});
    }

    if (createdSession?.id) {
      await prisma.reservation.deleteMany({ where: { session_id: createdSession.id } }).catch(() => {});
      await prisma.session.delete({ where: { id: createdSession.id } }).catch(() => {});
    }
    if (passPlan?.id) {
      await prisma.passPlan.delete({ where: { id: passPlan.id } }).catch(() => {});
    }
    if (product?.id) {
      await prisma.product.delete({ where: { id: product.id } }).catch(() => {});
    }
    if (kioskDevice?.id) {
      await prisma.kioskAccessLog.deleteMany({ where: { device_id: kioskDevice.id } }).catch(() => {});
      await prisma.kioskDevice.delete({ where: { id: kioskDevice.id } }).catch(() => {});
    }
    if (adminMembers?.id) await prisma.adminUser.delete({ where: { id: adminMembers.id } }).catch(() => {});
    if (adminNoMembers?.id) await prisma.adminUser.delete({ where: { id: adminNoMembers.id } }).catch(() => {});

    if (savedDailySetting) {
      await prisma.dailySetting.update({
        where: { date: todayDate },
        data: { is_self_service: savedDailySetting.is_self_service }
      }).catch(() => {});
    } else {
      await prisma.dailySetting.deleteMany({ where: { date: todayDate } }).catch(() => {});
    }
    if (!savedGlobalSetting) {
      await prisma.globalSetting.deleteMany({ where: { id: 1 } }).catch(() => {});
    }
    if (!savedKioskSetting) {
      await prisma.kioskSetting.deleteMany({ where: { id: 1 } }).catch(() => {});
    }
    await cleanupTestPublishedLayout(prisma, createdLayoutId);
  });

  // Clean up any stale test data on those phones
  const staleUsers = await prisma.user.findMany({
    where: { phone: { in: cleanupPhones } },
    select: { id: true }
  });
  if (staleUsers.length > 0) {
    const staleIds = staleUsers.map((u) => u.id);
    await prisma.memberBindRequest.deleteMany({
      where: { OR: [{ new_user_id: { in: staleIds } }, { manual_user_id: { in: staleIds } }] }
    });
    await prisma.bookingPrepay.deleteMany({ where: { user_id: { in: staleIds } } });
    await prisma.userPass.deleteMany({ where: { user_id: { in: staleIds } } });
    await prisma.productOrder.deleteMany({ where: { user_id: { in: staleIds } } });
    await prisma.reservation.deleteMany({ where: { user_id: { in: staleIds } } });
    await prisma.userLoginLog.deleteMany({ where: { user_id: { in: staleIds } } });
    await prisma.user.deleteMany({ where: { id: { in: staleIds } } });
  }

  // Ensure GlobalSetting, DailySetting (today = self-service), KioskSetting, Layout, Session
  savedGlobalSetting = await prisma.globalSetting.findUnique({ where: { id: 1 } });
  if (!savedGlobalSetting) {
    await prisma.globalSetting.create({ data: { id: 1 } });
  }
  savedDailySetting = await prisma.dailySetting.findUnique({ where: { date: todayDate } });
  await prisma.dailySetting.upsert({
    where: { date: todayDate },
    update: { is_self_service: true },
    create: { date: todayDate, is_self_service: true }
  });
  savedKioskSetting = await prisma.kioskSetting.findUnique({ where: { id: 1 } });
  if (!savedKioskSetting) {
    await prisma.kioskSetting.create({ data: { id: 1, early_minutes: 30, after_close_minutes: 60 } });
  }

  createdLayoutId = await ensureTestPublishedLayout(prisma, { effectiveDate: todayStr });
  createdSession = await prisma.session.findUnique({
    where: { session_date_start_time: { session_date: todayDate, start_time: '14:00' } }
  });
  if (!createdSession) {
    createdSession = await prisma.session.create({
      data: {
        session_date: todayDate,
        start_time: '14:00',
        end_time: '15:00',
        max_capacity: 16
      }
    });
  } else {
    createdSession = null; // do not delete pre-existing session in cleanup
  }
  const sessionRow = createdSession || await prisma.session.findUnique({
    where: { session_date_start_time: { session_date: todayDate, start_time: '14:00' } }
  });

  kioskDevice = await prisma.kioskDevice.create({
    data: {
      name: 'R30 I2 Kiosk',
      key_wrapped: wrapPairKey(crypto.randomBytes(32), process.env.JWT_SECRET),
      is_active: true,
      paired_at: new Date()
    }
  });

  // Create manual user with phone1 + reservation + pass (3 remaining) + productOrder + bookingPrepay
  const manualUser = await prisma.user.create({
    data: {
      line_user_id: manualLineId,
      name: 'Manual Old Name',
      phone: phone1,
      is_blacklisted: true,
      notes: '舊備註'
    }
  });

  const bookingRef = `R30-I2-${runId}`;
  cleanupBookingRefs.push(bookingRef);
  await prisma.reservation.create({
    data: {
      booking_ref: bookingRef,
      session_id: sessionRow.id,
      user_id: manualUser.id,
      pax: 2,
      status: 'confirmed',
      is_self_service: true,
      is_paid: true,
      billing_status: 'paid',
      total_amount: 200,
      amount_due: 200,
      amount_received: 200
    }
  });

  await prisma.bookingPrepay.create({
    data: {
      booking_ref: bookingRef,
      user_id: manualUser.id,
      total_amount: 200,
      amount_due: 200,
      status: 'verified'
    }
  });

  passPlan = await prisma.passPlan.create({
    data: {
      code: `R30_PLAN_${runId}`,
      name: 'R30 測試次數卡',
      pass_type: 'PUNCH_CARD',
      price: 500,
      total_quota: 5,
      is_active: true
    }
  });

  const userPass = await prisma.userPass.create({
    data: {
      pass_code: `PASS-R30-${runId}`,
      user_id: manualUser.id,
      plan_id: passPlan.id,
      plan_name_snapshot: passPlan.name,
      pass_type: 'PUNCH_CARD',
      total_quota: 5,
      remaining_quota: 3,
      payment_status: 'active',
      status: 'ACTIVE',
      expires_at: new Date('2099-12-31T23:59:59+08:00')
    }
  });

  product = await prisma.product.create({
    data: {
      code: `R30_PROD_${runId}`,
      name: 'R30 測試商品',
      price: 300
    }
  });

  const productOrder = await prisma.productOrder.create({
    data: {
      order_ref: `ORD-R30-${runId}`,
      user_id: manualUser.id,
      total_amount: 300,
      deposit_required: 100,
      balance_amount: 200,
      payment_method_code: 'transfer',
      payment_status: 'pending_payment',
      order_status: 'PREORDER_PLACED',
      items: {
        create: [{
          product_id: product.id,
          product_code_snapshot: product.code,
          product_name_snapshot: product.name,
          price_snapshot: 300,
          quantity: 1,
          subtotal: 300
        }]
      }
    }
  });

  // Compute bill before merge
  const billBefore = await getBookingBill(bookingRef);

  // Create admin users (one with members+reservations+shop, one without members)
  const adminPass1 = `r30_i2_adm1_${runId}`;
  const adminPass2 = `r30_i2_adm2_${runId}`;
  adminMembers = await prisma.adminUser.create({
    data: {
      name: 'R30 I2 Members Admin',
      password: adminPass1,
      role: 'staff',
      permissions: ['members', 'reservations', 'shop'],
      is_active: true
    }
  });
  adminNoMembers = await prisma.adminUser.create({
    data: {
      name: 'R30 I2 NoMembers Admin',
      password: adminPass2,
      role: 'staff',
      permissions: ['reservations'],
      is_active: true
    }
  });

  testServer = await startLocalTestServer();
  const baseUrl = testServer.baseUrl;

  const loginAdmin = async (password) => {
    const res = await fetch(`${baseUrl}/api/auth/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password })
    });
    assert.equal(res.status, 200);
    return (await res.json()).token;
  };
  const membersToken = await loginAdmin(adminPass1);
  const noMembersToken = await loginAdmin(adminPass2);

  // 1. New LINE account registers with phone1 (same as manualUser)
  const tempToken1 = generateToken({ line_user_id: newLineId1, isTemp: true, typ: 'line_temp' }, { expiresIn: '30m' });
  const regRes1 = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tempToken1}` },
    body: JSON.stringify({ name: 'New LINE Alice', phone: phone1 })
  });
  assert.equal(regRes1.status, 200);
  const regBody1 = await regRes1.json();

  // Manual user's line_user_id must NOT change; a new User row must be created
  const manualAfterReg = await prisma.user.findUnique({ where: { id: manualUser.id } });
  assert.equal(manualAfterReg.line_user_id, manualLineId);
  const newUser1 = await prisma.user.findUnique({ where: { line_user_id: newLineId1 } });
  assert.ok(newUser1);
  assert.notEqual(newUser1.id, manualUser.id);
  assert.equal(newUser1.phone, phone1);

  // MemberBindRequest created with pending status and pass_summary containing remaining: 3
  const bindReqs = await prisma.memberBindRequest.findMany({
    where: { new_user_id: newUser1.id, manual_user_id: manualUser.id }
  });
  assert.equal(bindReqs.length, 1);
  const bindReq = bindReqs[0];
  assert.equal(bindReq.status, 'pending');
  assert.equal(bindReq.phone, phone1);
  assert.ok(Array.isArray(bindReq.pass_summary));
  assert.equal(bindReq.pass_summary.length, 1);
  assert.equal(bindReq.pass_summary[0].user_pass_id, userPass.id);
  assert.equal(bindReq.pass_summary[0].remaining, 3);

  // Before approval: new user sees NO reservations and NO passes
  const myResBefore = await fetch(`${baseUrl}/api/reservations/my`, {
    headers: { Authorization: `Bearer ${regBody1.token}` }
  });
  assert.equal(myResBefore.status, 200);
  assert.deepEqual(await myResBefore.json(), []);

  const myPassesBefore = await fetch(`${baseUrl}/api/passes/my`, {
    headers: { Authorization: `Bearer ${regBody1.token}` }
  });
  assert.equal(myPassesBefore.status, 200);
  assert.deepEqual(await myPassesBefore.json(), []);

  // 2. Register with phone2 (NO manual user) -> response structure & values (excluding token & user.name/phone) must be identical
  const tempToken2 = generateToken({ line_user_id: newLineId2, isTemp: true, typ: 'line_temp' }, { expiresIn: '30m' });
  const regRes2 = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tempToken2}` },
    body: JSON.stringify({ name: 'New LINE Bob', phone: phone2 })
  });
  assert.equal(regRes2.status, 200);
  const regBody2 = await regRes2.json();

  assert.deepEqual(Object.keys(regBody1).sort(), Object.keys(regBody2).sort());
  assert.equal(regBody1.message, regBody2.message);
  assert.equal(regBody1.requireLineLoginEveryTime, regBody2.requireLineLoginEveryTime);
  assert.deepEqual(Object.keys(regBody1.user).sort(), Object.keys(regBody2.user).sort());

  // 3. Before approval (while pending), adminCreateReservation with phone1 must prefer real LINE user (newUser1)
  const adminCreateBeforeRes = await fetch(`${baseUrl}/api/reservations/admin`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${membersToken}` },
    body: JSON.stringify({
      session_ids: [sessionRow.id],
      pax: 1,
      name: 'Counter Pending',
      phone: phone1
    })
  });
  assert.equal(adminCreateBeforeRes.status, 201);
  const adminCreatedBeforeData = await adminCreateBeforeRes.json();
  const createdRefBefore = adminCreatedBeforeData.booking_ref || adminCreatedBeforeData.reservation?.booking_ref;
  if (createdRefBefore) cleanupBookingRefs.push(createdRefBefore);
  const resBeforeRow = await prisma.reservation.findFirst({ where: { booking_ref: createdRefBefore } });
  assert.equal(resBeforeRow.user_id, newUser1.id, 'Before approval, adminCreateReservation should prefer real LINE user');

  // 4. Staff WITHOUT 'members' permission gets 403 on approve
  const unauthApprove = await fetch(`${baseUrl}/api/users/bind-requests/${bindReq.id}/approve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${noMembersToken}` },
    body: JSON.stringify({})
  });
  assert.equal(unauthApprove.status, 403);

  // 5. Inspect GET /api/users/bind-requests and GET /api/users/:id/bind-requests
  const listPendingRes = await fetch(`${baseUrl}/api/users/bind-requests?status=pending`, {
    headers: { Authorization: `Bearer ${membersToken}` }
  });
  assert.equal(listPendingRes.status, 200);
  const listPendingData = await listPendingRes.json();
  assert.ok(listPendingData.requests.some((r) => r.id === bindReq.id));

  const userBindRes = await fetch(`${baseUrl}/api/users/${newUser1.id}/bind-requests`, {
    headers: { Authorization: `Bearer ${membersToken}` }
  });
  assert.equal(userBindRes.status, 200);
  const userBindData = await userBindRes.json();
  assert.equal(userBindData.requests.length, 1);
  assert.equal(userBindData.requests[0].manual_stats.reservation_count, 1);
  assert.equal(userBindData.requests[0].manual_stats.future_reservation_count, 1);
  assert.equal(userBindData.requests[0].manual_stats.product_order_count, 1);

  // 6. Approve bind request
  const approveRes = await fetch(`${baseUrl}/api/users/bind-requests/${bindReq.id}/approve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${membersToken}` },
    body: JSON.stringify({ note: '核對本人無誤' })
  });
  assert.equal(approveRes.status, 200);

  // Verify moved rows & merged user fields
  const [movedRes, movedPass, movedOrder, movedPrepay, mergedManual, updatedNewUser, auditRow] = await Promise.all([
    prisma.reservation.findFirst({ where: { booking_ref: bookingRef } }),
    prisma.userPass.findUnique({ where: { id: userPass.id } }),
    prisma.productOrder.findUnique({ where: { id: productOrder.id } }),
    prisma.bookingPrepay.findUnique({ where: { booking_ref: bookingRef } }),
    prisma.user.findUnique({ where: { id: manualUser.id } }),
    prisma.user.findUnique({ where: { id: newUser1.id } }),
    prisma.accountingEvent.findFirst({
      where: { category: 'member', event_type: 'member_merged' },
      orderBy: { id: 'desc' }
    })
  ]);

  assert.equal(movedRes.user_id, newUser1.id);
  assert.equal(movedPass.user_id, newUser1.id);
  assert.equal(movedOrder.user_id, newUser1.id);
  assert.equal(movedPrepay.user_id, newUser1.id);

  assert.equal(mergedManual.merged_into_user_id, newUser1.id);
  assert.ok(mergedManual.merged_at);
  assert.equal(mergedManual.phone, phone1, 'Old phone must be retained on merged manual user');

  assert.equal(updatedNewUser.is_blacklisted, true);
  assert.ok(updatedNewUser.notes.includes('[合併自櫃檯建檔]'));
  assert.ok(updatedNewUser.notes.includes('舊備註'));
  assert.ok(auditRow, 'member_merged audit log must exist');

  // After approval: new user sees pass with remaining: 3, and bill total matches before merge
  const myPassesAfter = await fetch(`${baseUrl}/api/passes/my`, {
    headers: { Authorization: `Bearer ${regBody1.token}` }
  });
  assert.equal(myPassesAfter.status, 200);
  const myPassesList = await myPassesAfter.json();
  assert.equal(myPassesList.length, 1);
  assert.equal(myPassesList[0].remaining_quota, 3);

  const billAfter = await getBookingBill(bookingRef);
  assert.equal(billAfter.total_amount, billBefore.total_amount);

  // 7. Re-approving same request returns 409
  const reApproveRes = await fetch(`${baseUrl}/api/users/bind-requests/${bindReq.id}/approve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${membersToken}` },
    body: JSON.stringify({})
  });
  assert.equal(reApproveRes.status, 409);

  // Reject -> then approve returns 409
  const manualRej = await prisma.user.create({
    data: { line_user_id: manualLineIdReject, name: 'Manual Reject', phone: phoneReject }
  });
  const newRej = await prisma.user.create({
    data: { line_user_id: newLineIdReject, name: 'New Reject', phone: phoneReject }
  });
  const reqRej = await prisma.memberBindRequest.create({
    data: { new_user_id: newRej.id, manual_user_id: manualRej.id, phone: phoneReject, status: 'pending', pass_summary: [] }
  });
  const rejectRes = await fetch(`${baseUrl}/api/users/bind-requests/${reqRej.id}/reject`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${membersToken}` },
    body: JSON.stringify({ note: '非本人' })
  });
  assert.equal(rejectRes.status, 200);
  const approveAfterReject = await fetch(`${baseUrl}/api/users/bind-requests/${reqRej.id}/approve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${membersToken}` },
    body: JSON.stringify({})
  });
  assert.equal(approveAfterReject.status, 409);

  // 8. After approval: adminCreateReservation with phone1 attaches to newUser1
  const adminCreateAfterRes = await fetch(`${baseUrl}/api/reservations/admin`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${membersToken}` },
    body: JSON.stringify({
      session_ids: [sessionRow.id],
      pax: 1,
      name: 'Counter After',
      phone: phone1
    })
  });
  assert.equal(adminCreateAfterRes.status, 201);
  const adminCreatedAfterData = await adminCreateAfterRes.json();
  const createdRefAfter = adminCreatedAfterData.booking_ref || adminCreatedAfterData.reservation?.booking_ref;
  if (createdRefAfter) cleanupBookingRefs.push(createdRefAfter);
  const resAfterRow = await prisma.reservation.findFirst({ where: { booking_ref: createdRefAfter } });
  assert.equal(resAfterRow.user_id, newUser1.id);

  // 9. Deliberately plant a "leaked" reservation directly on the merged manual user
  const leakedRef = `R30-LEAK-${runId}`;
  cleanupBookingRefs.push(leakedRef);
  await prisma.reservation.create({
    data: {
      booking_ref: leakedRef,
      session_id: sessionRow.id,
      user_id: manualUser.id,
      pax: 1,
      status: 'confirmed',
      is_self_service: true,
      is_paid: true,
      billing_status: 'paid',
      total_amount: 100
    }
  });

  // All lookups using phone1 must only match newUser1 and NEVER return the leaked manual record:
  // (a) Another LINE user registers with phone1 -> 409 PHONE_ALREADY_BOUND, no new bind request
  const tempToken3 = generateToken({ line_user_id: newLineId3, isTemp: true, typ: 'line_temp' }, { expiresIn: '30m' });
  const regRes3 = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tempToken3}` },
    body: JSON.stringify({ name: 'Another LINE', phone: phone1 })
  });
  assert.equal(regRes3.status, 409);
  assert.equal((await regRes3.json()).code, 'PHONE_ALREADY_BOUND');
  const totalReqsForManual = await prisma.memberBindRequest.count({ where: { manual_user_id: manualUser.id } });
  assert.equal(totalReqsForManual, 1);

  // (b) GET /api/users?search=0900000011 vs include_merged=1
  const usersDefaultRes = await fetch(`${baseUrl}/api/users?search=${phone1}`, {
    headers: { Authorization: `Bearer ${membersToken}` }
  });
  assert.equal(usersDefaultRes.status, 200);
  const usersDefaultData = await usersDefaultRes.json();
  assert.equal(usersDefaultData.data.length, 1);
  assert.equal(usersDefaultData.data[0].id, newUser1.id);

  const usersIncRes = await fetch(`${baseUrl}/api/users?search=${phone1}&include_merged=1`, {
    headers: { Authorization: `Bearer ${membersToken}` }
  });
  assert.equal(usersIncRes.status, 200);
  const usersIncData = await usersIncRes.json();
  assert.equal(usersIncData.data.length, 2);
  const mergedRow = usersIncData.data.find((u) => u.id === manualUser.id);
  assert.equal(mergedRow.merged_into_user_id, newUser1.id);

  // (c) Kiosk phone check-in opens door with newUser1's name (NOT manualUser's)
  const accessRes = await processKioskAccess(prisma, {
    device: kioskDevice,
    method: 'phone',
    payload: phone1,
    now: new Date(`${todayStr}T14:05:00+08:00`),
    notifyFn: async () => {},
    reseatFn: async () => {}
  });
  assert.equal(accessRes.open_door, true);
  assert.equal(accessRes.booking.name, 'New LINE Alice');
  assert.notEqual(accessRes.booking.booking_ref, leakedRef);

  // (d) Admin reservations search, quick-lookup, shop orders search
  const adminResSearch = await fetch(`${baseUrl}/api/reservations/admin?search=${phone1}`, {
    headers: { Authorization: `Bearer ${membersToken}` }
  });
  assert.equal(adminResSearch.status, 200);
  const adminResData = await adminResSearch.json();
  const adminResList = adminResData.data || [];
  assert.ok(adminResList.length > 0);
  assert.ok(adminResList.every((r) => r.user_id === newUser1.id || r.user?.id === newUser1.id));
  assert.ok(!adminResList.some((r) => r.booking_ref === leakedRef));

  const quickLookupRes = await fetch(`${baseUrl}/api/reservations/admin/quick-lookup?q=${phone1}`, {
    headers: { Authorization: `Bearer ${membersToken}` }
  });
  assert.equal(quickLookupRes.status, 200);
  const qlData = await quickLookupRes.json();
  assert.ok(qlData.reservations.length > 0);
  assert.ok(qlData.reservations.every((r) => r.user?.id === newUser1.id));
  assert.ok(!qlData.reservations.some((r) => r.booking_ref === leakedRef));
  assert.ok(qlData.passes.every((p) => p.user?.id === newUser1.id));
  assert.ok(qlData.shop_orders.every((o) => o.user?.id === newUser1.id));

  const shopOrdersRes = await fetch(`${baseUrl}/api/shop/admin/orders?search=${phone1}`, {
    headers: { Authorization: `Bearer ${membersToken}` }
  });
  assert.equal(shopOrdersRes.status, 200);
  const shopOrdersData = await shopOrdersRes.json();
  assert.equal(shopOrdersData.orders.length, 1);
  assert.equal(shopOrdersData.orders[0].user.id, newUser1.id);
});
