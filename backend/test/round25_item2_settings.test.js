import test from 'node:test';
import assert from 'node:assert/strict';
import prisma from '../src/prismaClient.js';
import { dateOnly, toTaipeiDateString } from '../../shared/time.js';
import {
  getDailySetting,
  getDailySettingsRange,
  updateDailySetting,
  batchUpdateDailySettings
} from '../src/controllers/dailySettingController.js';
import {
  getKioskSettings,
  updateKioskSettings
} from '../src/controllers/kioskSettingController.js';
import {
  getAvailableEquipment,
  updateEquipmentConfig,
  ensureDefaultEquipmentConfigs
} from '../src/controllers/equipmentController.js';

function createMockRes() {
  return {
    statusCode: 200,
    body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; }
  };
}

test('Round 25 Item 2: Daily self-service settings, kiosk settings, and equipment self-service availability', async () => {
  const testDates = ['2099-05-01', '2099-05-02', '2099-05-03', '2099-05-04'];
  const dateObjs = testDates.map(d => dateOnly(d));
  const bookingRef = 'r25-item2-ref-001';
  let user = null;
  let sessions = [];
  let savedKiosk = null;
  let savedSmallCfg = null;

  try {
    await ensureDefaultEquipmentConfigs();
    savedKiosk = await prisma.kioskSetting.findUnique({ where: { id: 1 } });
    savedSmallCfg = await prisma.equipmentConfig.findUnique({ where: { id: 'pegboard_s' } });

    // Clean any leftover test data for those future dates
    await prisma.bookingEquipment.deleteMany({ where: { booking_ref: bookingRef } });
    await prisma.reservation.deleteMany({ where: { booking_ref: bookingRef } });
    await prisma.session.deleteMany({ where: { session_date: { in: dateObjs } } });
    await prisma.dailySetting.deleteMany({ where: { date: { in: dateObjs } } });

    user = await prisma.user.upsert({
      where: { line_user_id: 'r25_item2_test_user' },
      update: { name: 'R25設定測試員', phone: '0911222333' },
      create: { line_user_id: 'r25_item2_test_user', name: 'R25設定測試員', phone: '0911222333' }
    });

    // Create 1 confirmed reservation on 2099-05-02 (spanning 2 sessions)
    const s1 = await prisma.session.create({
      data: { session_date: dateObjs[1], start_time: '13:00', end_time: '14:00', max_capacity: 16 }
    });
    const s2 = await prisma.session.create({
      data: { session_date: dateObjs[1], start_time: '14:00', end_time: '15:00', max_capacity: 16 }
    });
    const sDay1 = await prisma.session.create({
      data: { session_date: dateObjs[0], start_time: '13:00', end_time: '14:00', max_capacity: 16 }
    });
    sessions = [s1, s2, sDay1];

    await prisma.reservation.createMany({
      data: [
        { booking_ref: bookingRef, session_id: s1.id, user_id: user.id, pax: 2, status: 'confirmed' },
        { booking_ref: bookingRef, session_id: s2.id, user_id: user.id, pax: 2, status: 'confirmed' }
      ]
    });

    // 1a. Switching is_self_service on day WITH confirmed booking -> 422
    const resBlock = createMockRes();
    await updateDailySetting({ body: { date: '2099-05-02', is_self_service: true } }, resBlock);
    assert.equal(resBlock.statusCode, 422);
    assert.ok(resBlock.body.error.includes('這天已經有 1 筆預約'));

    // 1b. Switching is_self_service on day WITHOUT confirmed booking -> 200
    const resOk = createMockRes();
    await updateDailySetting({
      body: { date: '2099-05-01', is_self_service: true, iron_mode: 'next', self_allow_equipment: false }
    }, resOk);
    assert.equal(resOk.statusCode, 200);
    assert.equal(resOk.body.setting.is_self_service, true);
    assert.equal(resOk.body.setting.iron_mode, 'next');

    // Verify GET /daily-settings returns self_service meta
    const resGet = createMockRes();
    await getDailySetting({ query: { date: '2099-05-01', now: '2099-04-30T10:00:00+08:00' } }, resGet);
    assert.equal(resGet.statusCode, 200);
    assert.equal(resGet.body.is_self_service, true);
    assert.equal(resGet.body.self_service.iron_text, '店員會在隔天協助熨燙');
    assert.equal(resGet.body.self_service.transfer_open, true);

    // 2. Batch update 3 days where 2099-05-02 has booking -> 422 and none modified
    const resBatchFail = createMockRes();
    await batchUpdateDailySettings({
      body: {
        dates: ['2099-05-02', '2099-05-03', '2099-05-04'],
        is_self_service: true,
        iron_mode: 'today'
      }
    }, resBatchFail);
    assert.equal(resBatchFail.statusCode, 422);
    const day3Row = await prisma.dailySetting.findUnique({ where: { date: dateObjs[2] } });
    assert.equal(day3Row, null, 'Batch conflict must leave all days untouched');

    // 3. GET /daily-settings/range returns full range with day_type & price_type
    const resRange = createMockRes();
    await getDailySettingsRange({ query: { start: '2099-05-01', end: '2099-05-10' } }, resRange);
    assert.equal(resRange.statusCode, 200);
    assert.equal(resRange.body.length, 10);
    const selfRows = resRange.body.filter((r) => r.is_self_service);
    assert.deepEqual(selfRows.map((r) => r.date), ['2099-05-01']);
    assert.equal(selfRows[0].day_type, 'self');
    assert.ok(resRange.body.every((r) => r.price_type === 'weekday' || r.price_type === 'holiday'));

    const resTooLong = createMockRes();
    await getDailySettingsRange({ query: { start: '2099-01-01', end: '2099-06-01' } }, resTooLong);
    assert.equal(resTooLong.statusCode, 400);

    // 4. KioskSettings bounds check
    const resZero = createMockRes();
    await updateKioskSettings({ body: { max_unpaid_self_bookings: 0 } }, resZero);
    assert.equal(resZero.statusCode, 422);

    const resEleven = createMockRes();
    await updateKioskSettings({ body: { max_unpaid_self_bookings: 11 } }, resEleven);
    assert.equal(resEleven.statusCode, 422);

    const resKioskOk = createMockRes();
    await updateKioskSettings({ body: { max_unpaid_self_bookings: 3, early_minutes: 45 } }, resKioskOk);
    assert.equal(resKioskOk.statusCode, 200);
    const resKioskGet = createMockRes();
    await getKioskSettings({}, resKioskGet);
    assert.equal(resKioskGet.body.max_unpaid_self_bookings, 3);
    assert.equal(resKioskGet.body.early_minutes, 45);

    // 5. Self-service day with self_allow_equipment = false -> availability returns []
    const resEqClosed = createMockRes();
    await getAvailableEquipment({ query: { date: '2099-05-01', sessions: '13:00', per_session: '1' } }, resEqClosed);
    assert.equal(resEqClosed.statusCode, 200);
    assert.equal(resEqClosed.body.self_service, true);
    assert.equal(resEqClosed.body.equipments.length, 0);

    // 6a. self_stock > total_stock -> 422
    const resEqInvalidStock = createMockRes();
    await updateEquipmentConfig({
      params: { id: 'pegboard_s' },
      body: { self_enabled: true, self_stock: (savedSmallCfg?.total_stock ?? 5) + 5 }
    }, resEqInvalidStock);
    assert.equal(resEqInvalidStock.statusCode, 422);

    // 6b. Enable pegboard_s for self-service with self_hourly_rate=90 & self_stock=2, enable day self_allow_equipment=true
    const resEqCfgOk = createMockRes();
    await updateEquipmentConfig({
      params: { id: 'pegboard_s' },
      body: { self_enabled: true, self_hourly_rate: 90, self_daily_cap: 300, self_stock: 2 }
    }, resEqCfgOk);
    assert.equal(resEqCfgOk.statusCode, 200);

    await prisma.dailySetting.update({
      where: { date: dateObjs[0] },
      data: { self_allow_equipment: true }
    });

    const resEqOpen = createMockRes();
    await getAvailableEquipment({ query: { date: '2099-05-01', sessions: '13:00', per_session: '1' } }, resEqOpen);
    assert.equal(resEqOpen.statusCode, 200);
    assert.equal(resEqOpen.body.self_service, true);
    assert.equal(resEqOpen.body.equipments.length, 1);
    assert.equal(resEqOpen.body.equipments[0].id, 'pegboard_s');
    assert.equal(resEqOpen.body.equipments[0].hourly_rate, 90);
    assert.equal(resEqOpen.body.equipments[0].available_qty, 2);

    // 7. Normal day (2099-05-02): availability unchanged (uses regular rates & no self_service flag)
    const resEqNormal = createMockRes();
    await getAvailableEquipment({ query: { date: '2099-05-02', sessions: '13:00', per_session: '1' } }, resEqNormal);
    assert.equal(resEqNormal.statusCode, 200);
    assert.equal('self_service' in resEqNormal.body, false);
    const smallNormal = resEqNormal.body.equipments.find(e => e.id === 'pegboard_s');
    assert.equal(smallNormal.hourly_rate, savedSmallCfg.hourly_rate);
    assert.equal(smallNormal.available_qty, savedSmallCfg.total_stock);
  } finally {
    await prisma.bookingEquipment.deleteMany({ where: { booking_ref: bookingRef } }).catch(() => {});
    await prisma.reservation.deleteMany({ where: { booking_ref: bookingRef } }).catch(() => {});
    if (sessions.length > 0) {
      await prisma.session.deleteMany({ where: { id: { in: sessions.map(s => s.id) } } }).catch(() => {});
    }
    await prisma.dailySetting.deleteMany({ where: { date: { in: dateObjs } } }).catch(() => {});
    if (user) {
      await prisma.user.delete({ where: { id: user.id } }).catch(() => {});
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
    if (savedSmallCfg) {
      await prisma.equipmentConfig.update({
        where: { id: 'pegboard_s' },
        data: {
          self_enabled: savedSmallCfg.self_enabled,
          self_hourly_rate: savedSmallCfg.self_hourly_rate,
          self_daily_cap: savedSmallCfg.self_daily_cap,
          self_stock: savedSmallCfg.self_stock
        }
      }).catch(() => {});
    }
    await prisma.$disconnect();
  }
});
