import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import express from 'express';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';
import prisma from '../src/prismaClient.js';
import authRoutes from '../src/routes/auth.js';
import reservationRoutes from '../src/routes/reservations.js';
import passRoutes from '../src/routes/passes.js';
import checkoutRoutes from '../src/routes/checkout.js';
import shopRoutes from '../src/routes/shop.js';
import { generateToken } from '../src/middlewares/authMiddleware.js';
import { ensureDefaultEquipmentConfigs } from '../src/controllers/equipmentController.js';
import { dateOnly } from '../../shared/time.js';
import { ensureTestPublishedLayout, cleanupTestPublishedLayout } from './helpers/seedTestLayout.js';

function startLocalTestServer() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/auth', authRoutes);
  app.use('/api/reservations', reservationRoutes);
  app.use('/api/passes', passRoutes);
  app.use('/api/checkout', checkoutRoutes);
  app.use('/api/shop', shopRoutes);
  app.use((err, req, res, next) => {
    res.status(500).json({ error: err?.message || 'Internal error' });
  });

  const server = http.createServer(app);
  return new Promise((resolve, reject) => {
    server.listen(0, (err) => {
      if (err) return reject(err);
      const port = server.address().port;
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        close: () => new Promise((res) => server.close(res))
      });
    });
  });
}

