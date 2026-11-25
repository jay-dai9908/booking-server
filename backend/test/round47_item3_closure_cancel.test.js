import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import prisma from '../src/prismaClient.js';
import { dateOnly } from '../../shared/time.js';
import dailySettingsRoutes from '../src/routes/dailySettings.js';
import { generateToken } from '../src/middlewares/authMiddleware.js';

function signAdmin(adminUser) {
  return generateToken({
    id: adminUser.id,
    role: 'admin',
    name: adminUser.name,
    token_version: adminUser.token_version || 0
  });
}

async function startTestApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/daily-settings', dailySettingsRoutes);

  return await new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve({ server, baseUrl: `http://127.0.0.1:${addr.port}` });
    });
  });
}

test('Round 47 Item 3: Closure impact 4 groups, idempotent batch cancel with manual LINE push, and BOM CSV export', async () => {
  const runId = Date.now();
  const dateStr = '2026-12-02';
  const dateObj = dateOnly(dateStr);
  const poolAccNum = `8220${String(runId).slice(-8)}`;

  const prevPushFn = globalThis.__TEST_LINE_PUSH_FN__;
  const prevGlobal = await prisma.globalSetting.findUnique({ where: { id: 1 } });
  let srv = null;
  const createdSessionIds = [];
  const createdUserIds = [];
  const createdRefs = [];
  const passPlanCode = `R47I3_PLAN_${runId}`;
  const passCode = `R47I3PASS${String(runId).slice(-4)}`;
  const adminPwd = `r47-i3-admin-${runId}`;

  try {
    await prisma.globalSetting.upsert({
      where: { id: 1 },
      update: { line_auto_notify_cancel: true },
      create: { id: 1, line_auto_notify_cancel: true }
    });

    await prisma.dailySetting.deleteMany({ where: { date: dateObj } });

    let session = await prisma.session.findUnique({
      where: { session_date_start_time: { session_date: dateObj, start_time: '13:00' } }
    });
    if (!session) {
      session = await prisma.session.create({
        data: { session_date: dateObj, start_time: '13:00', end_time: '15:00', max_capacity: 20 }
      });
      createdSessionIds.push(session.id);
    } else if (session.closed_at) {
      session = await prisma.session.update({
        where: { id: session.id },
        data: { closed_at: null, closed_by: null }
      });
    }

    const adminUser = await prisma.adminUser.create({
      data: { name: 'R47I3店長', password: adminPwd, role: 'superadmin', permissions: ['all'], is_active: true }
    });
    const adminToken = signAdmin(adminUser);

    const [uA, uB, uC, uD, uE] = await Promise.all([
      prisma.user.create({ data: { name: '顧客A有LINE', phone: `0911${String(runId).slice(-6)}`, line_user_id: `U_R47I3_A_${runId}` } }),
      prisma.user.create({ data: { name: '顧客B無LINE', phone: `0912${String(runId).slice(-6)}`, line_user_id: `manual_${runId}_B` } }),
      prisma.user.create({ data: { name: '顧客C已收現金', phone: `0913${String(runId).slice(-6)}`, line_user_id: `U_R47I3_C_${runId}` } }),
      prisma.user.create({ data: { name: '顧客D扣卡券', phone: `0914${String(runId).slice(-6)}`, line_user_id: `U_R47I3_D_${runId}` } }),
      prisma.user.create({ data: { name: '顧客E待對帳', phone: `0915${String(runId).slice(-6)}`, line_user_id: `U_R47I3_E_${runId}` } })
    ]);
    createdUserIds.push(uA.id, uB.id, uC.id, uD.id, uE.id);

    const plan = await prisma.passPlan.create({
      data: { code: passPlanCode, name: 'R47I3計次卡', pass_type: 'PUNCH_CARD', price: 1000, total_quota: 5, is_active: true }
    });
    const passD = await prisma.userPass.create({
      data: {
        user_id: uD.id,
        plan_id: plan.id,
        pass_code: passCode,
        plan_name_snapshot: plan.name,
        pass_type: 'PUNCH_CARD',
        total_quota: 5,
        remaining_quota: 4,
        payment_status: 'active',
        status: 'ACTIVE',
        expires_at: dateOnly('2099-12-31')
      }
    });

    await prisma.oneTimeAccountPool.create({
      data: {
        payment_method_code: 'ctbc_pool',
        account_number: poolAccNum,
        status: 'ASSIGNED',
        assigned_order_ref: `R47I3-E-${runId}`
      }
    });

    const refA = `R47I3-A-${runId}`;
    const refB = `R47I3-B-${runId}`;
    const refC = `R47I3-C-${runId}`;
    const refD = `R47I3-D-${runId}`;
    const refE = `R47I3-E-${runId}`;
    createdRefs.push(refA, refB, refC, refD, refE);

    await prisma.reservation.createMany({
      data: [
        { booking_ref: refA, session_id: session.id, user_id: uA.id, pax: 2, status: 'confirmed' },
        { booking_ref: refB, session_id: session.id, user_id: uB.id, pax: 1, status: 'confirmed' },
        { booking_ref: refC, session_id: session.id, user_id: uC.id, pax: 2, status: 'confirmed', amount_received: 600, billing_status: 'paid', is_paid: true },
        { booking_ref: refD, session_id: session.id, user_id: uD.id, pax: 1, status: 'confirmed', billing_status: 'paid', is_paid: true },
        { booking_ref: refE, session_id: session.id, user_id: uE.id, pax: 1, status: 'confirmed', is_self_service: true }
      ]
    });

    await prisma.payment.create({
      data: {
        payment_no: `PAY-R47C-${runId}`,
        batch_no: `BATCH-R47C-${runId}`,
        booking_ref: refC,
        method: 'cash',
        kind: 'charge',
        amount: 600,
        status: 'valid',
        staff_name: 'tester',
        device_label: '測試',
        breakdown_json: {}
      }
    });
    await prisma.payment.create({
      data: {
        payment_no: `PAY-R47D-${runId}`,
        batch_no: `BATCH-R47D-${runId}`,
        booking_ref: refD,
        method: 'pass',
        kind: 'charge',
        amount: 0,
        status: 'valid',
        staff_name: 'tester',
        device_label: '測試',
        breakdown_json: {},
        pass_json: [{ user_pass_id: passD.id, units: 1, pass_code: passCode, plan_name: plan.name }]
      }
    });
    await prisma.bookingPrepay.create({
      data: {
        booking_ref: refE,
        user_id: uE.id,
        total_amount: 800,
        amount_due: 800,
        status: 'reported_pending_verify',
        remittance_last5: '12345',
        assigned_pool_account: poolAccNum,
        deadline_at: new Date('2026-12-01T12:00:00+08:00')
      }
    });

    srv = await startTestApp();

    // 1. Before setting closed -> 409
    const notClosedTry = await fetch(`${srv.baseUrl}/api/daily-settings/${dateStr}/closure/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ booking_refs: [refA], notify_line: true })
    });
    assert.equal(notClosedTry.status, 409);

    // 2. Set closed
    const setClosedRes = await fetch(`${srv.baseUrl}/api/daily-settings/day-type`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ date: dateStr, day_type: 'closed', closed_note: '線路檢修' })
    });
    assert.equal(setClosedRes.status, 200);

    // 3. Check closure-impact 4 groups
    const impactRes = await fetch(`${srv.baseUrl}/api/daily-settings/${dateStr}/closure-impact`, {
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    assert.equal(impactRes.status, 200);
    const impact = await impactRes.json();
    assert.deepEqual(impact.groups.direct_cancel.map((i) => i.booking_ref).sort(), [refA, refB].sort());
    assert.equal(impact.groups.need_refund.length, 1);
    assert.equal(impact.groups.need_refund[0].booking_ref, refC);
    assert.equal(impact.groups.need_refund[0].paid_amount, 600);
    assert.equal(impact.groups.need_refund[0].payments[0].method_label, '現金');
    assert.equal(impact.groups.pass_deducted.length, 1);
    assert.equal(impact.groups.pass_deducted[0].booking_ref, refD);
    assert.equal(impact.groups.pass_deducted[0].passes[0].last4, passCode.slice(-4));
    assert.equal(impact.groups.pending_reconcile.length, 1);
    assert.equal(impact.groups.pending_reconcile[0].booking_ref, refE);

    // 4. Batch cancel [A, B, C] with notify_line: true
    const pushCalls = [];
    globalThis.__TEST_LINE_PUSH_FN__ = async (to, payload) => {
      pushCalls.push({ to, payload });
      return { ok: true };
    };

    const batchRes = await fetch(`${srv.baseUrl}/api/daily-settings/${dateStr}/closure/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ booking_refs: [refA, refB, refC], notify_line: true })
    });
    assert.equal(batchRes.status, 200);
    const batchBody = await batchRes.json();
    assert.equal(batchBody.cancelled.length, 2);
    assert.equal(batchBody.skipped.length, 1);
    assert.equal(batchBody.skipped[0].booking_ref, refC);
    assert.equal(batchBody.skipped[0].reason, '需退款');

    const resA = batchBody.cancelled.find((x) => x.booking_ref === refA);
    const resB = batchBody.cancelled.find((x) => x.booking_ref === refB);
    assert.equal(resA.line_status, 'sent');
    assert.equal(resB.line_status, 'no_line');
    assert.equal(pushCalls.length, 1);
    assert.equal(pushCalls[0].to, uA.line_user_id);

    // Audit event line_message_sent recorded once; C/D/E untouched
    const lineAuditCount = await prisma.accountingEvent.count({
      where: { event_type: 'line_message_sent', booking_ref: refA }
    });
    assert.equal(lineAuditCount, 1);
    const cPayment = await prisma.payment.findFirst({ where: { booking_ref: refC } });
    assert.equal(cPayment.status, 'valid');
    const dPassAfter = await prisma.userPass.findUnique({ where: { id: passD.id } });
    assert.equal(dPassAfter.remaining_quota, 4);
    const ePoolAfter = await prisma.oneTimeAccountPool.findUnique({ where: { account_number: poolAccNum } });
    assert.equal(ePoolAfter.status, 'ASSIGNED');

    // 5. Repeat identical request -> idempotent (0 cancelled, 0 extra pushes)
    const repeatRes = await fetch(`${srv.baseUrl}/api/daily-settings/${dateStr}/closure/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ booking_refs: [refA, refB, refC], notify_line: true })
    });
    assert.equal(repeatRes.status, 200);
    const repeatBody = await repeatRes.json();
    assert.equal(repeatBody.cancelled.length, 0);
    assert.equal(repeatBody.skipped.length, 3);
    assert.equal(pushCalls.length, 1);

    // 6. CSV export has UTF-8 BOM & 3 rows (C, D, E)
    const csvRes = await fetch(`${srv.baseUrl}/api/daily-settings/${dateStr}/closure-impact.csv`, {
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    assert.equal(csvRes.status, 200);
    const csvBuf = Buffer.from(await csvRes.arrayBuffer());
    assert.equal(csvBuf[0], 0xef);
    assert.equal(csvBuf[1], 0xbb);
    assert.equal(csvBuf[2], 0xbf);
    const csvText = csvBuf.toString('utf8').slice(1);
    const lines = csvText.trim().split(/\r?\n/);
    assert.equal(lines.length, 4);
    assert.ok(csvText.includes(refC));
    assert.ok(csvText.includes(refD));
    assert.ok(csvText.includes(refE));
  } finally {
    globalThis.__TEST_LINE_PUSH_FN__ = prevPushFn;
    if (srv?.server) await new Promise((r) => srv.server.close(r));
    await prisma.bookingPrepay.deleteMany({ where: { booking_ref: { in: createdRefs } } });
    await prisma.payment.deleteMany({ where: { booking_ref: { in: createdRefs } } });
    await prisma.reservation.deleteMany({ where: { booking_ref: { in: createdRefs } } });
    await prisma.oneTimeAccountPool.deleteMany({ where: { account_number: poolAccNum } });
    await prisma.userPass.deleteMany({ where: { pass_code: passCode } });
    await prisma.passPlan.deleteMany({ where: { code: passPlanCode } });
    if (createdUserIds.length > 0) await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    if (createdSessionIds.length > 0) await prisma.session.deleteMany({ where: { id: { in: createdSessionIds } } });
    await prisma.dailySetting.deleteMany({ where: { date: dateObj } });
    await prisma.adminUser.deleteMany({ where: { password: adminPwd } });
    if (prevGlobal) {
      await prisma.globalSetting.update({
        where: { id: 1 },
        data: { line_auto_notify_cancel: prevGlobal.line_auto_notify_cancel }
      });
    }
  }
});
