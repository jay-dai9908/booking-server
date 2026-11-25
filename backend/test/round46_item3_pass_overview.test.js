import test from 'node:test';
import assert from 'node:assert/strict';
import prisma from '../src/prismaClient.js';
import { toTaipeiDateString } from '../../shared/time.js';
import {
  grantUserPass,
  getAllPassesAdmin,
  getPassesSummaryAdmin,
  togglePassStatus,
  refundUserPassSaleHandler,
  redeemUserPass
} from '../src/controllers/passController.js';
import { expireOverduePasses } from '../src/services/billing/passExpiry.js';
import { getClosingPreview, getEventsList } from '../src/controllers/accountingController.js';

function createMockReqRes({
  body = {},
  params = {},
  query = {},
  user = { id: 9463, name: 'R46卡券店長', role: 'admin', isSuperAdmin: true, permissions: ['all'], isVerifiedAdmin: true }
} = {}) {
  const req = { body, params, query, user, headers: { 'x-device-label': 'R46測試櫃檯' }, ip: '127.0.0.1' };
  let statusCode = 200;
  let bodyData = null;
  const res = {
    status(c) { statusCode = c; return res; },
    json(d) { bodyData = d; return res; },
    getStatusCode() { return statusCode; },
    getBody() { return bodyData; }
  };
  return { req, res };
}

