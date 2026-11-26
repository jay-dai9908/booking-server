import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import cookieParser from 'cookie-parser';
import prisma from '../src/prismaClient.js';
import { generateToken } from '../src/middlewares/authMiddleware.js';
import reservationRoutes from '../src/routes/reservations.js';
import dailySettingRoutes from '../src/routes/dailySettings.js';
import { createReservationHandler } from '../src/controllers/reservationController.js';
import { resetReservationCreateLimiter } from '../src/middlewares/rateLimiter.js';
import { ensureDatabaseSchema } from '../src/db/ensureSchema.js';
import { dateOnly } from '../../shared/time.js';

function startLocalApp(fixedNowRef) {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/daily-settings', dailySettingRoutes);
  app.use('/api/reservations', reservationRoutes);
  app.post('/api/test-clock-reservations', (req, res, next) => {
    const uid = Number(req.headers['x-test-user-id']);
    req.user = { id: uid, typ: 'customer', role: 'customer' };
    next();
  }, createReservationHandler({ now: () => fixedNowRef.current }));

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

test('Round 49 Item 1: started/non-contiguous session guards, active booking & pax limits, concurrency lock, admin bypass, rate limiter, and fresh DB defaults', async () => {
  const ts = Date.now();
  const futureDateStr = '2099-06-15';
  const pastDateStr = '2020-01-15';
  const futureDate = dateOnly(futureDateStr);
  const pastDate = dateOnly(pastDateStr);
  const fixedNowRef = { current: new Date(`${futureDateStr}T14:30:00+08:00`) };

  let srv = null;
  let origGlobal = null;
  let customer = null;
  let customer2 = null;
  let adminUser = null;
  const createdSessionIds = [];
  const createdBookingRefs = [];
  const createdDates = [futureDate, pastDate];

  try {
    await ensureDatabaseSchema();
    resetReservationCreateLimiter();
    srv = await startLocalApp(fixedNowRef);

    origGlobal = await prisma.globalSetting.findUnique({ where: { id: 1 } });

    customer = await prisma.user.create({
      data: {
        name: 'R49測試客1',
        phone: `0971${String(ts).slice(-6)}`,
        line_user_id: `r49_i1_cust1_${ts}`
      }
    });
    customer2 = await prisma.user.create({
      data: {
        name: 'R49測試客2',
        phone: `0972${String(ts).slice(-6)}`,
        line_user_id: `r49_i1_cust2_${ts}`
      }
    });
    adminUser = await prisma.adminUser.create({
      data: {
        name: `R49管理員_${ts}`,
        password: `R49_Admin_${ts}!`,
        permissions: ['settings', 'reservations'],
        is_active: true
      }
    });

    const custToken = generateToken({
      id: customer.id,
      typ: 'customer',
      role: 'customer',
      line_user_id: customer.line_user_id,
      name: customer.name
    });
    const custHeaders = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${custToken}`
    };

    const adminToken = generateToken({
      id: adminUser.id,
      role: 'admin',
      name: adminUser.name,
      permissions: adminUser.permissions,
      token_version: 0
    });
    const adminHeaders = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${adminToken}`
    };

    // Seed future sessions (14:00..18:00) and past session
    const s14 = await prisma.session.create({ data: { session_date: futureDate, start_time: '14:00', end_time: '15:00', max_capacity: 20 } });
    const s15 = await prisma.session.create({ data: { session_date: futureDate, start_time: '15:00', end_time: '16:00', max_capacity: 20 } });
    const s16 = await prisma.session.create({ data: { session_date: futureDate, start_time: '16:00', end_time: '17:00', max_capacity: 20 } });
    const s17 = await prisma.session.create({ data: { session_date: futureDate, start_time: '17:00', end_time: '18:00', max_capacity: 20 } });
    const sPast = await prisma.session.create({ data: { session_date: pastDate, start_time: '13:00', end_time: '14:00', max_capacity: 20 } });
    createdSessionIds.push(s14.id, s15.id, s16.id, s17.id, sPast.id);

    // Clear any leftover dailySetting for those dates
    await prisma.dailySetting.deleteMany({ where: { date: { in: createdDates } } });

    // 1. Fresh DB / GlobalSetting defaults (3 and 8) & 422 validation
    const gRes = await fetch(`${srv.baseUrl}/api/daily-settings/global`);
    assert.equal(gRes.status, 200);
    const gData = await gRes.json();
    assert.equal(typeof gData.max_active_bookings_per_user, 'number');
    assert.equal(typeof gData.max_pax_per_booking, 'number');

    const badRes1 = await fetch(`${srv.baseUrl}/api/daily-settings/global`, {
      method: 'PUT',
      headers: adminHeaders,
      body: JSON.stringify({ max_active_bookings_per_user: -1 })
    });
    assert.equal(badRes1.status, 422);

    const badRes2 = await fetch(`${srv.baseUrl}/api/daily-settings/global`, {
      method: 'PUT',
      headers: adminHeaders,
      body: JSON.stringify({ max_pax_per_booking: '1.5' })
    });
    assert.equal(badRes2.status, 422);

    // 2. Time guard with injected clock now = 14:30
    // 14:00-15:00 already started -> 400 SESSION_STARTED
    let res = await fetch(`${srv.baseUrl}/api/test-clock-reservations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-test-user-id': String(customer.id) },
      body: JSON.stringify({ session_ids: [s14.id], pax: 1, forceSplit: true })
    });
    assert.equal(res.status, 400);
    let body = await res.json();
    assert.equal(body.code, 'SESSION_STARTED');

    // Non-contiguous 15:00-16:00 + 17:00-18:00 -> 400 SESSIONS_NOT_CONTIGUOUS
    res = await fetch(`${srv.baseUrl}/api/test-clock-reservations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-test-user-id': String(customer.id) },
      body: JSON.stringify({ session_ids: [s15.id, s17.id], pax: 1, forceSplit: true })
    });
    assert.equal(res.status, 400);
    body = await res.json();
    assert.equal(body.code, 'SESSIONS_NOT_CONTIGUOUS');

    // Valid future session 15:00-16:00 -> 201
    res = await fetch(`${srv.baseUrl}/api/test-clock-reservations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-test-user-id': String(customer.id) },
      body: JSON.stringify({ session_ids: [s15.id], pax: 1, forceSplit: true })
    });
    assert.equal(res.status, 201);
    const ref1 = (await res.json()).reservation.booking_ref;
    createdBookingRefs.push(ref1);

    // 3. Past ended confirmed booking does not count toward active limit; max_active_bookings_per_user = 2
    const pastRef = `R49-PAST-${ts}`;
    createdBookingRefs.push(pastRef);
    await prisma.reservation.create({
      data: {
        booking_ref: pastRef,
        session_id: sPast.id,
        user_id: customer.id,
        pax: 1,
        status: 'confirmed'
      }
    });

    await prisma.globalSetting.update({
      where: { id: 1 },
      data: { max_active_bookings_per_user: 2, max_pax_per_booking: 6 }
    });

    // 2nd active booking -> 201
    res = await fetch(`${srv.baseUrl}/api/test-clock-reservations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-test-user-id': String(customer.id) },
      body: JSON.stringify({ session_ids: [s16.id], pax: 1, forceSplit: true })
    });
    assert.equal(res.status, 201);
    const ref2 = (await res.json()).reservation.booking_ref;
    createdBookingRefs.push(ref2);

    // 3rd active booking -> 409 TOO_MANY_ACTIVE_BOOKINGS
    res = await fetch(`${srv.baseUrl}/api/test-clock-reservations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-test-user-id': String(customer.id) },
      body: JSON.stringify({ session_ids: [s17.id], pax: 1, forceSplit: true })
    });
    assert.equal(res.status, 409);
    body = await res.json();
    assert.equal(body.code, 'TOO_MANY_ACTIVE_BOOKINGS');

    // Cancel ref1 -> 3rd active booking now succeeds
    await prisma.reservation.updateMany({ where: { booking_ref: ref1 }, data: { status: 'cancelled' } });
    res = await fetch(`${srv.baseUrl}/api/test-clock-reservations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-test-user-id': String(customer.id) },
      body: JSON.stringify({ session_ids: [s17.id], pax: 1, forceSplit: true })
    });
    assert.equal(res.status, 201);
    const ref3 = (await res.json()).reservation.booking_ref;
    createdBookingRefs.push(ref3);

    // 4. Pax limit = 6: pax 7 -> 400 PAX_LIMIT; pax 6 -> 201 (after setting limit 0 for active count)
    res = await fetch(`${srv.baseUrl}/api/test-clock-reservations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-test-user-id': String(customer2.id) },
      body: JSON.stringify({ session_ids: [s15.id], pax: 7, forceSplit: true })
    });
    assert.equal(res.status, 400);
    body = await res.json();
    assert.equal(body.code, 'PAX_LIMIT');

    await prisma.globalSetting.update({ where: { id: 1 }, data: { max_active_bookings_per_user: 0 } });
    res = await fetch(`${srv.baseUrl}/api/test-clock-reservations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-test-user-id': String(customer2.id) },
      body: JSON.stringify({ session_ids: [s15.id], pax: 6, forceSplit: true })
    });
    assert.equal(res.status, 201);
    createdBookingRefs.push((await res.json()).reservation.booking_ref);

    // Also setting pax limit 0 allows 7
    await prisma.globalSetting.update({ where: { id: 1 }, data: { max_pax_per_booking: 0 } });
    res = await fetch(`${srv.baseUrl}/api/test-clock-reservations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-test-user-id': String(customer2.id) },
      body: JSON.stringify({ session_ids: [s16.id], pax: 7, forceSplit: true })
    });
    assert.equal(res.status, 201);
    createdBookingRefs.push((await res.json()).reservation.booking_ref);

    // 5. Concurrent Promise.all with max_active_bookings_per_user = 1 -> strictly 1 succeeds, 1 gets 409
    await prisma.reservation.deleteMany({ where: { user_id: customer2.id } });
    await prisma.globalSetting.update({ where: { id: 1 }, data: { max_active_bookings_per_user: 1, max_pax_per_booking: 8 } });
    const concResps = await Promise.all([
      fetch(`${srv.baseUrl}/api/test-clock-reservations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-test-user-id': String(customer2.id) },
        body: JSON.stringify({ session_ids: [s15.id], pax: 1, forceSplit: true })
      }),
      fetch(`${srv.baseUrl}/api/test-clock-reservations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-test-user-id': String(customer2.id) },
        body: JSON.stringify({ session_ids: [s16.id], pax: 1, forceSplit: true })
      })
    ]);
    const concStatuses = concResps.map((r) => r.status).sort();
    assert.deepEqual(concStatuses, [201, 409]);
    for (const r of concResps) {
      if (r.status === 201) {
        createdBookingRefs.push((await r.json()).reservation.booking_ref);
      }
    }

    // 6. Admin bypass + dynamic settings update (5, 10)
    const updRes = await fetch(`${srv.baseUrl}/api/daily-settings/global`, {
      method: 'PUT',
      headers: adminHeaders,
      body: JSON.stringify({ max_active_bookings_per_user: 5, max_pax_per_booking: 10 })
    });
    assert.equal(updRes.status, 200);
    const updatedGlobal = (await updRes.json()).setting;
    assert.equal(updatedGlobal.max_active_bookings_per_user, 5);
    assert.equal(updatedGlobal.max_pax_per_booking, 10);

    // Customer2 gets 400 PAX_LIMIT at pax 11
    res = await fetch(`${srv.baseUrl}/api/test-clock-reservations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-test-user-id': String(customer2.id) },
      body: JSON.stringify({ session_ids: [s17.id], pax: 11, forceSplit: true })
    });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).code, 'PAX_LIMIT');

    // Admin creates for customer with 11 pax despite limits
    const admCreateRes = await fetch(`${srv.baseUrl}/api/reservations/admin`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({
        session_ids: [s17.id],
        pax: 11,
        name: customer.name,
        phone: customer.phone,
        forceSplit: true
      })
    });
    assert.equal(admCreateRes.status, 201);
    const admCreateBody = await admCreateRes.json();
    createdBookingRefs.push(admCreateBody.reservation?.booking_ref || admCreateBody.booking_ref);

    // 7. Rate limiter: 10 requests pass limiter (400 validation), 11th gets 429 RATE_LIMITED
    resetReservationCreateLimiter();
    for (let i = 0; i < 10; i++) {
      const rlRes = await fetch(`${srv.baseUrl}/api/reservations`, {
        method: 'POST',
        headers: custHeaders,
        body: JSON.stringify({ session_ids: [s14.id], pax: 1 })
      });
      assert.notEqual(rlRes.status, 429);
    }
    const rl11 = await fetch(`${srv.baseUrl}/api/reservations`, {
      method: 'POST',
      headers: custHeaders,
      body: JSON.stringify({ session_ids: [s14.id], pax: 1 })
    });
    assert.equal(rl11.status, 429);
    assert.equal((await rl11.json()).code, 'RATE_LIMITED');
    resetReservationCreateLimiter();
  } finally {
    if (srv) await srv.close().catch(() => {});
    resetReservationCreateLimiter();
    await prisma.bookingEquipment.deleteMany({ where: { booking_ref: { in: createdBookingRefs } } }).catch(() => {});
    await prisma.bookingPerson.deleteMany({ where: { booking_ref: { in: createdBookingRefs } } }).catch(() => {});
    await prisma.payment.deleteMany({ where: { booking_ref: { in: createdBookingRefs } } }).catch(() => {});
    await prisma.reservation.deleteMany({ where: { session_id: { in: createdSessionIds } } }).catch(() => {});
    await prisma.dailySetting.deleteMany({ where: { date: { in: createdDates } } }).catch(() => {});
    await prisma.session.deleteMany({ where: { id: { in: createdSessionIds } } }).catch(() => {});
    const uids = [customer?.id, customer2?.id].filter(Boolean);
    if (uids.length) await prisma.user.deleteMany({ where: { id: { in: uids } } }).catch(() => {});
    if (adminUser) await prisma.adminUser.deleteMany({ where: { id: adminUser.id } }).catch(() => {});
    if (origGlobal) {
      await prisma.globalSetting.update({
        where: { id: 1 },
        data: {
          max_active_bookings_per_user: origGlobal.max_active_bookings_per_user,
          max_pax_per_booking: origGlobal.max_pax_per_booking
        }
      }).catch(() => {});
    }
  }
});
