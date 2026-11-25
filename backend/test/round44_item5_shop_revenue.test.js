import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import cookieParser from 'cookie-parser';
import prisma from '../src/prismaClient.js';
import { generateToken } from '../src/middlewares/authMiddleware.js';
import accountingRoutes from '../src/routes/accounting.js';
import { dateOnly } from '../../shared/time.js';
import { diagnoseRevenueGap } from '../scripts/diagnose-revenue-gap.mjs';

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

test('Round 44 Item 5: dedicated shop-summary, shop-payments.csv, store summary exclusion, and read-only gap diagnosis', async () => {
  const runId = `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  let srv = null;
  let staffUser = null;
  const createdUserIds = [];
  const createdResIds = [];
  const createdOrderIds = [];
  const createdPaymentNos = [];

  try {
    srv = await startLocalApp();
    staffUser = await prisma.adminUser.create({
      data: {
        password: `R44I5_${runId}_Pass!`,
        name: `R44商城統計_${runId}`,
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
        line_user_id: `r44_i5_cust_${runId}`,
        name: 'R44商城統計測試客',
        phone: `0945${runId.slice(-6)}`
      }
    });
    createdUserIds.push(customer.id);

    const sNov10 = await prisma.session.upsert({
      where: { session_date_start_time: { session_date: dateOnly('2026-11-10'), start_time: '14:00' } },
      update: {},
      create: { session_date: dateOnly('2026-11-10'), start_time: '14:00', end_time: '18:00', max_capacity: 20 }
    });
    const sNov05 = await prisma.session.upsert({
      where: { session_date_start_time: { session_date: dateOnly('2026-11-05'), start_time: '14:00' } },
      update: {},
      create: { session_date: dateOnly('2026-11-05'), start_time: '14:00', end_time: '18:00', max_capacity: 20 }
    });

    const bookingRef = `R44S-${runId}-1`;
    const paidNoPayRef = `R44S-${runId}-NOPAY`;

    const rBooking = await prisma.reservation.create({
      data: {
        booking_ref: bookingRef,
        user_id: customer.id,
        session_id: sNov10.id,
        pax: 1,
        assigned_seats: ['1-1'],
        status: 'confirmed',
        is_paid: true,
        billing_status: 'paid',
        total_amount: 1000
      }
    });
    // Seed a paid reservation with NO Payment rows on 2026-11-05 to verify diagnoseRevenueGap
    const rNoPay = await prisma.reservation.create({
      data: {
        booking_ref: paidNoPayRef,
        user_id: customer.id,
        session_id: sNov05.id,
        pax: 1,
        assigned_seats: ['1-2'],
        status: 'confirmed',
        is_paid: true,
        billing_status: 'paid',
        total_amount: 450
      }
    });
    createdResIds.push(rBooking.id, rNoPay.id);

    const shopOrderRef = `PO-R44S-${runId}`;
    const ord = await prisma.productOrder.create({
      data: {
        order_ref: shopOrderRef,
        user_id: customer.id,
        total_amount: 2000,
        deposit_required: 500,
        paid_amount: 1800,
        balance_amount: 0,
        payment_method_code: 'transfer',
        payment_status: 'fully_paid',
        order_status: 'picked_up'
      }
    });
    createdOrderIds.push(ord.id);

    const pNos = [
      `P44I5-${runId}-1`,
      `P44I5-${runId}-2`,
      `P44I5-${runId}-3`,
      `P44I5-${runId}-4`
    ];
    createdPaymentNos.push(...pNos);

    await prisma.payment.createMany({
      data: [
        // Shop deposit 500 (transfer) on 2026-11-10
        {
          payment_no: pNos[0],
          batch_no: `B_${pNos[0]}`,
          booking_ref: shopOrderRef,
          source: 'shop',
          source_ref: shopOrderRef,
          kind: 'charge',
          method: 'transfer',
          amount: 500,
          status: 'valid',
          staff_name: staffUser.name,
          device_label: 'r44-i5-test',
          breakdown_json: {},
          created_at: new Date('2026-11-10T06:00:00.000Z')
        },
        // Shop balance 1500 (cash) on 2026-11-12
        {
          payment_no: pNos[1],
          batch_no: `B_${pNos[1]}`,
          booking_ref: shopOrderRef,
          source: 'shop',
          source_ref: shopOrderRef,
          kind: 'supplement',
          method: 'cash',
          amount: 1500,
          status: 'valid',
          staff_name: staffUser.name,
          device_label: 'r44-i5-test',
          breakdown_json: {},
          created_at: new Date('2026-11-12T06:00:00.000Z')
        },
        // Shop refund 200 (cash) on 2026-11-15
        {
          payment_no: pNos[2],
          batch_no: `B_${pNos[2]}`,
          booking_ref: shopOrderRef,
          source: 'shop',
          source_ref: shopOrderRef,
          kind: 'refund',
          method: 'cash',
          amount: 200,
          status: 'valid',
          staff_name: staffUser.name,
          device_label: 'r44-i5-test',
          breakdown_json: {},
          created_at: new Date('2026-11-15T06:00:00.000Z')
        },
        // Store booking cash 1000 on 2026-11-10
        {
          payment_no: pNos[3],
          batch_no: `B_${pNos[3]}`,
          booking_ref: bookingRef,
          source: 'booking',
          source_ref: bookingRef,
          kind: 'charge',
          method: 'cash',
          amount: 1000,
          status: 'valid',
          staff_name: staffUser.name,
          device_label: 'r44-i5-test',
          breakdown_json: {},
          created_at: new Date('2026-11-10T08:00:00.000Z')
        }
      ]
    });

    // 1. shop-summary for 2026-11-01 ~ 2026-11-30
    const shopRes = await fetch(
      `${srv.baseUrl}/api/accounting/shop-summary?date_from=2026-11-01&date_to=2026-11-30`,
      { headers: authHeaders }
    );
    assert.equal(shopRes.status, 200);
    const shopBody = await shopRes.json();
    assert.equal(shopBody.income, 2000);
    assert.equal(shopBody.refunds, 200);
    assert.equal(shopBody.net, 1800);
    assert.equal(shopBody.order_count, 1);
    assert.equal(shopBody.daily.length, 30);

    const shopCash = shopBody.methods.find((m) => m.key === 'cash');
    const shopTransfer = shopBody.methods.find((m) => m.key === 'transfer');
    assert.equal(shopCash?.amount, 1500);
    assert.equal(shopCash?.refund_amount, 200);
    assert.equal(shopTransfer?.amount, 500);

    // 2. Store summary net_revenue = 1000 (excludes all shop payments) & summary.shop matches shop-summary
    const sumRes = await fetch(
      `${srv.baseUrl}/api/accounting/summary?start_date=2026-11-01&end_date=2026-11-30`,
      { headers: authHeaders }
    );
    assert.equal(sumRes.status, 200);
    const sumBody = await sumRes.json();
    assert.equal(sumBody.net_revenue, 1000);
    const storeCash = sumBody.methods.find((m) => m.key === 'cash');
    assert.equal(storeCash?.amount, 1000, 'store summary must not include shop cash');
    assert.equal(sumBody.shop.income, shopBody.income);
    assert.equal(sumBody.shop.refunds, shopBody.refunds);
    assert.equal(sumBody.shop.amount, shopBody.net);

    // 3. shop-payments.csv -> 3 data rows + BOM + '單號' header
    const csvRes = await fetch(
      `${srv.baseUrl}/api/accounting/shop-payments.csv?date_from=2026-11-01&date_to=2026-11-30`,
      { headers: authHeaders }
    );
    assert.equal(csvRes.status, 200);
    const csvBuf = Buffer.from(await csvRes.arrayBuffer());
    assert.equal(csvBuf[0], 0xef);
    assert.equal(csvBuf[1], 0xbb);
    assert.equal(csvBuf[2], 0xbf);
    const csvText = csvBuf.toString('utf8');
    const lines = csvText.replace(/^\uFEFF/, '').split(/\r?\n/).filter(Boolean);
    assert.equal(lines.length - 1, 3);
    assert.ok(lines[0].includes('"單號"'));
    assert.ok(lines.slice(1).every((l) => l.includes(shopOrderRef)));

    // 4. Read-only diagnoseRevenueGap finds 2026-11-05 paid booking with missing Payment rows
    const diag = await diagnoseRevenueGap(prisma, { from: '2026-11-01', to: '2026-11-10' });
    const nov05 = diag.days.find((d) => d.date === '2026-11-05');
    const nov10 = diag.days.find((d) => d.date === '2026-11-10');
    assert.equal(nov05?.paid_no_payment_count, 1);
    assert.equal(nov05?.paid_no_payment_amount, 450);
    assert.equal(nov10?.payment_net_revenue, 1000, 'diagnoseRevenueGap must exclude shop 500');
  } finally {
    await srv?.close().catch(() => {});
    if (createdPaymentNos.length > 0) {
      await prisma.payment.deleteMany({ where: { payment_no: { in: createdPaymentNos } } }).catch(() => {});
    }
    if (createdOrderIds.length > 0) {
      await prisma.productOrder.deleteMany({ where: { id: { in: createdOrderIds } } }).catch(() => {});
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
