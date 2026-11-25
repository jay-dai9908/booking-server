import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import cookieParser from 'cookie-parser';
import prisma from '../src/prismaClient.js';
import { generateToken } from '../src/middlewares/authMiddleware.js';
import accountingRoutes from '../src/routes/accounting.js';
import billingRoutes from '../src/routes/billing.js';
import { dateOnly } from '../../shared/time.js';
import { generatePaymentMethodKeyReport } from '../scripts/report-payment-method-keys.mjs';

function startLocalApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/accounting', accountingRoutes);
  app.use('/api/billing', billingRoutes);

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

test('Round 44 Item 2: normalized payment method keys across summary, payments filter, closing, billing collect, and audit script', async () => {
  const runId = `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const targetDate = '2026-11-18';
  const targetStart = new Date('2026-11-18T06:00:00.000Z'); // 14:00 Asia/Taipei
  let srv = null;
  let staffUser = null;
  let prevGlobalSetting = null;
  const createdUserIds = [];
  const createdResIds = [];
  const createdBookingRefs = [];
  const createdPaymentNos = [];

  try {
    srv = await startLocalApp();
    prevGlobalSetting = await prisma.globalSetting.findUnique({ where: { id: 1 } });

    await prisma.globalSetting.upsert({
      where: { id: 1 },
      update: {
        payment_methods_json: [
          { key: 'cash', label: '現金', enabled: true },
          { key: 'linepay', label: 'LINE Pay', enabled: true },
          { key: 'card', label: '信用卡', enabled: true },
          { key: 'custom_1', label: '街口支付', enabled: true },
          { key: 'transfer', label: '銀行轉帳', enabled: false }
        ]
      },
      create: {
        id: 1,
        payment_methods_json: [
          { key: 'cash', label: '現金', enabled: true },
          { key: 'linepay', label: 'LINE Pay', enabled: true },
          { key: 'card', label: '信用卡', enabled: true },
          { key: 'custom_1', label: '街口支付', enabled: true },
          { key: 'transfer', label: '銀行轉帳', enabled: false }
        ]
      }
    });

    staffUser = await prisma.adminUser.create({
      data: {
        password: `R44I2_${runId}_Pass!`,
        name: `R44付款方式_${runId}`,
        permissions: ['accounting', 'reservations', 'seating'],
        is_active: true
      }
    });
    const token = generateToken({
      id: staffUser.id,
      role: 'admin',
      name: staffUser.name,
      permissions: ['accounting', 'reservations', 'seating'],
      token_version: staffUser.token_version
    });
    const authHeaders = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    };

    const customer = await prisma.user.create({
      data: {
        line_user_id: `r44_i2_cust_${runId}`,
        name: 'R44付款方式測試客',
        phone: `0942${runId.slice(-6)}`
      }
    });
    createdUserIds.push(customer.id);

    const session = await prisma.session.upsert({
      where: { session_date_start_time: { session_date: dateOnly(targetDate), start_time: '14:00' } },
      update: {},
      create: { session_date: dateOnly(targetDate), start_time: '14:00', end_time: '18:00', max_capacity: 20 }
    });

    const refMain = `R44M-${runId}-1`;
    const refCollect = `R44M-${runId}-2`;
    createdBookingRefs.push(refMain, refCollect);

    const resMain = await prisma.reservation.create({
      data: {
        booking_ref: refMain,
        user_id: customer.id,
        session_id: session.id,
        pax: 1,
        assigned_seats: ['1-1'],
        status: 'confirmed',
        is_paid: true
      }
    });
    createdResIds.push(resMain.id);

    const resCollect = await prisma.reservation.create({
      data: {
        booking_ref: refCollect,
        user_id: customer.id,
        session_id: session.id,
        pax: 1,
        assigned_seats: ['1-2'],
        status: 'checked_in',
        is_paid: false
      }
    });
    createdResIds.push(resCollect.id);
    await prisma.bookingPerson.create({
      data: {
        booking_ref: refCollect,
        person_no: 1,
        seat_code: '1-2',
        status: 'active',
        timer_started_at: targetStart
      }
    });

    // Seed mixed legacy & normalized method keys in Payment directly
    const seedRows = [
      { no: `P44I2-${runId}-1`, source: 'booking', source_ref: refMain, kind: 'charge', method: 'line_pay', amount: 200 },
      { no: `P44I2-${runId}-2`, source: 'booking', source_ref: refMain, kind: 'charge', method: 'linepay', amount: 300 },
      { no: `P44I2-${runId}-3`, source: 'booking', source_ref: refMain, kind: 'charge', method: 'card', amount: 400 },
      { no: `P44I2-${runId}-4`, source: 'booking', source_ref: refMain, kind: 'charge', method: 'custom_1', amount: 150 },
      { no: `P44I2-${runId}-5`, source: 'booking', source_ref: refMain, kind: 'refund', method: 'custom_1', amount: 50 },
      { no: `P44I2-${runId}-6`, source: 'booking', source_ref: refMain, kind: 'charge', method: 'other', amount: 50 },
      // Shop payment must NOT pollute booking summary/closing breakdown
      { no: `P44I2-${runId}-7`, source: 'shop', source_ref: `ORD44_${runId}`, kind: 'charge', method: 'linepay', amount: 900 }
    ];

    for (const row of seedRows) {
      createdPaymentNos.push(row.no);
    }
    await prisma.payment.createMany({
      data: seedRows.map((row) => ({
        payment_no: row.no,
        batch_no: `B_${row.no}`,
        booking_ref: row.source_ref,
        source: row.source,
        source_ref: row.source_ref,
        kind: row.kind,
        method: row.method,
        amount: row.amount,
        status: 'valid',
        staff_name: staffUser.name,
        device_label: 'r44-i2-test',
        breakdown_json: {},
        created_at: targetStart
      }))
    });

    // 1. Summary merges line_pay + linepay under 'linepay', lists dynamic custom_1, places 'other' last, excludes shop
    const sumRes = await fetch(
      `${srv.baseUrl}/api/accounting/summary?start_date=${targetDate}&end_date=${targetDate}`,
      { headers: authHeaders }
    );
    assert.equal(sumRes.status, 200);
    const sumBody = await sumRes.json();
    assert.equal(sumBody.by_method.line_pay, undefined, 'by_method must not expose raw line_pay key');
    assert.deepEqual(sumBody.by_method.linepay, { count: 2, amount: 500 });
    assert.deepEqual(sumBody.by_method.card, { count: 1, amount: 400 });
    assert.deepEqual(sumBody.by_method.custom_1, { count: 1, amount: 150 });
    assert.deepEqual(sumBody.by_method.other, { count: 1, amount: 50 });

    const lpItem = sumBody.methods.find((m) => m.key === 'linepay');
    const c1Item = sumBody.methods.find((m) => m.key === 'custom_1');
    const otherItem = sumBody.methods[sumBody.methods.length - 1];
    assert.equal(lpItem?.count, 2);
    assert.equal(lpItem?.amount, 500);
    assert.equal(c1Item?.label, '街口支付');
    assert.equal(c1Item?.amount, 150);
    assert.equal(c1Item?.refund_count, 1);
    assert.equal(c1Item?.refund_amount, 50);
    assert.equal(otherItem?.key, 'other');
    assert.equal(otherItem?.amount, 50);
    // gross = 200 + 300 + 400 + 150 + 50 = 1100, refunds = 50, net = 1050 (excludes shop 900)
    assert.equal(sumBody.net_revenue, 1050);

    // 2. GET /payments?method=linepay returns BOTH line_pay and linepay rows
    const listRes = await fetch(
      `${srv.baseUrl}/api/accounting/payments?date_from=${targetDate}&date_to=${targetDate}&method=linepay`,
      { headers: authHeaders }
    );
    assert.equal(listRes.status, 200);
    const listBody = await listRes.json();
    const listNos = listBody.payments.map((p) => p.payment_no);
    assert.ok(listNos.includes(`P44I2-${runId}-1`), 'filter method=linepay must match legacy line_pay row');
    assert.ok(listNos.includes(`P44I2-${runId}-2`), 'filter method=linepay must match canonical linepay row');
    assert.equal(listBody.total_count, 2);

    // 3. Closing preview includes card + custom_1 + linepay + other (excludes shop)
    const closePrevRes = await fetch(
      `${srv.baseUrl}/api/accounting/closing/preview?date=${targetDate}`,
      { headers: authHeaders }
    );
    assert.equal(closePrevRes.status, 200);
    const closePrev = await closePrevRes.json();
    assert.ok(Array.isArray(closePrev.methods), 'closing preview should include methods array');
    const cpCard = closePrev.methods.find((m) => m.key === 'card');
    const cpCustom = closePrev.methods.find((m) => m.key === 'custom_1');
    const cpLinepay = closePrev.methods.find((m) => m.key === 'linepay');
    assert.equal(cpCard?.amount, 400);
    assert.equal(cpCustom?.amount, 150);
    assert.equal(cpCustom?.refund_amount, 50);
    assert.equal(cpLinepay?.amount, 500);

    // 4. Billing collect with legacy alias 'line_pay' persists normalized 'linepay'
    const billDetRes = await fetch(`${srv.baseUrl}/api/billing/${refCollect}`, { headers: authHeaders });
    assert.equal(billDetRes.status, 200);
    const collectRes = await fetch(`${srv.baseUrl}/api/billing/${refCollect}/collect`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        person_nos: [1],
        method: 'line_pay',
        print: false
      })
    });
    assert.equal(collectRes.status, 200, 'collect using legacy alias line_pay should resolve against enabled linepay');
    const savedCollectPay = await prisma.payment.findFirst({
      where: { booking_ref: refCollect },
      orderBy: { id: 'desc' }
    });
    assert.ok(savedCollectPay);
    createdPaymentNos.push(savedCollectPay.payment_no);
    assert.equal(savedCollectPay.method, 'linepay', 'persisted Payment.method must be normalized to linepay');

    // 5. Read-only key report detects non-canonical key (line_pay -> linepay) without mutating DB
    const reportRows = await generatePaymentMethodKeyReport(prisma);
    const legacyRow = reportRows.find((r) => r.raw_method === 'line_pay');
    assert.ok(legacyRow, 'report must list legacy line_pay');
    assert.equal(legacyRow.mapped_key, 'linepay');
    assert.ok(legacyRow.count >= 1);
    assert.equal(reportRows.some((r) => r.raw_method === 'other' && r.in_config === false), true);

    const stillLegacy = await prisma.payment.findUnique({ where: { payment_no: `P44I2-${runId}-1` } });
    assert.equal(stillLegacy?.method, 'line_pay', 'report script must remain strictly read-only');
  } finally {
    await srv?.close().catch(() => {});
    if (prevGlobalSetting) {
      await prisma.globalSetting.update({
        where: { id: 1 },
        data: { payment_methods_json: prevGlobalSetting.payment_methods_json }
      }).catch(() => {});
    }
    if (createdBookingRefs.length > 0) {
      await prisma.printJob.deleteMany({ where: { booking_ref: { in: createdBookingRefs } } }).catch(() => {});
      await prisma.bookingPerson.deleteMany({ where: { booking_ref: { in: createdBookingRefs } } }).catch(() => {});
    }
    await prisma.payment.deleteMany({
      where: {
        OR: [
          { payment_no: { in: createdPaymentNos } },
          { booking_ref: { in: createdBookingRefs } }
        ]
      }
    }).catch(() => {});
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
