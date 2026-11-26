import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import cookieParser from 'cookie-parser';
import prisma from '../src/prismaClient.js';
import { generateToken } from '../src/middlewares/authMiddleware.js';
import shopRoutes from '../src/routes/shop.js';
import { buildOrderPaymentInfo } from '../src/services/shop/orderPaymentInfo.js';

function startLocalApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
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

test('Round 48 Item 1: buildOrderPaymentInfo handles all four method_types cleanly', () => {
  const poolInfo = buildOrderPaymentInfo({
    order: { payment_method_code: 'ctbc_pool', assigned_pool_account: '00000000000001', assigned_pool_url: 'https://pay.example.com/1' },
    method: { code: 'ctbc_pool', name: '專屬轉帳', method_type: 'POOL_ACCOUNT', require_last5: true, display_instructions: '轉帳後回報' },
    poolRow: { bank_code: '822', bank_name: '測試銀行', payment_url: 'https://pay.example.com/pool' }
  });
  assert.equal(poolInfo.needs_payment, true);
  assert.equal(poolInfo.account, '00000000000001');
  assert.equal(poolInfo.bank_label, '測試銀行（822）');
  assert.equal(poolInfo.payment_url, 'https://pay.example.com/1');
  assert.equal(poolInfo.require_last5, true);
  assert.equal(poolInfo.account_missing, false);

  const multiInfo = buildOrderPaymentInfo({
    order: { payment_method_code: 'multi', selected_bank_info: '第一測試行 (007) 00000000000002' },
    method: {
      code: 'multi',
      name: '一般匯款',
      method_type: 'MULTI_BANK',
      require_last5: true,
      bank_accounts_json: [
        { bank_name: '第一測試行', bank_code: '007', account: '00000000000002' },
        { bank_name: '第二測試行', bank_code: '013', account: '00000000000003' }
      ]
    }
  });
  assert.equal(multiInfo.needs_payment, true);
  assert.equal(multiInfo.bank_label, '第一測試行（007）');
  assert.equal(multiInfo.account, '00000000000002');
  assert.equal(multiInfo.require_last5, true);
  assert.equal(multiInfo.account_missing, false);

  const ewalletInfo = buildOrderPaymentInfo({
    order: { payment_method_code: 'jkopay' },
    method: { code: 'jkopay', name: '電子支付', method_type: 'EWALLET', display_instructions: '請掃門市 QR 付款', require_last5: false }
  });
  assert.equal(ewalletInfo.needs_payment, true);
  assert.equal(ewalletInfo.instructions, '請掃門市 QR 付款');
  assert.equal(ewalletInfo.account, null);
  assert.equal(ewalletInfo.require_last5, false);
  assert.equal(ewalletInfo.account_missing, false);

  const onsiteInfo = buildOrderPaymentInfo({
    order: { payment_method_code: 'onsite' },
    method: { code: 'onsite', name: '到店付款', method_type: 'ONSITE', require_last5: true }
  });
  assert.equal(onsiteInfo.needs_payment, false);
  assert.equal(onsiteInfo.require_last5, false);
  assert.equal(onsiteInfo.account, null);
  assert.equal(onsiteInfo.bank_label, '');
  assert.equal(onsiteInfo.account_missing, false);
});

