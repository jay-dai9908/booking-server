import test from 'node:test';
import assert from 'node:assert/strict';
import prisma from '../src/prismaClient.js';
import { dateOnly, toTaipeiDateString } from '../../shared/time.js';
import {
  isWithinSelfServiceBusinessHours,
  checkKioskOfflineAlerts,
  notifyBackupCodeUsed,
  formatTaipeiTime
} from '../src/services/kiosk/alertService.js';
import { startTestServer } from './helpers/testServer.js';

test('Round 27 Item 5: Kiosk offline and backup code LINE notifications', async (t) => {
  const testServer = await startTestServer();
  const BASE_URL = testServer.baseUrl;

  let admin = null;
  let testUser = null;
  let fullDaySession = null;
  let origDailySetting = null;
  const now = new Date();
  const todayStr = toTaipeiDateString(now);
  const todayDateObj = dateOnly(todayStr);

  try {
    // 1. Setup admin staff user and login
    const staffPass = `test_alert_pwd_${Date.now()}`;
    admin = await prisma.adminUser.create({
      data: {
        name: 'Alert Admin',
        password: staffPass,
        role: 'staff',
        permissions: ['settings'],
        is_active: true
      }
    });

    const loginRes = await fetch(`${BASE_URL}/api/auth/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: staffPass })
    });
    assert.equal(loginRes.status, 200);
    const { token } = await loginRes.json();
    assert.ok(token);

    // Setup candidate User with LINE ID
    testUser = await prisma.user.create({
      data: {
        name: 'Test Alert Recipient',
      phone: `0987${String(Date.now()).slice(-6)}`,
      line_user_id: `U_alert_test_${Date.now()}`
    }
  });

  // 2. Test Alert Recipients Admin Endpoints
  const resGetRecipients = await fetch(`${BASE_URL}/api/kiosk/admin/alerts/recipients`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  assert.equal(resGetRecipients.status, 200);
  const dataGetRecipients = await resGetRecipients.json();
  assert.equal(dataGetRecipients.ok, true);
  assert(Array.isArray(dataGetRecipients.candidates));
  assert(dataGetRecipients.candidates.some((c) => c.id === testUser.id));

  const resPutRecipients = await fetch(`${BASE_URL}/api/kiosk/admin/alerts/recipients`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ user_ids: [testUser.id] })
  });
  assert.equal(resPutRecipients.status, 200);
  const dataPutRecipients = await resPutRecipients.json();
  assert.deepEqual(dataPutRecipients.alert_user_ids, [testUser.id]);

  // Reject more than 3 recipients with 422
  const resPutOverLimit = await fetch(`${BASE_URL}/api/kiosk/admin/alerts/recipients`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ user_ids: [1, 2, 3, 4] })
  });
  assert.equal(resPutOverLimit.status, 422);

  // Test sending a test alert message
  const resTestAlert = await fetch(`${BASE_URL}/api/kiosk/admin/alerts/test`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` }
  });
  assert.equal(resTestAlert.status, 200);

  // 3. Test isWithinSelfServiceBusinessHours logic
  origDailySetting = await prisma.dailySetting.findUnique({
    where: { date: todayDateObj }
  });

  // Ensure daily setting has is_self_service = true
  await prisma.dailySetting.upsert({
    where: { date: todayDateObj },
    update: { is_self_service: true },
    create: { date: todayDateObj, is_self_service: true }
  });

  // Ensure a session exists covering 00:00 - 23:59 so current time is guaranteed within business hours
  fullDaySession = await prisma.session.create({
    data: {
      session_date: todayDateObj,
      start_time: '00:00',
      end_time: '23:59',
      max_capacity: 16
    }
  });

  const inHours = await isWithinSelfServiceBusinessHours(prisma, now);
  assert.equal(inHours, true);

  // Test when is_self_service is false -> false
  await prisma.dailySetting.update({
    where: { date: todayDateObj },
    data: { is_self_service: false }
  });
  const notInHours = await isWithinSelfServiceBusinessHours(prisma, now);
  assert.equal(notInHours, false);

  // Re-enable self service for offline checks
  await prisma.dailySetting.update({
    where: { date: todayDateObj },
    data: { is_self_service: true }
  });

  // 4. Test checkKioskOfflineAlerts
  // Create or update active device to be offline (last seen 15 minutes ago)
  let device = await prisma.kioskDevice.findFirst({ where: { is_active: true } });
  const fifteenMinutesAgo = new Date(now.getTime() - 15 * 60 * 1000);
  if (!device) {
    device = await prisma.kioskDevice.create({
      data: {
        name: '門口報到機',
        key_wrapped: 'dummy',
        is_active: true,
        last_seen_at: fifteenMinutesAgo,
        offline_alerted_at: null
      }
    });
  } else {
    device = await prisma.kioskDevice.update({
      where: { id: device.id },
      data: {
        is_active: true,
        last_seen_at: fifteenMinutesAgo,
        offline_alerted_at: null
      }
    });
  }

  // Run check -> should alert
  const alertResult1 = await checkKioskOfflineAlerts(prisma, now);
  assert.equal(alertResult1.alerted, true);
  assert.equal(alertResult1.offline, true);

  // Device offline_alerted_at should now be set
  let devAfter1 = await prisma.kioskDevice.findUnique({ where: { id: device.id } });
  assert.ok(devAfter1.offline_alerted_at);

  // Second check within 60 mins -> should be throttled
  const alertResult2 = await checkKioskOfflineAlerts(prisma, now);
  assert.equal(alertResult2.alerted, false);
  assert.equal(alertResult2.reason, 'ALERT_THROTTLED');

  // Device recovers (seen now) -> should send recovery message and clear offline_alerted_at
  await prisma.kioskDevice.update({
    where: { id: device.id },
    data: { last_seen_at: now }
  });

  const alertResult3 = await checkKioskOfflineAlerts(prisma, now);
  assert.equal(alertResult3.recovered, true);
  assert.equal(alertResult3.offline, false);

  let devAfter3 = await prisma.kioskDevice.findUnique({ where: { id: device.id } });
  assert.equal(devAfter3.offline_alerted_at, null);

  // 5. Test notifyBackupCodeUsed
  const notifyResult = await notifyBackupCodeUsed(prisma, now);
  assert.ok(notifyResult);

  } finally {
    // Cleanup
    if (fullDaySession?.id) {
      await prisma.session.delete({ where: { id: fullDaySession.id } }).catch(() => {});
    }
    if (origDailySetting) {
      await prisma.dailySetting.update({
        where: { date: todayDateObj },
        data: { is_self_service: origDailySetting.is_self_service }
      });
    } else {
      await prisma.dailySetting.deleteMany({ where: { date: todayDateObj } }).catch(() => {});
    }
    if (admin?.id) {
      await prisma.adminUser.delete({ where: { id: admin.id } }).catch(() => {});
    }
    if (testUser?.id) {
      await prisma.user.delete({ where: { id: testUser.id } }).catch(() => {});
    }
    await testServer.close();
  }
});
