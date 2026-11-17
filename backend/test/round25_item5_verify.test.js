import test from 'node:test';
import assert from 'node:assert/strict';
import prisma from '../src/prismaClient.js';
import { dateOnly, toTaipeiDateString } from '../../shared/time.js';
import { createReservation, getAdminNavBadges } from '../src/controllers/reservationController.js';
import {
  patchRemittanceLast5Handler,
  getAdminPrepaysHandler,
  verifyAdminPrepayHandler,
  mismatchAdminPrepayHandler,
  remindAdminPrepayHandler
} from '../src/controllers/prepayController.js';
import { ensureDefaultEquipmentConfigs } from '../src/controllers/equipmentController.js';
import { voidPayment, getBookingBill } from '../src/services/billing/billService.js';
import { releaseExpiredPrepays } from '../src/services/selfService/prepayService.js';
import { getClosingPreview } from '../src/controllers/accountingController.js';

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
    user: { id: 1, name: 'R25管理員', role: 'admin' },
    headers: { 'x-device-label': 'POS測試機' },
    body,
    params,
    query
  };
}

test('Round 25 Item 5: Admin prepay reconciliation, verify settlement, mismatch, remind, void restore, and closing preview', async () => {
  const futureDateStr = '2099-08-20';
  const testDate = dateOnly(futureDateStr);
  const normalDateStr = '2099-08-21';
  const normalDate = dateOnly(normalDateStr);

  let savedKiosk = null;
  let savedSmallEq = null;
  let savedTransferMethod = null;
  let savedGlobal = null;
  let testUser = null;
  const createdRefs = [];
  const createdPoolIds = [];
  const createdPlanIds = [];
  let createdMethodCode = null;
  let createdLayoutId = null;

  try {
    await ensureDefaultEquipmentConfigs();
    savedKiosk = await prisma.kioskSetting.findUnique({ where: { id: 1 } });
    savedSmallEq = await prisma.equipmentConfig.findUnique({ where: { id: 'pegboard_s' } });
    savedGlobal = await prisma.globalSetting.findUnique({ where: { id: 1 } });

    const oldSess = await prisma.session.findMany({ where: { session_date: testDate }, select: { id: true } });
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
    await prisma.dailySetting.deleteMany({ where: { date: testDate } });

    const existingLayouts = await prisma.seatLayout.findMany({
      where: { status: 'published' },
      include: { tables: { include: { seats: true } } }
    });
    if (existingLayouts.length === 0) {
      const layout = await prisma.seatLayout.create({
        data: {
          name: 'R25 Verify Test Layout',
          status: 'published',
          capacity: 16,
          tables: {
            create: {
              name: 'T1',
              x: 0,
              y: 0,
              seats: {
                create: Array.from({ length: 16 }, (_, i) => ({
                  code: `B${i + 1}`,
                  seat_no: i + 1,
                  x: i * 40,
                  y: 0,
                  is_active: true
                }))
              }
            }
          }
        }
      });
      createdLayoutId = layout.id;
    }

    await prisma.kioskSetting.upsert({
      where: { id: 1 },
      update: { prepay_deadline_hour: 12, early_minutes: 30, max_unpaid_self_bookings: 10 },
      create: { id: 1, prepay_deadline_hour: 12, early_minutes: 30, after_close_minutes: 60, max_unpaid_self_bookings: 10 }
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

    savedTransferMethod = await prisma.paymentMethodConfig.findUnique({ where: { code: 'transfer' } }).catch(() => null);
    await prisma.paymentMethodConfig.upsert({
      where: { code: 'r25_item5_bank' },
      update: { is_enabled: true, method_type: 'STATIC_BANK' },
      create: {
        code: 'r25_item5_bank',
        name: '台新匯款',
        method_type: 'STATIC_BANK',
        is_enabled: true,
        sort_order: 2,
        bank_accounts_json: [{ bank_name: '台新銀行', bank_code: '812', account: '2001002003' }]
      }
    });
    createdMethodCode = 'r25_item5_bank';

    for (const accNum of ['82290005001', '82290005002']) {
      await prisma.oneTimeAccountPool.deleteMany({ where: { account_number: accNum } });
      const pool = await prisma.oneTimeAccountPool.create({
        data: {
          payment_method_code: 'ctbc_pool',
          account_number: accNum,
          status: 'AVAILABLE'
        }
      });
      createdPoolIds.push(pool.id);
    }

    testUser = await prisma.user.upsert({
      where: { line_user_id: 'r25_item5_user' },
      update: { name: 'R25對帳會員', phone: '0911000501', is_blacklisted: false },
      create: { line_user_id: 'r25_item5_user', name: 'R25對帳會員', phone: '0911000501' }
    });

    await prisma.equipmentConfig.update({
      where: { id: 'pegboard_s' },
      data: {
        visibility_status: 'ACTIVE',
        hourly_rate: 100,
        daily_cap: 300,
        total_stock: 5,
        self_enabled: true,
        self_hourly_rate: 80,
        self_daily_cap: 240,
        self_stock: 3
      }
    });

    const plan = await prisma.passPlan.upsert({
      where: { code: 'r25_item5_punch' },
      update: { pass_type: 'PUNCH_CARD', checkout_effect: 'entry_full', is_active: true },
      create: {
        code: 'r25_item5_punch',
        name: 'R25對帳九宮格卡',
        pass_type: 'PUNCH_CARD',
        price: 3000,
        total_quota: 5,
        checkout_effect: 'entry_full',
        day_restriction: 'ALL',
        is_active: true
      }
    });
    createdPlanIds.push(plan.id);

    const userPass = await prisma.userPass.create({
      data: {
        pass_code: `PASS-R25-5-${Date.now()}`,
        user_id: testUser.id,
        plan_id: plan.id,
        plan_name_snapshot: plan.name,
        pass_type: 'PUNCH_CARD',
        remaining_quota: 4,
        total_quota: 5,
        status: 'ACTIVE',
        payment_status: 'active',
        day_restriction: 'ALL'
      }
    });

    await prisma.dailySetting.create({
      data: {
        date: testDate,
        allow_unlimited: true,
        hourly_price: 150,
        unlimited_price: 750,
        is_self_service: true,
        self_allow_hourly: false,
        self_allow_equipment: true,
        iron_mode: 'today'
      }
    });

    const sess = await Promise.all([
      prisma.session.create({ data: { session_date: testDate, start_time: '13:00', end_time: '14:00', max_capacity: 20 } }),
      prisma.session.create({ data: { session_date: testDate, start_time: '14:00', end_time: '15:00', max_capacity: 20 } })
    ]);
    const sessionIds = sess.map((s) => s.id);

    // ---------------------------------------------------------
    // Booking A: All transfer (2 pax, ctbc_pool, amount_due = 1500)
    // ---------------------------------------------------------
    let refA = null;
    {
      const r = createMockRes();
      await createReservation(makeCustomerReq(testUser, {
        body: {
          session_ids: sessionIds,
          pax: 2,
          isUnlimited: true,
          self_service_ack: true,
          prepay: {
            pass_uses: [],
            transfer: { payment_method_code: 'ctbc_pool' },
            expected_transfer_amount: 1500
          }
        }
      }), r);
      assert.equal(r.statusCode, 201);
      refA = r.body.reservation.booking_ref;
      createdRefs.push(refA);

      // Report last5
      const rep = createMockRes();
      await patchRemittanceLast5Handler(makeCustomerReq(testUser, {
        params: { booking_ref: refA },
        body: { remittance_last5: '11223' }
      }), rep);
      assert.equal(rep.statusCode, 200);

      // Check admin nav badges reflects reported prepay
      const badgeRes = createMockRes();
      await getAdminNavBadges(makeAdminReq(), badgeRes);
      assert.ok(badgeRes.body.self_prepay_pending_verify >= 1);

      // Check admin prepays list
      const listRes = createMockRes();
      await getAdminPrepaysHandler(makeAdminReq({ query: { status: 'reported_pending_verify', date: futureDateStr } }), listRes);
      assert.equal(listRes.statusCode, 200);
      assert.ok(listRes.body.items.some((x) => x.booking_ref === refA));

      // Verify A
      const vRes = createMockRes();
      await verifyAdminPrepayHandler(makeAdminReq({ params: { booking_ref: refA } }), vRes);
      assert.equal(vRes.statusCode, 200, JSON.stringify(vRes.body));
      assert.equal(vRes.body.alreadyVerified, false);

      const paymentsA = await prisma.payment.findMany({ where: { booking_ref: refA, status: 'valid' } });
      assert.equal(paymentsA.length, 1);
      assert.equal(paymentsA[0].method, 'transfer');
      assert.equal(paymentsA[0].amount, 1500);

      const eventsA = await prisma.accountingEvent.findMany({ where: { booking_ref: refA, category: 'payment' } });
      assert.ok(eventsA.length >= 1);

      const dbResA = await prisma.reservation.findFirst({ where: { booking_ref: refA } });
      assert.equal(dbResA.billing_status, 'paid');

      const prepayA = await prisma.bookingPrepay.findUnique({ where: { booking_ref: refA } });
      const poolA = await prisma.oneTimeAccountPool.findFirst({ where: { account_number: prepayA.assigned_pool_account } });
      assert.equal(poolA.status, 'USED');

      // Case 5: Double verify idempotency -> no duplicate payment!
      const vRes2 = createMockRes();
      await verifyAdminPrepayHandler(makeAdminReq({ params: { booking_ref: refA } }), vRes2);
      assert.equal(vRes2.statusCode, 200);
      assert.equal(vRes2.body.alreadyVerified, true);
      const paymentsA2 = await prisma.payment.findMany({ where: { booking_ref: refA, status: 'valid' } });
      assert.equal(paymentsA2.length, 1);
    }

    // ---------------------------------------------------------
    // Booking B: 3 pax, 1 pass -> verify settles 1 pass + 1 transfer without double-deducting
    // ---------------------------------------------------------
    let refB = null;
    {
      const r = createMockRes();
      await createReservation(makeCustomerReq(testUser, {
        body: {
          session_ids: sessionIds,
          pax: 3,
          isUnlimited: true,
          self_service_ack: true,
          prepay: {
            pass_uses: [{ user_pass_id: userPass.id, persons: 1 }],
            transfer: { payment_method_code: 'r25_item5_bank' },
            expected_transfer_amount: 1500
          }
        }
      }), r);
      assert.equal(r.statusCode, 201);
      refB = r.body.reservation.booking_ref;
      createdRefs.push(refB);

      const quotaBeforeVerify = (await prisma.userPass.findUnique({ where: { id: userPass.id } })).remaining_quota;
      assert.equal(quotaBeforeVerify, 3);

      const vRes = createMockRes();
      await verifyAdminPrepayHandler(makeAdminReq({ params: { booking_ref: refB } }), vRes);
      assert.equal(vRes.statusCode, 200);

      // Quota MUST still be 3 (not deducted again!)
      const quotaAfterVerify = (await prisma.userPass.findUnique({ where: { id: userPass.id } })).remaining_quota;
      assert.equal(quotaAfterVerify, 3);

      const paymentsB = await prisma.payment.findMany({ where: { booking_ref: refB, status: 'valid' } });
      assert.equal(paymentsB.length, 2);
      const passPayB = paymentsB.find((p) => p.method === 'pass');
      const transPayB = paymentsB.find((p) => p.method === 'transfer');
      assert.ok(passPayB && transPayB);
      assert.equal(transPayB.amount, 1500);

      const dbResB = await prisma.reservation.findFirst({ where: { booking_ref: refB } });
      assert.equal(dbResB.billing_status, 'paid');
      assert.equal(dbResB.paid_persons, 3);
    }

    // ---------------------------------------------------------
    // Booking C: 1 pax using pass + 1 smart board (2h * 80 = 160)
    // Verify -> same person 1 has BOTH pass (750) & transfer (160) -> voidPayment restores +1 quota!
    // Also test even when POS 'transfer' payment method is disabled
    // ---------------------------------------------------------
    let refC = null;
    {
      if (savedTransferMethod) {
        await prisma.paymentMethodConfig.update({ where: { code: 'transfer' }, data: { is_enabled: false } });
      }

      const r = createMockRes();
      await createReservation(makeCustomerReq(testUser, {
        body: {
          session_ids: sessionIds,
          pax: 1,
          isUnlimited: true,
          equipments: [{ equipment_id: 'pegboard_s', quantity: 1, rental_hours: 2, start_time: '13:00' }],
          self_service_ack: true,
          prepay: {
            pass_uses: [{ user_pass_id: userPass.id, persons: 1 }],
            transfer: { payment_method_code: 'r25_item5_bank' },
            expected_transfer_amount: 160
          }
        }
      }), r);
      assert.equal(r.statusCode, 201);
      refC = r.body.reservation.booking_ref;
      createdRefs.push(refC);

      const vRes = createMockRes();
      await verifyAdminPrepayHandler(makeAdminReq({ params: { booking_ref: refC } }), vRes);
      assert.equal(vRes.statusCode, 200);

      const paymentsC = await prisma.payment.findMany({ where: { booking_ref: refC, status: 'valid' } });
      assert.equal(paymentsC.length, 2);
      const passPayC = paymentsC.find((p) => p.method === 'pass');
      const transPayC = paymentsC.find((p) => p.method === 'transfer');
      assert.ok(passPayC && transPayC);
      assert.deepEqual(passPayC.person_nos, [1]);
      assert.deepEqual(transPayC.person_nos, [1]);
      assert.equal(transPayC.amount, 160);

      const dbResC = await prisma.reservation.findFirst({ where: { booking_ref: refC } });
      assert.equal(dbResC.billing_status, 'paid');

      // Void passPayC -> restores pass quota from 2 back to 3!
      await voidPayment(passPayC.id, '測試作廢退次', { id: 1, name: 'R25管理員' }, { device_label: '測試' });
      const quotaAfterVoid = (await prisma.userPass.findUnique({ where: { id: userPass.id } })).remaining_quota;
      assert.equal(quotaAfterVoid, 3);
    }

    // ---------------------------------------------------------
    // Booking D: Mismatch skips expiry cron + remind 429 cooldown
    // ---------------------------------------------------------
    let refD = null;
    {
      const r = createMockRes();
      await createReservation(makeCustomerReq(testUser, {
        body: {
          session_ids: sessionIds,
          pax: 1,
          isUnlimited: true,
          self_service_ack: true,
          prepay: {
            pass_uses: [],
            transfer: { payment_method_code: 'r25_item5_bank' },
            expected_transfer_amount: 750
          }
        }
      }), r);
      assert.equal(r.statusCode, 201);
      refD = r.body.reservation.booking_ref;
      createdRefs.push(refD);

      // Remind once -> 200; remind again immediately -> 429
      const rem1 = createMockRes();
      await remindAdminPrepayHandler(makeAdminReq({ params: { booking_ref: refD } }), rem1);
      assert.equal(rem1.statusCode, 200);
      const rem2 = createMockRes();
      await remindAdminPrepayHandler(makeAdminReq({ params: { booking_ref: refD } }), rem2);
      assert.equal(rem2.statusCode, 429);

      // Mark mismatch
      const misRes = createMockRes();
      await mismatchAdminPrepayHandler(makeAdminReq({
        params: { booking_ref: refD },
        body: { note: '只收到 NT$ 500' }
      }), misRes);
      assert.equal(misRes.statusCode, 200);
      assert.equal(misRes.body.prepay.status, 'mismatch');

      // Force deadline to past & run releaseExpiredPrepays -> MUST NOT cancel mismatch!
      await prisma.bookingPrepay.update({
        where: { booking_ref: refD },
        data: { deadline_at: new Date(Date.now() - 3600 * 1000) }
      });
      await releaseExpiredPrepays(new Date());
      const pDAfter = await prisma.bookingPrepay.findUnique({ where: { booking_ref: refD } });
      assert.equal(pDAfter.status, 'mismatch');
    }

    // ---------------------------------------------------------
    // Closing preview: transfer included (1500 + 1500 = 3000 from A & B; C was voided), pass excluded
    // ---------------------------------------------------------
    {
      const todayStr = toTaipeiDateString(new Date());
      const closeRes = createMockRes();
      await getClosingPreview(makeAdminReq({ query: { date: todayStr } }), closeRes);
      assert.equal(closeRes.statusCode, 200);
      assert.ok((closeRes.body.by_method?.transfer?.amount || 0) >= 3000);
      assert.equal(closeRes.body.by_method?.pass, undefined);
    }

    // ---------------------------------------------------------
    // Round 25b Item 1: pricing_snapshot pins self-service entry price at creation,
    // while non-self-service booking bill still follows updated GlobalSetting prices.
    // ---------------------------------------------------------
    {
      // Create self-service booking E at 750/person before rate hike
      const rSelf = createMockRes();
      await createReservation(makeCustomerReq(testUser, {
        body: {
          session_ids: sessionIds,
          pax: 1,
          isUnlimited: true,
          self_service_ack: true,
          prepay: {
            pass_uses: [],
            transfer: { payment_method_code: 'r25_item5_bank' },
            expected_transfer_amount: 750
          }
        }
      }), rSelf);
      assert.equal(rSelf.statusCode, 201);
      const refSelf = rSelf.body.reservation.booking_ref;
      createdRefs.push(refSelf);

      const prepayE = await prisma.bookingPrepay.findUnique({ where: { booking_ref: refSelf } });
      assert.ok(prepayE.pricing_snapshot, 'BookingPrepay must store pricing_snapshot');
      assert.equal(prepayE.pricing_snapshot.unlimited, 750);

      // Prepare normal (non-self-service) day booking F before rate hike
      await prisma.dailySetting.deleteMany({ where: { date: normalDate } });
      await prisma.session.deleteMany({ where: { session_date: normalDate } });
      const normalSess = await Promise.all([
        prisma.session.create({ data: { session_date: normalDate, start_time: '13:00', end_time: '14:00', max_capacity: 20 } }),
        prisma.session.create({ data: { session_date: normalDate, start_time: '14:00', end_time: '15:00', max_capacity: 20 } })
      ]);
      const rNormal = createMockRes();
      await createReservation(makeCustomerReq(testUser, {
        body: {
          session_ids: normalSess.map((s) => s.id),
          pax: 1,
          isUnlimited: true
        }
      }), rNormal);
      assert.equal(rNormal.statusCode, 201);
      const refNormal = rNormal.body.reservation.booking_ref;
      createdRefs.push(refNormal);

      // Admin raises BOTH DailySetting.unlimited_price AND GlobalSetting weekday/weekend prices
      await prisma.dailySetting.update({
        where: { date: testDate },
        data: { unlimited_price: 880, hourly_price: 180 }
      });
      await prisma.globalSetting.update({
        where: { id: 1 },
        data: {
          weekday_hourly_price: 220,
          weekday_unlimited_price: 920,
          weekend_hourly_price: 260,
          weekend_unlimited_price: 990
        }
      });

      // Verify self-service booking E -> must still use pinned 750 -> 200 OK & paid
      const vSelf = createMockRes();
      await verifyAdminPrepayHandler(makeAdminReq({ params: { booking_ref: refSelf } }), vSelf);
      assert.equal(vSelf.statusCode, 200, 'Expected verify 200 despite price change when pricing_snapshot is pinned');
      assert.equal(vSelf.body.prepay.amount_due, 750);
      const dbSelfRes = await prisma.reservation.findFirst({ where: { booking_ref: refSelf } });
      assert.equal(dbSelfRes.billing_status, 'paid');

      // Normal-day booking F still follows the updated GlobalSetting price
      const normalBill = await getBookingBill(refNormal);
      const isNormalWknd = normalBill.pricing.day_type === 'weekend';
      assert.equal(normalBill.pricing.unlimited, isNormalWknd ? 990 : 920);
      assert.equal(normalBill.pricing.hourly, isNormalWknd ? 260 : 220);
      assert.equal(normalBill.bill.summary.amount_due, 2 * (isNormalWknd ? 260 : 220));
    }
  } finally {
    if (savedTransferMethod) {
      await prisma.paymentMethodConfig.update({
        where: { code: 'transfer' },
        data: { is_enabled: savedTransferMethod.is_enabled }
      }).catch(() => {});
    }
    if (createdRefs.length) {
      await prisma.payment.deleteMany({ where: { booking_ref: { in: createdRefs } } });
      await prisma.bookingPrepay.deleteMany({ where: { booking_ref: { in: createdRefs } } });
      await prisma.bookingPerson.deleteMany({ where: { booking_ref: { in: createdRefs } } });
      await prisma.bookingEquipment.deleteMany({ where: { booking_ref: { in: createdRefs } } });
      await prisma.reservation.deleteMany({ where: { booking_ref: { in: createdRefs } } });
    }
    await prisma.session.deleteMany({ where: { session_date: testDate } });
    await prisma.dailySetting.deleteMany({ where: { date: testDate } });
    await prisma.session.deleteMany({ where: { session_date: normalDate } });
    await prisma.dailySetting.deleteMany({ where: { date: normalDate } });
    if (savedGlobal) {
      await prisma.globalSetting.update({
        where: { id: 1 },
        data: {
          weekday_hourly_price: savedGlobal.weekday_hourly_price,
          weekday_unlimited_price: savedGlobal.weekday_unlimited_price,
          weekend_hourly_price: savedGlobal.weekend_hourly_price,
          weekend_unlimited_price: savedGlobal.weekend_unlimited_price
        }
      }).catch(() => {});
    }
    if (createdPlanIds.length) {
      await prisma.userPass.deleteMany({ where: { plan_id: { in: createdPlanIds } } });
      await prisma.passPlan.deleteMany({ where: { id: { in: createdPlanIds } } });
    }
    if (createdPoolIds.length) {
      await prisma.oneTimeAccountPool.deleteMany({ where: { id: { in: createdPoolIds } } });
    }
    if (createdMethodCode) {
      await prisma.paymentMethodConfig.deleteMany({ where: { code: createdMethodCode } });
    }
    if (createdLayoutId) {
      await prisma.seatLayout.deleteMany({ where: { id: createdLayoutId } });
    }
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
    if (savedSmallEq) {
      await prisma.equipmentConfig.update({
        where: { id: 'pegboard_s' },
        data: {
          visibility_status: savedSmallEq.visibility_status,
          hourly_rate: savedSmallEq.hourly_rate,
          daily_cap: savedSmallEq.daily_cap,
          total_stock: savedSmallEq.total_stock,
          self_enabled: savedSmallEq.self_enabled,
          self_hourly_rate: savedSmallEq.self_hourly_rate,
          self_daily_cap: savedSmallEq.self_daily_cap,
          self_stock: savedSmallEq.self_stock
        }
      });
    }
  }
});
