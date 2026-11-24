import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import express from 'express';
import cookieParser from 'cookie-parser';
import prisma from '../src/prismaClient.js';
import reservationRoutes from '../src/routes/reservations.js';
import { generateToken } from '../src/middlewares/authMiddleware.js';
import { getBookingBill, collectPayment, supplementPayment } from '../src/services/billing/billService.js';
import { solidifyDailyPrices } from '../src/services/pricing/solidify.js';
import { ensureTestPublishedLayout, cleanupTestPublishedLayout } from './helpers/seedTestLayout.js';
import { dateOnly } from '../../shared/time.js';

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
        close: () => new Promise((r) => server.close(r))
      });
    });
  });
}

test('Round 37 Item 2: reservation pricing_snapshot, supplement rate, and solidifyDailyPrices backfill', async (t) => {
  const runId = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const futureWeekday = dateOnly('2099-08-05'); // Wednesday (weekday)
  const pastDayA = dateOnly('2000-01-03'); // Monday (weekday)
  const pastDayB = dateOnly('2000-01-04'); // Tuesday (weekday)
  const pastDayC = dateOnly('2000-01-05'); // Wednesday (weekday)
  const testDates = [futureWeekday, pastDayA, pastDayB, pastDayC];
  const createdRefs = [];
  const createdSessionIds = [];

  let srv = null;
  let user = null;
  let createdLayoutId = null;
  let globalOrig = null;

  t.after(async () => {
    if (srv) await srv.close().catch(() => {});
    if (globalOrig) {
      await prisma.globalSetting.update({
        where: { id: globalOrig.id },
        data: {
          weekday_hourly_price: globalOrig.weekday_hourly_price,
          weekday_unlimited_price: globalOrig.weekday_unlimited_price,
          weekend_hourly_price: globalOrig.weekend_hourly_price,
          weekend_unlimited_price: globalOrig.weekend_unlimited_price
        }
      }).catch(() => {});
    }
    if (createdRefs.length > 0) {
      await prisma.printJob.deleteMany({ where: { booking_ref: { in: createdRefs } } }).catch(() => {});
      await prisma.payment.deleteMany({ where: { booking_ref: { in: createdRefs } } }).catch(() => {});
      await prisma.bookingPerson.deleteMany({ where: { booking_ref: { in: createdRefs } } }).catch(() => {});
      await prisma.reservation.deleteMany({ where: { booking_ref: { in: createdRefs } } }).catch(() => {});
    }
    if (createdSessionIds.length > 0) {
      await prisma.session.deleteMany({ where: { id: { in: createdSessionIds } } }).catch(() => {});
    }
    await prisma.dailySetting.deleteMany({ where: { date: { in: testDates } } }).catch(() => {});
    if (user?.id) await prisma.user.delete({ where: { id: user.id } }).catch(() => {});
    await cleanupTestPublishedLayout(prisma, createdLayoutId);
  });

  createdLayoutId = await ensureTestPublishedLayout(prisma);
  srv = await startLocalApp();

  globalOrig = await prisma.globalSetting.findFirst();
  await prisma.globalSetting.update({
    where: { id: globalOrig.id },
    data: {
      weekday_hourly_price: 150,
      weekday_unlimited_price: 750
    }
  });

  user = await prisma.user.create({
    data: {
      line_user_id: `r37_i2_user_${runId}`,
      name: 'R37價格快照客',
      phone: `09972${String(Date.now()).slice(-5)}` // check-secrets: fake-data
    }
  });
  const customerToken = generateToken({
    id: user.id,
    typ: 'customer',
    role: 'customer',
    isTemp: false
  });

  const s1 = await prisma.session.create({ data: { session_date: futureWeekday, start_time: '14:00', end_time: '15:00', max_capacity: 20 } });
  const s2 = await prisma.session.create({ data: { session_date: futureWeekday, start_time: '15:00', end_time: '16:00', max_capacity: 20 } });
  const s3 = await prisma.session.create({ data: { session_date: futureWeekday, start_time: '16:00', end_time: '17:00', max_capacity: 20 } });
  createdSessionIds.push(s1.id, s2.id, s3.id);

  // 1. Online create while weekday hourly is 150 -> 3h booking
  const resCreate = await fetch(`${srv.baseUrl}/api/reservations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: `token=${customerToken}` },
    body: JSON.stringify({
      session_ids: [s1.id, s2.id, s3.id],
      pax: 1
    })
  });
  const createData = await resCreate.json();
  assert.equal(resCreate.status, 201, `create failed: ${JSON.stringify(createData)}`);
  const snapRef = createData.reservation.booking_ref;
  createdRefs.push(snapRef);

  // 2. Legacy booking on same day with pricing_snapshot = null
  const legacyRef = `R37-I2-LEG-${runId}`;
  createdRefs.push(legacyRef);
  await prisma.reservation.createMany({
    data: [s1.id, s2.id, s3.id].map(sid => ({
      booking_ref: legacyRef,
      session_id: sid,
      user_id: user.id,
      pax: 1,
      status: 'confirmed',
      assigned_seats: ['A2-1'],
      pricing_snapshot: null
    }))
  });
  await prisma.bookingPerson.create({
    data: { booking_ref: legacyRef, person_no: 1, seat_code: 'A2-1', status: 'active' }
  });

  // Raise GlobalSetting weekday_hourly_price to 200
  await prisma.globalSetting.update({
    where: { id: globalOrig.id },
    data: { weekday_hourly_price: 200 }
  });

  const billSnap = await getBookingBill(snapRef);
  assert.equal(billSnap.bill.summary.amount_due, 450, 'snapshotted booking stays 3 * 150 = 450');

  const billLegacy = await getBookingBill(legacyRef);
  assert.equal(billLegacy.bill.summary.amount_due, 600, 'legacy null-snapshot booking follows current global price (600)');

  // 3. Collect and supplement +1 hour on snapshotted booking -> uses snapshot rate 150
  const staff = { id: 1, name: `R37店員_${runId}` };
  const dev = { device_id: 'd1', device_label: 'Counter' };
  await collectPayment(snapRef, {
    person_nos: [1],
    method: 'cash',
    cash_received: 450,
    expected_amount: 450,
    print: false
  }, staff, dev);

  const supRes = await supplementPayment(snapRef, {
    person_no: 1,
    method: 'cash',
    cash_received: 150,
    items: [{ type: 'hours', hours: 1 }],
    print: false
  }, staff, dev);
  assert.equal(supRes.payment.amount, 150);

  // 4. Solidify past dates:
  // Reset GlobalSetting weekday rate to 170 before running solidify
  await prisma.globalSetting.update({
    where: { id: globalOrig.id },
    data: { weekday_hourly_price: 170, weekday_unlimited_price: 800 }
  });

  const sA = await prisma.session.create({ data: { session_date: pastDayA, start_time: '14:00', end_time: '15:00', max_capacity: 10 } });
  const sB = await prisma.session.create({ data: { session_date: pastDayB, start_time: '14:00', end_time: '16:00', max_capacity: 10 } });
  const sC = await prisma.session.create({ data: { session_date: pastDayC, start_time: '14:00', end_time: '16:00', max_capacity: 10 } });
  createdSessionIds.push(sA.id, sB.id, sC.id);

  await prisma.dailySetting.create({
    data: { date: pastDayA, hourly_price: 120, unlimited_price: 600, allow_unlimited: true }
  });
  await prisma.dailySetting.create({
    data: { date: pastDayB, hourly_price: null, unlimited_price: null, allow_unlimited: false }
  });
  // pastDayC intentionally has NO DailySetting

  const solid1 = await solidifyDailyPrices({ through: pastDayC });
  assert.equal(solid1.count, 2);

  const dsA = await prisma.dailySetting.findUnique({ where: { date: pastDayA } });
  const dsB = await prisma.dailySetting.findUnique({ where: { date: pastDayB } });
  const dsC = await prisma.dailySetting.findUnique({ where: { date: pastDayC } });

  assert.equal(dsA.hourly_price, 120);
  assert.equal(dsB.hourly_price, 170);
  assert.equal(dsB.unlimited_price, 800);
  assert.equal(dsB.allow_unlimited, false);
  assert.equal(dsC.hourly_price, 170);
  assert.equal(dsC.unlimited_price, 800);

  // Running solidify again changes nothing
  const solid2 = await solidifyDailyPrices({ through: pastDayC });
  assert.equal(solid2.count, 0);

  // 5. Legacy booking on pastDayC before vs after changing GlobalSetting again -> stays 2 * 170 = 340
  const pastLegRef = `R37-I2-PAST-${runId}`;
  createdRefs.push(pastLegRef);
  await prisma.reservation.create({
    data: {
      booking_ref: pastLegRef,
      session_id: sC.id,
      user_id: user.id,
      pax: 1,
      status: 'confirmed',
      assigned_seats: ['A3-1'],
      pricing_snapshot: null
    }
  });
  await prisma.bookingPerson.create({
    data: { booking_ref: pastLegRef, person_no: 1, seat_code: 'A3-1', status: 'active' }
  });
  const billPastBefore = await getBookingBill(pastLegRef);
  await prisma.globalSetting.update({
    where: { id: globalOrig.id },
    data: { weekday_hourly_price: 250, weekday_unlimited_price: 999 }
  });
  const billPastAfter = await getBookingBill(pastLegRef);
  assert.equal(billPastBefore.bill.summary.amount_due, 340);
  assert.equal(billPastAfter.bill.summary.amount_due, 340);
});
