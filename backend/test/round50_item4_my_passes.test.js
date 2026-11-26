import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import cookieParser from 'cookie-parser';
import prisma from '../src/prismaClient.js';
import { generateToken } from '../src/middlewares/authMiddleware.js';
import passRoutes from '../src/routes/passes.js';

function startLocalApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/passes', passRoutes);
  const server = http.createServer(app);
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', (err) => {
      if (err) return reject(err);
      resolve({
        baseUrl: `http://127.0.0.1:${server.address().port}`,
        close: () => new Promise((res) => server.close(res))
      });
    });
  });
}

test('Round 50 Item 4: GET /api/passes/my computes display_status without DB mutation and returns sanitized latest 20 usage logs', async () => {
  const ts = Date.now();
  let user = null;
  let plan = null;
  const createdPassIds = [];
  let srv = null;

  try {
    user = await prisma.user.create({
      data: {
        name: 'R50 Passes User',
        phone: `0955${String(ts).slice(-6)}`,
        line_user_id: `r50_pass_${ts}`
      }
    });
    plan = await prisma.passPlan.create({
      data: {
        code: `r50_plan_${ts}`,
        name: 'R50 計次方案',
        pass_type: 'PUNCH_CARD',
        price: 1000,
        total_quota: 5,
        is_active: true
      }
    });

    const pastDate = new Date(Date.now() - 86400000);
    const futureDate = new Date(Date.now() + 7 * 86400000);
    const baseLogs = [];
    for (let i = 1; i <= 25; i++) {
      baseLogs.push({
        at: new Date(Date.UTC(2026, 10, 1, 10, i, 0)).toISOString(),
        use_date: '2026-11-01',
        booking_ref: `aa11bb22cc33${String(i).padStart(4, '0')}`,
        payment_no: `PAY-${i}`,
        person_no: 1,
        units: 1,
        type: i === 25 ? 'restore' : 'deduct',
        by: `Staff_${i}`,
        source: 'checkout'
      });
    }

    const specs = [
      { key: 'usable', status: 'ACTIVE', payment_status: 'active', remaining_quota: 3, expires_at: futureDate, logs: baseLogs },
      { key: 'expired_by_date', status: 'ACTIVE', payment_status: 'active', remaining_quota: 2, expires_at: pastDate, logs: [] },
      { key: 'used_up', status: 'ACTIVE', payment_status: 'active', remaining_quota: 0, expires_at: futureDate, logs: [] },
      { key: 'unpaid', status: 'ACTIVE', payment_status: 'pending_payment', remaining_quota: 5, expires_at: futureDate, logs: [] },
      { key: 'revoked', status: 'REVOKED', payment_status: 'active', remaining_quota: 5, expires_at: futureDate, logs: [] }
    ];

    const byKey = {};
    for (const sp of specs) {
      const created = await prisma.userPass.create({
        data: {
          pass_code: `PASS-R50-${ts}-${sp.key}`,
          user_id: user.id,
          plan_id: plan.id,
          plan_name_snapshot: 'R50 計次方案',
          pass_type: 'PUNCH_CARD',
          remaining_quota: sp.remaining_quota,
          total_quota: 5,
          status: sp.status,
          payment_status: sp.payment_status,
          expires_at: sp.expires_at,
          usage_logs_json: sp.logs
        }
      });
      createdPassIds.push(created.id);
      byKey[sp.key] = created;
    }

    const token = generateToken({ id: user.id, role: 'customer', typ: 'customer' });
    srv = await startLocalApp();

    const res = await fetch(`${srv.baseUrl}/api/passes/my`, {
      headers: { Cookie: `token=${token}` }
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.length, 5);

    const mapByCode = Object.fromEntries(body.map((p) => [p.pass_code, p]));
    assert.equal(mapByCode[byKey.usable.pass_code].display_status, 'usable');
    assert.equal(mapByCode[byKey.expired_by_date.pass_code].display_status, 'expired');
    assert.equal(mapByCode[byKey.used_up.pass_code].display_status, 'used_up');
    assert.equal(mapByCode[byKey.unpaid.pass_code].display_status, 'unpaid');
    assert.equal(mapByCode[byKey.revoked.pass_code].display_status, 'revoked');

    // Verify raw usage_logs_json is stripped and usage has newest 20 without by/payment_no
    for (const p of body) {
      assert.equal(p.usage_logs_json, undefined);
      assert.ok(Array.isArray(p.usage));
    }

    const usableRes = mapByCode[byKey.usable.pass_code];
    assert.equal(usableRes.usage.length, 20);
    assert.equal(usableRes.usage[0].type, 'restore');
    assert.equal(usableRes.usage[0].booking_ref, 'BK-AA11-0025');
    assert.equal(usableRes.usage[0].by, undefined);
    assert.equal(usableRes.usage[0].payment_no, undefined);
    assert.equal(usableRes.usage[1].type, 'deduct');
    assert.equal(usableRes.usage[1].booking_ref, 'BK-AA11-0024');
    // Oldest of the 20 retained logs is entry #6
    assert.equal(usableRes.usage[19].booking_ref, 'BK-AA11-0006');

    // Verify expired-by-date row remained status='ACTIVE' in DB (display-only!)
    const dbRow = await prisma.userPass.findUnique({ where: { id: byKey.expired_by_date.id } });
    assert.equal(dbRow.status, 'ACTIVE');
  } finally {
    if (srv) await srv.close();
    if (createdPassIds.length > 0) {
      await prisma.userPass.deleteMany({ where: { id: { in: createdPassIds } } });
    }
    if (plan) await prisma.passPlan.deleteMany({ where: { id: plan.id } });
    if (user) await prisma.user.deleteMany({ where: { id: user.id } });
  }
});
