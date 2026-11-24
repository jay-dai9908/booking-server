import test from 'node:test';
import assert from 'node:assert/strict';
import prisma from '../src/prismaClient.js';
import { dateOnly } from '../../shared/time.js';
import { ensureTestPublishedLayout, cleanupTestPublishedLayout } from './helpers/seedTestLayout.js';
import { createReservation, adminCancelReservation } from '../src/controllers/reservationController.js';
import { patchRemittanceLast5Handler, verifyAdminPrepayHandler } from '../src/controllers/prepayController.js';
import { voidPayment, markUnpaid } from '../src/services/billing/billService.js';
import { releaseExpiredPrepays } from '../src/services/selfService/prepayService.js';
import { isBookingClearedForEntry, processKioskAccess } from '../src/services/kiosk/accessService.js';

function createMockRes() {
  return {
    statusCode: 200,
    body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; }
  };
}

function makeCustomerReq(user, { body = {}, params = {} } = {}) {
  return { user: { id: user.id, name: user.name, role: 'customer', typ: 'customer' }, body, params };
}

function makeAdminReq({ body = {}, params = {} } = {}) {
  return {
    user: { id: 1, name: 'R38店員', role: 'admin' },
    headers: { 'x-device-label': 'R38櫃檯' },
    body,
    params
  };
}

