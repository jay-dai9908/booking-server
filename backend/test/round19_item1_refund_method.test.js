import test from 'node:test';
import assert from 'node:assert/strict';
import prisma from '../src/prismaClient.js';
import { collectPayment, refundPayment } from '../src/services/billing/billService.js';
import { getClosingPreview } from '../src/controllers/accountingController.js';
import { dateOnly, toTaipeiDateString } from '../../shared/time.js';

function createMockReqRes({ query = {}, user = { name: '店長測試員', id: 1 } } = {}) {
  const req = {
    query,
    user,
    headers: { 'user-agent': 'NodeTestAgent' },
    ip: '127.0.0.1'
  };
  let statusCode = 200;
  let responseData = null;

  const res = {
    status(code) {
      statusCode = code;
      return res;
    },
    json(data) {
      responseData = data;
      return res;
    },
    getStatusCode() {
      return statusCode;
    },
    getResponseData() {
      return responseData;
    }
  };

  return { req, res };
}

test('Round 19 Item 1: Refund payment method preserves cash closing expected_cash', async (t) => {
  const runId = Math.random().toString(36).slice(2, 8);
  const bookingRef = `R19-${runId}-01`;
  const todayStr = toTaipeiDateString(new Date());
  const sessionDate = dateOnly(todayStr);

  // Ensure GlobalSetting has default float_amount 2000 and valid pricing
  await prisma.globalSetting.upsert({
    where: { id: 1 },
    update: {
      cash_float_amount: 2000,
      weekday_hourly_price: 150,
      weekday_unlimited_price: 750,
      payment_methods_json: [
        { key: 'cash', label: '現金', enabled: true },
        { key: 'linepay', label: 'LINE Pay', enabled: true },
        { key: 'transfer', label: '銀行轉帳', enabled: true },
        { key: 'card', label: '信用卡', enabled: true }
      ]
    },
    create: {
      id: 1,
      cash_float_amount: 2000,
      weekday_hourly_price: 150,
      weekday_unlimited_price: 750,
      payment_methods_json: [
        { key: 'cash', label: '現金', enabled: true },
        { key: 'linepay', label: 'LINE Pay', enabled: true },
        { key: 'transfer', label: '銀行轉帳', enabled: true },
        { key: 'card', label: '信用卡', enabled: true }
      ]
    }
  });

  const testUser = await prisma.user.upsert({
    where: { line_user_id: `user_r19_${runId}` },
    update: {},
    create: {
      line_user_id: `user_r19_${runId}`,
      name: '退款測試員',
      phone: '0912345678'
    }
  });

  const session = await prisma.session.upsert({
    where: {
      session_date_start_time: {
        session_date: sessionDate,
        start_time: '13:00'
      }
    },
    update: {
      end_time: '17:00',
      max_capacity: 20
    },
    create: {
      session_date: sessionDate,
      start_time: '13:00',
      end_time: '17:00',
      max_capacity: 20
    }
  });

  const reservation = await prisma.reservation.create({
    data: {
      booking_ref: bookingRef,
      user_id: testUser.id,
      session_id: session.id,
      pax: 1,
      assigned_seats: ['2-1'],
      status: 'confirmed'
    }
  });

  await prisma.bookingPerson.create({
    data: {
      booking_ref: bookingRef,
      person_no: 1,
      seat_code: '2-1',
      status: 'active'
    }
  });

  const cleanup = async () => {
    await prisma.printJob.deleteMany({ where: { booking_ref: bookingRef } }).catch(() => {});
    await prisma.payment.deleteMany({ where: { booking_ref: bookingRef } }).catch(() => {});
    await prisma.bookingPerson.deleteMany({ where: { booking_ref: bookingRef } }).catch(() => {});
    await prisma.reservation.deleteMany({ where: { id: reservation.id } }).catch(() => {});
    await prisma.user.deleteMany({ where: { id: testUser.id } }).catch(() => {});
    await prisma.session.deleteMany({ where: { id: session.id } }).catch(() => {});
  };

  t.after(cleanup);

  // Step 1: Collect payment with LINE Pay (NT$600)
  const collectResult = await collectPayment(
    bookingRef,
    {
      person_nos: [1],
      expected_amount: 600,
      method: 'linepay',
      cash_received: null,
      pass_tenders: [],
      print: false
    },
    { name: '店長', id: 1 },
    { device_id: 'DEV-TEST', device_label: '櫃檯' }
  );
  assert.ok(collectResult.payments?.length > 0, '應成功產生付款紀錄');
  assert.equal(collectResult.payments[0].method, 'linepay');
  assert.equal(collectResult.payments[0].amount, 600);

  // Baseline closing preview before refund
  const { req: req1, res: res1 } = createMockReqRes({ query: { date: todayStr } });
  await getClosingPreview(req1, res1);
  assert.equal(res1.getStatusCode(), 200);
  const baseline = res1.getResponseData();
  const baselineExpectedCash = baseline.expected_cash;

  // Step 2: Refund 100 with LINE Pay ('linepay')
  const refundResult = await refundPayment(
    bookingRef,
    {
      person_no: 1,
      amount: 100,
      method: 'linepay',
      reason: '客人提早離場',
      print: false
    },
    { name: '店長', id: 1 },
    { device_id: 'DEV-TEST', device_label: '櫃檯' }
  );
  assert.equal(refundResult.payment.method, 'linepay');
  assert.equal(refundResult.payment.amount, 100);

  // Step 3: Check closing preview after LINE Pay refund
  const { req: req2, res: res2 } = createMockReqRes({ query: { date: todayStr } });
  await getClosingPreview(req2, res2);
  assert.equal(res2.getStatusCode(), 200);
  const afterRefund = res2.getResponseData();

  // Verification:
  // 1. Expected cash must remain unchanged (LINE Pay refund does not deduct cash)
  assert.equal(
    afterRefund.expected_cash,
    baselineExpectedCash,
    'LINE Pay 退款不應扣減日結的現金應有 (expected_cash 應保持不變)'
  );

  // 2. LINE Pay refund amount is 100
  assert.equal(
    afterRefund.refunds?.linepay?.amount,
    100,
    '日結預覽中的 linepay 退款金額應為 100'
  );
  assert.equal(
    afterRefund.refunds?.linepay?.count,
    1,
    '日結預覽中的 linepay 退款筆數應為 1'
  );
});
