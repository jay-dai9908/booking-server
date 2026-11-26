import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import cookieParser from 'cookie-parser';
import prisma from '../src/prismaClient.js';
import { generateToken } from '../src/middlewares/authMiddleware.js';
import reservationRoutes from '../src/routes/reservations.js';
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

test('Round 50 Item 2: GET /api/reservations/my includes server_now ISO timestamp on returned bookings', async () => {
  const ts = Date.now();
  const phone = `0977${String(ts).slice(-6)}`;
  const dateStr = toTaipeiDateString(new Date(Date.now() + 3 * 86400000));
  const bookingRef = `BK-${ts}-SN`;
  let user = null;
  let createdSession = null;
  let reservation = null;
  let srv = null;

  try {
    user = await prisma.user.create({
      data: {
        name: 'R50 ServerNow Test',
        phone,
        line_user_id: `r50_sn_${ts}`
      }
    });
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
    reservation = await prisma.reservation.create({
      data: {
        booking_ref: bookingRef,
        user_id: user.id,
        session_id: session.id,
        pax: 1,
        total_amount: 100,
        status: 'confirmed',
        attendance: 'pending',
        is_self_service: false
      }
    });

    const token = generateToken({ id: user.id, role: 'customer', typ: 'customer' });
    srv = await startLocalApp();

    const beforeMs = Date.now();
    const res = await fetch(`${srv.baseUrl}/api/reservations/my`, {
      headers: { Cookie: `token=${token}` }
    });
    const afterMs = Date.now();
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body) && body.length === 1);
    assert.ok(typeof body[0].server_now === 'string' && body[0].server_now.length > 0);
    const parsedMs = Date.parse(body[0].server_now);
    assert.ok(Number.isFinite(parsedMs));
    assert.ok(parsedMs >= beforeMs - 5000 && parsedMs <= afterMs + 5000);
  } finally {
    if (srv) await srv.close();
    if (reservation) await prisma.reservation.deleteMany({ where: { id: reservation.id } });
    if (createdSession) await prisma.session.deleteMany({ where: { id: createdSession.id } });
    if (user) await prisma.user.deleteMany({ where: { id: user.id } });
  }
});
