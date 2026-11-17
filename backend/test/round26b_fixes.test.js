import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import prisma from '../src/prismaClient.js';
import { dateOnly } from '../../shared/time.js';
import { ensureTestPublishedLayout, cleanupTestPublishedLayout } from './helpers/seedTestLayout.js';
import { processKioskSync } from '../src/services/kiosk/syncService.js';
import { wrapPairKey, qrKeyFrom, qrCodeFor } from '../src/services/kiosk/sgk1.js';
import { processKioskAccess } from '../src/services/kiosk/accessService.js';

test('Round 26b Item 1: backup_open events handle unknown at (null, 0, negative, omitted) and valid timestamp', async () => {
  const fixedNow = new Date('2099-10-20T14:30:00.000+08:00');
  let device = null;
  let savedKiosk = null;

  try {
    savedKiosk = await prisma.kioskSetting.findUnique({ where: { id: 1 } });
    await prisma.kioskSetting.upsert({
      where: { id: 1 },
      update: { early_minutes: 30, after_close_minutes: 60, prepay_deadline_hour: 12, max_unpaid_self_bookings: 2 },
      create: { id: 1, early_minutes: 30, after_close_minutes: 60, prepay_deadline_hour: 12, max_unpaid_self_bookings: 2 }
    });

    device = await prisma.kioskDevice.create({
      data: {
        name: 'R26b Test Device',
        key_wrapped: wrapPairKey(crypto.randomBytes(32), process.env.JWT_SECRET),
        is_active: true,
        paired_at: fixedNow
      }
    });

    // 1. at 分別是 null、0、-5、缺欄位 (undefined)
    const unknownEvents = [
      { id: 'ev-null', type: 'backup_open', at: null, offline: false },
      { id: 'ev-zero', type: 'backup_open', at: 0, offline: true },
      { id: 'ev-neg', type: 'backup_open', at: -5, offline: true },
      { id: 'ev-missing', type: 'backup_open', offline: false }
    ];

    const syncRes1 = await processKioskSync(prisma, {
      device,
      body: { events: unknownEvents },
      clientIp: '127.0.0.1',
      now: fixedNow
    });

    assert.deepEqual(syncRes1.ack_event_ids.sort(), ['ev-missing', 'ev-neg', 'ev-null', 'ev-zero'].sort());

    const logsUnknown = await prisma.kioskAccessLog.findMany({
      where: { device_id: device.id, event_id: { in: ['ev-null', 'ev-zero', 'ev-neg', 'ev-missing'] } }
    });
    assert.equal(logsUnknown.length, 4);

    for (const log of logsUnknown) {
      assert.equal(log.at_unknown, true, `Expected at_unknown=true for event ${log.event_id}`);
      assert.equal(log.at.getTime(), fixedNow.getTime(), `Expected at to equal received time for event ${log.event_id}`);
      assert.equal(log.result, 'BACKUP_OPEN');
      assert.equal(log.open_door, true);
      assert.equal(log.method, 'backup_code');
    }

    // 重送同批事件：不應新增重複紀錄
    const syncResDup = await processKioskSync(prisma, {
      device,
      body: { events: unknownEvents },
      clientIp: '127.0.0.1',
      now: new Date(fixedNow.getTime() + 10000)
    });
    assert.deepEqual(syncResDup.ack_event_ids.sort(), ['ev-missing', 'ev-neg', 'ev-null', 'ev-zero'].sort());

    const countAfterDup = await prisma.kioskAccessLog.count({
      where: { device_id: device.id, event_id: { in: ['ev-null', 'ev-zero', 'ev-neg', 'ev-missing'] } }
    });
    assert.equal(countAfterDup, 4, 'Duplicate events must not create extra rows');

    // 2. at 是正常秒數
    const normalSec = 1795000000;
    const normalEvent = [{ id: 'ev-normal', type: 'backup_open', at: normalSec, offline: false }];

    const syncRes2 = await processKioskSync(prisma, {
      device,
      body: { events: normalEvent },
      clientIp: '127.0.0.1',
      now: fixedNow
    });
    assert.deepEqual(syncRes2.ack_event_ids, ['ev-normal']);

    const normalLog = await prisma.kioskAccessLog.findUnique({
      where: { device_id_event_id: { device_id: device.id, event_id: 'ev-normal' } }
    });
    assert.ok(normalLog);
    assert.equal(normalLog.at_unknown, false);
    assert.equal(normalLog.at.getTime(), normalSec * 1000);
  } finally {
    if (device) {
      await prisma.kioskAccessLog.deleteMany({ where: { device_id: device.id } });
      await prisma.kioskDevice.delete({ where: { id: device.id } }).catch(() => {});
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

test('Round 26b Item 2: pad_locked events record PAD_LOCKED in KioskAccessLog with keypad method and dedup', async () => {
  const fixedNow = new Date('2099-10-20T15:00:00.000+08:00');
  let device = null;
  let savedKiosk = null;

  try {
    savedKiosk = await prisma.kioskSetting.findUnique({ where: { id: 1 } });
    await prisma.kioskSetting.upsert({
      where: { id: 1 },
      update: { early_minutes: 30, after_close_minutes: 60, prepay_deadline_hour: 12, max_unpaid_self_bookings: 2 },
      create: { id: 1, early_minutes: 30, after_close_minutes: 60, prepay_deadline_hour: 12, max_unpaid_self_bookings: 2 }
    });

    device = await prisma.kioskDevice.create({
      data: {
        name: 'R26b Test PadLocked Device',
        key_wrapped: wrapPairKey(crypto.randomBytes(32), process.env.JWT_SECRET),
        is_active: true,
        paired_at: fixedNow
      }
    });

    const lockEvent = [{ id: 'ev-pad-lock-1', type: 'pad_locked', at: null, offline: false }];

    // 送一筆 pad_locked
    const syncRes1 = await processKioskSync(prisma, {
      device,
      body: { events: lockEvent },
      clientIp: '127.0.0.1',
      now: fixedNow
    });

    assert.ok(syncRes1.ack_event_ids.includes('ev-pad-lock-1'), 'ack_event_ids must include ev-pad-lock-1');

    const log = await prisma.kioskAccessLog.findUnique({
      where: { device_id_event_id: { device_id: device.id, event_id: 'ev-pad-lock-1' } }
    });
    assert.ok(log, 'Access log must exist for pad_locked');
    assert.equal(log.method, 'keypad');
    assert.equal(log.result, 'PAD_LOCKED');
    assert.equal(log.open_door, false);
    assert.equal(log.at_unknown, true);
    assert.equal(log.at.getTime(), fixedNow.getTime());

    // 同一個事件編號再送一次不會多一筆
    const syncRes2 = await processKioskSync(prisma, {
      device,
      body: { events: lockEvent },
      clientIp: '127.0.0.1',
      now: new Date(fixedNow.getTime() + 5000)
    });
    assert.ok(syncRes2.ack_event_ids.includes('ev-pad-lock-1'), 'ack_event_ids must include ev-pad-lock-1 on resend');

    const count = await prisma.kioskAccessLog.count({
      where: { device_id: device.id, event_id: 'ev-pad-lock-1' }
    });
    assert.equal(count, 1, 'Duplicate event must not create extra rows');
  } finally {
    if (device) {
      await prisma.kioskAccessLog.deleteMany({ where: { device_id: device.id } });
      await prisma.kioskDevice.delete({ where: { id: device.id } }).catch(() => {});
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

test('Round 26b Item 3 Test 1: reseat failure rolls back to savepoint and does not displace other bookings', async () => {
  const selfDateStr = '2099-10-21';
  const selfDate = dateOnly(selfDateStr);
  const tOpen = new Date(`${selfDateStr}T13:30:00.000+08:00`);

  let savedKiosk = null;
  let createdLayoutId = null;
  let device = null;
  let session = null;
  const createdRefs = [];

  const refOther = crypto.randomUUID();
  const refWait = crypto.randomUUID();
  createdRefs.push(refOther, refWait);

  try {
    savedKiosk = await prisma.kioskSetting.findUnique({ where: { id: 1 } });
    await prisma.kioskSetting.upsert({
      where: { id: 1 },
      update: { early_minutes: 30, after_close_minutes: 60, prepay_deadline_hour: 12, max_unpaid_self_bookings: 10 },
      create: { id: 1, early_minutes: 30, after_close_minutes: 60, prepay_deadline_hour: 12, max_unpaid_self_bookings: 10 }
    });

    createdLayoutId = await ensureTestPublishedLayout(prisma, {
      name: 'R26b Item3 Layout',
      effectiveFrom: '2020-01-01',
      effectiveDate: selfDateStr,
      codePrefix: 'K',
      seatCount: 10
    });

    await prisma.dailySetting.deleteMany({ where: { date: selfDate } });
    await prisma.dailySetting.create({
      data: {
        date: selfDate,
        allow_unlimited: true,
        hourly_price: 150,
        unlimited_price: 750,
        is_self_service: true,
        self_allow_hourly: false,
        self_allow_equipment: true
      }
    });

    session = await prisma.session.create({
      data: { session_date: selfDate, start_time: '13:00', end_time: '14:00', max_capacity: 40 }
    });

    const userA = await prisma.user.upsert({
      where: { line_user_id: 'r26b_user_other' },
      update: { name: 'R26b其他顧客', phone: '0912999001' },
      create: { line_user_id: 'r26b_user_other', name: 'R26b其他顧客', phone: '0912999001' }
    });

    const userB = await prisma.user.upsert({
      where: { line_user_id: 'r26b_user_wait' },
      update: { name: 'R26b候位顧客', phone: '0912999002' },
      create: { line_user_id: 'r26b_user_wait', name: 'R26b候位顧客', phone: '0912999002' }
    });

    // 1. 另一筆預約：已有確定實體座位 ['K01']
    await prisma.reservation.create({
      data: {
        booking_ref: refOther,
        user_id: userA.id,
        session_id: session.id,
        pax: 1,
        assigned_seats: ['K01'],
        status: 'confirmed',
        billing_status: 'paid',
        is_paid: true,
        is_self_service: true,
        is_unlimited: true,
        total_amount: 750
      }
    });

    // 2. 候位預約：['WAIT-1']
    await prisma.reservation.create({
      data: {
        booking_ref: refWait,
        user_id: userB.id,
        session_id: session.id,
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

    const rawKey = crypto.randomBytes(32);
    device = await prisma.kioskDevice.create({
      data: {
        name: 'R26b Savepoint Test Device',
        key_wrapped: wrapPairKey(rawKey, process.env.JWT_SECRET),
        is_active: true,
        paired_at: tOpen
      }
    });

    // 準備一個 stub reseatBookings：先改了 refOther 的座位，再拋出 CANNOT_DISPLACE
    const stubReseatDisplaceAndThrow = async (tx, _opts) => {
      await tx.reservation.updateMany({
        where: { booking_ref: refOther },
        data: { assigned_seats: ['K02-DISPLACED'] }
      });
      const err = new Error('Cannot displace other bookings');
      err.code = 'CANNOT_DISPLACE';
      throw err;
    };

    const qrKey = qrKeyFrom(process.env.JWT_SECRET);
    const qrCode = qrCodeFor(qrKey, refWait, Math.floor(tOpen.getTime() / 1000));

    const accessRes = await processKioskAccess(prisma, {
      device,
      method: 'qr',
      payload: qrCode.code,
      now: tOpen,
      notifyFn: async () => {},
      reseatFn: stubReseatDisplaceAndThrow
    });

    // 驗證 1：報到成功、開門、seats 是空陣列
    assert.equal(accessRes.result, 'FIRST_CHECKIN');
    assert.equal(accessRes.open_door, true);
    assert.deepEqual(accessRes.booking.seats, []);

    // 驗證 2：另一筆預約的座位在 savepoint rollback 後完全沒有被改動，仍為 ['K01']
    const otherInDb = await prisma.reservation.findFirst({
      where: { booking_ref: refOther }
    });
    assert.deepEqual(otherInDb.assigned_seats, ['K01'], 'Other booking seats must remain untouched after savepoint rollback');

    // 驗證 3：候位預約已完成報到
    const waitInDb = await prisma.reservation.findFirst({
      where: { booking_ref: refWait }
    });
    assert.equal(waitInDb.attendance, 'checked_in');
    assert.equal(waitInDb.checked_in_by, '報到機');
  } finally {
    if (device) {
      await prisma.kioskAccessLog.deleteMany({ where: { device_id: device.id } });
      await prisma.kioskDevice.delete({ where: { id: device.id } }).catch(() => {});
    }
    if (createdRefs.length) {
      await prisma.kioskAccessLog.deleteMany({ where: { booking_ref: { in: createdRefs } } });
      await prisma.payment.deleteMany({ where: { booking_ref: { in: createdRefs } } });
      await prisma.bookingPerson.deleteMany({ where: { booking_ref: { in: createdRefs } } });
      await prisma.bookingEquipment.deleteMany({ where: { booking_ref: { in: createdRefs } } });
      await prisma.bookingPrepay.deleteMany({ where: { booking_ref: { in: createdRefs } } });
      await prisma.reservation.deleteMany({ where: { booking_ref: { in: createdRefs } } });
    }
    if (session) {
      await prisma.session.delete({ where: { id: session.id } }).catch(() => {});
    }
    await prisma.dailySetting.deleteMany({ where: { date: selfDate } }).catch(() => {});
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

test('Round 26b Item 3 Test 2: reseat DB error recovers via savepoint and checkin proceeds', async () => {
  const selfDateStr = '2099-10-22';
  const selfDate = dateOnly(selfDateStr);
  const tOpen = new Date(`${selfDateStr}T13:30:00.000+08:00`);

  let savedKiosk = null;
  let createdLayoutId = null;
  let device = null;
  let session = null;
  const createdRefs = [];

  const refWait = crypto.randomUUID();
  createdRefs.push(refWait);

  try {
    savedKiosk = await prisma.kioskSetting.findUnique({ where: { id: 1 } });
    await prisma.kioskSetting.upsert({
      where: { id: 1 },
      update: { early_minutes: 30, after_close_minutes: 60, prepay_deadline_hour: 12, max_unpaid_self_bookings: 10 },
      create: { id: 1, early_minutes: 30, after_close_minutes: 60, prepay_deadline_hour: 12, max_unpaid_self_bookings: 10 }
    });

    createdLayoutId = await ensureTestPublishedLayout(prisma, {
      name: 'R26b Item3 DB Error Layout',
      effectiveFrom: '2020-01-01',
      effectiveDate: selfDateStr,
      codePrefix: 'K',
      seatCount: 10
    });

    await prisma.dailySetting.deleteMany({ where: { date: selfDate } });
    await prisma.dailySetting.create({
      data: {
        date: selfDate,
        allow_unlimited: true,
        hourly_price: 150,
        unlimited_price: 750,
        is_self_service: true,
        self_allow_hourly: false,
        self_allow_equipment: true
      }
    });

    session = await prisma.session.create({
      data: { session_date: selfDate, start_time: '13:00', end_time: '14:00', max_capacity: 40 }
    });

    const userB = await prisma.user.upsert({
      where: { line_user_id: 'r26b_user_wait_dberr' },
      update: { name: 'R26b候位資料庫錯誤測試', phone: '0912999003' },
      create: { line_user_id: 'r26b_user_wait_dberr', name: 'R26b候位資料庫錯誤測試', phone: '0912999003' }
    });

    await prisma.reservation.create({
      data: {
        booking_ref: refWait,
        user_id: userB.id,
        session_id: session.id,
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

    const rawKey = crypto.randomBytes(32);
    device = await prisma.kioskDevice.create({
      data: {
        name: 'R26b DB Error Test Device',
        key_wrapped: wrapPairKey(rawKey, process.env.JWT_SECRET),
        is_active: true,
        paired_at: tOpen
      }
    });

    // 準備一個 stub reseatBookings：執行語法或不存在資料表的 SQL，引發 PostgreSQL 資料庫錯誤
    const stubReseatDbError = async (tx, _opts) => {
      await tx.$executeRawUnsafe('SELECT * FROM non_existent_table_for_savepoint_test');
    };

    const qrKey = qrKeyFrom(process.env.JWT_SECRET);
    const qrCode = qrCodeFor(qrKey, refWait, Math.floor(tOpen.getTime() / 1000));

    const accessRes = await processKioskAccess(prisma, {
      device,
      method: 'qr',
      payload: qrCode.code,
      now: tOpen,
      notifyFn: async () => {},
      reseatFn: stubReseatDbError
    });

    // 驗證 1：即使重排發生資料庫錯誤，外層交易因 savepoint rollback 恢復正常，報到成功並開門
    assert.equal(accessRes.result, 'FIRST_CHECKIN');
    assert.equal(accessRes.open_door, true);
    assert.deepEqual(accessRes.booking.seats, []);

    // 驗證 2：候位預約已正確寫入已報到狀態
    const waitInDb = await prisma.reservation.findFirst({
      where: { booking_ref: refWait }
    });
    assert.equal(waitInDb.attendance, 'checked_in');
    assert.equal(waitInDb.checked_in_by, '報到機');
  } finally {
    if (device) {
      await prisma.kioskAccessLog.deleteMany({ where: { device_id: device.id } });
      await prisma.kioskDevice.delete({ where: { id: device.id } }).catch(() => {});
    }
    if (createdRefs.length) {
      await prisma.kioskAccessLog.deleteMany({ where: { booking_ref: { in: createdRefs } } });
      await prisma.payment.deleteMany({ where: { booking_ref: { in: createdRefs } } });
      await prisma.bookingPerson.deleteMany({ where: { booking_ref: { in: createdRefs } } });
      await prisma.bookingEquipment.deleteMany({ where: { booking_ref: { in: createdRefs } } });
      await prisma.bookingPrepay.deleteMany({ where: { booking_ref: { in: createdRefs } } });
      await prisma.reservation.deleteMany({ where: { booking_ref: { in: createdRefs } } });
    }
    if (session) {
      await prisma.session.delete({ where: { id: session.id } }).catch(() => {});
    }
    await prisma.dailySetting.deleteMany({ where: { date: selfDate } }).catch(() => {});
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
