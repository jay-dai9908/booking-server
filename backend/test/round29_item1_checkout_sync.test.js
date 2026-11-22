import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import bcrypt from 'bcryptjs';
import prisma from '../src/prismaClient.js';
import { dateOnly, toTaipeiDateString } from '../../shared/time.js';
import { getBookingBill } from '../src/services/billing/billService.js';
import { invalidateDisplayAuthCache } from '../src/middlewares/displayAuth.js';
import { resetDisplayBusForTests } from '../src/services/display/displayBus.js';
import { clearDisplayLoginFailures } from '../src/controllers/displayDeviceController.js';
import { startDisplayTestServer } from './helpers/displayTestServer.js';

function openSseClient(url) {
  return new Promise((resolve, reject) => {
    const events = [];
    let buffer = '';
    let settled = false;

    const req = http.get(url, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`SSE status ${res.statusCode}`));
        return;
      }
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        buffer += chunk;
        const parts = buffer.split('\n\n');
        buffer = parts.pop() || '';
        for (const part of parts) {
          const lines = part.split('\n');
          let evName = 'message';
          let dataStr = '';
          for (const ln of lines) {
            if (ln.startsWith('event:')) evName = ln.slice(6).trim();
            else if (ln.startsWith('data:')) dataStr += ln.slice(5).trim();
          }
          if (dataStr) {
            try {
              events.push({ event: evName, data: JSON.parse(dataStr) });
            } catch {
              events.push({ event: evName, data: dataStr });
            }
          }
        }
      });

      const handle = {
        events,
        waitForEvent(predicate, timeoutMs = 4000) {
          return new Promise((resEv, rejEv) => {
            const start = Date.now();
            const check = () => {
              const found = events.find(predicate);
              if (found) return resEv(found);
              if (Date.now() - start > timeoutMs) {
                return rejEv(new Error(`Timeout waiting for SSE event; got: ${events.map((e) => e.event).join(',')}`));
              }
              setTimeout(check, 40);
            };
            check();
          });
        },
        close() {
          req.destroy();
        }
      };
      if (!settled) {
        settled = true;
        resolve(handle);
      }
    });
    req.on('error', (err) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    });
  });
}

