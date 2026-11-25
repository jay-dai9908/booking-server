import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import cookieParser from 'cookie-parser';
import prisma from '../src/prismaClient.js';
import { generateToken } from '../src/middlewares/authMiddleware.js';
import userRoutes from '../src/routes/users.js';
import reservationRoutes from '../src/routes/reservations.js';
import { dateOnly, toTaipeiDateString } from '../../shared/time.js';

function startLocalApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/users', userRoutes);
  app.use('/api/reservations', reservationRoutes);

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

test('Round 44 Item 4: member total_paid/shop-orders/payments endpoints and reservations day/month/all search scope', async () => {
  const runId = `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const todayStr = toTaipeiDateString(new Date());
  const thisMonthStr = todayStr.slice(0, 7);
  const [yr, mo] = thisMonthStr.split('-').map(Number);
  const prevMonthDateObj = new Date(Date.UTC(yr, mo - 2, 15));
  const prevMonthDateStr = prevMonthDateObj.toISOString().slice(0, 10);

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
        password: `R44I4_${runId}_Pass!`,
        name: `R44會員測試_${runId}`,
        permissions: ['members', 'reservations'],
        is_active: true
      }
    });
    const token = generateToken({
      id: staffUser.id,
      role: 'admin',
      name: staffUser.name,
      permissions: ['members', 'reservations'],
      token_version: staffUser.token_version
    });
    const authHeaders = { Authorization: `Bearer ${token}` };

    const member = await prisma.user.create({
      data: {
        line_user_id: `r44_i4_mem_${runId}`,
        name: 'R44會員實付測試客',
        phone: `0944${runId.slice(-6)}`
      }
    });
    createdUserIds.push(member.id);

    const searchMember = await prisma.user.create({
      data: {
        line_user_id: `r44_i4_search_${runId}`,
        name: 'R44跨月搜尋客',
        phone: '0900000123'
      }
    });
    createdUserIds.push(searchMember.id);

    const todaySession = await prisma.session.upsert({
      where: { session_date_start_time: { session_date: dateOnly(todayStr), start_time: '14:00' } },
      update: {},
      create: { session_date: dateOnly(todayStr), start_time: '14:00', end_time: '18:00', max_capacity: 20 }
    });
    const prevSession = await prisma.session.upsert({
      where: { session_date_start_time: { session_date: dateOnly(prevMonthDateStr), start_time: '14:00' } },
      update: {},
      create: { session_date: dateOnly(prevMonthDateStr), start_time: '14:00', end_time: '18:00', max_capacity: 20 }
    });

    const ref1 = `R44M4-${runId}-1`;
    const ref2 = `R44M4-${runId}-2`;
    const ref3 = `R44M4-${runId}-3`;
    const refPrev = `R44M4-${runId}-PREV`;

    const r1 = await prisma.reservation.create({
      data: {
        booking_ref: ref1,
        user_id: member.id,
        session_id: todaySession.id,
        pax: 1,
        assigned_seats: ['1-1'],
        status: 'confirmed',
        attendance: 'checked_in',
        is_paid: true,
        billing_status: 'paid',
        has_refund: true,
        total_amount: 600,
        amount_due: 600,
        amount_received: 500
      }
    });
    const r2 = await prisma.reservation.create({
      data: {
        booking_ref: ref2,
        user_id: member.id,
        session_id: todaySession.id,
        pax: 1,
        assigned_seats: ['1-2'],
        status: 'confirmed',
        attendance: 'checked_in',
        is_paid: false,
        billing_status: 'unpaid',
        total_amount: 400,
        amount_due: 400,
        amount_received: 0
      }
    });
    const r3 = await prisma.reservation.create({
      data: {
        booking_ref: ref3,
        user_id: member.id,
        session_id: todaySession.id,
        pax: 1,
        assigned_seats: ['1-3'],
        status: 'confirmed',
        attendance: 'checked_in',
        is_paid: true,
        billing_status: 'paid',
        total_amount: 550,
        amount_due: 550,
        amount_received: 0
      }
    });
    const rPrev = await prisma.reservation.create({
      data: {
        booking_ref: refPrev,
        user_id: searchMember.id,
        session_id: prevSession.id,
        pax: 1,
        assigned_seats: ['1-4'],
        status: 'confirmed',
        total_amount: 300
      }
    });
    createdResIds.push(r1.id, r2.id, r3.id, rPrev.id);

    const shopOrderRef = `PO-R44-${runId}`;
    const ord = await prisma.productOrder.create({
      data: {
        order_ref: shopOrderRef,
        user_id: member.id,
        total_amount: 800,
        deposit_required: 300,
        paid_amount: 300,
        balance_amount: 500,
        payment_method_code: 'cash',
        payment_status: 'deposit_verified',
        order_status: 'preorder_placed'
      }
    });
    createdOrderIds.push(ord.id);

    const pNos = [`P44M4-${runId}-1`, `P44M4-${runId}-2`, `P44M4-${runId}-3`, `P44M4-${runId}-4`];
    createdPaymentNos.push(...pNos);
    const nowTs = new Date();
    await prisma.payment.createMany({
      data: [
        {
          payment_no: pNos[0],
          batch_no: `B_${pNos[0]}`,
          booking_ref: ref1,
          source: 'booking',
          source_ref: ref1,
          kind: 'charge',
          method: 'cash',
          amount: 600,
          status: 'valid',
          staff_name: staffUser.name,
          device_label: 'r44-i4-test',
          breakdown_json: {},
          created_at: new Date(nowTs.getTime() - 4000)
        },
        {
          payment_no: pNos[1],
          batch_no: `B_${pNos[1]}`,
          booking_ref: ref1,
          source: 'booking',
          source_ref: ref1,
          kind: 'refund',
          method: 'cash',
          amount: 100,
          status: 'valid',
          reason: '差額退款',
          staff_name: staffUser.name,
          device_label: 'r44-i4-test',
          breakdown_json: {},
          created_at: new Date(nowTs.getTime() - 3000)
        },
        {
          payment_no: pNos[2],
          batch_no: `B_${pNos[2]}`,
          booking_ref: ref3,
          source: 'booking',
          source_ref: ref3,
          kind: 'charge',
          method: 'pass',
          amount: 550,
          status: 'valid',
          staff_name: staffUser.name,
          device_label: 'r44-i4-test',
          breakdown_json: {},
          created_at: new Date(nowTs.getTime() - 2000)
        },
        {
          payment_no: pNos[3],
          batch_no: `B_${pNos[3]}`,
          booking_ref: shopOrderRef,
          source: 'shop',
          source_ref: shopOrderRef,
          kind: 'charge',
          method: 'cash',
          amount: 300,
          status: 'valid',
          staff_name: staffUser.name,
          device_label: 'r44-i4-test',
          breakdown_json: {},
          created_at: new Date(nowTs.getTime() - 1000)
        }
      ]
    });

    // 1. GET /api/users/:id -> total_paid 500, total_paid_shop 300, pass_used_value 550, stats.total_spent 500
    const userRes = await fetch(`${srv.baseUrl}/api/users/${member.id}`, { headers: authHeaders });
    assert.equal(userRes.status, 200);
    const userBody = await userRes.json();
    assert.equal(userBody.total_paid, 500);
    assert.equal(userBody.total_paid_shop, 300);
    assert.equal(userBody.pass_used_value, 550);
    assert.equal(userBody.stats.total_paid, 500);
    assert.equal(userBody.stats.total_paid_shop, 300);
    assert.equal(userBody.stats.pass_used_value, 550);
    assert.equal(userBody.stats.total_spent, 500);

    // 2. GET /api/users/:id/payments?kind=refund -> 1 refund of 100
    const refRes = await fetch(`${srv.baseUrl}/api/users/${member.id}/payments?kind=refund`, { headers: authHeaders });
    assert.equal(refRes.status, 200);
    const refBody = await refRes.json();
    assert.equal(refBody.total, 1);
    assert.equal(refBody.payments.length, 1);
    assert.equal(refBody.payments[0].amount, 100);
    assert.equal(refBody.payments[0].method_label, '現金');

    // 3. GET /api/users/:id/shop-orders -> 1 order, paid 300
    const ordRes = await fetch(`${srv.baseUrl}/api/users/${member.id}/shop-orders`, { headers: authHeaders });
    assert.equal(ordRes.status, 200);
    const ordBody = await ordRes.json();
    assert.equal(ordBody.total, 1);
    assert.equal(ordBody.orders.length, 1);
    assert.equal(ordBody.orders[0].order_ref, shopOrderRef);
    assert.equal(ordBody.orders[0].paid_amount, 300);

    // 4. Reservations search across months: month misses prevMonth phone, all finds it
    const mRes = await fetch(
      `${srv.baseUrl}/api/reservations/admin?scope=month&month=${thisMonthStr}&search=0900000123`,
      { headers: authHeaders }
    );
    assert.equal(mRes.status, 200);
    const mBody = await mRes.json();
    assert.equal(mBody.data.some((r) => r.booking_ref === refPrev), false);

    const aRes = await fetch(
      `${srv.baseUrl}/api/reservations/admin?scope=all&search=0900000123`,
      { headers: authHeaders }
    );
    assert.equal(aRes.status, 200);
    const aBody = await aRes.json();
    assert.equal(aBody.data.some((r) => r.booking_ref === refPrev), true);
    assert.equal(aBody.range_note, null);

    // 5. scope=all without search returns range_note and full counts
    const allDefaultRes = await fetch(
      `${srv.baseUrl}/api/reservations/admin?scope=all`,
      { headers: authHeaders }
    );
    assert.equal(allDefaultRes.status, 200);
    const allDefaultBody = await allDefaultRes.json();
    assert.equal(allDefaultBody.range_note, '最近 12 個月');
    assert.ok(allDefaultBody.counts && allDefaultBody.counts.all >= 4);

    // 6. scope=day&date=today returns only today's reservations (excludes prevMonth)
    const dayRes = await fetch(
      `${srv.baseUrl}/api/reservations/admin?scope=day&date=${todayStr}`,
      { headers: authHeaders }
    );
    assert.equal(dayRes.status, 200);
    const dayBody = await dayRes.json();
    assert.equal(dayBody.data.some((r) => r.booking_ref === ref1), true);
    assert.equal(dayBody.data.some((r) => r.booking_ref === refPrev), false);
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
