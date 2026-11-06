import test from 'node:test';
import assert from 'node:assert/strict';
import prisma from '../src/prismaClient.js';
import {
  collectPayment,
  refundPayment,
  voidPayment,
  waivePayment,
  getBookingBill
} from '../src/services/billing/billService.js';
import { dateOnly } from '../../shared/time.js';

test('Step 4 Billing Tests (Sections 3.5 - 3.8)', async (t) => {
  // GlobalSetting ensure
  await prisma.globalSetting.upsert({
    where: { id: 1 },
    update: {
      weekday_hourly_price: 150,
      weekday_unlimited_price: 750,
      weekend_hourly_price: 180,
      weekend_unlimited_price: 1100,
      billing_grace_minutes: 10,
      billing_block_minutes: 30,
      auto_print_receipt: true,
      auto_print_summary: true
    },
    create: {
      id: 1,
      weekday_hourly_price: 150,
      weekday_unlimited_price: 750,
      billing_grace_minutes: 10,
      billing_block_minutes: 30,
      auto_print_receipt: true,
      auto_print_summary: true
    }
  });

  const userA = await prisma.user.upsert({
    where: { line_user_id: 'test_step4_user_a' },
    update: { name: '測試客A' },
    create: { line_user_id: 'test_step4_user_a', name: '測試客A', phone: '0900000001' }
  });

  const userB = await prisma.user.upsert({
    where: { line_user_id: 'test_step4_user_b' },
    update: { name: '測試客B' },
    create: { line_user_id: 'test_step4_user_b', name: '測試客B', phone: '0900000002' }
  });

  const sessionDate = dateOnly('2026-11-04');
  const session = await prisma.session.upsert({
    where: {
      session_date_start_time: {
        session_date: sessionDate,
        start_time: '14:00'
      }
    },
    update: {
      end_time: '18:00',
      max_capacity: 30
    },
    create: {
      session_date: sessionDate,
      start_time: '14:00',
      end_time: '18:00',
      max_capacity: 30
    }
  });

  const staffUser = { name: '門市人員小陳', id: 99 };
  const deviceInfo = { device_id: 'dev-pos-1', device_label: '櫃檯平板' };

  await t.test('3.5 Prevent duplicate person payment & removed/nonexistent person checks', async () => {
    const bookingRef = `BK-DUP-${Date.now()}-1`;

    await prisma.printJob.deleteMany({ where: { booking_ref: bookingRef } });
    await prisma.payment.deleteMany({ where: { booking_ref: bookingRef } });
    await prisma.bookingPerson.deleteMany({ where: { booking_ref: bookingRef } });
    await prisma.reservation.deleteMany({ where: { booking_ref: bookingRef } });

    await prisma.reservation.create({
      data: {
        booking_ref: bookingRef,
        user_id: userA.id,
        session_id: session.id,
        pax: 2,
        assigned_seats: ['1-1', '1-2'],
        status: 'confirmed'
      }
    });

    await prisma.bookingPerson.createMany({
      data: [
        { booking_ref: bookingRef, person_no: 1, seat_code: '1-1', status: 'active' },
        { booking_ref: bookingRef, person_no: 2, seat_code: '1-2', status: 'removed' }
      ]
    });

    // Pay person 1
    const payRes1 = await collectPayment(bookingRef, {
      person_nos: [1],
      method: 'cash',
      print: false
    }, staffUser, deviceInfo);

    assert.equal(payRes1.payments.length, 1);
    assert.equal(payRes1.payments[0].person_nos[0], 1);

    // Try paying person 1 again -> 409
    await assert.rejects(
      async () => {
        await collectPayment(bookingRef, {
          person_nos: [1],
          method: 'cash',
          print: false
        }, staffUser, deviceInfo);
      },
      (err) => err.status === 409 && err.message.includes('第 1 位已經付過款')
    );

    // Try paying removed person 2 -> 409
    await assert.rejects(
      async () => {
        await collectPayment(bookingRef, {
          person_nos: [2],
          method: 'cash',
          print: false
        }, staffUser, deviceInfo);
      },
      (err) => err.status === 409 && err.message.includes('第 2 位已移除')
    );

    // Try paying non-existent person 9 -> 409
    await assert.rejects(
      async () => {
        await collectPayment(bookingRef, {
          person_nos: [9],
          method: 'cash',
          print: false
        }, staffUser, deviceInfo);
      },
      (err) => err.status === 409 && err.message.includes('第 9 位不存在')
    );
  });

  await t.test('3.6 Refresh billing cache and promo code used_count sync', async () => {
    const bookingRef = `BK-CACHE-${Date.now()}-2`;
    const promoCodeStr = `PROMO_STEP4_${Date.now()}`;

    await prisma.printJob.deleteMany({ where: { booking_ref: bookingRef } });
    await prisma.payment.deleteMany({ where: { booking_ref: bookingRef } });
    await prisma.bookingPerson.deleteMany({ where: { booking_ref: bookingRef } });
    await prisma.reservation.deleteMany({ where: { booking_ref: bookingRef } });
    await prisma.promoCode.deleteMany({ where: { code: promoCodeStr } });

    await prisma.promoCode.create({
      data: {
        code: promoCodeStr,
        name: '測試優惠券',
        discount_type: 'fixed_order',
        discount_value: 50,
        used_count: 0
      }
    });

    const resv = await prisma.reservation.create({
      data: {
        booking_ref: bookingRef,
        user_id: userA.id,
        session_id: session.id,
        pax: 2,
        assigned_seats: ['1-1', '1-2'],
        status: 'confirmed',
        checkout_details: {
          version: 2,
          order_promos: [
            { key: 'p1', code: promoCodeStr, name: '測試優惠券', discount_type: 'fixed_order', discount_value: 50, split: { mode: 'proportional' } }
          ],
          persons: [
            { person_no: 1, addons: [] },
            { person_no: 2, addons: [] }
          ]
        }
      }
    });

    await prisma.bookingPerson.createMany({
      data: [
        { booking_ref: bookingRef, person_no: 1, seat_code: '1-1', status: 'active' },
        { booking_ref: bookingRef, person_no: 2, seat_code: '1-2', status: 'active' }
      ]
    });

    // 1. Collect payment for person 1
    const p1Result = await collectPayment(bookingRef, {
      person_nos: [1],
      method: 'cash',
      print: false
    }, staffUser, deviceInfo);

    // Check reservation cache after partial payment
    const cached1 = await prisma.reservation.findFirst({ where: { booking_ref: bookingRef } });
    assert.ok(cached1.amount_due > 0, 'amount_due should not be 0');
    assert.ok(cached1.amount_received > 0, 'amount_received should not be 0');
    assert.equal(cached1.paid_persons, 1, 'paid_persons is 1');
    assert.equal(cached1.is_paid, false, 'is_paid is false while partial');
    assert.equal(cached1.paid_at, null, 'paid_at is null while partial');
    assert.equal(cached1.payment_method, 'cash');
    assert.equal(cached1.promo_code, promoCodeStr);

    // Promo code used_count incremented on first payment
    const promoAfter1 = await prisma.promoCode.findUnique({ where: { code: promoCodeStr } });
    assert.equal(promoAfter1.used_count, 1, 'promo used_count incremented to 1');

    // 2. Collect payment for person 2 with card -> order fully paid
    const p2Result = await collectPayment(bookingRef, {
      person_nos: [2],
      method: 'card',
      print: false
    }, staffUser, deviceInfo);

    const cached2 = await prisma.reservation.findFirst({ where: { booking_ref: bookingRef } });
    assert.equal(cached2.is_paid, true, 'is_paid is true');
    assert.ok(cached2.paid_at != null, 'paid_at is set');
    assert.equal(cached2.paid_persons, 2, 'paid_persons is 2');
    assert.equal(cached2.payment_method, 'mixed', 'multiple methods produces mixed');
    assert.equal(cached2.checkout_regular_hours, 8, '8 regular hours total');

    // Promo count should still be 1 (not double incremented on second payment)
    const promoAfter2 = await prisma.promoCode.findUnique({ where: { code: promoCodeStr } });
    assert.equal(promoAfter2.used_count, 1, 'promo used_count remains 1');

    // 3. Void person 2's payment -> order reopened
    const p2Pay = p2Result.payments[0];
    await voidPayment(p2Pay.id, '測試作廢重新開啟', staffUser, deviceInfo);

    const cached3 = await prisma.reservation.findFirst({ where: { booking_ref: bookingRef } });
    assert.equal(cached3.is_paid, false, 'is_paid is false after reopen');
    assert.equal(cached3.paid_at, null, 'paid_at cleared on reopen');

    const reopenedLog = await prisma.accountingEvent.findFirst({
      where: { booking_ref: bookingRef, event_type: 'bill_reopened' }
    });
    assert.ok(reopenedLog, 'bill_reopened audit event created');

    // 4. Void person 1's payment -> all payments voided
    const p1Pay = p1Result.payments[0];
    await voidPayment(p1Pay.id, '全部作廢', staffUser, deviceInfo);

    const promoAfterFullVoid = await prisma.promoCode.findUnique({ where: { code: promoCodeStr } });
    assert.equal(promoAfterFullVoid.used_count, 0, 'promo used_count decremented back to 0 on full void');
  });

  await t.test('3.7 Validate pass tender ownership, restrictions, and restoration', async () => {
    const bookingRef = `BK-PASS-${Date.now()}-3`;

    await prisma.printJob.deleteMany({ where: { booking_ref: bookingRef } });
    await prisma.payment.deleteMany({ where: { booking_ref: bookingRef } });
    await prisma.bookingPerson.deleteMany({ where: { booking_ref: bookingRef } });
    await prisma.reservation.deleteMany({ where: { booking_ref: bookingRef } });

    const passPlan = await prisma.passPlan.upsert({
      where: { code: 'TEST_TIME_PLAN' },
      update: {},
      create: {
        code: 'TEST_TIME_PLAN',
        name: '測試時數方案',
        pass_type: 'TIME_PASS',
        total_quota: 10,
        checkout_effect: 'entry_hours'
      }
    });

    await prisma.reservation.create({
      data: {
        booking_ref: bookingRef,
        user_id: userA.id,
        session_id: session.id,
        pax: 1,
        assigned_seats: ['1-1'],
        status: 'confirmed'
      }
    });

    await prisma.bookingPerson.create({
      data: {
        booking_ref: bookingRef,
        person_no: 1,
        seat_code: '1-1',
        status: 'active'
      }
    });

    // Pass belonging to User B
    const passUserB = await prisma.userPass.create({
      data: {
        user_id: userB.id,
        plan_id: passPlan.id,
        pass_code: 'PASS-USER-B',
        plan_name_snapshot: '測試時數券B',
        pass_type: 'TIME_PASS',
        total_quota: 10,
        remaining_quota: 10,
        payment_status: 'active',
        status: 'ACTIVE'
      }
    });

    // Valid Pass for User A
    const passUserA = await prisma.userPass.create({
      data: {
        user_id: userA.id,
        plan_id: passPlan.id,
        pass_code: 'PASS-USER-A',
        plan_name_snapshot: '測試時數券A',
        pass_type: 'TIME_PASS',
        total_quota: 10,
        remaining_quota: 10,
        payment_status: 'active',
        status: 'ACTIVE'
      }
    });

    // 1. Try using User B's pass for User A's reservation -> 422
    await assert.rejects(
      async () => {
        await collectPayment(bookingRef, {
          person_nos: [1],
          pass_tenders: [{ user_pass_id: passUserB.id, units: 2, person_no: 1 }],
          method: 'pass',
          print: false
        }, staffUser, deviceInfo);
      },
      (err) => err.status === 422 && err.message.includes('此卡券不屬於此預約會員')
    );

    // 2. Try duplicate pass tenders in same payment -> 422
    await assert.rejects(
      async () => {
        await collectPayment(bookingRef, {
          person_nos: [1],
          pass_tenders: [
            { user_pass_id: passUserA.id, units: 1, person_no: 1 },
            { user_pass_id: passUserA.id, units: 1, person_no: 1 }
          ],
          method: 'pass',
          print: false
        }, staffUser, deviceInfo);
      },
      (err) => err.status === 422 && err.message.includes('同一次收款不能重複使用同一張卡券')
    );

    // 3. Valid payment using passUserA
    const payResult = await collectPayment(bookingRef, {
      person_nos: [1],
      pass_tenders: [{ user_pass_id: passUserA.id, units: 4, person_no: 1 }],
      method: 'cash',
      print: false
    }, staffUser, deviceInfo);

    const updatedPass1 = await prisma.userPass.findUnique({ where: { id: passUserA.id } });
    assert.equal(updatedPass1.remaining_quota, 6, 'remaining quota deducted by 4');

    // 4. Void payment restores pass (pass_restored)
    const passPay = payResult.payments.find(p => p.method === 'pass');
    await voidPayment(passPay.id, '作廢退回卡券', staffUser, deviceInfo);

    const updatedPass2 = await prisma.userPass.findUnique({ where: { id: passUserA.id } });
    assert.equal(updatedPass2.remaining_quota, 10, 'remaining quota restored to 10');

    const passRestoredLog = await prisma.accountingEvent.findFirst({
      where: { booking_ref: bookingRef, event_type: 'pass_restored' }
    });
    assert.ok(passRestoredLog, 'pass_restored audit event exists');

    // Clean up
    await prisma.userPass.deleteMany({ where: { id: { in: [passUserA.id, passUserB.id] } } });
  });

  await t.test('3.8 Automatic print jobs created in transaction', async () => {
    const bookingRef = `BK-PRINT-${Date.now()}-4`;

    await prisma.printJob.deleteMany({ where: { booking_ref: bookingRef } });
    await prisma.payment.deleteMany({ where: { booking_ref: bookingRef } });
    await prisma.bookingPerson.deleteMany({ where: { booking_ref: bookingRef } });
    await prisma.reservation.deleteMany({ where: { booking_ref: bookingRef } });

    await prisma.reservation.create({
      data: {
        booking_ref: bookingRef,
        user_id: userA.id,
        session_id: session.id,
        pax: 2,
        assigned_seats: ['1-1', '1-2'],
        status: 'confirmed'
      }
    });

    await prisma.bookingPerson.createMany({
      data: [
        { booking_ref: bookingRef, person_no: 1, seat_code: '1-1', status: 'active' },
        { booking_ref: bookingRef, person_no: 2, seat_code: '1-2', status: 'active' }
      ]
    });

    // 1. Pay person 1 with print: true
    const pay1 = await collectPayment(bookingRef, {
      person_nos: [1],
      method: 'cash',
      print: true
    }, staffUser, deviceInfo);

    assert.ok(pay1.print_jobs?.length > 0, 'print_jobs returned by backend');
    assert.equal(pay1.print_jobs[0].type, 'receipt');

    const dbJob1 = await prisma.printJob.findFirst({
      where: { booking_ref: bookingRef, payment_id: pay1.payments[0].id }
    });
    assert.ok(dbJob1, 'print job persisted in database');

    // 2. Pay person 2 with print: true (completes settlement of 2 separate payments)
    const pay2 = await collectPayment(bookingRef, {
      person_nos: [2],
      method: 'cash',
      print: true
    }, staffUser, deviceInfo);

    // Should contain receipt AND summary job!
    const receiptJob = pay2.print_jobs.find(j => j.type === 'receipt');
    const summaryJob = pay2.print_jobs.find(j => j.type === 'summary');

    assert.ok(receiptJob, 'receipt job generated for person 2');
    assert.ok(summaryJob, 'summary job generated on multi-payment settlement');
  });

  t.after(async () => {
    await prisma.printJob.deleteMany({ where: { booking_ref: { startsWith: 'BK-' } } });
    await prisma.payment.deleteMany({ where: { booking_ref: { startsWith: 'BK-' } } });
    await prisma.bookingPerson.deleteMany({ where: { booking_ref: { startsWith: 'BK-' } } });
    await prisma.reservation.deleteMany({ where: { booking_ref: { startsWith: 'BK-' } } });
  });
});
