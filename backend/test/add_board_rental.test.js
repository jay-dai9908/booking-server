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

test('Item 3: addBoardRental stock verification scoped to date', async (t) => {
  const testEqId = 'pegboard_s_test_stock';
  await prisma.equipmentConfig.upsert({
    where: { id: testEqId },
    update: { name: '小板測試', hourly_rate: 90, total_stock: 1, visibility_status: 'ACTIVE' },
    create: { id: testEqId, name: '小板測試', hourly_rate: 90, total_stock: 1, visibility_status: 'ACTIVE' }
  });

  const testUser = await prisma.user.upsert({
    where: { line_user_id: 'test_item3_user' },
    update: { name: '加租測試客' },
    create: { line_user_id: 'test_item3_user', name: '加租測試客', phone: '0977000001' }
  });

  const tomorrowDate = dateOnly('2026-11-20');
  const dayAfterDate = dateOnly('2026-11-21');

  // Create sessions for tomorrow
  const sessTomorrow1 = await prisma.session.upsert({
    where: { session_date_start_time: { session_date: tomorrowDate, start_time: '13:00' } },
    update: { end_time: '14:00', max_capacity: 16 },
    create: { session_date: tomorrowDate, start_time: '13:00', end_time: '14:00', max_capacity: 16 }
  });
  const sessTomorrow2 = await prisma.session.upsert({
    where: { session_date_start_time: { session_date: tomorrowDate, start_time: '14:00' } },
    update: { end_time: '15:00', max_capacity: 16 },
    create: { session_date: tomorrowDate, start_time: '14:00', end_time: '15:00', max_capacity: 16 }
  });

  // Create sessions for day after tomorrow
  const sessDayAfter1 = await prisma.session.upsert({
    where: { session_date_start_time: { session_date: dayAfterDate, start_time: '13:00' } },
    update: { end_time: '14:00', max_capacity: 16 },
    create: { session_date: dayAfterDate, start_time: '13:00', end_time: '14:00', max_capacity: 16 }
  });
  const sessDayAfter2 = await prisma.session.upsert({
    where: { session_date_start_time: { session_date: dayAfterDate, start_time: '14:00' } },
    update: { end_time: '15:00', max_capacity: 16 },
    create: { session_date: dayAfterDate, start_time: '14:00', end_time: '15:00', max_capacity: 16 }
  });

  const bookingTomorrow1 = 'BK-TEST-BOARD-T1';
  const bookingTomorrow2 = 'BK-TEST-BOARD-T2';
  const bookingDayAfter = 'BK-TEST-BOARD-DA';

  // Clean up any previous test data
  await prisma.bookingEquipment.deleteMany({
    where: { booking_ref: { in: [bookingTomorrow1, bookingTomorrow2, bookingDayAfter] } }
  });
  await prisma.bookingPerson.deleteMany({
    where: { booking_ref: { in: [bookingTomorrow1, bookingTomorrow2, bookingDayAfter] } }
  });
  await prisma.reservation.deleteMany({
    where: { booking_ref: { in: [bookingTomorrow1, bookingTomorrow2, bookingDayAfter] } }
  });

  // Helper to create booking with 2 sessions (13:00-15:00)
  async function createBooking(ref, s1, s2) {
    await prisma.reservation.create({
      data: { booking_ref: ref, user_id: testUser.id, session_id: s1.id, pax: 1, status: 'confirmed' }
    });
    await prisma.reservation.create({
      data: { booking_ref: ref, user_id: testUser.id, session_id: s2.id, pax: 1, status: 'confirmed' }
    });
    await prisma.bookingPerson.create({
      data: { booking_ref: ref, person_no: 1, status: 'active' }
    });
  }

  await createBooking(bookingTomorrow1, sessTomorrow1, sessTomorrow2);
  await createBooking(bookingTomorrow2, sessTomorrow1, sessTomorrow2);
  await createBooking(bookingDayAfter, sessDayAfter1, sessDayAfter2);

  // 1. BookingTomorrow1 rents the only 1 unit of testEqId
  {
    const { req, res } = createMockReqRes({
      params: { booking_ref: bookingTomorrow1 },
      body: {
        person_no: 1,
        equipment_id: testEqId,
        from_at: '13:00',
        to_at: '15:00'
      }
    });
    await addBoardRental(req, res);
    assert.equal(res.getStatusCode(), 200, '明天第一筆租借小板應成功 (200)');
    assert.equal(res.getResponseData()?.success, true);
  }

  // 2. BookingTomorrow2 rents testEqId at same time -> should fail 409
  {
    const { req, res } = createMockReqRes({
      params: { booking_ref: bookingTomorrow2 },
      body: {
        person_no: 1,
        equipment_id: testEqId,
        from_at: '13:00',
        to_at: '15:00'
      }
    });
    await addBoardRental(req, res);
    assert.equal(res.getStatusCode(), 409, '明天第二筆同時段租借小板應回 409 庫存不足');
    assert.equal(res.getResponseData()?.code, 'BOARD_OUT_OF_STOCK');
  }

  // 3. BookingDayAfter rents testEqId on day after tomorrow at same time -> should succeed 200
  {
    const { req, res } = createMockReqRes({
      params: { booking_ref: bookingDayAfter },
      body: {
        person_no: 1,
        equipment_id: testEqId,
        from_at: '13:00',
        to_at: '15:00'
      }
    });
    await addBoardRental(req, res);
    assert.equal(res.getStatusCode(), 200, '後天同一時段租借小板應成功 (200)');
    assert.equal(res.getResponseData()?.success, true);
  }

  // 4. BookingTomorrow1 has rental with null covered_sessions but start_at/end_at set -> BookingTomorrow2 still gets 409
  {
    await prisma.bookingEquipment.updateMany({
      where: { booking_ref: bookingTomorrow1 },
      data: { covered_sessions: [] }
    });
    const { req, res } = createMockReqRes({
      params: { booking_ref: bookingTomorrow2 },
      body: {
        person_no: 1,
        equipment_id: testEqId,
        from_at: '13:00',
        to_at: '15:00'
      }
    });
    await addBoardRental(req, res);
    assert.equal(res.getStatusCode(), 409, '無 covered_sessions 但時間重疊時仍應回 409');
    assert.equal(res.getResponseData()?.code, 'BOARD_OUT_OF_STOCK');
  }

  // Cleanup
  await prisma.bookingEquipment.deleteMany({
    where: { booking_ref: { in: [bookingTomorrow1, bookingTomorrow2, bookingDayAfter] } }
  });
  await prisma.bookingPerson.deleteMany({
    where: { booking_ref: { in: [bookingTomorrow1, bookingTomorrow2, bookingDayAfter] } }
  });
  await prisma.reservation.deleteMany({
    where: { booking_ref: { in: [bookingTomorrow1, bookingTomorrow2, bookingDayAfter] } }
  });
  await prisma.equipmentConfig.delete({ where: { id: testEqId } });
});
