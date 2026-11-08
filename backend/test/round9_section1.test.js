import test from 'node:test';
import assert from 'node:assert/strict';
import prisma from '../src/prismaClient.js';
import { createReservation, getMyReservations } from '../src/controllers/reservationController.js';
import { modifyBookingEquipment } from '../src/controllers/equipmentController.js';
import { dateOnly } from '../../shared/time.js';

function createMockReqRes({ body = {}, params = {}, query = {}, user = { name: '測試客', id: 1 } }) {
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

test('Round 9 Section 1: Smart board consecutive rental of different sizes', async (t) => {
  const testDate = dateOnly('2026-11-26');

  const testUser = await prisma.user.upsert({
    where: { line_user_id: 'test_round9_user' },
    update: { name: '第九輪測試客', is_blacklisted: false },
    create: { line_user_id: 'test_round9_user', name: '第九輪測試客', phone: '0933000111', is_blacklisted: false }
  });

  // Ensure GlobalSetting has allow_equipment_exceed_pax = false
  await prisma.globalSetting.upsert({
    where: { id: 1 },
    update: { allow_equipment_exceed_pax: false, equipment_discount_enabled: true },
    create: { id: 1, allow_equipment_exceed_pax: false, equipment_discount_enabled: true }
  });

  // Ensure equipment configs exist
  await prisma.equipmentConfig.upsert({
    where: { id: 'small' },
    update: { name: '智能拼豆板（小板）', hourly_rate: 90, total_stock: 10, visibility_status: 'ACTIVE', min_contiguous_hours: 2 },
    create: { id: 'small', name: '智能拼豆板（小板）', hourly_rate: 90, total_stock: 10, visibility_status: 'ACTIVE', min_contiguous_hours: 2 }
  });
  await prisma.equipmentConfig.upsert({
    where: { id: 'medium' },
    update: { name: '智能拼豆板（中板）', hourly_rate: 120, total_stock: 10, visibility_status: 'ACTIVE', min_contiguous_hours: 2 },
    create: { id: 'medium', name: '智能拼豆板（中板）', hourly_rate: 120, total_stock: 10, visibility_status: 'ACTIVE', min_contiguous_hours: 2 }
  });

  // Create 8 consecutive sessions (13:00 to 21:00)
  const sessionHours = [
    { start: '13:00', end: '14:00' },
    { start: '14:00', end: '15:00' },
    { start: '15:00', end: '16:00' },
    { start: '16:00', end: '17:00' },
    { start: '17:00', end: '18:00' },
    { start: '18:00', end: '19:00' },
    { start: '19:00', end: '20:00' },
    { start: '20:00', end: '21:00' },
  ];
  const sessions = [];
  for (const sh of sessionHours) {
    const s = await prisma.session.upsert({
      where: { session_date_start_time: { session_date: testDate, start_time: sh.start } },
      update: { end_time: sh.end, max_capacity: 16 },
      create: { session_date: testDate, start_time: sh.start, end_time: sh.end, max_capacity: 16 }
    });
    sessions.push(s);
  }
  const sessionIds = sessions.map(s => s.id);

  // Helper to cleanup
  async function cleanup() {
    await prisma.payment.deleteMany({ where: { booking_ref: { startsWith: 'BK-' } } });
    await prisma.bookingEquipment.deleteMany({ where: { equipment_id: { in: ['small', 'medium'] } } });
    await prisma.bookingPerson.deleteMany({ where: { booking_ref: { startsWith: 'BK-' } } });
    await prisma.reservation.deleteMany({ where: { session_id: { in: sessionIds } } });
  }
  await cleanup();

  t.after(async () => {
    await cleanup();
    await prisma.session.deleteMany({ where: { id: { in: sessionIds } } });
    await prisma.user.deleteMany({ where: { id: testUser.id } });
  });

  await t.test('1. createReservation allows consecutive non-overlapping boards for 1 pax (total 2 boards > 1 pax)', async () => {
    const { req, res } = createMockReqRes({
      user: testUser,
      body: {
        session_ids: sessionIds,
        pax: 1,
        isUnlimited: true,
        equipments: [
          { equipment_id: 'small', quantity: 1, rental_hours: 4, start_time: '13:00' },
          { equipment_id: 'medium', quantity: 1, rental_hours: 4, start_time: '17:00' }
        ]
      }
    });

    await createReservation(req, res);
    assert.equal(res.getStatusCode(), 201, `Expected 201 Created but got ${res.getStatusCode()}: ${JSON.stringify(res.getResponseData())}`);
    const data = res.getResponseData();
    const bookingRef = data.reservation?.booking_ref || data.booking_ref;
    assert.ok(bookingRef, 'Must return booking_ref');

    // Verify booking equipments in DB
    const beList = await prisma.bookingEquipment.findMany({
      where: { booking_ref: bookingRef },
      orderBy: { created_at: 'asc' }
    });
    assert.equal(beList.length, 2, 'Should create 2 equipment records');
    assert.equal(beList[0].equipment_id, 'small');
    assert.equal(beList[0].rental_hours, 4);
    assert.deepEqual(beList[0].covered_sessions, ['13:00-14:00', '14:00-15:00', '15:00-16:00', '16:00-17:00']);

    assert.equal(beList[1].equipment_id, 'medium');
    assert.equal(beList[1].rental_hours, 4);
    assert.deepEqual(beList[1].covered_sessions, ['17:00-18:00', '18:00-19:00', '19:00-20:00', '20:00-21:00']);

    // Check getMyReservations preserves both equipment segments
    const { req: myReq, res: myRes } = createMockReqRes({ user: testUser });
    await getMyReservations(myReq, myRes);
    const myBookings = myRes.getResponseData();
    const myBooking = myBookings.find(b => b.booking_ref === bookingRef);
    assert.ok(myBooking, 'Should find my booking');
    assert.equal(myBooking.equipments.length, 2, 'Equipments should list both segments');

    await cleanup();
  });

  await t.test('2. createReservation rejects overlapping boards when concurrent boards > pax', async () => {
    const { req, res } = createMockReqRes({
      user: testUser,
      body: {
        session_ids: sessionIds,
        pax: 1,
        isUnlimited: true,
        equipments: [
          { equipment_id: 'small', quantity: 1, rental_hours: 4, start_time: '13:00' }, // 13:00 - 17:00
          { equipment_id: 'medium', quantity: 1, rental_hours: 4, start_time: '16:00' } // 16:00 - 20:00 (overlaps at 16:00-17:00)
        ]
      }
    });

    await createReservation(req, res);
    assert.equal(res.getStatusCode(), 400, 'Should reject overlapping boards exceeding pax');
    const data = res.getResponseData();
    assert.match(data.error || data.message || '', /預約時段內同時使用的智能板不能超過|EQUIPMENT_EXCEED_PAX|超過/);

    await cleanup();
  });

  await t.test('3. modifyBookingEquipment checks concurrent boards <= pax', async () => {
    // First create a 1-pax reservation with 1 board (13:00 - 17:00)
    const { req: cReq, res: cRes } = createMockReqRes({
      user: testUser,
      body: {
        session_ids: sessionIds,
        pax: 1,
        isUnlimited: true,
        equipments: [
          { equipment_id: 'small', quantity: 1, rental_hours: 4, start_time: '13:00' }
        ]
      }
    });
    await createReservation(cReq, cRes);
    const cData = cRes.getResponseData();
    const bookingRef = cData.reservation?.booking_ref || cData.booking_ref;

    // Modify to consecutive: small 13:00-17:00 and medium 17:00-21:00 -> should succeed
    const { req: mReq1, res: mRes1 } = createMockReqRes({
      user: testUser,
      params: { booking_ref: bookingRef },
      body: {
        equipments: [
          { equipment_id: 'small', quantity: 1, rental_hours: 4, start_time: '13:00' },
          { equipment_id: 'medium', quantity: 1, rental_hours: 4, start_time: '17:00' }
        ]
      }
    });
    await modifyBookingEquipment(mReq1, mRes1);
    assert.equal(mRes1.getStatusCode(), 200, `Expected 200 from modifyBookingEquipment: ${JSON.stringify(mRes1.getResponseData())}`);

    // Modify to overlapping: small 13:00-17:00 and medium 16:00-20:00 -> should fail with 400
    const { req: mReq2, res: mRes2 } = createMockReqRes({
      user: testUser,
      params: { booking_ref: bookingRef },
      body: {
        equipments: [
          { equipment_id: 'small', quantity: 1, rental_hours: 4, start_time: '13:00' },
          { equipment_id: 'medium', quantity: 1, rental_hours: 4, start_time: '16:00' }
        ]
      }
    });
    await modifyBookingEquipment(mReq2, mRes2);
    assert.equal(mRes2.getStatusCode(), 400, 'Should reject overlapping modification exceeding pax');

    await cleanup();
  });
});
