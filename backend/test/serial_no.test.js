import test from 'node:test';
import assert from 'node:assert/strict';
import prisma from '../src/prismaClient.js';
import {
  collectPayment,
  nextSerialNo,
  getNextDailySeq
} from '../src/services/billing/billService.js';
import { queuePrintJob } from '../src/services/print/printService.js';
import { dateOnly, toTaipeiDateString } from '../../shared/time.js';

test('Serial Number Hotfix Acceptance Tests (urgent-serial-no)', async (t) => {
  // Ensure default GlobalSetting exists
  await prisma.globalSetting.upsert({
    where: { id: 1 },
    update: {
      weekday_hourly_price: 150,
      weekday_unlimited_price: 750,
      weekend_hourly_price: 180,
      weekend_unlimited_price: 1100,
      billing_grace_minutes: 10,
      billing_block_minutes: 30,
      auto_print_receipt: false,
      auto_print_summary: false
    },
    create: {
      id: 1,
      weekday_hourly_price: 150,
      weekday_unlimited_price: 750,
      billing_grace_minutes: 10,
      billing_block_minutes: 30,
      auto_print_receipt: false,
      auto_print_summary: false
    }
  });

  const testUser = await prisma.user.upsert({
    where: { line_user_id: 'test_serial_user' },
    update: { name: '序號測試客' },
    create: { line_user_id: 'test_serial_user', name: '序號測試客', phone: '0900000009' }
  });

  const staffUser = { name: '櫃檯人員小張', id: 88 };
  const deviceInfo = { device_id: 'dev-pos-serial', device_label: '櫃檯平板' };

  // Setup test session dates
  const day1Str = '2026-11-10';
  const day2Str = '2026-11-11';
  const sessionDate1 = dateOnly(day1Str);
  const sessionDate2 = dateOnly(day2Str);

  const session1 = await prisma.session.upsert({
    where: {
      session_date_start_time: {
        session_date: sessionDate1,
        start_time: '14:00'
      }
    },
    update: { end_time: '18:00', max_capacity: 30 },
    create: {
      session_date: sessionDate1,
      start_time: '14:00',
      end_time: '18:00',
      max_capacity: 30
    }
  });

  const session2 = await prisma.session.upsert({
    where: {
      session_date_start_time: {
        session_date: sessionDate2,
        start_time: '14:00'
      }
    },
    update: { end_time: '18:00', max_capacity: 30 },
    create: {
      session_date: sessionDate2,
      start_time: '14:00',
      end_time: '18:00',
      max_capacity: 30
    }
  });

  const createdBookingRefs = [];
  const createdPaymentNos = [];
  const createdJobNos = [];

  // Helper to create test booking
  async function createTestBooking(bookingRef, session, pax = 2) {
    createdBookingRefs.push(bookingRef);
    await prisma.printJob.deleteMany({ where: { booking_ref: bookingRef } });
    await prisma.payment.deleteMany({ where: { booking_ref: bookingRef } });
    await prisma.bookingPerson.deleteMany({ where: { booking_ref: bookingRef } });
    await prisma.reservation.deleteMany({ where: { booking_ref: bookingRef } });

    await prisma.reservation.create({
      data: {
        booking_ref: bookingRef,
        user_id: testUser.id,
        session_id: session.id,
        pax,
        assigned_seats: ['A1-1', 'A1-2'],
        status: 'confirmed'
      }
    });

    await prisma.bookingPerson.createMany({
      data: [
        { booking_ref: bookingRef, person_no: 1, seat_code: 'A1-1', status: 'active' },
        { booking_ref: bookingRef, person_no: 2, seat_code: 'A1-2', status: 'active' }
      ]
    });
  }

  await t.test('1. Day 1 payments (x2) and Day 2 payments (Taipei 00:30 and 10:00): all succeed with unique numbers', async () => {
    const bookingDay1 = `BK-SER-D1-${Date.now()}`;
    const bookingDay2 = `BK-SER-D2-${Date.now()}`;

    await createTestBooking(bookingDay1, session1);
    await createTestBooking(bookingDay2, session2);

    // Day 1, Payment 1: 14:00 Taipei
    const timeDay1P1 = new Date('2026-11-10T14:00:00+08:00');
    const resDay1P1 = await collectPayment(bookingDay1, {
      person_nos: [1],
      method: 'cash',
      print: false,
      now: timeDay1P1
    }, staffUser, deviceInfo);

    assert.equal(resDay1P1.payments.length, 1);
    const payNo1 = resDay1P1.payments[0].payment_no;
    createdPaymentNos.push(payNo1);
    assert.match(payNo1, /^R-261110-\d{4}$/, `Expected R-261110-xxxx, got ${payNo1}`);

    // Day 1, Payment 2: 15:00 Taipei
    const timeDay1P2 = new Date('2026-11-10T15:00:00+08:00');
    const resDay1P2 = await collectPayment(bookingDay1, {
      person_nos: [2],
      method: 'cash',
      print: false,
      now: timeDay1P2
    }, staffUser, deviceInfo);

    assert.equal(resDay1P2.payments.length, 1);
    const payNo2 = resDay1P2.payments[0].payment_no;
    createdPaymentNos.push(payNo2);
    assert.match(payNo2, /^R-261110-\d{4}$/, `Expected R-261110-xxxx, got ${payNo2}`);
    assert.notEqual(payNo1, payNo2, 'Day 1 payment numbers must be distinct');

    // Day 2 at Taipei 00:30 (UTC 2026-11-10T16:30:00.000Z)
    // In legacy code, this reset seq to 1 and collided with R-0001, throwing P2002.
    const timeDay2Early = new Date('2026-11-11T00:30:00+08:00');
    assert.equal(toTaipeiDateString(timeDay2Early), '2026-11-11');

    const resDay2Early = await collectPayment(bookingDay2, {
      person_nos: [1],
      method: 'cash',
      print: false,
      now: timeDay2Early
    }, staffUser, deviceInfo);

    assert.equal(resDay2Early.payments.length, 1);
    const payNo3 = resDay2Early.payments[0].payment_no;
    createdPaymentNos.push(payNo3);
    assert.match(payNo3, /^R-261111-\d{4}$/, `Expected R-261111-xxxx, got ${payNo3}`);
    assert.notEqual(payNo3, payNo1, 'Day 2 payment number must not collide with Day 1');

    // Day 2 at Taipei 10:00
    const timeDay2Late = new Date('2026-11-11T10:00:00+08:00');
    assert.equal(toTaipeiDateString(timeDay2Late), '2026-11-11');

    const resDay2Late = await collectPayment(bookingDay2, {
      person_nos: [2],
      method: 'cash',
      print: false,
      now: timeDay2Late
    }, staffUser, deviceInfo);

    assert.equal(resDay2Late.payments.length, 1);
    const payNo4 = resDay2Late.payments[0].payment_no;
    createdPaymentNos.push(payNo4);
    assert.match(payNo4, /^R-261111-\d{4}$/, `Expected R-261111-xxxx, got ${payNo4}`);
    assert.notEqual(payNo4, payNo2, 'Day 2 payment 2 must not collide with Day 1');
    assert.notEqual(payNo4, payNo3, 'Day 2 payments must be distinct');

    // Verify all 4 payments are distinct
    const uniquePayNos = new Set([payNo1, payNo2, payNo3, payNo4]);
    assert.equal(uniquePayNos.size, 4, 'All 4 payments across Day 1 and Day 2 must have distinct serial numbers');
  });

  await t.test('2. Day 1 and Day 2 print jobs do not collide', async () => {
    // Day 1 job
    const jobDay1 = await queuePrintJob({
      type: 'test',
      user: staffUser,
      device: deviceInfo,
      now: new Date('2026-11-10T14:00:00+08:00')
    });
    createdJobNos.push(jobDay1.job_no);
    assert.match(jobDay1.job_no, /^P-261110-\d{4}$/, `Expected P-261110-xxxx, got ${jobDay1.job_no}`);

    // Day 2 job at 00:30 Taipei
    const jobDay2Early = await queuePrintJob({
      type: 'test',
      user: staffUser,
      device: deviceInfo,
      now: new Date('2026-11-11T00:30:00+08:00')
    });
    createdJobNos.push(jobDay2Early.job_no);
    assert.match(jobDay2Early.job_no, /^P-261111-\d{4}$/, `Expected P-261111-xxxx, got ${jobDay2Early.job_no}`);
    assert.notEqual(jobDay2Early.job_no, jobDay1.job_no, 'Day 2 print job must not collide with Day 1');

    // Day 2 job at 10:00 Taipei
    const jobDay2Late = await queuePrintJob({
      type: 'test',
      user: staffUser,
      device: deviceInfo,
      now: new Date('2026-11-11T10:00:00+08:00')
    });
    createdJobNos.push(jobDay2Late.job_no);
    assert.match(jobDay2Late.job_no, /^P-261111-\d{4}$/, `Expected P-261111-xxxx, got ${jobDay2Late.job_no}`);
    assert.notEqual(jobDay2Late.job_no, jobDay2Early.job_no, 'Day 2 print jobs must be distinct');
  });

  await t.test('3. Concurrent payments: two simultaneous requests receive distinct numbers without P2002 error', async () => {
    const bookingConcA = `BK-CONC-A-${Date.now()}`;
    const bookingConcB = `BK-CONC-B-${Date.now()}`;

    await createTestBooking(bookingConcA, session1, 1);
    await createTestBooking(bookingConcB, session1, 1);

    const concurrentNow = new Date('2026-11-10T16:00:00+08:00');

    // Run two payments simultaneously
    const [resA, resB] = await Promise.all([
      collectPayment(bookingConcA, {
        person_nos: [1],
        method: 'cash',
        print: false,
        now: concurrentNow
      }, staffUser, deviceInfo),
      collectPayment(bookingConcB, {
        person_nos: [1],
        method: 'cash',
        print: false,
        now: concurrentNow
      }, staffUser, deviceInfo)
    ]);

    const payNoA = resA.payments[0].payment_no;
    const payNoB = resB.payments[0].payment_no;
    createdPaymentNos.push(payNoA, payNoB);

    assert.ok(payNoA.startsWith('R-261110-'));
    assert.ok(payNoB.startsWith('R-261110-'));
    assert.notEqual(payNoA, payNoB, 'Concurrent payments must receive distinct payment numbers');
  });

  await t.test('4. Centralized nextSerialNo helper verifies format and date consistency', async () => {
    await prisma.$transaction(async (tx) => {
      // Payment serial
      const customDate = new Date('2026-12-25T15:30:00+08:00');
      const sPay = await nextSerialNo(tx, 'payment', customDate);
      assert.match(sPay, /^R-261225-\d{4}$/);

      // Print job serial
      const sJob = await nextSerialNo(tx, 'job', customDate);
      assert.match(sJob, /^P-261225-\d{4}$/);

      // Cross-midnight date: 2026-12-26 00:15 Taipei
      const crossMidnight = new Date('2026-12-25T16:15:00.000Z'); // 00:15 in UTC+8
      const sNextDay = await nextSerialNo(tx, 'payment', crossMidnight);
      assert.match(sNextDay, /^R-261226-\d{4}$/);
    });
  });

  await t.test('5. Search by full serial number or trailing 4 digits', async () => {
    const targetPayNo = createdPaymentNos[0];
    assert.ok(targetPayNo, 'A created payment number must exist');

    // 1. Search by full payment_no
    const fullMatch = await prisma.payment.findMany({
      where: { payment_no: { contains: targetPayNo, mode: 'insensitive' } }
    });
    assert.ok(fullMatch.length >= 1);
    assert.ok(fullMatch.some(p => p.payment_no === targetPayNo));

    // 2. Search by trailing 4 digits
    const seqDigits = targetPayNo.slice(-4);
    const seqMatch = await prisma.payment.findMany({
      where: { payment_no: { contains: seqDigits, mode: 'insensitive' } }
    });
    assert.ok(seqMatch.length >= 1);
    assert.ok(seqMatch.some(p => p.payment_no === targetPayNo));
  });

  // Cleanup created test records
  for (const ref of createdBookingRefs) {
    await prisma.printJob.deleteMany({ where: { booking_ref: ref } });
    await prisma.payment.deleteMany({ where: { booking_ref: ref } });
    await prisma.bookingPerson.deleteMany({ where: { booking_ref: ref } });
    await prisma.reservation.deleteMany({ where: { booking_ref: ref } });
  }
  for (const jNo of createdJobNos) {
    await prisma.printJob.deleteMany({ where: { job_no: jNo } });
  }
  for (const pNo of createdPaymentNos) {
    await prisma.payment.deleteMany({ where: { payment_no: pNo } });
  }
  // Clean test dailyCounters
  await prisma.dailyCounter.deleteMany({
    where: {
      date: { in: [sessionDate1, sessionDate2, dateOnly('2026-12-25'), dateOnly('2026-12-26')] }
    }
  });
});
