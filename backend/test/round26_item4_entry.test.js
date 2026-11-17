import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import prisma from '../src/prismaClient.js';
import { dateOnly } from '../../shared/time.js';
import { ensureTestPublishedLayout, cleanupTestPublishedLayout } from './helpers/seedTestLayout.js';
import { ensureDefaultEquipmentConfigs } from '../src/controllers/equipmentController.js';
import { createReservation } from '../src/controllers/reservationController.js';
import { patchRemittanceLast5Handler, verifyAdminPrepayHandler } from '../src/controllers/prepayController.js';
import { getReservationEntryPass } from '../src/services/kiosk/entryService.js';
import { processKioskAccess } from '../src/services/kiosk/accessService.js';
import { wrapPairKey } from '../src/services/kiosk/sgk1.js';

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

test('Round 26 Item 4: Customer Entry API returns all 8 states, 403 on non-owner, and QR code unlocks door', async () => {
  const selfDateStr = '2099-10-15';
  const selfDate = dateOnly(selfDateStr);
  const testDates = [selfDate];

  const tEarly = new Date(`${selfDateStr}T12:15:00.000+08:00`);
  const tOpen = new Date(`${selfDateStr}T12:45:00.000+08:00`);
  const tEnded = new Date(`${selfDateStr}T22:05:00.000+08:00`);

  let savedKiosk = null;
  let createdLayoutId = null;
  let createdMethodCode = null;
  let device = null;
  const createdPlanIds = [];
  const createdRefs = [];

  try {
    await ensureDefaultEquipmentConfigs();
    savedKiosk = await prisma.kioskSetting.findUnique({ where: { id: 1 } });
    await prisma.kioskSetting.upsert({
      where: { id: 1 },
      update: { early_minutes: 30, after_close_minutes: 60, prepay_deadline_hour: 12, max_unpaid_self_bookings: 10 },
      create: { id: 1, early_minutes: 30, after_close_minutes: 60, prepay_deadline_hour: 12, max_unpaid_self_bookings: 10 }
    });

    // 清理測試日期既有時段與預約
    const oldSess = await prisma.session.findMany({ where: { session_date: { in: testDates } }, select: { id: true } });
    const oldSessIds = oldSess.map((s) => s.id);
    if (oldSessIds.length) {
      const oldRes = await prisma.reservation.findMany({ where: { session_id: { in: oldSessIds } }, select: { booking_ref: true } });
      const oldRefs = [...new Set(oldRes.map((r) => r.booking_ref))];
      if (oldRefs.length) {
        await prisma.kioskAccessLog.deleteMany({ where: { booking_ref: { in: oldRefs } } });
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
      name: 'R26 Entry Layout',
      effectiveFrom: '2020-01-01',
      effectiveDate: selfDateStr,
      codePrefix: 'K',
      seatCount: 16
    });

    // 建立半自助日設定與時段 13:00~21:00
    await prisma.dailySetting.upsert({
      where: { date: selfDate },
      update: {
        is_self_service: true,
        iron_mode: 'today',
        iron_date: null
      },
      create: {
        date: selfDate,
        is_self_service: true,
        iron_mode: 'today',
        iron_date: null
      }
    });

    const s1 = await prisma.session.create({
      data: {
        session_date: selfDate,
        start_time: '13:00',
        end_time: '14:00',
        max_capacity: 16
      }
    });
    const s2 = await prisma.session.create({
      data: {
        session_date: selfDate,
        start_time: '20:00',
        end_time: '21:00',
        max_capacity: 16
      }
    });

    // 取得或建立轉帳付款方式
    createdMethodCode = 'r26_item4_bank';
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

    // 建立兩個測試會員
    const userA = await prisma.user.upsert({
      where: { line_user_id: 'r26_item4_userA' },
      update: { name: '會員小甲', phone: '0988000001' },
      create: { line_user_id: 'r26_item4_userA', phone: '0988000001', name: '會員小甲' }
    });
    const userB = await prisma.user.upsert({
      where: { line_user_id: 'r26_item4_userB' },
      update: { name: '會員小乙', phone: '0988000002' },
      create: { line_user_id: 'r26_item4_userB', phone: '0988000002', name: '會員小乙' }
    });

    // 建立測試報到機裝置
    const pairKey = crypto.randomBytes(32);
    device = await prisma.kioskDevice.create({
      data: {
        name: '門口測試機-條碼測試',
        key_wrapped: wrapPairKey(pairKey),
        is_active: true
      }
    });

    // 建立一筆半自助預約的 helper
    const bookSelfReservation = async (user, { pax = 1 } = {}) => {
      const resMock = createMockRes();
      await createReservation(
        makeCustomerReq(user, {
          body: {
            session_ids: [s1.id],
            pax,
            isUnlimited: true,
            self_service_ack: true,
            prepay: {
              transfer: { payment_method_code: createdMethodCode },
              expected_transfer_amount: 750 * pax
            }
          }
        }),
        resMock
      );
      assert.equal(resMock.statusCode, 201, `Failed to book: ${JSON.stringify(resMock.body)}`);
      const ref = resMock.body.reservation.booking_ref;
      createdRefs.push(ref);
      return ref;
    };

    // 1. 測試 unpaid: 預約剛建立未匯款
    const refUnpaid = await bookSelfReservation(userA, { pax: 1 });
    const passUnpaid = await getReservationEntryPass(prisma, {
      bookingRef: refUnpaid,
      userId: userA.id,
      now: tOpen
    });
    assert.equal(passUnpaid.state, 'unpaid');
    assert.equal(passUnpaid.code, null);
    assert.equal(passUnpaid.code_expires_at, null);
    assert.equal(passUnpaid.start, '13:00');
    assert.equal(passUnpaid.open_at, '12:30');
    assert.equal(passUnpaid.until, '21:00');
    assert.ok(passUnpaid.server_now);

    // 2. 測試 reported: 會員回報末五碼
    const refReported = await bookSelfReservation(userA, { pax: 1 });
    const repRes = createMockRes();
    await patchRemittanceLast5Handler(
      makeCustomerReq(userA, {
        params: { booking_ref: refReported },
        body: { remittance_last5: '54321' }
      }),
      repRes
    );
    assert.equal(repRes.statusCode, 200, `repRes failed: ${JSON.stringify(repRes.body)}`);
    const passReported = await getReservationEntryPass(prisma, {
      bookingRef: refReported,
      userId: userA.id,
      now: tOpen
    });
    assert.equal(passReported.state, 'reported');
    assert.equal(passReported.code, null);

    // 3. 測試 mismatch: 管理員標記金額不符
    const refMismatch = await bookSelfReservation(userA, { pax: 1 });
    await prisma.bookingPrepay.update({
      where: { booking_ref: refMismatch },
      data: { status: 'mismatch' }
    });
    const passMismatch = await getReservationEntryPass(prisma, {
      bookingRef: refMismatch,
      userId: userA.id,
      now: tOpen
    });
    assert.equal(passMismatch.state, 'mismatch');
    assert.equal(passMismatch.code, null);

    // 4. 測試 confirmed: 已對帳完成，但現在早於 12:30（如 12:15）
    const refConfirmed = await bookSelfReservation(userA, { pax: 2 });
    await patchRemittanceLast5Handler(
      makeCustomerReq(userA, {
        params: { booking_ref: refConfirmed },
        body: { remittance_last5: '12345' }
      }),
      createMockRes()
    );
    await verifyAdminPrepayHandler(
      makeAdminReq({ params: { booking_ref: refConfirmed } }),
      createMockRes()
    );
    const passConfirmed = await getReservationEntryPass(prisma, {
      bookingRef: refConfirmed,
      userId: userA.id,
      now: tEarly
    });
    assert.equal(passConfirmed.state, 'confirmed');
    assert.equal(passConfirmed.code, null);
    assert.equal(passConfirmed.open_at, '12:30');
    assert.equal(passConfirmed.start, '13:00');

    // 5. 測試 open: 已對帳完成且時間已達 12:45，尚未報到
    const passOpen = await getReservationEntryPass(prisma, {
      bookingRef: refConfirmed,
      userId: userA.id,
      now: tOpen
    });
    assert.equal(passOpen.state, 'open');
    assert.ok(passOpen.code && passOpen.code.startsWith('SG1-'));
    assert.ok(Number.isInteger(passOpen.code_expires_at));
    assert.ok(Array.isArray(passOpen.seats));
    assert.ok(typeof passOpen.zone === 'string');
    assert.ok(passOpen.iron_text.length > 0);

    // 驗證 code 格式及使用 processKioskAccess 掃描能否成功開門 (FIRST_CHECKIN)
    const scanOutcome = await processKioskAccess(prisma, {
      device,
      method: 'qr',
      payload: passOpen.code,
      now: tOpen
    });
    assert.equal(scanOutcome.result, 'FIRST_CHECKIN');
    assert.equal(scanOutcome.open_door, true);

    // 6. 測試 in: 已完成報到（checked_in_at 有值）
    const passIn = await getReservationEntryPass(prisma, {
      bookingRef: refConfirmed,
      userId: userA.id,
      now: tOpen
    });
    assert.equal(passIn.state, 'in');
    assert.ok(passIn.first_checkin_at);
    assert.ok(passIn.seats.length > 0, 'Checked-in pass should have seats assigned');
    assert.ok(passIn.code && passIn.code.startsWith('SG1-'));
    assert.ok(Number.isInteger(passIn.code_expires_at));

    // 7. 測試 ended: 已超過打烊寬限時間（如 22:05）
    const passEnded = await getReservationEntryPass(prisma, {
      bookingRef: refConfirmed,
      userId: userA.id,
      now: tEnded
    });
    assert.equal(passEnded.state, 'ended');
    assert.equal(passEnded.code, null);

    // 8. 測試 cancelled: 預約被取消
    const refCancelled = await bookSelfReservation(userA, { pax: 1 });
    await prisma.reservation.updateMany({
      where: { booking_ref: refCancelled },
      data: { status: 'cancelled' }
    });
    const passCancelled = await getReservationEntryPass(prisma, {
      bookingRef: refCancelled,
      userId: userA.id,
      now: tOpen
    });
    assert.equal(passCancelled.state, 'cancelled');
    assert.equal(passCancelled.code, null);
    assert.deepEqual(passCancelled.seats, []);

    // 9. 測試非本人呼叫回傳 403 (FORBIDDEN)
    await assert.rejects(
      async () => {
        await getReservationEntryPass(prisma, {
          bookingRef: refConfirmed,
          userId: userB.id,
          now: tOpen
        });
      },
      (err) => err.statusCode === 403 && err.message === 'FORBIDDEN'
    );

    // 10. 測試查無預約回傳 404 (RESERVATION_NOT_FOUND)
    await assert.rejects(
      async () => {
        await getReservationEntryPass(prisma, {
          bookingRef: '00000000-0000-0000-0000-000000000000',
          userId: userA.id,
          now: tOpen
        });
      },
      (err) => err.statusCode === 404 && err.message === 'RESERVATION_NOT_FOUND'
    );

    console.log('Round 26 Item 4 Entry API unit test passed successfully!');
  } finally {
    if (device) {
      await prisma.kioskAccessLog.deleteMany({ where: { device_id: device.id } });
      await prisma.kioskDevice.delete({ where: { id: device.id } }).catch(() => {});
    }
    if (createdRefs.length > 0) {
      await prisma.kioskAccessLog.deleteMany({ where: { booking_ref: { in: createdRefs } } });
      await prisma.payment.deleteMany({ where: { booking_ref: { in: createdRefs } } });
      await prisma.bookingPerson.deleteMany({ where: { booking_ref: { in: createdRefs } } });
      await prisma.bookingEquipment.deleteMany({ where: { booking_ref: { in: createdRefs } } });
      await prisma.bookingPrepay.deleteMany({ where: { booking_ref: { in: createdRefs } } });
      await prisma.reservation.deleteMany({ where: { booking_ref: { in: createdRefs } } });
    }
    await prisma.session.deleteMany({ where: { session_date: { in: testDates } } });
    await prisma.dailySetting.deleteMany({ where: { date: { in: testDates } } });
    for (const pid of createdPlanIds) {
      await prisma.reservationPricingPlan.delete({ where: { id: pid } }).catch(() => {});
    }
    if (createdMethodCode) {
      await prisma.paymentMethodConfig.deleteMany({ where: { code: createdMethodCode } }).catch(() => {});
    }
    if (createdLayoutId) {
      await cleanupTestPublishedLayout(prisma, createdLayoutId);
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
      }).catch(() => {});
    } else {
      await prisma.kioskSetting.delete({ where: { id: 1 } }).catch(() => {});
    }
  }
});
