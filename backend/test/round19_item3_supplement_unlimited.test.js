import test from 'node:test';
import assert from 'node:assert/strict';
import prisma from '../src/prismaClient.js';
import { collectPayment, supplementPayment } from '../src/services/billing/billService.js';
import { dateOnly } from '../../shared/time.js';

test('Round 19 Item 3: Supplement unlimited_diff uses target person entry amount & hours respects weekday/weekend rates', async (t) => {
  const runId = Math.random().toString(36).slice(2, 8);
  const weekdayDate = dateOnly('2026-11-18'); // Wednesday (weekday)
  const weekendDate = dateOnly('2026-11-22'); // Sunday (weekend)

  await prisma.globalSetting.upsert({
    where: { id: 1 },
    update: {
      weekday_hourly_price: 150,
      weekday_unlimited_price: 750,
      weekend_hourly_price: 180,
      weekend_unlimited_price: 900
    },
    create: {
      id: 1,
      weekday_hourly_price: 150,
      weekday_unlimited_price: 750,
      weekend_hourly_price: 180,
      weekend_unlimited_price: 900
    }
  });

  const testUser = await prisma.user.upsert({
    where: { line_user_id: `user_r19_supp_${runId}` },
    update: {},
    create: {
      line_user_id: `user_r19_supp_${runId}`,
      name: '補收測試員',
      phone: '0988000111'
    }
  });

  const weekdaySession = await prisma.session.upsert({
    where: {
      session_date_start_time: {
        session_date: weekdayDate,
        start_time: '13:00'
      }
    },
    update: {},
    create: {
      session_date: weekdayDate,
      start_time: '13:00',
      end_time: '17:00',
      max_capacity: 20
    }
  });

  const weekendSession = await prisma.session.upsert({
    where: {
      session_date_start_time: {
        session_date: weekendDate,
        start_time: '13:00'
      }
    },
    update: {},
    create: {
      session_date: weekendDate,
      start_time: '13:00',
      end_time: '17:00',
      max_capacity: 20
    }
  });

  const weekdayBookingRef = `R19-WD-${runId}`;
  const weekendBookingRef = `R19-WE-${runId}`;

  // Weekday reservation with 2 persons:
  // Person 1: 4 hours (4 * 150 = 600)
  // Person 2: 3 hours (3 * 150 = 450)
  const weekdayRes = await prisma.reservation.create({
    data: {
      booking_ref: weekdayBookingRef,
      user_id: testUser.id,
      session_id: weekdaySession.id,
      pax: 2,
      assigned_seats: ['1-1', '1-2'],
      status: 'confirmed',
      checkout_details: {
        version: 2,
        rev: 1,
        persons: [
          { person_no: 1, hours_override: 4 },
          { person_no: 2, hours_override: 3 }
        ]
      }
    }
  });

  await prisma.bookingPerson.createMany({
    data: [
      { booking_ref: weekdayBookingRef, person_no: 1, seat_code: '1-1', status: 'active' },
      { booking_ref: weekdayBookingRef, person_no: 2, seat_code: '1-2', status: 'active' }
    ]
  });

  // Weekend reservation with 1 person for testing weekend hours rate
  const weekendRes = await prisma.reservation.create({
    data: {
      booking_ref: weekendBookingRef,
      user_id: testUser.id,
      session_id: weekendSession.id,
      pax: 1,
      assigned_seats: ['2-1'],
      status: 'confirmed',
      checkout_details: {
        version: 2,
        rev: 1,
        persons: [
          { person_no: 1, hours_override: 2 }
        ]
      }
    }
  });

  await prisma.bookingPerson.create({
    data: { booking_ref: weekendBookingRef, person_no: 1, seat_code: '2-1', status: 'active' }
  });

  const cleanup = async () => {
    await prisma.printJob.deleteMany({ where: { booking_ref: { in: [weekdayBookingRef, weekendBookingRef] } } }).catch(() => {});
    await prisma.payment.deleteMany({ where: { booking_ref: { in: [weekdayBookingRef, weekendBookingRef] } } }).catch(() => {});
    await prisma.bookingPerson.deleteMany({ where: { booking_ref: { in: [weekdayBookingRef, weekendBookingRef] } } }).catch(() => {});
    await prisma.reservation.deleteMany({ where: { id: { in: [weekdayRes.id, weekendRes.id] } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { id: testUser.id } }).catch(() => {});
    await prisma.session.deleteMany({ where: { id: { in: [weekdaySession.id, weekendSession.id] } } }).catch(() => {});
  };

  t.after(cleanup);

  // 1. Single payment collects both Person 1 and Person 2
  // Person 1 entry = 600, Person 2 entry = 450, Total = 1050
  const collectResult = await collectPayment(
    weekdayBookingRef,
    {
      person_nos: [1, 2],
      expected_amount: 1050,
      method: 'cash',
      cash_received: 1050,
      pass_tenders: [],
      print: false
    },
    { name: '店長', id: 1 },
    { device_id: 'DEV-TEST', device_label: '櫃檯' }
  );

  assert.ok(collectResult.payments?.length > 0);
  const mainPay = collectResult.payments[0];
  const breakdownPersons = mainPay.breakdown_json?.persons || [];
  assert.equal(breakdownPersons.length, 2);
  const p1 = breakdownPersons.find(p => p.person_no === 1);
  const p2 = breakdownPersons.find(p => p.person_no === 2);
  assert.equal(p1.entry?.amount, 600, '第 1 位入場費應為 600');
  assert.equal(p2.entry?.amount, 450, '第 2 位入場費應為 450');

  // 2. Call supplementPayment for Person 2 with unlimited_diff
  // Unlimited price is 750 (weekday default).
  // Target person entry is 450.
  // The supplement amount MUST be 750 - 450 = 300 (NOT 750 - 600 = 150).
  const supplementResult = await supplementPayment(
    weekdayBookingRef,
    {
      person_no: 2,
      method: 'cash',
      items: [
        { type: 'unlimited_diff' }
      ],
      print: false
    },
    { name: '店長', id: 1 },
    { device_id: 'DEV-TEST', device_label: '櫃檯' }
  );

  assert.equal(
    supplementResult.payment.amount,
    300,
    '第 2 位已付入場 NT$450，補收不限時差額應為 NT$300 (750 - 450)，不是用第 1 位的 600 算'
  );
  assert.deepEqual(supplementResult.payment.person_nos, [2]);

  // 3. Weekday hours supplement rate check: 1 hour = 150
  const weekdayHoursResult = await supplementPayment(
    weekdayBookingRef,
    {
      person_no: 1,
      method: 'cash',
      items: [
        { type: 'hours', hours: 1 }
      ],
      print: false
    },
    { name: '店長', id: 1 },
    { device_id: 'DEV-TEST', device_label: '櫃檯' }
  );
  assert.equal(weekdayHoursResult.payment.amount, 150, '平日加時 1 小時單價應為 150');

  // 4. Weekend collect & hours supplement rate check: 1 hour = 180
  await collectPayment(
    weekendBookingRef,
    {
      person_nos: [1],
      expected_amount: 360, // 2h * 180 = 360
      method: 'cash',
      cash_received: 360,
      pass_tenders: [],
      print: false
    },
    { name: '店長', id: 1 },
    { device_id: 'DEV-TEST', device_label: '櫃檯' }
  );

  const weekendHoursResult = await supplementPayment(
    weekendBookingRef,
    {
      person_no: 1,
      method: 'cash',
      items: [
        { type: 'hours', hours: 1 }
      ],
      print: false
    },
    { name: '店長', id: 1 },
    { device_id: 'DEV-TEST', device_label: '櫃檯' }
  );
  assert.equal(weekendHoursResult.payment.amount, 180, '假日加時 1 小時單價應為 180 (依假日定價)');
});
