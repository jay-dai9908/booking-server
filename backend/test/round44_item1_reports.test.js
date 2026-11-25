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

test('Round 44 Item 1: backend daily revenue, summary paid_booking_count/avg_ticket, cursor pagination, and full CSV exports excluding shop', async () => {
  const runId = `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  let srv = null;
  let staffUser = null;
  const createdUserIds = [];
  const createdSessionIds = [];
  const createdResIds = [];
  const createdBookingRefs = [];
  const createdPaymentNos = [];

  try {
    srv = await startLocalApp();
    staffUser = await prisma.adminUser.create({
      data: {
        password: `R44I1_${runId}_Pass!`,
        name: 'R44營收測試員',
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
        line_user_id: `r44_i1_cust_${runId}`,
        name: 'R44月報測試客',
        phone: `0944${runId.slice(-6)}`
      }
    });
    createdUserIds.push(customer.id);

    // Seed 60 bookings & 60 valid cash charge payments of 100 across 2026-11-01..2026-11-30 (2/day)
    const payData = [];
    for (let day = 1; day <= 30; day += 1) {
      const dd = String(day).padStart(2, '0');
      const dStr = `2026-11-${dd}`;
      const session = await prisma.session.upsert({
        where: { session_date_start_time: { session_date: dateOnly(dStr), start_time: '14:00' } },
        update: {},
        create: { session_date: dateOnly(dStr), start_time: '14:00', end_time: '16:00', max_capacity: 20 }
      });
      createdSessionIds.push(session.id);

      for (let k = 1; k <= 2; k += 1) {
        const ref = `R44I1-${runId}-${dd}-${k}`;
        createdBookingRefs.push(ref);
        const r = await prisma.reservation.create({
          data: {
            booking_ref: ref,
            user_id: customer.id,
            session_id: session.id,
            pax: 1,
            status: 'confirmed',
            is_paid: true,
            billing_status: 'paid',
            amount_due: 100,
            amount_received: 100
          }
        });
        createdResIds.push(r.id);

        const pNo = `R-R44I1-${runId}-${dd}-${k}`;
        createdPaymentNos.push(pNo);
        payData.push({
          payment_no: pNo,
          batch_no: `B-${pNo}`,
          booking_ref: ref,
          source: 'booking',
          kind: 'charge',
          method: 'cash',
          amount: 100,
          status: 'valid',
          person_nos: [1],
          staff_name: 'R44營收測試員',
          created_at: new Date(`${dStr}T1${k}:00:00+08:00`)
        });
      }
    }

    // 11/15 cash refund 300 on the first Nov 15 booking
    const refundNo = `R-R44I1-REF-${runId}`;
    createdPaymentNos.push(refundNo);
    payData.push({
      payment_no: refundNo,
      batch_no: `B-${refundNo}`,
      booking_ref: `R44I1-${runId}-15-1`,
      source: 'booking',
      kind: 'refund',
      method: 'cash',
      amount: 300,
      status: 'valid',
      person_nos: [1],
      reason: 'R44測試退款',
      staff_name: 'R44營收測試員',
      created_at: new Date('2026-11-15T18:00:00+08:00')
    });

    // 11/10 shop deposit 500 (source: 'shop') -> MUST be excluded from all store revenue reports
    const shopOrderRef = `ORD-R44I1-${runId}`;
    const shopPayNo = `R-R44I1-SHOP-${runId}`;
    createdPaymentNos.push(shopPayNo);
    payData.push({
      payment_no: shopPayNo,
      batch_no: `B-${shopPayNo}`,
      booking_ref: shopOrderRef,
      source: 'shop',
      source_ref: shopOrderRef,
      kind: 'charge',
      method: 'transfer',
      amount: 500,
      status: 'valid',
      person_nos: [],
      staff_name: '商城後台',
      created_at: new Date('2026-11-10T15:00:00+08:00')
    });

    await prisma.payment.createMany({
      data: payData.map((p) => ({
        ...p,
        device_label: '櫃檯',
        breakdown_json: { customer_name: 'R44月報測試客' }
      }))
    });

    // Also create 60 audit events in Nov 2026 tagged with runId for events.csv check
    const evData = Array.from({ length: 60 }, (_, idx) => ({
      booking_ref: createdBookingRefs[idx],
      event_type: 'charge_collected',
      category: 'charge',
      summary: `R44I1事件_${runId}_${idx + 1}`,
      amount: 100,
      staff_name: `R44事件員_${runId}`,
      device_label: '測試機',
      created_at: new Date('2026-11-20T12:00:00+08:00')
    }));
    await prisma.accountingEvent.createMany({ data: evData });

    // 1. Summary check (2026-11-01..2026-11-30)
    const sumRes = await fetch(`${srv.baseUrl}/api/accounting/summary?start_date=2026-11-01&end_date=2026-11-30`, { headers: authHeaders });
    assert.equal(sumRes.status, 200);
    const sumBody = await sumRes.json();
    assert.equal(sumBody.net_revenue, 5700);
    assert.equal(sumBody.paid_booking_count, 60);
    assert.equal(sumBody.avg_ticket, 95);

    // 2. Daily revenue check (30 rows, day 1=200, day 10=200 (no shop 500!), day 15=-100, sum net=5700)
    const dailyRes = await fetch(`${srv.baseUrl}/api/accounting/daily?date_from=2026-11-01&date_to=2026-11-30`, { headers: authHeaders });
    assert.equal(dailyRes.status, 200);
    const dailyBody = await dailyRes.json();
    assert.equal(dailyBody.daily.length, 30);
    const nov01 = dailyBody.daily.find((d) => d.date === '2026-11-01');
    const nov10 = dailyBody.daily.find((d) => d.date === '2026-11-10');
    const nov15 = dailyBody.daily.find((d) => d.date === '2026-11-15');
    assert.equal(nov01.net, 200);
    assert.equal(nov10.net, 200, '11/10 daily net must exclude 500 shop payment');
    assert.equal(nov15.net, -100);
    assert.equal(dailyBody.daily.reduce((s, d) => s + d.net, 0), 5700);

    // 3. payments.csv without source -> 61 data rows + BOM + Content-Disposition; with source=shop -> 1 row
    const csvRes = await fetch(`${srv.baseUrl}/api/accounting/payments.csv?date_from=2026-11-01&date_to=2026-11-30`, { headers: authHeaders });
    assert.equal(csvRes.status, 200);
    const csvDisp = csvRes.headers.get('content-disposition') || '';
    assert.ok(csvDisp.includes("filename*=UTF-8''"), `Expected UTF-8 filename header, got: ${csvDisp}`);
    const csvBuf = Buffer.from(await csvRes.arrayBuffer());
    assert.equal(csvBuf[0], 0xef);
    assert.equal(csvBuf[1], 0xbb);
    assert.equal(csvBuf[2], 0xbf);
    const csvText = csvBuf.toString('utf8');
    assert.ok(csvText.startsWith('\uFEFF'), 'CSV must start with UTF-8 BOM');
    const csvLines = csvText.replace(/^\uFEFF/, '').split(/\r?\n/).filter(Boolean);
    assert.equal(csvLines.length - 1, 61, 'payments.csv must have 61 data rows (60 charges + 1 refund, excluding shop)');
    assert.ok(csvLines[0].includes('"來源"'));

    const shopCsvRes = await fetch(`${srv.baseUrl}/api/accounting/payments.csv?date_from=2026-11-01&date_to=2026-11-30&source=shop`, { headers: authHeaders });
    assert.equal(shopCsvRes.status, 200);
    const shopCsvText = await shopCsvRes.text();
    const shopLines = shopCsvText.replace(/^\uFEFF/, '').split(/\r?\n/).filter(Boolean);
    assert.equal(shopLines.length - 1, 1, 'payments.csv?source=shop must return 1 row');

    // 4. GET /payments cursor pagination (50 + 11 = 61, total_count = 61)
    const p1Res = await fetch(`${srv.baseUrl}/api/accounting/payments?date_from=2026-11-01&date_to=2026-11-30`, { headers: authHeaders });
    assert.equal(p1Res.status, 200);
    const p1 = await p1Res.json();
    assert.equal(p1.total_count, 61);
    assert.equal(p1.payments.length, 50);
    assert.ok(p1.next_cursor, 'First page must return next_cursor');

    const p2Res = await fetch(`${srv.baseUrl}/api/accounting/payments?date_from=2026-11-01&date_to=2026-11-30&cursor=${p1.next_cursor}`, { headers: authHeaders });
    assert.equal(p2Res.status, 200);
    const p2 = await p2Res.json();
    assert.equal(p2.payments.length, 11);
    assert.equal(p2.next_cursor, null);
    const seenIds = new Set([...p1.payments, ...p2.payments].map((p) => p.id));
    assert.equal(seenIds.size, 61);

    // 5. events.csv -> 60 rows
    const evCsvRes = await fetch(`${srv.baseUrl}/api/accounting/events.csv?date_from=2026-11-01&date_to=2026-11-30&staff=${encodeURIComponent(`R44事件員_${runId}`)}`, { headers: authHeaders });
    assert.equal(evCsvRes.status, 200);
    const evCsvBuf = Buffer.from(await evCsvRes.arrayBuffer());
    assert.equal(evCsvBuf[0], 0xef);
    assert.equal(evCsvBuf[1], 0xbb);
    assert.equal(evCsvBuf[2], 0xbf);
    const evCsvText = evCsvBuf.toString('utf8');
    assert.ok(evCsvText.startsWith('\uFEFF'));
    const evLines = evCsvText.replace(/^\uFEFF/, '').split(/\r?\n/).filter(Boolean);
    assert.equal(evLines.length - 1, 60);

    // 6. daily > 366 days -> 400
    const badRangeRes = await fetch(`${srv.baseUrl}/api/accounting/daily?date_from=2025-01-01&date_to=2026-12-31`, { headers: authHeaders });
    assert.equal(badRangeRes.status, 400);
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
