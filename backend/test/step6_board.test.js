import test from 'node:test';
import assert from 'node:assert/strict';
import prisma from '../src/prismaClient.js';
import { swapBoard, returnBoard } from '../src/controllers/floorController.js';
import { splitBoardUnits } from '../src/services/floor/liveService.js';
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

test('Step 6 Board Swap and Return Tests (Section 4.4)', async (t) => {
  // GlobalSetting ensure
  await prisma.globalSetting.upsert({
    where: { id: 1 },
    update: {
      weekday_hourly_price: 150,
      weekday_unlimited_price: 750,
      equipment_discount_enabled: true,
      equipment_discount_buy_hours: 3,
      equipment_discount_free_hours: 1,
      equipment_discount_stackable: true
    },
    create: {
      id: 1,
      weekday_hourly_price: 150,
      weekday_unlimited_price: 750,
      equipment_discount_enabled: true,
      equipment_discount_buy_hours: 3,
      equipment_discount_free_hours: 1,
      equipment_discount_stackable: true
    }
  });

  // Ensure equipment configs: Small (S) and Medium (M)
  await prisma.equipmentConfig.upsert({
    where: { id: 'pegboard_s' },
    update: { name: '小板', hourly_rate: 90, total_stock: 5, visibility_status: 'ACTIVE' },
    create: { id: 'pegboard_s', name: '小板', hourly_rate: 90, total_stock: 5, visibility_status: 'ACTIVE' }
  });

  await prisma.equipmentConfig.upsert({
    where: { id: 'pegboard_m' },
    update: { name: '中板', hourly_rate: 120, total_stock: 2, visibility_status: 'ACTIVE' },
    create: { id: 'pegboard_m', name: '中板', hourly_rate: 120, total_stock: 2, visibility_status: 'ACTIVE' }
  });

  const testUser = await prisma.user.upsert({
    where: { line_user_id: 'test_step6_user' },
    update: { name: '換板測試客' },
    create: { line_user_id: 'test_step6_user', name: '換板測試客', phone: '0966000001' }
  });

  const testDate = dateOnly('2026-11-06');

  // Create 4 sessions: 14:00, 15:00, 16:00, 17:00
  const sess14 = await prisma.session.upsert({
    where: { session_date_start_time: { session_date: testDate, start_time: '14:00' } },
    update: { end_time: '15:00', max_capacity: 16 },
    create: { session_date: testDate, start_time: '14:00', end_time: '15:00', max_capacity: 16 }
  });
  const sess15 = await prisma.session.upsert({
    where: { session_date_start_time: { session_date: testDate, start_time: '15:00' } },
    update: { end_time: '16:00', max_capacity: 16 },
    create: { session_date: testDate, start_time: '15:00', end_time: '16:00', max_capacity: 16 }
  });
  const sess16 = await prisma.session.upsert({
    where: { session_date_start_time: { session_date: testDate, start_time: '16:00' } },
    update: { end_time: '17:00', max_capacity: 16 },
    create: { session_date: testDate, start_time: '16:00', end_time: '17:00', max_capacity: 16 }
  });
  const sess17 = await prisma.session.upsert({
    where: { session_date_start_time: { session_date: testDate, start_time: '17:00' } },
    update: { end_time: '18:00', max_capacity: 16 },
    create: { session_date: testDate, start_time: '17:00', end_time: '18:00', max_capacity: 16 }
  });

  const sessionIds = [sess14.id, sess15.id, sess16.id, sess17.id];

  await t.test('4.4.1 splitBoardUnits sets planned_end_at to board unit own covered_sessions end', async () => {
    const bookingRef = 'BK-TEST-6-SPLIT';
    await prisma.bookingEquipment.deleteMany({ where: { booking_ref: bookingRef } });
    await prisma.reservation.deleteMany({ where: { booking_ref: bookingRef } });

    // Reservation covers all 4 sessions 14:00-18:00
    for (const sid of sessionIds) {
      await prisma.reservation.create({
        data: {
          booking_ref: bookingRef,
          user_id: testUser.id,
          session_id: sid,
          pax: 1,
          status: 'confirmed'
        }
      });
    }

    // Equipment only covers 2 sessions: sess14 and sess15 (ends at 16:00)
    await prisma.bookingEquipment.create({
      data: {
        booking_ref: bookingRef,
        equipment_id: 'pegboard_s',
        equipment_name_snapshot: '小板',
        quantity: 2, // Needs splitting
        rental_hours: 2,
        subtotal_price: 360,
        covered_sessions: [String(sess14.id), String(sess15.id)]
      }
    });

    await prisma.$transaction(async (tx) => {
      await splitBoardUnits(tx, bookingRef);
    });

    const units = await prisma.bookingEquipment.findMany({ where: { booking_ref: bookingRef } });
    assert.equal(units.length, 2);
    // Both units should have planned_end_at = 16:00 (end of sess15), not 18:00
    for (const u of units) {
      assert.ok(u.planned_end_at);
      const endHour = new Date(u.planned_end_at).getUTCHours();
      // 16:00 Taipei is 08:00 UTC
      assert.equal(endHour, 8, 'planned_end_at should be 16:00 Taipei (08:00 UTC)');
    }
  });

  await t.test('4.4.2 swapBoard: boundary 15:30, amount NT$345, covered_sessions updated, audit logged', async () => {
    await prisma.bookingEquipment.deleteMany({ where: { OR: [{ booking_ref: { startsWith: 'BK-TEST-6-' } }, { booking_ref: { startsWith: 'BK-OCCUPY-' } }] } });
    await prisma.reservation.deleteMany({ where: { OR: [{ booking_ref: { startsWith: 'BK-TEST-6-' } }, { booking_ref: { startsWith: 'BK-OCCUPY-' } }] } });

    const bookingRef = 'BK-TEST-6-SWAP';
    const unitGroup = 'UG-TEST-6-SWAP';

    for (const sid of sessionIds) {
      await prisma.reservation.create({
        data: {
          booking_ref: bookingRef,
          user_id: testUser.id,
          session_id: sid,
          pax: 1,
          status: 'confirmed',
          attendance: 'checked_in'
        }
      });
    }

    // Small board 14:00 to 18:00
    const start14 = new Date('2026-11-06T14:00:00+08:00');
    const end18 = new Date('2026-11-06T18:00:00+08:00');

    await prisma.bookingEquipment.create({
      data: {
        booking_ref: bookingRef,
        equipment_id: 'pegboard_s',
        equipment_name_snapshot: '小板',
        quantity: 1,
        rental_hours: 4,
        subtotal_price: 270,
        covered_sessions: sessionIds.map(String),
        unit_group: unitGroup,
        segment_no: 1,
        start_at: start14,
        unit_rate: 90,
        planned_end_at: end18
      }
    });

    // Swap to pegboard_m at 15:30
    const boundaryAt = new Date('2026-11-06T15:30:00+08:00').toISOString();
    const { req, res } = createMockReqRes({
      params: { booking_ref: bookingRef, unit_group: unitGroup },
      body: {
        to_equipment_id: 'pegboard_m',
        boundary_at: boundaryAt,
        now: '2026-11-06T15:40:00+08:00'
      }
    });

    await swapBoard(req, res);
    assert.equal(res.getStatusCode(), 200, `swapBoard failed: ${JSON.stringify(res.getResponseData())}`);

    // Check segments
    const segs = await prisma.bookingEquipment.findMany({
      where: { booking_ref: bookingRef, unit_group: unitGroup },
      orderBy: { segment_no: 'asc' }
    });
    assert.equal(segs.length, 2);

    // Segment 1 (Small): covers 14:00 and 15:00 sessions (up to 16:00). 16:00+ is released!
    assert.deepEqual(segs[0].covered_sessions, [String(sess14.id), String(sess15.id)]);
    assert.equal(segs[0].ended_reason, 'swapped');

    // Segment 2 (Medium): starts from 15:00 session to 17:00 session
    assert.deepEqual(segs[1].covered_sessions, [String(sess15.id), String(sess16.id), String(sess17.id)]);
    assert.equal(segs[1].equipment_id, 'pegboard_m');

    // Check bill calculation: 4 hours total, 1 hr free @ 90 -> gross 135+300=435 - 90 = 345!
    const bill = res.getResponseData().bill;
    assert.equal(bill.summary.board_total, 345, 'Board amount should be NT$345');

    // Check audit log
    const event = await prisma.accountingEvent.findFirst({
      where: { booking_ref: bookingRef, event_type: 'amount_adjusted' }
    });
    assert.ok(event);
    assert.match(event.summary, /換板 小板 → 中板/);
  });

  await t.test('4.4.3 swapBoard: rejects invalid boundary_at with 422', async () => {
    const bookingRef = 'BK-TEST-6-INVALID-BOUND';
    const unitGroup = 'UG-TEST-6-INVALID-BOUND';

    await prisma.bookingEquipment.deleteMany({ where: { booking_ref: bookingRef } });
    await prisma.reservation.deleteMany({ where: { booking_ref: bookingRef } });

    await prisma.reservation.create({
      data: {
        booking_ref: bookingRef,
        user_id: testUser.id,
        session_id: sess14.id,
        pax: 1,
        status: 'confirmed'
      }
    });

    await prisma.bookingEquipment.create({
      data: {
        booking_ref: bookingRef,
        equipment_id: 'pegboard_s',
        equipment_name_snapshot: '小板',
        quantity: 1,
        rental_hours: 1,
        subtotal_price: 90,
        covered_sessions: [String(sess14.id)],
        unit_group: unitGroup,
        segment_no: 1,
        start_at: new Date('2026-11-06T14:00:00+08:00'),
        unit_rate: 90
      }
    });

    // Provide arbitrary invalid boundary (e.g. 14:17)
    const { req, res } = createMockReqRes({
      params: { booking_ref: bookingRef, unit_group: unitGroup },
      body: {
        to_equipment_id: 'pegboard_m',
        boundary_at: '2026-11-06T14:17:00+08:00'
      }
    });

    await swapBoard(req, res);
    assert.equal(res.getStatusCode(), 422, 'Expected 422 for invalid boundary');
  });

  await t.test('4.4.4 swapBoard: returns 409 when new size is out of stock (剩 0 台)', async () => {
    const bookingRef = 'BK-TEST-6-OOS';
    const unitGroup = 'UG-TEST-6-OOS';

    await prisma.bookingEquipment.deleteMany({ where: { booking_ref: { in: [bookingRef, 'BK-OCCUPY-M'] } } });
    await prisma.reservation.deleteMany({ where: { booking_ref: { in: [bookingRef, 'BK-OCCUPY-M'] } } });

    for (const sid of sessionIds) {
      await prisma.reservation.create({
        data: {
          booking_ref: bookingRef,
          user_id: testUser.id,
          session_id: sid,
          pax: 1,
          status: 'confirmed'
        }
      });
      await prisma.reservation.create({
        data: {
          booking_ref: 'BK-OCCUPY-M',
          user_id: testUser.id,
          session_id: sid,
          pax: 2,
          status: 'confirmed'
        }
      });
    }

    // pegboard_m total_stock is 2. Occupy both in sess15
    await prisma.bookingEquipment.create({
      data: {
        booking_ref: 'BK-OCCUPY-M',
        equipment_id: 'pegboard_m',
        equipment_name_snapshot: '中板',
        quantity: 2,
        rental_hours: 4,
        subtotal_price: 960,
        covered_sessions: sessionIds.map(String)
      }
    });

    // Active board is small
    await prisma.bookingEquipment.create({
      data: {
        booking_ref: bookingRef,
        equipment_id: 'pegboard_s',
        equipment_name_snapshot: '小板',
        quantity: 1,
        rental_hours: 4,
        subtotal_price: 270,
        covered_sessions: sessionIds.map(String),
        unit_group: unitGroup,
        segment_no: 1,
        start_at: new Date('2026-11-06T14:00:00+08:00'),
        unit_rate: 90
      }
    });

    // Swap to pegboard_m at 15:30
    const { req, res } = createMockReqRes({
      params: { booking_ref: bookingRef, unit_group: unitGroup },
      body: {
        to_equipment_id: 'pegboard_m',
        boundary_at: '2026-11-06T15:30:00+08:00',
        now: '2026-11-06T15:40:00+08:00'
      }
    });

    await swapBoard(req, res);
    assert.equal(res.getStatusCode(), 409);
    assert.match(res.getResponseData().error, /中板剩 0 台/);
  });

  await t.test('4.4.5 returnBoard: removes subsequent sessions and logs audit event', async () => {
    const bookingRef = 'BK-TEST-6-RETURN';
    const unitGroup = 'UG-TEST-6-RETURN';

    await prisma.bookingEquipment.deleteMany({ where: { booking_ref: bookingRef } });
    await prisma.reservation.deleteMany({ where: { booking_ref: bookingRef } });

    for (const sid of sessionIds) {
      await prisma.reservation.create({
        data: {
          booking_ref: bookingRef,
          user_id: testUser.id,
          session_id: sid,
          pax: 1,
          status: 'confirmed'
        }
      });
    }

    await prisma.bookingEquipment.create({
      data: {
        booking_ref: bookingRef,
        equipment_id: 'pegboard_s',
        equipment_name_snapshot: '小板',
        quantity: 1,
        rental_hours: 4,
        subtotal_price: 270,
        covered_sessions: sessionIds.map(String),
        unit_group: unitGroup,
        segment_no: 1,
        start_at: new Date('2026-11-06T14:00:00+08:00'),
        unit_rate: 90,
        planned_end_at: new Date('2026-11-06T18:00:00+08:00')
      }
    });

    // Return at 15:15 (during sess15)
    const { req, res } = createMockReqRes({
      params: { booking_ref: bookingRef, unit_group: unitGroup },
      body: {
        at: '2026-11-06T15:15:00+08:00'
      }
    });

    await returnBoard(req, res);
    assert.equal(res.getStatusCode(), 200);

    const seg = await prisma.bookingEquipment.findFirst({
      where: { booking_ref: bookingRef, unit_group: unitGroup }
    });
    assert.equal(seg.ended_reason, 'returned');
    // Subsequent sessions (sess16 and sess17) should be removed!
    assert.deepEqual(seg.covered_sessions, [String(sess14.id), String(sess15.id)]);

    // Check audit log
    const event = await prisma.accountingEvent.findFirst({
      where: { booking_ref: bookingRef, event_type: 'amount_adjusted' }
    });
    assert.ok(event);
    assert.match(event.summary, /歸還 小板/);
  });

  t.after(async () => {
    await prisma.bookingEquipment.deleteMany({ where: { OR: [{ booking_ref: { startsWith: 'BK-TEST-6-' } }, { booking_ref: { startsWith: 'BK-OCCUPY-' } }] } });
    await prisma.reservation.deleteMany({ where: { OR: [{ booking_ref: { startsWith: 'BK-TEST-6-' } }, { booking_ref: { startsWith: 'BK-OCCUPY-' } }] } });
  });
});
