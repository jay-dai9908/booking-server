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
  await prisma.accountingEvent.deleteMany({ where: { booking_ref: bookingRef } });
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

  } finally {
    // Cleanup
    await prisma.accountingEvent.deleteMany({ where: { booking_ref: bookingRef } }).catch(() => {});
    await prisma.bookingEquipment.deleteMany({ where: { booking_ref: bookingRef } }).catch(() => {});
    await prisma.bookingPerson.deleteMany({ where: { booking_ref: bookingRef } }).catch(() => {});
    await prisma.reservation.deleteMany({ where: { booking_ref: bookingRef } }).catch(() => {});
    await prisma.session.deleteMany({ where: { session_date: testDate } }).catch(() => {});
  }
});
