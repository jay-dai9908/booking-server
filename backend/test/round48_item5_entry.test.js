import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import cookieParser from 'cookie-parser';
import prisma from '../src/prismaClient.js';
import { generateToken } from '../src/middlewares/authMiddleware.js';
import reservationRoutes from '../src/routes/reservations.js';
import { getReservationEntryPass } from '../src/services/kiosk/entryService.js';
import { dateOnly, toTaipeiDateString } from '../../shared/time.js';

function startLocalApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
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

test('Round 48 Item 5: GET /api/reservations/:ref/entry returns dynamic early_minutes and null until without sessions', async () => {
  const TS = Date.now();
  const srv = await startLocalApp();
  const origKiosk = await prisma.kioskSetting.findUnique({ where: { id: 1 } });
  let customer = null;
  let session = null;
  let createdDate = null;
  const ref = `R48I5-${TS}`;

  try {
    await prisma.kioskSetting.upsert({
      where: { id: 1 },
      update: { early_minutes: 45 },
      create: { id: 1, early_minutes: 45 }
    });

    customer = await prisma.user.create({
      data: { name: 'R48進場卡客', phone: `0966${String(TS).slice(-6)}`, line_user_id: `r48_i5_${TS}` }
    });
    const token = generateToken({
      id: customer.id,
      typ: 'customer',
      line_user_id: customer.line_user_id,
      role: 'customer',
      name: customer.name
    });

    const futStr = toTaipeiDateString(new Date(Date.now() + 80 * 86400000));
    const futDate = dateOnly(futStr);
    const existingDs = await prisma.dailySetting.findUnique({ where: { date: futDate } });
    if (!existingDs) createdDate = futDate;
    await prisma.dailySetting.upsert({
      where: { date: futDate },
      update: { is_self_service: true, day_type: 'self', day_type_source: 'manual' },
      create: { date: futDate, is_self_service: true, day_type: 'self', day_type_source: 'manual' }
    });

    session = await prisma.session.create({
      data: { session_date: futDate, start_time: '13:00', end_time: '14:00', max_capacity: 10 }
    });

    await prisma.reservation.create({
      data: {
        booking_ref: ref,
        session_id: session.id,
        user_id: customer.id,
        pax: 1,
        status: 'confirmed',
        is_self_service: true,
        is_paid: true,
        billing_status: 'paid'
      }
    });

    await prisma.bookingPrepay.create({
      data: {
        booking_ref: ref,
        user_id: customer.id,
        total_amount: 550,
        amount_due: 550,
        status: 'verified'
      }
    });

    const res1 = await fetch(`${srv.baseUrl}/api/reservations/${ref}/entry`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    assert.equal(res1.status, 200);
    const body1 = await res1.json();
    assert.equal(body1.early_minutes, 45);
    assert.equal(body1.until, '14:00');

    // Pure mock check: when allDaySessions is empty, until must be null (no fake 21:00)
    const mockDb = {
      reservation: {
        findMany: async () => [{
          booking_ref: ref,
          user_id: customer.id,
          status: 'confirmed',
          is_self_service: true,
          is_paid: true,
          billing_status: 'paid',
          assigned_seats: [],
          session: { session_date: futDate, start_time: '13:00', end_time: '14:00' }
        }]
      },
      bookingPrepay: { findUnique: async () => ({ booking_ref: ref, status: 'verified', amount_due: 0 }) },
      dailySetting: { findUnique: async () => ({ date: futDate, is_self_service: true }) },
      kioskSetting: { findUnique: async () => ({ id: 1, early_minutes: 45, after_close_minutes: 60 }) },
      session: { findMany: async () => [] },
      globalSetting: { findUnique: async () => ({ seat_layout_enabled: false }) },
      bookingEquipment: { findMany: async () => [] }
    };
    const emptyDayPass = await getReservationEntryPass(mockDb, { bookingRef: ref, userId: customer.id });
    assert.equal(emptyDayPass.until, null);
    assert.equal(emptyDayPass.early_minutes, 45);
  } finally {
    await srv.close();
    await prisma.reservation.deleteMany({ where: { booking_ref: ref } }).catch(() => {});
    await prisma.bookingPrepay.deleteMany({ where: { booking_ref: ref } }).catch(() => {});
    if (session) await prisma.session.deleteMany({ where: { id: session.id } }).catch(() => {});
    if (createdDate) await prisma.dailySetting.deleteMany({ where: { date: createdDate } }).catch(() => {});
    if (customer) await prisma.user.deleteMany({ where: { id: customer.id } }).catch(() => {});
    if (origKiosk) {
      await prisma.kioskSetting.upsert({
        where: { id: 1 },
        update: { early_minutes: origKiosk.early_minutes },
        create: origKiosk
      }).catch(() => {});
    } else {
      await prisma.kioskSetting.deleteMany({ where: { id: 1 } }).catch(() => {});
    }
  }
});
