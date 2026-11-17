import test from 'node:test';
import assert from 'node:assert/strict';
import prisma from '../src/prismaClient.js';
import { getGlobalSetting } from '../src/controllers/dailySettingController.js';

function createMockRes() {
  const res = {
    statusCode: 200,
    body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; }
  };
  return res;
}

test('Round 25 Item 1: Schema tables & columns exist and GET /global-settings leaks no KioskSetting fields', async () => {
  try {
    // Query new columns on DailySetting, EquipmentConfig, Reservation, and new tables KioskSetting, BookingPrepay
    await prisma.$queryRaw`SELECT is_self_service, self_allow_hourly, self_allow_equipment, iron_mode, iron_date FROM "DailySetting" LIMIT 1`;
    await prisma.$queryRaw`SELECT self_enabled, self_hourly_rate, self_daily_cap, self_stock FROM "EquipmentConfig" LIMIT 1`;
    await prisma.$queryRaw`SELECT is_self_service FROM "Reservation" LIMIT 1`;
    await prisma.$queryRaw`SELECT id, early_minutes, after_close_minutes, prepay_deadline_hour, max_unpaid_self_bookings FROM "KioskSetting" LIMIT 1`;
    await prisma.$queryRaw`SELECT id, booking_ref, user_id, total_amount, pass_persons, pass_holds, amount_due, status FROM "BookingPrepay" LIMIT 1`;

    const res = createMockRes();
    await getGlobalSetting({}, res);
    assert.equal(res.statusCode, 200);
    assert.ok(res.body && typeof res.body === 'object');
    for (const forbidden of ['early_minutes', 'after_close_minutes', 'prepay_deadline_hour', 'max_unpaid_self_bookings']) {
      assert.equal(forbidden in res.body, false, `GlobalSetting response must NOT contain ${forbidden}`);
    }
  } finally {
    await prisma.$disconnect();
  }
});