test('Round 46 Item 3: pass overview, summary, expiry job, status reason guard, and pass sale refund', async () => {
  const ts = Date.now();
  const createdUserIds = [];
  const createdPlanIds = [];
  const createdPassIds = [];
  const createdPassCodes = [];
  const origGlobal = await prisma.globalSetting.findUnique({ where: { id: 1 } });

  try {
    await prisma.globalSetting.upsert({
      where: { id: 1 },
      update: {
        print_enabled: false,
        payment_methods_json: [
          { key: 'cash', label: '現金', enabled: true },
          { key: 'line_pay', label: 'LINE Pay', enabled: true },
          { key: 'transfer', label: '匯款', enabled: true }
        ]
      },
      create: {
        id: 1,
        print_enabled: false,
        payment_methods_json: [
          { key: 'cash', label: '現金', enabled: true },
          { key: 'line_pay', label: 'LINE Pay', enabled: true },
          { key: 'transfer', label: '匯款', enabled: true }
        ]
      }
    });

    const user = await prisma.user.create({
      data: {
        line_user_id: `U_R46_I3_${ts}`,
        name: 'R46卡券會員',
        phone: '0933444555'
      }
    });
    createdUserIds.push(user.id);

    const plan = await prisma.passPlan.create({
      data: {
        code: `r46_plan_${ts}`,
        name: 'R46十次券',
        pass_type: 'PUNCH_CARD',
        total_quota: 10,
        price: 1500,
        valid_days: 90
      }
    });
    createdPlanIds.push(plan.id);

    const now = Date.now();
    // 1) Seed 35 passes: 30 ACTIVE (3 expiring in 10d, 27 expiring in 60d), 2 overdue ACTIVE, 3 REVOKED
    for (let i = 0; i < 35; i++) {
      let status = 'ACTIVE';
      let expiresAt = new Date(now + 60 * 86400000);
      if (i < 3) {
        expiresAt = new Date(now + (5 + i) * 86400000);
      } else if (i >= 30 && i < 32) {
        expiresAt = new Date(now - 2 * 86400000); // overdue still ACTIVE
      } else if (i >= 32) {
        status = 'REVOKED';
      }

      const code = `PASS-R46I3-${String(i).padStart(2, '0')}-${String(ts).slice(-4)}`;
      const p = await prisma.userPass.create({
        data: {
          pass_code: code,
          user_id: user.id,
          plan_id: plan.id,
          plan_name_snapshot: plan.name,
          pass_type: 'PUNCH_CARD',
          total_quota: 10,
          remaining_quota: 8,
          status,
          expires_at: expiresAt,
          order_ref: i === 29 ? `SHP-BONUS-${ts}` : null
        }
      });
      createdPassIds.push(p.id);
      createdPassCodes.push(code);
    }

    // 2) Expiry job runs -> 2 become EXPIRED + 2 pass_status_changed logs; running again is a no-op
    const beforeExp = new Date();
    const exp1 = await expireOverduePasses();
    assert.equal(exp1.expiredCount, 2);

    const expEvents1 = await prisma.accountingEvent.findMany({
      where: { event_type: 'pass_status_changed', staff_name: '系統', created_at: { gte: beforeExp } }
    });
    assert.equal(expEvents1.length, 2);
    assert.equal(expEvents1[0].reason, '已過期');

    const exp2 = await expireOverduePasses();
    assert.equal(exp2.expiredCount, 0);
    const expEvents2 = await prisma.accountingEvent.findMany({
      where: { event_type: 'pass_status_changed', staff_name: '系統', created_at: { gte: beforeExp } }
    });
    assert.equal(expEvents2.length, 2);

    // 3) Summary check
    const rSum = createMockReqRes();
    await getPassesSummaryAdmin(rSum.req, rSum.res);
    assert.equal(rSum.res.getStatusCode(), 200);
    const sumBody = rSum.res.getBody();
    assert.equal(sumBody.active_count, 30);
    assert.equal(sumBody.expiring_30d_count, 3);
    assert.equal(sumBody.expired_count, 2);

    // 4) All passes pagination & expiring_days=30 filter
    const rPage2 = createMockReqRes({ query: { limit: '30', page: '2' } });
    await getAllPassesAdmin(rPage2.req, rPage2.res);
    assert.equal(rPage2.res.getStatusCode(), 200);
    assert.equal(rPage2.res.getBody().total, 35);
    assert.equal(rPage2.res.getBody().passes.length, 5);

    const rExpFilter = createMockReqRes({ query: { expiring_days: '30', limit: '30' } });
    await getAllPassesAdmin(rExpFilter.req, rExpFilter.res);
    assert.equal(rExpFilter.res.getStatusCode(), 200);
    assert.equal(rExpFilter.res.getBody().passes.length, 3);

    // 5) PATCH status guards & manual revoke + pass category filter check
    const targetPassId = createdPassIds[0];
    const rBadStatus = createMockReqRes({ params: { id: String(targetPassId) }, body: { status: 'FOO', reason: 'x' } });
    await togglePassStatus(rBadStatus.req, rBadStatus.res);
    assert.equal(rBadStatus.res.getStatusCode(), 422);

    const rNoReason = createMockReqRes({ params: { id: String(targetPassId) }, body: { status: 'REVOKED' } });
    await togglePassStatus(rNoReason.req, rNoReason.res);
    assert.equal(rNoReason.res.getStatusCode(), 422);

    const rRevoke = createMockReqRes({
      params: { id: String(targetPassId) },
      body: { status: 'REVOKED', reason: 'R46 測試作廢' }
    });
    await togglePassStatus(rRevoke.req, rRevoke.res);
    assert.equal(rRevoke.res.getStatusCode(), 200);
    assert.equal(rRevoke.res.getBody().pass.status, 'REVOKED');

    // Redeem another pass manually & confirm category=pass lists both pass_redeemed_manual & pass_status_changed
    const rRedeem = createMockReqRes({
      body: { pass_code: createdPassCodes[1], units: 1, note: 'R46 核銷' }
    });
    await redeemUserPass(rRedeem.req, rRedeem.res);
    assert.equal(rRedeem.res.getStatusCode(), 200);

    const rPassEvs = createMockReqRes({ query: { category: 'pass', limit: '50' } });
    await getEventsList(rPassEvs.req, rPassEvs.res);
    const evTypes = new Set(rPassEvs.res.getBody().events.map((e) => e.event_type));
    assert.ok(evTypes.has('pass_status_changed'));
    assert.ok(evTypes.has('pass_redeemed_manual'));

    // 6) Sell pass (cash 1500) -> closing preview baseline -> refund 1500 -> closing preview +1500 cash refund & idempotent retry & over-refund 422
    const rSell = createMockReqRes({
      body: {
        user_id: user.id,
        plan_id: plan.id,
        mode: 'sale',
        method: 'cash',
        amount: 1500,
        cash_received: 1500,
        print: false
      }
    });
    await grantUserPass(rSell.req, rSell.res);
    assert.equal(rSell.res.getStatusCode(), 200);
    const soldPass = rSell.res.getBody().pass;
    const salePay = rSell.res.getBody().payment;
    createdPassIds.push(soldPass.id);
    createdPassCodes.push(soldPass.pass_code);

    const todayStr = toTaipeiDateString(new Date());
    const rCloseBefore = createMockReqRes({ query: { date: todayStr } });
    await getClosingPreview(rCloseBefore.req, rCloseBefore.res);
    const cashRefundBefore = rCloseBefore.res.getBody().cash_refund ?? 0;

    const batchId = `r46-pass-ref-${ts}`;
    const rRefund = createMockReqRes({
      params: { id: String(soldPass.id) },
      body: { amount: 1500, method: 'cash', reason: '顧客未使用全額退費', client_batch_id: batchId }
    });
    await refundUserPassSaleHandler(rRefund.req, rRefund.res);
    assert.equal(rRefund.res.getStatusCode(), 200);
    const refundPay = rRefund.res.getBody().payment;
    assert.equal(refundPay.kind, 'refund');
    assert.equal(refundPay.source, 'pass_sale');
    assert.equal(refundPay.related_payment_id, salePay.id);
    assert.equal(rRefund.res.getBody().pass.status, 'REVOKED');

    const rRefundEv = await prisma.accountingEvent.findFirst({
      where: { event_type: 'pass_sale_refunded', booking_ref: soldPass.pass_code },
      orderBy: { id: 'desc' }
    });
    assert.ok(rRefundEv);

    const rCloseAfter = createMockReqRes({ query: { date: todayStr } });
    await getClosingPreview(rCloseAfter.req, rCloseAfter.res);
    const cashRefundAfter = rCloseAfter.res.getBody().cash_refund ?? 0;
    assert.equal(cashRefundAfter - cashRefundBefore, 1500);

    // Retry with same client_batch_id -> deduplicated, only 1 refund record
    const rRefundDup = createMockReqRes({
      params: { id: String(soldPass.id) },
      body: { amount: 1500, method: 'cash', reason: '重複送出測試', client_batch_id: batchId }
    });
    await refundUserPassSaleHandler(rRefundDup.req, rRefundDup.res);
    assert.equal(rRefundDup.res.getStatusCode(), 200);
    assert.equal(rRefundDup.res.getBody().deduplicated, true);
    const refundCount = await prisma.payment.count({
      where: { source: 'pass_sale', source_ref: soldPass.pass_code, kind: 'refund' }
    });
    assert.equal(refundCount, 1);

    // Refund 1 more dollar -> 422
    const rRefundOver = createMockReqRes({
      params: { id: String(soldPass.id) },
      body: { amount: 1, method: 'cash', reason: '超額退費測試', client_batch_id: `over-${ts}` }
    });
    await refundUserPassSaleHandler(rRefundOver.req, rRefundOver.res);
    assert.equal(rRefundOver.res.getStatusCode(), 422);

    // 7) Gifted pass refund -> 409
    const rGift = createMockReqRes({
      body: { user_id: user.id, plan_id: plan.id, mode: 'gift', reason: 'VIP 活動贈送' }
    });
    await grantUserPass(rGift.req, rGift.res);
    assert.equal(rGift.res.getStatusCode(), 200);
    const giftedPass = rGift.res.getBody().pass;
    createdPassIds.push(giftedPass.id);
    createdPassCodes.push(giftedPass.pass_code);

    const rGiftRefund = createMockReqRes({
      params: { id: String(giftedPass.id) },
      body: { amount: 100, method: 'cash', reason: '贈品退費應失敗' }
    });
    await refundUserPassSaleHandler(rGiftRefund.req, rGiftRefund.res);
    assert.equal(rGiftRefund.res.getStatusCode(), 409);

    // 8) Source column labels across sale, gift, shop_bonus, and legacy
    const rAllSrc = createMockReqRes({ query: { limit: '50', page: '1' } });
    await getAllPassesAdmin(rAllSrc.req, rAllSrc.res);
    const allList = rAllSrc.res.getBody().passes;
    const byCode = new Map(allList.map((p) => [p.pass_code, p]));
    assert.equal(byCode.get(soldPass.pass_code)?.source_label, '販售');
    assert.equal(byCode.get(giftedPass.pass_code)?.source_label, '贈送');
    assert.equal(byCode.get(createdPassCodes[29])?.source_label, '商城贈品');
    assert.equal(byCode.get(createdPassCodes[5])?.source_label, '舊資料（來源不明）');
  } finally {
    if (createdPassCodes.length > 0) {
      await prisma.payment.deleteMany({
        where: { source: 'pass_sale', source_ref: { in: createdPassCodes } }
      });
    }
    if (createdPassIds.length > 0) {
      await prisma.userPass.deleteMany({ where: { id: { in: createdPassIds } } });
    }
    if (createdPlanIds.length > 0) {
      await prisma.passPlan.deleteMany({ where: { id: { in: createdPlanIds } } });
    }
    if (createdUserIds.length > 0) {
      await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    }
    if (origGlobal) {
      await prisma.globalSetting.update({
        where: { id: 1 },
        data: {
          print_enabled: origGlobal.print_enabled,
          payment_methods_json: origGlobal.payment_methods_json
        }
      });
    }
  }
});
