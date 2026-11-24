import test from 'node:test';
import assert from 'node:assert/strict';
import prisma from '../src/prismaClient.js';
import { grantUserPass, redeemUserPass } from '../src/controllers/passController.js';
import { voidPayment } from '../src/services/billing/billService.js';
import { getAccountingSummary, getLedger, getClosingPreview } from '../src/controllers/accountingController.js';
import { toTaipeiDateString } from '../../shared/time.js';

function createMockReqRes({ body = {}, params = {}, query = {}, user = { id: 1, name: 'R38店員' } } = {}) {
  const req = {
    body,
    params,
    query,
    user,
    headers: { 'x-device-label': 'R38櫃檯' },
    ip: '127.0.0.1'
  };
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

test('Round 38 Item 2: pass grant sale vs gift modes, accounting/closing integration, and same-day unused pass void', async () => {
  const ts = Date.now();
  const createdPassIds = [];
  const createdPayIds = [];
  let user = null;
  let plan = null;
  let savedGlobal = null;

  try {
    savedGlobal = await prisma.globalSetting.findUnique({ where: { id: 1 } });
    await prisma.globalSetting.upsert({
      where: { id: 1 },
      update: { print_enabled: true, auto_print_receipt: true },
      create: { id: 1, print_enabled: true, auto_print_receipt: true }
    });

    user = await prisma.user.create({
      data: {
        line_user_id: `manual_r38_2_${ts}`,
        name: 'R38買卡顧客',
        phone: `0988${String(ts).slice(-6)}`
      }
    });

    plan = await prisma.passPlan.create({
      data: {
        code: `R38_PLAN_${ts}`,
        name: 'R38五次燙豆卡',
        pass_type: 'PUNCH_CARD',
        price: 1000,
        total_quota: 5,
        valid_days: 90,
        day_restriction: 'ALL'
      }
    });

    const todayStr = toTaipeiDateString(new Date());

    // Baseline closing preview before sale
    const baseClose = createMockReqRes({ query: { date: todayStr } });
    await getClosingPreview(baseClose.req, baseClose.res);
    assert.equal(baseClose.res.getStatusCode(), 200);
    const baseCashAmt = baseClose.res.getBody().by_method?.cash?.amount || 0;

    // 1. Missing mode -> 422
    {
      const { req, res } = createMockReqRes({
        body: { user_id: user.id, plan_id: plan.id }
      });
      await grantUserPass(req, res);
      assert.equal(res.getStatusCode(), 422);
    }

    // 2. Gift without reason -> 422
    {
      const { req, res } = createMockReqRes({
        body: { user_id: user.id, plan_id: plan.id, mode: 'gift' }
      });
      await grantUserPass(req, res);
      assert.equal(res.getStatusCode(), 422);
    }

    // 3. Sale with invalid method='pass' or altered amount without reason -> 422; short cash -> 400
    {
      const { req, res } = createMockReqRes({
        body: { user_id: user.id, plan_id: plan.id, mode: 'sale', method: 'pass', amount: 1000 }
      });
      await grantUserPass(req, res);
      assert.equal(res.getStatusCode(), 422);
    }
    {
      const { req, res } = createMockReqRes({
        body: { user_id: user.id, plan_id: plan.id, mode: 'sale', method: 'cash', amount: 800 }
      });
      await grantUserPass(req, res);
      assert.equal(res.getStatusCode(), 422);
    }
    {
      const { req, res } = createMockReqRes({
        body: { user_id: user.id, plan_id: plan.id, mode: 'sale', method: 'cash', amount: 1000, cash_received: 500 }
      });
      await grantUserPass(req, res);
      assert.equal(res.getStatusCode(), 400);
    }

    // 4. Valid gift -> UserPass + pass_gifted AccountingEvent, NO Payment
    let giftPass = null;
    {
      const { req, res } = createMockReqRes({
        body: { user_id: user.id, plan_id: plan.id, mode: 'gift', reason: '週年慶VIP贈送' },
        user: { id: 9, name: '贈送測試店員' }
      });
      await grantUserPass(req, res);
      assert.equal(res.getStatusCode(), 200);
      giftPass = res.res?.getBody ? res.res.getBody().pass : res.getBody().pass;
      createdPassIds.push(giftPass.id);

      const payCount = await prisma.payment.count({ where: { booking_ref: giftPass.pass_code } });
      assert.equal(payCount, 0);

      const giftEv = await prisma.accountingEvent.findFirst({
        where: { booking_ref: giftPass.pass_code, event_type: 'pass_gifted' }
      });
      assert.ok(giftEv);
      assert.equal(giftEv.category, 'pass');
      assert.equal(giftEv.reason, '週年慶VIP贈送');
      assert.equal(giftEv.staff_name, '贈送測試店員');
    }

    // 5. Valid sale: 1000 cash, cash_received=1000
    let soldPass1 = null;
    let soldPay1 = null;
    {
      const { req, res } = createMockReqRes({
        body: {
          user_id: user.id,
          plan_id: plan.id,
          mode: 'sale',
          method: 'cash',
          amount: 1000,
          cash_received: 1000,
          client_batch_id: `r38-sale-1-${ts}`
        },
        user: { id: 7, name: '販售小幫手' }
      });
      await grantUserPass(req, res);
      assert.equal(res.getStatusCode(), 200);
      const body = res.getBody();
      soldPass1 = body.pass;
      soldPay1 = body.payment;
      createdPassIds.push(soldPass1.id);
      createdPayIds.push(soldPay1.id);

      assert.equal(soldPay1.source, 'pass_sale');
      assert.equal(soldPay1.source_ref, soldPass1.pass_code);
      assert.equal(soldPay1.booking_ref, soldPass1.pass_code);
      assert.equal(soldPay1.kind, 'charge');
      assert.equal(soldPay1.amount, 1000);
      assert.equal(soldPay1.staff_name, '販售小幫手');
      assert.deepEqual(soldPay1.person_nos, []);
      assert.ok(body.print_job, 'Expected receipt PrintJob queued for pass_sale');

      const soldEv = await prisma.accountingEvent.findFirst({
        where: { payment_id: soldPay1.id, event_type: 'pass_sold' }
      });
      assert.ok(soldEv);
      assert.equal(soldEv.category, 'payment');
      assert.equal(soldEv.amount, 1000);

      // Closing preview cash increased by 1000
      const afterClose = createMockReqRes({ query: { date: todayStr } });
      await getClosingPreview(afterClose.req, afterClose.res);
      assert.equal(afterClose.res.getBody().by_method.cash.amount, baseCashAmt + 1000);

      // Ledger displays '卡券販售 · *XXXX'
      const ledgerRes = createMockReqRes({ query: { start_date: todayStr, end_date: todayStr } });
      await getLedger(ledgerRes.req, ledgerRes.res);
      const row = ledgerRes.res.getBody().ledger.find(l => l.id === soldPay1.id);
      assert.ok(row);
      assert.equal(row.user_name, `卡券販售 · *${soldPass1.pass_code.slice(-4)}`);

      // Accounting summary includes pass_sale revenue
      const sumRes = createMockReqRes({ query: { start_date: todayStr, end_date: todayStr } });
      await getAccountingSummary(sumRes.req, sumRes.res);
      assert.ok((sumRes.res.getBody().by_method?.cash?.amount || 0) >= 1000);
    }

    // 6. Same-day void of unused sold pass -> voided + pass REVOKED + closing cash decreases by 1000
    {
      const voidRes = await voidPayment(
        soldPay1.id,
        '客人買錯方案退訂',
        { id: 7, name: '販售小幫手' },
        { device_id: 'dev-1', device_label: 'R38櫃檯' }
      );
      assert.equal(voidRes.voided_count, 1);
      assert.equal(voidRes.voided_source, 'pass_sale');

      const revokedPass = await prisma.userPass.findUnique({ where: { id: soldPass1.id } });
      assert.equal(revokedPass.status, 'REVOKED');

      const afterVoidClose = createMockReqRes({ query: { date: todayStr } });
      await getClosingPreview(afterVoidClose.req, afterVoidClose.res);
      assert.equal(afterVoidClose.res.getBody().by_method?.cash?.amount || 0, baseCashAmt);
    }

    // 7. Sold pass used once -> voidPayment rejects with 409
    {
      const { req, res } = createMockReqRes({
        body: {
          user_id: user.id,
          plan_id: plan.id,
          mode: 'sale',
          method: 'cash',
          amount: 1000,
          cash_received: 1200,
          client_batch_id: `r38-sale-2-${ts}`
        }
      });
      await grantUserPass(req, res);
      assert.equal(res.getStatusCode(), 200);
      const soldPass2 = res.getBody().pass;
      const soldPay2 = res.getBody().payment;
      createdPassIds.push(soldPass2.id);
      createdPayIds.push(soldPay2.id);
      assert.equal(soldPay2.change_given, 200);

      const { req: redReq, res: redRes } = createMockReqRes({
        body: { user_pass_id: soldPass2.id, deduct_amount: 1, note: '使用一次' }
      });
      await redeemUserPass(redReq, redRes);
      assert.equal(redRes.getStatusCode(), 200);

      await assert.rejects(
        () => voidPayment(soldPay2.id, '想作廢已用卡券', { id: 1, name: '店長' }, { device_label: '櫃檯' }),
        (err) => err?.status === 409 && /這張卡已使用，請改用退款/.test(err.message)
      );
    }
  } finally {
    if (createdPayIds.length) {
      const pays = await prisma.payment.findMany({ where: { id: { in: createdPayIds } }, select: { booking_ref: true } });
      const bRefs = pays.map(p => p.booking_ref);
      await prisma.printJob.deleteMany({ where: { OR: [{ payment_id: { in: createdPayIds } }, { booking_ref: { in: bRefs } }] } });
      await prisma.payment.deleteMany({ where: { id: { in: createdPayIds } } });
    }
    if (createdPassIds.length) {
      await prisma.userPass.deleteMany({ where: { id: { in: createdPassIds } } });
    }
    if (plan) {
      await prisma.passPlan.deleteMany({ where: { id: plan.id } });
    }
    if (user) {
      await prisma.user.deleteMany({ where: { id: user.id } });
    }
    if (savedGlobal) {
      await prisma.globalSetting.update({
        where: { id: 1 },
        data: {
          print_enabled: savedGlobal.print_enabled,
          auto_print_receipt: savedGlobal.auto_print_receipt
        }
      }).catch(() => {});
    }
  }
});
