import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import cookieParser from 'cookie-parser';
import axios from 'axios';
import prisma from '../src/prismaClient.js';
import { generateToken } from '../src/middlewares/authMiddleware.js';
import reservationRoutes from '../src/routes/reservations.js';
import {
  formatBookingRef,
  sendSelfServiceTransferPendingNotification,
  sendSelfServiceExpiredNotification,
  sendSelfServiceVerifiedNotification,
  sendSelfServiceMismatchNotification,
  sendSelfServiceRemindNotification,
} from '../src/utils/lineMessaging.js';
import { toTaipeiDateString } from '../../shared/time.js';

function startLocalApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/reservations', reservationRoutes);
  const server = http.createServer(app);
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', (err) => {
      if (err) return reject(err);
      resolve({
        baseUrl: `http://127.0.0.1:${server.address().port}`,
        close: () => new Promise((res) => server.close(res))
      });
    });
  });
}

test('Round 50 Item 3: LINE templates format 5 refs as BK-XXXX-XXXX and quick-lookup matches QR / BK ref', async () => {
  const origPost = axios.post;
  const prevLineEnv = process.env.LINE_MESSAGING_ACCESS_TOKEN;
  const capturedPayloads = [];
  axios.post = async (_url, payload) => {
    capturedPayloads.push(payload);
    return { data: {} };
  };
  process.env.LINE_MESSAGING_ACCESS_TOKEN = `unit_${Date.now()}`;

  const ts = Date.now();
  const rawRef = `aa11bb22cc33dd44ee55${String(ts).slice(-4)}`;
  const expectedFormatted = formatBookingRef(rawRef);
  assert.match(expectedFormatted, /^BK-AA11-[0-9A-Z]{4}$/);

  const testUser = { line_user_id: `U_r50_i3_${ts}`, name: 'R50顧客' };
  const baseInfo = {
    booking_ref: rawRef,
    session_date: '2026-12-10',
    time_range: '18:00 - 22:00',
    amount_due: 500,
    deadline_at: '2026-12-09T10:00:00.000Z',
    open_at: '17:30',
    pass_restored: false,
    note: '金額不同'
  };

  let dbUser = null;
  let createdSession = null;
  let reservation = null;
  let admin = null;
  let srv = null;

  try {
    await sendSelfServiceTransferPendingNotification(baseInfo, testUser);
    await sendSelfServiceExpiredNotification(baseInfo, testUser);
    await sendSelfServiceVerifiedNotification(baseInfo, testUser);
    await sendSelfServiceMismatchNotification(baseInfo, testUser);
    await sendSelfServiceRemindNotification(baseInfo, testUser);

    assert.equal(capturedPayloads.length, 5);
    for (const payload of capturedPayloads) {
      const jsonStr = JSON.stringify(payload);
      assert.ok(jsonStr.includes(expectedFormatted), `Expected ${expectedFormatted} in LINE payload`);
      assert.ok(!jsonStr.includes(rawRef), `Raw UUID ref ${rawRef} should not leak into LINE payload`);
    }

    const dateStr = toTaipeiDateString(new Date(Date.now() + 4 * 86400000));
    const sessionDate = new Date(`${dateStr}T00:00:00.000Z`);
    let session = await prisma.session.findUnique({
      where: { session_date_start_time: { session_date: sessionDate, start_time: '14:00' } }
    });
    if (!session) {
      session = await prisma.session.create({
        data: {
          session_date: sessionDate,
          start_time: '14:00',
          end_time: '15:00',
          max_capacity: 10
        }
      });
      createdSession = session;
    }

    dbUser = await prisma.user.create({
      data: {
        name: 'R50 QuickLookup User',
        phone: `0988${String(ts).slice(-6)}`,
        line_user_id: `r50_ql_${ts}`
      }
    });
    reservation = await prisma.reservation.create({
      data: {
        booking_ref: rawRef,
        user_id: dbUser.id,
        session_id: session.id,
        pax: 1,
        total_amount: 100,
        status: 'confirmed'
      }
    });
    admin = await prisma.adminUser.create({
      data: {
        name: 'R50 Lookup Admin',
        password: `r50ql_${ts}`,
        role: 'admin',
        is_active: true,
        permissions: ['reservations']
      }
    });
    const adminToken = generateToken({
      id: admin.id,
      name: admin.name,
      role: 'admin',
      token_version: admin.token_version,
      typ: 'admin'
    });

    srv = await startLocalApp();
    // Lookup by formatted BK-XXXX-XXXX
    let res = await fetch(`${srv.baseUrl}/api/reservations/admin/quick-lookup?q=${encodeURIComponent(expectedFormatted)}`, {
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    assert.equal(res.status, 200);
    let data = await res.json();
    assert.ok(data.reservations.some((r) => r.booking_ref === rawRef));

    // Lookup by raw ref encoded in QR
    res = await fetch(`${srv.baseUrl}/api/reservations/admin/quick-lookup?q=${encodeURIComponent(rawRef)}`, {
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    assert.equal(res.status, 200);
    data = await res.json();
    assert.ok(data.reservations.some((r) => r.booking_ref === rawRef));
  } finally {
    axios.post = origPost;
    if (prevLineEnv === undefined) delete process.env.LINE_MESSAGING_ACCESS_TOKEN;
    else process.env.LINE_MESSAGING_ACCESS_TOKEN = prevLineEnv;
    if (srv) await srv.close();
    if (reservation) await prisma.reservation.deleteMany({ where: { id: reservation.id } });
    if (createdSession) await prisma.session.deleteMany({ where: { id: createdSession.id } });
    if (dbUser) await prisma.user.deleteMany({ where: { id: dbUser.id } });
    if (admin) await prisma.adminUser.deleteMany({ where: { id: admin.id } });
  }
});
