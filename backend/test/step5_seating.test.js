import test from 'node:test';
import assert from 'node:assert/strict';
import prisma from '../src/prismaClient.js';
import { checkIn, moveSeat, addPerson } from '../src/controllers/floorController.js';
import { previewPublish, publishLayout, createLayoutDraft } from '../src/controllers/seatLayoutController.js';
import { createBulkSessions } from '../src/controllers/sessionController.js';
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

test('Step 5 Seating Tests (Sections 4.1 - 4.3)', async (t) => {
  // Ensure global settings
  await prisma.globalSetting.upsert({
    where: { id: 1 },
    update: {
      seat_layout_enabled: true,
      weekday_hourly_price: 150,
      weekday_unlimited_price: 750
    },
    create: {
      id: 1,
      seat_layout_enabled: true,
      weekday_hourly_price: 150,
      weekday_unlimited_price: 750
    }
  });

  const testUserA = await prisma.user.upsert({
    where: { line_user_id: 'test_step5_user_a' },
    update: { name: '預約客A' },
    create: { line_user_id: 'test_step5_user_a', name: '預約客A', phone: '0911000001' }
  });

  const testUserB = await prisma.user.upsert({
    where: { line_user_id: 'test_step5_user_b' },
    update: { name: '現場客B' },
    create: { line_user_id: 'test_step5_user_b', name: '現場客B', phone: '0911000002' }
  });

  const testDate = dateOnly('2026-11-20');

  // Set up 2 consecutive sessions: 14:00-15:00 and 15:00-16:00
  const session1 = await prisma.session.upsert({
    where: { session_date_start_time: { session_date: testDate, start_time: '14:00' } },
    update: { end_time: '15:00', max_capacity: 16 },
    create: { session_date: testDate, start_time: '14:00', end_time: '15:00', max_capacity: 16 }
  });

  const session2 = await prisma.session.upsert({
    where: { session_date_start_time: { session_date: testDate, start_time: '15:00' } },
    update: { end_time: '16:00', max_capacity: 16 },
    create: { session_date: testDate, start_time: '15:00', end_time: '16:00', max_capacity: 16 }
  });

  await t.test('4.1 Check-in selecting a later booking seat reseats later booking across all sessions', async () => {
    const bookingLater = 'BK-TEST-5-LATER';
    const bookingCheckin = 'BK-TEST-5-CHECKIN';

    // Cleanup
    await prisma.bookingPerson.deleteMany({ where: { booking_ref: { in: [bookingLater, bookingCheckin] } } });
    await prisma.reservation.deleteMany({ where: { booking_ref: { in: [bookingLater, bookingCheckin] } } });

    // Later booking for User A: multi-session (session 1 and session 2) on seat A1-1
    await prisma.reservation.create({
      data: {
        booking_ref: bookingLater,
        user_id: testUserA.id,
        session_id: session1.id,
        pax: 1,
        status: 'confirmed',
        attendance: 'confirmed',
        is_seat_locked: false,
        seat_source: 'auto',
        assigned_seats: ['A1-1'],
        total_amount: 300
      }
    });
    await prisma.reservation.create({
      data: {
        booking_ref: bookingLater,
        user_id: testUserA.id,
        session_id: session2.id,
        pax: 1,
        status: 'confirmed',
        attendance: 'confirmed',
        is_seat_locked: false,
        seat_source: 'auto',
        assigned_seats: ['A1-1'],
        total_amount: 300
      }
    });

    // Checkin booking for User B: at session 1, wanting seat A1-1
    await prisma.reservation.create({
      data: {
        booking_ref: bookingCheckin,
        user_id: testUserB.id,
        session_id: session1.id,
        pax: 1,
        status: 'confirmed',
        attendance: 'confirmed',
        is_seat_locked: false,
        seat_source: 'auto',
        assigned_seats: ['WAIT-1'],
        total_amount: 150
      }
    });

    const { req, res } = createMockReqRes({
      params: { booking_ref: bookingCheckin },
      body: {
        seats: ['A1-1'],
        start_timer: true
      }
    });

    await checkIn(req, res);
    assert.equal(res.getStatusCode(), 200, `Expected 200 but got ${res.getStatusCode()}: ${JSON.stringify(res.getResponseData())}`);

    const resData = res.getResponseData();
    assert.equal(resData.displaced?.length, 1, 'Expected later booking to be displaced');
    assert.equal(resData.displaced[0].booking_ref, bookingLater);

    // Verify later booking was reseated consistently across session 1 AND session 2
    const laterResvs = await prisma.reservation.findMany({
      where: { booking_ref: bookingLater },
      orderBy: { session: { start_time: 'asc' } }
    });
    assert.equal(laterResvs.length, 2);
    const newSeat = laterResvs[0].assigned_seats[0];
    assert.notEqual(newSeat, 'A1-1', 'Later booking must no longer be on A1-1');
    assert.deepEqual(laterResvs[1].assigned_seats, [newSeat], 'Later booking must have consistent seats across all sessions');

    // Verify check-in booking got A1-1
    const checkinRes = await prisma.reservation.findFirst({
      where: { booking_ref: bookingCheckin }
    });
    assert.deepEqual(checkinRes.assigned_seats, ['A1-1']);
    assert.equal(checkinRes.attendance, 'checked_in');

    // Verify SQL collision check is 0
    const collisions = await prisma.$queryRaw`
      select session_id, seat, count(distinct booking_ref) as cnt
      from "Reservation", unnest(assigned_seats) seat
      where status <> 'cancelled' and seat not like 'WAIT-%'
        and booking_ref in (${bookingLater}, ${bookingCheckin})
      group by 1, 2 having count(distinct booking_ref) > 1
    `;
    assert.equal(collisions.length, 0, 'No seats can have duplicate bookings in the same session');
  });

  await t.test('4.1 Full capacity conflict check returns 409 and keeps DB unchanged', async () => {
    const bookingBlocked = 'BK-TEST-5-BLOCKED';
    const bookingAttempt = 'BK-TEST-5-ATTEMPT';

    await prisma.bookingPerson.deleteMany({ where: { booking_ref: { startsWith: 'BK-TEST-5-' } } });
    await prisma.reservation.deleteMany({ where: { booking_ref: { startsWith: 'BK-TEST-5-' } } });

    // Blocked reservation is checked_in or seat_locked
    await prisma.reservation.create({
      data: {
        booking_ref: bookingBlocked,
        user_id: testUserA.id,
        session_id: session1.id,
        pax: 1,
        status: 'confirmed',
        attendance: 'checked_in',
        is_seat_locked: true,
        seat_source: 'staff',
        assigned_seats: ['B1-1'],
        total_amount: 150
      }
    });

    await prisma.reservation.create({
      data: {
        booking_ref: bookingAttempt,
        user_id: testUserB.id,
        session_id: session1.id,
        pax: 1,
        status: 'confirmed',
        attendance: 'confirmed',
        is_seat_locked: false,
        seat_source: 'auto',
        assigned_seats: ['WAIT-1'],
        total_amount: 150
      }
    });

    const { req, res } = createMockReqRes({
      params: { booking_ref: bookingAttempt },
      body: {
        seats: ['B1-1'],
        start_timer: true
      }
    });

    await checkIn(req, res);
    assert.equal(res.getStatusCode(), 409, 'Expected 409 on locked seat collision');
    assert.equal(res.getResponseData().code, 'SEAT_CONFLICT');

    // Verify bookingAttempt remains untouched
    const attemptRes = await prisma.reservation.findFirst({
      where: { booking_ref: bookingAttempt }
    });
    assert.deepEqual(attemptRes.assigned_seats, ['WAIT-1']);
    assert.equal(attemptRes.attendance, 'confirmed');
  });

  await t.test('4.2 moveSeat swap mode swaps seats and syncs BookingPerson.seat_code', async () => {
    const bookingSwapA = 'BK-TEST-5-SWAP-A';
    const bookingSwapB = 'BK-TEST-5-SWAP-B';

    await prisma.bookingPerson.deleteMany({ where: { booking_ref: { startsWith: 'BK-TEST-5-' } } });
    await prisma.reservation.deleteMany({ where: { booking_ref: { startsWith: 'BK-TEST-5-' } } });

    // A has 2 pax: A1-1 and A1-2 in session 1
    await prisma.reservation.create({
      data: {
        booking_ref: bookingSwapA,
        user_id: testUserA.id,
        session_id: session1.id,
        pax: 2,
        status: 'confirmed',
        attendance: 'checked_in',
        is_seat_locked: true,
        seat_source: 'staff',
        assigned_seats: ['A1-1', 'A1-2'],
        total_amount: 300
      }
    });
    await prisma.bookingPerson.createMany({
      data: [
        { booking_ref: bookingSwapA, person_no: 1, seat_code: 'A1-1', status: 'active' },
        { booking_ref: bookingSwapA, person_no: 2, seat_code: 'A1-2', status: 'active' }
      ]
    });

    // B has 1 pax: A1-3 in session 1
    await prisma.reservation.create({
      data: {
        booking_ref: bookingSwapB,
        user_id: testUserB.id,
        session_id: session1.id,
        pax: 1,
        status: 'confirmed',
        attendance: 'checked_in',
        is_seat_locked: true,
        seat_source: 'staff',
        assigned_seats: ['A1-3'],
        total_amount: 150
      }
    });
    await prisma.bookingPerson.create({
      data: { booking_ref: bookingSwapB, person_no: 1, seat_code: 'A1-3', status: 'active' }
    });

    // Move seat A1-1 of bookingSwapA to A1-3 (swap)
    const { req, res } = createMockReqRes({
      params: { booking_ref: bookingSwapA },
      body: {
        from_seat: 'A1-1',
        to_seat: 'A1-3',
        mode: 'swap'
      }
    });

    await moveSeat(req, res);
    assert.equal(res.getStatusCode(), 200, `moveSeat swap failed: ${JSON.stringify(res.getResponseData())}`);

    // Verify reservation seats
    const resA = await prisma.reservation.findFirst({ where: { booking_ref: bookingSwapA } });
    const resB = await prisma.reservation.findFirst({ where: { booking_ref: bookingSwapB } });

    assert.deepEqual(resA.assigned_seats, ['A1-3', 'A1-2'], 'A1-1 should be replaced by A1-3 while A1-2 remains untouched');
    assert.deepEqual(resB.assigned_seats, ['A1-1'], 'B should now have A1-1');

    // Verify BookingPerson.seat_code sync
    const bpA1 = await prisma.bookingPerson.findFirst({ where: { booking_ref: bookingSwapA, person_no: 1 } });
    const bpB1 = await prisma.bookingPerson.findFirst({ where: { booking_ref: bookingSwapB, person_no: 1 } });
    assert.equal(bpA1.seat_code, 'A1-3');
    assert.equal(bpB1.seat_code, 'A1-1');
  });

  await t.test('4.3 Layout preview and publish with capacity calculation and reseating', async () => {
    // 1. Create a draft layout with 14 active seats (e.g. deleting B2-3 and B2-4 from default 16)
    const legacy = (await import('../src/services/seating/layoutService.js')).getLegacyFallbackLayout();
    
    // Create new layout draft
    const draft = await prisma.seatLayout.create({
      data: {
        name: '測試新格局 14人',
        status: 'draft',
        canvas_w: 1000,
        canvas_h: 625,
        capacity: 14,
        rules_json: legacy.rules_json,
        zones: {
          create: legacy.zones.map(z => ({ name: z.name, note: z.note, sort_order: z.sort_order }))
        }
      },
      include: { zones: true }
    });

    const zoneMap = new Map(draft.zones.map(z => [z.sort_order, z.id]));

    // Insert tables
    const table1 = await prisma.seatTable.create({
      data: { layout_id: draft.id, zone_id: zoneMap.get(0), label: 'A1', shape: 'long', arrangement: 'one_side', cx: 250, cy: 220, w: 60, h: 260 }
    });
    const table2 = await prisma.seatTable.create({
      data: { layout_id: draft.id, zone_id: zoneMap.get(0), label: 'A2', shape: 'long', arrangement: 'one_side', cx: 250, cy: 460, w: 60, h: 260 }
    });
    const table3 = await prisma.seatTable.create({
      data: { layout_id: draft.id, zone_id: zoneMap.get(1), label: 'B1', shape: 'rect', arrangement: 'two_sides', cx: 720, cy: 220, w: 70, h: 140 }
    });
    const table4 = await prisma.seatTable.create({
      data: { layout_id: draft.id, zone_id: zoneMap.get(1), label: 'B2', shape: 'rect', arrangement: 'two_sides', cx: 720, cy: 460, w: 70, h: 140 }
    });

    // Insert 14 seats: omit B2-3 and B2-4
    const seatDefs = legacy.seats.filter(s => s.code !== 'B2-3' && s.code !== 'B2-4');
    for (const s of seatDefs) {
      let tId = table1.id;
      if (s.table_id === 102) tId = table2.id;
      if (s.table_id === 201) tId = table3.id;
      if (s.table_id === 202) tId = table4.id;

      await prisma.seat.create({
        data: {
          layout_id: draft.id,
          table_id: tId,
          zone_id: s.zone_id === 1 ? zoneMap.get(0) : zoneMap.get(1),
          code: s.code,
          lx: s.lx,
          ly: s.ly,
          side: s.side,
          side_mode: 'auto',
          is_active: true,
          priority: 'normal',
          origin_code: s.code
        }
      });
    }

    // Set future session max_capacity to 20 to test capacity_before = 20
    const futureDate = dateOnly('2026-11-25');
    await prisma.session.deleteMany({
      where: { session_date: { in: [futureDate, dateOnly('2026-11-26')] } }
    });
    const futureSession = await prisma.session.upsert({
      where: { session_date_start_time: { session_date: futureDate, start_time: '14:00' } },
      update: { end_time: '15:00', max_capacity: 20 },
      create: { session_date: futureDate, start_time: '14:00', end_time: '15:00', max_capacity: 20 }
    });

    // Create a movable reservation on B2-4 (deleted in draft)
    const bMovable = 'BK-TEST-5-MOVABLE';
    // Create a pinned reservation on B2-3 (deleted in draft)
    const bPinned = 'BK-TEST-5-PINNED';

    await prisma.reservation.deleteMany({ where: { booking_ref: { in: [bMovable, bPinned] } } });

    await prisma.reservation.create({
      data: {
        booking_ref: bMovable,
        user_id: testUserA.id,
        session_id: futureSession.id,
        pax: 1,
        status: 'confirmed',
        attendance: 'confirmed',
        is_seat_locked: false,
        seat_source: 'auto',
        assigned_seats: ['B2-4'],
        total_amount: 150
      }
    });

    await prisma.reservation.create({
      data: {
        booking_ref: bPinned,
        user_id: testUserB.id,
        session_id: futureSession.id,
        pax: 1,
        status: 'confirmed',
        attendance: 'checked_in',
        is_seat_locked: true,
        seat_source: 'staff',
        assigned_seats: ['B2-3'],
        total_amount: 150
      }
    });

    // Test previewPublish
    const previewRes = createMockReqRes({
      params: { id: draft.id },
      body: { effective_from: '2026-11-25' }
    });
    await previewPublish(previewRes.req, previewRes.res);
    assert.equal(previewRes.res.getStatusCode(), 200);
    const pData = previewRes.res.getResponseData();
    assert.equal(pData.capacity_before, 20, 'capacity_before should be 20 from future session max_capacity');
    assert.equal(pData.capacity_after, 14, 'capacity_after should be 14 from draft active seats');
    assert.equal(pData.affected_bookings?.length, 2, 'Both bookings on B2-3 and B2-4 should be affected');

    // Test publishLayout
    const pubRes = createMockReqRes({
      params: { id: draft.id },
      body: { effective_from: '2026-11-25', confirm: true }
    });
    await publishLayout(pubRes.req, pubRes.res);
    assert.equal(pubRes.res.getStatusCode(), 200);
    const pubData = pubRes.res.getResponseData();

    assert.equal(pubData.capacity_before, 20);
    assert.equal(pubData.capacity_after, 14);

    // Verify bookings on deleted seats (movable and pinned) were reallocated
    assert.equal(pubData.reallocated?.length, 2);
    const reallocatedRefs = pubData.reallocated.map(r => r.booking_ref);
    assert.ok(reallocatedRefs.includes(bMovable));
    assert.ok(reallocatedRefs.includes(bPinned));

    const reallocatedRes = await prisma.reservation.findFirst({ where: { booking_ref: bMovable } });
    assert.notEqual(reallocatedRes.assigned_seats[0], 'B2-4');

    const pinnedRes = await prisma.reservation.findFirst({ where: { booking_ref: bPinned } });
    assert.notEqual(pinnedRes.assigned_seats[0], 'B2-3', 'Pinned reservation on deleted seat must not retain B2-3');

    // Verify session max_capacity updated to 14
    const updatedFutureSession = await prisma.session.findUnique({ where: { id: futureSession.id } });
    assert.equal(updatedFutureSession.max_capacity, 14);

    // Test createBulkSessions inherits layout capacity
    const bulkRes = createMockReqRes({
      body: {
        session_dates: ['2026-11-26'],
        start_time: '10:00',
        end_time: '12:00'
      }
    });
    await createBulkSessions(bulkRes.req, bulkRes.res);
    assert.equal(bulkRes.res.getStatusCode(), 201);
    const createdSessions = await prisma.session.findMany({
      where: { session_date: dateOnly('2026-11-26') }
    });
    assert.equal(createdSessions.length, 2);
    assert.equal(createdSessions[0].max_capacity, 14, 'createBulkSessions should inherit active layout capacity 14');
  });

  // Cleanup test data
  await prisma.bookingPerson.deleteMany({
    where: {
      booking_ref: {
        startsWith: 'BK-TEST-5-'
      }
    }
  });
  await prisma.reservation.deleteMany({
    where: {
      booking_ref: {
        startsWith: 'BK-TEST-5-'
      }
    }
  });
  await prisma.session.deleteMany({
    where: { session_date: { in: [dateOnly('2026-11-25'), dateOnly('2026-11-26')] } }
  });
});
