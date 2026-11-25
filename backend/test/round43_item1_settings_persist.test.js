import test from 'node:test';
import assert from 'node:assert/strict';
import prisma from '../src/prismaClient.js';
import { dateOnly, toTaipeiDateString } from '../../shared/time.js';
import { getGlobalSetting, updateGlobalSetting } from '../src/controllers/dailySettingController.js';
import { getClosingPreview } from '../src/controllers/accountingController.js';
import { createReservation } from '../src/controllers/reservationController.js';
import { getBookingBill, collectPayment } from '../src/services/billing/billService.js';

function createMockReqRes({ body = {}, params = {}, query = {}, user = { id: 901, name: 'R43測試店長', role: 'admin', isSuperAdmin: true, permissions: ['all'] } } = {}) {
  const req = { body, params, query, user, headers: {}, ip: '127.0.0.1' };
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

test('Round 43 Item 1: updateGlobalSetting persists all 9 checkout/timer/print fields, validates 422, affects unpaid bills & closing float, and audits without token leak', async () => {
  const ts = Date.now();
  const futureStr = toTaipeiDateString(new Date(Date.now() + 14 * 86400000));
  const futureDate = dateOnly(futureStr);
  const createdRefs = [];
  const createdUserIds = [];
  let s1 = null;
  let s2 = null;

  const origGlobal = await prisma.globalSetting.findUnique({ where: { id: 1 } });

  try {
    // Baseline defaults
    await prisma.globalSetting.upsert({
      where: { id: 1 },
      update: {
        weekday_hourly_price: 100,
        weekday_unlimited_price: 550,
        weekend_hourly_price: 150,
        weekend_unlimited_price: 800,
        billing_grace_minutes: 10,
        billing_block_minutes: 30,
        board_swap_grace_minutes: 10,
        early_leave_mode: 'booked',
        default_split_mode: 'proportional',
        cash_float_amount: 2000,
        auto_print_receipt: true,
        auto_print_summary: true,
        receipt_footer_text: '謝謝光臨，作品記得帶回家',
        line_messaging_token: null
      },
      create: {
        id: 1,
        weekday_hourly_price: 100,
        weekday_unlimited_price: 550,
        weekend_hourly_price: 150,
        weekend_unlimited_price: 800,
        billing_grace_minutes: 10,
        billing_block_minutes: 30,
        board_swap_grace_minutes: 10,
        early_leave_mode: 'booked',
        default_split_mode: 'proportional',
        cash_float_amount: 2000,
        auto_print_receipt: true,
        auto_print_summary: true,
        receipt_footer_text: '謝謝光臨，作品記得帶回家'
      }
    });

    // 1) Update all 9 fields once
    const putPayload = {
      billing_grace_minutes: 5,
      billing_block_minutes: 15,
      board_swap_grace_minutes: 5,
      early_leave_mode: 'actual',
      default_split_mode: 'even',
      cash_float_amount: 3000,
      auto_print_receipt: false,
      auto_print_summary: false,
      receipt_footer_text: '測試頁尾'
    };
    const putRes = createMockReqRes({ body: putPayload });
    await updateGlobalSetting(putRes.req, putRes.res);
    assert.equal(putRes.res.getStatusCode(), 200);

    const getRes = createMockReqRes();
    await getGlobalSetting(getRes.req, getRes.res);
    assert.equal(getRes.res.getStatusCode(), 200);
    const fetched = getRes.res.getBody();
    for (const [k, v] of Object.entries(putPayload)) {
      assert.equal(fetched[k], v, `GET /daily-settings/global mismatch for ${k}`);
    }

    // 2) Validation 422 cases leave DB untouched
    const invalidCases = [
      { field: 'billing_grace_minutes', value: -1 },
      { field: 'billing_grace_minutes', value: 31 },
      { field: 'billing_block_minutes', value: 20 },
      { field: 'early_leave_mode', value: 'x' },
      { field: 'default_split_mode', value: 'x' },
      { field: 'cash_float_amount', value: -1 },
      { field: 'receipt_footer_text', value: '一'.repeat(61) },
      { field: 'weekday_hourly_price', value: 'abc' },
      { field: 'default_session_capacity', value: 201 },
      {
        field: 'business_hours_json',
        value: {
          weekday: { start: '18:00', end: '10:00' },
          saturday: { start: '09:00', end: '21:00' },
          sunday: { start: '09:00', end: '21:00' }
        }
      }
    ];

    for (const ic of invalidCases) {
      const badReq = createMockReqRes({ body: { [ic.field]: ic.value } });
      await updateGlobalSetting(badReq.req, badReq.res);
      assert.equal(badReq.res.getStatusCode(), 422, `Expected 422 for ${ic.field}=${JSON.stringify(ic.value)}, got ${badReq.res.getStatusCode()}`);
      assert.equal(badReq.res.getBody().field, ic.field);

      const verifyRes = createMockReqRes();
      await getGlobalSetting(verifyRes.req, verifyRes.res);
      const afterBad = verifyRes.res.getBody();
      assert.equal(afterBad.billing_grace_minutes, 5);
      assert.equal(afterBad.cash_float_amount, 3000);
      assert.equal(afterBad.receipt_footer_text, '測試頁尾');
    }

    // Empty receipt_footer_text saves null
    const emptyFooterRes = createMockReqRes({ body: { receipt_footer_text: '   ' } });
    await updateGlobalSetting(emptyFooterRes.req, emptyFooterRes.res);
    assert.equal(emptyFooterRes.res.getStatusCode(), 200);
    const getEmptyFooter = createMockReqRes();
    await getGlobalSetting(getEmptyFooter.req, getEmptyFooter.res);
    assert.equal(getEmptyFooter.res.getBody().receipt_footer_text, null);

    // 3) Billing follows billing_grace_minutes for unpaid, frozen for paid
    await prisma.dailySetting.deleteMany({ where: { date: futureDate } });
    await prisma.dailySetting.create({
      data: { date: futureDate, hourly_price: 100, unlimited_price: 550, allow_unlimited: true }
    });
    const staleRefs = (await prisma.reservation.findMany({ where: { session: { session_date: futureDate } }, select: { booking_ref: true } })).map(r => r.booking_ref);
    if (staleRefs.length) {
      await prisma.payment.deleteMany({ where: { booking_ref: { in: staleRefs } } });
      await prisma.bookingPerson.deleteMany({ where: { booking_ref: { in: staleRefs } } });
      await prisma.reservation.deleteMany({ where: { booking_ref: { in: staleRefs } } });
    }
    await prisma.session.deleteMany({ where: { session_date: futureDate } });
    s1 = await prisma.session.create({
      data: { session_date: futureDate, start_time: '14:00', end_time: '15:00', max_capacity: 20 }
    });
    s2 = await prisma.session.create({
      data: { session_date: futureDate, start_time: '15:00', end_time: '16:00', max_capacity: 20 }
    });

    const uUnpaid = await prisma.user.create({
      data: { line_user_id: `r43_u1_${ts}`, name: 'R43未付款', phone: `09431${String(ts).slice(-5)}` } // check-secrets: fake-data
    });
    const uPaid = await prisma.user.create({
      data: { line_user_id: `r43_u2_${ts}`, name: 'R43已付款', phone: `09432${String(ts).slice(-5)}` } // check-secrets: fake-data
    });
    createdUserIds.push(uUnpaid.id, uPaid.id);

    // Reset grace=10, block=30
    const resetGraceRes = createMockReqRes({
      body: { billing_grace_minutes: 10, billing_block_minutes: 30, early_leave_mode: 'booked' }
    });
    await updateGlobalSetting(resetGraceRes.req, resetGraceRes.res);
    assert.equal(resetGraceRes.res.getStatusCode(), 200);

    const createBooking = async (userId) => {
      const r = createMockReqRes({
        user: { id: userId, role: 'customer' },
        body: { session_ids: [s1.id], pax: 1 }
      });
      await createReservation(r.req, r.res);
      assert.equal(r.res.getStatusCode(), 201);
      const body = r.res.getBody();
      const ref = body.reservation?.booking_ref || body.booking?.booking_ref || body.booking_ref;
      assert.ok(ref, `Expected booking_ref from createReservation, got ${JSON.stringify(body)}`);
      createdRefs.push(ref);
      await prisma.bookingPerson.create({
        data: {
          booking_ref: ref,
          person_no: 1,
          status: 'active',
          billing_start_at: new Date(`${futureStr}T14:00:00+08:00`),
          timer_started_at: new Date(`${futureStr}T14:00:00+08:00`),
          timer_ended_at: new Date(`${futureStr}T15:25:00+08:00`) // 1h25m (85 mins)
        }
      });
      return ref;
    };

    const unpaidRef = await createBooking(uUnpaid.id);
    const paidRef = await createBooking(uPaid.id);

    // With grace=10: 85 mins = 60 + 25 (>10) -> 1.5h = 150
    const unpaidBefore = await getBookingBill(unpaidRef);
    assert.equal(unpaidBefore.bill.persons[0].entry.hours, 1.5);
    assert.equal(unpaidBefore.bill.summary.amount_due, 150);

    // Pay paidRef under grace=10 (150)
    await collectPayment(
      paidRef,
      {
        person_nos: [1],
        expected_amount: 150,
        expected_net_amount: 150,
        method: 'cash',
        received_amount: 150,
        cash_received: 150
      },
      { id: 901, name: 'R43測試店長' },
      { device_label: '測試' }
    );
    const paidBefore = await getBookingBill(paidRef);
    assert.equal(paidBefore.bill.persons[0].total, 150);

    // Change grace -> 30
    const grace30Res = createMockReqRes({ body: { billing_grace_minutes: 30 } });
    await updateGlobalSetting(grace30Res.req, grace30Res.res);
    assert.equal(grace30Res.res.getStatusCode(), 200);

    const unpaidAfter = await getBookingBill(unpaidRef);
    assert.equal(unpaidAfter.bill.persons[0].entry.hours, 1);
    assert.equal(unpaidAfter.bill.summary.amount_due, 100);

    const paidAfter = await getBookingBill(paidRef);
    assert.equal(paidAfter.bill.persons[0].total, 150, 'Paid guest bill must remain frozen at 150');
    assert.equal(paidAfter.bill.summary.amount_due, 150, 'Paid guest summary amount_due must remain frozen at 150');

    // 4) Closing preview reads updated cash_float_amount = 3000
    const closePreviewRes = createMockReqRes({ query: { date: toTaipeiDateString(new Date()) } });
    await getClosingPreview(closePreviewRes.req, closePreviewRes.res);
    assert.equal(closePreviewRes.res.getStatusCode(), 200);
    assert.equal(closePreviewRes.res.getBody().float_amount, 3000);

    // 5) Audit test: reset grace=10, cash_float_amount=2000 first, then update 10->5 & 2000->3000 together
    const prepAudit = createMockReqRes({
      body: { billing_grace_minutes: 10, cash_float_amount: 2000 }
    });
    await updateGlobalSetting(prepAudit.req, prepAudit.res);
    assert.equal(prepAudit.res.getStatusCode(), 200);

    const auditUpdate = createMockReqRes({
      user: { id: 901, name: 'R43稽核店長', role: 'admin', isSuperAdmin: true, permissions: ['all'] },
      body: { billing_grace_minutes: 5, cash_float_amount: 3000 }
    });
    await updateGlobalSetting(auditUpdate.req, auditUpdate.res);
    assert.equal(auditUpdate.res.getStatusCode(), 200);

    const auditEv = await prisma.accountingEvent.findFirst({
      where: { category: 'setting', event_type: 'setting_changed' },
      orderBy: { id: 'desc' }
    });
    assert.ok(auditEv);
    assert.deepEqual(auditEv.before_json, { billing_grace_minutes: 10, cash_float_amount: 2000 });
    assert.deepEqual(auditEv.after_json, { billing_grace_minutes: 5, cash_float_amount: 3000 });
    assert.equal(auditEv.staff_name, 'R43稽核店長');

    // 6) Token update never leaks token in audit event
    const fakeToken = 'test-token-abcdef'; // check-secrets: fake-data
    const tokenRes = createMockReqRes({
      user: { id: 901, name: 'R43稽核店長', role: 'admin', isSuperAdmin: true, permissions: ['all'] },
      body: { line_messaging_token: fakeToken }
    });
    await updateGlobalSetting(tokenRes.req, tokenRes.res);
    assert.equal(tokenRes.res.getStatusCode(), 200);

    const tokenEv = await prisma.accountingEvent.findFirst({
      where: { category: 'setting', event_type: 'setting_changed' },
      orderBy: { id: 'desc' }
    });
    assert.ok(tokenEv);
    assert.equal(JSON.stringify(tokenEv).includes(fakeToken), false, 'Audit log must NEVER contain raw line_messaging_token');
  } finally {
    await prisma.payment.deleteMany({
      where: { booking_ref: { in: createdRefs } }
    }).catch(() => {});
    await prisma.bookingPerson.deleteMany({
      where: { booking_ref: { in: createdRefs } }
    }).catch(() => {});
    await prisma.reservation.deleteMany({
      where: { booking_ref: { in: createdRefs } }
    }).catch(() => {});
    await prisma.dailySetting.deleteMany({ where: { date: futureDate } }).catch(() => {});
    if (s1 || s2) {
      await prisma.session.deleteMany({
        where: { id: { in: [s1?.id, s2?.id].filter(Boolean) } }
      }).catch(() => {});
    }
    if (createdUserIds.length) {
      await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } }).catch(() => {});
    }
    if (origGlobal) {
      await prisma.globalSetting.update({
        where: { id: 1 },
        data: {
          weekday_hourly_price: origGlobal.weekday_hourly_price,
          weekday_unlimited_price: origGlobal.weekday_unlimited_price,
          weekend_hourly_price: origGlobal.weekend_hourly_price,
          weekend_unlimited_price: origGlobal.weekend_unlimited_price,
          billing_grace_minutes: origGlobal.billing_grace_minutes,
          billing_block_minutes: origGlobal.billing_block_minutes,
          board_swap_grace_minutes: origGlobal.board_swap_grace_minutes,
          early_leave_mode: origGlobal.early_leave_mode,
          default_split_mode: origGlobal.default_split_mode,
          cash_float_amount: origGlobal.cash_float_amount,
          auto_print_receipt: origGlobal.auto_print_receipt,
          auto_print_summary: origGlobal.auto_print_summary,
          receipt_footer_text: origGlobal.receipt_footer_text,
          line_messaging_token: origGlobal.line_messaging_token
        }
      }).catch(() => {});
    }
  }
});
