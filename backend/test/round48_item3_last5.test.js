import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import cookieParser from 'cookie-parser';
import prisma from '../src/prismaClient.js';
import { generateToken } from '../src/middlewares/authMiddleware.js';
import reservationRoutes from '../src/routes/reservations.js';
import shopRoutes from '../src/routes/shop.js';
import { releaseExpiredPrepays } from '../src/services/selfService/prepayService.js';
import { dateOnly, toTaipeiDateString } from '../../shared/time.js';
import { ensureTestPublishedLayout, cleanupTestPublishedLayout } from './helpers/seedTestLayout.js';

function startLocalApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/reservations', reservationRoutes);
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

test('Round 48 Item 3: Last-5 deadline guard, reported/mismatch unpaid & pool hold limits, releaseExpiredPrepays preservation, and shop remittance guards', async () => {
  const TS = Date.now();
  const srv = await startLocalApp();
  let createdLayoutId = null;
  let user = null;
  let userHold = null;
  let product = null;
  let createdPoolMethod = false;
  let createdBankMethod = false;
  const poolMethodCode = 'ctbc_pool';
  const bankMethodCode = `r48_bank_${TS}`;
  const createdSessionIds = [];
  const createdDates = [];
  const createdPoolIds = [];
  const createdOrderIds = [];
  const createdBookingRefs = [];
  let prevKioskMaxUnpaid = null;

  try {
    createdLayoutId = await ensureTestPublishedLayout(prisma);
    const ks = await prisma.kioskSetting.findUnique({ where: { id: 1 } });
    prevKioskMaxUnpaid = ks?.max_unpaid_self_bookings ?? null;
    await prisma.kioskSetting.upsert({
      where: { id: 1 },
      update: { max_unpaid_self_bookings: 2 },
      create: { id: 1, max_unpaid_self_bookings: 2 }
    });

    const existingPoolCfg = await prisma.paymentMethodConfig.findUnique({ where: { code: poolMethodCode } });
    if (!existingPoolCfg) {
      await prisma.paymentMethodConfig.create({
        data: { code: poolMethodCode, name: '專屬帳號', method_type: 'POOL_ACCOUNT', is_enabled: true }
      });
      createdPoolMethod = true;
    }
    await prisma.paymentMethodConfig.create({
      data: {
        code: bankMethodCode,
        name: '一般匯款',
        method_type: 'MULTI_BANK',
        is_enabled: true,
        bank_accounts_json: [{ bank_name: '測試銀', bank_code: '007', account: '00000000000888' }]
      }
    });
    createdBankMethod = true;

    user = await prisma.user.create({
      data: { name: 'R48末五碼客', phone: `0987${String(TS).slice(-6)}`, line_user_id: `r48_i3_u1_${TS}` }
    });
    userHold = await prisma.user.create({
      data: { name: 'R48帳號上限客', phone: `0986${String(TS).slice(-6)}`, line_user_id: `r48_i3_u2_${TS}` }
    });
    const token1 = generateToken({ id: user.id, typ: 'customer', line_user_id: user.line_user_id, role: 'customer', name: user.name });
    const token2 = generateToken({ id: userHold.id, typ: 'customer', line_user_id: userHold.line_user_id, role: 'customer', name: userHold.name });
    const hdr1 = { 'Content-Type': 'application/json', Authorization: `Bearer ${token1}` };
    const hdr2 = { 'Content-Type': 'application/json', Authorization: `Bearer ${token2}` };

    const yesterdayStr = toTaipeiDateString(new Date(Date.now() - 86400000));
    const futStr1 = toTaipeiDateString(new Date(Date.now() + 60 * 86400000));
    const futStr2 = toTaipeiDateString(new Date(Date.now() + 61 * 86400000));
    const futStr3 = toTaipeiDateString(new Date(Date.now() + 62 * 86400000));

    for (const dStr of [yesterdayStr, futStr1, futStr2, futStr3]) {
      const dObj = dateOnly(dStr);
      const existingDs = await prisma.dailySetting.findUnique({ where: { date: dObj } });
      if (!existingDs) {
        createdDates.push(dObj);
      }
      await prisma.dailySetting.upsert({
        where: { date: dObj },
        update: { is_self_service: true, allow_unlimited: true, day_type: 'self', day_type_source: 'manual' },
        create: { date: dObj, is_self_service: true, allow_unlimited: true, day_type: 'self', day_type_source: 'manual' }
      });
    }

    const mkSessions = async (dStr, hours = ['13:00-14:00', '14:00-15:00', '15:00-16:00', '16:00-17:00']) => {
      const dObj = dateOnly(dStr);
      const created = [];
      for (const h of hours) {
        const [start_time, end_time] = h.split('-');
        let s = await prisma.session.findUnique({
          where: { session_date_start_time: { session_date: dObj, start_time } }
        });
        if (!s) {
          s = await prisma.session.create({
            data: { session_date: dObj, start_time, end_time, max_capacity: 10 }
          });
          createdSessionIds.push(s.id);
        }
        created.push(s);
      }
      return created;
    };

    const sessYest = await mkSessions(yesterdayStr);
    const sessFut1 = await mkSessions(futStr1);
    const sessFut2 = await mkSessions(futStr2);
    const sessFut3 = await mkSessions(futStr3);

    // Build 1st future pending_payment booking
    const createSelfRes = async (hdr, sessList) => {
      const res = await fetch(`${srv.baseUrl}/api/reservations`, {
        method: 'POST',
        headers: hdr,
        body: JSON.stringify({
          session_ids: sessList.map((s) => s.id),
          pax: 1,
          isUnlimited: true,
          self_service_ack: true,
          prepay: {
            pass_uses: [],
            transfer: { payment_method_code: bankMethodCode }
          }
        })
      });
      const body = await res.json();
      if (res.status === 201 && body.reservation?.booking_ref) {
        createdBookingRefs.push(body.reservation.booking_ref);
      }
      return { status: res.status, body };
    };

    const r1 = await createSelfRes(hdr1, sessFut1);
    assert.equal(r1.status, 201);
    const ref1 = r1.body.reservation.booking_ref;

    // 1. Force deadline_at 1 min ago on pending_payment -> 409 PREPAY_DEADLINE_PASSED
    await prisma.bookingPrepay.update({
      where: { booking_ref: ref1 },
      data: { deadline_at: new Date(Date.now() - 60000) }
    });
    const resLast5Expired = await fetch(`${srv.baseUrl}/api/reservations/${ref1}/prepay/remittance`, {
      method: 'PATCH',
      headers: hdr1,
      body: JSON.stringify({ remittance_last5: '11111' })
    });
    assert.equal(resLast5Expired.status, 409);
    const bodyExpired = await resLast5Expired.json();
    assert.equal(bodyExpired.code, 'PREPAY_DEADLINE_PASSED');
    const prepayAfterBlocked = await prisma.bookingPrepay.findUnique({ where: { booking_ref: ref1 } });
    assert.equal(prepayAfterBlocked.status, 'pending_payment');

    // Restore future deadline for ref1, and create 2nd future booking -> report ref2 (reported_pending_verify) even after forcing expired deadline
    await prisma.bookingPrepay.update({
      where: { booking_ref: ref1 },
      data: { deadline_at: new Date(Date.now() + 86400000) }
    });
    const r2 = await createSelfRes(hdr1, sessFut2);
    assert.equal(r2.status, 201);
    const ref2 = r2.body.reservation.booking_ref;

    // Make ref2 reported_pending_verify AND expired deadline_at
    await prisma.bookingPrepay.update({
      where: { booking_ref: ref2 },
      data: { status: 'reported_pending_verify', remittance_last5: '22222', deadline_at: new Date(Date.now() - 60000) }
    });

    // 2. Editing last5 on expired reported_pending_verify succeeds & keeps status
    const resEditReported = await fetch(`${srv.baseUrl}/api/reservations/${ref2}/prepay/remittance`, {
      method: 'PATCH',
      headers: hdr1,
      body: JSON.stringify({ remittance_last5: '54321' })
    });
    assert.equal(resEditReported.status, 200);
    const prepay2 = await prisma.bookingPrepay.findUnique({ where: { booking_ref: ref2 } });
    assert.equal(prepay2.remittance_last5, '54321');
    assert.equal(prepay2.status, 'reported_pending_verify');

    // 3. Mismatch -> edit last5 turns status into reported_pending_verify
    await prisma.bookingPrepay.update({
      where: { booking_ref: ref2 },
      data: { status: 'mismatch' }
    });
    const resEditMismatch = await fetch(`${srv.baseUrl}/api/reservations/${ref2}/prepay/remittance`, {
      method: 'PATCH',
      headers: hdr1,
      body: JSON.stringify({ remittance_last5: '67890' })
    });
    assert.equal(resEditMismatch.status, 200);
    const prepay2AfterMismatch = await prisma.bookingPrepay.findUnique({ where: { booking_ref: ref2 } });
    assert.equal(prepay2AfterMismatch.status, 'reported_pending_verify');

    // 4. Unpaid limit=2: 1 pending_payment (ref1) + 1 reported_pending_verify (ref2), both future -> 3rd fails 409 TOO_MANY_UNPAID
    const r3Blocked = await createSelfRes(hdr1, sessFut3);
    assert.equal(r3Blocked.status, 409);
    assert.equal(r3Blocked.body.code, 'TOO_MANY_UNPAID');

    // 5. Move ref2 reservation session to yesterday (past date) -> 3rd future booking succeeds!
    const ref2ResRows = await prisma.reservation.findMany({ where: { booking_ref: ref2 }, orderBy: { id: 'asc' } });
    for (let i = 0; i < ref2ResRows.length; i++) {
      await prisma.reservation.update({
        where: { id: ref2ResRows[i].id },
        data: { session_id: sessYest[i].id }
      });
    }
    const r3Ok = await createSelfRes(hdr1, sessFut3);
    assert.equal(r3Ok.status, 201);

    // 6. releaseExpiredPrepays preserves reported_pending_verify even when deadline_at is past
    await releaseExpiredPrepays(new Date());
    const ref2StillConfirmed = await prisma.reservation.findFirst({ where: { booking_ref: ref2 } });
    assert.equal(ref2StillConfirmed.status, 'confirmed');

    // 7. Pool holds count reported_pending_verify shop + mismatch self-service (userHold has limit 2)
    const pa1 = await prisma.oneTimeAccountPool.create({
      data: { payment_method_code: poolMethodCode, account_number: `00000101${String(TS).slice(-6)}`, status: 'ASSIGNED', assigned_user_id: userHold.id }
    });
    const pa2 = await prisma.oneTimeAccountPool.create({
      data: { payment_method_code: poolMethodCode, account_number: `00000102${String(TS).slice(-6)}`, status: 'ASSIGNED', assigned_user_id: userHold.id }
    });
    const pa3 = await prisma.oneTimeAccountPool.create({
      data: { payment_method_code: poolMethodCode, account_number: `00000103${String(TS).slice(-6)}`, status: 'AVAILABLE' }
    });
    createdPoolIds.push(pa1.id, pa2.id, pa3.id);

    product = await prisma.product.create({
      data: { code: `R48I3_P_${TS}`, name: 'R48商城測試物', price: 300, deposit_amount: 300, visibility_status: 'ACTIVE' }
    });
    const shopReported = await prisma.productOrder.create({
      data: {
        order_ref: `PO-R48I3-1-${TS}`,
        user_id: userHold.id,
        total_amount: 300,
        deposit_required: 300,
        balance_amount: 300,
        payment_method_code: poolMethodCode,
        assigned_pool_account: pa1.account_number,
        payment_status: 'reported_pending_verify',
        order_status: 'preorder_placed'
      }
    });
    const shopCancelled = await prisma.productOrder.create({
      data: {
        order_ref: `PO-R48I3-2-${TS}`,
        user_id: userHold.id,
        total_amount: 300,
        deposit_required: 300,
        balance_amount: 300,
        payment_method_code: bankMethodCode,
        payment_status: 'pending_payment',
        order_status: 'cancelled'
      }
    });
    const shopExpired = await prisma.productOrder.create({
      data: {
        order_ref: `PO-R48I3-3-${TS}`,
        user_id: userHold.id,
        total_amount: 300,
        deposit_required: 300,
        balance_amount: 300,
        payment_method_code: bankMethodCode,
        payment_status: 'pending_payment',
        payment_deadline: new Date(Date.now() - 60000),
        order_status: 'preorder_placed'
      }
    });
    createdOrderIds.push(shopReported.id, shopCancelled.id, shopExpired.id);

    const selfHoldRef = `R48-I3-HOLD-${TS}`;
    createdBookingRefs.push(selfHoldRef);
    await prisma.bookingPrepay.create({
      data: {
        booking_ref: selfHoldRef,
        user_id: userHold.id,
        total_amount: 550,
        amount_due: 550,
        status: 'mismatch',
        assigned_pool_account: pa2.account_number
      }
    });

    const holdBlocked = await fetch(`${srv.baseUrl}/api/reservations`, {
      method: 'POST',
      headers: hdr2,
      body: JSON.stringify({
        session_ids: sessFut3.map((s) => s.id),
        pax: 1,
        isUnlimited: true,
        self_service_ack: true,
        prepay: { pass_uses: [], transfer: { payment_method_code: poolMethodCode } }
      })
    });
    assert.equal(holdBlocked.status, 409);
    const holdBody = await holdBlocked.json();
    assert.equal(holdBody.code, 'POOL_HOLD_LIMIT');

    // 8. Shop remittance guards: 'abcde' -> 400, cancelled -> 409, expired pending_payment -> 409 PREPAY_DEADLINE_PASSED
    const shopBad5 = await fetch(`${srv.baseUrl}/api/shop/orders/${shopReported.id}/remittance`, {
      method: 'PATCH',
      headers: hdr2,
      body: JSON.stringify({ remittance_last5: 'abcde' })
    });
    assert.equal(shopBad5.status, 400);

    const shopCanRes = await fetch(`${srv.baseUrl}/api/shop/orders/${shopCancelled.id}/remittance`, {
      method: 'PATCH',
      headers: hdr2,
      body: JSON.stringify({ remittance_last5: '12345' })
    });
    assert.equal(shopCanRes.status, 409);

    const shopExpRes = await fetch(`${srv.baseUrl}/api/shop/orders/${shopExpired.id}/remittance`, {
      method: 'PATCH',
      headers: hdr2,
      body: JSON.stringify({ remittance_last5: '12345' })
    });
    assert.equal(shopExpRes.status, 409);
    const shopExpBody = await shopExpRes.json();
    assert.equal(shopExpBody.code, 'PREPAY_DEADLINE_PASSED');
  } finally {
    await srv.close();
    if (createdBookingRefs.length > 0) {
      await prisma.reservation.deleteMany({ where: { booking_ref: { in: createdBookingRefs } } }).catch(() => {});
      await prisma.bookingPrepay.deleteMany({ where: { booking_ref: { in: createdBookingRefs } } }).catch(() => {});
      await prisma.accountingEvent.deleteMany({ where: { booking_ref: { in: createdBookingRefs } } }).catch(() => {});
    }
    if (createdOrderIds.length > 0) {
      await prisma.productOrder.deleteMany({ where: { id: { in: createdOrderIds } } }).catch(() => {});
    }
    if (createdPoolIds.length > 0) {
      await prisma.oneTimeAccountPool.deleteMany({ where: { id: { in: createdPoolIds } } }).catch(() => {});
    }
    if (createdSessionIds.length > 0) {
      await prisma.session.deleteMany({ where: { id: { in: createdSessionIds } } }).catch(() => {});
    }
    if (createdDates.length > 0) {
      await prisma.dailySetting.deleteMany({ where: { date: { in: createdDates } } }).catch(() => {});
    }
    if (createdBankMethod) {
      await prisma.paymentMethodConfig.deleteMany({ where: { code: bankMethodCode } }).catch(() => {});
    }
    if (createdPoolMethod) {
      await prisma.paymentMethodConfig.deleteMany({ where: { code: poolMethodCode } }).catch(() => {});
    }
    if (product) {
      await prisma.product.deleteMany({ where: { id: product.id } }).catch(() => {});
    }
    const uids = [user?.id, userHold?.id].filter(Boolean);
    if (uids.length > 0) {
      await prisma.user.deleteMany({ where: { id: { in: uids } } }).catch(() => {});
    }
    if (prevKioskMaxUnpaid !== null) {
      await prisma.kioskSetting.update({ where: { id: 1 }, data: { max_unpaid_self_bookings: prevKioskMaxUnpaid } }).catch(() => {});
    }
    await cleanupTestPublishedLayout(prisma, createdLayoutId);
  }
});
