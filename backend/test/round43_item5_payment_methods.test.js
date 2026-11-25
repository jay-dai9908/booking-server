import test from 'node:test';
import assert from 'node:assert/strict';
import prisma from '../src/prismaClient.js';
import { getGlobalSetting, updateGlobalSetting } from '../src/controllers/dailySettingController.js';
import { postCollect } from '../src/controllers/billingController.js';
import { queuePrintJob } from '../src/services/print/printService.js';
import { dateOnly } from '../../shared/time.js';

function createMockReqRes({
  body = {},
  params = {},
  query = {},
  user = { id: 905, name: 'R43付款測試員', role: 'admin', isSuperAdmin: true, permissions: ['all'] }
} = {}) {
  const req = { body, params, query, user, headers: { 'user-agent': 'NodeTestAgent' }, ip: '127.0.0.1' };
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

test('Round 43 Item 5: custom payment methods CRUD, strict 422 validation, Payment guard, and receipt/reprint labels', async () => {
  const runId = Math.random().toString(36).slice(2, 8);
  const bookingRef = `R43PM-${runId}`;
  const sessionDate = dateOnly('2026-11-28');
  const origSetting = await prisma.globalSetting.findUnique({ where: { id: 1 } });

  let testUser = null;
  let reservation = null;
  let printStation = null;

  try {
    // Ensure print enabled & a station or global print_enabled = true so PrintJob is created
    await prisma.globalSetting.upsert({
      where: { id: 1 },
      update: { print_enabled: true, auto_print_receipt: true },
      create: { id: 1, print_enabled: true, auto_print_receipt: true }
    });

    printStation = await prisma.printStation.findFirst({ where: { is_default: true } });

    testUser = await prisma.user.create({
      data: {
        line_user_id: `r43_pm_${runId}`,
        name: 'R43付款方式測試客',
        phone: '0912345699'
      }
    });

    const session = await prisma.session.upsert({
      where: { session_date_start_time: { session_date: sessionDate, start_time: '14:00' } },
      update: {},
      create: { session_date: sessionDate, start_time: '14:00', end_time: '18:00', max_capacity: 20 }
    });

    reservation = await prisma.reservation.create({
      data: {
        booking_ref: bookingRef,
        user_id: testUser.id,
        session_id: session.id,
        pax: 1,
        assigned_seats: ['1-1'],
        status: 'confirmed',
        is_unlimited: false
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

    // 1. Add { key: 'custom_1', label: '街口', enabled: true } -> 200 & visible on GET
    const initialList = [
      { key: 'cash', label: '現金', enabled: true },
      { key: 'linepay', label: 'LINE Pay', enabled: true },
      { key: 'transfer', label: '銀行轉帳', enabled: true },
      { key: 'custom_1', label: '街口', enabled: true }
    ];
    const rSave1 = createMockReqRes({ body: { payment_methods_json: initialList } });
    await updateGlobalSetting(rSave1.req, rSave1.res);
    assert.equal(rSave1.res.getStatusCode(), 200);

    const rGet1 = createMockReqRes();
    await getGlobalSetting(rGet1.req, rGet1.res);
    assert.equal(rGet1.res.getStatusCode(), 200);
    const custom1 = rGet1.res.getBody().payment_methods_json.find((m) => m.key === 'custom_1');
    assert.deepEqual(custom1, { key: 'custom_1', label: '街口', enabled: true });

    // 2. Collect payment using custom_1 -> 200, receipt commands_json shows '街口' without 'custom_1'
    const rCollect = createMockReqRes({
      params: { booking_ref: bookingRef },
      body: { person_nos: [1], method: 'custom_1' }
    });
    await postCollect(rCollect.req, rCollect.res);
    assert.equal(rCollect.res.getStatusCode(), 200);
    const payRow = rCollect.res.getBody().payments[0];
    assert.equal(payRow.method, 'custom_1');

    const job1 = await queuePrintJob({
      type: 'receipt',
      booking_ref: bookingRef,
      payment_id: payRow.id,
      user: { id: 905, name: 'R43付款測試員' },
      device: { device_label: printStation?.name || '櫃檯' }
    });
    assert.ok(job1, 'Receipt print job should be created');
    const cmdText1 = JSON.stringify(job1.commands_json);
    assert.ok(cmdText1.includes('街口'), `Receipt should include 街口, got: ${cmdText1}`);
    assert.ok(!cmdText1.includes('custom_1'), `Receipt must not include raw custom_1: ${cmdText1}`);

    // 3. Rename custom_1 -> '街口支付', old Payment.method stays 'custom_1', reprint shows '街口支付'
    const renamedList = initialList.map((m) => (m.key === 'custom_1' ? { ...m, label: '街口支付' } : m));
    const rRename = createMockReqRes({ body: { payment_methods_json: renamedList } });
    await updateGlobalSetting(rRename.req, rRename.res);
    assert.equal(rRename.res.getStatusCode(), 200);

    const payReloaded = await prisma.payment.findUnique({ where: { id: payRow.id } });
    assert.equal(payReloaded.method, 'custom_1');

    const jobReprint = await queuePrintJob({
      type: 'receipt',
      booking_ref: bookingRef,
      payment_id: payRow.id,
      reprint_of_id: job1.id,
      user: { id: 905, name: 'R43付款測試員' },
      device: { device_label: printStation?.name || '櫃檯' }
    });
    const cmdTextReprint = JSON.stringify(jobReprint.commands_json);
    assert.ok(cmdTextReprint.includes('街口支付'), `Reprinted receipt must include 街口支付: ${cmdTextReprint}`);
    assert.ok(!cmdTextReprint.includes('custom_1'));

    // 4. Try removing custom_1 after Payment record exists -> 422 & GET unchanged
    const rRemoveUsed = createMockReqRes({
      body: {
        payment_methods_json: [
          { key: 'cash', label: '現金', enabled: true },
          { key: 'linepay', label: 'LINE Pay', enabled: true },
          { key: 'transfer', label: '銀行轉帳', enabled: true }
        ]
      }
    });
    await updateGlobalSetting(rRemoveUsed.req, rRemoveUsed.res);
    assert.equal(rRemoveUsed.res.getStatusCode(), 422);
    assert.match(rRemoveUsed.res.getBody().error || '', /已有收款紀錄，只能停用/);

    const rGetAfterGuard = createMockReqRes();
    await getGlobalSetting(rGetAfterGuard.req, rGetAfterGuard.res);
    assert.ok(
      rGetAfterGuard.res.getBody().payment_methods_json.some((m) => m.key === 'custom_1'),
      'GET list must remain unchanged after 422 guard'
    );

    // 5. Validation cases -> 422
    const rDupNorm = createMockReqRes({
      body: {
        payment_methods_json: [
          { key: 'cash', label: '現金', enabled: true },
          { key: 'line_pay', label: 'LINE A', enabled: true },
          { key: 'linepay', label: 'LINE B', enabled: true },
          { key: 'custom_1', label: '街口支付', enabled: true }
        ]
      }
    });
    await updateGlobalSetting(rDupNorm.req, rDupNorm.res);
    assert.equal(rDupNorm.res.getStatusCode(), 422);

    const rReservedPass = createMockReqRes({
      body: {
        payment_methods_json: [
          { key: 'cash', label: '現金', enabled: true },
          { key: 'pass', label: '卡券', enabled: true },
          { key: 'custom_1', label: '街口支付', enabled: true }
        ]
      }
    });
    await updateGlobalSetting(rReservedPass.req, rReservedPass.res);
    assert.equal(rReservedPass.res.getStatusCode(), 422);

    const rDupLabel = createMockReqRes({
      body: {
        payment_methods_json: [
          { key: 'cash', label: '現金', enabled: true },
          { key: 'linepay', label: '重複名稱', enabled: true },
          { key: 'custom_1', label: '重複名稱', enabled: true }
        ]
      }
    });
    await updateGlobalSetting(rDupLabel.req, rDupLabel.res);
    assert.equal(rDupLabel.res.getStatusCode(), 422);

    const thirteenMethods = [
      { key: 'cash', label: '現金', enabled: true },
      { key: 'custom_1', label: '街口支付', enabled: true },
      ...Array.from({ length: 11 }, (_, i) => ({
        key: `extra_${i + 1}`,
        label: `方式${i + 1}`,
        enabled: true
      }))
    ];
    assert.equal(thirteenMethods.length, 13);
    const rTooMany = createMockReqRes({ body: { payment_methods_json: thirteenMethods } });
    await updateGlobalSetting(rTooMany.req, rTooMany.res);
    assert.equal(rTooMany.res.getStatusCode(), 422);
  } finally {
    await prisma.printJob.deleteMany({ where: { booking_ref: bookingRef } }).catch(() => {});
    await prisma.payment.deleteMany({ where: { booking_ref: bookingRef } }).catch(() => {});
    await prisma.bookingPerson.deleteMany({ where: { booking_ref: bookingRef } }).catch(() => {});
    if (reservation?.id) {
      await prisma.reservation.deleteMany({ where: { id: reservation.id } }).catch(() => {});
    }
    if (testUser?.id) {
      await prisma.user.deleteMany({ where: { id: testUser.id } }).catch(() => {});
    }
    if (origSetting) {
      await prisma.globalSetting.update({
        where: { id: 1 },
        data: {
          payment_methods_json: origSetting.payment_methods_json,
          print_enabled: origSetting.print_enabled,
          auto_print_receipt: origSetting.auto_print_receipt
        }
      }).catch(() => {});
    }
  }
});
