import test from 'node:test';
import assert from 'node:assert/strict';
import prisma from '../src/prismaClient.js';
import { createReservation } from '../src/controllers/reservationController.js';
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

test('Round 18 Item 3: Cannot add equipment for past hours during in-progress booking', async (t) => {
  const now = new Date();
  const taipeiDateStr = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(now);
  const curH = parseInt(
    new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Taipei', hour: 'numeric', hour12: false }).format(now),
    10
  );
  const testDate = dateOnly(taipeiDateStr);
  const runId = Math.random().toString(36).slice(2, 7);

  const testUser = await prisma.user.upsert({
    where: { line_user_id: `test_r18_user_${runId}` },
    update: { name: '第十八輪測試客', is_blacklisted: false },
    create: { line_user_id: `test_r18_user_${runId}`, name: '第十八輪測試客', phone: '0955000111', is_blacklisted: false }
  });

  // Ensure equipment configs exist
  await prisma.equipmentConfig.upsert({
    where: { id: 'small' },
    update: { name: '智能拼豆板（小板）', hourly_rate: 90, total_stock: 10, visibility_status: 'ACTIVE', min_contiguous_hours: 1 },
    create: { id: 'small', name: '智能拼豆板（小板）', hourly_rate: 90, total_stock: 10, visibility_status: 'ACTIVE', min_contiguous_hours: 1 }
  });

  // We set up sessions covering past hour and future hours
  // Let start hour be (curH - 1) and end be (curH + 3)
  const startH = Math.max(0, curH - 1);
  const endH = Math.min(24, curH + 3);

  const sessionIds = [];
  for (let h = startH; h < endH; h++) {
    const sStr = `${String(h).padStart(2, '0')}:00`;
    const eStr = `${String(h + 1).padStart(2, '0')}:00`;
    const sess = await prisma.session.upsert({
      where: {
        session_date_start_time: {
          session_date: testDate,
          start_time: sStr
        }
      },
      update: { max_capacity: 20 },
      create: {
        session_date: testDate,
        start_time: sStr,
        end_time: eStr,
        max_capacity: 20
      }
    });
    sessionIds.push(sess.id);
  }

  // Create a reservation for this user
  const { req: cReq, res: cRes } = createMockReqRes({
    user: testUser,
    body: {
      session_ids: sessionIds,
      pax: 2,
      isUnlimited: true,
      equipments: []
    }
  });
  await createReservation(cReq, cRes);
  const cData = cRes.getResponseData();
  const bookingRef = cData.reservation?.booking_ref || cData.booking_ref;
  assert.ok(bookingRef, 'Reservation created successfully');

  const cleanup = async () => {
    await prisma.bookingEquipment.deleteMany({ where: { booking_ref: bookingRef } }).catch(() => {});
    await prisma.bookingPerson.deleteMany({ where: { booking_ref: bookingRef } }).catch(() => {});
    await prisma.reservation.deleteMany({ where: { booking_ref: bookingRef } }).catch(() => {});
    await prisma.user.deleteMany({ where: { id: testUser.id } }).catch(() => {});
  };
  t.after(cleanup);

  if (startH < curH) {
    const pastHourStr = `${String(startH).padStart(2, '0')}:00`;
    await t.test('Attempting to add board starting before current hour returns 422', async () => {
      const { req, res } = createMockReqRes({
        user: testUser,
        params: { booking_ref: bookingRef },
        body: {
          equipments: [
            { equipment_id: 'small', quantity: 1, rental_hours: 2, start_time: pastHourStr }
          ]
        }
      });
      await modifyBookingEquipment(req, res);
      assert.equal(res.getStatusCode(), 422, 'Should reject past start time with 422');
      const data = res.getResponseData();
      assert.equal(data.error, '已經過去的時段不能加租');
    });
  }

  const currentHourStr = `${String(curH).padStart(2, '0')}:00`;
  await t.test('Adding board starting at current hour or later does not return 422', async () => {
    const { req, res } = createMockReqRes({
      user: testUser,
      params: { booking_ref: bookingRef },
      body: {
        equipments: [
          { equipment_id: 'small', quantity: 1, rental_hours: Math.max(1, endH - curH), start_time: currentHourStr }
        ]
      }
    });
    await modifyBookingEquipment(req, res);
    assert.notEqual(res.getStatusCode(), 422, 'Should not return 422 for current/future hour');
  });
});
