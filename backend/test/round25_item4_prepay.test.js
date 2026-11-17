import test from 'node:test';
import assert from 'node:assert/strict';
import prisma from '../src/prismaClient.js';
import { dateOnly } from '../../shared/time.js';
import { ensureTestPublishedLayout, cleanupTestPublishedLayout } from './helpers/seedTestLayout.js';
import {
  createReservation,
  cancelReservation,
  getMyReservations
} from '../src/controllers/reservationController.js';
import {
  getPrepayOptionsHandler,
  postPrepayQuoteHandler,
  patchRemittanceLast5Handler
} from '../src/controllers/prepayController.js';
import { modifyBookingEquipment, ensureDefaultEquipmentConfigs } from '../src/controllers/equipmentController.js';
import { releaseExpiredPrepays } from '../src/services/selfService/prepayService.js';

function createMockRes() {
  return {
    statusCode: 200,
    body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; }
  };
}

function makeReq(user, { body = {}, params = {}, query = {} } = {}) {
  return {
    user: { id: user.id, name: user.name, role: user.role || 'customer' },
    body,
    params,
    query
  };
}

test('Round 25 Item 4: Self-service reservation quote, create, settle, cancel, and expiry', async () => {
  const futureDateStr = '2099-07-15';
  const pastDateStr = '2020-01-15';
  const normalDateStr = '2099-07-16';
  const testDates = [dateOnly(futureDateStr), dateOnly(pastDateStr), dateOnly(normalDateStr)];

  let savedKiosk = null;
  let savedSmallEq = null;
  let testUser = null;
  let otherUser = null;
  const createdRefs = [];
  const createdPoolIds = [];
  const createdPromoIds = [];
  const createdPlanIds = [];
  const createdPassIds = [];
  let createdMethodCode = null;
  let createdLayoutId = null;

  try {
    await ensureDefaultEquipmentConfigs();
    savedKiosk = await prisma.kioskSetting.findUnique({ where: { id: 1 } });
    savedSmallEq = await prisma.equipmentConfig.findUnique({ where: { id: 'pegboard_s' } });

    // Ensure clean state for our isolated test dates & promo codes
    await prisma.bookingEquipment.deleteMany({
      where: {
        reservation: { session: { session_date: { in: testDates } } }
      }
    }).catch(() => {});

    const oldSess = await prisma.session.findMany({
      where: { session_date: { in: testDates } },
      select: { id: true }
    });
    const oldSessIds = oldSess.map((s) => s.id);
    if (oldSessIds.length) {
      const oldRes = await prisma.reservation.findMany({
        where: { session_id: { in: oldSessIds } },
        select: { booking_ref: true }
      });
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

    // Ensure SeatLayout with seats exists so allocateSeats succeeds cleanly
    createdLayoutId = await ensureTestPublishedLayout(prisma, {
      name: 'R25 Test Layout',
      effectiveFrom: '2020-01-01',
      effectiveDate: futureDateStr,
      codePrefix: 'A',
      seatCount: 16
    });

    // Ensure KioskSetting baseline
    await prisma.kioskSetting.upsert({
      where: { id: 1 },
      update: { prepay_deadline_hour: 12, early_minutes: 30, max_unpaid_self_bookings: 2 },
      create: { id: 1, prepay_deadline_hour: 12, early_minutes: 30, after_close_minutes: 60, max_unpaid_self_bookings: 2 }
    });

    // Seed GlobalSetting if missing
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

    // Ensure transfer methods (bank_transfer & ctbc_pool)
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
    await prisma.paymentMethodConfig.upsert({
      where: { code: 'r25_bank_transfer' },
      update: { is_enabled: true, method_type: 'STATIC_BANK' },
      create: {
        code: 'r25_bank_transfer',
        name: '一般匯款',
        method_type: 'STATIC_BANK',
        is_enabled: true,
        sort_order: 2,
        bank_accounts_json: [{ bank_name: '玉山銀行', bank_code: '808', account: '1234567890' }]
      }
    });
    createdMethodCode = 'r25_bank_transfer';

    // Seed pool accounts
    for (const accNum of ['82290001001', '82290001002', '82290001003', '82290001004']) {
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

    // Users
    testUser = await prisma.user.upsert({
      where: { line_user_id: 'r25_item4_user_1' },
      update: { name: 'R25顧客一', phone: '0911000401', is_blacklisted: false },
      create: { line_user_id: 'r25_item4_user_1', name: 'R25顧客一', phone: '0911000401' }
    });
    otherUser = await prisma.user.upsert({
      where: { line_user_id: 'r25_item4_user_2' },
      update: { name: 'R25顧客二', phone: '0911000402', is_blacklisted: false },
      create: { line_user_id: 'r25_item4_user_2', name: 'R25顧客二', phone: '0911000402' }
    });

    // Equipment config for self-service: pegboard_s open (self_rate=80, cap=240, stock=1)
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
        self_stock: 1
      }
    });

    // Pass Plan (PUNCH_CARD, entry_full) & UserPass (quota=3)
    const plan = await prisma.passPlan.upsert({
      where: { code: 'r25_punch_card' },
      update: { pass_type: 'PUNCH_CARD', checkout_effect: 'entry_full', is_active: true },
      create: {
        code: 'r25_punch_card',
        name: 'R25不限時九宮格卡',
        pass_type: 'PUNCH_CARD',
        price: 3000,
        total_quota: 5,
        checkout_effect: 'entry_full',
        day_restriction: 'ALL',
        is_active: true
      }
    });
    createdPlanIds.push(plan.id);

    const passCode = `PASS-R25-${Date.now()}`;
    const userPass = await prisma.userPass.create({
      data: {
        pass_code: passCode,
        user_id: testUser.id,
        plan_id: plan.id,
        plan_name_snapshot: plan.name,
        pass_type: 'PUNCH_CARD',
        remaining_quota: 3,
        total_quota: 5,
        status: 'ACTIVE',
        payment_status: 'active',
        day_restriction: 'ALL'
      }
    });
    createdPassIds.push(userPass.id);

    // Promo codes
    await prisma.promoCode.deleteMany({ where: { code: { in: ['R25OFF100', 'R25MIN3'] } } });
    const promo100 = await prisma.promoCode.create({
      data: {
        code: 'R25OFF100',
        name: 'R25整單折100',
        discount_type: 'fixed_order',
        discount_value: 100,
        target_scope: 'all',
        min_pax: 1,
        min_hours: 1,
        is_active: true,
        used_count: 0
      }
    });
    const promoMin3 = await prisma.promoCode.create({
      data: {
        code: 'R25MIN3',
        name: 'R25三人優惠',
        discount_type: 'fixed_order',
        discount_value: 150,
        target_scope: 'all',
        min_pax: 3,
        min_hours: 1,
        is_active: true,
        used_count: 0
      }
    });
    createdPromoIds.push(promo100.id, promoMin3.id);

    // Daily settings: futureDate = self-service (hourly=150, unlimited=750, allow_equipment=true)
    await prisma.dailySetting.create({
      data: {
        date: dateOnly(futureDateStr),
        allow_unlimited: true,
        hourly_price: 150,
        unlimited_price: 750,
        is_self_service: true,
        self_allow_hourly: false,
        self_allow_equipment: true,
        iron_mode: 'next'
      }
    });
    await prisma.dailySetting.create({
      data: {
        date: dateOnly(pastDateStr),
        allow_unlimited: true,
        hourly_price: 150,
        unlimited_price: 750,
        is_self_service: true,
        self_allow_hourly: false,
        self_allow_equipment: true,
        iron_mode: 'today'
      }
    });
    await prisma.dailySetting.create({
      data: {
        date: dateOnly(normalDateStr),
        allow_unlimited: true,
        hourly_price: 150,
        unlimited_price: 750,
        is_self_service: false
      }
    });

    // Sessions (2 hours each on each test date)
    const futureSess = await Promise.all([
      prisma.session.create({ data: { session_date: dateOnly(futureDateStr), start_time: '13:00', end_time: '14:00', max_capacity: 16 } }),
      prisma.session.create({ data: { session_date: dateOnly(futureDateStr), start_time: '14:00', end_time: '15:00', max_capacity: 16 } }),
      prisma.session.create({ data: { session_date: dateOnly(futureDateStr), start_time: '15:00', end_time: '16:00', max_capacity: 16 } })
    ]);
    const pastSess = await Promise.all([
      prisma.session.create({ data: { session_date: dateOnly(pastDateStr), start_time: '13:00', end_time: '14:00', max_capacity: 16 } }),
      prisma.session.create({ data: { session_date: dateOnly(pastDateStr), start_time: '14:00', end_time: '15:00', max_capacity: 16 } })
    ]);
    const normalSess = await Promise.all([
      prisma.session.create({ data: { session_date: dateOnly(normalDateStr), start_time: '13:00', end_time: '14:00', max_capacity: 16 } }),
      prisma.session.create({ data: { session_date: dateOnly(normalDateStr), start_time: '14:00', end_time: '15:00', max_capacity: 16 } })
    ]);

    // Case 1: Missing self_service_ack -> 400 SELF_ACK_REQUIRED, no booking written
    {
      const r = createMockRes();
      await createReservation(makeReq(testUser, {
        body: {
          session_ids: futureSess.map(s => s.id),
          pax: 2,
          isUnlimited: true,
          prepay: { pass_uses: [], transfer: { payment_method_code: 'ctbc_pool' } }
        }
      }), r);
      assert.equal(r.statusCode, 400);
      assert.equal(r.body.code, 'SELF_ACK_REQUIRED');
    }

    // Case 2: All transfer, 2 pax -> BookingPrepay pending_payment, pass_persons=0, amount_due=1500, pool ASSIGNED, 0 payments
    let allTransferRef = null;
    {
      const r = createMockRes();
      await createReservation(makeReq(testUser, {
        body: {
          session_ids: futureSess.slice(0, 2).map(s => s.id),
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
      assert.equal(r.statusCode, 201, JSON.stringify(r.body));
      allTransferRef = r.body.reservation.booking_ref;
      createdRefs.push(allTransferRef);

      const prepay = await prisma.bookingPrepay.findUnique({ where: { booking_ref: allTransferRef } });
      assert.equal(prepay.status, 'pending_payment');
      assert.equal(prepay.pass_persons, 0);
      assert.equal(prepay.amount_due, 1500);
      assert.ok(prepay.assigned_pool_account);

      const poolRow = await prisma.oneTimeAccountPool.findFirst({
        where: { account_number: prepay.assigned_pool_account }
      });
      assert.equal(poolRow.status, 'ASSIGNED');
      assert.equal(poolRow.assigned_order_ref, allTransferRef);

      const payCount = await prisma.payment.count({ where: { booking_ref: allTransferRef } });
      assert.equal(payCount, 0);
    }

    // Case 3: All pass (2 pax) PAST DEADLINE without board -> verified immediately, quota -2 (left=1), 2 pass payments, billing_status='paid'
    let allPassPastRef = null;
    {
      const r = createMockRes();
      await createReservation(makeReq(testUser, {
        body: {
          session_ids: pastSess.map(s => s.id),
          pax: 2,
          isUnlimited: true,
          self_service_ack: true,
          prepay: {
            pass_uses: [{ user_pass_id: userPass.id, persons: 2 }],
            transfer: null,
            expected_transfer_amount: 0
          }
        }
      }), r);
      assert.equal(r.statusCode, 201, JSON.stringify(r.body));
      allPassPastRef = r.body.reservation.booking_ref;
      createdRefs.push(allPassPastRef);

      const upAfter = await prisma.userPass.findUnique({ where: { id: userPass.id } });
      assert.equal(upAfter.remaining_quota, 1);

      const prepay = await prisma.bookingPrepay.findUnique({ where: { booking_ref: allPassPastRef } });
      assert.equal(prepay.status, 'verified');
      assert.equal(prepay.amount_due, 0);
      assert.ok(prepay.settled_at);

      const payments = await prisma.payment.findMany({ where: { booking_ref: allPassPastRef, status: 'valid' } });
      assert.equal(payments.length, 2);
      assert.ok(payments.every(p => p.method === 'pass'));

      const dbRes = await prisma.reservation.findFirst({ where: { booking_ref: allPassPastRef } });
      assert.equal(dbRes.billing_status, 'paid');
    }

    // Cancel all-pass verified on a future date (futureDateStr) -> customer can cancel, restores quota back to 3, voids payments
    {
      const rFutPass = createMockRes();
      await createReservation(makeReq(testUser, {
        body: {
          session_ids: futureSess.slice(0, 2).map(s => s.id),
          pax: 1,
          isUnlimited: true,
          self_service_ack: true,
          prepay: {
            pass_uses: [{ user_pass_id: userPass.id, persons: 1 }],
            transfer: null,
            expected_transfer_amount: 0
          }
        }
      }), rFutPass);
      assert.equal(rFutPass.statusCode, 201);
      const futPassRef = rFutPass.body.reservation.booking_ref;
      createdRefs.push(futPassRef);
      const upMid = await prisma.userPass.findUnique({ where: { id: userPass.id } });
      assert.equal(upMid.remaining_quota, 0);

      const r = createMockRes();
      await cancelReservation(makeReq(testUser, { params: { id: futPassRef } }), r);
      assert.equal(r.statusCode, 200, JSON.stringify(r.body));

      const upAfter = await prisma.userPass.findUnique({ where: { id: userPass.id } });
      assert.equal(upAfter.remaining_quota, 1);
      const voidedCount = await prisma.payment.count({ where: { booking_ref: futPassRef, status: 'voided' } });
      assert.equal(voidedCount, 1);
      const dbRes = await prisma.reservation.findFirst({ where: { booking_ref: futPassRef } });
      assert.equal(dbRes.status, 'cancelled');

      // Reset quota to 3 cleanly for subsequent cases
      await prisma.userPass.update({
        where: { id: userPass.id },
        data: { remaining_quota: 3, status: 'ACTIVE' }
      });
    }

    // Cancel Case 2 (pending_payment) -> releases pool account back to AVAILABLE
    {
      const prepayBefore = await prisma.bookingPrepay.findUnique({ where: { booking_ref: allTransferRef } });
      const poolAcc = prepayBefore.assigned_pool_account;
      const r = createMockRes();
      await cancelReservation(makeReq(testUser, { params: { id: allTransferRef } }), r);
      assert.equal(r.statusCode, 200, JSON.stringify(r.body));

      const poolRow = await prisma.oneTimeAccountPool.findFirst({ where: { account_number: poolAcc } });
      assert.equal(poolRow.status, 'AVAILABLE');
    }

    // Case 4: 3 pax, 1 pass + promo R25OFF100 + 1 pegboard_s (2h * 80 = 160)
    // Entry unpaid = 2 * 750 = 1500; board = 160; subtotal unpaid = 1660; promo = -100 => amount_due = 1560
    let comboRef = null;
    {
      // Check quote endpoint first
      const qRes = createMockRes();
      await postPrepayQuoteHandler(makeReq(testUser, {
        body: {
          session_ids: futureSess.slice(0, 2).map(s => s.id),
          pax: 3,
          isUnlimited: true,
          equipments: [{ equipment_id: 'pegboard_s', quantity: 1, rental_hours: 2, start_time: '13:00' }],
          promo_code: 'R25OFF100',
          pass_uses: [{ user_pass_id: userPass.id, persons: 1 }]
        }
      }), qRes);
      assert.equal(qRes.statusCode, 200);
      assert.equal(qRes.body.transfer_amount, 1560);
      assert.equal(qRes.body.promo.discount, 100);
      assert.deepEqual(qRes.body.promo.applies_to_persons, [1, 2]);

      const r = createMockRes();
      await createReservation(makeReq(testUser, {
        body: {
          session_ids: futureSess.slice(0, 2).map(s => s.id),
          pax: 3,
          isUnlimited: true,
          equipments: [{ equipment_id: 'pegboard_s', quantity: 1, rental_hours: 2, start_time: '13:00' }],
          promo_code: 'R25OFF100',
          self_service_ack: true,
          prepay: {
            pass_uses: [{ user_pass_id: userPass.id, persons: 1 }],
            transfer: { payment_method_code: 'r25_bank_transfer' },
            expected_transfer_amount: 1560
          }
        }
      }), r);
      assert.equal(r.statusCode, 201, JSON.stringify(r.body));
      comboRef = r.body.reservation.booking_ref;
      createdRefs.push(comboRef);

      const prepay = await prisma.bookingPrepay.findUnique({ where: { booking_ref: comboRef } });
      assert.equal(prepay.amount_due, 1560);
      assert.equal(prepay.pass_persons, 1);

      const be = await prisma.bookingEquipment.findFirst({ where: { booking_ref: comboRef } });
      assert.equal(be.unit_rate, 80);

      const pRow = await prisma.promoCode.findUnique({ where: { code: 'R25OFF100' } });
      assert.equal(pRow.used_count, 1);

      // Mutate equipment rates now; combo booking's GET /reservations/my & bill total must stay unchanged!
      await prisma.equipmentConfig.update({
        where: { id: 'pegboard_s' },
        data: { hourly_rate: 999, self_hourly_rate: 999 }
      });
      const dbRes = await prisma.reservation.findFirst({ where: { booking_ref: comboRef } });
      assert.equal(dbRes.total_amount, 1560 + 750);

      // Customer try modifyBookingEquipment -> 409
      const modRes = createMockRes();
      await modifyBookingEquipment(makeReq(testUser, {
        params: { booking_ref: comboRef },
        body: { equipments: [] }
      }), modRes);
      assert.equal(modRes.statusCode, 409);

      // Cancel combo -> restores pass (2 -> 3) and promo used_count (1 -> 0)
      const cRes = createMockRes();
      await cancelReservation(makeReq(testUser, { params: { id: comboRef } }), cRes);
      assert.equal(cRes.statusCode, 200);
      const pAfter = await prisma.promoCode.findUnique({ where: { code: 'R25OFF100' } });
      assert.equal(pAfter.used_count, 0);
      const upAfter = await prisma.userPass.findUnique({ where: { id: userPass.id } });
      assert.equal(upAfter.remaining_quota, 3);

      // Restore pegboard_s rates for next cases
      await prisma.equipmentConfig.update({
        where: { id: 'pegboard_s' },
        data: { hourly_rate: 100, self_hourly_rate: 80 }
      });
    }

    // Case 5: Promo min_pax = 3 with 3 pax & 1 pass -> fails condition (only 2 unpaid pax)
    {
      const qRes = createMockRes();
      await postPrepayQuoteHandler(makeReq(testUser, {
        body: {
          session_ids: futureSess.slice(0, 2).map(s => s.id),
          pax: 3,
          isUnlimited: true,
          promo_code: 'R25MIN3',
          pass_uses: [{ user_pass_id: userPass.id, persons: 1 }]
        }
      }), qRes);
      assert.equal(qRes.statusCode, 200);
      assert.ok(qRes.body.errors.some(e => e.code === 'PROMO_ERROR'));
      assert.equal(qRes.body.promo, null);
    }

    // Case 6: All pass + promo -> 400 PROMO_WITH_PASS
    {
      const r = createMockRes();
      await createReservation(makeReq(testUser, {
        body: {
          session_ids: futureSess.slice(0, 2).map(s => s.id),
          pax: 2,
          isUnlimited: true,
          promo_code: 'R25OFF100',
          self_service_ack: true,
          prepay: {
            pass_uses: [{ user_pass_id: userPass.id, persons: 2 }],
            transfer: null,
            expected_transfer_amount: 0
          }
        }
      }), r);
      assert.equal(r.statusCode, 400);
      assert.equal(r.body.code, 'PROMO_WITH_PASS');
    }

    // Case 7: 1 pass + 1 pegboard_s past deadline -> 409 PREPAY_DEADLINE_PASSED, quota unchanged
    {
      const r = createMockRes();
      await createReservation(makeReq(testUser, {
        body: {
          session_ids: pastSess.map(s => s.id),
          pax: 1,
          isUnlimited: true,
          equipments: [{ equipment_id: 'pegboard_s', quantity: 1, rental_hours: 2, start_time: '13:00' }],
          self_service_ack: true,
          prepay: {
            pass_uses: [{ user_pass_id: userPass.id, persons: 1 }],
            transfer: { payment_method_code: 'r25_bank_transfer' },
            expected_transfer_amount: 160
          }
        }
      }), r);
      assert.equal(r.statusCode, 409);
      assert.equal(r.body.code, 'PREPAY_DEADLINE_PASSED');
      const upCheck = await prisma.userPass.findUnique({ where: { id: userPass.id } });
      assert.equal(upCheck.remaining_quota, 3);
    }

    // Case 8: Pass quota insufficient (request 4 when remaining=3) -> 422 PASS_NOT_USABLE
    {
      const r = createMockRes();
      await createReservation(makeReq(testUser, {
        body: {
          session_ids: futureSess.slice(0, 2).map(s => s.id),
          pax: 4,
          isUnlimited: true,
          self_service_ack: true,
          prepay: {
            pass_uses: [{ user_pass_id: userPass.id, persons: 4 }],
            transfer: null,
            expected_transfer_amount: 0
          }
        }
      }), r);
      assert.equal(r.statusCode, 422);
      assert.equal(r.body.code, 'PASS_NOT_USABLE');
    }

    // Case 9: Wrong expected_transfer_amount -> 409 AMOUNT_CHANGED, no pool hold, quota unchanged
    {
      const availBefore = await prisma.oneTimeAccountPool.count({ where: { status: 'AVAILABLE' } });
      const r = createMockRes();
      await createReservation(makeReq(testUser, {
        body: {
          session_ids: futureSess.slice(0, 2).map(s => s.id),
          pax: 2,
          isUnlimited: true,
          self_service_ack: true,
          prepay: {
            pass_uses: [{ user_pass_id: userPass.id, persons: 1 }],
            transfer: { payment_method_code: 'ctbc_pool' },
            expected_transfer_amount: 999
          }
        }
      }), r);
      assert.equal(r.statusCode, 409);
      assert.equal(r.body.code, 'AMOUNT_CHANGED');
      const availAfter = await prisma.oneTimeAccountPool.count({ where: { status: 'AVAILABLE' } });
      assert.equal(availAfter, availBefore);
      const upCheck = await prisma.userPass.findUnique({ where: { id: userPass.id } });
      assert.equal(upCheck.remaining_quota, 3);
    }

    // Case 10: Equipment self_stock=1 taken by booking A -> booking B gets 409 out of stock
    {
      const rA = createMockRes();
      await createReservation(makeReq(otherUser, {
        body: {
          session_ids: futureSess.slice(0, 2).map(s => s.id),
          pax: 1,
          isUnlimited: true,
          equipments: [{ equipment_id: 'pegboard_s', quantity: 1, rental_hours: 2, start_time: '13:00' }],
          self_service_ack: true,
          prepay: {
            pass_uses: [],
            transfer: { payment_method_code: 'r25_bank_transfer' },
            expected_transfer_amount: 910
          }
        }
      }), rA);
      assert.equal(rA.statusCode, 201);
      createdRefs.push(rA.body.reservation.booking_ref);

      const rB = createMockRes();
      await createReservation(makeReq(testUser, {
        body: {
          session_ids: futureSess.slice(0, 2).map(s => s.id),
          pax: 1,
          isUnlimited: true,
          equipments: [{ equipment_id: 'pegboard_s', quantity: 1, rental_hours: 2, start_time: '13:00' }],
          self_service_ack: true,
          prepay: {
            pass_uses: [],
            transfer: { payment_method_code: 'r25_bank_transfer' },
            expected_transfer_amount: 910
          }
        }
      }), rB);
      assert.equal(rB.statusCode, 409);

      // Also check self_allow_equipment=false blocks equipments with 400 SELF_EQUIPMENT_NOT_OPEN
      await prisma.dailySetting.update({
        where: { date: dateOnly(futureDateStr) },
        data: { self_allow_equipment: false }
      });
      const rClosedEq = createMockRes();
      await createReservation(makeReq(testUser, {
        body: {
          session_ids: futureSess.slice(0, 2).map(s => s.id),
          pax: 1,
          isUnlimited: true,
          equipments: [{ equipment_id: 'pegboard_s', quantity: 1, rental_hours: 2, start_time: '13:00' }],
          self_service_ack: true,
          prepay: {
            pass_uses: [],
            transfer: { payment_method_code: 'r25_bank_transfer' },
            expected_transfer_amount: 910
          }
        }
      }), rClosedEq);
      assert.equal(rClosedEq.statusCode, 400);
      assert.equal(rClosedEq.body.code, 'SELF_EQUIPMENT_NOT_OPEN');
    }

    // Case 11: Unpaid limit max_unpaid_self_bookings=2 -> 3rd pending fails 409 TOO_MANY_UNPAID, bump to 3 succeeds
    const unpaidRefs = [];
    for (let i = 0; i < 2; i++) {
      const r = createMockRes();
      await createReservation(makeReq(testUser, {
        body: {
          session_ids: futureSess.slice(0, 2).map(s => s.id),
          pax: 1,
          isUnlimited: true,
          self_service_ack: true,
          prepay: {
            pass_uses: [],
            transfer: { payment_method_code: 'ctbc_pool' },
            expected_transfer_amount: 750
          }
        }
      }), r);
      assert.equal(r.statusCode, 201);
      unpaidRefs.push(r.body.reservation.booking_ref);
      createdRefs.push(r.body.reservation.booking_ref);
    }
    // 3rd unpaid fails 409 TOO_MANY_UNPAID
    {
      const r3 = createMockRes();
      await createReservation(makeReq(testUser, {
        body: {
          session_ids: futureSess.slice(0, 2).map(s => s.id),
          pax: 1,
          isUnlimited: true,
          self_service_ack: true,
          prepay: {
            pass_uses: [],
            transfer: { payment_method_code: 'r25_bank_transfer' },
            expected_transfer_amount: 750
          }
        }
      }), r3);
      assert.equal(r3.statusCode, 409);
      assert.equal(r3.body.code, 'TOO_MANY_UNPAID');
    }
    // Change max_unpaid_self_bookings to 3 -> 3rd succeeds; and 0-transfer all-pass still succeeds too!
    await prisma.kioskSetting.update({ where: { id: 1 }, data: { max_unpaid_self_bookings: 3 } });
    {
      const r3ok = createMockRes();
      await createReservation(makeReq(testUser, {
        body: {
          session_ids: futureSess.slice(0, 2).map(s => s.id),
          pax: 1,
          isUnlimited: true,
          promo_code: 'R25OFF100',
          self_service_ack: true,
          prepay: {
            pass_uses: [],
            transfer: { payment_method_code: 'r25_bank_transfer' },
            expected_transfer_amount: 650
          }
        }
      }), r3ok);
      assert.equal(r3ok.statusCode, 201, JSON.stringify(r3ok.body));
      unpaidRefs.push(r3ok.body.reservation.booking_ref);
      createdRefs.push(r3ok.body.reservation.booking_ref);
    }

    // Case 12: Expiry cron (`releaseExpiredPrepays`):
    // - unpaidRefs[0]: status=pending_payment + expired deadline + promo R25OFF100 test or pool account -> expired!
    // - unpaidRefs[1]: customer reported last5 -> reported_pending_verify + expired deadline -> untouched!
    // - unpaidRefs[2]: status=pending_payment + future deadline -> untouched!
    {
      // Report last5 on unpaidRefs[1]
      const repRes = createMockRes();
      await patchRemittanceLast5Handler(makeReq(testUser, {
        params: { booking_ref: unpaidRefs[1] },
        body: { remittance_last5: '54321' }
      }), repRes);
      assert.equal(repRes.statusCode, 200);
      assert.equal(repRes.body.prepay.status, 'reported_pending_verify');

      // Customer cancel reported -> blocked 400
      const cRepRes = createMockRes();
      await cancelReservation(makeReq(testUser, { params: { id: unpaidRefs[1] } }), cRepRes);
      assert.equal(cRepRes.statusCode, 400);

      // Force unpaidRefs[0] (pending_payment) & unpaidRefs[1] (reported_pending_verify) deadlines to the past
      const pastDeadline = new Date(Date.now() - 3600 * 1000);
      await prisma.bookingPrepay.updateMany({
        where: { booking_ref: { in: [unpaidRefs[0], unpaidRefs[1]] } },
        data: { deadline_at: pastDeadline }
      });

      const expiredCount = await releaseExpiredPrepays(new Date());
      assert.ok(expiredCount >= 1);

      const p0 = await prisma.bookingPrepay.findUnique({ where: { booking_ref: unpaidRefs[0] } });
      assert.equal(p0.status, 'expired');
      const r0 = await prisma.reservation.findFirst({ where: { booking_ref: unpaidRefs[0] } });
      assert.equal(r0.status, 'cancelled');
      assert.equal(r0.cancelled_by, 'system:prepay_expired');

      // Verify pool account from unpaidRefs[0] returned to AVAILABLE
      const releasedPool = await prisma.oneTimeAccountPool.findFirst({
        where: { account_number: p0.assigned_pool_account }
      });
      assert.equal(releasedPool.status, 'AVAILABLE');

      // unpaidRefs[1] (reported) MUST NOT be expired
      const p1 = await prisma.bookingPrepay.findUnique({ where: { booking_ref: unpaidRefs[1] } });
      assert.equal(p1.status, 'reported_pending_verify');

      // unpaidRefs[2] (future deadline) MUST NOT be expired, promo used_count is 1
      const p2 = await prisma.bookingPrepay.findUnique({ where: { booking_ref: unpaidRefs[2] } });
      assert.equal(p2.status, 'pending_payment');
      const promoMid = await prisma.promoCode.findUnique({ where: { code: 'R25OFF100' } });
      assert.equal(promoMid.used_count, 1);

      // Now expire unpaidRefs[2] as well -> promo used_count returns to 0
      await prisma.bookingPrepay.update({
        where: { booking_ref: unpaidRefs[2] },
        data: { deadline_at: pastDeadline }
      });
      await releaseExpiredPrepays(new Date());
      const promoAfterExpire = await prisma.promoCode.findUnique({ where: { code: 'R25OFF100' } });
      assert.equal(promoAfterExpire.used_count, 0);

      // Test GET /prepay-options & GET /my enrichment
      const optRes = createMockRes();
      await getPrepayOptionsHandler(makeReq(testUser, { query: { date: futureDateStr, pax: '2' } }), optRes);
      assert.equal(optRes.statusCode, 200);
      assert.equal(optRes.body.is_self_service, true);
      assert.ok(Array.isArray(optRes.body.passes));

      const myRes = createMockRes();
      await getMyReservations(makeReq(testUser), myRes);
      assert.equal(myRes.statusCode, 200);
      const myItem = myRes.body.find(item => item.booking_ref === unpaidRefs[1]);
      assert.ok(myItem);
      assert.equal(myItem.is_self_service, true);
      assert.ok(myItem.prepay);
      assert.equal(myItem.prepay.admin_note, undefined);
      assert.ok(myItem.self_info?.open_at);
      assert.equal(myItem.self_info?.until, '16:00');
    }

    // Case 13: Normal business day -> identical to regular flow (no BookingPrepay, is_self_service=false, normal hourly_rate)
    {
      const rNorm = createMockRes();
      await createReservation(makeReq(testUser, {
        body: {
          session_ids: normalSess.map(s => s.id),
          pax: 1,
          isUnlimited: false,
          equipments: [{ equipment_id: 'pegboard_s', quantity: 1, rental_hours: 2, start_time: '13:00' }]
        }
      }), rNorm);
      assert.equal(rNorm.statusCode, 201, JSON.stringify(rNorm.body));
      const normRef = rNorm.body.reservation.booking_ref;
      createdRefs.push(normRef);

      const dbNorm = await prisma.reservation.findFirst({ where: { booking_ref: normRef } });
      assert.equal(dbNorm.is_self_service, false);
      const normPrepay = await prisma.bookingPrepay.findUnique({ where: { booking_ref: normRef } });
      assert.equal(normPrepay, null);
      const normEq = await prisma.bookingEquipment.findFirst({ where: { booking_ref: normRef } });
      assert.equal(normEq.subtotal_price, 200); // regular hourly_rate=100 * 2h
    }
  } finally {
    // Cleanup in reverse dependency order (never delete append-only AccountingEvent)
    const remainingSess = await prisma.session.findMany({ where: { session_date: { in: testDates } }, select: { id: true } });
    const remainingSessIds = remainingSess.map(s => s.id);
    const remainingRes = remainingSessIds.length
      ? await prisma.reservation.findMany({ where: { session_id: { in: remainingSessIds } }, select: { booking_ref: true } })
      : [];
    const allCleanupRefs = [...new Set([...createdRefs, ...remainingRes.map(r => r.booking_ref)])];
    if (allCleanupRefs.length) {
      await prisma.payment.deleteMany({ where: { booking_ref: { in: allCleanupRefs } } });
      await prisma.bookingPrepay.deleteMany({ where: { booking_ref: { in: allCleanupRefs } } });
      await prisma.bookingPerson.deleteMany({ where: { booking_ref: { in: allCleanupRefs } } });
      await prisma.bookingEquipment.deleteMany({ where: { booking_ref: { in: allCleanupRefs } } });
      await prisma.reservation.deleteMany({ where: { booking_ref: { in: allCleanupRefs } } });
    }
    await prisma.session.deleteMany({ where: { session_date: { in: testDates } } });
    await prisma.dailySetting.deleteMany({ where: { date: { in: testDates } } });
    if (createdPlanIds.length) {
      await prisma.userPass.deleteMany({ where: { plan_id: { in: createdPlanIds } } });
      await prisma.passPlan.deleteMany({ where: { id: { in: createdPlanIds } } });
    }
    if (createdPromoIds.length) {
      await prisma.promoCode.deleteMany({ where: { id: { in: createdPromoIds } } });
    }
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
