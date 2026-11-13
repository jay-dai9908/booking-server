import test from 'node:test';
import assert from 'node:assert/strict';
import prisma from '../src/prismaClient.js';
import { moveGroup } from '../src/controllers/floorController.js';
import { dateOnly } from '../../shared/time.js';

function createMockReqRes({ body = {}, params = {}, query = {}, user = { name: '店長', id: 1 } }) {
  const req = { body, params, query, user, headers: { 'user-agent': 'NodeTestAgent' }, ip: '127.0.0.1' };
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

test('Round 22 Item 4: moveGroup unit tests', async (t) => {
  const todayStr = '2026-11-20';
  const dbDate = dateOnly(todayStr);

  // Setup GlobalSetting
  await prisma.globalSetting.upsert({
    where: { id: 1 },
    update: { seat_layout_enabled: true },
    create: { id: 1, seat_layout_enabled: true }
  });

  // Setup test user
  const testUser = await prisma.user.upsert({
    where: { line_user_id: 'test_user_round22' },
    update: { name: '換桌測試員' },
    create: {
      line_user_id: 'test_user_round22',
      name: '換桌測試員',
      phone: '0912345678'
    }
  });

  // Setup layout with 3 tables: Table A (4 seats), Table B (4 seats), Table C (2 seats)
  const testLayout = await prisma.seatLayout.create({
    data: {
      name: 'Round 22 Move Group Layout',
      status: 'published',
      effective_from: dbDate,
      canvas_w: 1000,
      canvas_h: 625,
      zones: {
        create: [{ name: '測試區', sort_order: 0 }]
      }
    },
    include: { zones: true }
  });
  const zoneId = testLayout.zones[0].id;

  const tableA = await prisma.seatTable.create({
    data: {
      layout_id: testLayout.id,
      zone_id: zoneId,
      label: '桌 A',
      shape: 'rect',
      arrangement: 'two_sides',
      w: 60,
      h: 120,
      cx: 100,
      cy: 100,
      rotation: 0
    }
  });

  const tableB = await prisma.seatTable.create({
    data: {
      layout_id: testLayout.id,
      zone_id: zoneId,
      label: '桌 B',
      shape: 'rect',
      arrangement: 'two_sides',
      w: 60,
      h: 120,
      cx: 250,
      cy: 100,
      rotation: 0
    }
  });

  const tableC = await prisma.seatTable.create({
    data: {
      layout_id: testLayout.id,
      zone_id: zoneId,
      label: '桌 C',
      shape: 'rect',
      arrangement: 'one_side',
      w: 60,
      h: 60,
      cx: 400,
      cy: 100,
      rotation: 0
    }
  });

  // Create seats for Table A
  await prisma.seat.createMany({
    data: [
      { layout_id: testLayout.id, zone_id: zoneId, table_id: tableA.id, code: 'A1-1', lx: 0, ly: 0, is_active: true, sort_order: 1 },
      { layout_id: testLayout.id, zone_id: zoneId, table_id: tableA.id, code: 'A1-2', lx: 0, ly: 0, is_active: true, sort_order: 2 },
      { layout_id: testLayout.id, zone_id: zoneId, table_id: tableA.id, code: 'A1-3', lx: 0, ly: 0, is_active: true, sort_order: 3 },
      { layout_id: testLayout.id, zone_id: zoneId, table_id: tableA.id, code: 'A1-4', lx: 0, ly: 0, is_active: true, sort_order: 4 }
    ]
  });

  // Create seats for Table B
  await prisma.seat.createMany({
    data: [
      { layout_id: testLayout.id, zone_id: zoneId, table_id: tableB.id, code: 'B1-1', lx: 0, ly: 0, is_active: true, sort_order: 1 },
      { layout_id: testLayout.id, zone_id: zoneId, table_id: tableB.id, code: 'B1-2', lx: 0, ly: 0, is_active: true, sort_order: 2 },
      { layout_id: testLayout.id, zone_id: zoneId, table_id: tableB.id, code: 'B1-3', lx: 0, ly: 0, is_active: true, sort_order: 3 },
      { layout_id: testLayout.id, zone_id: zoneId, table_id: tableB.id, code: 'B1-4', lx: 0, ly: 0, is_active: true, sort_order: 4 }
    ]
  });

  // Create seats for Table C
  await prisma.seat.createMany({
    data: [
      { layout_id: testLayout.id, zone_id: zoneId, table_id: tableC.id, code: 'C1-1', lx: 0, ly: 0, is_active: true, sort_order: 1 },
      { layout_id: testLayout.id, zone_id: zoneId, table_id: tableC.id, code: 'C1-2', lx: 0, ly: 0, is_active: true, sort_order: 2 }
    ]
  });

  // Setup test session
  const testSession = await prisma.session.upsert({
    where: {
      session_date_start_time: {
        session_date: dbDate,
        start_time: '14:00'
      }
    },
    update: { max_capacity: 10, end_time: '15:00' },
    create: {
      session_date: dbDate,
      start_time: '14:00',
      end_time: '15:00',
      max_capacity: 10
    }
  });

  const testRef1 = 'BK-R22-TEST-01';
  const testRef2 = 'BK-R22-TEST-02';
  const testRef3 = 'BK-R22-TEST-03';
  const testRef4 = 'BK-R22-TEST-04';
  const initialTimerStartedAt = new Date('2026-11-20T06:00:00Z');

  // Register cleanup in t.after
  t.after(async () => {
    await prisma.bookingPerson.deleteMany({ where: { booking_ref: { in: [testRef1, testRef2, testRef3, testRef4] } } });
    await prisma.reservation.deleteMany({ where: { booking_ref: { in: [testRef1, testRef2, testRef3, testRef4] } } });
    await prisma.session.deleteMany({ where: { id: testSession.id } });
    await prisma.seat.deleteMany({ where: { layout_id: testLayout.id } });
    await prisma.seatTable.deleteMany({ where: { layout_id: testLayout.id } });
    await prisma.seatZone.deleteMany({ where: { layout_id: testLayout.id } });
    await prisma.seatLayout.deleteMany({ where: { id: testLayout.id } });
    await prisma.user.deleteMany({ where: { line_user_id: 'test_user_round22' } });
  });

  // 1. 3 人換到有 4 個空位的桌子：成功，計時開始時間不變
  await t.test('1. 3 人換到有 4 個空位的桌子：成功，計時開始時間不變', async () => {
    // Create 3-person reservation sitting at Table A (A1-1, A1-2, A1-3)
    await prisma.reservation.create({
      data: {
        booking_ref: testRef1,
        session_id: testSession.id,
        user_id: testUser.id,
        pax: 3,
        status: 'confirmed',
        attendance: 'checked_in',
        checked_in_at: initialTimerStartedAt,
        assigned_seats: ['A1-1', 'A1-2', 'A1-3'],
        total_amount: 900,
        amount_received: 0,
        billing_status: 'unpaid'
      }
    });

    await prisma.bookingPerson.createMany({
      data: [
        { booking_ref: testRef1, person_no: 1, seat_code: 'A1-1', status: 'active', timer_started_at: initialTimerStartedAt },
        { booking_ref: testRef1, person_no: 2, seat_code: 'A1-2', status: 'active', timer_started_at: initialTimerStartedAt },
        { booking_ref: testRef1, person_no: 3, seat_code: 'A1-3', status: 'active', timer_started_at: initialTimerStartedAt }
      ]
    });

    // Move to Table B (has 4 empty seats)
    const { req, res } = createMockReqRes({
      params: { booking_ref: testRef1 },
      body: { to_table_id: tableB.id }
    });

    await moveGroup(req, res);
    assert.equal(res.getStatusCode(), 200);
    const data = res.getResponseData();
    assert.equal(data.success, true);
    assert.deepEqual(data.new_seats, ['B1-1', 'B1-2', 'B1-3']);

    // Check DB reservation assigned_seats
    const updatedRes = await prisma.reservation.findFirst({
      where: { booking_ref: testRef1 }
    });
    assert.deepEqual(updatedRes.assigned_seats, ['B1-1', 'B1-2', 'B1-3']);

    // Check BookingPersons have updated seat_code and timer_started_at is preserved
    const updatedPersons = await prisma.bookingPerson.findMany({
      where: { booking_ref: testRef1 },
      orderBy: { person_no: 'asc' }
    });
    assert.equal(updatedPersons.length, 3);
    assert.equal(updatedPersons[0].seat_code, 'B1-1');
    assert.equal(updatedPersons[1].seat_code, 'B1-2');
    assert.equal(updatedPersons[2].seat_code, 'B1-3');

    // Timer start time must NOT change (計時開始時間不變)
    assert.equal(updatedPersons[0].timer_started_at.getTime(), initialTimerStartedAt.getTime());
    assert.equal(updatedPersons[1].timer_started_at.getTime(), initialTimerStartedAt.getTime());
    assert.equal(updatedPersons[2].timer_started_at.getTime(), initialTimerStartedAt.getTime());
  });

  // 2. 目標桌只剩 2 個空位：回 422，原本的座位不變
  await t.test('2. 目標桌只剩 2 個空位：回 422，原本的座位不變', async () => {
    // Current seats are B1-1, B1-2, B1-3 (3 persons)
    // Table C only has 2 seats (C1-1, C1-2)
    const { req, res } = createMockReqRes({
      params: { booking_ref: testRef1 },
      body: { to_table_id: tableC.id }
    });

    await moveGroup(req, res);
    assert.equal(res.getStatusCode(), 422);
    const data = res.getResponseData();
    assert.equal(data.error, '這桌只剩 2 個空位');

    // Verify original seats and persons are untouched
    const resAfterFail = await prisma.reservation.findFirst({
      where: { booking_ref: testRef1 }
    });
    assert.deepEqual(resAfterFail.assigned_seats, ['B1-1', 'B1-2', 'B1-3']);

    const personsAfterFail = await prisma.bookingPerson.findMany({
      where: { booking_ref: testRef1 },
      orderBy: { person_no: 'asc' }
    });
    assert.equal(personsAfterFail[0].seat_code, 'B1-1');
    assert.equal(personsAfterFail[1].seat_code, 'B1-2');
    assert.equal(personsAfterFail[2].seat_code, 'B1-3');
  });

  // 3. 目標座位被別組坐了：不能算成空位
  await t.test('3. 目標座位被別組坐了：不能算成空位', async () => {
    // Table A has 4 seats total.
    // Seat another booking (testRef2) on A1-1 and A1-2.
    // So Table A only has 2 free seats left (A1-3, A1-4).
    await prisma.reservation.create({
      data: {
        booking_ref: testRef2,
        session_id: testSession.id,
        user_id: testUser.id,
        pax: 2,
        status: 'confirmed',
        attendance: 'checked_in',
        assigned_seats: ['A1-1', 'A1-2'],
        total_amount: 600,
        amount_received: 0,
        billing_status: 'unpaid'
      }
    });
    await prisma.bookingPerson.createMany({
      data: [
        { booking_ref: testRef2, person_no: 1, seat_code: 'A1-1', status: 'active' },
        { booking_ref: testRef2, person_no: 2, seat_code: 'A1-2', status: 'active' }
      ]
    });

    // Try to move testRef1 (3 persons) to Table A
    // Even though Table A has 4 physical seats, 2 are taken by testRef2.
    // Thus only 2 empty seats exist -> must return 422 '這桌只剩 2 個空位'
    const { req, res } = createMockReqRes({
      params: { booking_ref: testRef1 },
      body: { to_table_id: tableA.id }
    });

    await moveGroup(req, res);
    assert.equal(res.getStatusCode(), 422);
    const data = res.getResponseData();
    assert.equal(data.error, '這桌只剩 2 個空位');

    // Original seats for testRef1 remain untouched
    const resAfterConflict = await prisma.reservation.findFirst({
      where: { booking_ref: testRef1 }
    });
    assert.deepEqual(resAfterConflict.assigned_seats, ['B1-1', 'B1-2', 'B1-3']);
  });

  // 4. 團體中若有人已移除（status: 'removed'），換桌時只計算 active 人數
  await t.test('4. 團體中若有人已移除（status: removed），換桌時只計算 active 人數', async () => {
    // Mark person 3 as removed (now only 2 active persons in testRef1)
    await prisma.bookingPerson.update({
      where: { booking_ref_person_no: { booking_ref: testRef1, person_no: 3 } },
      data: { status: 'removed', seat_code: null }
    });
    await prisma.reservation.updateMany({
      where: { booking_ref: testRef1 },
      data: { assigned_seats: ['B1-1', 'B1-2'], pax: 2 }
    });

    // Move to Table C (which has 2 empty seats: C1-1, C1-2)
    // Previously Table C failed because countNeeded was 3, but now it is 2 -> should SUCCEED!
    const { req, res } = createMockReqRes({
      params: { booking_ref: testRef1 },
      body: { to_table_id: tableC.id }
    });

    await moveGroup(req, res);
    assert.equal(res.getStatusCode(), 200);
    const data = res.getResponseData();
    assert.equal(data.success, true);
    assert.deepEqual(data.new_seats, ['C1-1', 'C1-2']);

    const resOnC = await prisma.reservation.findFirst({
      where: { booking_ref: testRef1 }
    });
    assert.deepEqual(resOnC.assigned_seats, ['C1-1', 'C1-2']);

    // Clean up testRef2
    await prisma.bookingPerson.deleteMany({ where: { booking_ref: testRef2 } });
    await prisma.reservation.deleteMany({ where: { booking_ref: testRef2 } });
  });

  // 5. 目標桌 4 個座位，其中 2 個被未報到的訂單佔用（attendance: null）：2 人自動換桌時，排到另外 2 個空位
  await t.test('5. 目標桌有未報到訂單（attendance: null）佔用 2 個座位時，2 人自動換桌排到另外 2 個空位', async () => {
    // At this point, testRef1 (2 active persons) is at Table C (C1-1, C1-2).
    // Create an un-checked-in reservation (testRef3, attendance: null) occupying B1-1, B1-2 on Table B (4 seats total).
    await prisma.reservation.create({
      data: {
        booking_ref: testRef3,
        session_id: testSession.id,
        user_id: testUser.id,
        pax: 2,
        status: 'confirmed',
        attendance: null,
        assigned_seats: ['B1-1', 'B1-2'],
        total_amount: 600,
        amount_received: 0,
        billing_status: 'unpaid'
      }
    });

    const { req, res } = createMockReqRes({
      params: { booking_ref: testRef1 },
      body: { to_table_id: tableB.id }
    });

    await moveGroup(req, res);
    assert.equal(res.getStatusCode(), 200);
    const data = res.getResponseData();
    assert.equal(data.success, true);
    assert.deepEqual(data.new_seats, ['B1-3', 'B1-4']);

    const movedRes = await prisma.reservation.findFirst({ where: { booking_ref: testRef1 } });
    assert.deepEqual(movedRes.assigned_seats, ['B1-3', 'B1-4']);

    const activePersons = await prisma.bookingPerson.findMany({
      where: { booking_ref: testRef1, status: 'active' },
      orderBy: { person_no: 'asc' }
    });
    assert.deepEqual(activePersons.map(p => p.seat_code), ['B1-3', 'B1-4']);
  });

  // 6. 3 人自動換到同一桌（其中 2 個被未報到的訂單佔用）：回 422「這桌只剩 2 個空位」
  await t.test('6. 3 人自動換到有未報到訂單佔用 2 位的 4 人桌：回 422「這桌只剩 2 個空位」', async () => {
    // Create a 3-person checked-in group (testRef4) on Table A (A1-1, A1-2, A1-3)
    await prisma.reservation.create({
      data: {
        booking_ref: testRef4,
        session_id: testSession.id,
        user_id: testUser.id,
        pax: 3,
        status: 'confirmed',
        attendance: 'checked_in',
        checked_in_at: initialTimerStartedAt,
        assigned_seats: ['A1-1', 'A1-2', 'A1-3'],
        total_amount: 900,
        amount_received: 0,
        billing_status: 'unpaid'
      }
    });
    await prisma.bookingPerson.createMany({
      data: [
        { booking_ref: testRef4, person_no: 1, seat_code: 'A1-1', status: 'active', timer_started_at: initialTimerStartedAt },
        { booking_ref: testRef4, person_no: 2, seat_code: 'A1-2', status: 'active', timer_started_at: initialTimerStartedAt },
        { booking_ref: testRef4, person_no: 3, seat_code: 'A1-3', status: 'active', timer_started_at: initialTimerStartedAt }
      ]
    });

    // Move testRef1 back to Table C first or keep testRef1 on B? Wait: if testRef1 is on B (B1-3, B1-4), move testRef1 to C so B only has testRef3 (2 seats taken, 2 empty)
    await prisma.reservation.updateMany({ where: { booking_ref: testRef1 }, data: { assigned_seats: ['C1-1', 'C1-2'] } });
    await prisma.bookingPerson.updateMany({ where: { booking_ref: testRef1, person_no: 1 }, data: { seat_code: 'C1-1' } });
    await prisma.bookingPerson.updateMany({ where: { booking_ref: testRef1, person_no: 2 }, data: { seat_code: 'C1-2' } });

    const { req, res } = createMockReqRes({
      params: { booking_ref: testRef4 },
      body: { to_table_id: tableB.id }
    });

    await moveGroup(req, res);
    assert.equal(res.getStatusCode(), 422);
    const data = res.getResponseData();
    assert.equal(data.error, '這桌只剩 2 個空位');

    const res4 = await prisma.reservation.findFirst({ where: { booking_ref: testRef4 } });
    assert.deepEqual(res4.assigned_seats, ['A1-1', 'A1-2', 'A1-3']);
  });

  // 7. 帶 to_seats，其中有一個被未報到的訂單佔用：回 422，原本的座位不變
  await t.test('7. 帶 to_seats，其中一個座位被未報到訂單佔用：回 422 且原本座位不變', async () => {
    // testRef1 (2 active persons) is at C1-1, C1-2. testRef3 (attendance: null) is at B1-1, B1-2.
    // Request move to Table B specifying to_seats: ['B1-2', 'B1-3'] (B1-2 is occupied by un-checked-in testRef3)
    const { req, res } = createMockReqRes({
      params: { booking_ref: testRef1 },
      body: { to_table_id: tableB.id, to_seats: ['B1-2', 'B1-3'] }
    });

    await moveGroup(req, res);
    assert.equal(res.getStatusCode(), 422);
    const data = res.getResponseData();
    assert.ok(data.error.includes('B1-2'), `Expected error message to mention B1-2, got: ${data.error}`);

    // Verify original seats for testRef1 remain untouched (C1-1, C1-2)
    const res1 = await prisma.reservation.findFirst({ where: { booking_ref: testRef1 } });
    assert.deepEqual(res1.assigned_seats, ['C1-1', 'C1-2']);

    const persons1 = await prisma.bookingPerson.findMany({
      where: { booking_ref: testRef1, status: 'active' },
      orderBy: { person_no: 'asc' }
    });
    assert.deepEqual(persons1.map(p => p.seat_code), ['C1-1', 'C1-2']);
  });

  // 8. 帶合法的 to_seats（如 ['B1-3', 'B1-4']）：依照指定的座位換桌成功
  await t.test('8. 帶合法的 to_seats 時，照指定座位換桌成功且計時開始時間不變', async () => {
    const { req, res } = createMockReqRes({
      params: { booking_ref: testRef1 },
      body: { to_table_id: tableB.id, to_seats: ['B1-4', 'B1-3'] }
    });

    await moveGroup(req, res);
    assert.equal(res.getStatusCode(), 200);
    const data = res.getResponseData();
    assert.equal(data.success, true);
    assert.deepEqual(data.new_seats, ['B1-4', 'B1-3']);

    const persons1 = await prisma.bookingPerson.findMany({
      where: { booking_ref: testRef1, status: 'active' },
      orderBy: { person_no: 'asc' }
    });
    assert.deepEqual(persons1.map(p => p.seat_code), ['B1-4', 'B1-3']);
    assert.equal(persons1[0].timer_started_at.getTime(), initialTimerStartedAt.getTime());
    assert.equal(persons1[1].timer_started_at.getTime(), initialTimerStartedAt.getTime());
  });
});
