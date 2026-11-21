import test from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import prisma from '../src/prismaClient.js';
import { generateToken } from '../src/middlewares/authMiddleware.js';
import { clearDisplayLoginFailures } from '../src/controllers/displayDeviceController.js';
import { invalidateDisplayAuthCache } from '../src/middlewares/displayAuth.js';
import { resetDisplayBusForTests } from '../src/services/display/displayBus.js';
import { startDisplayTestServer } from './helpers/displayTestServer.js';

test('Round 28 Item 1: DisplayDevice login, token isolation, logout/password invalidation, and rate limiting', async () => {
  const srv = await startDisplayTestServer();
  const BASE = srv.baseUrl;
  const ts = Date.now();
  const createdIds = { staff: [], users: [], devices: [] };

  try {
    clearDisplayLoginFailures();
    invalidateDisplayAuthCache();

    // Setup: staff with settings permission, staff without settings permission, and customer user
    const settingsStaffPass = `set_pwd_${ts}`;
    const settingsStaff = await prisma.adminUser.create({
      data: { name: 'Settings Staff', password: settingsStaffPass, role: 'staff', permissions: ['settings'], is_active: true }
    });
    createdIds.staff.push(settingsStaff.id);

    const floorStaffPass = `flr_pwd_${ts}`;
    const floorStaff = await prisma.adminUser.create({
      data: { name: 'Floor Staff', password: floorStaffPass, role: 'staff', permissions: ['reservations'], is_active: true }
    });
    createdIds.staff.push(floorStaff.id);

    const customer = await prisma.user.create({
      data: { line_user_id: `U_r28_item1_${ts}`, name: '顯示屏測試會員', phone: '0900111222' }
    });
    createdIds.users.push(customer.id);

    const loginAdmin = async (password) => {
      const r = await fetch(`${BASE}/api/auth/admin/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password })
      });
      assert.equal(r.status, 200);
      return (await r.json()).token;
    };

    const settingsToken = await loginAdmin(settingsStaffPass);
    const floorToken = await loginAdmin(floorStaffPass);
    const customerToken = generateToken({ id: customer.id, role: 'customer' });

    // 1. Permission check: floorStaff without 'settings' gets 403 on display admin endpoints
    {
      const r = await fetch(`${BASE}/api/display/admin/devices`, {
        headers: { Authorization: `Bearer ${floorToken}` }
      });
      assert.equal(r.status, 403);
    }

    // 2. Password min 8 chars validation
    {
      const r = await fetch(`${BASE}/api/display/admin/devices`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${settingsToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: '櫃檯顯示屏', password: 'short' })
      });
      assert.equal(r.status, 422);
    }

    // 3. Create display device & verify password_hash is never returned
    const devPass1 = `displayPass_${ts}_1`;
    let deviceId;
    {
      const r = await fetch(`${BASE}/api/display/admin/devices`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${settingsToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: `櫃檯顯示屏_${ts}`, password: devPass1 })
      });
      assert.equal(r.status, 201);
      const data = await r.json();
      assert.ok(data.device?.id);
      assert.equal(data.device.password_hash, undefined);
      assert.equal(data.device.token_version, 1);
      deviceId = data.device.id;
      createdIds.devices.push(deviceId);

      // Verify DB stores bcrypt hash ($2a$ or $2b$)
      const dbRow = await prisma.displayDevice.findUnique({ where: { id: deviceId } });
      assert.ok(dbRow.password_hash.startsWith('$2'));
      assert.notEqual(dbRow.password_hash, devPass1);
    }

    // 4. List devices never returns password_hash
    {
      const r = await fetch(`${BASE}/api/display/admin/devices`, {
        headers: { Authorization: `Bearer ${settingsToken}` }
      });
      assert.equal(r.status, 200);
      const data = await r.json();
      assert.ok(Array.isArray(data.devices));
      for (const d of data.devices) {
        assert.equal('password_hash' in d, false);
      }
    }

    // 5. Login with display device -> get permanent token (no exp)
    let displayToken1;
    {
      const r = await fetch(`${BASE}/api/display/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ device_id: deviceId, password: devPass1 })
      });
      assert.equal(r.status, 200);
      const data = await r.json();
      assert.ok(data.token);
      displayToken1 = data.token;
      const decodedUnverified = jwt.decode(displayToken1);
      assert.equal(decodedUnverified.display_id, deviceId);
      assert.equal(decodedUnverified.tv, 1);
      assert.equal(decodedUnverified.typ, 'display');
      assert.equal(decodedUnverified.exp, undefined);
    }

    // 6. Display token works on displayAuth endpoint
    {
      const r = await fetch(`${BASE}/api/display/state`, {
        headers: { Authorization: `Bearer ${displayToken1}` }
      });
      assert.equal(r.status, 200);
    }

    // 7. Token isolation:
    //    - Display token rejected by /api/reservations/my and admin routes
    //    - Customer & admin tokens rejected by /api/display/state
    {
      const rMy = await fetch(`${BASE}/api/reservations/my`, {
        headers: { Authorization: `Bearer ${displayToken1}` }
      });
      assert.equal(rMy.status, 401);

      const rAdmin = await fetch(`${BASE}/api/display/admin/devices`, {
        headers: { Authorization: `Bearer ${displayToken1}` }
      });
      assert.equal(rAdmin.status, 401);

      const rCustOnDisp = await fetch(`${BASE}/api/display/state`, {
        headers: { Authorization: `Bearer ${customerToken}` }
      });
      assert.equal(rCustOnDisp.status, 401);

      const rAdminOnDisp = await fetch(`${BASE}/api/display/state`, {
        headers: { Authorization: `Bearer ${settingsToken}` }
      });
      assert.equal(rAdminOnDisp.status, 401);
    }

    // 8. Logout device -> token_version increments -> old token returns 401 DISPLAY_LOGGED_OUT
    {
      const rOut = await fetch(`${BASE}/api/display/admin/devices/${deviceId}/logout`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${settingsToken}` }
      });
      assert.equal(rOut.status, 200);
      const outData = await rOut.json();
      assert.equal(outData.device.token_version, 2);

      const rState = await fetch(`${BASE}/api/display/state`, {
        headers: { Authorization: `Bearer ${displayToken1}` }
      });
      assert.equal(rState.status, 401);
      const errData = await rState.json();
      assert.equal(errData.error, 'DISPLAY_LOGGED_OUT');
    }

    // 9. Re-login, then change password -> old token returns 401 DISPLAY_LOGGED_OUT, new password works
    const rLogin2 = await fetch(`${BASE}/api/display/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device_id: deviceId, password: devPass1 })
    });
    assert.equal(rLogin2.status, 200);
    const displayToken2 = (await rLogin2.json()).token;

    const devPass2 = `displayPass_${ts}_2`;
    {
      const rPw = await fetch(`${BASE}/api/display/admin/devices/${deviceId}/password`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${settingsToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: devPass2 })
      });
      assert.equal(rPw.status, 200);
      assert.equal((await rPw.json()).device.password_hash, undefined);

      const rStateOld = await fetch(`${BASE}/api/display/state`, {
        headers: { Authorization: `Bearer ${displayToken2}` }
      });
      assert.equal(rStateOld.status, 401);
      assert.equal((await rStateOld.json()).error, 'DISPLAY_LOGGED_OUT');

      // Old password fails
      const rOldPw = await fetch(`${BASE}/api/display/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ device_id: deviceId, password: devPass1 })
      });
      assert.equal(rOldPw.status, 401);

      // New password succeeds
      const rNewPw = await fetch(`${BASE}/api/display/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ device_id: deviceId, password: devPass2 })
      });
      assert.equal(rNewPw.status, 200);
    }

    // 10. Rate limit: 10 failed logins from same IP -> 11th returns 429
    clearDisplayLoginFailures();
    for (let i = 0; i < 10; i++) {
      const rFail = await fetch(`${BASE}/api/display/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ device_id: deviceId, password: 'wrong-password-123' })
      });
      assert.equal(rFail.status, 401, `Attempt ${i + 1} should return 401`);
    }
    const rBlocked = await fetch(`${BASE}/api/display/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device_id: deviceId, password: devPass2 })
    });
    assert.equal(rBlocked.status, 429);
  } finally {
    clearDisplayLoginFailures();
    resetDisplayBusForTests();
    if (createdIds.devices.length) {
      await prisma.displayDevice.deleteMany({ where: { id: { in: createdIds.devices } } });
    }
    if (createdIds.users.length) {
      await prisma.user.deleteMany({ where: { id: { in: createdIds.users } } });
    }
    if (createdIds.staff.length) {
      await prisma.adminUser.deleteMany({ where: { id: { in: createdIds.staff } } });
    }
    await srv.close();
  }
});
