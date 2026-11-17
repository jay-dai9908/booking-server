import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import prisma from '../src/prismaClient.js';
import { processKioskSync } from '../src/services/kiosk/syncService.js';
import { wrapPairKey } from '../src/services/kiosk/sgk1.js';

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
