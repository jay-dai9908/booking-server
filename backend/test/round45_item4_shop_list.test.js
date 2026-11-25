import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import cookieParser from 'cookie-parser';
import prisma from '../src/prismaClient.js';
import { generateToken } from '../src/middlewares/authMiddleware.js';
import shopRoutes from '../src/routes/shop.js';
import { createProductOrder } from '../src/controllers/shopController.js';
import { releaseExpiredPreorders } from '../src/cronJobs.js';
import { runEnableShopOrderExpiry } from '../scripts/enable-shop-order-expiry.mjs';
import { dateOnly } from '../../shared/time.js';

function startLocalApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/shop', shopRoutes);
  // Bypass IP rate-limit (max 10/10m) solely to stress-test 20 parallel createProductOrder transactions
  app.post('/api/shop-test/orders', (req, res, next) => {
    const uid = Number(req.headers['x-test-user-id']);
    req.user = { id: uid, typ: 'customer', role: 'customer' };
    next();
  }, createProductOrder);

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

test('Round 45 Item 4: universal expiry, auto_expire flag, enable-shop-order-expiry script, Taipei PO-YYYYMMDD-NNNN concurrency, and pagination/overdue filter', async () => {
  const runId = `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const poolAcctNew = `99900451${String(Date.now()).slice(-5)}`;
  const poolAcctLegacy = `99900452${String(Date.now()).slice(-5)}`;

  let srv = null;
  let staffUser = null;
  let customer = null;
  let product = null;
  let origGlobalSetting = null;
  const createdMethodCodes = [];
  const createdOrderRefs = [];
  const seqDates = [dateOnly('2026-11-23'), dateOnly('2026-11-24'), dateOnly(new Date())];

  try {
    srv = await startLocalApp();

    origGlobalSetting = await prisma.globalSetting.findUnique({ where: { id: 1 } });
    if (!origGlobalSetting) {
      await prisma.globalSetting.create({ data: { id: 1, shop_enabled: true, shop_deposit_deadline_days: 2 } });
    } else {
      await prisma.globalSetting.update({ where: { id: 1 }, data: { shop_enabled: true, shop_deposit_deadline_days: 2 } });
    }

    // Ensure standard payment methods exist & enabled
    const methodDefs = [
      { code: 'ctbc_pool', name: '中信專屬一次帳號', method_type: 'POOL_ACCOUNT' },
      { code: 'bank_transfer', name: '銀行轉帳', method_type: 'MULTI_BANK' },
      { code: 'jkopay', name: '街口支付', method_type: 'EWALLET' },
      { code: 'onsite', name: '到店付款', method_type: 'ONSITE' }
    ];
    for (const def of methodDefs) {
      const ex = await prisma.paymentMethodConfig.findUnique({ where: { code: def.code } });
      if (!ex) {
        await prisma.paymentMethodConfig.create({
          data: { code: def.code, name: def.name, method_type: def.method_type, is_enabled: true }
        });
        createdMethodCodes.push(def.code);
      } else if (!ex.is_enabled) {
        await prisma.paymentMethodConfig.update({ where: { code: def.code }, data: { is_enabled: true } });
      }
    }

    staffUser = await prisma.adminUser.create({
      data: {
        password: `R45I4_${runId}_Pass!`,
        name: `R45列表測試_${runId}`,
        permissions: ['shop', 'reservations'],
        is_active: true
      }
    });
    const adminToken = generateToken({
      id: staffUser.id,
      role: 'admin',
      name: staffUser.name,
      permissions: ['shop', 'reservations'],
      token_version: staffUser.token_version
    });
    const adminHeaders = { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' };

    customer = await prisma.user.create({
      data: {
        line_user_id: `r45_i4_cust_${runId}`,
        name: 'R45列表測試客',
        phone: `09454${String(Date.now()).slice(-5)}`
      }
    });
    const custToken = generateToken({
      id: customer.id,
      typ: 'customer',
      line_user_id: customer.line_user_id,
      role: 'customer',
      name: customer.name
    });
    const custHeaders = { Authorization: `Bearer ${custToken}`, 'Content-Type': 'application/json' };

    product = await prisma.product.create({
      data: {
        code: `R45_I4_${runId}`,
        name: `R45列表商品_${runId}`,
        price: 500,
        deposit_amount: 200,
        visibility_status: 'ACTIVE'
      }
    });

    // 1. Universal expiry + legacy auto_expire=false + enable-shop-order-expiry script
    const pastDeadline = new Date(Date.now() - 3600000);
    await prisma.oneTimeAccountPool.createMany({
      data: [
        { account_number: poolAcctNew, payment_method_code: 'ctbc_pool', status: 'ASSIGNED', assigned_order_ref: `PO-EXP-POOL-${runId}`, assigned_user_id: customer.id, assigned_at: new Date() },
        { account_number: poolAcctLegacy, payment_method_code: 'ctbc_pool', status: 'ASSIGNED', assigned_order_ref: `PO-LEG-POOL-${runId}`, assigned_user_id: customer.id, assigned_at: new Date() }
      ]
    });

    const mkExpFixture = async (refSuffix, overrides) => {
      const ref = `PO-EXP-${refSuffix}-${runId}`;
      createdOrderRefs.push(ref);
      return prisma.productOrder.create({
        data: {
          order_ref: ref,
          user_id: customer.id,
          total_amount: 500,
          deposit_required: 200,
          paid_amount: 0,
          balance_amount: 500,
          payment_status: 'pending_payment',
          order_status: 'preorder_placed',
          payment_deadline: pastDeadline,
          auto_expire: true,
          items: {
            create: {
              product_id: product.id,
              product_code_snapshot: product.code,
              product_name_snapshot: product.name,
              price_snapshot: 500,
              quantity: 1,
              subtotal: 500
            }
          },
          ...overrides
        }
      });
    };

    const expPoolRef = `PO-EXP-POOL-${runId}`;
    const legPoolRef = `PO-LEG-POOL-${runId}`;
    createdOrderRefs.push(expPoolRef, legPoolRef);

    const expPool = await prisma.productOrder.create({
      data: {
        order_ref: expPoolRef,
        user_id: customer.id,
        total_amount: 500,
        deposit_required: 200,
        paid_amount: 0,
        balance_amount: 500,
        payment_status: 'pending_payment',
        order_status: 'preorder_placed',
        payment_method_code: 'ctbc_pool',
        assigned_pool_account: poolAcctNew,
        payment_deadline: pastDeadline,
        auto_expire: true,
        items: { create: { product_id: product.id, product_code_snapshot: product.code, product_name_snapshot: product.name, price_snapshot: 500, quantity: 1, subtotal: 500 } }
      }
    });
    const expBank = await mkExpFixture('BANK', { payment_method_code: 'bank_transfer' });
    const expJko = await mkExpFixture('JKO', { payment_method_code: 'jkopay' });
    const expOnsite = await mkExpFixture('ONSITE', { payment_method_code: 'onsite' });
    const expReported = await mkExpFixture('RPT', {
      payment_method_code: 'bank_transfer',
      payment_status: 'reported_pending_verify',
      remittance_last5: '77889',
      remittance_reported_at: new Date()
    });
    const legOnsite = await mkExpFixture('LEGONSITE', {
      payment_method_code: 'onsite',
      auto_expire: false
    });
    const legPool = await prisma.productOrder.create({
      data: {
        order_ref: legPoolRef,
        user_id: customer.id,
        total_amount: 500,
        deposit_required: 200,
        paid_amount: 0,
        balance_amount: 500,
        payment_status: 'pending_payment',
        order_status: 'preorder_placed',
        payment_method_code: 'ctbc_pool',
        assigned_pool_account: poolAcctLegacy,
        payment_deadline: pastDeadline,
        auto_expire: false,
        items: { create: { product_id: product.id, product_code_snapshot: product.code, product_name_snapshot: product.name, price_snapshot: 500, quantity: 1, subtotal: 500 } }
      }
    });

    const cancelledCount = await releaseExpiredPreorders();
    assert.equal(cancelledCount, 5); // 4 auto_expire=true + 1 legacy ctbc_pool

    for (const id of [expPool.id, expBank.id, expJko.id, expOnsite.id, legPool.id]) {
      const row = await prisma.productOrder.findUnique({ where: { id } });
      assert.equal(row.order_status, 'cancelled');
    }
    const expEvents = await prisma.accountingEvent.findMany({
      where: { booking_ref: { in: [expPool.order_ref, expBank.order_ref, expJko.order_ref, expOnsite.order_ref, legPool.order_ref] }, event_type: 'shop_order_expired' }
    });
    assert.equal(expEvents.length, 5);

    const reportedRow = await prisma.productOrder.findUnique({ where: { id: expReported.id } });
    assert.equal(reportedRow.order_status, 'preorder_placed');
    const legOnsiteBefore = await prisma.productOrder.findUnique({ where: { id: legOnsite.id } });
    assert.equal(legOnsiteBefore.order_status, 'preorder_placed');

    // Legacy onsite still appears under overdue=1 filter alongside expReported
    let res = await fetch(`${srv.baseUrl}/api/shop/admin/orders?overdue=1&limit=100`, { headers: adminHeaders });
    assert.equal(res.status, 200);
    const overdueBody = await res.json();
    const overdueRefs = new Set(overdueBody.orders.map((o) => o.order_ref));
    assert.ok(overdueRefs.has(legOnsite.order_ref));
    assert.ok(overdueRefs.has(expReported.order_ref));
    assert.ok(!overdueRefs.has(expOnsite.order_ref)); // cancelled orders excluded

    // enable-shop-order-expiry.mjs dry-run & --apply
    const dryRes = await runEnableShopOrderExpiry({ prismaClient: prisma, apply: false });
    assert.ok(dryRes.orders.some((o) => o.order_ref === legOnsite.order_ref));
    const stillFalse = await prisma.productOrder.findUnique({ where: { id: legOnsite.id } });
    assert.equal(stillFalse.auto_expire, false);

    const scriptNow = new Date();
    const applyRes = await runEnableShopOrderExpiry({ prismaClient: prisma, apply: true, now: scriptNow });
    assert.ok(applyRes.updatedCount >= 1);
    const afterApply = await prisma.productOrder.findUnique({ where: { id: legOnsite.id } });
    assert.equal(afterApply.auto_expire, true);
    assert.ok(new Date(afterApply.payment_deadline).getTime() >= scriptNow.getTime() + 2 * 86400000 - 2000);
    const extAudit = await prisma.accountingEvent.findFirst({
      where: { booking_ref: legOnsite.order_ref, event_type: 'shop_order_deadline_extended' }
    });
    assert.ok(extAudit);

    // Re-run writes 0 rows
    const applyAgain = await runEnableShopOrderExpiry({ prismaClient: prisma, apply: true });
    assert.equal(applyAgain.updatedCount, 0);

    // 2. Order ref Taipei date (2026-11-22T18:00:00.000Z = Taipei 2026-11-23 02:00)
    await prisma.dailyCounter.deleteMany({
      where: { key: 'shop_order', date: { in: [dateOnly('2026-11-23'), dateOnly('2026-11-24')] } }
    });

    const nov23MorningUtc = '2026-11-22T18:00:00.000Z';
    res = await fetch(`${srv.baseUrl}/api/shop/orders`, {
      method: 'POST',
      headers: custHeaders,
      body: JSON.stringify({
        items: [{ product_id: product.id, quantity: 1 }],
        payment_method_code: 'onsite',
        now: nov23MorningUtc
      })
    });
    assert.equal(res.status, 200);
    const o1 = (await res.json()).order;
    createdOrderRefs.push(o1.order_ref);
    assert.equal(o1.order_ref, 'PO-20261123-0001');
    assert.equal(o1.auto_expire, true);
    const expected2Days = new Date(new Date(nov23MorningUtc).getTime() + 2 * 86400000).getTime();
    assert.equal(new Date(o1.payment_deadline).getTime(), expected2Days);

    res = await fetch(`${srv.baseUrl}/api/shop/orders`, {
      method: 'POST',
      headers: custHeaders,
      body: JSON.stringify({
        items: [{ product_id: product.id, quantity: 1 }],
        payment_method_code: 'onsite',
        now: nov23MorningUtc
      })
    });
    assert.equal(res.status, 200);
    const o2 = (await res.json()).order;
    createdOrderRefs.push(o2.order_ref);
    assert.equal(o2.order_ref, 'PO-20261123-0002');

    // Change deadline setting to 3 days -> new onsite order gets 3-day deadline
    await prisma.globalSetting.update({ where: { id: 1 }, data: { shop_deposit_deadline_days: 3 } });
    const nov23MidUtc = '2026-11-23T06:00:00.000Z';
    res = await fetch(`${srv.baseUrl}/api/shop/orders`, {
      method: 'POST',
      headers: custHeaders,
      body: JSON.stringify({
        items: [{ product_id: product.id, quantity: 1 }],
        payment_method_code: 'onsite',
        now: nov23MidUtc
      })
    });
    assert.equal(res.status, 200);
    const o3 = (await res.json()).order;
    createdOrderRefs.push(o3.order_ref);
    const expected3Days = new Date(new Date(nov23MidUtc).getTime() + 3 * 86400000).getTime();
    assert.equal(new Date(o3.payment_deadline).getTime(), expected3Days);
    await prisma.globalSetting.update({ where: { id: 1 }, data: { shop_deposit_deadline_days: 2 } });

    // Parallel 20 order creations on 2026-11-24 -> all succeed, 20 unique refs
    const nov24Utc = '2026-11-23T20:00:00.000Z';
    const parallelResps = await Promise.all(
      Array.from({ length: 20 }, () =>
        fetch(`${srv.baseUrl}/api/shop-test/orders`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-test-user-id': String(customer.id) },
          body: JSON.stringify({
            items: [{ product_id: product.id, quantity: 1 }],
            payment_method_code: 'bank_transfer',
            now: nov24Utc
          })
        })
      )
    );
    const parallelRefs = new Set();
    for (const pr of parallelResps) {
      assert.equal(pr.status, 200);
      const po = (await pr.json()).order;
      createdOrderRefs.push(po.order_ref);
      assert.ok(po.order_ref.startsWith('PO-20261124-'));
      parallelRefs.add(po.order_ref);
    }
    assert.equal(parallelRefs.size, 20);

    // 3. Ensure pagination works for 65 orders (currently createdOrderRefs has 2+1+20+7 = 30; create 35 more to reach 65)
    const needMore = 65 - createdOrderRefs.length;
    const bulkCreates = [];
    for (let i = 0; i < needMore; i++) {
      const ref = `PO-PAGE-${String(i).padStart(2, '0')}-${runId}`;
      createdOrderRefs.push(ref);
      bulkCreates.push({
        order_ref: ref,
        user_id: customer.id,
        total_amount: 500,
        deposit_required: 200,
        paid_amount: 0,
        balance_amount: 500,
        payment_method_code: 'onsite',
        payment_status: 'pending_payment',
        order_status: 'preorder_placed',
        payment_deadline: new Date(Date.now() + 86400000),
        auto_expire: true
      });
    }
    await prisma.productOrder.createMany({ data: bulkCreates });

    res = await fetch(`${srv.baseUrl}/api/shop/admin/orders?search=${encodeURIComponent(customer.phone)}&limit=30&page=3`, {
      headers: adminHeaders
    });
    assert.equal(res.status, 200);
    const page3Body = await res.json();
    assert.equal(page3Body.totalCount, 65);
    assert.equal(page3Body.totalPages, 3);
    assert.equal(page3Body.orders.length, 5);
  } finally {
    if (srv) await srv.close().catch(() => {});
    await prisma.oneTimeAccountPool.deleteMany({ where: { account_number: { in: [poolAcctNew, poolAcctLegacy] } } }).catch(() => {});
    if (createdOrderRefs.length) {
      await prisma.productOrder.deleteMany({ where: { order_ref: { in: createdOrderRefs } } }).catch(() => {});
    }
    await prisma.dailyCounter.deleteMany({ where: { key: 'shop_order', date: { in: seqDates } } }).catch(() => {});
    if (product) await prisma.product.delete({ where: { id: product.id } }).catch(() => {});
    if (customer) await prisma.user.delete({ where: { id: customer.id } }).catch(() => {});
    if (staffUser) await prisma.adminUser.delete({ where: { id: staffUser.id } }).catch(() => {});
    if (createdMethodCodes.length) {
      await prisma.paymentMethodConfig.deleteMany({ where: { code: { in: createdMethodCodes } } }).catch(() => {});
    }
    if (origGlobalSetting) {
      await prisma.globalSetting.update({
        where: { id: 1 },
        data: {
          shop_enabled: origGlobalSetting.shop_enabled,
          shop_deposit_deadline_days: origGlobalSetting.shop_deposit_deadline_days
        }
      }).catch(() => {});
    }
  }
});
