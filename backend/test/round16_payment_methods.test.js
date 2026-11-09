import test from 'node:test';
import assert from 'node:assert/strict';
import prisma from '../src/prismaClient.js';
import { updateGlobalSetting } from '../src/controllers/dailySettingController.js';
import { postCollect } from '../src/controllers/billingController.js';
import { dateOnly } from '../../shared/time.js';

function createMockReqRes({ params = {}, body = {}, user = { name: '店長測試員', id: 1 } } = {}) {
  const req = {
    params,
    body,
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

test('Round 16 Item 2: Payment methods configuration & validation', async (t) => {
  const runId = Math.random().toString(36).slice(2, 8);
  const bookingRef = `R16-${runId}-01`;
  const sessionDate = dateOnly('2026-11-15');

  // Ensure test user and session exist
  const testUser = await prisma.user.upsert({
    where: { line_user_id: `user_${runId}` },
    update: {},
    create: {
      line_user_id: `user_${runId}`,
      name: '付款測試員',
      phone: '0912000111'
    }
  });

  const session = await prisma.session.upsert({
    where: {
      session_date_start_time: {
        session_date: sessionDate,
        start_time: '14:00'
      }
    },
    update: {},
    create: {
      session_date: sessionDate,
      start_time: '14:00',
      end_time: '18:00',
      max_capacity: 20
    }
  });

  // Create test reservation
  const reservation = await prisma.reservation.create({
    data: {
      booking_ref: bookingRef,
      user_id: testUser.id,
      session_id: session.id,
      pax: 1,
      assigned_seats: ['1-1'],
      status: 'confirmed'
    }
  });

  await prisma.bookingPerson.createMany({
    data: [
      {
        booking_ref: bookingRef,
        person_no: 1,
        seat_code: '1-1',
        status: 'active'
      }
    ]
  });

  const cleanup = async () => {
    // Note: Never delete from accountingEvent due to append-only trigger
    await prisma.printJob.deleteMany({ where: { booking_ref: bookingRef } }).catch(() => {});
    await prisma.payment.deleteMany({ where: { booking_ref: bookingRef } }).catch(() => {});
    await prisma.bookingPerson.deleteMany({ where: { booking_ref: bookingRef } }).catch(() => {});
    await prisma.reservation.deleteMany({ where: { id: reservation.id } }).catch(() => {});
    await prisma.user.deleteMany({ where: { id: testUser.id } }).catch(() => {});

    // Restore default settings
    await prisma.globalSetting.update({
      where: { id: 1 },
      data: {
        payment_methods_json: [
          { key: 'cash', label: '現金', enabled: true },
          { key: 'linepay', label: 'LINE Pay', enabled: true },
          { key: 'transfer', label: '銀行轉帳', enabled: true }
        ]
      }
    }).catch(() => {});
  };

  t.after(cleanup);

  await t.test('1. 送出的設定把現金關掉時，後端仍然存成開啟', async () => {
    const { req, res } = createMockReqRes({
      body: {
        payment_methods_json: [
          { key: 'cash', label: '現金', enabled: false },
          { key: 'linepay', label: 'LINE Pay', enabled: false },
          { key: 'transfer', label: '銀行轉帳', enabled: true }
        ]
      }
    });

    await updateGlobalSetting(req, res);
    assert.equal(res.getStatusCode(), 200);

    const saved = await prisma.globalSetting.findUnique({ where: { id: 1 } });
    const cashMethod = saved.payment_methods_json.find(m => m.key === 'cash');
    const linepayMethod = saved.payment_methods_json.find(m => m.key === 'linepay');

    assert.ok(cashMethod, '現金付款方式必須存在');
    assert.equal(cashMethod.enabled, true, '送出 cash enabled: false 時，後端仍必須強制存為 enabled: true');
    assert.ok(linepayMethod, 'LINE Pay 付款方式必須存在');
    assert.equal(linepayMethod.enabled, false, 'LINE Pay 應被關閉 (enabled: false)');
  });

  await t.test('2. 關掉 LINE Pay 後，POST /billing/:ref/collect 用 linepay 回 422', async () => {
    const { req, res } = createMockReqRes({
      params: { booking_ref: bookingRef },
      body: {
        person_nos: [1],
        method: 'linepay',
        expected_amount: 200
      }
    });

    await postCollect(req, res);
    assert.equal(res.getStatusCode(), 422, '關掉 LINE Pay 後使用 linepay 收款應回傳 422');
    const data = res.getResponseData();
    assert.ok(data?.error, '應有錯誤訊息');
    assert.match(data.error, /未啟用|不支援/);
  });

  await t.test('3. 重新開啟 LINE Pay 後，POST /billing/:ref/collect 用 linepay 可成功付款', async () => {
    // Re-enable LINE Pay
    const { req: setReq, res: setRes } = createMockReqRes({
      body: {
        payment_methods_json: [
          { key: 'cash', label: '現金', enabled: true },
          { key: 'linepay', label: 'LINE Pay', enabled: true },
          { key: 'transfer', label: '銀行轉帳', enabled: true }
        ]
      }
    });
    await updateGlobalSetting(setReq, setRes);

    const { req, res } = createMockReqRes({
      params: { booking_ref: bookingRef },
      body: {
        person_nos: [1],
        method: 'linepay',
        expected_amount: 180
      }
    });

    await postCollect(req, res);
    assert.equal(res.getStatusCode(), 200, '開啟 LINE Pay 後應成功收款回傳 200');
    const data = res.getResponseData();
    assert.equal(data.success, true);
    assert.equal(data.payments?.[0]?.method, 'linepay');
  });
});
