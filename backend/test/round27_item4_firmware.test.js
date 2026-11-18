import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import prisma from '../src/prismaClient.js';
import { processKioskSync } from '../src/services/kiosk/syncService.js';
import { startTestServer } from './helpers/testServer.js';

function createEsp32Binary(versionStr, size = 1024, projectName = 'kiosk-firmware') {
  const buf = Buffer.alloc(size, 0xff);
  buf[0] = 0xe9; // ESP32 image magic byte
  buf[1] = 0x04; // segment count
  buf[2] = 0x00; // spi mode
  buf[3] = 0x20; // spi speed / size

  // App desc magic word at offset 32: 32 54 cd ab
  buf[32] = 0x32;
  buf[33] = 0x54;
  buf[34] = 0xcd;
  buf[35] = 0xab;

  // Write version string at offset 48 (0x30)
  buf.fill(0, 48, 80);
  buf.write(versionStr, 48, 'ascii');

  // Write project name at offset 80 (0x50)
  buf.fill(0, 80, 112);
  buf.write(projectName, 80, 'ascii');
  return buf;
}

test('Round 27 Item 4: Kiosk Firmware OTA management and sync reporting', async () => {
  const testServer = await startTestServer();
  const BASE_URL = testServer.baseUrl;

  let admin = null;
  try {
    // 1. Setup admin staff user and login
    const staffPass = `test_fw_pwd_${Date.now()}`;
    admin = await prisma.adminUser.create({
    data: {
      name: 'FW Admin',
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

  // Clean firmware and reset setting
  await prisma.kioskFirmware.deleteMany();
  await prisma.kioskSetting.upsert({
    where: { id: 1 },
    update: { fw_target_id: null, fw_policy: 'none' },
    create: { id: 1, fw_target_id: null, fw_policy: 'none' }
  });

  // 2. Reject invalid binaries with 422
  const badMagicBuf = Buffer.alloc(256, 0x00);
  const resBadMagic = await fetch(`${BASE_URL}/api/kiosk/admin/firmware`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      raw_base64: badMagicBuf.toString('base64'),
      note: 'Bad magic'
    })
  });
  assert.equal(resBadMagic.status, 422);
  const dataBadMagic = await resBadMagic.json();
  assert.equal(dataBadMagic.error, 'INVALID_FIRMWARE_HEADER');

  // Test bad app desc magic
  const badDescBuf = createEsp32Binary('v0.9.0', 1024);
  badDescBuf[32] = 0x00;
  const resBadDesc = await fetch(`${BASE_URL}/api/kiosk/admin/firmware`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw_base64: badDescBuf.toString('base64') })
  });
  assert.equal(resBadDesc.status, 422);
  const dataBadDesc = await resBadDesc.json();
  assert.equal(dataBadDesc.error, 'INVALID_APP_DESC_MAGIC');

  // Test bad project name
  const badProjBuf = createEsp32Binary('v0.9.1', 1024, 'wrong-project');
  const resBadProj = await fetch(`${BASE_URL}/api/kiosk/admin/firmware`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw_base64: badProjBuf.toString('base64') })
  });
  assert.equal(resBadProj.status, 422);
  const dataBadProj = await resBadProj.json();
  assert.equal(dataBadProj.error, 'INVALID_PROJECT_NAME');

  // 3. Upload valid ESP32 firmware v1.0.0
  const binV1 = createEsp32Binary('v1.0.0', 2048);
  const sha256_v1 = crypto.createHash('sha256').update(binV1).digest('hex');

  const resV1 = await fetch(`${BASE_URL}/api/kiosk/admin/firmware`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      raw_base64: binV1.toString('base64'),
      note: 'Initial Release'
    })
  });
  assert.equal(resV1.status, 201);
  const dataV1 = await resV1.json();
  assert.equal(dataV1.ok, true);
  assert.equal(dataV1.firmware.version, 'v1.0.0');
  assert.equal(dataV1.firmware.size, 2048);
  assert.equal(dataV1.firmware.sha256, sha256_v1);
  const fw1Id = dataV1.firmware.id;

  // Test duplicate version upload -> returns 409
  const resDup = await fetch(`${BASE_URL}/api/kiosk/admin/firmware`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw_base64: binV1.toString('base64') })
  });
  assert.equal(resDup.status, 409);
  const dataDup = await resDup.json();
  assert.equal(dataDup.error, 'FIRMWARE_VERSION_EXISTS');

  // 4. Upload 4 more versions to test retention (v1.1, v1.2, v1.3, v1.4)
  const fwIds = [fw1Id];
  for (let i = 1; i <= 4; i++) {
    const bin = createEsp32Binary(`v1.${i}.0`, 2048 + i * 100);
    const res = await fetch(`${BASE_URL}/api/kiosk/admin/firmware`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        raw_base64: bin.toString('base64'),
        note: `Release 1.${i}`
      })
    });
    assert.equal(res.status, 201);
    const d = await res.json();
    fwIds.push(d.firmware.id);
  }

  // Verify list: max 3 versions retained
  const resList = await fetch(`${BASE_URL}/api/kiosk/admin/firmware`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  assert.equal(resList.status, 200);
  const dataList = await resList.json();
  assert.equal(dataList.ok, true);
  assert(dataList.firmwares.length <= 3);

  // 5. Set target version with policy "now"
  const targetId = fwIds[fwIds.length - 1]; // newest
  const targetFw = dataList.firmwares.find((f) => f.id === targetId);
  const resTarget = await fetch(`${BASE_URL}/api/kiosk/admin/firmware/target`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      firmware_id: targetId,
      policy: 'now'
    })
  });
  assert.equal(resTarget.status, 200);
  const dataTarget = await resTarget.json();
  assert.equal(dataTarget.ok, true);
  assert.equal(dataTarget.target_id, targetId);
  assert.equal(dataTarget.policy, 'now');

  // 6. Attempt deleting target firmware -> must be rejected
  const resDelTarget = await fetch(`${BASE_URL}/api/kiosk/admin/firmware/${targetId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` }
  });
  assert.equal(resDelTarget.status, 400);
  const dataDelTarget = await resDelTarget.json();
  assert.equal(dataDelTarget.error, 'CANNOT_DELETE_TARGET_FIRMWARE');

  // 7. Download firmware file
  const resDown = await fetch(`${BASE_URL}/api/kiosk/files/firmware/${targetId}.bin`);
  assert.equal(resDown.status, 200);
  assert.equal(resDown.headers.get('content-type'), 'application/octet-stream');
  assert.equal(resDown.headers.get('cache-control'), 'public, max-age=86400, immutable');

  // 8. Test processKioskSync response with firmware payload
  let device = await prisma.kioskDevice.findFirst({ where: { is_active: true } });
  if (!device) {
    device = await prisma.kioskDevice.create({
      data: { name: '門口報到機', key_wrapped: 'dummy' }
    });
  }

  const syncPayload = await processKioskSync(prisma, {
    device,
    body: {
      fw: 'v1.0.0', // older version
      status: { fw_state: 'downloading', ota_failed: null }
    },
    clientIp: '127.0.0.1',
    now: new Date()
  });

  assert.ok(syncPayload.firmware);
  assert.equal(syncPayload.firmware.policy, 'now');
  assert.equal(syncPayload.firmware.url, `/api/kiosk/files/firmware/${targetId}.bin`);

  // Device status_json updated
  const updatedDev = await prisma.kioskDevice.findUnique({ where: { id: device.id } });
  assert.equal(updatedDev.status_json.fw_state, 'downloading');

  // 9. When Kiosk reports updated version equal to target, policy auto resets to 'none'
  const syncCompletePayload = await processKioskSync(prisma, {
    device,
    body: {
      fw: targetFw.version,
      status: { fw_state: 'idle', ota_failed: null }
    },
    clientIp: '127.0.0.1',
    now: new Date()
  });
  assert.equal(syncCompletePayload.firmware, null);
  const settingAfterComplete = await prisma.kioskSetting.findUnique({ where: { id: 1 } });
  assert.equal(settingAfterComplete.fw_policy, 'none');

  // 10. When Kiosk reports ota_failed event, policy auto resets to 'none'
  await prisma.kioskSetting.update({
    where: { id: 1 },
    data: { fw_policy: 'now', fw_target_id: targetId }
  });
  const syncFailedPayload = await processKioskSync(prisma, {
    device,
    body: {
      fw: 'v1.0.0',
      events: [{ id: `ev_ota_fail_${Date.now()}`, type: 'ota_failed' }]
    },
    clientIp: '127.0.0.1',
    now: new Date()
  });
  assert.equal(syncFailedPayload.firmware, null);
  const settingAfterFail = await prisma.kioskSetting.findUnique({ where: { id: 1 } });
  assert.equal(settingAfterFail.fw_policy, 'none');

    // Cleanup
    await prisma.kioskFirmware.deleteMany();
    if (admin) {
      await prisma.adminUser.delete({ where: { id: admin.id } }).catch(() => {});
    }
  } finally {
    await testServer.close();
  }
});
