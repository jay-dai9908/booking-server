import test from 'node:test';
import assert from 'node:assert/strict';
import prisma from '../src/prismaClient.js';
import { getGlobalSetting } from '../src/controllers/dailySettingController.js';
import { postCollect, postSupplement } from '../src/controllers/billingController.js';
import { collectPayment } from '../src/services/billing/billService.js';
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

test('Round 18b Item 1: pass payment method vulnerability fix', async (t) => {
  const runId = Math.random().toString(36).slice(2, 8);
  const bookingRef = `R18B-${runId}-01`;
  const sessionDate = dateOnly('2026-11-20');

  const testUser = await prisma.user.upsert({
    where: { line_user_id: `user_r18b_${runId}` },
    update: {},
    create: {
      line_user_id: `user_r18b_${runId}`,
      name: '票券測試員',
      phone: '0912999888'
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
      end_time: '16:00',
      max_capacity: 20
    }
  });

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

  await prisma.bookingPerson.create({
    data: {
      booking_ref: bookingRef,
      person_no: 1,
      seat_code: '1-1',
      status: 'active'
    }
  });

  const passPlan = await prisma.passPlan.upsert({
    where: { code: `PLAN_${runId}` },
    update: {},
    create: {
      code: `PLAN_${runId}`,
      name: '時數體驗券',
      pass_type: 'TIME_PASS',
      total_quota: 10,
      checkout_effect: 'entry_hours'
    }
  });

  const userPass = await prisma.userPass.create({
    data: {
      user_id: testUser.id,
      plan_id: passPlan.id,
      pass_code: `PASS-${runId}`,
      plan_name_snapshot: '時數體驗券',
      pass_type: 'TIME_PASS',
      remaining_quota: 10,
      status: 'ACTIVE',
      expires_at: new Date('2026-12-31')
    }
  });

  const origSetting = await prisma.globalSetting.findFirst();
  const origMethods = origSetting?.payment_methods_json;

  const cleanup = async () => {
    if (origMethods !== undefined) {
      await prisma.globalSetting.update({
        where: { id: 1 },
        data: { payment_methods_json: origMethods }
      }).catch(() => {});
    }
    await prisma.printJob.deleteMany({ where: { booking_ref: { startsWith: `R18B-${runId}` } } }).catch(() => {});
    await prisma.payment.deleteMany({ where: { booking_ref: { startsWith: `R18B-${runId}` } } }).catch(() => {});
    await prisma.bookingPerson.deleteMany({ where: { booking_ref: { startsWith: `R18B-${runId}` } } }).catch(() => {});
    await prisma.reservation.deleteMany({ where: { user_id: testUser.id } }).catch(() => {});
    await prisma.userPass.deleteMany({ where: { user_id: testUser.id } }).catch(() => {});
    await prisma.passPlan.deleteMany({ where: { id: passPlan.id } }).catch(() => {});
    await prisma.user.deleteMany({ where: { id: testUser.id } }).catch(() => {});
  };

  t.after(cleanup);

  await t.test('1. POST /billing/:ref/collect with method: pass and no pass_tenders returns 422, order status unchanged', async () => {
    const { req, res } = createMockReqRes({
      params: { booking_ref: bookingRef },
      body: {
        person_nos: [1],
        method: 'pass'
      }
    });

    await postCollect(req, res);
    assert.equal(res.getStatusCode(), 422, '使用 method: pass 收款應回傳 422');
    const data = res.getResponseData();
    assert.match(data?.error || '', /卡券請用卡券折抵/, '應提示卡券請用卡券折抵');

    // Verify order status unchanged
    const resAfter = await prisma.reservation.findUnique({ where: { id: reservation.id } });
    assert.equal(resAfter.is_paid, false, '訂單應保持未付款');
    assert.equal(resAfter.paid_persons, 0, '已付款人數應為 0');

    // Verify no payment records created
    const payments = await prisma.payment.findMany({ where: { booking_ref: bookingRef } });
    assert.equal(payments.length, 0, '不應建立任何付款紀錄');
  });

  await t.test('2. POST /billing/:ref/collect using pass_tenders discount succeeds normally', async () => {
    const { req, res } = createMockReqRes({
      params: { booking_ref: bookingRef },
      body: {
        person_nos: [1],
        method: 'cash',
        pass_tenders: [
          {
            user_pass_id: userPass.id,
            person_no: 1,
            units: 2
          }
        ]
      }
    });

    await postCollect(req, res);
    assert.equal(res.getStatusCode(), 200, '使用 pass_tenders 收款應成功回傳 200');

    const resAfter = await prisma.reservation.findUnique({ where: { id: reservation.id } });
    assert.equal(resAfter.is_paid, true, '訂單應已結清');
    assert.equal(resAfter.paid_persons, 1, '已付款人數應為 1');

    const payments = await prisma.payment.findMany({ where: { booking_ref: bookingRef } });
    assert.ok(payments.length >= 1, '應建立卡券折抵付款紀錄');
    const passPayment = payments.find(p => p.method === 'pass');
    assert.ok(passPayment, '付款紀錄中應有 method: pass 的折抵');
    assert.ok(Array.isArray(passPayment.pass_json) && passPayment.pass_json.length > 0, 'pass_json 應有卡券明細');
  });

  await t.test('3. GlobalSetting filters out pass even if DB contains pass in payment_methods_json', async () => {
    // Inject pass into DB
    await prisma.globalSetting.update({
      where: { id: 1 },
      data: {
        payment_methods_json: [
          { key: 'cash', label: '現金', enabled: true },
          { key: 'pass', label: '體驗券 / 票券', enabled: true },
          { key: 'linepay', label: 'LINE Pay', enabled: true }
        ]
      }
    });

    const { req, res } = createMockReqRes();
    await getGlobalSetting(req, res);
    assert.equal(res.getStatusCode(), 200);

    const data = res.getResponseData();
    assert.ok(Array.isArray(data.payment_methods_json), '應回傳付款方式列表');
    const hasPass = data.payment_methods_json.some(m => (m.key || m.code) === 'pass');
    assert.equal(hasPass, false, '讀取設定時必須忽略 pass 付款方式');
  });

  await t.test('4. POST /billing/:ref/collect with partial pass tender and remaining method pass returns 422', async () => {
    // Setup a 2-person booking (total $300). Pass tender covers person 1 ($150), remaining balance $150 submitted with method: 'pass'
    const partialPass = await prisma.userPass.create({
      data: {
        user_id: testUser.id,
        plan_id: passPlan.id,
        pass_code: `PASS-PART-${runId}`,
        plan_name_snapshot: '時數體驗券',
        pass_type: 'TIME_PASS',
        remaining_quota: 1,
        status: 'ACTIVE',
        expires_at: new Date('2026-12-31')
      }
    });

    const bookingRefPartial = `R18B-PART-${runId}`;
    const resPartial = await prisma.reservation.create({
      data: {
        booking_ref: bookingRefPartial,
        user_id: testUser.id,
        session_id: session.id,
        pax: 2,
        assigned_seats: ['1-2', '1-3'],
        status: 'confirmed'
      }
    });
    await prisma.bookingPerson.createMany({
      data: [
        { booking_ref: bookingRefPartial, person_no: 1, seat_code: '1-2', status: 'active' },
        { booking_ref: bookingRefPartial, person_no: 2, seat_code: '1-3', status: 'active' }
      ]
    });

    const { req, res } = createMockReqRes({
      params: { booking_ref: bookingRefPartial },
      body: {
        person_nos: [1, 2],
        method: 'pass',
        pass_tenders: [
          {
            user_pass_id: partialPass.id,
            person_no: 1,
            units: 1
          }
        ]
      }
    });

    await postCollect(req, res);
    assert.equal(res.getStatusCode(), 422, '剩餘金額若以 method: pass 支付應回傳 422');
    assert.match(res.getResponseData()?.error || '', /卡券請用卡券折抵/);

    // Cleanup partial reservation
    await prisma.bookingPerson.deleteMany({ where: { booking_ref: bookingRefPartial } });
    await prisma.reservation.deleteMany({ where: { id: resPartial.id } });
    await prisma.userPass.delete({ where: { id: partialPass.id } });
  });

  await t.test('5. POST /billing/:ref/supplement with method pass returns 422', async () => {
    const { req, res } = createMockReqRes({
      params: { booking_ref: bookingRef },
      body: {
        person_no: 1,
        method: 'pass',
        items: [{ type: 'other', label: '加購耗材', amount: 50 }]
      }
    });

    await postSupplement(req, res);
    assert.equal(res.getStatusCode(), 422, '補收使用 method: pass 應回傳 422');
    assert.match(res.getResponseData()?.error || '', /卡券請用卡券折抵/);
  });
});
