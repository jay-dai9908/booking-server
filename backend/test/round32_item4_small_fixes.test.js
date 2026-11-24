import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import crypto from 'crypto';
import express from 'express';
import cookieParser from 'cookie-parser';
import prisma from '../src/prismaClient.js';
import authRoutes from '../src/routes/auth.js';
import printRoutes from '../src/routes/print.js';
import passRoutes from '../src/routes/passes.js';
import shopRoutes from '../src/routes/shop.js';
import { getAccountingSummary } from '../src/controllers/accountingController.js';

function startLocalApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/auth', authRoutes);
  app.use('/api/print', printRoutes);
  app.use('/api/passes', passRoutes);
  app.use('/api/shop', shopRoutes);

  const server = http.createServer(app);
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', (err) => {
      if (err) return reject(err);
      const port = server.address().port;
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        close: () => new Promise((res) => server.close(res))
      });
    });
  });
}

test('Round 32 Item 4: print station ownership, 500 error detail stripping, active-only public pass plans, and verified shop remittance 409', async (t) => {
  const runId = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const secretA = `sec_a_${runId}`;
  const secretB = `sec_b_${runId}`;
  const hashOf = (s) => crypto.createHash('sha256').update(s).digest('hex');

  let stationA = null;
  let stationB = null;
  let job1 = null;
  let jobQueued = null;
  let inactivePlan = null;
  let activePlan = null;
  let adminUser = null;
  let customer = null;
  let verifiedOrder = null;
  let srv = null;

  t.after(async () => {
    if (srv) await srv.close().catch(() => {});
    const jobIds = [job1?.id, jobQueued?.id].filter(Boolean);
    if (jobIds.length > 0) {
      await prisma.printJob.deleteMany({ where: { id: { in: jobIds } } }).catch(() => {});
    }
    const stationIds = [stationA?.id, stationB?.id].filter(Boolean);
    if (stationIds.length > 0) {
      await prisma.printStation.deleteMany({ where: { id: { in: stationIds } } }).catch(() => {});
    }
    const planIds = [inactivePlan?.id, activePlan?.id].filter(Boolean);
    if (planIds.length > 0) {
      await prisma.passPlan.deleteMany({ where: { id: { in: planIds } } }).catch(() => {});
    }
    if (verifiedOrder?.id) {
      await prisma.productOrder.delete({ where: { id: verifiedOrder.id } }).catch(() => {});
    }
    if (customer?.id) {
      await prisma.user.delete({ where: { id: customer.id } }).catch(() => {});
    }
    if (adminUser?.id) {
      await prisma.adminUser.delete({ where: { id: adminUser.id } }).catch(() => {});
    }
  });

  // 1. Print stations A & B + jobs
  stationA = await prisma.printStation.create({
    data: { name: `R32-Station-A-${runId}`, secret_hash: hashOf(secretA), is_active: true }
  });
  stationB = await prisma.printStation.create({
    data: { name: `R32-Station-B-${runId}`, secret_hash: hashOf(secretB), is_active: true }
  });

  job1 = await prisma.printJob.create({
    data: {
      job_no: `P-R32-1-${runId}`,
      type: 'test',
      title: 'R32 Test Slip 1',
      status: 'claimed',
      station_id: stationA.id,
      claimed_at: new Date(),
      lease_until: new Date(Date.now() + 60000),
      commands_json: { lines: ['test'] },
      requested_by_name: 'R32 Test',
      requested_device: 'test'
    }
  });
  jobQueued = await prisma.printJob.create({
    data: {
      job_no: `P-R32-2-${runId}`,
      type: 'test',
      title: 'R32 Test Slip 2',
      status: 'queued',
      commands_json: { lines: ['queued'] },
      requested_by_name: 'R32 Test',
      requested_device: 'test'
    }
  });

  // 2. Active & inactive PassPlans
  activePlan = await prisma.passPlan.create({
    data: {
      code: `R32_ACT_${runId}`,
      name: 'R32 Active Plan',
      pass_type: 'PUNCH_CARD',
      price: 500,
      total_quota: 5,
      is_active: true
    }
  });
  inactivePlan = await prisma.passPlan.create({
    data: {
      code: `R32_INACT_${runId}`,
      name: 'R32 Inactive Plan',
      pass_type: 'PUNCH_CARD',
      price: 400,
      total_quota: 5,
      is_active: false
    }
  });

  // 3. Admin, Customer, and deposit_verified order
  const staffPass = `r32_i4_adm_${runId}`;
  adminUser = await prisma.adminUser.create({
    data: {
      name: 'R32 I4 Admin',
      password: staffPass,
      role: 'staff',
      permissions: ['members'],
      is_active: true
    }
  });
  customer = await prisma.user.create({
    data: {
      line_user_id: `U_r32_i4_${runId}`,
      name: 'R32 I4 Cust',
      phone: '0900000324'
    }
  });
  verifiedOrder = await prisma.productOrder.create({
    data: {
      order_ref: `ORD-R32-I4-${runId}`,
      user_id: customer.id,
      total_amount: 300,
      deposit_required: 100,
      balance_amount: 200,
      payment_method_code: 'transfer',
      payment_status: 'deposit_verified',
      remittance_last5: '12345'
    }
  });

  srv = await startLocalApp();
  const baseUrl = srv.baseUrl;

  // Test 1a: Station B tries to report Station A's claimed job -> 409, status remains 'claimed'
  const bReportRes = await fetch(`${baseUrl}/api/print/station/jobs/${job1.id}/result`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Station ${stationB.id}.${secretB}`
    },
    body: JSON.stringify({ success: true })
  });
  assert.equal(bReportRes.status, 409);
  const jobAfterB = await prisma.printJob.findUnique({ where: { id: job1.id } });
  assert.equal(jobAfterB.status, 'claimed');

  // Test 1b: Station A reports its own claimed job -> 200, status becomes 'printed'
  const aReportRes = await fetch(`${baseUrl}/api/print/station/jobs/${job1.id}/result`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Station ${stationA.id}.${secretA}`
    },
    body: JSON.stringify({ success: true })
  });
  assert.equal(aReportRes.status, 200);
  const jobAfterA = await prisma.printJob.findUnique({ where: { id: job1.id } });
  assert.equal(jobAfterA.status, 'printed');

  // Test 1c: Station A tries to report a 'queued' (unclaimed) job -> 409
  const queuedReportRes = await fetch(`${baseUrl}/api/print/station/jobs/${jobQueued.id}/result`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Station ${stationA.id}.${secretA}`
    },
    body: JSON.stringify({ success: true })
  });
  assert.equal(queuedReportRes.status, 409);

  // Test 2: getAccountingSummary 500 error omits details
  const origPaymentFindMany = prisma.payment.findMany;
  prisma.payment.findMany = async () => {
    throw new Error('SENSITIVE_DB_INTERNAL_ERR');
  };
  let capturedStatus = 200;
  let capturedBody = null;
  try {
    await getAccountingSummary(
      { query: { date: '2026-11-24' } },
      {
        status(code) {
          capturedStatus = code;
          return this;
        },
        json(payload) {
          capturedBody = payload;
          return this;
        }
      }
    );
  } finally {
    prisma.payment.findMany = origPaymentFindMany;
  }
  assert.equal(capturedStatus, 500);
  assert.equal('details' in capturedBody, false);
  assert.equal(JSON.stringify(capturedBody).includes('SENSITIVE_DB_INTERNAL_ERR'), false);

  // Test 3: Public GET /api/passes/plans?all=true excludes inactive plan; admin GET /api/passes/admin/plans includes it
  const pubPlansRes = await fetch(`${baseUrl}/api/passes/plans?all=true`);
  assert.equal(pubPlansRes.status, 200);
  const pubPlans = await pubPlansRes.json();
  assert.ok(pubPlans.some((p) => p.id === activePlan.id));
  assert.equal(pubPlans.some((p) => p.id === inactivePlan.id), false);

  const loginRes = await fetch(`${baseUrl}/api/auth/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: staffPass })
  });
  assert.equal(loginRes.status, 200);
  const { token: adminToken } = await loginRes.json();

  const admPlansRes = await fetch(`${baseUrl}/api/passes/admin/plans`, {
    headers: { Authorization: `Bearer ${adminToken}` }
  });
  assert.equal(admPlansRes.status, 200);
  const admPlans = await admPlansRes.json();
  assert.ok(admPlans.some((p) => p.id === activePlan.id));
  assert.ok(admPlans.some((p) => p.id === inactivePlan.id));

  // Test 4: Customer cannot update remittance_last5 on deposit_verified order (409)
  const custLogin = await fetch(`${baseUrl}/api/auth/test-login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: customer.id, role: 'customer' })
  });
  const { token: custToken } = await custLogin.json();

  const remitRes = await fetch(`${baseUrl}/api/shop/orders/${verifiedOrder.id}/remittance`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${custToken}` },
    body: JSON.stringify({ remittance_last5: '99999' })
  });
  assert.equal(remitRes.status, 409);
});
