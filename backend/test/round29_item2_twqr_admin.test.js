import test from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import prisma from '../src/prismaClient.js';
import { buildTransferPayload } from '../../shared/twqr.js';
import { dateOnly, toTaipeiDateString } from '../../shared/time.js';
import { invalidateDisplayAuthCache } from '../src/middlewares/displayAuth.js';
import { resetDisplayBusForTests } from '../src/services/display/displayBus.js';
import { startDisplayTestServer } from './helpers/displayTestServer.js';

test('Round 29 Item 2: TWQR admin configuration, validation, masking, and state isolation', async () => {
  const srv = await startDisplayTestServer();
  const BASE = srv.baseUrl;
  const ts = Date.now();
  const todayStr = toTaipeiDateString(new Date());
  const todayDate = dateOnly(todayStr);

  const created = { staffId: null, deviceId: null, userId: null, bookingRef: `BK-TWQR-${ts}` };

  try {
    invalidateDisplayAuthCache();
    resetDisplayBusForTests();

    const staffPass = `twqr_adm_${ts}`;
    const staff = await prisma.adminUser.create({
      data: { name: 'TWQR Admin', password: staffPass, role: 'staff', permissions: ['settings', 'reservations'], is_active: true }
    });
    created.staffId = staff.id;
    const adminToken = (await (await fetch(`${BASE}/api/auth/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: staffPass })
    })).json()).token;

    const devPass = `disp_twqr_${ts}`;
    const dev = await prisma.displayDevice.create({
      data: { name: `TWQR Display ${ts}`, password_hash: await bcrypt.hash(devPass, 10), token_version: 1 }
    });
    created.deviceId = dev.id;
    const displayToken = (await (await fetch(`${BASE}/api/display/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device_id: dev.id, password: devPass })
    })).json()).token;

    // 1. Reject non-TWQR payload (e.g. https URL) with 422
    {
      const rBad = await fetch(`${BASE}/api/display/admin/settings`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ twqr_mode: 'text', twqr_payload: 'https://example.com/pay' })
      });
      assert.equal(rBad.status, 422);
      assert.equal((await rBad.json()).error, '這不是 TWQR 收款碼內容');
    }

    // 2. Save bank + fake account -> returns parsed last4 & masked display
    const fakeBank = '822';
    const fakeAcct = '000123456789';
    const expectedPayload = buildTransferPayload(fakeBank, fakeAcct);

    {
      const rOk = await fetch(`${BASE}/api/display/admin/settings`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          twqr_mode: 'acct',
          twqr_bank_code: fakeBank,
          twqr_account: fakeAcct,
          twqr_use_raw_image: false,
          twqr_logo_enabled: true
        })
      });
      assert.equal(rOk.status, 200);
      const data = await rOk.json();
      assert.equal(data.setting.twqr_account_last4, '6789');
      assert.equal(data.setting.twqr_parsed?.bank_code, '822');
      assert.equal(data.setting.twqr_parsed?.type, '02');
      assert.equal(data.setting.twqr_parsed?.account_last4, '6789');
      assert.ok(data.setting.twqr_payload_masked.includes('6789'));
      assert.equal(data.setting.twqr_payload_masked.includes(fakeAcct), false);
    }

    // 3. GET /api/display/state NEVER returns twqr_account or twqr_payload
    {
      const rState = await fetch(`${BASE}/api/display/state`, {
        headers: { Authorization: `Bearer ${displayToken}` }
      });
      assert.equal(rState.status, 200);
      const state = await rState.json();
      const rawJson = JSON.stringify(state);
      assert.equal(rawJson.includes(fakeAcct), false);
      assert.equal(rawJson.includes('TWQRP'), false);
      assert.equal('twqr_account' in state, false);
      assert.equal(state.twqr?.has_twqr, true);
      assert.equal(state.twqr?.logo_enabled, true);
    }

    // 4. Checkout with method='transfer' sends encoded payload
    const user = await prisma.user.create({
      data: { line_user_id: `U_twqr_${ts}`, name: 'TWQR客', phone: '0911222333' }
    });
    created.userId = user.id;
    const s1 = await prisma.session.upsert({
      where: { session_date_start_time: { session_date: todayDate, start_time: '15:00' } },
      update: {},
      create: { session_date: todayDate, start_time: '15:00', end_time: '17:00', max_capacity: 20 }
    });
    await prisma.reservation.create({
      data: { booking_ref: created.bookingRef, session_id: s1.id, user_id: user.id, pax: 1, assigned_seats: ['A1-1'], attendance: 'checked_in' }
    });

    const rCo = await fetch(`${BASE}/api/display/checkout`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ booking_ref: created.bookingRef, phase: 'method', method: 'transfer' })
    });
    assert.equal(rCo.status, 200);
    const coData = await rCo.json();
    assert.equal(coData.checkout.twqr?.enabled, true);
    assert.equal(coData.checkout.twqr?.payload, expectedPayload);

    // 5. Text mode with raw TWQRP:// normalizes and encodes
    {
      const rText = await fetch(`${BASE}/api/display/admin/settings`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          twqr_mode: 'text',
          twqr_payload: 'TWQRP://個人轉帳/158/02/V1?D5=013&D6=0000999988887777&D10=901'
        })
      });
      assert.equal(rText.status, 200);
      const dText = await rText.json();
      assert.equal(dText.setting.twqr_parsed?.bank_code, '013');
      assert.equal(dText.setting.twqr_parsed?.account_last4, '7777');
    }
  } finally {
    resetDisplayBusForTests();
    await prisma.displaySetting.update({
      where: { id: 1 },
      data: { twqr_mode: 'acct', twqr_bank_code: '', twqr_account: '', twqr_payload: '' }
    }).catch(() => {});
    await prisma.reservation.deleteMany({ where: { booking_ref: created.bookingRef } });
    if (created.userId) await prisma.user.deleteMany({ where: { id: created.userId } });
    if (created.deviceId) await prisma.displayDevice.deleteMany({ where: { id: created.deviceId } });
    if (created.staffId) await prisma.adminUser.deleteMany({ where: { id: created.staffId } });
    await srv.close();
  }
});
