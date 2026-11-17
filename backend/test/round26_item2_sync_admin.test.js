import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import prisma from '../src/prismaClient.js';
import { dateOnly } from '../../shared/time.js';
import { wrapPairKey } from '../src/services/kiosk/sgk1.js';
import { buildSevenDaysSchedule, processKioskSync } from '../src/services/kiosk/syncService.js';
import {
  getKioskAdminOverviewHandler,
  updateKioskBackupCodeHandler,
  getKioskBackupCodeHandler,
  updateKioskSetupPinHandler,
  getKioskAccessLogsHandler
} from '../src/controllers/kioskController.js';
import { getKioskSettings, updateKioskSettings } from '../src/controllers/kioskSettingController.js';
import { getGlobalSetting } from '../src/controllers/dailySettingController.js';

function createMockRes() {
  return {
    statusCode: 200,
    body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; }
  };
}

function makeAdminReq({ body = {}, params = {}, query = {} } = {}) {
  return {
    user: { id: 1, name: 'R26管理員', role: 'admin' },
    headers: { 'x-device-label': '後台測試機' },
    body,
    params,
    query
  };
}

test('Round 26 Item 2: Kiosk sync 7-day schedule, event dedup, backup code validation, and secrets isolation', async () => {
  // Choose Taipei date near midnight: 2099-10-01T16:30:00Z = 2099-10-02 00:30+08:00
  const fixedNow = new Date('2099-10-01T16:30:00.000Z');
  const d0 = '2099-10-02'; // self
  const d1 = '2099-10-03'; // normal
  const d2 = '2099-10-04'; // closed
  const cleanupDates = [dateOnly(d0), dateOnly(d1), dateOnly(d2)];

  let savedKiosk = null;
  let device = null;

  try {
    savedKiosk = await prisma.kioskSetting.findUnique({ where: { id: 1 } });

    await prisma.kioskSlide.deleteMany();
    await prisma.session.deleteMany({ where: { session_date: { in: cleanupDates } } });
    await prisma.dailySetting.deleteMany({ where: { date: { in: cleanupDates } } });

    await prisma.globalSetting.upsert({
      where: { id: 1 },
      update: {},
      create: {
        id: 1,
        weekday_hourly_price: 150,
        weekday_unlimited_price: 750,
        weekend_hourly_price: 200,
        weekend_unlimited_price: 900,
        official_line_url: 'https://lin.ee/fallbackTest'
      }
    });

    await prisma.dailySetting.create({
      data: {
        date: dateOnly(d0),
        is_self_service: true,
        allow_unlimited: true,
        iron_mode: 'today'
      }
    });
    await prisma.dailySetting.create({
      data: {
        date: dateOnly(d1),
        is_self_service: false,
        allow_unlimited: true
      }
    });

    await prisma.session.createMany({
      data: [
        { session_date: dateOnly(d0), start_time: '10:00', end_time: '11:00', max_capacity: 16 },
        { session_date: dateOnly(d0), start_time: '19:00', end_time: '21:00', max_capacity: 16 },
        { session_date: dateOnly(d1), start_time: '11:00', end_time: '12:00', max_capacity: 16 }
      ]
    });

    device = await prisma.kioskDevice.create({
      data: {
        name: 'R26 Sync 測試報到機',
        key_wrapped: wrapPairKey(crypto.randomBytes(32), process.env.JWT_SECRET),
        is_active: true,
        paired_at: fixedNow
      }
    });

    // 1. 7-day schedule respects Taipei timezone across UTC midnight & outputs self/normal/closed modes
    const days = await buildSevenDaysSchedule(prisma, fixedNow);
    assert.equal(days.length, 7);
    assert.deepEqual(days[0], {
      date: d0,
      mode: 'self',
      open: '10:00',
      close: '21:00',
      iron_text: '店員會在今天下午到店協助熨燙'
    });
    assert.deepEqual(days[1], {
      date: d1,
      mode: 'normal',
      open: '11:00',
      close: '12:00',
      iron_text: ''
    });
    assert.deepEqual(days[2], {
      date: d2,
      mode: 'closed',
      open: null,
      close: null,
      iron_text: ''
    });

    // 2. Backup code validation (09xxx, 9-digit, alpha rejected with 422; valid 10-digit accepted & bumps rev)
    await prisma.kioskSetting.upsert({
      where: { id: 1 },
      update: { backup_code: null, backup_code_rev: 0, backup_code_set_at: null, slides_rev: 0 },
      create: { id: 1, slides_rev: 0 }
    });

    for (const badCode of ['0912345678', '123456789', '88001234AB']) {
      const badRes = createMockRes();
      await updateKioskBackupCodeHandler(makeAdminReq({ body: { code: badCode } }), badRes);
      assert.equal(badRes.statusCode, 422, `Expected ${badCode} rejected`);
    }

    const okCodeRes = createMockRes();
    await updateKioskBackupCodeHandler(makeAdminReq({ body: { code: '8800123456' } }), okCodeRes);
    assert.equal(okCodeRes.statusCode, 200);
    assert.equal(okCodeRes.body.backup_code_rev, 1);

    // Same code again rejected
    const dupCodeRes = createMockRes();
    await updateKioskBackupCodeHandler(makeAdminReq({ body: { code: '8800123456' } }), dupCodeRes);
    assert.equal(dupCodeRes.statusCode, 422);

    // Setup PIN 6 digits validation
    const badPinRes = createMockRes();
    await updateKioskSetupPinHandler(makeAdminReq({ body: { pin: '12345' } }), badPinRes);
    assert.equal(badPinRes.statusCode, 422);

    const okPinRes = createMockRes();
    await updateKioskSetupPinHandler(makeAdminReq({ body: { pin: '246810' } }), okPinRes);
    assert.equal(okPinRes.statusCode, 200);
    assert.equal(okPinRes.body.setup_pin_rev, 1);

    // Update settings (line_url/line_id) bumps config_rev
    const updSetRes = createMockRes();
    await updateKioskSettings(makeAdminReq({ body: { line_url: 'https://lin.ee/kioskLine', line_id: '@sgtest' } }), updSetRes);
    assert.equal(updSetRes.statusCode, 200);
    assert.equal(updSetRes.body.setting.backup_code, undefined);
    assert.equal(updSetRes.body.setting.setup_pin, undefined);

    // 3. Kiosk sync processes events with dedup on (device_id, event_id)
    const eventAtSec = Math.floor(new Date('2099-10-02T05:15:00.000Z').getTime() / 1000);
    const syncPayload = {
      fw: '0.2.0',
      boot_id: 'a1b2c3d4',
      uptime_s: 3600,
      reset_reason: 'poweron',
      rssi: -58,
      scanner_ok: true,
      have: { backup_code_rev: 1, setup_pin_rev: 1, config_rev: 1 },
      events: [
        { id: 'a1b2c3d4-7', type: 'backup_open', at: eventAtSec, offline: true }
      ]
    };

    const syncOut1 = await processKioskSync(prisma, { device, body: syncPayload, clientIp: '127.0.0.1', now: fixedNow });
    const syncOut2 = await processKioskSync(prisma, { device, body: syncPayload, clientIp: '127.0.0.1', now: fixedNow });

    assert.deepEqual(syncOut1.ack_event_ids, ['a1b2c3d4-7']);
    assert.deepEqual(syncOut2.ack_event_ids, ['a1b2c3d4-7']);
    assert.deepEqual(syncOut1.backup_code, { rev: 1, code: '8800123456' });
    assert.deepEqual(syncOut1.setup_pin, { rev: 1, pin: '246810' });
    assert.deepEqual(syncOut1.contact, { line_url: 'https://lin.ee/kioskLine', line_id: '@sgtest' });
    assert.deepEqual(syncOut1.slides, { rev: 0, items: [] });
    assert.ok(syncOut1.floor_map === null || typeof syncOut1.floor_map?.version === 'string');
    assert.equal(syncOut1.firmware, null);

    const logCount = await prisma.kioskAccessLog.count({
      where: { device_id: device.id, event_id: 'a1b2c3d4-7' }
    });
    assert.equal(logCount, 1);

    // Access logs admin endpoint returns the backup_open entry for 2099-10-02
    const logsRes = createMockRes();
    await getKioskAccessLogsHandler(makeAdminReq({ query: { date: d0 } }), logsRes);
    assert.equal(logsRes.statusCode, 200);
    assert.equal(logsRes.body.logs.length, 1);
    assert.equal(logsRes.body.logs[0].method, 'backup_code');
    assert.equal(logsRes.body.logs[0].result, 'BACKUP_OPEN');
    assert.equal(logsRes.body.logs[0].open_door, true);

    // 4. Overview excludes plaintext backup_code & setup_pin and reports synced status
    const ovRes = createMockRes();
    await getKioskAdminOverviewHandler(makeAdminReq(), ovRes);
    assert.equal(ovRes.statusCode, 200);
    assert.equal(ovRes.body.backup_code_status.code, undefined);
    assert.equal(ovRes.body.backup_code_status.is_set, true);
    assert.equal(ovRes.body.backup_code_status.synced, true);
    assert.equal(ovRes.body.settings.backup_code, undefined);
    assert.equal(ovRes.body.settings.setup_pin, undefined);

    // Explicit GET backup-code reveals code and logs audit without storing password
    const revealRes = createMockRes();
    await getKioskBackupCodeHandler(makeAdminReq(), revealRes);
    assert.equal(revealRes.statusCode, 200);
    assert.equal(revealRes.body.code, '8800123456');

    const latestAudit = await prisma.accountingEvent.findFirst({
      where: { event_type: 'kiosk_backup_code_viewed' },
      orderBy: { id: 'desc' }
    });
    assert.ok(latestAudit);
    assert.ok(!latestAudit.summary.includes('8800123456'));

    // 5. Public GET /api/global-settings & /api/daily-settings/global NEVER expose backup_code or setup_pin
    const globalRes = createMockRes();
    await getGlobalSetting({}, globalRes);
    assert.equal(globalRes.statusCode, 200);
    assert.equal(globalRes.body.backup_code, undefined);
    assert.equal(globalRes.body.setup_pin, undefined);

    const ksGetRes = createMockRes();
    await getKioskSettings(makeAdminReq(), ksGetRes);
    assert.equal(ksGetRes.statusCode, 200);
    assert.equal(ksGetRes.body.backup_code, undefined);
    assert.equal(ksGetRes.body.setup_pin, undefined);
  } finally {
    await prisma.kioskSlide.deleteMany();
    await prisma.session.deleteMany({ where: { session_date: { in: cleanupDates } } });
    await prisma.dailySetting.deleteMany({ where: { date: { in: cleanupDates } } });
    if (device?.id) {
      await prisma.kioskAccessLog.deleteMany({ where: { device_id: device.id } });
      await prisma.kioskDevice.deleteMany({ where: { id: device.id } });
    }
    if (savedKiosk) {
      await prisma.kioskSetting.update({
        where: { id: 1 },
        data: {
          early_minutes: savedKiosk.early_minutes,
          after_close_minutes: savedKiosk.after_close_minutes,
          prepay_deadline_hour: savedKiosk.prepay_deadline_hour,
          max_unpaid_self_bookings: savedKiosk.max_unpaid_self_bookings,
          line_url: savedKiosk.line_url,
          line_id: savedKiosk.line_id,
          backup_code: savedKiosk.backup_code,
          backup_code_rev: savedKiosk.backup_code_rev,
          backup_code_set_at: savedKiosk.backup_code_set_at,
          setup_pin: savedKiosk.setup_pin,
          setup_pin_rev: savedKiosk.setup_pin_rev,
          config_rev: savedKiosk.config_rev
        }
      });
    } else {
      await prisma.kioskSetting.delete({ where: { id: 1 } }).catch(() => {});
    }
  }
});
