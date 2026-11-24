import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import prisma from '../src/prismaClient.js';
import { startDisplayTestServer } from './helpers/displayTestServer.js';

function makePng(width, height, extraBytes = 0) {
  const buf = Buffer.alloc(32 + extraBytes, 0);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.writeUInt32BE(13, 8);
  buf.write('IHDR', 12, 'ascii');
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  buf[24] = 8;
  buf[25] = 2;
  return buf;
}

test('Display merge security: 4mb slide/settings body limits, >4mb 413, safeHttpUrl LINE guard, and GlobalSetting sanitize', async () => {
  const srv = await startDisplayTestServer();
  const BASE = srv.baseUrl;
  const ts = Date.now();
  const createdSlideIds = [];
  let staffId = null;
  let deviceId = null;
  let origKiosk = null;
  let origGlobal = null;

  try {
    origKiosk = await prisma.kioskSetting.findUnique({ where: { id: 1 } });
    origGlobal = await prisma.globalSetting.findUnique({ where: { id: 1 } });

    const staffPass = `dm_sec_${ts}`;
    const staff = await prisma.adminUser.create({
      data: {
        name: '顯示屏安全整合員',
        password: staffPass,
        permissions: ['settings'],
        is_active: true
      }
    });
    staffId = staff.id;

    const loginRes = await fetch(`${BASE}/api/auth/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: staffPass })
    });
    assert.equal(loginRes.status, 200);
    const { token: adminToken } = await loginRes.json();

    const devPass = `disp_sec_${ts}`;
    const dev = await prisma.displayDevice.create({
      data: {
        name: '安全測試顯示屏',
        password_hash: await bcrypt.hash(devPass, 10)
      }
    });
    deviceId = dev.id;

    const devLogin = await fetch(`${BASE}/api/display/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device_id: dev.id, password: devPass })
    });
    assert.equal(devLogin.status, 200);
    const { token: displayToken } = await devLogin.json();

    // 1. Default 1MB parser blocks >1MB on normal route (/api/display/login) with 413
    {
      const bigBody = JSON.stringify({ device_id: dev.id, password: 'x'.repeat(1.3 * 1024 * 1024) });
      const res = await fetch(`${BASE}/api/display/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: bigBody
      });
      assert.equal(res.status, 413);
      const data = await res.json();
      assert.equal(data.error, '資料太大');
    }

    // 2. POST /api/display/admin/slides allows ~3MB JSON base64 slide upload (decoded <= 2MB) -> 201
    {
      const pngBuf = makePng(1920, 1080, 1950 * 1024); // ~1.95MB raw binary -> ~2.6MB base64
      const dataUrl = `data:image/png;base64,${pngBuf.toString('base64')}`;
      const padNeeded = Math.max(0, 3 * 1024 * 1024 - Buffer.byteLength(dataUrl));
      const payload = JSON.stringify({
        set: 'self',
        title: '3MB測試輪播圖',
        seconds: 8,
        data_base64: dataUrl,
        note_pad: 'a'.repeat(padNeeded + 1024)
      });
      assert.ok(Buffer.byteLength(payload) > 3 * 1024 * 1024, 'Payload should exceed 3MB');
      assert.ok(Buffer.byteLength(payload) < 4 * 1024 * 1024, 'Payload should stay below 4MB');

      const res = await fetch(`${BASE}/api/display/admin/slides`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
        body: payload
      });
      assert.equal(res.status, 201, `Expected 201 for 3MB JSON base64 slide, got ${res.status}`);
      const d = await res.json();
      assert.equal(d.ok, true);
      createdSlideIds.push(d.slide.id);
    }

    // 3. POST /api/display/admin/slides rejects >4MB with 413
    {
      const over4mb = JSON.stringify({
        set: 'self',
        title: '4.2MB過大',
        data_base64: 'A'.repeat(4.2 * 1024 * 1024)
      });
      const res = await fetch(`${BASE}/api/display/admin/slides`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
        body: over4mb
      });
      assert.equal(res.status, 413);
      const d = await res.json();
      assert.equal(d.error, '資料太大');
    }

    // 4. PUT /api/display/admin/settings allows >1MB (<4MB) TWQR upload & rejects >4MB with 413
    {
      const tinyPngB64 = makePng(64, 64, 900 * 1024).toString('base64'); // ~1.2MB base64 data URL
      const okBody = JSON.stringify({
        twqr_mode: 'img',
        twqr_raw_image: `data:image/png;base64,${tinyPngB64}`,
        twqr_use_raw_image: true
      });
      assert.ok(Buffer.byteLength(okBody) > 1024 * 1024 && Buffer.byteLength(okBody) < 4 * 1024 * 1024);
      const resOk = await fetch(`${BASE}/api/display/admin/settings`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
        body: okBody
      });
      // May succeed (200) or fail TWQR decode if not QR, either way MUST NOT be 413
      assert.notEqual(resOk.status, 413, '1.2MB settings upload must not hit 1MB global 413 cap');

      const over4mb = JSON.stringify({
        twqr_mode: 'img',
        twqr_raw_image: `data:image/png;base64,${'A'.repeat(4.2 * 1024 * 1024)}`
      });
      const res413 = await fetch(`${BASE}/api/display/admin/settings`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
        body: over4mb
      });
      assert.equal(res413.status, 413);
    }

    // 5. Reject unsafe line_url (422 INVALID_URL) & sanitize unsafe DB line_url in /api/display/state
    {
      const badRes = await fetch(`${BASE}/api/display/admin/settings`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ line_url: 'javascript:alert(1)' })
      });
      assert.equal(badRes.status, 422);
      const badBody = await badRes.json();
      assert.equal(badBody.code, 'INVALID_URL');

      await prisma.kioskSetting.upsert({
        where: { id: 1 },
        update: { line_url: 'javascript:evil()' },
        create: { id: 1, line_url: 'javascript:evil()' }
      });
      await prisma.globalSetting.upsert({
        where: { id: 1 },
        update: { official_line_url: 'javascript:bad1()', line_button_url: 'data:text/html,bad2' },
        create: { id: 1, official_line_url: 'javascript:bad1()', line_button_url: 'data:text/html,bad2' }
      });
      const stateRes = await fetch(`${BASE}/api/display/state`, {
        headers: { Authorization: `Bearer ${displayToken}` }
      });
      assert.equal(stateRes.status, 200);
      const state = await stateRes.json();
      assert.equal(state.line.url, '', 'Unsafe DB line_url must not leak into display state');
    }

    // 6. PUT /api/daily-settings/global keeps sanitizeGlobalSetting while notifying displayBus
    {
      const testToken = `TEST-MERGE-TOKEN-${crypto.randomBytes(4).toString('hex')}`;
      await prisma.globalSetting.upsert({
        where: { id: 1 },
        update: { line_messaging_token: testToken },
        create: { id: 1, line_messaging_token: testToken }
      });
      const putRes = await fetch(`${BASE}/api/daily-settings/global`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          payment_methods_json: [
            { key: 'cash', label: '現金', enabled: true },
            { key: 'transfer', label: '轉帳', enabled: true },
            { key: 'linepay', label: 'LINE Pay', enabled: false },
            { key: 'card', label: '信用卡', enabled: true },
            { key: 'pass', label: '體驗券 / 票券', enabled: true }
          ]
        })
      });
      assert.equal(putRes.status, 200);
      const putBody = await putRes.json();
      const rawJson = JSON.stringify(putBody);
      assert.equal(rawJson.includes(testToken), false, 'GlobalSetting response must sanitize line_messaging_token');
      assert.equal(rawJson.includes('"line_messaging_token"'), false);
      assert.equal(putBody.setting.has_line_messaging_token, true);
    }
  } finally {
    if (createdSlideIds.length) {
      await prisma.displaySlide.deleteMany({ where: { id: { in: createdSlideIds } } });
    }
    if (deviceId) await prisma.displayDevice.deleteMany({ where: { id: deviceId } });
    if (staffId) await prisma.adminUser.deleteMany({ where: { id: staffId } });
    if (origKiosk) {
      await prisma.kioskSetting.update({
        where: { id: 1 },
        data: { line_url: origKiosk.line_url, line_id: origKiosk.line_id }
      }).catch(() => {});
    }
    if (origGlobal) {
      await prisma.globalSetting.update({
        where: { id: 1 },
        data: {
          official_line_url: origGlobal.official_line_url,
          line_button_url: origGlobal.line_button_url,
          line_messaging_token: origGlobal.line_messaging_token,
          payment_methods_json: origGlobal.payment_methods_json
        }
      }).catch(() => {});
    }
    await prisma.displaySetting.deleteMany({ where: { id: 1 } }).catch(() => {});
    await srv.close();
  }
});
