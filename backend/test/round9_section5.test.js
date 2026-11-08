import test from 'node:test';
import assert from 'node:assert/strict';
import prisma from '../src/prismaClient.js';
import { addBoardRental } from '../src/controllers/floorController.js';
import { dateOnly } from '../../shared/time.js';

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

test('Round 9 Section 5: POST /floor/:ref/boards validation and creation', async (t) => {
  const testDate = dateOnly('2026-11-28');
  const bookingRef = 'BK-TEST-SEC5-001';

  // 1. Setup user
  const user = await prisma.user.upsert({
    where: { line_user_id: 'test_sec5_user' },
    update: { name: '計時測試員' },
    create: { line_user_id: 'test_sec5_user', name: '計時測試員', phone: '0955111222' }
  });

  // 2. Setup equipment configs with stock
  // 'medium' has stock = 1 (to easily test out of stock)
  await prisma.equipmentConfig.upsert({
    where: { id: 'medium' },
    update: { name: '智能拼豆板（中板）', hourly_rate: 120, total_stock: 1, visibility_status: 'ACTIVE' },
    create: { id: 'medium', name: '智能拼豆板（中板）', hourly_rate: 120, total_stock: 1, visibility_status: 'ACTIVE' }
  });
  await prisma.equipmentConfig.upsert({
    where: { id: 'small' },
    update: { name: '智能拼豆板（小板）', hourly_rate: 90, total_stock: 5, visibility_status: 'ACTIVE' },
    create: { id: 'small', name: '智能拼豆板（小板）', hourly_rate: 90, total_stock: 5, visibility_status: 'ACTIVE' }
  });

  // 3. Setup sessions: 13:00-14:00, 14:00-15:00
  const s1 = await prisma.session.upsert({
    where: { session_date_start_time: { session_date: testDate, start_time: '13:00' } },
    update: { end_time: '14:00', max_capacity: 10 },
    create: { session_date: testDate, start_time: '13:00', end_time: '14:00', max_capacity: 10 }
  });
  const s2 = await prisma.session.upsert({
    where: { session_date_start_time: { session_date: testDate, start_time: '14:00' } },
    update: { end_time: '15:00', max_capacity: 10 },
    create: { session_date: testDate, start_time: '14:00', end_time: '15:00', max_capacity: 10 }
  });

  // 4. Create test reservation and booking persons
  await prisma.bookingEquipment.deleteMany({ where: { booking_ref: bookingRef } });
  await prisma.bookingPerson.deleteMany({ where: { booking_ref: bookingRef } });
  await prisma.reservation.deleteMany({ where: { booking_ref: bookingRef } });

  const res1 = await prisma.reservation.create({
    data: {
      booking_ref: bookingRef,
      session: { connect: { id: s1.id } },
      user: { connect: { id: user.id } },
      pax: 2,
      status: 'confirmed',
      assigned_seats: ['A1-1', 'A1-2']
    }
  });
  const res2 = await prisma.reservation.create({
    data: {
      booking_ref: bookingRef,
      session: { connect: { id: s2.id } },
      user: { connect: { id: user.id } },
      pax: 2,
      status: 'confirmed',
      assigned_seats: ['A1-1', 'A1-2']
    }
  });

  const p1 = await prisma.bookingPerson.create({
    data: {
      booking_ref: bookingRef,
      person_no: 1,
      seat_code: 'A1-1',
      status: 'active'
    }
  });
  const p2 = await prisma.bookingPerson.create({
    data: {
      booking_ref: bookingRef,
      person_no: 2,
      seat_code: 'A1-2',
      status: 'active'
    }
  });

  try {
    // -------------------------------------------------------------
    // Test 1: Rent board successfully for person 1
    // -------------------------------------------------------------
    const { req: req1, res: res1Res } = createMockReqRes({
      params: { booking_ref: bookingRef },
      body: {
        person_no: 1,
        equipment_id: 'medium',
        from_at: '13:00',
        to_at: '15:00'
      }
    });

    await addBoardRental(req1, res1Res);
    assert.strictEqual(res1Res.getStatusCode(), 200);
    const data1 = res1Res.getResponseData();
    assert.strictEqual(data1.success, true);
    assert.strictEqual(data1.booking_equipment.person_id, p1.id);
    assert.strictEqual(data1.booking_equipment.equipment_id, 'medium');
    assert.ok(data1.booking_equipment.unit_group, 'Must generate new unit_group');

    // -------------------------------------------------------------
    // Test 2: Overlapping interval for the SAME person -> returns 409
    // -------------------------------------------------------------
    const { req: req2, res: res2Res } = createMockReqRes({
      params: { booking_ref: bookingRef },
      body: {
        person_no: 1,
        equipment_id: 'small',
        from_at: '14:00',
        to_at: '15:00'
      }
    });

    await addBoardRental(req2, res2Res);
    assert.strictEqual(res2Res.getStatusCode(), 409);
    assert.match(res2Res.getResponseData().error, /不可同時租借兩台/);

    // -------------------------------------------------------------
    // Test 3: Out of stock (medium total_stock=1, already in use by person 1 in 13:00-15:00)
    // Person 2 tries to rent medium in overlapping session -> returns 409
    // -------------------------------------------------------------
    const { req: req3, res: res3Res } = createMockReqRes({
      params: { booking_ref: bookingRef },
      body: {
        person_no: 2,
        equipment_id: 'medium',
        from_at: '13:00',
        to_at: '14:00'
      }
    });

    await addBoardRental(req3, res3Res);
    assert.strictEqual(res3Res.getStatusCode(), 409);
    assert.match(res3Res.getResponseData().error, /庫存不足/);

    // -------------------------------------------------------------
    // Test 4: Person 2 rents 'small' (available stock) -> succeeds
    // -------------------------------------------------------------
    const { req: req4, res: res4Res } = createMockReqRes({
      params: { booking_ref: bookingRef },
      body: {
        person_no: 2,
        equipment_id: 'small',
        from_at: '13:00',
        to_at: '15:00'
      }
    });

    await addBoardRental(req4, res4Res);
    assert.strictEqual(res4Res.getStatusCode(), 200);
    assert.strictEqual(res4Res.getResponseData().success, true);
    // Verify covered_sessions contains time ranges (e.g. "13:00-14:00") rather than plain session IDs
    const createdEq = res4Res.getResponseData().booking_equipment;
    assert.ok(Array.isArray(createdEq.covered_sessions));
    assert.ok(createdEq.covered_sessions.every(s => s.includes('-')), `covered_sessions must be time ranges like 13:00-14:00, got: ${JSON.stringify(createdEq.covered_sessions)}`);

    // -------------------------------------------------------------
    // Test 5: Out of stock check against online-booked equipment
    // (covered_sessions = ["13:00-14:00"], format from online booking)
    // -------------------------------------------------------------
    const otherRef = 'BK-TEST-SEC5-ONLINE';
    await prisma.bookingEquipment.deleteMany({ where: { booking_ref: otherRef } });
    await prisma.reservation.deleteMany({ where: { booking_ref: otherRef } });

    await prisma.reservation.create({
      data: {
        booking_ref: otherRef,
        session: { connect: { id: s1.id } },
        user: { connect: { id: user.id } },
        pax: 1,
        status: 'confirmed',
        assigned_seats: ['B1-1']
      }
    });

    // Medium board total_stock is 1, let's create a booking with covered_sessions: ["13:00-14:00"]
    await prisma.bookingEquipment.create({
      data: {
        booking_ref: otherRef,
        equipment_id: 'medium',
        equipment_name_snapshot: '智能拼豆板（中板）',
        quantity: 1,
        rental_hours: 1,
        subtotal_price: 120,
        covered_sessions: ['13:00-14:00']
      }
    });

    // Clean up previous rental by person 1 for clean check
    await prisma.bookingEquipment.deleteMany({ where: { booking_ref: bookingRef, equipment_id: 'medium' } });

    const { req: req5, res: res5Res } = createMockReqRes({
      params: { booking_ref: bookingRef },
      body: {
        person_no: 1,
        equipment_id: 'medium',
        from_at: '13:00',
        to_at: '14:00'
      }
    });

    await addBoardRental(req5, res5Res);
    assert.strictEqual(res5Res.getStatusCode(), 409, 'Must return 409 when online booking occupied the only medium board in stock');
    assert.match(res5Res.getResponseData().error, /庫存不足/);

    await prisma.bookingEquipment.deleteMany({ where: { booking_ref: otherRef } });
    await prisma.reservation.deleteMany({ where: { booking_ref: otherRef } });

    // -------------------------------------------------------------
    // Test 6: Overnight booking spanning past midnight (23:00 to 01:00)
    // -------------------------------------------------------------
    const sNight1 = await prisma.session.upsert({
      where: { session_date_start_time: { session_date: testDate, start_time: '23:00' } },
      update: { end_time: '00:00', max_capacity: 10 },
      create: { session_date: testDate, start_time: '23:00', end_time: '00:00', max_capacity: 10 }
    });
    const sNight2 = await prisma.session.upsert({
      where: { session_date_start_time: { session_date: testDate, start_time: '00:00' } },
      update: { end_time: '01:00', max_capacity: 10 },
      create: { session_date: testDate, start_time: '00:00', end_time: '01:00', max_capacity: 10 }
    });

    const overnightRef = 'BK-TEST-SEC5-OVERNIGHT';
    await prisma.bookingEquipment.deleteMany({ where: { booking_ref: overnightRef } });
    await prisma.bookingPerson.deleteMany({ where: { booking_ref: overnightRef } });
    await prisma.reservation.deleteMany({ where: { booking_ref: overnightRef } });

    await prisma.reservation.create({
      data: {
        booking_ref: overnightRef,
        session: { connect: { id: sNight1.id } },
        user: { connect: { id: user.id } },
        pax: 1,
        status: 'confirmed',
        assigned_seats: ['C1-1']
      }
    });
    await prisma.reservation.create({
      data: {
        booking_ref: overnightRef,
        session: { connect: { id: sNight2.id } },
        user: { connect: { id: user.id } },
        pax: 1,
        status: 'confirmed',
        assigned_seats: ['C1-1']
      }
    });
    await prisma.bookingPerson.create({
      data: {
        booking_ref: overnightRef,
        person_no: 1,
        seat_code: 'C1-1',
        status: 'active'
      }
    });

    const { req: req6, res: res6Res } = createMockReqRes({
      params: { booking_ref: overnightRef },
      body: {
        person_no: 1,
        equipment_id: 'small',
        from_at: '23:00',
        to_at: '01:00'
      }
    });

    await addBoardRental(req6, res6Res);
    assert.strictEqual(res6Res.getStatusCode(), 200, `Expected 200 for overnight rental, got: ${res6Res.getStatusCode()} ${JSON.stringify(res6Res.getResponseData())}`);
    const overnightEq = res6Res.getResponseData().booking_equipment;
    assert.strictEqual(overnightEq.rental_hours, 2);
    assert.strictEqual(overnightEq.subtotal_price, 180);

    await prisma.bookingEquipment.deleteMany({ where: { booking_ref: overnightRef } });
    await prisma.bookingPerson.deleteMany({ where: { booking_ref: overnightRef } });
    await prisma.reservation.deleteMany({ where: { booking_ref: overnightRef } });

  } finally {
    // Cleanup
    await prisma.accountingEvent.deleteMany({ where: { booking_ref: { in: [bookingRef, 'BK-TEST-SEC5-ONLINE', 'BK-TEST-SEC5-OVERNIGHT'] } } }).catch(() => {});
    await prisma.bookingEquipment.deleteMany({ where: { booking_ref: { in: [bookingRef, 'BK-TEST-SEC5-ONLINE', 'BK-TEST-SEC5-OVERNIGHT'] } } }).catch(() => {});
    await prisma.bookingPerson.deleteMany({ where: { booking_ref: { in: [bookingRef, 'BK-TEST-SEC5-ONLINE', 'BK-TEST-SEC5-OVERNIGHT'] } } }).catch(() => {});
    await prisma.reservation.deleteMany({ where: { booking_ref: { in: [bookingRef, 'BK-TEST-SEC5-ONLINE', 'BK-TEST-SEC5-OVERNIGHT'] } } }).catch(() => {});
    await prisma.session.deleteMany({ where: { session_date: testDate } }).catch(() => {});
  }
});
