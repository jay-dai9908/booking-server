import test from 'node:test';
import assert from 'node:assert/strict';
import prisma from '../src/prismaClient.js';
import { collectPayment, refundPayment, voidPayment } from '../src/services/billing/billService.js';
import { ensureTestPublishedLayout, cleanupTestPublishedLayout } from './helpers/seedTestLayout.js';
import { dateOnly } from '../../shared/time.js';

test('Round 36 Item 1: refund links related_payment_id, void checks active cash refunds for covered persons, and batch_no void stays booking-scoped', async (t) => {
  const runId = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const futureDate = dateOnly('2099-12-20');
  const refA = `R36-I1-A-${runId}`;
  const refB = `R36-I1-B-${runId}`;
  const refC = `R36-I1-C-${runId}`;
  const createdRefs = [refA, refB, refC];

  const staffUser = { id: 99, name: `R36店員_${runId}` };
  const deviceInfo = { device_id: 'dev-r36', device_label: 'R36測試台' };

  let user = null;
  let session = null;
  let dailySetting = null;
  let createdLayoutId = null;

  t.after(async () => {
    await prisma.printJob.deleteMany({ where: { booking_ref: { in: createdRefs } } }).catch(() => {});
    await prisma.payment.deleteMany({ where: { booking_ref: { in: createdRefs } } }).catch(() => {});
    await prisma.bookingPerson.deleteMany({ where: { booking_ref: { in: createdRefs } } }).catch(() => {});
    await prisma.reservation.deleteMany({ where: { booking_ref: { in: createdRefs } } }).catch(() => {});
    if (session?.id) await prisma.session.delete({ where: { id: session.id } }).catch(() => {});
    if (dailySetting === 'created') await prisma.dailySetting.delete({ where: { date: futureDate } }).catch(() => {});
    if (user?.id) await prisma.user.delete({ where: { id: user.id } }).catch(() => {});
    await cleanupTestPublishedLayout(prisma, createdLayoutId);
  });

  createdLayoutId = await ensureTestPublishedLayout(prisma);
  user = await prisma.user.create({
    data: {
      line_user_id: `r36_i1_user_${runId}`,
      name: 'R36退款關聯客',
      phone: `09961${String(Date.now()).slice(-5)}` // check-secrets: fake-data
    }
  });

  const existingDaily = await prisma.dailySetting.findUnique({ where: { date: futureDate } });
  if (!existingDaily) {
    await prisma.dailySetting.create({
      data: { date: futureDate, hourly_price: 250, unlimited_price: 900, allow_unlimited: true, is_self_service: false }
    });
    dailySetting = 'created';
  }

  session = await prisma.session.create({
    data: { session_date: futureDate, start_time: '13:00', end_time: '15:00', max_capacity: 20 }
  });

  for (const ref of createdRefs) {
    await prisma.reservation.create({
      data: {
        booking_ref: ref,
        user_id: user.id,
        session_id: session.id,
        pax: 1,
        assigned_seats: ['A1'],
        status: 'confirmed',
        checkout_details: { version: 2, persons: [{ person_no: 1, mode: 'hourly' }] }
      }
    });
    await prisma.bookingPerson.create({
      data: { booking_ref: ref, person_no: 1, seat_code: 'A1', status: 'active' }
    });
  }

  // 1. Person 1 pays 500 cash, refunds 100 -> related_payment_id points to charge; void charge -> 409; void refund then charge -> 200
  const colA = await collectPayment(refA, { person_nos: [1], method: 'cash', print: false }, staffUser, deviceInfo);
  const chargeA = colA.payments[0];
  assert.equal(chargeA.amount, 500);

  const refARes = await refundPayment(refA, { person_no: 1, amount: 100, method: 'cash', reason: '退100', print: false }, staffUser, deviceInfo);
  const refundA = refARes.payment;
  assert.equal(refundA.related_payment_id, chargeA.id);

  await assert.rejects(
    () => voidPayment(chargeA.id, '試圖先作廢收款', staffUser, deviceInfo),
    (err) => err.status === 409
  );

  await voidPayment(refundA.id, '先作廢退款', staffUser, deviceInfo);
  const voidChargeAfter = await voidPayment(chargeA.id, '再作廢收款', staffUser, deviceInfo);
  assert.equal(voidChargeAfter.bill.summary.amount_received, 0);

  // 2. Legacy refund without related_payment_id still blocks voiding charge (409)
  const colB = await collectPayment(refB, { person_nos: [1], method: 'cash', print: false }, staffUser, deviceInfo);
  const chargeB = colB.payments[0];
  await prisma.payment.create({
    data: {
      payment_no: `R36-LEG-${runId}`,
      batch_no: `B-LEG-${runId}`,
      booking_ref: refB,
      kind: 'refund',
      status: 'valid',
      method: 'cash',
      amount: 100,
      related_payment_id: null,
      person_nos: [1],
      breakdown_json: { refund_amount: 100, reason: 'legacy' },
      reason: 'legacy',
      staff_name: staffUser.name,
      device_label: 'R36測試台'
    }
  });
  await assert.rejects(
    () => voidPayment(chargeB.id, '舊式退款仍應擋作廢', staffUser, deviceInfo),
    (err) => err.status === 409
  );

  // 3. Cross-booking same batch_no collision guard: voiding refB's other or refC does not void refB
  const colC = await collectPayment(refC, { person_nos: [1], method: 'cash', print: false }, staffUser, deviceInfo);
  const sharedBatch = `B-COLLIDE-${runId}`;
  await prisma.payment.update({ where: { id: chargeB.id }, data: { batch_no: sharedBatch } });
  await prisma.payment.update({ where: { id: colC.payments[0].id }, data: { batch_no: sharedBatch } });

  await voidPayment(colC.payments[0].id, '作廢C不影響B', staffUser, deviceInfo);
  const chargeBAfter = await prisma.payment.findUnique({ where: { id: chargeB.id } });
  assert.equal(chargeBAfter.status, 'valid');
});
