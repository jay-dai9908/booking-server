import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import prisma from '../src/prismaClient.js';
import { checkIn, handleTimer } from '../src/controllers/floorController.js';
import { getLiveFloorData } from '../src/services/floor/liveService.js';
import { occupancyForSessions } from '../src/services/seating/layoutService.js';
import { isBookingCompleted } from '../../shared/floorSelectors.js';
import { toTaipeiDateString, dateOnly } from '../../shared/time.js';

const execFileAsync = promisify(execFile);

function createMockReqRes({ body = {}, params = {}, query = {}, user = { name: '店長', id: 1 } }) {
  const req = { body, params, query, user, headers: {} };
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

test('Paid bookings seating & timer tests (Spec 2.3)', async (t) => {
  const todayStr = toTaipeiDateString(new Date());
  const todayDate = dateOnly(todayStr);

  const testUser = await prisma.user.upsert({
    where: { line_user_id: 'test_paid_seating_user' },
    update: { name: '結清測試客' },
    create: { line_user_id: 'test_paid_seating_user', name: '結清測試客', phone: '0911222333' }
  });

  const createdSessionIds = [];
  const createdBookingRefs = [];
  const createdLayoutIds = [];
  const mutatedSessions = [];

  const cleanup = async () => {
    if (createdBookingRefs.length > 0) {
      await prisma.payment.deleteMany({ where: { booking_ref: { in: createdBookingRefs } } });
      await prisma.timerPause.deleteMany({ where: { person: { booking_ref: { in: createdBookingRefs } } } });
      await prisma.bookingPerson.deleteMany({ where: { booking_ref: { in: createdBookingRefs } } });
      await prisma.bookingEquipment.deleteMany({ where: { booking_ref: { in: createdBookingRefs } } });
      await prisma.reservation.deleteMany({ where: { booking_ref: { in: createdBookingRefs } } });
    }
    if (createdSessionIds.length > 0) {
      await prisma.reservation.deleteMany({ where: { session_id: { in: createdSessionIds } } });
      await prisma.session.deleteMany({ where: { id: { in: createdSessionIds } } });
    }
    if (mutatedSessions.length > 0) {
      for (const m of mutatedSessions) {
        await prisma.session.update({
          where: { id: m.id },
          data: { end_time: m.originalEndTime }
        }).catch(() => {});
      }
    }
    if (createdLayoutIds.length > 0) {
      await prisma.seat.deleteMany({ where: { layout_id: { in: createdLayoutIds } } });
      await prisma.seatTable.deleteMany({ where: { layout_id: { in: createdLayoutIds } } });
      await prisma.seatZone.deleteMany({ where: { layout_id: { in: createdLayoutIds } } });
      await prisma.seatLayout.deleteMany({ where: { id: { in: createdLayoutIds } } });
    }
  };

  // Helper to ensure a layout exists with B1 seats
  const ensureLayoutWithB1 = async () => {
    const published = await prisma.seatLayout.findFirst({
      where: { status: 'published' },
      include: { seats: true }
    });
    if (published && published.seats.some(s => s.code === 'B1-1')) {
      return;
    }
    const layout = await prisma.seatLayout.create({
      data: {
        name: 'Paid Test Layout',
        status: 'published',
        effective_from: todayDate,
        capacity: 4,
        canvas_w: 1000,
        canvas_h: 625,
        published_by_name: '店長',
        published_at: new Date()
      }
    });
    createdLayoutIds.push(layout.id);
    const zone = await prisma.seatZone.create({
      data: { layout_id: layout.id, name: '主區', sort_order: 0 }
    });
    const table = await prisma.seatTable.create({
      data: {
        layout_id: layout.id,
        zone_id: zone.id,
        label: 'B1',
        cx: 300,
        cy: 300,
        w: 100,
        h: 100,
        sort_order: 0
      }
    });
    for (const code of ['B1-1', 'B1-2', 'B1-3', 'B1-4']) {
      await prisma.seat.create({
        data: {
          layout_id: layout.id,
          zone_id: zone.id,
          table_id: table.id,
          code,
          lx: 0,
          ly: 0,
          sort_order: 0,
          is_active: true
        }
      });
    }
  };

  await ensureLayoutWithB1();

  const getOrCreateTestSession = async (startTime, endTime = null, capacity = 20) => {
    const defaultEnd = `${parseInt(startTime, 10) + 1}:00`;
    let sess = await prisma.session.findFirst({
      where: {
        session_date: todayDate,
        start_time: startTime
      }
    });
    if (sess) {
      if (endTime && sess.end_time !== endTime) {
        mutatedSessions.push({ id: sess.id, originalEndTime: sess.end_time });
        sess = await prisma.session.update({
          where: { id: sess.id },
          data: { end_time: endTime }
        });
      }
      return sess;
    }
    sess = await prisma.session.create({
      data: {
        session_date: todayDate,
        start_time: startTime,
        end_time: endTime || defaultEnd,
        max_capacity: capacity
      }
    });
    createdSessionIds.push(sess.id);
    return sess;
  };

  await cleanup();

  // Test 1: 先結帳、再帶位
  await t.test('1. 先結帳、再帶位：待入座 -> 帶位後在使用中、不計時、座位被佔用、同時段排位不會用到；時段結束自動離場；按全組離場釋出座位', async () => {
    const session = await getOrCreateTestSession('20:00', '22:00');
    const ref = 'BK-TEST-PAID-FIRST';
    createdBookingRefs.push(ref);

    await prisma.reservation.create({
      data: {
        booking_ref: ref,
        user_id: testUser.id,
        session_id: session.id,
        pax: 1,
        status: 'confirmed',
        attendance: 'pending',
        is_paid: true,
        billing_status: 'paid',
        total_amount: 300,
        amount_received: 300
      }
    });

    await prisma.payment.create({
      data: {
        payment_no: 'PAY-TEST-001',
        batch_no: 'BATCH-001',
        booking_ref: ref,
        amount: 300,
        method: 'cash',
        kind: 'charge',
        status: 'valid',
        breakdown_json: {},
        staff_name: '店長',
        device_label: '櫃檯',
        person_nos: [1]
      }
    });

    // 1. 先結帳、還沒帶位：在待入座
    const liveBeforeCheckIn = await getLiveFloorData(todayStr);
    const bookingBefore = liveBeforeCheckIn.bookings.find(b => b.booking_ref === ref);
    assert.ok(bookingBefore, 'Booking should exist in live floor data');
    assert.equal(bookingBefore.attendance, 'pending', '還沒帶位時 attendance 為 pending（待入座）');
    assert.equal(isBookingCompleted(bookingBefore), false, '未離場');

    // 2. 店員帶位
    const checkInMock = createMockReqRes({
      params: { booking_ref: ref },
      body: { seats: ['B1-1'], start_timer: true }
    });
    await checkIn(checkInMock.req, checkInMock.res);
    assert.equal(checkInMock.res.getStatusCode(), 200);

    // 帶位後：attendance 仍然是 checked_in，只更新座位，不開始計時
    const updatedResv = await prisma.reservation.findFirst({ where: { booking_ref: ref } });
    assert.equal(updatedResv.attendance, 'checked_in', '帶位後 attendance 仍為 checked_in');

    const person = await prisma.bookingPerson.findFirst({ where: { booking_ref: ref, person_no: 1 } });
    assert.ok(person, 'BookingPerson should exist');
    assert.equal(person.timer_started_at, null, '已付款的人不設定 timer_started_at（不開始計時）');

    // 在使用中、座位被佔用、同時段排位不會用到這些座位
    const liveAfterCheckIn = await getLiveFloorData(todayStr);
    const liveBooking = liveAfterCheckIn.bookings.find(b => b.booking_ref === ref);
    assert.ok(liveBooking);
    assert.equal(liveBooking.attendance, 'checked_in', 'live 數據中仍為 checked_in（使用中）');
    assert.deepEqual(liveBooking.assigned_seats, ['B1-1'], '座位照常佔用');

    const occ = await occupancyForSessions(prisma, [session.id]);
    assert.equal(occ[session.id]?.['B1-1'], ref, '同時段排位時該座位被此預約佔用');

    // 3. 已結清、時段還沒結束：在使用中
    const midSlotTime = new Date(`${todayStr}T21:00:00+08:00`);
    assert.equal(isBookingCompleted(liveBooking, midSlotTime), false, '時段還沒結束時留在使用中');

    // 時段結束後：自動移到已離場
    const afterSlotTime = new Date(`${todayStr}T22:05:00+08:00`);
    assert.equal(isBookingCompleted(liveBooking, afterSlotTime), true, '時段結束後自動移到已離場');

    // 4. 已結清後按全組離場：移到已離場，座位釋出
    const leaveMock = createMockReqRes({
      params: { booking_ref: ref },
      body: { action: 'end', person_nos: 'all' }
    });
    await handleTimer(leaveMock.req, leaveMock.res);
    assert.equal(leaveMock.res.getStatusCode(), 200);

    const departedResv = await prisma.reservation.findFirst({ where: { booking_ref: ref } });
    assert.equal(departedResv.attendance, 'completed', '按全組離場後 attendance 變為 completed');

    const occAfterLeave = await occupancyForSessions(prisma, [session.id]);
    assert.equal(occAfterLeave[session.id]?.['B1-1'], undefined, '離場後座位釋出');
  });

  // Test 2: 全組離場
  await t.test('2. 全組離場：person_nos: all，所有人的計時都結束，訂單標記 completed', async () => {
    const session = await getOrCreateTestSession('11:00', '23:59');
    const ref = 'BK-TEST-ALL-LEAVE';
    createdBookingRefs.push(ref);

    await prisma.reservation.create({
      data: {
        booking_ref: ref,
        user_id: testUser.id,
        session_id: session.id,
        pax: 2,
        status: 'confirmed',
        attendance: 'checked_in',
        assigned_seats: ['B1-1', 'B1-2'],
        total_amount: 600
      }
    });

    const now = new Date();
    await prisma.bookingPerson.createMany({
      data: [
        { booking_ref: ref, person_no: 1, seat_code: 'B1-1', timer_started_at: now, status: 'active' },
        { booking_ref: ref, person_no: 2, seat_code: 'B1-2', timer_started_at: now, status: 'active' }
      ]
    });

    // 觸發全組離場
    const leaveMock = createMockReqRes({
      params: { booking_ref: ref },
      body: { action: 'end', person_nos: 'all' }
    });
    await handleTimer(leaveMock.req, leaveMock.res);
    assert.equal(leaveMock.res.getStatusCode(), 200);

    const persons = await prisma.bookingPerson.findMany({ where: { booking_ref: ref } });
    assert.equal(persons.length, 2);
    assert.ok(persons[0].timer_ended_at != null, 'Person 1 timer ended');
    assert.ok(persons[1].timer_ended_at != null, 'Person 2 timer ended');

    const resv = await prisma.reservation.findFirst({ where: { booking_ref: ref } });
    assert.equal(resv.attendance, 'completed', 'Booking marked completed on all-leave');
  });

  // Test 3: 單一位離場
  await t.test('3. 單一位離場：只有該位計時結束，其他人仍在計時，訂單維持 checked_in', async () => {
    const session = await getOrCreateTestSession('12:00', '23:59');
    const ref = 'BK-TEST-SINGLE-LEAVE';
    createdBookingRefs.push(ref);

    await prisma.reservation.create({
      data: {
        booking_ref: ref,
        user_id: testUser.id,
        session_id: session.id,
        pax: 2,
        status: 'confirmed',
        attendance: 'checked_in',
        assigned_seats: ['B1-1', 'B1-2'],
        total_amount: 600
      }
    });

    const now = new Date();
    await prisma.bookingPerson.createMany({
      data: [
        { booking_ref: ref, person_no: 1, seat_code: 'B1-1', timer_started_at: now, status: 'active' },
        { booking_ref: ref, person_no: 2, seat_code: 'B1-2', timer_started_at: now, status: 'active' }
      ]
    });

    // 只有第 1 位離場
    const leaveMock = createMockReqRes({
      params: { booking_ref: ref },
      body: { action: 'end', person_nos: [1] }
    });
    await handleTimer(leaveMock.req, leaveMock.res);
    assert.equal(leaveMock.res.getStatusCode(), 200);

    const p1 = await prisma.bookingPerson.findFirst({ where: { booking_ref: ref, person_no: 1 } });
    const p2 = await prisma.bookingPerson.findFirst({ where: { booking_ref: ref, person_no: 2 } });
    assert.ok(p1.timer_ended_at != null, 'Person 1 ended');
    assert.equal(p2.timer_ended_at, null, 'Person 2 still timing');

    const resv = await prisma.reservation.findFirst({ where: { booking_ref: ref } });
    assert.equal(resv.attendance, 'checked_in', 'Booking still checked_in when someone is active');
  });

  // Test 4: 舊資料清理腳本 endTimersForPaidBookings.js
  await t.test('4. 舊資料腳本：--dry-run 只列出不修改；正式執行結束已結清計時；未結帳不受影響；具冪等性', async () => {
    const session = await getOrCreateTestSession('13:00', '23:59');
    const refPaid = 'BK-TEST-SCRIPT-PAID';
    const refUnpaid = 'BK-TEST-SCRIPT-UNPAID';
    createdBookingRefs.push(refPaid, refUnpaid);

    const now = new Date();

    // 1. 已結清但計時中
    await prisma.reservation.create({
      data: {
        booking_ref: refPaid,
        user_id: testUser.id,
        session_id: session.id,
        pax: 1,
        status: 'confirmed',
        attendance: 'checked_in',
        billing_status: 'paid',
        is_paid: true,
        assigned_seats: ['B1-1']
      }
    });
    await prisma.bookingPerson.create({
      data: {
        booking_ref: refPaid,
        person_no: 1,
        seat_code: 'B1-1',
        timer_started_at: now,
        status: 'active'
      }
    });
    await prisma.payment.create({
      data: {
        payment_no: 'PAY-TEST-002',
        batch_no: 'BATCH-001',
        booking_ref: refPaid,
        amount: 300,
        method: 'cash',
        kind: 'charge',
        status: 'valid',
        breakdown_json: {},
        staff_name: '店長',
        device_label: '櫃檯'
      }
    });

    // 2. 未結帳計時中
    await prisma.reservation.create({
      data: {
        booking_ref: refUnpaid,
        user_id: testUser.id,
        session_id: session.id,
        pax: 1,
        status: 'confirmed',
        attendance: 'checked_in',
        billing_status: 'unpaid',
        is_paid: false,
        assigned_seats: ['B1-2']
      }
    });
    await prisma.bookingPerson.create({
      data: {
        booking_ref: refUnpaid,
        person_no: 1,
        seat_code: 'B1-2',
        timer_started_at: now,
        status: 'active'
      }
    });

    const scriptPath = path.resolve(import.meta.dirname, '../src/scripts/endTimersForPaidBookings.js');

    // 執行 --dry-run
    const { stdout: dryOut } = await execFileAsync(process.execPath, [scriptPath, '--dry-run']);
    assert.match(dryOut, /BK-TEST-SCRIPT-PAID|結清測試客/, 'Dry run should list paid booking');
    assert.doesNotMatch(dryOut, /BK-TEST-SCRIPT-UNPAID/, 'Dry run must not touch unpaid booking');

    // 確認 dry-run 未做任何寫入
    const personPaidDry = await prisma.bookingPerson.findFirst({ where: { booking_ref: refPaid } });
    assert.equal(personPaidDry.timer_ended_at, null, 'Dry run should not modify DB');

    // 正式執行
    const { stdout: runOut } = await execFileAsync(process.execPath, [scriptPath]);
    assert.match(runOut, /BK-TEST-SCRIPT-PAID|結清測試客/, 'Script should process paid booking');

    const personPaidAfter = await prisma.bookingPerson.findFirst({ where: { booking_ref: refPaid } });
    assert.ok(personPaidAfter.timer_ended_at != null, 'Paid person timer ended after run');

    const resvPaidAfter = await prisma.reservation.findFirst({ where: { booking_ref: refPaid } });
    assert.equal(resvPaidAfter.attendance, 'completed', 'Paid reservation marked completed');

    const personUnpaidAfter = await prisma.bookingPerson.findFirst({ where: { booking_ref: refUnpaid } });
    assert.equal(personUnpaidAfter.timer_ended_at, null, 'Unpaid person timer untouched');

    // 冪等性：再次執行
    const { stdout: runOut2 } = await execFileAsync(process.execPath, [scriptPath]);
    assert.doesNotMatch(runOut2, /BK-TEST-SCRIPT-PAID/, 'Idempotent 2nd run should not process already completed booking');
  });

  // Test 5: 取消離場
  await t.test('5. 取消離場：只限當天且未付款者；已付款者不可取消離場', async () => {
    const session = await getOrCreateTestSession('14:00', '23:59');
    const refUnpaid = 'BK-TEST-RESTART-UNPAID';
    const refPaid = 'BK-TEST-RESTART-PAID';
    createdBookingRefs.push(refUnpaid, refPaid);

    const now = new Date();

    // 1. 未付款離場
    await prisma.reservation.create({
      data: {
        booking_ref: refUnpaid,
        user_id: testUser.id,
        session_id: session.id,
        pax: 1,
        status: 'confirmed',
        attendance: 'completed',
        billing_status: 'unpaid',
        is_paid: false,
        assigned_seats: ['B1-1']
      }
    });
    await prisma.bookingPerson.create({
      data: {
        booking_ref: refUnpaid,
        person_no: 1,
        seat_code: 'B1-1',
        timer_started_at: now,
        timer_ended_at: now,
        status: 'active'
      }
    });

    // 2. 已付款離場
    await prisma.reservation.create({
      data: {
        booking_ref: refPaid,
        user_id: testUser.id,
        session_id: session.id,
        pax: 1,
        status: 'confirmed',
        attendance: 'completed',
        billing_status: 'paid',
        is_paid: true,
        assigned_seats: ['B1-2']
      }
    });
    await prisma.bookingPerson.create({
      data: {
        booking_ref: refPaid,
        person_no: 1,
        seat_code: 'B1-2',
        timer_started_at: now,
        timer_ended_at: now,
        status: 'active'
      }
    });
    await prisma.payment.create({
      data: {
        payment_no: 'PAY-TEST-003',
        batch_no: 'BATCH-001',
        booking_ref: refPaid,
        amount: 300,
        method: 'cash',
        kind: 'charge',
        status: 'valid',
        breakdown_json: {},
        staff_name: '店長',
        device_label: '櫃檯'
      }
    });

    // 未付款取消離場
    const restartUnpaidMock = createMockReqRes({
      params: { booking_ref: refUnpaid },
      body: { action: 'restart', person_nos: [1] }
    });
    await handleTimer(restartUnpaidMock.req, restartUnpaidMock.res);
    assert.equal(restartUnpaidMock.res.getStatusCode(), 200);

    const pUnpaid = await prisma.bookingPerson.findFirst({ where: { booking_ref: refUnpaid } });
    assert.equal(pUnpaid.timer_ended_at, null, 'Unpaid person timer restarted');
    const rUnpaid = await prisma.reservation.findFirst({ where: { booking_ref: refUnpaid } });
    assert.equal(rUnpaid.attendance, 'checked_in', 'Unpaid reservation attendance back to checked_in');

    // 已付款取消離場（應被擋下或不變）
    const restartPaidMock = createMockReqRes({
      params: { booking_ref: refPaid },
      body: { action: 'restart', person_nos: [1] }
    });
    await handleTimer(restartPaidMock.req, restartPaidMock.res);

    const pPaid = await prisma.bookingPerson.findFirst({ where: { booking_ref: refPaid } });
    assert.ok(pPaid.timer_ended_at != null, 'Paid person timer remains ended');
  });

  // Test 6: 未結帳或有成員在場：只有每一位都按了離場，整筆預約才標記 completed
  await t.test('6. 每一位都按了離場：只有一位離場仍為 checked_in；每一位都離場後標記 completed', async () => {
    const session = await getOrCreateTestSession('15:00', '23:59');
    const ref = 'BK-TEST-SINGLE-END-WITH-PAID';
    createdBookingRefs.push(ref);

    await prisma.reservation.create({
      data: {
        booking_ref: ref,
        user_id: testUser.id,
        session_id: session.id,
        pax: 2,
        status: 'confirmed',
        attendance: 'checked_in',
        assigned_seats: ['B1-1', 'B1-2'],
        total_amount: 600
      }
    });

    const now = new Date();
    await prisma.bookingPerson.createMany({
      data: [
        { booking_ref: ref, person_no: 1, seat_code: 'B1-1', timer_started_at: null, timer_ended_at: null, status: 'active' },
        { booking_ref: ref, person_no: 2, seat_code: 'B1-2', timer_started_at: now, timer_ended_at: null, status: 'active' }
      ]
    });

    // 第 2 位按離場
    const leaveMock2 = createMockReqRes({
      params: { booking_ref: ref },
      body: { action: 'end', person_nos: [2] }
    });
    await handleTimer(leaveMock2.req, leaveMock2.res);
    assert.equal(leaveMock2.res.getStatusCode(), 200);

    const resvAfterOne = await prisma.reservation.findFirst({ where: { booking_ref: ref } });
    assert.equal(resvAfterOne.attendance, 'checked_in', '還有人尚未離場時維持 checked_in');

    // 第 1 位也按離場（每一位都按了離場）
    const leaveMock1 = createMockReqRes({
      params: { booking_ref: ref },
      body: { action: 'end', person_nos: [1] }
    });
    await handleTimer(leaveMock1.req, leaveMock1.res);
    assert.equal(leaveMock1.res.getStatusCode(), 200);

    const resvAfterBoth = await prisma.reservation.findFirst({ where: { booking_ref: ref } });
    assert.equal(resvAfterBoth.attendance, 'completed', '每一位都按了離場後整筆預約標記 completed');
  });

  await cleanup();
});
