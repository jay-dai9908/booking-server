import test from 'node:test';
import assert from 'node:assert/strict';
import prisma from '../src/prismaClient.js';
import { dateOnly } from '../../shared/time.js';
import { ensureTestPublishedLayout, cleanupTestPublishedLayout } from './helpers/seedTestLayout.js';
import { ensureDefaultEquipmentConfigs } from '../src/controllers/equipmentController.js';
import { createReservation, cancelReservation } from '../src/controllers/reservationController.js';
import { verifyAdminPrepayHandler } from '../src/controllers/prepayController.js';
import { releaseExpiredPrepays } from '../src/services/selfService/prepayService.js';

function createMockRes() {
  return {
    statusCode: 200,
    body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; }
  };
}

function makeCustomerReq(user, { body = {}, params = {}, query = {} } = {}) {
  return { user: { id: user.id, name: user.name, role: 'customer' }, body, params, query };
}

function makeAdminReq({ body = {}, params = {}, query = {} } = {}) {
  return {
    user: { id: 1, name: 'R25b併發測試管理員', role: 'admin' },
    headers: { 'x-device-label': 'POS測試機' },
    body,
    params,
    query
  };
}

test('Round 25b Item 3: Prepay verify vs expiry, verify vs cancel, and concurrent create max_unpaid serialization', async () => {
  const dateStr1 = '2099-09-10';
  const dateStr2 = '2099-09-11';
  const date1 = dateOnly(dateStr1);
  const date2 = dateOnly(dateStr2);
  const testDates = [date1, date2];

  let savedKiosk = null;
  let createdLayoutId = null;
  let createdMethodCode = null;
  const createdPoolIds = [];
  const createdRefs = [];

  try {
    await ensureDefaultEquipmentConfigs();
    savedKiosk = await prisma.kioskSetting.findUnique({ where: { id: 1 } });

    // Clean any leftovers on test dates
    const oldSess = await prisma.session.findMany({ where: { session_date: { in: testDates } }, select: { id: true } });
    const oldSessIds = oldSess.map((s) => s.id);
    if (oldSessIds.length) {
      const oldRes = await prisma.reservation.findMany({ where: { session_id: { in: oldSessIds } }, select: { booking_ref: true } });
      const oldRefs = [...new Set(oldRes.map((r) => r.booking_ref))];
      if (oldRefs.length) {
        await prisma.payment.deleteMany({ where: { booking_ref: { in: oldRefs } } });
        await prisma.bookingPrepay.deleteMany({ where: { booking_ref: { in: oldRefs } } });
        await prisma.bookingPerson.deleteMany({ where: { booking_ref: { in: oldRefs } } });
        await prisma.bookingEquipment.deleteMany({ where: { booking_ref: { in: oldRefs } } });
        await prisma.reservation.deleteMany({ where: { booking_ref: { in: oldRefs } } });
      }
      await prisma.session.deleteMany({ where: { id: { in: oldSessIds } } });
    }
    await prisma.dailySetting.deleteMany({ where: { date: { in: testDates } } });

    createdLayoutId = await ensureTestPublishedLayout(prisma, {
      name: 'R25b Concurrency Layout',
      effectiveFrom: '2020-01-01',
      effectiveDate: dateStr1,
      codePrefix: 'C',
      seatCount: 16
    });

    await prisma.globalSetting.upsert({
      where: { id: 1 },
      update: {},
      create: {
        id: 1,
        weekday_hourly_price: 150,
        weekday_unlimited_price: 750,
        weekend_hourly_price: 200,
        weekend_unlimited_price: 900,
        line_auto_notify_booking: false,
        line_auto_notify_cancel: false
      }
    });

    await prisma.paymentMethodConfig.upsert({
      where: { code: 'ctbc_pool' },
      update: { is_enabled: true, method_type: 'POOL_ACCOUNT' },
      create: {
        code: 'ctbc_pool',
        name: '中信專屬轉帳帳號',
        method_type: 'POOL_ACCOUNT',
        is_enabled: true,
        sort_order: 1
      }
    });

    createdMethodCode = 'r25b_conc_bank';
    await prisma.paymentMethodConfig.upsert({
      where: { code: createdMethodCode },
      update: { is_enabled: true, method_type: 'STATIC_BANK' },
      create: {
        code: createdMethodCode,
        name: 'R25b測試銀行匯款',
        method_type: 'STATIC_BANK',
        is_enabled: true,
        sort_order: 2,
        bank_accounts_json: [{ bank_name: '台新銀行', bank_code: '812', account: '2001002099' }]
      }
    });

    for (const accNum of ['82290095001', '82290095002']) {
      await prisma.oneTimeAccountPool.deleteMany({ where: { account_number: accNum } });
      const pool = await prisma.oneTimeAccountPool.create({
        data: { payment_method_code: 'ctbc_pool', account_number: accNum, status: 'AVAILABLE' }
      });
      createdPoolIds.push(pool.id);
    }

    const testUser = await prisma.user.upsert({
      where: { line_user_id: 'r25b_conc_user' },
      update: { name: 'R25b併發測試會員', phone: '0911000951', is_blacklisted: false },
      create: { line_user_id: 'r25b_conc_user', name: 'R25b併發測試會員', phone: '0911000951' }
    });

    // Ensure clean prepay state for testUser
    await prisma.bookingPrepay.deleteMany({ where: { user_id: testUser.id } });

    await prisma.dailySetting.createMany({
      data: [
        {
          date: date1,
          allow_unlimited: true,
          hourly_price: 150,
          unlimited_price: 750,
          is_self_service: true,
          self_allow_hourly: false,
          self_allow_equipment: true,
          iron_mode: 'today'
        },
        {
          date: date2,
          allow_unlimited: true,
          hourly_price: 150,
          unlimited_price: 750,
          is_self_service: true,
          self_allow_hourly: false,
          self_allow_equipment: true,
          iron_mode: 'today'
        }
      ]
    });

    const sess1 = await Promise.all([
      prisma.session.create({ data: { session_date: date1, start_time: '13:00', end_time: '14:00', max_capacity: 20 } }),
      prisma.session.create({ data: { session_date: date1, start_time: '14:00', end_time: '15:00', max_capacity: 20 } })
    ]);
    const sess2 = await Promise.all([
      prisma.session.create({ data: { session_date: date2, start_time: '13:00', end_time: '14:00', max_capacity: 20 } }),
      prisma.session.create({ data: { session_date: date2, start_time: '14:00', end_time: '15:00', max_capacity: 20 } })
    ]);
    const sessionIds1 = sess1.map((s) => s.id);
    const sessionIds2 = sess2.map((s) => s.id);

    await prisma.kioskSetting.upsert({
      where: { id: 1 },
      update: { prepay_deadline_hour: 12, early_minutes: 30, max_unpaid_self_bookings: 20 },
      create: { id: 1, prepay_deadline_hour: 12, early_minutes: 30, after_close_minutes: 60, max_unpaid_self_bookings: 20 }
    });

    // ---------------------------------------------------------
    // 1. Concurrent verifyAdminPrepayHandler vs releaseExpiredPrepays (10 rounds)
    // ---------------------------------------------------------
    for (let i = 0; i < 10; i++) {
      const rCreate = createMockRes();
      await createReservation(makeCustomerReq(testUser, {
        body: {
          session_ids: sessionIds1,
          pax: 1,
          isUnlimited: true,
          self_service_ack: true,
          prepay: {
            pass_uses: [],
            transfer: { payment_method_code: 'ctbc_pool' },
            expected_transfer_amount: 750
          }
        }
      }), rCreate);
      assert.equal(rCreate.statusCode, 201, JSON.stringify(rCreate.body));
      const ref = rCreate.body.reservation.booking_ref;
      createdRefs.push(ref);

      const pastDeadline = new Date(Date.now() - 3600 * 1000);
      await prisma.bookingPrepay.update({
        where: { booking_ref: ref },
        data: { deadline_at: pastDeadline }
      });

      const vRes = createMockRes();
      const tasks = i % 2 === 0
        ? [verifyAdminPrepayHandler(makeAdminReq({ params: { booking_ref: ref } }), vRes), releaseExpiredPrepays(new Date())]
        : [releaseExpiredPrepays(new Date()), verifyAdminPrepayHandler(makeAdminReq({ params: { booking_ref: ref } }), vRes)];
      await Promise.all(tasks);

      const [dbPrepay, dbRes, validPayments] = await Promise.all([
        prisma.bookingPrepay.findUnique({ where: { booking_ref: ref } }),
        prisma.reservation.findFirst({ where: { booking_ref: ref } }),
        prisma.payment.findMany({ where: { booking_ref: ref, status: 'valid' } })
      ]);

      assert.ok(['verified', 'expired'].includes(dbPrepay.status), `Unexpected status ${dbPrepay.status}`);
      if (dbPrepay.status === 'verified') {
        assert.equal(vRes.statusCode, 200);
        assert.equal(dbRes.status, 'confirmed');
        assert.equal(dbRes.billing_status, 'paid');
        assert.equal(validPayments.length, 1);
      } else {
        assert.equal(vRes.statusCode, 409);
        assert.equal(dbRes.status, 'cancelled');
        assert.equal(validPayments.length, 0);
      }

      // Release this iteration's booking & pool account so next iteration has capacity/pool
      await prisma.payment.deleteMany({ where: { booking_ref: ref } });
      await prisma.bookingPrepay.deleteMany({ where: { booking_ref: ref } });
      await prisma.bookingPerson.deleteMany({ where: { booking_ref: ref } });
      await prisma.reservation.deleteMany({ where: { booking_ref: ref } });
      await prisma.oneTimeAccountPool.updateMany({
        where: { id: { in: createdPoolIds } },
        data: { status: 'AVAILABLE', assigned_order_ref: null, assigned_user_id: null, assigned_at: null, verified_at: null }
      });
    }

    // ---------------------------------------------------------
    // 2. Concurrent verifyAdminPrepayHandler vs customer cancelReservation (10 rounds)
    // ---------------------------------------------------------
    for (let i = 0; i < 10; i++) {
      const rCreate = createMockRes();
      await createReservation(makeCustomerReq(testUser, {
        body: {
          session_ids: sessionIds1,
          pax: 1,
          isUnlimited: true,
          self_service_ack: true,
          prepay: {
            pass_uses: [],
            transfer: { payment_method_code: createdMethodCode },
            expected_transfer_amount: 750
          }
        }
      }), rCreate);
      assert.equal(rCreate.statusCode, 201);
      const ref = rCreate.body.reservation.booking_ref;
      createdRefs.push(ref);

      const vRes = createMockRes();
      const cRes = createMockRes();
      const tasks = i % 2 === 0
        ? [
            verifyAdminPrepayHandler(makeAdminReq({ params: { booking_ref: ref } }), vRes),
            cancelReservation(makeCustomerReq(testUser, { params: { id: ref } }), cRes)
          ]
        : [
            cancelReservation(makeCustomerReq(testUser, { params: { id: ref } }), cRes),
            verifyAdminPrepayHandler(makeAdminReq({ params: { booking_ref: ref } }), vRes)
          ];
      await Promise.all(tasks);

      const [dbPrepay, dbRes, validPayments] = await Promise.all([
        prisma.bookingPrepay.findUnique({ where: { booking_ref: ref } }),
        prisma.reservation.findFirst({ where: { booking_ref: ref } }),
        prisma.payment.findMany({ where: { booking_ref: ref, status: 'valid' } })
      ]);

      // Must never have cancelled+paid or verified+cancelled
      if (dbPrepay.status === 'verified') {
        assert.equal(vRes.statusCode, 200);
        assert.equal(cRes.statusCode, 400);
        assert.equal(dbRes.status, 'confirmed');
        assert.equal(dbRes.billing_status, 'paid');
        assert.equal(validPayments.length, 1);
      } else {
        assert.equal(dbPrepay.status, 'cancelled');
        assert.equal(cRes.statusCode, 200);
        assert.equal(vRes.statusCode, 409);
        assert.equal(dbRes.status, 'cancelled');
        assert.equal(validPayments.length, 0);
      }

      await prisma.payment.deleteMany({ where: { booking_ref: ref } });
      await prisma.bookingPrepay.deleteMany({ where: { booking_ref: ref } });
      await prisma.bookingPerson.deleteMany({ where: { booking_ref: ref } });
      await prisma.reservation.deleteMany({ where: { booking_ref: ref } });
    }

    // ---------------------------------------------------------
    // 3. Concurrent createReservation against max_unpaid_self_bookings=2
    //    User already has 1 pending_payment -> fire 2 concurrent creates on date1 & date2
    //    -> 1 succeeds (201) + 1 fails 409 TOO_MANY_UNPAID -> total pending_payment = 2
    // ---------------------------------------------------------
    await prisma.kioskSetting.update({ where: { id: 1 }, data: { max_unpaid_self_bookings: 2 } });

    const rSeed = createMockRes();
    await createReservation(makeCustomerReq(testUser, {
      body: {
        session_ids: sessionIds1,
        pax: 1,
        isUnlimited: true,
        self_service_ack: true,
        prepay: {
          pass_uses: [],
          transfer: { payment_method_code: createdMethodCode },
          expected_transfer_amount: 750
        }
      }
    }), rSeed);
    assert.equal(rSeed.statusCode, 201);
    createdRefs.push(rSeed.body.reservation.booking_ref);

    const rConc1 = createMockRes();
    const rConc2 = createMockRes();
    await Promise.all([
      createReservation(makeCustomerReq(testUser, {
        body: {
          session_ids: sessionIds1,
          pax: 1,
          isUnlimited: true,
          self_service_ack: true,
          prepay: {
            pass_uses: [],
            transfer: { payment_method_code: createdMethodCode },
            expected_transfer_amount: 750
          }
        }
      }), rConc1),
      createReservation(makeCustomerReq(testUser, {
        body: {
          session_ids: sessionIds2,
          pax: 1,
          isUnlimited: true,
          self_service_ack: true,
          prepay: {
            pass_uses: [],
            transfer: { payment_method_code: createdMethodCode },
            expected_transfer_amount: 750
          }
        }
      }), rConc2)
    ]);

    const outcomes = [rConc1, rConc2].sort((a, b) => a.statusCode - b.statusCode);
    assert.equal(outcomes[0].statusCode, 201, `Expected one 201, got ${JSON.stringify(outcomes[0].body)}`);
    assert.equal(outcomes[1].statusCode, 409, `Expected one 409 TOO_MANY_UNPAID, got ${JSON.stringify(outcomes[1].body)}`);
    assert.equal(outcomes[1].body.code, 'TOO_MANY_UNPAID');
    createdRefs.push(outcomes[0].body.reservation.booking_ref);

    const unpaidAfter = await prisma.bookingPrepay.count({
      where: { user_id: testUser.id, status: 'pending_payment' }
    });
    assert.equal(unpaidAfter, 2);
  } finally {
    const remainingSess = await prisma.session.findMany({ where: { session_date: { in: testDates } }, select: { id: true } });
    const remainingSessIds = remainingSess.map((s) => s.id);
    const remainingRes = remainingSessIds.length
      ? await prisma.reservation.findMany({ where: { session_id: { in: remainingSessIds } }, select: { booking_ref: true } })
      : [];
    const allRefs = [...new Set([...createdRefs, ...remainingRes.map((r) => r.booking_ref)])];
    if (allRefs.length) {
      await prisma.payment.deleteMany({ where: { booking_ref: { in: allRefs } } });
      await prisma.bookingPrepay.deleteMany({ where: { booking_ref: { in: allRefs } } });
      await prisma.bookingPerson.deleteMany({ where: { booking_ref: { in: allRefs } } });
      await prisma.bookingEquipment.deleteMany({ where: { booking_ref: { in: allRefs } } });
      await prisma.reservation.deleteMany({ where: { booking_ref: { in: allRefs } } });
    }
    await prisma.session.deleteMany({ where: { session_date: { in: testDates } } });
    await prisma.dailySetting.deleteMany({ where: { date: { in: testDates } } });
    if (createdPoolIds.length) {
      await prisma.oneTimeAccountPool.deleteMany({ where: { id: { in: createdPoolIds } } });
    }
    if (createdMethodCode) {
      await prisma.paymentMethodConfig.deleteMany({ where: { code: createdMethodCode } });
    }
    await cleanupTestPublishedLayout(prisma, createdLayoutId);
    if (savedKiosk) {
      await prisma.kioskSetting.update({
        where: { id: 1 },
        data: {
          early_minutes: savedKiosk.early_minutes,
          after_close_minutes: savedKiosk.after_close_minutes,
          prepay_deadline_hour: savedKiosk.prepay_deadline_hour,
          max_unpaid_self_bookings: savedKiosk.max_unpaid_self_bookings
        }
      });
    }
  }
});
