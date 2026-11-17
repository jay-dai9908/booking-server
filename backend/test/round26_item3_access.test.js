import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import prisma from '../src/prismaClient.js';
import { dateOnly } from '../../shared/time.js';
import { ensureTestPublishedLayout, cleanupTestPublishedLayout } from './helpers/seedTestLayout.js';
import { ensureDefaultEquipmentConfigs } from '../src/controllers/equipmentController.js';
import { createReservation } from '../src/controllers/reservationController.js';
import { patchRemittanceLast5Handler, verifyAdminPrepayHandler } from '../src/controllers/prepayController.js';
import { checkIn } from '../src/controllers/floorController.js';
import { getBookingBill } from '../src/services/billing/billService.js';
import { getActiveLayoutForDate } from '../src/services/seating/layoutService.js';
import { qrKeyFrom, qrCodeFor, wrapPairKey } from '../src/services/kiosk/sgk1.js';
import { processKioskAccess } from '../src/services/kiosk/accessService.js';

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
    user: { id: 1, name: 'R26管理員', role: 'admin' },
    headers: { 'x-device-label': 'POS測試機' },
    body,
    params,
    query
  };
}

test('Round 26 Item 3: Kiosk access handles all 8 outcomes, QR windows, WAIT fallback, concurrency, smart boards, and floor lock', async () => {
  const selfDateStr = '2099-10-10';
  const normalDateStr = '2099-10-11';
  const selfDate = dateOnly(selfDateStr);
  const normalDate = dateOnly(normalDateStr);
  const testDates = [selfDate, normalDate];

  const tEarly = new Date(`${selfDateStr}T12:15:00.000+08:00`);
  const tOpen = new Date(`${selfDateStr}T12:40:00.000+08:00`);
  const tEnded = new Date(`${selfDateStr}T22:05:00.000+08:00`);
  const tNormal = new Date(`${normalDateStr}T13:10:00.000+08:00`);

  let savedKiosk = null;
  let savedSmallEq = null;
  let createdLayoutId = null;
  let createdMethodCode = null;
  let device = null;
  const createdPlanIds = [];
  const createdRefs = [];

  try {
    await ensureDefaultEquipmentConfigs();
    savedKiosk = await prisma.kioskSetting.findUnique({ where: { id: 1 } });
    savedSmallEq = await prisma.equipmentConfig.findUnique({ where: { id: 'pegboard_s' } });

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
      name: 'R26 Access Layout',
      effectiveFrom: '2020-01-01',
      effectiveDate: selfDateStr,
      codePrefix: 'K',
      seatCount: 16
    });

    await prisma.kioskSetting.upsert({
      where: { id: 1 },
      update: { early_minutes: 30, after_close_minutes: 60, prepay_deadline_hour: 12, max_unpaid_self_bookings: 10 },
      create: { id: 1, early_minutes: 30, after_close_minutes: 60, prepay_deadline_hour: 12, max_unpaid_self_bookings: 10 }
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

    createdMethodCode = 'r26_item3_bank';
    await prisma.paymentMethodConfig.upsert({
      where: { code: createdMethodCode },
      update: { is_enabled: true, method_type: 'STATIC_BANK' },
      create: {
        code: createdMethodCode,
        name: 'R26測試轉帳',
        method_type: 'STATIC_BANK',
        is_enabled: true,
        sort_order: 2,
        bank_accounts_json: [{ bank_name: '台新銀行', bank_code: '812', account: '2001003001' }]
      }
    });

    await prisma.equipmentConfig.update({
      where: { id: 'pegboard_s' },
      data: {
        visibility_status: 'ACTIVE',
        hourly_rate: 100,
        daily_cap: 300,
        total_stock: 10,
        self_enabled: true,
        self_hourly_rate: 80,
        self_daily_cap: 240,
        self_stock: 5
      }
    });

    device = await prisma.kioskDevice.create({
      data: {
        name: 'R26 Access Device',
        key_wrapped: wrapPairKey(crypto.randomBytes(32), process.env.JWT_SECRET),
        is_active: true,
        paired_at: tOpen
      }
    });

    const userMain = await prisma.user.upsert({
      where: { line_user_id: 'r26_access_user1' },
      update: { name: 'R26測試一號', phone: '0912000261', is_blacklisted: false },
      create: { line_user_id: 'r26_access_user1', name: 'R26測試一號', phone: '0912000261' }
    });
    const userWait = await prisma.user.upsert({
      where: { line_user_id: 'r26_access_user2' },
      update: { name: 'R26候位測試', phone: '0912000262', is_blacklisted: false },
      create: { line_user_id: 'r26_access_user2', name: 'R26候位測試', phone: '0912000262' }
    });
    const userStaffPaid = await prisma.user.upsert({
      where: { line_user_id: 'r26_access_user3' },
      update: { name: 'R26店員收款', phone: '0912000263', is_blacklisted: false },
      create: { line_user_id: 'r26_access_user3', name: 'R26店員收款', phone: '0912000263' }
    });
    const userStaffCheckin = await prisma.user.upsert({
      where: { line_user_id: 'r26_access_user4' },
      update: { name: 'R26店員已報到', phone: '0912000264', is_blacklisted: false },
      create: { line_user_id: 'r26_access_user4', name: 'R26店員已報到', phone: '0912000264' }
    });

    for (const u of [userMain, userWait, userStaffPaid, userStaffCheckin]) {
      await prisma.bookingPrepay.deleteMany({ where: { user_id: u.id } });
    }

    const plan = await prisma.passPlan.upsert({
      where: { code: 'r26_item3_punch' },
      update: { pass_type: 'PUNCH_CARD', checkout_effect: 'entry_full', is_active: true },
      create: {
        code: 'r26_item3_punch',
        name: 'R26測試九宮格卡',
        pass_type: 'PUNCH_CARD',
        price: 3000,
        total_quota: 5,
        checkout_effect: 'entry_full',
        day_restriction: 'ALL',
        is_active: true
      }
    });
    createdPlanIds.push(plan.id);

    const pass = await prisma.userPass.create({
      data: {
        pass_code: `PASS-R26-3-${Date.now()}`,
        user_id: userMain.id,
        plan_id: plan.id,
        plan_name_snapshot: plan.name,
        pass_type: 'PUNCH_CARD',
        remaining_quota: 5,
        total_quota: 5,
        status: 'ACTIVE',
        payment_status: 'active',
        day_restriction: 'ALL'
      }
    });

    await prisma.dailySetting.createMany({
      data: [
        {
          date: selfDate,
          allow_unlimited: true,
          hourly_price: 150,
          unlimited_price: 750,
          is_self_service: true,
          self_allow_hourly: false,
          self_allow_equipment: true,
          iron_mode: 'today'
        },
        {
          date: normalDate,
          allow_unlimited: true,
          hourly_price: 150,
          unlimited_price: 750,
          is_self_service: false
        }
      ]
    });

    const selfSessions = await Promise.all([
      prisma.session.create({ data: { session_date: selfDate, start_time: '13:00', end_time: '14:00', max_capacity: 40 } }),
      prisma.session.create({ data: { session_date: selfDate, start_time: '14:00', end_time: '15:00', max_capacity: 40 } }),
      prisma.session.create({ data: { session_date: selfDate, start_time: '20:00', end_time: '21:00', max_capacity: 40 } })
    ]);
    const bookingSessions = [selfSessions[0].id, selfSessions[1].id];

    const normalSessions = await Promise.all([
      prisma.session.create({ data: { session_date: normalDate, start_time: '13:00', end_time: '14:00', max_capacity: 20 } })
    ]);

    let lineCalls = 0;
    const spyNotify = async () => { lineCalls++; };
    const qrKey = qrKeyFrom(process.env.JWT_SECRET);

    // 1. NORMAL_DAY
    {
      const r = await processKioskAccess(prisma, {
        device,
        method: 'phone',
        payload: userMain.phone,
        now: tNormal,
        notifyFn: spyNotify
      });
      assert.equal(r.result, 'NORMAL_DAY');
      assert.equal(r.open_door, false);
    }

    // 2. Bad formats + missing booking -> NOT_FOUND
    for (const bad of [
      { method: 'phone', payload: '0812345678' },
      { method: 'phone', payload: '0999888777' },
      { method: 'qr', payload: 'NOT-A-VALID-QR' },
      { method: 'qr', payload: 'SG1-0000000000-AAAAAAAA' }
    ]) {
      const r = await processKioskAccess(prisma, { device, ...bad, now: tOpen, notifyFn: spyNotify });
      assert.equal(r.result, 'NOT_FOUND');
      assert.equal(r.open_door, false);
    }

    // Create Booking 1: hybrid (2 pax: 1 pass + 1 transfer + 2 smart boards), pending -> report -> verify
    const rCreate1 = createMockRes();
    await createReservation(makeCustomerReq(userMain, {
      body: {
        session_ids: bookingSessions,
        pax: 2,
        isUnlimited: true,
        equipments: [{ equipment_id: 'pegboard_s', quantity: 2, rental_hours: 2, start_time: '13:00' }],
        self_service_ack: true,
        prepay: {
          pass_uses: [{ user_pass_id: pass.id, persons: 1 }],
          transfer: { payment_method_code: createdMethodCode },
          expected_transfer_amount: 1070 // 750 entry + 2*(80*2=160) boards = 1070
        }
      }
    }), rCreate1);
    assert.equal(rCreate1.statusCode, 201, JSON.stringify(rCreate1.body));
    const ref1 = rCreate1.body.reservation.booking_ref;
    createdRefs.push(ref1);

    const billBefore = await getBookingBill(ref1);

    // Reported last5, before admin verify -> UNVERIFIED
    const rLast5 = createMockRes();
    await patchRemittanceLast5Handler(makeCustomerReq(userMain, {
      params: { booking_ref: ref1 },
      body: { remittance_last5: '12345' }
    }), rLast5);
    assert.equal(rLast5.statusCode, 200);

    const resUnverified = await processKioskAccess(prisma, {
      device,
      method: 'phone',
      payload: userMain.phone,
      now: tOpen,
      notifyFn: spyNotify
    });
    assert.equal(resUnverified.result, 'UNVERIFIED');
    assert.equal(resUnverified.open_door, false);

    // Verify payment by admin
    const rVerify1 = createMockRes();
    await verifyAdminPrepayHandler(makeAdminReq({ params: { booking_ref: ref1 } }), rVerify1);
    assert.equal(rVerify1.statusCode, 200);

    // QR checks: 2 windows ago -> QR_EXPIRED, another booking's MAC -> QR_EXPIRED
    const openUnix = Math.floor(tOpen.getTime() / 1000);
    const staleQr = qrCodeFor(qrKey, ref1, openUnix - 600);
    const rExpired = await processKioskAccess(prisma, {
      device, method: 'qr', payload: staleQr.code, now: tOpen, notifyFn: spyNotify
    });
    assert.equal(rExpired.result, 'QR_EXPIRED');
    assert.equal(rExpired.open_door, false);

    const otherMac = qrCodeFor(qrKey, crypto.randomUUID(), openUnix).code.split('-')[2];
    const forgedPrefixQr = `SG1-${qrCodeFor(qrKey, ref1, openUnix).code.split('-')[1]}-${otherMac}`;
    const rForgedMac = await processKioskAccess(prisma, {
      device, method: 'qr', payload: forgedPrefixQr, now: tOpen, notifyFn: spyNotify
    });
    assert.equal(rForgedMac.result, 'QR_EXPIRED');
    assert.equal(rForgedMac.open_door, false);

    // 3. TOO_EARLY
    const curQr = qrCodeFor(qrKey, ref1, Math.floor(tEarly.getTime() / 1000));
    const rTooEarly = await processKioskAccess(prisma, {
      device, method: 'qr', payload: curQr.code, now: tEarly, notifyFn: spyNotify
    });
    assert.equal(rTooEarly.result, 'TOO_EARLY');
    assert.equal(rTooEarly.open_door, false);
    assert.equal(rTooEarly.booking.open_at, '12:30');

    // 4. ENDED (> 21:00 + 60m = 22:00)
    const endedQr = qrCodeFor(qrKey, ref1, Math.floor(tEnded.getTime() / 1000));
    const rEnded = await processKioskAccess(prisma, {
      device, method: 'qr', payload: endedQr.code, now: tEnded, notifyFn: spyNotify
    });
    assert.equal(rEnded.result, 'ENDED');
    assert.equal(rEnded.open_door, false);

    // 5. Concurrent access x2 -> exactly 1 FIRST_CHECKIN & 1 RE_ENTRY, LINE notify called ONLY once
    const prevWinQr = qrCodeFor(qrKey, ref1, openUnix - 300);
    const [concA, concB] = await Promise.all([
      processKioskAccess(prisma, { device, method: 'qr', payload: prevWinQr.code, now: tOpen, notifyFn: spyNotify }),
      processKioskAccess(prisma, { device, method: 'phone', payload: userMain.phone, now: tOpen, notifyFn: spyNotify })
    ]);
    const resultsSorted = [concA.result, concB.result].sort();
    assert.deepEqual(resultsSorted, ['FIRST_CHECKIN', 'RE_ENTRY']);
    assert.equal(concA.open_door, true);
    assert.equal(concB.open_door, true);
    assert.equal(lineCalls, 1, 'First check-in notification must fire once only');

    // Verify DB records + split boards + unchanged bill
    const dbRes1 = await prisma.reservation.findFirst({ where: { booking_ref: ref1 } });
    assert.equal(dbRes1.attendance, 'checked_in');
    assert.equal(dbRes1.is_seat_locked, true);
    assert.equal(dbRes1.checked_in_by, '報到機');
    const persons1 = await prisma.bookingPerson.findMany({ where: { booking_ref: ref1 }, orderBy: { person_no: 'asc' } });
    assert.equal(persons1.length, 2);
    assert.equal(persons1[0].seat_code, dbRes1.assigned_seats[0]);
    assert.equal(persons1[1].seat_code, dbRes1.assigned_seats[1]);
    assert.equal(persons1[0].timer_started_at, null);

    const splitEqRows = await prisma.bookingEquipment.findMany({ where: { booking_ref: ref1 } });
    assert.equal(splitEqRows.length, 2, 'Smart boards qty 2 split into 2 rows');
    const billAfter = await getBookingBill(ref1);
    assert.equal(billAfter.bill.summary.amount_due, billBefore.bill.summary.amount_due);

    // Ensure another booking created afterward cannot displace ref1's locked seats
    const rConcurrentBooker = createMockRes();
    await createReservation(makeCustomerReq(userWait, {
      body: {
        session_ids: bookingSessions,
        pax: 2,
        isUnlimited: true,
        self_service_ack: true,
        prepay: {
          pass_uses: [],
          transfer: { payment_method_code: createdMethodCode },
          expected_transfer_amount: 1500
        }
      }
    }), rConcurrentBooker);
    assert.equal(rConcurrentBooker.statusCode, 201);
    createdRefs.push(rConcurrentBooker.body.reservation.booking_ref);
    const dbRes1Reloaded = await prisma.reservation.findFirst({ where: { booking_ref: ref1 } });
    assert.deepEqual(dbRes1Reloaded.assigned_seats, dbRes1.assigned_seats);

    // 6. Waitlist WAIT- booking -> gets real seat if available; if completely full still opens with seats=[]
    const waitRefFree = crypto.randomUUID();
    createdRefs.push(waitRefFree);
    for (const sid of bookingSessions) {
      await prisma.reservation.create({
        data: {
          booking_ref: waitRefFree,
          user_id: userWait.id,
          session_id: sid,
          pax: 1,
          assigned_seats: ['WAIT-1'],
          status: 'confirmed',
          billing_status: 'paid',
          is_paid: true,
          is_self_service: true,
          is_unlimited: true,
          total_amount: 750
        }
      });
    }
    const rWaitFree = await processKioskAccess(prisma, {
      device,
      method: 'qr',
      payload: qrCodeFor(qrKey, waitRefFree, openUnix).code,
      now: tOpen,
      notifyFn: spyNotify
    });
    assert.equal(rWaitFree.result, 'FIRST_CHECKIN');
    assert.equal(rWaitFree.open_door, true);
    assert.equal(rWaitFree.booking.seats.length, 1);
    assert.ok(!rWaitFree.booking.seats[0].startsWith('WAIT-'));

    // Occupy ALL active seats on the active layout in selfSessions[2] (20:00), then check in WAIT-99 -> seats = []
    const blockerRef = crypto.randomUUID();
    createdRefs.push(blockerRef);
    const activeLayoutForSelf = await getActiveLayoutForDate(prisma, selfDate);
    const allSeats = activeLayoutForSelf.seats.filter((s) => s.is_active).map((s) => s.code);
    await prisma.reservation.create({
      data: {
        booking_ref: blockerRef,
        user_id: userMain.id,
        session_id: selfSessions[2].id,
        pax: allSeats.length,
        assigned_seats: allSeats,
        status: 'confirmed',
        is_seat_locked: true,
        is_self_service: true
      }
    });
    const waitRefFull = crypto.randomUUID();
    createdRefs.push(waitRefFull);
    await prisma.reservation.create({
      data: {
        booking_ref: waitRefFull,
        user_id: userWait.id,
        session_id: selfSessions[2].id,
        pax: 1,
        assigned_seats: ['WAIT-99'],
        status: 'confirmed',
        billing_status: 'paid',
        is_paid: true,
        is_self_service: true,
        is_unlimited: true,
        total_amount: 750
      }
    });
    const t20Open = new Date(`${selfDateStr}T19:40:00.000+08:00`);
    const t20Unix = Math.floor(t20Open.getTime() / 1000);
    const rWaitFull = await processKioskAccess(prisma, {
      device,
      method: 'qr',
      payload: qrCodeFor(qrKey, waitRefFull, t20Unix).code,
      now: t20Open,
      notifyFn: spyNotify
    });
    assert.equal(rWaitFull.result, 'FIRST_CHECKIN');
    assert.equal(rWaitFull.open_door, true);
    assert.deepEqual(rWaitFull.booking.seats, []);

    // 7. Staff-created & paid reservation without BookingPrepay -> phone access succeeds
    const freeTailSeatA = allSeats[allSeats.length - 2];
    const freeTailSeatB = allSeats[allSeats.length - 1];
    const staffPaidRef = crypto.randomUUID();
    createdRefs.push(staffPaidRef);
    for (const sid of bookingSessions) {
      await prisma.reservation.create({
        data: {
          booking_ref: staffPaidRef,
          user_id: userStaffPaid.id,
          session_id: sid,
          pax: 1,
          assigned_seats: [freeTailSeatA],
          status: 'confirmed',
          billing_status: 'paid',
          is_paid: true,
          is_self_service: true,
          total_amount: 750
        }
      });
    }
    const rStaffPaid = await processKioskAccess(prisma, {
      device, method: 'phone', payload: userStaffPaid.phone, now: tOpen, notifyFn: spyNotify
    });
    assert.equal(rStaffPaid.result, 'FIRST_CHECKIN');
    assert.equal(rStaffPaid.open_door, true);

    // 8. Staff already checked in on floor -> kiosk returns RE_ENTRY and does NOT push LINE
    const staffCiRef = crypto.randomUUID();
    createdRefs.push(staffCiRef);
    for (const sid of bookingSessions) {
      await prisma.reservation.create({
        data: {
          booking_ref: staffCiRef,
          user_id: userStaffCheckin.id,
          session_id: sid,
          pax: 1,
          assigned_seats: [freeTailSeatB],
          status: 'confirmed',
          billing_status: 'paid',
          is_paid: true,
          is_self_service: true,
          total_amount: 750
        }
      });
    }
    const floorCiRes = createMockRes();
    await checkIn({
      params: { booking_ref: staffCiRef },
      body: { seats: [freeTailSeatB], start_timer: false },
      user: { id: 1, name: '櫃檯店員', role: 'admin' },
      headers: { 'x-device-label': 'POS測試' }
    }, floorCiRes);
    assert.equal(floorCiRes.statusCode, 200);

    const callsBeforeStaffReentry = lineCalls;
    const rKioskAfterFloor = await processKioskAccess(prisma, {
      device, method: 'phone', payload: userStaffCheckin.phone, now: tOpen, notifyFn: spyNotify
    });
    assert.equal(rKioskAfterFloor.result, 'RE_ENTRY');
    assert.equal(rKioskAfterFloor.open_door, true);
    assert.equal(lineCalls, callsBeforeStaffReentry);

    // Verify access log rows exist
    const logRows = await prisma.kioskAccessLog.findMany({ where: { device_id: device.id } });
    assert.ok(logRows.length >= 10);
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
    if (createdPlanIds.length) {
      await prisma.userPass.deleteMany({ where: { plan_id: { in: createdPlanIds } } });
      await prisma.passPlan.deleteMany({ where: { id: { in: createdPlanIds } } });
    }
    if (createdMethodCode) {
      await prisma.paymentMethodConfig.deleteMany({ where: { code: createdMethodCode } });
    }
    if (device?.id) {
      await prisma.kioskAccessLog.deleteMany({ where: { device_id: device.id } });
      await prisma.kioskDevice.deleteMany({ where: { id: device.id } });
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
