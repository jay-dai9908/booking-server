import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import bcrypt from 'bcryptjs';
import prisma from '../src/prismaClient.js';
import { invalidateDisplayAuthCache } from '../src/middlewares/displayAuth.js';
import { resetDisplayBusForTests } from '../src/services/display/displayBus.js';
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
        waitForEvent(predicate, timeoutMs = 3000) {
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

test('Round 29 Item 3: Staff message push/replace/clear, validation, permissions, and audit logging', async () => {
  const srv = await startDisplayTestServer();
  const BASE = srv.baseUrl;
  const ts = Date.now();
  const created = { staffIds: [], deviceId: null };

  try {
    invalidateDisplayAuthCache();
    resetDisplayBusForTests();

    const floorPass = `msg_flr_${ts}`;
    const floorStaff = await prisma.adminUser.create({
      data: { name: 'Floor Push Staff', password: floorPass, role: 'staff', permissions: ['reservations'], is_active: true }
    });
    created.staffIds.push(floorStaff.id);

    const noPermPass = `msg_nop_${ts}`;
    const noPermStaff = await prisma.adminUser.create({
      data: { name: 'Settings Only Staff', password: noPermPass, role: 'staff', permissions: ['settings'], is_active: true }
    });
    created.staffIds.push(noPermStaff.id);

    const floorToken = (await (await fetch(`${BASE}/api/auth/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: floorPass })
    })).json()).token;

    const noPermToken = (await (await fetch(`${BASE}/api/auth/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: noPermPass })
    })).json()).token;

    const devPass = `disp_msg_${ts}`;
    const dev = await prisma.displayDevice.create({
      data: { name: `Msg Display ${ts}`, password_hash: await bcrypt.hash(devPass, 10), token_version: 1 }
    });
    created.deviceId = dev.id;
    const displayToken = (await (await fetch(`${BASE}/api/display/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device_id: dev.id, password: devPass })
    })).json()).token;

    // 1. Permission check: unpermitted user gets 403
    {
      const r403Post = await fetch(`${BASE}/api/display/message`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${noPermToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'A1 請到櫃檯' })
      });
      assert.equal(r403Post.status, 403);

      const r403Del = await fetch(`${BASE}/api/display/message`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${noPermToken}` }
      });
      assert.equal(r403Del.status, 403);
    }

    // 2. Validation checks: empty / whitespace-only -> 422; > 40 chars -> 422
    {
      const rEmpty = await fetch(`${BASE}/api/display/message`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${floorToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: '  \n\r  ' })
      });
      assert.equal(rEmpty.status, 422);

      const rLong = await fetch(`${BASE}/api/display/message`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${floorToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: '一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十超' }) // 41 chars
      });
      assert.equal(rLong.status, 422);
    }

    // 3. Push, replace, and clear over SSE + audit log verification
    const sse = await openSseClient(`${BASE}/api/display/stream?token=${encodeURIComponent(displayToken)}`);
    try {
      await sse.waitForEvent((e) => e.event === 'state');

      // Push first message (with newlines that must be stripped)
      sse.events.length = 0;
      const rPush1 = await fetch(`${BASE}/api/display/message`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${floorToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: '  A3 桌的客人\n請到櫃檯一下  ' })
      });
      assert.equal(rPush1.status, 200);
      const ev1 = await sse.waitForEvent((e) => e.event === 'message' && e.data?.active === true);
      assert.equal(ev1.data.text, 'A3 桌的客人 請到櫃檯一下');

      // Replace with second message
      sse.events.length = 0;
      const rPush2 = await fetch(`${BASE}/api/display/message`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${floorToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'B2 桌作品完成' })
      });
      assert.equal(rPush2.status, 200);
      const ev2 = await sse.waitForEvent((e) => e.event === 'message' && e.data?.text === 'B2 桌作品完成');
      assert.equal(ev2.data.active, true);

      // Clear message
      sse.events.length = 0;
      const rDel = await fetch(`${BASE}/api/display/message`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${floorToken}` }
      });
      assert.equal(rDel.status, 200);
      const evClear = await sse.waitForEvent((e) => e.event === 'message' && e.data?.active === false);
      assert.equal(evClear.data.active, false);

      // Verify audit logs created
      const logs = await prisma.accountingEvent.findMany({
        where: {
          staff_id: floorStaff.id,
          event_type: { in: ['display_message_push', 'display_message_clear'] }
        },
        orderBy: { id: 'asc' }
      });
      assert.ok(logs.some((l) => l.event_type === 'display_message_push' && l.summary.includes('B2 桌作品完成')));
      assert.ok(logs.some((l) => l.event_type === 'display_message_clear'));
    } finally {
      sse.close();
    }
  } finally {
    resetDisplayBusForTests();
    if (created.deviceId) await prisma.displayDevice.deleteMany({ where: { id: created.deviceId } });
    if (created.staffIds.length) await prisma.adminUser.deleteMany({ where: { id: { in: created.staffIds } } });
    await srv.close();
  }
});
