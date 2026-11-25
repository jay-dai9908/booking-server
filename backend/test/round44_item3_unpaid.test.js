import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import cookieParser from 'cookie-parser';
import prisma from '../src/prismaClient.js';
import { generateToken } from '../src/middlewares/authMiddleware.js';
import accountingRoutes from '../src/routes/accounting.js';
import { dateOnly } from '../../shared/time.js';

function startLocalApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/accounting', accountingRoutes);

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

test('Round 44 Item 3: unified unpaid count/amount across summary, closing preview, and unpaid follow-up deducting pass & excluding no_show', async () => {
  const runId = `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const targetDate = '2026-11-19';
  const targetTs = new Date('2026-11-19T06:00:00.000Z');
  let srv = null;
  let staffUser = null;
  const createdUserIds = [];
  const createdResIds = [];
  const createdBookingRefs = [];
  const createdPaymentNos = [];

  try {
    srv = await startLocalApp();
    staffUser = await prisma.adminUser.create({
      data: {
        password: `R44I3_${runId}_Pass!`,
        name: `R44未結測試_${runId}`,
        permissions: ['accounting'],
        is_active: true
      }
    });
    const token = generateToken({
      id: staffUser.id,
      role: 'admin',
      name: staffUser.name,
      permissions: ['accounting'],
      token_version: staffUser.token_version
    });
    const authHeaders = { Authorization: `Bearer ${token}` };

    const customer = await prisma.user.create({
      data: {
        line_user_id: `r44_i3_cust_${runId}`,
        name: 'R44未結測試客',
        phone: `0943${runId.slice(-6)}`
      }
    });
    createdUserIds.push(customer.id);

    const session = await prisma.session.upsert({
      where: { session_date_start_time: { session_date: dateOnly(targetDate), start_time: '14:00' } },
      update: {},
      create: { session_date: dateOnly(targetDate), start_time: '14:00', end_time: '18:00', max_capacity: 30 }
    });

    const refA = `R44U-${runId}-A`;
    const refB = `R44U-${runId}-B`;
    const refC = `R44U-${runId}-C`;
    const refD = `R44U-${runId}-D`;
    const refE = `R44U-${runId}-E`;
    createdBookingRefs.push(refA, refB, refC, refD, refE);

    const specs = [
      // A: due 1100, cash 550 + pass 550 -> 0 unpaid -> NOT listed
      {
        booking_ref: refA,
        status: 'confirmed',
        billing_status: 'partial',
        is_paid: false,
        amount_due: 1100,
        amount_received: 550,
        total_amount: 1100,
        assigned_seats: ['1-1']
      },
      // B: due 600, received 200 -> 400 unpaid -> listed
      {
        booking_ref: refB,
        status: 'confirmed',
        billing_status: 'partial',
        is_paid: false,
        amount_due: 600,
        amount_received: 200,
        total_amount: 600,
        assigned_seats: ['1-2']
      },
      // C: never opened bill (billing_status null, is_paid false, total_amount 300) -> 300 unpaid -> listed
      {
        booking_ref: refC,
        status: 'confirmed',
        billing_status: null,
        is_paid: false,
        amount_due: null,
        amount_received: 0,
        total_amount: 300,
        assigned_seats: ['1-3']
      },
      // D: no_show -> NOT listed, counts into no_show_count = 1
      {
        booking_ref: refD,
        status: 'confirmed',
        attendance: 'no_show',
        billing_status: 'unpaid',
        is_paid: false,
        amount_due: 500,
        amount_received: 0,
        total_amount: 500,
        assigned_seats: ['1-4']
      },
      // E: cancelled -> NOT listed, NOT in no_show_count
      {
        booking_ref: refE,
        status: 'cancelled',
        billing_status: 'unpaid',
        is_paid: false,
        amount_due: 800,
        amount_received: 0,
        total_amount: 800,
        assigned_seats: ['1-5']
      }
    ];

    for (const sp of specs) {
      const created = await prisma.reservation.create({
        data: {
          booking_ref: sp.booking_ref,
          user_id: customer.id,
          session_id: session.id,
          pax: 1,
          assigned_seats: sp.assigned_seats,
          status: sp.status,
          attendance: sp.attendance || null,
          billing_status: sp.billing_status,
          is_paid: sp.is_paid,
          amount_due: sp.amount_due,
          amount_received: sp.amount_received,
          total_amount: sp.total_amount
        }
      });
      createdResIds.push(created.id);
    }

    // Seed A's cash 550 & pass 550 Payment rows
    const pCashA = `P44U-${runId}-A1`;
    const pPassA = `P44U-${runId}-A2`;
    createdPaymentNos.push(pCashA, pPassA);
    await prisma.payment.createMany({
      data: [
        {
          payment_no: pCashA,
          batch_no: `B_${pCashA}`,
          booking_ref: refA,
          source: 'booking',
          source_ref: refA,
          kind: 'charge',
          method: 'cash',
          amount: 550,
          status: 'valid',
          staff_name: staffUser.name,
          device_label: 'r44-i3-test',
          breakdown_json: {},
          created_at: targetTs
        },
        {
          payment_no: pPassA,
          batch_no: `B_${pPassA}`,
          booking_ref: refA,
          source: 'booking',
          source_ref: refA,
          kind: 'charge',
          method: 'pass',
          amount: 550,
          status: 'valid',
          staff_name: staffUser.name,
          device_label: 'r44-i3-test',
          breakdown_json: {},
          created_at: targetTs
        }
      ]
    });

    // 1. Summary
    const sumRes = await fetch(
      `${srv.baseUrl}/api/accounting/summary?start_date=${targetDate}&end_date=${targetDate}`,
      { headers: authHeaders }
    );
    assert.equal(sumRes.status, 200);
    const sumBody = await sumRes.json();
    assert.deepEqual(sumBody.unpaid, { count: 2, amount: 700, no_show_count: 1 });

    // 2. Closing preview
    const closeRes = await fetch(
      `${srv.baseUrl}/api/accounting/closing/preview?date=${targetDate}`,
      { headers: authHeaders }
    );
    assert.equal(closeRes.status, 200);
    const closeBody = await closeRes.json();
    assert.deepEqual(closeBody.unpaid, { count: 2, amount: 700, no_show_count: 1 });

    // 3. Unpaid follow-up
    const unpaidRes = await fetch(
      `${srv.baseUrl}/api/accounting/unpaid?date_from=${targetDate}&date_to=${targetDate}`,
      { headers: authHeaders }
    );
    assert.equal(unpaidRes.status, 200);
    const unpaidBody = await unpaidRes.json();
    assert.equal(unpaidBody.count, 2);
    assert.equal(unpaidBody.amount, 700);
    assert.equal(unpaidBody.no_show_count, 1);
    assert.deepEqual(unpaidBody.summary, { count: 2, amount: 700, no_show_count: 1 });

    const refsReturned = unpaidBody.unpaid.map((u) => u.booking_ref).sort();
    assert.deepEqual(refsReturned, [refB, refC].sort());

    const rowB = unpaidBody.unpaid.find((u) => u.booking_ref === refB);
    const rowC = unpaidBody.unpaid.find((u) => u.booking_ref === refC);
    assert.equal(rowB?.unpaid_amount, 400);
    assert.equal(rowB?.pass_value, 0);
    assert.equal(rowC?.unpaid_amount, 300);
    assert.equal(rowC?.amount_due, 300);
  } finally {
    await srv?.close().catch(() => {});
    if (createdPaymentNos.length > 0) {
      await prisma.payment.deleteMany({ where: { payment_no: { in: createdPaymentNos } } }).catch(() => {});
    }
    if (createdResIds.length > 0) {
      await prisma.reservation.deleteMany({ where: { id: { in: createdResIds } } }).catch(() => {});
    }
    if (createdUserIds.length > 0) {
      await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } }).catch(() => {});
    }
    if (staffUser?.id) {
      await prisma.adminUser.deleteMany({ where: { id: staffUser.id } }).catch(() => {});
    }
  }
});
