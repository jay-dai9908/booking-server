import test from 'node:test';
import assert from 'node:assert/strict';
import prisma from '../src/prismaClient.js';
import { dateOnly } from '../../shared/time.js';
import { getDayInfo, getDayInfoRange, getDayType } from '../src/services/calendar/dayType.js';
import { getEffectiveDailyRates, createReservationHandler } from '../src/controllers/reservationController.js';
import { getDailySettingsRange } from '../src/controllers/dailySettingController.js';
import { validatePassUsage, deductPass } from '../src/services/billing/passTender.js';
import { evaluatePromoCode } from '../src/controllers/checkoutController.js';
import { solidifyDailyPrices } from '../src/services/pricing/solidify.js';

function createMockRes() {
  return {
    statusCode: 200,
    body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; }
  };
}

test('Round 47 Item 1: Day type drives pricing, snapshots, passes, promos, solidify, and daily-settings range', async () => {
  const runId = Date.now();
  const wedStr = '2026-11-25';
  const satStr = '2026-11-28';
  const pastWedStr = '2026-11-18';
  const wedDate = dateOnly(wedStr);
  const satDate = dateOnly(satStr);
  const pastWedDate = dateOnly(pastWedStr);

  const prevGlobal = await prisma.globalSetting.findUnique({ where: { id: 1 } });
  const createdSessionIds = [];
  const createdUserIds = [];
  const createdPassPlanIds = [];
  const createdPassIds = [];
  const createdPromoIds = [];
  const createdRefs = [];

  try {
    await prisma.globalSetting.upsert({
      where: { id: 1 },
      update: {
        weekday_hourly_price: 150,
        weekday_unlimited_price: 750,
        weekend_hourly_price: 180,
        weekend_unlimited_price: 1100
      },
      create: {
        id: 1,
        weekday_hourly_price: 150,
        weekday_unlimited_price: 750,
        weekend_hourly_price: 180,
        weekend_unlimited_price: 1100
      }
    });

    await prisma.dailySetting.deleteMany({
      where: { date: { in: [wedDate, satDate, pastWedDate] } }
    });

    const ensureSession = async (session_date, start_time = '13:00', end_time = '14:00') => {
      const existing = await prisma.session.findUnique({
        where: { session_date_start_time: { session_date, start_time } }
      });
      if (existing) return existing;
      const created = await prisma.session.create({
        data: { session_date, start_time, end_time, max_capacity: 16 }
      });
      createdSessionIds.push(created.id);
      return created;
    };

    const [sWed] = await Promise.all([
      ensureSession(wedDate, '13:00', '14:00'),
      ensureSession(satDate, '13:00', '14:00'),
      ensureSession(pastWedDate, '13:00', '14:00')
    ]);

    const user = await prisma.user.create({
      data: {
        name: `R47測試顧客-${runId}`,
        phone: `0988${String(runId).slice(-6)}`,
        line_user_id: `U_R47_${runId}`
      }
    });
    createdUserIds.push(user.id);

    const passPlan = await prisma.passPlan.create({
      data: {
        code: `R47WK_PLAN_${runId}`,
        name: `R47限平日卡-${runId}`,
        pass_type: 'PUNCH_CARD',
        price: 1000,
        total_quota: 5,
        day_restriction: 'WEEKDAY_ONLY',
        is_active: true
      }
    });
    createdPassPlanIds.push(passPlan.id);

    const weekdayPass = await prisma.userPass.create({
      data: {
        user_id: user.id,
        plan_id: passPlan.id,
        pass_code: `R47WK-${runId}`,
        plan_name_snapshot: passPlan.name,
        pass_type: 'PUNCH_CARD',
        total_quota: 5,
        remaining_quota: 5,
        day_restriction: 'WEEKDAY_ONLY',
        payment_status: 'active',
        status: 'ACTIVE',
        expires_at: dateOnly('2099-12-31')
      }
    });
    createdPassIds.push(weekdayPass.id);

    const weekendPromo = await prisma.promoCode.create({
      data: {
        code: `R47WKND${String(runId).slice(-5)}`,
        name: 'R47限假日優惠',
        discount_type: 'fixed_order',
        discount_value: 50,
        target_scope: 'all',
        day_type_limit: 'weekend',
        mode_limit: 'all',
        channel: 'all',
        min_pax: 1,
        min_hours: 1,
        min_amount: 0,
        is_active: true
      }
    });
    createdPromoIds.push(weekendPromo.id);

    // 1. 2026-11-25 (Wed) manual holiday
    await prisma.dailySetting.create({
      data: {
        date: wedDate,
        day_type: 'holiday',
        day_type_source: 'manual'
      }
    });

    const ratesWedHoliday = await getEffectiveDailyRates(prisma, wedStr);
    assert.equal(ratesWedHoliday.hourly_price, 180);
    assert.equal(ratesWedHoliday.is_weekend, true);

    // Booking on 2026-11-25 captures pricing_snapshot.is_weekend = true & hourly = 180
    const resBook = createMockRes();
    await createReservationHandler()(
      {
        user: { id: user.id, name: user.name, phone: user.phone },
        body: {
          session_ids: [sWed.id],
          pax: 1,
          is_unlimited: false
        }
      },
      resBook
    );
    assert.equal(resBook.statusCode, 201);
    const bookedRow = await prisma.reservation.findFirst({
      where: { user_id: user.id },
      orderBy: { id: 'desc' }
    });
    assert.ok(bookedRow);
    const createdRef = bookedRow.booking_ref;
    createdRefs.push(createdRef);
    assert.equal(bookedRow.pricing_snapshot?.is_weekend, true);
    assert.equal(bookedRow.pricing_snapshot?.hourly, 180);

    // Weekday-only pass rejected via price_type & deductPass
    const wedInfo = await getDayInfo(prisma, wedStr);
    assert.equal(wedInfo.type, 'holiday');
    assert.equal(wedInfo.price_type, 'holiday');
    const passCheck = validatePassUsage(weekdayPass, { date: wedStr, units: 1, priceType: wedInfo.price_type });
    assert.equal(passCheck.usable, false);
    await assert.rejects(
      () =>
        prisma.$transaction((tx) =>
          deductPass(tx, {
            user_pass_id: weekdayPass.id,
            units: 1,
            booking_ref: createdRef,
            staff_name: 'tester',
            date: wedStr
          })
        ),
      (err) => err && err.status === 422
    );

    // Weekend-only promo allowed on manual holiday Wed
    const promoRes = await evaluatePromoCode(prisma, {
      code: weekendPromo.code,
      user_id: user.id,
      session_date: wedStr,
      pax: 1,
      hours: 1,
      base_amount: 180,
      hourly_price: 180
    });
    assert.equal(promoRes.valid, true);

    // 2. Switch 2026-11-25 back to auto -> 150 & weekday
    await prisma.dailySetting.update({
      where: { date: wedDate },
      data: { day_type: null, price_type: null, day_type_source: 'manual' }
    });
    const ratesWedAuto = await getEffectiveDailyRates(prisma, wedStr);
    assert.equal(ratesWedAuto.hourly_price, 150);
    assert.equal(ratesWedAuto.is_weekend, false);

    // 3. 2026-11-28 (Sat) no setting -> 180
    const ratesSat = await getEffectiveDailyRates(prisma, satStr);
    assert.equal(ratesSat.hourly_price, 180);
    assert.equal(ratesSat.is_weekend, true);
    assert.equal(await getDayType(satStr, prisma), 'holiday');

    // 4. solidifyDailyPrices uses price_type (2026-11-18 Wed manual holiday without prices -> 180)
    await prisma.dailySetting.create({
      data: {
        date: pastWedDate,
        day_type: 'holiday',
        day_type_source: 'manual'
      }
    });
    const solidRes = await solidifyDailyPrices({ through: pastWedStr, txOrPrisma: prisma });
    assert.ok(solidRes.updatedDates.includes(pastWedStr));
    const solidifiedPastWed = await prisma.dailySetting.findUnique({ where: { date: pastWedDate } });
    assert.equal(solidifiedPastWed.hourly_price, 180);
    assert.equal(solidifiedPastWed.unlimited_price, 1100);

    // 5. GET /daily-settings/range includes day_type & price_type for each day
    await prisma.dailySetting.update({
      where: { date: wedDate },
      data: { day_type: 'holiday', day_type_source: 'manual' }
    });
    const resRange = createMockRes();
    await getDailySettingsRange({ query: { start: '2026-11-25', end: '2026-11-28' } }, resRange);
    assert.equal(resRange.statusCode, 200);
    assert.equal(resRange.body.length, 4);
    const wedItem = resRange.body.find((d) => d.date === wedStr);
    const thuItem = resRange.body.find((d) => d.date === '2026-11-26');
    const satItem = resRange.body.find((d) => d.date === satStr);
    assert.equal(wedItem.day_type, 'holiday');
    assert.equal(wedItem.price_type, 'holiday');
    assert.equal(thuItem.day_type, 'closed');
    assert.equal(thuItem.price_type, 'weekday');
    assert.equal(satItem.day_type, 'holiday');
    assert.equal(satItem.price_type, 'holiday');
  } finally {
    const validRefs = createdRefs.filter(Boolean);
    if (validRefs.length > 0) {
      await prisma.bookingPerson.deleteMany({ where: { booking_ref: { in: validRefs } } });
      await prisma.reservation.deleteMany({ where: { booking_ref: { in: validRefs } } });
    }
    await prisma.userPass.deleteMany({ where: { pass_code: { startsWith: 'R47WK-' } } });
    await prisma.passPlan.deleteMany({ where: { code: { startsWith: 'R47WK_PLAN_' } } });
    await prisma.promoCode.deleteMany({ where: { code: { startsWith: 'R47WKND' } } });
    await prisma.user.deleteMany({ where: { line_user_id: { startsWith: 'U_R47_' } } });
    if (createdSessionIds.length > 0) {
      await prisma.session.deleteMany({ where: { id: { in: createdSessionIds } } });
    }
    await prisma.dailySetting.deleteMany({
      where: { date: { in: [wedDate, satDate, pastWedDate] } }
    });
    if (prevGlobal) {
      await prisma.globalSetting.update({
        where: { id: 1 },
        data: {
          weekday_hourly_price: prevGlobal.weekday_hourly_price,
          weekday_unlimited_price: prevGlobal.weekday_unlimited_price,
          weekend_hourly_price: prevGlobal.weekend_hourly_price,
          weekend_unlimited_price: prevGlobal.weekend_unlimited_price
        }
      });
    }
  }
});