test('Round 38 Item 4: voidPayment & markUnpaid reopen verified BookingPrepay without double-restoring held passes', async () => {
  const futureDateStr = '2099-09-20';
  const testDate = dateOnly(futureDateStr);
  const createdRefs = [];
  let user = null;
  let plan = null;
  let pass1 = null;
  let pass2 = null;
  let layoutId = null;
  let savedKiosk = null;
  let savedMethod = null;

  try {
    savedKiosk = await prisma.kioskSetting.findUnique({ where: { id: 1 } });
    layoutId = await ensureTestPublishedLayout(prisma, {
      name: 'R38 Item4 Layout',
      effectiveFrom: '2020-01-01',
      effectiveDate: futureDateStr,
      codePrefix: 'C',
      seatCount: 16
    });

    await prisma.kioskSetting.upsert({
      where: { id: 1 },
      update: { prepay_deadline_hour: 12, early_minutes: 30, max_unpaid_self_bookings: 10 },
      create: { id: 1, prepay_deadline_hour: 12, early_minutes: 30, after_close_minutes: 60, max_unpaid_self_bookings: 10 }
    });

    await prisma.dailySetting.upsert({
      where: { date: testDate },
      update: { is_self_service: true, hourly_price: 150, unlimited_price: 500, allow_unlimited: true, self_allow_hourly: true },
      create: { date: testDate, is_self_service: true, hourly_price: 150, unlimited_price: 500, allow_unlimited: true, self_allow_hourly: true }
    });

    const bankCode = `r38_bank_${Date.now()}`;
    savedMethod = bankCode;
    await prisma.paymentMethodConfig.create({
      data: {
        code: bankCode,
        name: 'R38測試銀行',
        method_type: 'MULTI_BANK',
        bank_accounts_json: [{ bank: '004', account: '1234567890' }],
        is_enabled: true,
        require_last5: true,
        sort_order: 99
      }
    });

    await prisma.session.deleteMany({ where: { session_date: testDate } });
    const sessions = await Promise.all([
      prisma.session.create({ data: { session_date: testDate, start_time: '14:00', end_time: '15:00', max_capacity: 16 } }),
      prisma.session.create({ data: { session_date: testDate, start_time: '15:00', end_time: '16:00', max_capacity: 16 } })
    ]);
    const sessionIds = sessions.map(s => s.id);

    const ts = Date.now();
    user = await prisma.user.create({
      data: { line_user_id: `manual_r38_4_${ts}`, name: 'R38半自助客', phone: `0986${String(ts).slice(-6)}` }
    });
    plan = await prisma.passPlan.create({
      data: {
        code: `R38_I4_${ts}`,
        name: 'R38暢遊體驗券',
        pass_type: 'PUNCH_CARD',
        price: 500,
        total_quota: 3,
        checkout_effect: 'entry_full',
        valid_days: 90
      }
    });
    pass1 = await prisma.userPass.create({
      data: {
        pass_code: `PASS-R38A-${ts}`,
        user_id: user.id,
        plan_id: plan.id,
        plan_name_snapshot: plan.name,
        pass_type: 'PUNCH_CARD',
        remaining_quota: 3,
        total_quota: 3,
        status: 'ACTIVE'
      }
    });
    pass2 = await prisma.userPass.create({
      data: {
        pass_code: `PASS-R38B-${ts}`,
        user_id: user.id,
        plan_id: plan.id,
        plan_name_snapshot: plan.name,
        pass_type: 'PUNCH_CARD',
        remaining_quota: 3,
        total_quota: 3,
        status: 'ACTIVE'
      }
    });

    // Helper to create & verify 2-pax booking (1 pass + 500 transfer)
    async function createAndVerifyBooking(passRow) {
      const cr = createMockRes();
      await createReservation(makeCustomerReq(user, {
        body: {
          session_ids: sessionIds,
          pax: 2,
          isUnlimited: true,
          self_service_ack: true,
          prepay: {
            pass_uses: [{ user_pass_id: passRow.id, persons: 1 }],
            transfer: { payment_method_code: bankCode },
            expected_transfer_amount: 500
          }
        }
      }), cr);
      assert.equal(cr.statusCode, 201, `Create failed: ${JSON.stringify(cr.body)}`);
      const bRef = cr.body.reservation.booking_ref;
      createdRefs.push(bRef);

      const p5 = createMockRes();
      await patchRemittanceLast5Handler(makeCustomerReq(user, {
        params: { booking_ref: bRef },
        body: { remittance_last5: '12345' }
      }), p5);
      assert.equal(p5.statusCode, 200);

      const ver = createMockRes();
      await verifyAdminPrepayHandler(makeAdminReq({ params: { booking_ref: bRef } }), ver);
      assert.equal(ver.statusCode, 200);
      return bRef;
    }

    // --- Scenario A: verify -> voidPayment transfer -> reopen + no double pass restore -> re-verify -> cancel ---
    const refA = await createAndVerifyBooking(pass1);
    const pass1AfterBooking = await prisma.userPass.findUnique({ where: { id: pass1.id } });
    assert.equal(pass1AfterBooking.remaining_quota, 2);

    const accessNow = new Date(`${futureDateStr}T14:05:00+08:00`);
    const prepayA1 = await prisma.bookingPrepay.findUnique({ where: { booking_ref: refA } });
    const resListA1 = await prisma.reservation.findMany({ where: { booking_ref: refA }, include: { session: true } });
    assert.equal(isBookingClearedForEntry(resListA1[0], prepayA1), true);
    const accOpen = await processKioskAccess(prisma, { method: 'phone', payload: user.phone, now: accessNow });
    assert.equal(accOpen.open_door, true);

    const transferPayA = await prisma.payment.findFirst({
      where: { booking_ref: refA, status: 'valid', method: 'transfer' }
    });
    assert.ok(transferPayA);

    await voidPayment(transferPayA.id, '對錯帳作廢重來', { id: 1, name: 'R38店員' }, { device_label: 'R38櫃檯' });

    const prepayA2 = await prisma.bookingPrepay.findUnique({ where: { booking_ref: refA } });
    assert.equal(prepayA2.status, 'reported_pending_verify');
    assert.equal(prepayA2.settled_at, null);
    assert.equal(prepayA2.verified_at, null);
    assert.match(prepayA2.admin_note || '', /作廢入帳，待重新對帳/);

    const reopenEv = await prisma.accountingEvent.findFirst({
      where: { booking_ref: refA, event_type: 'prepay_reopened' }
    });
    assert.ok(reopenEv);
    assert.equal(reopenEv.category, 'status');

    // Kiosk no longer clears!
    const resListA2 = await prisma.reservation.findMany({ where: { booking_ref: refA }, include: { session: true } });
    assert.equal(isBookingClearedForEntry(resListA2[0], prepayA2), false);
    const accDenied = await processKioskAccess(prisma, { method: 'phone', payload: user.phone, now: accessNow });
    assert.equal(accDenied.result, 'UNVERIFIED');
    assert.equal(accDenied.open_door, false);

    // Pass remaining_quota stays 2 (NOT restored to 3 yet!)
    const pass1AfterVoid = await prisma.userPass.findUnique({ where: { id: pass1.id } });
    assert.equal(pass1AfterVoid.remaining_quota, 2);

    // Re-verify -> succeeds without deducting pass again -> quota still 2 -> kiosk clears
    const reVer = createMockRes();
    await verifyAdminPrepayHandler(makeAdminReq({ params: { booking_ref: refA } }), reVer);
    assert.equal(reVer.statusCode, 200);
    const prepayA3 = await prisma.bookingPrepay.findUnique({ where: { booking_ref: refA } });
    assert.equal(prepayA3.status, 'verified');
    assert.equal((await prisma.userPass.findUnique({ where: { id: pass1.id } })).remaining_quota, 2);
    const accReopen = await processKioskAccess(prisma, { method: 'phone', payload: user.phone, now: accessNow });
    assert.equal(accReopen.open_door, true);

    // Cancel refA before creating refB so phone lookup matches refB cleanly
    await prisma.bookingPrepay.update({ where: { booking_ref: refA }, data: { status: 'pending_payment', settled_at: null } });

    // --- Scenario B: markUnpaid -> voided -> releaseExpiredPrepays leaves reported_pending_verify untouched -> customer cancel restores pass ONCE (to 3) ---
    const refB = await createAndVerifyBooking(pass2);
    assert.equal((await prisma.userPass.findUnique({ where: { id: pass2.id } })).remaining_quota, 2);

    await markUnpaid(refB, '誤按對帳退回重核', { id: 1, name: 'R38店員' }, { device_label: 'R38櫃檯' });

    const prepayB2 = await prisma.bookingPrepay.findUnique({ where: { booking_ref: refB } });
    assert.equal(prepayB2.status, 'reported_pending_verify');
    assert.equal(prepayB2.settled_at, null);
    assert.equal((await prisma.userPass.findUnique({ where: { id: pass2.id } })).remaining_quota, 2);

    // Expired prepay cron must NOT cancel reported_pending_verify even with past deadline
    await prisma.bookingPrepay.update({
      where: { booking_ref: refB },
      data: { deadline_at: new Date(Date.now() - 3600000) }
    });
    await releaseExpiredPrepays(new Date());
    const prepayBAfterCron = await prisma.bookingPrepay.findUnique({ where: { booking_ref: refB } });
    assert.equal(prepayBAfterCron.status, 'reported_pending_verify');

    // Now cancel refB -> pass_holds restored ONCE (2 -> 3, never 4)
    const cancelRes = createMockRes();
    await adminCancelReservation({
      params: { booking_ref: refB },
      user: { id: 1, name: 'R38店員', role: 'admin' },
      body: {}
    }, cancelRes);
    assert.equal(cancelRes.statusCode, 200);
    const pass2AfterCancel = await prisma.userPass.findUnique({ where: { id: pass2.id } });
    assert.equal(pass2AfterCancel.remaining_quota, 3);
  } finally {
    if (savedMethod) {
      await prisma.paymentMethodConfig.deleteMany({ where: { code: savedMethod } }).catch(() => {});
    }
    if (createdRefs.length) {
      await prisma.kioskAccessLog.deleteMany({ where: { booking_ref: { in: createdRefs } } });
      await prisma.payment.deleteMany({ where: { booking_ref: { in: createdRefs } } });
      await prisma.bookingPrepay.deleteMany({ where: { booking_ref: { in: createdRefs } } });
      await prisma.bookingPerson.deleteMany({ where: { booking_ref: { in: createdRefs } } });
      await prisma.bookingEquipment.deleteMany({ where: { booking_ref: { in: createdRefs } } });
      await prisma.reservation.deleteMany({ where: { booking_ref: { in: createdRefs } } });
    }
    await prisma.session.deleteMany({ where: { session_date: testDate } });
    await prisma.dailySetting.deleteMany({ where: { date: testDate } });
    if (pass1) await prisma.userPass.deleteMany({ where: { id: pass1.id } });
    if (pass2) await prisma.userPass.deleteMany({ where: { id: pass2.id } });
    if (plan) await prisma.passPlan.deleteMany({ where: { id: plan.id } });
    if (user) await prisma.user.deleteMany({ where: { id: user.id } });
    if (layoutId) await cleanupTestPublishedLayout(prisma, layoutId).catch(() => {});
    if (savedKiosk) {
      await prisma.kioskSetting.update({
        where: { id: 1 },
        data: {
          prepay_deadline_hour: savedKiosk.prepay_deadline_hour,
          early_minutes: savedKiosk.early_minutes,
          max_unpaid_self_bookings: savedKiosk.max_unpaid_self_bookings
        }
      }).catch(() => {});
    }
  }
});