test('Round 29 Item 1: Checkout sync server recomputation, split/single-active/close guards, dynamic payment methods, and privacy', async () => {
  const srv = await startDisplayTestServer();
  const BASE = srv.baseUrl;
  const ts = Date.now();
  const todayStr = toTaipeiDateString(new Date());
  const todayDate = dateOnly(todayStr);

  const created = {
    staffId: null,
    deviceId: null,
    userId: null,
    bookingRefs: [],
    prevPaymentMethods: null
  };

  try {
    clearDisplayLoginFailures();
    invalidateDisplayAuthCache();
    resetDisplayBusForTests();

    const gsBefore = await prisma.globalSetting.findUnique({ where: { id: 1 } });
    created.prevPaymentMethods = gsBefore?.payment_methods_json ?? null;

    const staffPass = `co_adm_${ts}`;
    const staff = await prisma.adminUser.create({
      data: { name: 'Checkout Admin', password: staffPass, role: 'staff', permissions: ['settings', 'reservations', 'accounting'], is_active: true }
    });
    created.staffId = staff.id;

    const adminLogin = await fetch(`${BASE}/api/auth/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: staffPass })
    });
    const adminToken = (await adminLogin.json()).token;

    const devPass = `disp_co_${ts}`;
    const dev = await prisma.displayDevice.create({
      data: { name: `CO Display ${ts}`, password_hash: await bcrypt.hash(devPass, 10), token_version: 1 }
    });
    created.deviceId = dev.id;

    const dispLogin = await fetch(`${BASE}/api/display/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device_id: dev.id, password: devPass })
    });
    const displayToken = (await dispLogin.json()).token;

    const piiName = '林保密結帳人';
    const piiPhone = '0987654321';
    const user = await prisma.user.create({
      data: { line_user_id: `U_co_${ts}`, name: piiName, phone: piiPhone }
    });
    created.userId = user.id;

    const s1 = await prisma.session.upsert({
      where: { session_date_start_time: { session_date: todayDate, start_time: '13:00' } },
      update: {},
      create: { session_date: todayDate, start_time: '13:00', end_time: '15:00', max_capacity: 20 }
    });

    const refA = `BK-R29A-${ts}`;
    const refB = `BK-R29B-${ts}`;
    created.bookingRefs.push(refA, refB);

    const tStart = new Date(`${todayStr}T13:00:00+08:00`);
    await prisma.reservation.create({
      data: {
        booking_ref: refA,
        session_id: s1.id,
        user_id: user.id,
        pax: 2,
        assigned_seats: ['A2-1', 'A2-2'],
        attendance: 'checked_in',
        checked_in_at: tStart
      }
    });
    await prisma.bookingPerson.createMany({
      data: [
        { booking_ref: refA, person_no: 1, seat_code: 'A2-1', status: 'active', billing_start_at: tStart, timer_started_at: tStart },
        { booking_ref: refA, person_no: 2, seat_code: 'A2-2', status: 'active', billing_start_at: tStart, timer_started_at: tStart }
      ]
    });

    // Mark person 2 as already paid via Payment row
    await prisma.payment.create({
      data: {
        payment_no: `R-R29-${ts}`,
        batch_no: `B-R29-${ts}`,
        booking_ref: refA,
        kind: 'charge',
        status: 'valid',
        method: 'cash',
        amount: 200,
        person_nos: [2],
        breakdown_json: {
          persons: [{ person_no: 2, seat_code: 'A2-2', entry: { mode: 'hourly', hours: 2, amount: 200 }, board: { amount: 0, units: [] }, addons: [], shares: [], promos: [], total: 200 }]
        },
        staff_name: 'Checkout Admin',
        device_label: '測試'
      }
    });

    await prisma.reservation.create({
      data: {
        booking_ref: refB,
        session_id: s1.id,
        user_id: user.id,
        pax: 1,
        assigned_seats: ['B1-1'],
        attendance: 'checked_in',
        checked_in_at: tStart
      }
    });
    await prisma.bookingPerson.create({
      data: { booking_ref: refB, person_no: 1, seat_code: 'B1-1', status: 'active', billing_start_at: tStart, timer_started_at: tStart }
    });

    // Configure dynamic payment_methods_json: disable linepay, add custom method, ensure no easycard
    await fetch(`${BASE}/api/daily-settings/global`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        payment_methods_json: [
          { key: 'cash', label: '現金', enabled: true },
          { key: 'linepay', label: 'LINE Pay', enabled: false },
          { key: 'transfer', label: '銀行轉帳', enabled: true },
          { key: 'custom_epay', label: '街口掃碼', enabled: true }
        ]
      })
    });

    const sse = await openSseClient(`${BASE}/api/display/stream?token=${encodeURIComponent(displayToken)}`);
    try {
      await sse.waitForEvent((e) => e.event === 'state');

      // 1. Open booking A with tampered amount from client -> server must use getBookingBill
      sse.events.length = 0;
      const expectedBillA = await getBookingBill(refA);
      const expectedP1Total = expectedBillA.bill.persons.find((p) => p.person_no === 1).total;

      const rOpenA = await fetch(`${BASE}/api/display/checkout`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          booking_ref: refA,
          phase: 'open',
          person_nos: [1],
          amount_due: 1, // tampered client value must be ignored
          total: 1
        })
      });
      assert.equal(rOpenA.status, 200);
      const evOpenA = await sse.waitForEvent((e) => e.event === 'checkout' && e.data?.phase === 'open');
      assert.equal(evOpenA.data.amount_due, expectedP1Total);
      assert.equal(evOpenA.data.persons.find((p) => p.person_no === 2).paid, true);
      assert.equal(evOpenA.data.persons.find((p) => p.person_no === 1).paid, false);
      assert.deepEqual(evOpenA.data.selected_person_nos, [1]);

      // Payment methods check: no linepay (disabled), no easycard, custom_epay present with label
      const methodKeys = evOpenA.data.payment_methods.map((m) => m.key);
      assert.equal(methodKeys.includes('linepay'), false);
      assert.equal(methodKeys.includes('easycard'), false);
      assert.equal(methodKeys.includes('custom_epay'), true);
      assert.equal(evOpenA.data.payment_methods.find((m) => m.key === 'custom_epay').label, '街口掃碼');

      // Privacy scan on checkout payload
      const coJson = JSON.stringify(evOpenA.data);
      assert.equal(coJson.includes(piiName), false);
      assert.equal(coJson.includes(piiPhone), false);
      assert.equal(coJson.includes(refA), false);

      // 2. Selecting disabled method ('linepay') treats method as null
      sse.events.length = 0;
      await fetch(`${BASE}/api/display/checkout`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ booking_ref: refA, phase: 'method', person_nos: [1], method: 'linepay' })
      });
      const evDisabledMethod = await sse.waitForEvent((e) => e.event === 'checkout' && e.data?.phase === 'method');
      assert.equal(evDisabledMethod.data.method, null);

      // 3. Selecting cash + cash_received computes change; selecting custom_epay sets label
      sse.events.length = 0;
      await fetch(`${BASE}/api/display/checkout`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ booking_ref: refA, phase: 'method', person_nos: [1], method: 'cash', cash_received: 2000 })
      });
      const evCash = await sse.waitForEvent((e) => e.event === 'checkout' && e.data?.method === 'cash');
      assert.equal(evCash.data.cash_received, 2000);
      assert.equal(evCash.data.change, 2000 - expectedP1Total);

      sse.events.length = 0;
      await fetch(`${BASE}/api/display/checkout`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ booking_ref: refA, phase: 'method', person_nos: [1], method: 'custom_epay' })
      });
      const evCustom = await sse.waitForEvent((e) => e.event === 'checkout' && e.data?.method === 'custom_epay');
      assert.equal(evCustom.data.method_label, '街口掃碼');

      // 4. Open booking B replaces A; closing A must NOT close B!
      sse.events.length = 0;
      await fetch(`${BASE}/api/display/checkout`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ booking_ref: refB, phase: 'open' })
      });
      const evOpenB = await sse.waitForEvent((e) => e.event === 'checkout' && e.data?.seats?.includes('B1-1'));
      assert.equal(evOpenB.data.active, true);

      sse.events.length = 0;
      const rCloseOld = await fetch(`${BASE}/api/display/checkout`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ booking_ref: refA, phase: 'close' })
      });
      assert.equal(rCloseOld.status, 200);
      assert.equal((await rCloseOld.json()).closed, false);

      // Verify state still holds B active
      const stateAfterOldClose = await (await fetch(`${BASE}/api/display/state`, {
        headers: { Authorization: `Bearer ${displayToken}` }
      })).json();
      assert.equal(stateAfterOldClose.checkout?.active, true);
      assert.ok(stateAfterOldClose.checkout?.seats?.includes('B1-1'));

      // Closing B clears checkout
      const rCloseB = await fetch(`${BASE}/api/display/checkout`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ booking_ref: refB, phase: 'close' })
      });
      assert.equal((await rCloseB.json()).closed, true);
      await sse.waitForEvent((e) => e.event === 'checkout' && e.data?.active === false);
    } finally {
      sse.close();
    }
  } finally {
    resetDisplayBusForTests();
    clearDisplayLoginFailures();
    if (created.prevPaymentMethods !== null) {
      await prisma.globalSetting.update({ where: { id: 1 }, data: { payment_methods_json: created.prevPaymentMethods } }).catch(() => {});
    }
    await prisma.payment.deleteMany({ where: { booking_ref: { in: created.bookingRefs } } });
    await prisma.bookingPerson.deleteMany({ where: { booking_ref: { in: created.bookingRefs } } });
    await prisma.reservation.deleteMany({ where: { booking_ref: { in: created.bookingRefs } } });
    if (created.userId) await prisma.user.deleteMany({ where: { id: created.userId } });
    if (created.deviceId) await prisma.displayDevice.deleteMany({ where: { id: created.deviceId } });
    if (created.staffId) await prisma.adminUser.deleteMany({ where: { id: created.staffId } });
    await srv.close();
  }
});