test('Round 30 Item 4: customer-only endpoints reject admin/legacy/temp tokens and admin operations use permission-checked admin routes', async (t) => {
  const runId = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const futureDateStr = '2099-11-20';
  const futureDate = dateOnly(futureDateStr);

  const refUnpaid = `R30-I4-UNPAID-${runId}`;
  const refPaid = `R30-I4-PAID-${runId}`;
  const refEquip = `R30-I4-EQ-${runId}`;
  const cleanupRefs = [refUnpaid, refPaid, refEquip];
  const promoCodeStr = `R30POS${runId.slice(-6).toUpperCase()}`;

  let testServer = null;
  let createdLayoutId = null;
  let createdSessions = [];
  let customerA = null;
  let customerB = null;
  let staffNoPerm = null;
  let staffRes = null;
  let staffShop = null;
  let staffCoupons = null;
  let promoRow = null;
  let product = null;
  let orderPending = null;
  let orderVerified = null;

  t.after(async () => {
    if (testServer) await testServer.close();

    await prisma.accountingEvent.deleteMany({
      where: {
        category: 'shop',
        event_type: 'shop_remittance_updated',
        booking_ref: { in: [orderPending?.order_ref, orderVerified?.order_ref].filter(Boolean) }
      }
    }).catch(() => {});

    await prisma.bookingEquipment.deleteMany({ where: { booking_ref: { in: cleanupRefs } } }).catch(() => {});
    await prisma.reservation.deleteMany({ where: { booking_ref: { in: cleanupRefs } } }).catch(() => {});

    if (promoRow?.id) await prisma.promoCode.delete({ where: { id: promoRow.id } }).catch(() => {});
    const orderIds = [orderPending?.id, orderVerified?.id].filter(Boolean);
    if (orderIds.length > 0) {
      await prisma.productOrderItem.deleteMany({ where: { order_id: { in: orderIds } } }).catch(() => {});
      await prisma.productOrder.deleteMany({ where: { id: { in: orderIds } } }).catch(() => {});
    }
    if (product?.id) await prisma.product.delete({ where: { id: product.id } }).catch(() => {});

    for (const s of createdSessions) {
      await prisma.reservation.deleteMany({ where: { session_id: s.id } }).catch(() => {});
      await prisma.session.delete({ where: { id: s.id } }).catch(() => {});
    }

    const adminIds = [staffNoPerm?.id, staffRes?.id, staffShop?.id, staffCoupons?.id].filter(Boolean);
    if (adminIds.length > 0) {
      await prisma.adminUser.deleteMany({ where: { id: { in: adminIds } } }).catch(() => {});
    }
    const userIds = [customerA?.id, customerB?.id].filter(Boolean);
    if (userIds.length > 0) {
      await prisma.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => {});
    }
    await cleanupTestPublishedLayout(prisma, createdLayoutId);
  });

  await ensureDefaultEquipmentConfigs();
  createdLayoutId = await ensureTestPublishedLayout(prisma, { effectiveDate: futureDateStr });

  // Create two future sessions (10:00-11:00, 11:00-12:00)
  for (const [st, et] of [['10:00', '11:00'], ['11:00', '12:00']]) {
    let s = await prisma.session.findUnique({
      where: { session_date_start_time: { session_date: futureDate, start_time: st } }
    });
    if (!s) {
      s = await prisma.session.create({
        data: { session_date: futureDate, start_time: st, end_time: et, max_capacity: 16 }
      });
      createdSessions.push(s);
    }
  }
  const sess1 = await prisma.session.findUnique({
    where: { session_date_start_time: { session_date: futureDate, start_time: '10:00' } }
  });
  const sess2 = await prisma.session.findUnique({
    where: { session_date_start_time: { session_date: futureDate, start_time: '11:00' } }
  });

  // Pick a shared ID unused in both User and AdminUser so Customer A and Staff S share the exact same numeric ID
  const [maxUser, maxAdmin] = await Promise.all([
    prisma.user.aggregate({ _max: { id: true } }),
    prisma.adminUser.aggregate({ _max: { id: true } })
  ]);
  const sharedId = Math.max(maxUser._max.id || 0, maxAdmin._max.id || 0) + 100;

  customerA = await prisma.user.create({
    data: {
      id: sharedId,
      line_user_id: `U_r30_i4_A_${runId}`,
      name: 'Customer A',
      phone: '0900000041'
    }
  });
  customerB = await prisma.user.create({
    data: {
      line_user_id: `U_r30_i4_B_${runId}`,
      name: 'Customer B',
      phone: '0900000042'
    }
  });

  const passS = `r30_i4_s_${runId}`;
  const passR = `r30_i4_r_${runId}`;
  const passShop = `r30_i4_shop_${runId}`;
  const passC = `r30_i4_c_${runId}`;

  staffNoPerm = await prisma.adminUser.create({
    data: { id: sharedId, name: 'Staff NoPerm', password: passS, role: 'staff', permissions: [], is_active: true }
  });
  staffRes = await prisma.adminUser.create({
    data: { name: 'Staff Reservations', password: passR, role: 'staff', permissions: ['reservations'], is_active: true }
  });
  staffShop = await prisma.adminUser.create({
    data: { name: 'Staff Shop', password: passShop, role: 'staff', permissions: ['shop'], is_active: true }
  });
  staffCoupons = await prisma.adminUser.create({
    data: { name: 'Staff Coupons', password: passC, role: 'staff', permissions: ['coupons'], is_active: true }
  });

  // Ensure Postgres sequences are ahead of explicit sharedId so subsequent creates never collide
  await prisma.$executeRawUnsafe(`SELECT setval(pg_get_serial_sequence('"User"', 'id'), GREATEST((SELECT COALESCE(MAX(id), 1) FROM "User"), 1))`);
  await prisma.$executeRawUnsafe(`SELECT setval(pg_get_serial_sequence('"AdminUser"', 'id'), GREATEST((SELECT COALESCE(MAX(id), 1) FROM "AdminUser"), 1))`);

  // Reservations for Customer A
  await prisma.reservation.create({
    data: {
      booking_ref: refUnpaid,
      session_id: sess1.id,
      user_id: customerA.id,
      pax: 2,
      status: 'confirmed',
      is_paid: false,
      total_amount: 300,
      admin_note: 'original_admin_note'
    }
  });
  await prisma.reservation.create({
    data: {
      booking_ref: refPaid,
      session_id: sess1.id,
      user_id: customerA.id,
      pax: 2,
      status: 'confirmed',
      is_paid: true,
      amount_received: 0,
      total_amount: 300
    }
  });
  await prisma.reservation.createMany({
    data: [
      { booking_ref: refEquip, session_id: sess1.id, user_id: customerA.id, pax: 2, status: 'confirmed', total_amount: 300 },
      { booking_ref: refEquip, session_id: sess2.id, user_id: customerA.id, pax: 2, status: 'confirmed', total_amount: 300 }
    ]
  });

  // Shop product + orders for Customer A
  product = await prisma.product.create({
    data: { code: `R30_I4_P_${runId}`, name: 'R30 I4 Product', price: 200 }
  });
  orderPending = await prisma.productOrder.create({
    data: {
      order_ref: `ORD-R30-I4-P-${runId}`,
      user_id: customerA.id,
      total_amount: 200,
      deposit_required: 100,
      balance_amount: 100,
      payment_method_code: 'transfer',
      payment_status: 'pending_payment',
      remittance_last5: '11111'
    }
  });
  orderVerified = await prisma.productOrder.create({
    data: {
      order_ref: `ORD-R30-I4-V-${runId}`,
      user_id: customerA.id,
      total_amount: 200,
      deposit_required: 100,
      balance_amount: 100,
      payment_method_code: 'transfer',
      payment_status: 'deposit_verified',
      remittance_last5: '22222'
    }
  });

  // POS-only promo code
  promoRow = await prisma.promoCode.create({
    data: {
      code: promoCodeStr,
      name: 'POS Only Promo',
      discount_type: 'fixed_order',
      discount_value: 50,
      channel: 'pos',
      is_active: true
    }
  });

  testServer = await startLocalTestServer();
  const baseUrl = testServer.baseUrl;

  const loginAdmin = async (password) => {
    const r = await fetch(`${baseUrl}/api/auth/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password })
    });
    assert.equal(r.status, 200);
    return (await r.json()).token;
  };
  const loginCustomerTest = async (id) => {
    const r = await fetch(`${baseUrl}/api/auth/test-login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, role: 'customer' })
    });
    assert.equal(r.status, 200);
    return (await r.json()).token;
  };

  const [tokenS, tokenR, tokenShop, tokenC, tokenCustA, tokenCustB] = await Promise.all([
    loginAdmin(passS),
    loginAdmin(passR),
    loginAdmin(passShop),
    loginAdmin(passC),
    loginCustomerTest(customerA.id),
    loginCustomerTest(customerB.id)
  ]);

  // 1. Staff S (permissions: [], id === customerA.id) blocked with 403 CUSTOMER_ONLY on ALL 10 customer endpoints
  const staffSBlockedCalls = [
    { method: 'GET', path: '/api/reservations/my' },
    { method: 'GET', path: '/api/passes/my' },
    { method: 'GET', path: `/api/reservations/${refUnpaid}/entry` },
    { method: 'POST', path: '/api/reservations', body: { session_ids: [sess1.id], pax: 1 } },
    { method: 'DELETE', path: `/api/reservations/${refUnpaid}` },
    { method: 'PATCH', path: `/api/reservations/${refUnpaid}/notes`, body: { admin_note: 'hacked_note' } },
    { method: 'PATCH', path: `/api/reservations/${refEquip}/equipment`, body: { equipments: [] } },
    { method: 'POST', path: '/api/checkout/promo-codes/validate', body: { code: promoCodeStr, is_pos: true } },
    { method: 'PATCH', path: `/api/shop/orders/${orderPending.id}/remittance`, body: { remittance_last5: '99999' } },
    { method: 'GET', path: '/api/shop/my-orders' }
  ];

  for (const c of staffSBlockedCalls) {
    const r = await fetch(`${baseUrl}${c.path}`, {
      method: c.method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenS}` },
      body: c.body ? JSON.stringify(c.body) : undefined
    });
    assert.equal(r.status, 403, `Expected 403 for Staff S on ${c.method} ${c.path}, got ${r.status}`);
    const body = await r.json();
    assert.equal(body.code, 'CUSTOMER_ONLY', `Expected code CUSTOMER_ONLY on ${c.method} ${c.path}`);
  }

  // Verify DB state unchanged after Staff S attempts
  const unpaidCheck = await prisma.reservation.findFirst({ where: { booking_ref: refUnpaid } });
  assert.equal(unpaidCheck.status, 'confirmed');
  assert.equal(unpaidCheck.admin_note, 'original_admin_note');
  const orderCheck = await prisma.productOrder.findUnique({ where: { id: orderPending.id } });
  assert.equal(orderCheck.remittance_last5, '11111');

  // 2. Staff S calling new admin cancel route -> 403 無此功能存取權限
  const staffSAdminCancel = await fetch(`${baseUrl}/api/reservations/admin/${refUnpaid}/cancel`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenS}` },
    body: JSON.stringify({})
  });
  assert.equal(staffSAdminCancel.status, 403);
  assert.equal((await staffSAdminCancel.json()).error, '無此功能存取權限');

  // 3. Customer B cannot cancel A's reservation -> 403
  const custBCancel = await fetch(`${baseUrl}/api/reservations/${refUnpaid}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${tokenCustB}` }
  });
  assert.equal(custBCancel.status, 403);

  // 4. Staff R (reservations permission) admin routes: notes, equipment, cancel + REQUIRE_PAID_CANCEL_CONFIRM
  const adminNotesRes = await fetch(`${baseUrl}/api/reservations/admin/${refUnpaid}/notes`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenR}` },
    body: JSON.stringify({ admin_note: 'staff_verified_note', customer_note: 'cust_note' })
  });
  assert.equal(adminNotesRes.status, 200);
  const notesBody = await adminNotesRes.json();
  assert.equal(notesBody.admin_note, 'staff_verified_note');

  const adminEqRes = await fetch(`${baseUrl}/api/reservations/admin/${refEquip}/equipment`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenR}` },
    body: JSON.stringify({ equipments: [{ equipment_id: 'pegboard_s', quantity: 1, rental_hours: 2 }] })
  });
  assert.equal(adminEqRes.status, 200);

  const adminCancelUnpaid = await fetch(`${baseUrl}/api/reservations/admin/${refUnpaid}/cancel`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenR}` },
    body: JSON.stringify({})
  });
  assert.equal(adminCancelUnpaid.status, 200);

  const adminCancelPaidNoConfirm = await fetch(`${baseUrl}/api/reservations/admin/${refPaid}/cancel`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenR}` },
    body: JSON.stringify({})
  });
  assert.equal(adminCancelPaidNoConfirm.status, 409);
  assert.equal((await adminCancelPaidNoConfirm.json()).code, 'REQUIRE_PAID_CANCEL_CONFIRM');

  const adminCancelPaidConfirm = await fetch(`${baseUrl}/api/reservations/admin/${refPaid}/cancel`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenR}` },
    body: JSON.stringify({ confirmPaidCancel: true })
  });
  assert.equal(adminCancelPaidConfirm.status, 200);

  // 5. Legacy customer token (no typ) rejected with 401 on /api/reservations/my and /api/auth/me
  const legacyCustToken = jwt.sign({ id: customerA.id, role: 'customer' }, process.env.JWT_SECRET, { expiresIn: '1h' });
  const legacyResMy = await fetch(`${baseUrl}/api/reservations/my`, {
    headers: { Authorization: `Bearer ${legacyCustToken}` }
  });
  assert.equal(legacyResMy.status, 401);

  const legacyMe = await fetch(`${baseUrl}/api/auth/me`, {
    headers: { Authorization: `Bearer ${legacyCustToken}` }
  });
  assert.equal(legacyMe.status, 401);

  // 6. Temp token rejected with 401 on /api/reservations/my
  const tempToken = generateToken({ line_user_id: `U_tmp_${runId}`, isTemp: true, typ: 'line_temp' }, { expiresIn: '30m' });
  const tempResMy = await fetch(`${baseUrl}/api/reservations/my`, {
    headers: { Authorization: `Bearer ${tempToken}` }
  });
  assert.equal(tempResMy.status, 401);

  // 7. Deprecated /api/checkout/admin/promo-codes/validate returns 410 GONE (replaced by /api/billing/:ref/promos in Round 34 Item 2), customer route forces is_pos=false (fails)
  const adminPromoRes = await fetch(`${baseUrl}/api/checkout/admin/promo-codes/validate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenC}` },
    body: JSON.stringify({ code: promoCodeStr, base_amount: 300, pax: 1, hours: 1, is_pos: false })
  });
  assert.equal(adminPromoRes.status, 410);
  const adminPromoData = await adminPromoRes.json();
  assert.equal(adminPromoData.code, 'GONE');

  const custPromoRes = await fetch(`${baseUrl}/api/checkout/promo-codes/validate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenCustA}` },
    body: JSON.stringify({ code: promoCodeStr, base_amount: 300, pax: 1, hours: 1, is_pos: true })
  });
  assert.equal(custPromoRes.status, 400);
  assert.equal((await custPromoRes.json()).valid, false);

  // 8. Shop order remittance: deposit_verified order rejected 409 for customer, allowed for shop admin with audit log
  const custRemitVerified = await fetch(`${baseUrl}/api/shop/orders/${orderVerified.id}/remittance`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenCustA}` },
    body: JSON.stringify({ remittance_last5: '55555' })
  });
  assert.equal(custRemitVerified.status, 409);

  const adminRemitRes = await fetch(`${baseUrl}/api/shop/admin/orders/${orderVerified.id}/remittance`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenShop}` },
    body: JSON.stringify({ remittance_last5: '77777' })
  });
  assert.equal(adminRemitRes.status, 200);

  const remitAudit = await prisma.accountingEvent.findFirst({
    where: { category: 'shop', event_type: 'shop_remittance_updated', booking_ref: orderVerified.order_ref }
  });
  assert.ok(remitAudit, 'Admin remittance update must write audit log');
});