test('Round 48 Item 1: Shop order pool exhaustion, custom POOL_ACCOUNT, MULTI_BANK, ONSITE, hold limit & legacy account_missing', async () => {
  const TS = Date.now();
  const srv = await startLocalApp();
  const createdOrderIds = [];
  const createdPoolIds = [];
  const createdMethodCodes = [];
  let createdProductId = null;
  let user1 = null;
  let user2 = null;

  try {
    user1 = await prisma.user.create({
      data: { name: 'R48商城客A', phone: `0999${String(TS).slice(-6)}`, line_user_id: `r48_i1_u1_${TS}` }
    });
    user2 = await prisma.user.create({
      data: { name: 'R48商城客B', phone: `0998${String(TS).slice(-6)}`, line_user_id: `r48_i1_u2_${TS}` }
    });
    const token1 = generateToken({
      id: user1.id,
      typ: 'customer',
      line_user_id: user1.line_user_id,
      role: 'customer',
      name: user1.name
    });
    const token2 = generateToken({
      id: user2.id,
      typ: 'customer',
      line_user_id: user2.line_user_id,
      role: 'customer',
      name: user2.name
    });

    const product = await prisma.product.create({
      data: {
        code: `R48_PROD_${TS}`,
        name: 'R48測試商品',
        category: 'bundle',
        price: 500,
        deposit_amount: 500,
        is_preorder: true,
        visibility_status: 'ACTIVE'
      }
    });
    createdProductId = product.id;

    // Seed/ensure standard & custom payment methods
    const poolCodeEmpty = `r48_empty_pool_${TS}`;
    const poolCodeCustom = `r48_custom_pool_${TS}`;
    const multiBankCode = `r48_multi_${TS}`;
    const onsiteCode = `r48_onsite_${TS}`;
    createdMethodCodes.push(poolCodeEmpty, poolCodeCustom, multiBankCode, onsiteCode);

    await prisma.paymentMethodConfig.createMany({
      data: [
        { code: poolCodeEmpty, name: '空帳號專戶', method_type: 'POOL_ACCOUNT', is_enabled: true, require_last5: true },
        { code: poolCodeCustom, name: '自訂專屬帳號', method_type: 'POOL_ACCOUNT', is_enabled: true, require_last5: true },
        {
          code: multiBankCode,
          name: '一般匯款測試',
          method_type: 'MULTI_BANK',
          is_enabled: true,
          require_last5: true,
          bank_accounts_json: [
            { bank_name: '測試銀行甲', bank_code: '004', account: '00000000000101' },
            { bank_name: '測試銀行乙', bank_code: '012', account: '00000000000102' }
          ]
        },
        { code: onsiteCode, name: '到店付款測試', method_type: 'ONSITE', is_enabled: true, require_last5: false }
      ]
    });

    // Ensure ctbc_pool exists for legacy check test
    let existingCtbc = await prisma.paymentMethodConfig.findUnique({ where: { code: 'ctbc_pool' } });
    if (!existingCtbc) {
      await prisma.paymentMethodConfig.create({
        data: { code: 'ctbc_pool', name: '專屬帳號', method_type: 'POOL_ACCOUNT', is_enabled: true, require_last5: true }
      });
      createdMethodCodes.push('ctbc_pool');
    }

    const hdr1 = { 'Content-Type': 'application/json', Authorization: `Bearer ${token1}` };
    const hdr2 = { 'Content-Type': 'application/json', Authorization: `Bearer ${token2}` };

    // 1. Empty POOL_ACCOUNT -> 409 NO_POOL_ACCOUNT, order count unchanged
    const countBeforeEmpty = await prisma.productOrder.count();
    const resEmpty = await fetch(`${srv.baseUrl}/api/shop/orders`, {
      method: 'POST',
      headers: hdr1,
      body: JSON.stringify({
        items: [{ product_id: product.id, quantity: 1 }],
        payment_method_code: poolCodeEmpty
      })
    });
    assert.equal(resEmpty.status, 409);
    const bodyEmpty = await resEmpty.json();
    assert.equal(bodyEmpty.code, 'NO_POOL_ACCOUNT');
    assert.equal(await prisma.productOrder.count(), countBeforeEmpty);

    // 2. Custom POOL_ACCOUNT with 1 account -> 1st succeeds, 2nd returns 409
    const p1 = await prisma.oneTimeAccountPool.create({
      data: {
        payment_method_code: poolCodeCustom,
        bank_code: '808',
        bank_name: '測試專用銀',
        account_number: `00000000${String(TS).slice(-6)}`,
        status: 'AVAILABLE'
      }
    });
    createdPoolIds.push(p1.id);

    const pmResBefore = await fetch(`${srv.baseUrl}/api/shop/payment-methods`);
    assert.equal(pmResBefore.status, 200);
    const pmBefore = await pmResBefore.json();
    assert.equal(pmBefore.pool_available_counts[poolCodeCustom], 1);

    const resPool1 = await fetch(`${srv.baseUrl}/api/shop/orders`, {
      method: 'POST',
      headers: hdr1,
      body: JSON.stringify({
        items: [{ product_id: product.id, quantity: 1 }],
        payment_method_code: poolCodeCustom
      })
    });
    assert.equal(resPool1.status, 200);
    const bPool1 = await resPool1.json();
    createdOrderIds.push(bPool1.order.id);
    assert.equal(bPool1.order.payment_info.account, p1.account_number);
    assert.ok(bPool1.order.payment_info.bank_label.includes('測試專用銀'));

    const resPool2 = await fetch(`${srv.baseUrl}/api/shop/orders`, {
      method: 'POST',
      headers: hdr2,
      body: JSON.stringify({
        items: [{ product_id: product.id, quantity: 1 }],
        payment_method_code: poolCodeCustom
      })
    });
    assert.equal(resPool2.status, 409);
    const bPool2 = await resPool2.json();
    assert.equal(bPool2.code, 'NO_POOL_ACCOUNT');

    // 3. MULTI_BANK -> valid 2nd account vs invalid string
    const resMultiOk = await fetch(`${srv.baseUrl}/api/shop/orders`, {
      method: 'POST',
      headers: hdr1,
      body: JSON.stringify({
        items: [{ product_id: product.id, quantity: 1 }],
        payment_method_code: multiBankCode,
        selected_bank_info: '測試銀行乙 (012) 00000000000102'
      })
    });
    assert.equal(resMultiOk.status, 200);
    const bMultiOk = await resMultiOk.json();
    createdOrderIds.push(bMultiOk.order.id);
    assert.equal(bMultiOk.order.payment_info.account, '00000000000102');
    assert.equal(bMultiOk.order.payment_info.bank_label, '測試銀行乙（012）');

    const resMultiBad = await fetch(`${srv.baseUrl}/api/shop/orders`, {
      method: 'POST',
      headers: hdr1,
      body: JSON.stringify({
        items: [{ product_id: product.id, quantity: 1 }],
        payment_method_code: multiBankCode,
        selected_bank_info: '不存在銀行 999999'
      })
    });
    assert.equal(resMultiBad.status, 400);

    // 4. ONSITE -> needs_payment false, require_last5 false
    const resOnsite = await fetch(`${srv.baseUrl}/api/shop/orders`, {
      method: 'POST',
      headers: hdr1,
      body: JSON.stringify({
        items: [{ product_id: product.id, quantity: 1 }],
        payment_method_code: onsiteCode
      })
    });
    assert.equal(resOnsite.status, 200);
    const bOnsite = await resOnsite.json();
    createdOrderIds.push(bOnsite.order.id);
    assert.equal(bOnsite.order.payment_info.needs_payment, false);
    assert.equal(bOnsite.order.payment_info.require_last5, false);

    // 5. Same member already holds 2 pending POOL_ACCOUNT orders -> 3rd returns 409 POOL_HOLD_LIMIT
    const p2 = await prisma.oneTimeAccountPool.create({
      data: {
        payment_method_code: poolCodeCustom,
        bank_code: '808',
        bank_name: '測試專用銀',
        account_number: `00000001${String(TS).slice(-6)}`,
        status: 'AVAILABLE'
      }
    });
    const p3 = await prisma.oneTimeAccountPool.create({
      data: {
        payment_method_code: poolCodeCustom,
        bank_code: '808',
        bank_name: '測試專用銀',
        account_number: `00000002${String(TS).slice(-6)}`,
        status: 'AVAILABLE'
      }
    });
    createdPoolIds.push(p2.id, p3.id);

    const resHold2 = await fetch(`${srv.baseUrl}/api/shop/orders`, {
      method: 'POST',
      headers: hdr1,
      body: JSON.stringify({
        items: [{ product_id: product.id, quantity: 1 }],
        payment_method_code: poolCodeCustom
      })
    });
    assert.equal(resHold2.status, 200);
    const bHold2 = await resHold2.json();
    createdOrderIds.push(bHold2.order.id);

    const resHold3 = await fetch(`${srv.baseUrl}/api/shop/orders`, {
      method: 'POST',
      headers: hdr1,
      body: JSON.stringify({
        items: [{ product_id: product.id, quantity: 1 }],
        payment_method_code: poolCodeCustom
      })
    });
    assert.equal(resHold3.status, 409);
    const bHold3 = await resHold3.json();
    assert.equal(bHold3.code, 'POOL_HOLD_LIMIT');

    // 6. Legacy row with ctbc_pool & null assigned_pool_account -> getMyProductOrders returns account_missing: true
    const legacyOrd = await prisma.productOrder.create({
      data: {
        order_ref: `PO-LEGACY-${TS}`,
        user_id: user2.id,
        total_amount: 500,
        deposit_required: 500,
        balance_amount: 500,
        payment_method_code: 'ctbc_pool',
        assigned_pool_account: null,
        payment_status: 'pending_payment',
        order_status: 'preorder_placed'
      }
    });
    createdOrderIds.push(legacyOrd.id);

    const myOrdRes = await fetch(`${srv.baseUrl}/api/shop/my-orders`, { headers: hdr2 });
    assert.equal(myOrdRes.status, 200);
    const myOrds = await myOrdRes.json();
    const legacyFound = myOrds.find((o) => o.id === legacyOrd.id);
    assert.ok(legacyFound);
    assert.equal(legacyFound.payment_info.account_missing, true);
  } finally {
    await srv.close();
    if (createdOrderIds.length > 0) {
      await prisma.productOrderItem.deleteMany({ where: { order_id: { in: createdOrderIds } } }).catch(() => {});
      await prisma.productOrder.deleteMany({ where: { id: { in: createdOrderIds } } }).catch(() => {});
    }
    if (createdPoolIds.length > 0) {
      await prisma.oneTimeAccountPool.deleteMany({ where: { id: { in: createdPoolIds } } }).catch(() => {});
    }
    if (createdMethodCodes.length > 0) {
      await prisma.paymentMethodConfig.deleteMany({ where: { code: { in: createdMethodCodes } } }).catch(() => {});
    }
    if (createdProductId) {
      await prisma.product.deleteMany({ where: { id: createdProductId } }).catch(() => {});
    }
    const uids = [user1?.id, user2?.id].filter(Boolean);
    if (uids.length > 0) {
      await prisma.user.deleteMany({ where: { id: { in: uids } } }).catch(() => {});
    }
    await prisma.dailyCounter.deleteMany({ where: { key: 'shop_order' } }).catch(() => {});
  }
});
