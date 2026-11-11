import test from 'node:test';
import assert from 'node:assert/strict';
import prisma from '../src/prismaClient.js';
import { collectPayment, refundPayment, getBookingBill } from '../src/services/billing/billService.js';
import { dateOnly, toTaipeiDateString } from '../../shared/time.js';

test('Round 21 Item 1: Per-person refund limits and legacy splitAmount fallback', async (t) => {
  const runId = Math.random().toString(36).slice(2, 8);
  const bookingRef1 = `R21-${runId}-01`;
  const bookingRef2 = `R21-${runId}-02`;
  const bookingRef3 = `R21-${runId}-03`;
  const todayStr = toTaipeiDateString(new Date());
  const sessionDate = dateOnly(todayStr);

  // Ensure default pricing and payment methods
  await prisma.globalSetting.upsert({
    where: { id: 1 },
    update: {
      weekday_hourly_price: 200,
      weekday_unlimited_price: 750,
      payment_methods_json: [
        { key: 'cash', label: '現金', enabled: true },
        { key: 'linepay', label: 'LINE Pay', enabled: true },
        { key: 'transfer', label: '銀行轉帳', enabled: true },
        { key: 'card', label: '信用卡', enabled: true }
      ]
    },
    create: {
      id: 1,
      cash_float_amount: 2000,
      weekday_hourly_price: 200,
      weekday_unlimited_price: 750,
      payment_methods_json: [
        { key: 'cash', label: '現金', enabled: true },
        { key: 'linepay', label: 'LINE Pay', enabled: true },
        { key: 'transfer', label: '銀行轉帳', enabled: true },
        { key: 'card', label: '信用卡', enabled: true }
      ]
    }
  });

  const testUser = await prisma.user.upsert({
    where: { line_user_id: `user_r21_${runId}` },
    update: {},
    create: {
      line_user_id: `user_r21_${runId}`,
      name: '退款限制測試客',
      phone: '0912345678'
    }
  });

  const session = await prisma.session.upsert({
    where: {
      session_date_start_time: {
        session_date: sessionDate,
        start_time: '14:00'
      }
    },
    update: {
      end_time: '15:00',
      max_capacity: 20
    },
    create: {
      session_date: sessionDate,
      start_time: '14:00',
      end_time: '15:00',
      max_capacity: 20
    }
  });

  const cleanup = async () => {
    await prisma.printJob.deleteMany({
      where: { booking_ref: { in: [bookingRef1, bookingRef2, bookingRef3] } }
    }).catch(() => {});
    await prisma.payment.deleteMany({
      where: { booking_ref: { in: [bookingRef1, bookingRef2, bookingRef3] } }
    }).catch(() => {});
    await prisma.bookingPerson.deleteMany({
      where: { booking_ref: { in: [bookingRef1, bookingRef2, bookingRef3] } }
    }).catch(() => {});
    await prisma.reservation.deleteMany({
      where: { booking_ref: { in: [bookingRef1, bookingRef2, bookingRef3] } }
    }).catch(() => {});
    await prisma.userPass.deleteMany({
      where: { user_id: testUser.id }
    }).catch(() => {});
    await prisma.passPlan.deleteMany({
      where: { code: `PLAN-R21-${runId}` }
    }).catch(() => {});
    await prisma.user.deleteMany({
      where: { id: testUser.id }
    }).catch(() => {});
  };
  t.after(cleanup);

  const staffUser = { name: '店長測試員', id: 1 };
  const deviceInfo = { device_id: 'DEV-TEST', device_label: '櫃檯測試' };

  // -------------------------------------------------------------
  // Scenario 1: Two persons pay NT$400 together (NT$200 each)
  // -------------------------------------------------------------
  await prisma.reservation.create({
    data: {
      booking_ref: bookingRef1,
      user_id: testUser.id,
      session_id: session.id,
      pax: 2,
      status: 'confirmed',
      assigned_seats: ['A1-1', 'A1-2'],
      checkout_details: {
        version: 2,
        rev: 1,
        persons: [
          { person_no: 1, mode: 'hourly', hours_override: 1 },
          { person_no: 2, mode: 'hourly', hours_override: 1 }
        ]
      }
    }
  });

  await prisma.bookingPerson.createMany({
    data: [
      { booking_ref: bookingRef1, person_no: 1, seat_code: 'A1-1', status: 'active' },
      { booking_ref: bookingRef1, person_no: 2, seat_code: 'A1-2', status: 'active' }
    ]
  });

  // Collect NT$400 for Person 1 & 2 together via linepay
  const collectRes = await collectPayment(
    bookingRef1,
    {
      person_nos: [1, 2],
      method: 'linepay',
      print: false
    },
    staffUser,
    deviceInfo
  );
  assert.equal(collectRes.bill.summary.amount_received, 400);

  // Verify GET /billing/:ref returns max_refundable = 200 for each person
  const billAfterPay = await getBookingBill(bookingRef1);
  const p1Bill = billAfterPay.bill.persons.find(p => p.person_no === 1);
  const p2Bill = billAfterPay.bill.persons.find(p => p.person_no === 2);
  assert.equal(p1Bill.max_refundable, 200);
  assert.equal(p2Bill.max_refundable, 200);

  // Person 1 refunds NT$100 -> succeeds
  const refund1 = await refundPayment(
    bookingRef1,
    {
      person_no: 1,
      amount: 100,
      method: 'linepay',
      reason: '退回部分時數'
    },
    staffUser,
    deviceInfo
  );
  assert.ok(refund1.payment);
  assert.equal(refund1.payment.amount, 100);

  // Check max_refundable after 1st refund
  const billAfterRef1 = await getBookingBill(bookingRef1);
  const p1AfterRef1 = billAfterRef1.bill.persons.find(p => p.person_no === 1);
  const p2AfterRef1 = billAfterRef1.bill.persons.find(p => p.person_no === 2);
  assert.equal(p1AfterRef1.max_refundable, 100, 'Person 1 max_refundable should be 200 - 100 = 100');
  assert.equal(p2AfterRef1.max_refundable, 200, 'Person 2 max_refundable remains 200');

  // Person 1 tries to refund NT$150 -> rejected with 400 (最多可退 NT$100)
  let rejected = false;
  try {
    await refundPayment(
      bookingRef1,
      {
        person_no: 1,
        amount: 150,
        method: 'linepay',
        reason: '超過上限退款'
      },
      staffUser,
      deviceInfo
    );
  } catch (err) {
    rejected = true;
    assert.equal(err.status, 400);
    assert.ok(err.message.includes('最多可退 NT$100'), `Message should mention 最多可退 NT$100: ${err.message}`);
  }
  assert.ok(rejected, 'Refunding 150 when max_refundable is 100 must throw 400');

  // Person 1 refunds remaining NT$100 -> succeeds
  await refundPayment(
    bookingRef1,
    {
      person_no: 1,
      amount: 100,
      method: 'linepay',
      reason: '結清第 1 位剩餘退款'
    },
    staffUser,
    deviceInfo
  );

  // Person 2 refunds NT$200 -> succeeds
  await refundPayment(
    bookingRef1,
    {
      person_no: 2,
      amount: 200,
      method: 'linepay',
      reason: '第 2 位全額退款'
    },
    staffUser,
    deviceInfo
  );

  // Verify order-level total refunds = 400
  const finalPayments1 = await prisma.payment.findMany({
    where: { booking_ref: bookingRef1, status: 'valid', kind: 'refund' }
  });
  const totalRefundAmt1 = finalPayments1.reduce((s, p) => s + p.amount, 0);
  assert.equal(totalRefundAmt1, 400, 'Total order refund must be exactly 400, not exceeding order paid amount');

  // -------------------------------------------------------------
  // Scenario 2: Legacy payment without breakdown_json.persons
  // -------------------------------------------------------------
  await prisma.reservation.create({
    data: {
      booking_ref: bookingRef2,
      user_id: testUser.id,
      session_id: session.id,
      pax: 2,
      status: 'confirmed',
      assigned_seats: ['B1-1', 'B1-2'],
      checkout_details: {
        version: 2,
        rev: 1,
        persons: [
          { person_no: 1, mode: 'hourly', hours_override: 1 },
          { person_no: 2, mode: 'hourly', hours_override: 1 }
        ]
      }
    }
  });

  await prisma.bookingPerson.createMany({
    data: [
      { booking_ref: bookingRef2, person_no: 1, seat_code: 'B1-1', status: 'active' },
      { booking_ref: bookingRef2, person_no: 2, seat_code: 'B1-2', status: 'active' }
    ]
  });

  // Create legacy payment with NO breakdown_json.persons
  await prisma.payment.create({
    data: {
      payment_no: `R-LEGACY-${runId}-01`,
      batch_no: `B-LEGACY-${runId}`,
      booking_ref: bookingRef2,
      kind: 'charge',
      status: 'valid',
      method: 'linepay',
      amount: 400,
      person_nos: [1, 2],
      breakdown_json: {}, // legacy: no persons breakdown
      staff_name: '店長',
      device_label: '櫃檯'
    }
  });

  // getBookingBill for legacy booking: both persons should get 200 max_refundable
  const legBill = await getBookingBill(bookingRef2);
  const legP1 = legBill.bill.persons.find(p => p.person_no === 1);
  const legP2 = legBill.bill.persons.find(p => p.person_no === 2);
  assert.equal(legP1.max_refundable, 200, 'Legacy person 1 should get 200 via splitAmount');
  assert.equal(legP2.max_refundable, 200, 'Legacy person 2 should get 200 via splitAmount');

  // Refund Person 1 for 200
  await refundPayment(
    bookingRef2,
    {
      person_no: 1,
      amount: 200,
      method: 'linepay',
      reason: '舊資料退款'
    },
    staffUser,
    deviceInfo
  );

  // Person 1 tries to refund 1 more dollar -> rejected
  let legRejected = false;
  try {
    await refundPayment(
      bookingRef2,
      {
        person_no: 1,
        amount: 1,
        method: 'linepay',
        reason: '超退'
      },
      staffUser,
      deviceInfo
    );
  } catch (err) {
    legRejected = true;
    assert.equal(err.status, 400);
    assert.ok(err.message.includes('最多可退 NT$0'));
  }
  assert.ok(legRejected, 'Person 1 cannot refund beyond splitAmount legacy share');

  // -------------------------------------------------------------
  // Scenario 3: Mixed tender (Pass + Cash) shared checkout
  // Person 1 pays with pass (NT$200), Person 2 pays with cash (NT$200)
  // -------------------------------------------------------------
  const passPlan = await prisma.passPlan.create({
    data: {
      code: `PLAN-R21-${runId}`,
      name: 'R21 時數券',
      pass_type: 'TIME_PASS',
      total_quota: 10,
      checkout_effect: 'entry_hours',
      checkout_scope: 'entry'
    }
  });

  const userPass = await prisma.userPass.create({
    data: {
      pass_code: `PASS-R21-${runId}`,
      user_id: testUser.id,
      plan_id: passPlan.id,
      plan_name_snapshot: passPlan.name,
      pass_type: 'TIME_PASS',
      total_quota: 10,
      remaining_quota: 10,
      status: 'ACTIVE'
    }
  });

  await prisma.reservation.create({
    data: {
      booking_ref: bookingRef3,
      user_id: testUser.id,
      session_id: session.id,
      pax: 2,
      status: 'confirmed',
      assigned_seats: ['C1-1', 'C1-2'],
      checkout_details: {
        version: 2,
        rev: 1,
        persons: [
          { person_no: 1, mode: 'hourly', hours_override: 1 },
          { person_no: 2, mode: 'hourly', hours_override: 1 }
        ]
      }
    }
  });

  await prisma.bookingPerson.createMany({
    data: [
      { booking_ref: bookingRef3, person_no: 1, seat_code: 'C1-1', status: 'active' },
      { booking_ref: bookingRef3, person_no: 2, seat_code: 'C1-2', status: 'active' }
    ]
  });

  const mixedCollect = await collectPayment(
    bookingRef3,
    {
      person_nos: [1, 2],
      method: 'cash',
      cash_received: 200,
      pass_tenders: [
        {
          user_pass_id: userPass.id,
          person_no: 1,
          units: 1
        }
      ],
      print: false
    },
    staffUser,
    deviceInfo
  );

  assert.equal(mixedCollect.bill.summary.amount_received, 200);
  assert.equal(mixedCollect.bill.summary.pass_value_total, 200);

  const billAfterMixed = await getBookingBill(bookingRef3);
  const p1Mixed = billAfterMixed.bill.persons.find(p => p.person_no === 1);
  const p2Mixed = billAfterMixed.bill.persons.find(p => p.person_no === 2);
  assert.equal(p1Mixed.paid_amount, 200, 'Person 1 paid 200 via pass');
  assert.equal(p2Mixed.paid_amount, 200, 'Person 2 paid 200 via cash');
  assert.equal(p1Mixed.max_refundable, 200);
  assert.equal(p2Mixed.max_refundable, 200);

  // Person 2 refunds 200 cash -> succeeds
  await refundPayment(
    bookingRef3,
    {
      person_no: 2,
      amount: 200,
      method: 'cash',
      reason: '退第 2 位現金'
    },
    staffUser,
    deviceInfo
  );

  const billAfterP2Ref = await getBookingBill(bookingRef3);
  const p2AfterRef = billAfterP2Ref.bill.persons.find(p => p.person_no === 2);
  assert.equal(p2AfterRef.max_refundable, 0, 'Person 2 has 0 max_refundable after full refund');

  // Person 2 tries to refund 50 -> rejected
  let p2ExcessRejected = false;
  try {
    await refundPayment(
      bookingRef3,
      {
        person_no: 2,
        amount: 50,
        method: 'cash',
        reason: '超退'
      },
      staffUser,
      deviceInfo
    );
  } catch (err) {
    p2ExcessRejected = true;
    assert.equal(err.status, 400);
  }
  assert.ok(p2ExcessRejected, 'Person 2 cannot refund more than paid');
});
