import test from 'node:test';
import assert from 'node:assert/strict';
import prisma from '../src/prismaClient.js';
import { dateOnly } from '../../shared/time.js';
import { ensureTestPublishedLayout, cleanupTestPublishedLayout } from './helpers/seedTestLayout.js';
import { ensureDefaultEquipmentConfigs } from '../src/controllers/equipmentController.js';
import { createReservationHandler } from '../src/controllers/reservationController.js';

function createMockRes() {
  return {
    statusCode: 200,
    body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; }
  };
}

test('Round 25b Item 4: Abort creation with 409 AMOUNT_CHANGED and full rollback when getBookingBill differs from quote', async () => {
  const testDateStr = '2099-09-12';
  const testDate = dateOnly(testDateStr);

  let savedKiosk = null;
  let savedSmallEq = null;
  let createdLayoutId = null;
  const createdPoolIds = [];
  const createdPlanIds = [];
  const createdPromoIds = [];

  try {
    await ensureDefaultEquipmentConfigs();
    savedKiosk = await prisma.kioskSetting.findUnique({ where: { id: 1 } });
    savedSmallEq = await prisma.equipmentConfig.findUnique({ where: { id: 'pegboard_s' } });

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

    createdLayoutId = await ensureTestPublishedLayout(prisma, {
      name: 'R25b Mismatch Layout',
      effectiveFrom: '2020-01-01',
      effectiveDate: testDateStr,
      codePrefix: 'M',
      seatCount: 16
    });

    await prisma.kioskSetting.upsert({
      where: { id: 1 },
      update: { prepay_deadline_hour: 12, early_minutes: 30, max_unpaid_self_bookings: 2 },
      create: { id: 1, prepay_deadline_hour: 12, early_minutes: 30, after_close_minutes: 60, max_unpaid_self_bookings: 2 }
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

    const poolAccNum = '82290095099';
    await prisma.oneTimeAccountPool.deleteMany({ where: { account_number: poolAccNum } });
    const pool = await prisma.oneTimeAccountPool.create({
      data: { payment_method_code: 'ctbc_pool', account_number: poolAccNum, status: 'AVAILABLE' }
    });
    createdPoolIds.push(pool.id);

    const testUser = await prisma.user.upsert({
      where: { line_user_id: 'r25b_mismatch_user' },
      update: { name: 'R25b金額保護會員', phone: '0911000952', is_blacklisted: false },
      create: { line_user_id: 'r25b_mismatch_user', name: 'R25b金額保護會員', phone: '0911000952' }
    });
    await prisma.bookingPrepay.deleteMany({ where: { user_id: testUser.id } });

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
      where: { code: 'r25b_mismatch_punch' },
      update: { pass_type: 'PUNCH_CARD', checkout_effect: 'entry_full', is_active: true },
      create: {
        code: 'r25b_mismatch_punch',
        name: 'R25b回滾測試九宮格卡',
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
        pass_code: `PASS-R25B-M-${Date.now()}`,
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

    await prisma.promoCode.deleteMany({ where: { code: 'R25BMISMATCH' } });
    const promo = await prisma.promoCode.create({
      data: {
        code: 'R25BMISMATCH',
        name: 'R25b金額保護折價',
        discount_type: 'fixed',
        discount_value: 100,
        target_scope: 'entry',
        is_active: true,
        used_count: 0
      }
    });
    createdPromoIds.push(promo.id);

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

    // Deliberately inject a diverging getBookingBill total (quote = 1560, bill = 9999)
    const createWithDivergentBill = createReservationHandler({
      getBookingBill: async () => ({
        bill: { summary: { amount_due: 9999 } }
      })
    });

    const testStartTs = new Date();
    const res = createMockRes();
    await createWithDivergentBill({
      user: { id: testUser.id, name: testUser.name, role: 'customer' },
      body: {
        session_ids: sessionIds,
        pax: 2,
        isUnlimited: true,
        promo_code: 'R25BMISMATCH',
        equipments: [{ equipment_id: 'pegboard_s', quantity: 1, rental_hours: 2, start_time: '13:00' }],
        self_service_ack: true,
        prepay: {
          pass_uses: [{ user_pass_id: userPass.id, persons: 1 }],
          transfer: { payment_method_code: 'ctbc_pool' },
          expected_transfer_amount: 810 // 750 - 100 promo + 160 board = 810 (total 1560)
        }
      }
    }, res);

    assert.equal(res.statusCode, 409);
    assert.equal(res.body.code, 'AMOUNT_CHANGED');
    assert.equal(res.body.quote?.total_amount, 9999);

    // Assert full transaction rollback: 0 persisted rows anywhere
    const [resCount, prepayCount, eqCount, dbPass, dbPool, dbPromo] = await Promise.all([
      prisma.reservation.count({ where: { session_id: { in: sessionIds } } }),
      prisma.bookingPrepay.count({ where: { user_id: testUser.id } }),
      prisma.bookingEquipment.count({ where: { created_at: { gte: testStartTs } } }),
      prisma.userPass.findUnique({ where: { id: userPass.id } }),
      prisma.oneTimeAccountPool.findUnique({ where: { id: pool.id } }),
      prisma.promoCode.findUnique({ where: { id: promo.id } })
    ]);

    assert.equal(resCount, 0, 'Reservation must be rolled back');
    assert.equal(prepayCount, 0, 'BookingPrepay must be rolled back');
    assert.equal(eqCount, 0, 'BookingEquipment must be rolled back');
    assert.equal(dbPass.remaining_quota, 3, 'UserPass deduction must be rolled back');
    assert.equal(dbPool.status, 'AVAILABLE', 'OneTimeAccountPool hold must be rolled back');
    assert.equal(dbPool.assigned_order_ref, null);
    assert.equal(dbPromo.used_count, 0, 'PromoCode usage must be rolled back');
  } finally {
    const remainingSess = await prisma.session.findMany({ where: { session_date: testDate }, select: { id: true } });
    const remainingSessIds = remainingSess.map((s) => s.id);
    if (remainingSessIds.length) {
      const remainingRes = await prisma.reservation.findMany({ where: { session_id: { in: remainingSessIds } }, select: { booking_ref: true } });
      const refs = [...new Set(remainingRes.map((r) => r.booking_ref))];
      if (refs.length) {
        await prisma.payment.deleteMany({ where: { booking_ref: { in: refs } } });
        await prisma.bookingPrepay.deleteMany({ where: { booking_ref: { in: refs } } });
        await prisma.bookingPerson.deleteMany({ where: { booking_ref: { in: refs } } });
        await prisma.bookingEquipment.deleteMany({ where: { booking_ref: { in: refs } } });
        await prisma.reservation.deleteMany({ where: { booking_ref: { in: refs } } });
      }
      await prisma.session.deleteMany({ where: { id: { in: remainingSessIds } } });
    }
    await prisma.dailySetting.deleteMany({ where: { date: testDate } });
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
    } else {
      await prisma.kioskSetting.delete({ where: { id: 1 } }).catch(() => {});
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
