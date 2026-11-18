import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import prisma from '../src/prismaClient.js';
import { processKioskSync } from '../src/services/kiosk/syncService.js';
import { resolveEventTime, notifyBackupCodeUsed } from '../src/services/kiosk/alertService.js';
import { wrapPairKey } from '../src/services/kiosk/sgk1.js';

test('Round 27b Item 2: backup_open LINE notification aligns time resolution with KioskAccessLog and dedups retries', async () => {
  const receivedNow = new Date('2099-10-20T14:30:00.000+08:00');
  const validEventDate = new Date('2099-10-20T14:05:00.000+08:00');
  const validEventSec = Math.floor(validEventDate.getTime() / 1000);

  // Unit assertions on shared resolveEventTime
  const rValid = resolveEventTime(validEventSec, receivedNow);
  assert.equal(rValid.unknown, false);
  assert.equal(rValid.at.getTime(), validEventSec * 1000);

  for (const badAt of [null, 0, -5, undefined, '']) {
    const rBad = resolveEventTime(badAt, receivedNow);
    assert.equal(rBad.unknown, true, `Expected unknown=true for at=${String(badAt)}`);
    assert.equal(rBad.at.getTime(), receivedNow.getTime());
  }

  let savedKiosk = null;
  let testUser = null;
  let device = null;

  try {
    savedKiosk = await prisma.kioskSetting.findUnique({ where: { id: 1 } });

    testUser = await prisma.user.create({
      data: {
        name: 'R27b Alert Recipient',
        phone: `0977${String(Date.now()).slice(-6)}`,
        line_user_id: `U_r27b_alert_${Date.now()}`
      }
    });

    await prisma.kioskSetting.upsert({
      where: { id: 1 },
      update: { alert_user_ids: [testUser.id] },
      create: { id: 1, alert_user_ids: [testUser.id] }
    });

    device = await prisma.kioskDevice.create({
      data: {
        name: 'R27b Backup Alert Device',
        key_wrapped: wrapPairKey(crypto.randomBytes(32), process.env.JWT_SECRET),
        is_active: true,
        paired_at: receivedNow
      }
    });

    const sent = [];
    const spyPush = async (lineUserId, message) => {
      sent.push({ lineUserId, text: message.text });
    };

    // 1. Direct notifyBackupCodeUsed for valid seconds, null, 0, -5
    await notifyBackupCodeUsed(prisma, receivedNow, validEventSec, { pushFn: spyPush });
    await notifyBackupCodeUsed(prisma, receivedNow, null, { pushFn: spyPush });
    await notifyBackupCodeUsed(prisma, receivedNow, 0, { pushFn: spyPush });
    await notifyBackupCodeUsed(prisma, receivedNow, -5, { pushFn: spyPush });

    assert.equal(sent.length, 4);
    assert.equal(sent[0].text, '備用開門密碼在 14:05 被使用，請到後台換一組新的');
    assert.equal(sent[1].text, '備用開門密碼被使用了（發生時間不明，補報於 14:30），請到後台換一組新的');
    assert.equal(sent[2].text, '備用開門密碼被使用了（發生時間不明，補報於 14:30），請到後台換一組新的');
    assert.equal(sent[3].text, '備用開門密碼被使用了（發生時間不明，補報於 14:30），請到後台換一組新的');

    // 2. Through processKioskSync + duplicate event_id protection
    sent.length = 0;
    const batchEvents = [
      { id: 'r27b-ev-valid', type: 'backup_open', at: validEventSec, offline: false },
      { id: 'r27b-ev-null', type: 'backup_open', at: null, offline: true },
      { id: 'r27b-ev-zero', type: 'backup_open', at: 0, offline: true },
      { id: 'r27b-ev-neg', type: 'backup_open', at: -5, offline: true }
    ];

    await processKioskSync(prisma, {
      device,
      body: { events: batchEvents },
      clientIp: '127.0.0.1',
      now: receivedNow,
      pushFn: spyPush
    });

    assert.equal(sent.length, 4);
    assert.equal(sent[0].text, '備用開門密碼在 14:05 被使用，請到後台換一組新的');
    assert.equal(sent[1].text, '備用開門密碼被使用了（發生時間不明，補報於 14:30），請到後台換一組新的');
    assert.equal(sent[2].text, '備用開門密碼被使用了（發生時間不明，補報於 14:30），請到後台換一組新的');
    assert.equal(sent[3].text, '備用開門密碼被使用了（發生時間不明，補報於 14:30），請到後台換一組新的');

    // Re-send duplicate event_ids -> must NOT send any more LINE alerts
    await processKioskSync(prisma, {
      device,
      body: { events: batchEvents },
      clientIp: '127.0.0.1',
      now: new Date(receivedNow.getTime() + 60000),
      pushFn: spyPush
    });

    assert.equal(sent.length, 4, 'Duplicate event_ids must trigger LINE notification only once');
  } finally {
    if (device?.id) {
      await prisma.kioskAccessLog.deleteMany({ where: { device_id: device.id } }).catch(() => {});
      await prisma.kioskDevice.delete({ where: { id: device.id } }).catch(() => {});
    }
    if (savedKiosk) {
      await prisma.kioskSetting.update({
        where: { id: 1 },
        data: { alert_user_ids: savedKiosk.alert_user_ids ?? [] }
      }).catch(() => {});
    } else {
      await prisma.kioskSetting.deleteMany({ where: { id: 1 } }).catch(() => {});
    }
    if (testUser?.id) {
      await prisma.user.delete({ where: { id: testUser.id } }).catch(() => {});
    }
  }
});
