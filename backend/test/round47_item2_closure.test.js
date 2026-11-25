import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import prisma from '../src/prismaClient.js';
import { dateOnly, toTaipeiDateString } from '../../shared/time.js';
import dailySettingsRoutes from '../src/routes/dailySettings.js';
import reservationRoutes from '../src/routes/reservations.js';
import sessionRoutes from '../src/routes/sessions.js';
import { getBookingBill } from '../src/services/billing/billService.js';
import { generateToken } from '../src/middlewares/authMiddleware.js';

function signAdmin(adminUser) {
  return generateToken({
    id: adminUser.id,
    role: 'admin',
    name: adminUser.name,
    token_version: adminUser.token_version || 0
  });
}

function signCustomer(user) {
  return generateToken({
    id: user.id,
    typ: 'customer',
    role: 'customer',
    name: user.name
  });
}

async function startTestApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/daily-settings', dailySettingsRoutes);
  app.use('/api/reservations', reservationRoutes);
  app.use('/api/sessions', sessionRoutes);

  return await new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve({ server, baseUrl: `http://127.0.0.1:${addr.port}` });
    });
  });
}

test('Round 47 Item 2: Admin day-type assignment, DAY_CLOSED across 4 booking entries, and AFFECTS_UNPAID check', async () => {
  const runId = Date.now();
  const dClosedStr = '2026-12-02';
  const dThuStr = '2026-12-03';
  const dClosedDate = dateOnly(dClosedStr);
  const dThuDate = dateOnly(dThuStr);

  // Compute yesterday in Taipei time
  const yesterdayDt = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const yesterdayStr = toTaipeiDateString(yesterdayDt);

  const prevGlobal = await prisma.globalSetting.findUnique({ where: { id: 1 } });
  let srv = null;
  const createdSessionIds = [];
  const createdUserIds = [];
  const createdRefs = [];

  try {
    await prisma.globalSetting.upsert({
      where: { id: 1 },
      update: {
        weekday_hourly_price: 150,
        weekday_unlimited_price: 750,
        weekend_hourly_price: 180,
        weekend_unlimited_price: 1100
      },
      create: {
        id: 1,
        weekday_hourly_price: 150,
        weekday_unlimited_price: 750,
        weekend_hourly_price: 180,
        weekend_unlimited_price: 1100
      }
    });

    await prisma.dailySetting.deleteMany({ where: { date: { in: [dClosedDate, dThuDate] } } });

    const ensureSession = async (session_date, start_time, end_time) => {
      const existing = await prisma.session.findUnique({
        where: { session_date_start_time: { session_date, start_time } }
      });
      if (existing) {
        if (existing.closed_at) {
          return await prisma.session.update({
            where: { id: existing.id },
            data: { closed_at: null, closed_by: null }
          });
        }
        return existing;
      }
      const created = await prisma.session.create({
        data: { session_date, start_time, end_time, max_capacity: 16 }
      });
      createdSessionIds.push(created.id);
      return created;
    };

    const [sClosed1, sClosed2, sThu1] = await Promise.all([
      ensureSession(dClosedDate, '13:00', '14:00'),
      ensureSession(dClosedDate, '14:00', '15:00'),
      ensureSession(dThuDate, '13:00', '14:00')
    ]);

    const customer = await prisma.user.create({
      data: {
        name: `R47I2顧客-${runId}`,
        phone: `0977${String(runId).slice(-6)}`,
        line_user_id: `U_R47I2_${runId}`
      }
    });
    createdUserIds.push(customer.id);

    const adminUser = await prisma.adminUser.upsert({
      where: { password: `r47-admin-${runId}` },
      update: {},
      create: {
        name: 'R47店長',
        password: `r47-admin-${runId}`,
        role: 'superadmin',
        permissions: ['all'],
        is_active: true
      }
    });

    const adminToken = signAdmin(adminUser);
    const customerToken = signCustomer(customer);

    srv = await startTestApp();

    // Pre-existing confirmed booking on 2026-12-02 before closing
    const existingBookRes = await fetch(`${srv.baseUrl}/api/reservations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${customerToken}` },
      body: JSON.stringify({ session_ids: [sClosed1.id], pax: 1, is_unlimited: false })
    });
    assert.equal(existingBookRes.status, 201);
    const existingBody = await existingBookRes.json();
    const existingRef = existingBody.reservation.booking_ref;
    createdRefs.push(existingRef);
    const billBeforeClose = await getBookingBill(existingRef, prisma);

    // 1. Set 2026-12-02 to closed with closed_note='設備維修'
    const closeRes = await fetch(`${srv.baseUrl}/api/daily-settings/day-type`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ date: dClosedStr, day_type: 'closed', closed_note: '設備維修' })
    });
    assert.equal(closeRes.status, 200);

    // Audit log recorded
    const auditEvent = await prisma.accountingEvent.findFirst({
      where: { event_type: 'daily_setting_changed', target_ref: dClosedStr },
      orderBy: { id: 'desc' }
    });
    assert.ok(auditEvent);
    assert.equal(auditEvent.after_json?.day_type, 'closed');

    // Customer create -> 409 DAY_CLOSED
    const custTry = await fetch(`${srv.baseUrl}/api/reservations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${customerToken}` },
      body: JSON.stringify({ session_ids: [sClosed2.id], pax: 1, is_unlimited: false })
    });
    assert.equal(custTry.status, 409);
    const custTryBody = await custTry.json();
    assert.equal(custTryBody.code, 'DAY_CLOSED');
    assert.ok(custTryBody.error.includes('設備維修') || custTryBody.closed_note === '設備維修');

    // Admin manual/walk-in create -> 409 DAY_CLOSED
    const adminTry = await fetch(`${srv.baseUrl}/api/reservations/admin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ name: '臨時客', phone: '', session_ids: [sClosed2.id], pax: 1, is_walk_in: true })
    });
    assert.equal(adminTry.status, 409);
    const adminTryBody = await adminTry.json();
    assert.equal(adminTryBody.code, 'DAY_CLOSED');

    // Extend existing booking onto closed day -> 409 DAY_CLOSED
    const extendTry = await fetch(`${srv.baseUrl}/api/reservations/admin/${existingRef}/extend`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ session_ids: [sClosed2.id] })
    });
    assert.equal(extendTry.status, 409);
    const extendTryBody = await extendTry.json();
    assert.equal(extendTryBody.code, 'DAY_CLOSED');

    // Self-service prepay-quote on closed day -> 409 DAY_CLOSED
    const quoteTry = await fetch(`${srv.baseUrl}/api/reservations/prepay-quote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${customerToken}` },
      body: JSON.stringify({ session_ids: [sClosed2.id], pax: 1, isUnlimited: true })
    });
    assert.equal(quoteTry.status, 409);
    const quoteTryBody = await quoteTry.json();
    assert.equal(quoteTryBody.code, 'DAY_CLOSED');

    // Customer GET /sessions?date=2026-12-02 -> empty list & day_closed: true
    const sessCust = await fetch(`${srv.baseUrl}/api/sessions?date=${dClosedStr}`);
    assert.equal(sessCust.status, 200);
    const sessCustBody = await sessCust.json();
    assert.equal(sessCustBody.day_closed, true);
    assert.equal(sessCustBody.closed_note, '設備維修');
    assert.deepEqual(sessCustBody.sessions, []);

    // Existing reservation unchanged & bill unchanged
    const existingRow = await prisma.reservation.findFirst({ where: { booking_ref: existingRef } });
    assert.equal(existingRow.status, 'confirmed');
    const billAfterClose = await getBookingBill(existingRef, prisma);
    assert.equal(billAfterClose.bill.summary.amount_due, billBeforeClose.bill.summary.amount_due);

    // 2. Day with confirmed booking switching to self -> 422
    const selfConflictRes = await fetch(`${srv.baseUrl}/api/daily-settings/day-type`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ date: dClosedStr, day_type: 'self' })
    });
    assert.equal(selfConflictRes.status, 422);

    // 3. Switch 2026-12-02 back to auto -> customer can book
    const reopenRes = await fetch(`${srv.baseUrl}/api/daily-settings/day-type`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ date: dClosedStr, day_type: 'auto' })
    });
    assert.equal(reopenRes.status, 200);

    const custBookOpen = await fetch(`${srv.baseUrl}/api/reservations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${customerToken}` },
      body: JSON.stringify({ session_ids: [sClosed2.id], pax: 1, is_unlimited: false })
    });
    assert.equal(custBookOpen.status, 201);
    const openBody = await custBookOpen.json();
    createdRefs.push(openBody.reservation.booking_ref);

    // 4. Yesterday -> 422
    const pastRes = await fetch(`${srv.baseUrl}/api/daily-settings/day-type`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ date: yesterdayStr, day_type: 'closed' })
    });
    assert.equal(pastRes.status, 422);

    // 5. 2026-12-03 (Thu): snapshot vs null-snapshot legacy unpaid bookings
    // 5a. Only snapshotted booking -> succeeds without confirm_affected, keeps weekday price 150, new gets 180
    const snapBookRes = await fetch(`${srv.baseUrl}/api/reservations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${customerToken}` },
      body: JSON.stringify({ session_ids: [sThu1.id], pax: 1, is_unlimited: false })
    });
    assert.equal(snapBookRes.status, 201);
    const snapRef = (await snapBookRes.json()).reservation.booking_ref;
    createdRefs.push(snapRef);

    const holSnapOnly = await fetch(`${srv.baseUrl}/api/daily-settings/day-type`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ date: dThuStr, day_type: 'holiday' })
    });
    assert.equal(holSnapOnly.status, 200);

    const snapBillAfter = await getBookingBill(snapRef, prisma);
    assert.equal(snapBillAfter.bill.summary.amount_due, 150);

    const newThuRes = await fetch(`${srv.baseUrl}/api/reservations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${customerToken}` },
      body: JSON.stringify({ session_ids: [sThu1.id], pax: 1, is_unlimited: false })
    });
    assert.equal(newThuRes.status, 201);
    const newThuRef = (await newThuRes.json()).reservation.booking_ref;
    createdRefs.push(newThuRef);
    const newThuBill = await getBookingBill(newThuRef, prisma);
    assert.equal(newThuBill.bill.summary.amount_due, 180);

    // 5b. Add null-snapshot legacy booking on 2026-12-03 (while currently holiday) -> switch back to weekday -> 409 AFFECTS_UNPAID
    const legacyRef = `LEGACY-R47-${runId}`;
    createdRefs.push(legacyRef);
    await prisma.reservation.create({
      data: {
        booking_ref: legacyRef,
        session_id: sThu1.id,
        user_id: customer.id,
        pax: 1,
        status: 'confirmed',
        is_unlimited: false,
        pricing_snapshot: null
      }
    });
    await prisma.bookingPerson.create({
      data: { booking_ref: legacyRef, person_no: 1, status: 'active' }
    });

    const billLegacyBefore = await getBookingBill(legacyRef, prisma);
    assert.equal(billLegacyBefore.bill.summary.amount_due, 180);

    const unconfirmedChange = await fetch(`${srv.baseUrl}/api/daily-settings/day-type`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ date: dThuStr, day_type: 'weekday' })
    });
    assert.equal(unconfirmedChange.status, 409);
    const unconfirmedBody = await unconfirmedChange.json();
    assert.equal(unconfirmedBody.code, 'AFFECTS_UNPAID');
    assert.equal(unconfirmedBody.count, 1);

    const confirmedChange = await fetch(`${srv.baseUrl}/api/daily-settings/day-type`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ date: dThuStr, day_type: 'weekday', confirm_affected: true })
    });
    assert.equal(confirmedChange.status, 200);

    const billLegacyAfter = await getBookingBill(legacyRef, prisma);
    assert.equal(billLegacyAfter.bill.summary.amount_due, 150);
  } finally {
    if (srv?.server) await new Promise((r) => srv.server.close(r));
    const validRefs = createdRefs.filter(Boolean);
    if (validRefs.length > 0) {
      await prisma.bookingPerson.deleteMany({ where: { booking_ref: { in: validRefs } } });
      await prisma.reservation.deleteMany({ where: { booking_ref: { in: validRefs } } });
    }
    if (createdUserIds.length > 0) {
      await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    }
    if (createdSessionIds.length > 0) {
      await prisma.session.deleteMany({ where: { id: { in: createdSessionIds } } });
    }
    await prisma.dailySetting.deleteMany({ where: { date: { in: [dClosedDate, dThuDate] } } });
    await prisma.adminUser.deleteMany({ where: { password: `r47-admin-${runId}` } });
    if (prevGlobal) {
      await prisma.globalSetting.update({
        where: { id: 1 },
        data: {
          weekday_hourly_price: prevGlobal.weekday_hourly_price,
          weekday_unlimited_price: prevGlobal.weekday_unlimited_price,
          weekend_hourly_price: prevGlobal.weekend_hourly_price,
          weekend_unlimited_price: prevGlobal.weekend_unlimited_price
        }
      });
    }
  }
});
