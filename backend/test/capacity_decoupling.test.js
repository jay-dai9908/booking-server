import test from 'node:test';
import assert from 'node:assert/strict';
import prisma from '../src/prismaClient.js';
import { publishLayout, previewPublish } from '../src/controllers/seatLayoutController.js';
import { createBulkSessions } from '../src/controllers/sessionController.js';
import { createReservation, adminCreateReservation, extendReservation } from '../src/controllers/reservationController.js';
import { addPerson } from '../src/controllers/floorController.js';
import { getGlobalSetting, updateGlobalSetting } from '../src/controllers/dailySettingController.js';
import { dateOnly } from '../../shared/time.js';

function createMockReqRes({ body = {}, params = {}, query = {}, user = { name: '店長', id: 1, isSuperAdmin: true, permissions: ['all'] } }) {
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

async function createTestLayoutWithSeats(name, status, effectiveFrom, seatCount, codePrefix) {
  const layout = await prisma.seatLayout.create({
    data: {
      name,
      status,
      effective_from: effectiveFrom,
      canvas_w: 1000,
      canvas_h: 625,
      capacity: seatCount,
      zones: {
        create: [{ name: 'A區', sort_order: 0 }]
      }
    },
    include: { zones: true }
  });
  const zoneId = layout.zones[0].id;

  const table = await prisma.seatTable.create({
    data: {
      layout_id: layout.id,
      zone_id: zoneId,
      label: 'T1',
      shape: 'rect',
      arrangement: 'one_side',
      cx: 200,
      cy: 200,
      w: 80,
      h: 120,
      sort_order: 1
    }
  });

  const seatsData = [];
  for (let i = 1; i <= seatCount; i++) {
    seatsData.push({
      layout_id: layout.id,
      table_id: table.id,
      zone_id: zoneId,
      code: `${codePrefix}-${i}`,
      lx: 10 * i,
      ly: 20,
      side_mode: 'auto',
      is_active: true,
      priority: 'normal',
      sort_order: i
    });
  }

  await prisma.seat.createMany({ data: seatsData });
  return layout;
}

test('Capacity Decoupling Acceptance Tests', async (t) => {
  const TS = Date.now();
  const testDate = dateOnly('2026-12-15');

  // Setup GlobalSetting
  await prisma.globalSetting.upsert({
    where: { id: 1 },
    update: { default_session_capacity: 16, seat_layout_enabled: true },
    create: { id: 1, default_session_capacity: 16, seat_layout_enabled: true }
  });

  // Acceptance 1: GlobalSetting default_session_capacity API
  await t.test('1. GlobalSetting default_session_capacity can be read and updated', async () => {
    const getRes = createMockReqRes({});
    await getGlobalSetting(getRes.req, getRes.res);
    assert.equal(getRes.res.getStatusCode(), 200);
    assert.equal(getRes.res.getResponseData().default_session_capacity, 16);

    const updateRes = createMockReqRes({ body: { default_session_capacity: 18 } });
    await updateGlobalSetting(updateRes.req, updateRes.res);
    assert.equal(updateRes.res.getStatusCode(), 200);

    const verifyRes = createMockReqRes({});
    await getGlobalSetting(verifyRes.req, verifyRes.res);
    assert.equal(verifyRes.res.getResponseData().default_session_capacity, 18);

    // Reset back to 16
    await updateGlobalSetting(createMockReqRes({ body: { default_session_capacity: 16 } }).req, createMockReqRes({ body: { default_session_capacity: 16 } }).res);
  });

  // Acceptance 2: createBulkSessions with/without max_capacity
  await t.test('2. 建立時段時帶 max_capacity: 14，上限是 14；沒帶的話，用全域預設 (16)', async () => {
    // 2a: With max_capacity: 14
    const bulk1 = createMockReqRes({
      body: {
        session_dates: ['2026-12-16'],
        start_time: '10:00',
        end_time: '11:00',
        max_capacity: 14
      }
    });
    await createBulkSessions(bulk1.req, bulk1.res);
    assert.equal(bulk1.res.getStatusCode(), 201);
    const s1 = await prisma.session.findFirst({
      where: { session_date: dateOnly('2026-12-16'), start_time: '10:00' }
    });
    assert.equal(s1.max_capacity, 14, 'Provided max_capacity: 14 must be applied');

    // 2b: Without max_capacity -> global default (16)
    const bulk2 = createMockReqRes({
      body: {
        session_dates: ['2026-12-16'],
        start_time: '11:00',
        end_time: '12:00'
      }
    });
    await createBulkSessions(bulk2.req, bulk2.res);
    assert.equal(bulk2.res.getStatusCode(), 201);
    const s2 = await prisma.session.findFirst({
      where: { session_date: dateOnly('2026-12-16'), start_time: '11:00' }
    });
    assert.equal(s2.max_capacity, 16, 'When max_capacity is omitted, global default 16 must be applied');
  });

  // Acceptance 3: Layout publishing does NOT overwrite existing session max_capacity
  await t.test('3. 發布一個 20 個座位的版面後，已存在時段的 max_capacity 保持原本的 16，不會被改成 20', async () => {
    // Create an existing session with max_capacity = 16
    const sess = await prisma.session.upsert({
      where: { session_date_start_time: { session_date: testDate, start_time: '14:00' } },
      update: { end_time: '15:00', max_capacity: 16 },
      create: { session_date: testDate, start_time: '14:00', end_time: '15:00', max_capacity: 16 }
    });

    // Create a 20-seat draft layout
    const layout = await createTestLayoutWithSeats(`測試20座位版面_${TS}`, 'draft', testDate, 20, `S${TS}`);

    // Publish this layout
    const pubRes = createMockReqRes({
      params: { id: layout.id },
      body: { effective_from: '2026-12-15', confirm: true }
    });
    await publishLayout(pubRes.req, pubRes.res);
    assert.equal(pubRes.res.getStatusCode(), 200);

    // Verify session max_capacity is STILL 16, NOT 20
    const reloadedSession = await prisma.session.findUnique({ where: { id: sess.id } });
    assert.equal(reloadedSession.max_capacity, 16, 'Session max_capacity must remain 16 after publishing 20-seat layout');
  });

  // Acceptance 4: Over capacity separation between online and admin
  await t.test('4. 某時段已經有 14 位線上預約、上限 14、座位 20：顧客被擋下 (409)，現場加人排到空座，店員替已有訂單加 1 人成功', async () => {
    const slotDate = dateOnly('2026-12-18');

    // Create session with max_capacity: 14
    const session = await prisma.session.upsert({
      where: { session_date_start_time: { session_date: slotDate, start_time: '15:00' } },
      update: { end_time: '16:00', max_capacity: 14 },
      create: { session_date: slotDate, start_time: '15:00', end_time: '16:00', max_capacity: 14 }
    });

    // Create 20-seat published layout for slotDate
    const layout = await createTestLayoutWithSeats(`測試20座_${TS}`, 'published', slotDate, 20, `P${TS}`);
    const seats20 = await prisma.seat.findMany({ where: { layout_id: layout.id }, orderBy: { sort_order: 'asc' } });

    // Create existing 14 pax bookings (e.g. 1 reservation with 13 pax, 1 with 1 pax = 14)
    const user1 = await prisma.user.upsert({
      where: { line_user_id: `test_user_1_${TS}` },
      update: { name: '現有預約客A' },
      create: { line_user_id: `test_user_1_${TS}`, name: '現有預約客A', phone: '0911000001' }
    });
    const user2 = await prisma.user.upsert({
      where: { line_user_id: `test_user_2_${TS}` },
      update: { name: '現有預約客B' },
      create: { line_user_id: `test_user_2_${TS}`, name: '現有預約客B', phone: '0911000002' }
    });

    const bookingRef1 = `BK-EXIST1-${TS}`;
    const seatsFor13 = seats20.slice(0, 13).map(s => s.code);
    await prisma.reservation.create({
      data: {
        booking_ref: bookingRef1,
        session_id: session.id,
        user_id: user1.id,
        pax: 13,
        status: 'confirmed',
        assigned_seats: seatsFor13
      }
    });
    // Create booking persons for bookingRef1
    for (let p = 1; p <= 13; p++) {
      await prisma.bookingPerson.create({
        data: {
          booking_ref: bookingRef1,
          person_no: p,
          seat_code: seatsFor13[p - 1],
          status: 'active'
        }
      });
    }

    const bookingRef2 = `BK-EXIST2-${TS}`;
    const seatFor1 = [seats20[13].code];
    await prisma.reservation.create({
      data: {
        booking_ref: bookingRef2,
        session_id: session.id,
        user_id: user2.id,
        pax: 1,
        status: 'confirmed',
        assigned_seats: seatFor1
      }
    });
    await prisma.bookingPerson.create({
      data: {
        booking_ref: bookingRef2,
        person_no: 1,
        seat_code: seatFor1[0],
        status: 'active'
      }
    });

    // Total booked pax is now 14. max_capacity is 14. Total physical seats is 20.

    // 4a. 顧客再預約 1 位：被擋下 (409)
    const custUser = await prisma.user.upsert({
      where: { line_user_id: `test_cust_online_${TS}` },
      update: { name: '線上新顧客' },
      create: { line_user_id: `test_cust_online_${TS}`, name: '線上新顧客', phone: '0911000003' }
    });
    const custReqRes = createMockReqRes({
      body: {
        session_ids: [session.id],
        pax: 1
      },
      user: { id: custUser.id }
    });
    await createReservation(custReqRes.req, custReqRes.res);
    assert.equal(custReqRes.res.getStatusCode(), 409, 'Customer online booking over max_capacity (14) must be blocked with 409');

    // 4b. 店員現場加人 2 位：成功，排到空座位 (14 + 2 = 16 <= 20)
    const adminReqRes = createMockReqRes({
      body: {
        session_ids: [session.id],
        pax: 2,
        name: '現場散客',
        phone: '0922000000',
        isWalkIn: true
      }
    });
    await adminCreateReservation(adminReqRes.req, adminReqRes.res);
    assert.equal(adminReqRes.res.getStatusCode(), 201, 'Admin onsite booking must succeed when empty seats exist');
    const adminCreatedData = adminReqRes.res.getResponseData();
    assert.ok(adminCreatedData.reservation?.assigned_seats?.length === 2, 'Must assign 2 seats');
    assert.ok(!adminCreatedData.reservation.assigned_seats[0].startsWith('WAIT-'), 'Must be real empty seats, not waiting');

    // 4c. 店員替已有的訂單加 1 人：成功 (total now 16 + 1 = 17 <= 20)
    const allBookedSeatsInSession = (await prisma.reservation.findMany({
      where: { session_id: session.id, status: 'confirmed' }
    })).flatMap(r => r.assigned_seats || []);
    const emptySeat = seats20.find(s => !allBookedSeatsInSession.includes(s.code))?.code;
    assert.ok(emptySeat, 'There should be empty seats available among the 20 seats');

    const addPersonRes = createMockReqRes({
      params: { booking_ref: bookingRef2 },
      body: {
        seat_code: emptySeat,
        force: false
      }
    });
    await addPerson(addPersonRes.req, addPersonRes.res);
    assert.equal(addPersonRes.res.getStatusCode(), 200, 'Staff add person to existing booking must succeed because seat is available');
    const addPersonData = addPersonRes.res.getResponseData();
    assert.equal(addPersonData.person?.seat_code, emptySeat);

    // Verify bookingRef2 has pax = 2 now
    const updatedRes2 = await prisma.reservation.findFirst({ where: { booking_ref: bookingRef2 } });
    assert.equal(updatedRes2.pax, 2);

    // 4d. 店員替訂單加時（extendReservation）：時段線上人數已達上限 14，但座位 20 仍有空位，加時成功
    const nextSession = await prisma.session.upsert({
      where: { session_date_start_time: { session_date: slotDate, start_time: '16:00' } },
      update: { end_time: '17:00', max_capacity: 14 },
      create: { session_date: slotDate, start_time: '16:00', end_time: '17:00', max_capacity: 14 }
    });
    const refFill = `BK-FILL-${TS}`;
    const seatsFill = seats20.slice(0, 14).map(s => s.code);
    await prisma.reservation.create({
      data: {
        booking_ref: refFill,
        session_id: nextSession.id,
        user_id: user1.id,
        pax: 14,
        status: 'confirmed',
        assigned_seats: seatsFill
      }
    });

    const extendRes = createMockReqRes({
      params: { booking_ref: bookingRef2 },
      body: {
        session_ids: [nextSession.id],
        extendMode: 'system_allocate'
      }
    });
    await extendReservation(extendRes.req, extendRes.res);
    assert.equal(extendRes.res.getStatusCode(), 201, 'extendReservation must succeed when physical seats exist even if online max_capacity is reached');
  });

  // Acceptance 5: previewPublish counts sessions whose max_capacity > new layout capacity
  await t.test('5. 發布預覽時，計算未來時段可預約人數大於新座位數的時段數量，但不擋發布', async () => {
    const previewDate = dateOnly('2026-12-20');
    // Create 3 sessions with max_capacity = 16
    for (let h = 10; h < 13; h++) {
      await prisma.session.upsert({
        where: { session_date_start_time: { session_date: previewDate, start_time: `${h}:00` } },
        update: { end_time: `${h + 1}:00`, max_capacity: 16 },
        create: { session_date: previewDate, start_time: `${h}:00`, end_time: `${h + 1}:00`, max_capacity: 16 }
      });
    }

    // Create a 12-seat draft layout (less than 16)
    const draft12 = await createTestLayoutWithSeats(`12座版面_${TS}`, 'draft', previewDate, 12, `D12-${TS}`);

    const prevRes = createMockReqRes({
      params: { id: draft12.id },
      body: { effective_from: '2026-12-20' }
    });
    await previewPublish(prevRes.req, prevRes.res);
    assert.equal(prevRes.res.getStatusCode(), 200);
    const pData = prevRes.res.getResponseData();
    assert.equal(pData.capacity_after, 12);
    assert.ok(pData.sessions_capacity_exceeding_seats_count >= 3, 'Should detect at least 3 sessions where max_capacity (16) > 12');

    // Publishing should still succeed without blocking
    const pubRes = createMockReqRes({
      params: { id: draft12.id },
      body: { effective_from: '2026-12-20', confirm: true }
    });
    await publishLayout(pubRes.req, pubRes.res);
    assert.equal(pubRes.res.getStatusCode(), 200);
  });

  // Acceptance 6: Edge cases - invalid capacity fallback, getSessions fields, force addPerson, and force_wait extension
  await t.test('6. 邊界測試：無效容量退回全域設定、getSessions 雙重剩餘數字、加人 force 旁路、加時 force_wait', async () => {
    const edgeDate = dateOnly('2026-12-22');

    // 6a. createBulkSessions with invalid max_capacity ('abc') falls back to default (16)
    const bulkInvalid = createMockReqRes({
      body: {
        session_dates: ['2026-12-22'],
        start_time: '18:00',
        end_time: '19:00',
        max_capacity: 'invalid_number'
      }
    });
    await createBulkSessions(bulkInvalid.req, bulkInvalid.res);
    assert.equal(bulkInvalid.res.getStatusCode(), 201);
    const sEdge = await prisma.session.findFirst({
      where: { session_date: edgeDate, start_time: '18:00' }
    });
    assert.equal(sEdge.max_capacity, 16, 'Invalid max_capacity must fall back to default_session_capacity 16');

    // 6b. getSessions returns both online remaining_capacity and physical remaining_seats & total_seats
    const { getSessions } = await import('../src/controllers/sessionController.js');
    const getSessRes = createMockReqRes({ query: { date: '2026-12-22' } });
    await getSessions(getSessRes.req, getSessRes.res);
    assert.equal(getSessRes.res.getStatusCode(), 200);
    const sessList = getSessRes.res.getResponseData();
    assert.ok(sessList.length > 0);
    const target = sessList.find(s => s.id === sEdge.id);
    assert.equal(target.max_capacity, 16, 'max_capacity should be 16');
    assert.equal(target.remaining_capacity, 16, 'remaining_capacity should be 16');
    assert.equal(target.total_seats, 12, 'total_seats should be 12 from published 12-seat layout');
    assert.equal(target.remaining_seats, 12, 'remaining_seats should be 12 from published 12-seat layout');

    // 6c. Force addPerson when layout is full
    // Create a 2-seat layout and 2 pax booking
    const layout2 = await createTestLayoutWithSeats(`2座版面_${TS}`, 'published', edgeDate, 2, `E2-${TS}`);
    const edgeSession = await prisma.session.upsert({
      where: { session_date_start_time: { session_date: edgeDate, start_time: '19:00' } },
      update: { end_time: '20:00', max_capacity: 2 },
      create: { session_date: edgeDate, start_time: '19:00', end_time: '20:00', max_capacity: 2 }
    });
    const uEdge = await prisma.user.upsert({
      where: { line_user_id: `test_u_edge_${TS}` },
      update: { name: '邊界客人' },
      create: { line_user_id: `test_u_edge_${TS}`, name: '邊界客人', phone: '0988000000' }
    });
    const bRefEdge = `BK-EDGE-${TS}`;
    await prisma.reservation.create({
      data: {
        booking_ref: bRefEdge,
        session_id: edgeSession.id,
        user_id: uEdge.id,
        pax: 2,
        status: 'confirmed',
        assigned_seats: [`E2-${TS}-1`, `E2-${TS}-2`]
      }
    });
    await prisma.bookingPerson.createMany({
      data: [
        { booking_ref: bRefEdge, person_no: 1, seat_code: `E2-${TS}-1`, status: 'active' },
        { booking_ref: bRefEdge, person_no: 2, seat_code: `E2-${TS}-2`, status: 'active' }
      ]
    });

    // Attempting addPerson without force should fail 409 OVER_CAPACITY
    const addFail = createMockReqRes({
      params: { booking_ref: bRefEdge },
      body: { force: false }
    });
    let failed = false;
    try {
      await addPerson(addFail.req, addFail.res);
      if (addFail.res.getStatusCode() === 409) failed = true;
    } catch (e) {
      if (e.status === 409 && e.code === 'OVER_CAPACITY') failed = true;
    }
    assert.ok(failed, 'Adding person without force when physical seats are full must return 409 OVER_CAPACITY');

    // Attempting addPerson WITH force should succeed (仍然加入)
    const addForce = createMockReqRes({
      params: { booking_ref: bRefEdge },
      body: { force: true }
    });
    await addPerson(addForce.req, addForce.res);
    assert.equal(addForce.res.getStatusCode(), 200, 'Adding person with force: true must succeed');
    const updatedEdge = await prisma.reservation.findFirst({ where: { booking_ref: bRefEdge } });
    assert.equal(updatedEdge.pax, 3, 'Pax should be incremented to 3');

    // 6d. extendReservation with force_wait when physical seats are full
    const extendWaitRes = createMockReqRes({
      params: { booking_ref: bRefEdge },
      body: {
        session_ids: [edgeSession.id],
        extendMode: 'force_wait'
      }
    });
    // Extending existing booking with force_wait
    const nextEdgeSess = await prisma.session.upsert({
      where: { session_date_start_time: { session_date: edgeDate, start_time: '20:00' } },
      update: { end_time: '21:00', max_capacity: 2 },
      create: { session_date: edgeDate, start_time: '20:00', end_time: '21:00', max_capacity: 2 }
    });
    // Fill nextEdgeSess completely
    await prisma.reservation.create({
      data: {
        booking_ref: `BK-BLOCK-${TS}`,
        session_id: nextEdgeSess.id,
        user_id: uEdge.id,
        pax: 2,
        status: 'confirmed',
        assigned_seats: [`E2-${TS}-1`, `E2-${TS}-2`]
      }
    });

    // Now try normal extend -> should fail INSUFFICIENT_CAPACITY (400)
    const extendFailRes = createMockReqRes({
      params: { booking_ref: bRefEdge },
      body: {
        session_ids: [nextEdgeSess.id],
        extendMode: 'system_allocate'
      }
    });
    await extendReservation(extendFailRes.req, extendFailRes.res);
    assert.equal(extendFailRes.res.getStatusCode(), 400, 'Normal extension when no seats available should fail 400');

    // Now try extend with force_wait -> should succeed 201 with WAIT- seats
    const extendWaitOk = createMockReqRes({
      params: { booking_ref: bRefEdge },
      body: {
        session_ids: [nextEdgeSess.id],
        extendMode: 'force_wait'
      }
    });
    await extendReservation(extendWaitOk.req, extendWaitOk.res);
    assert.equal(extendWaitOk.res.getStatusCode(), 201, 'Extension with force_wait must succeed');
    const waitResRecord = await prisma.reservation.findFirst({
      where: { booking_ref: bRefEdge, session_id: nextEdgeSess.id }
    });
    assert.ok(waitResRecord.assigned_seats.every(s => s.startsWith('WAIT-')), 'All assigned seats must be WAIT-');
  });

  // Cleanup test data created
  const testDates = [
    dateOnly('2026-12-15'),
    dateOnly('2026-12-16'),
    dateOnly('2026-12-18'),
    dateOnly('2026-12-20'),
    dateOnly('2026-12-22')
  ];
  const testSessions = await prisma.session.findMany({
    where: { session_date: { in: testDates } },
    select: { id: true }
  });
  const testSessionIds = testSessions.map(s => s.id);
  const testReservations = await prisma.reservation.findMany({
    where: { session_id: { in: testSessionIds } },
    select: { booking_ref: true }
  });
  const testRefs = testReservations.map(r => r.booking_ref);

  await prisma.bookingPerson.deleteMany({
    where: { booking_ref: { in: testRefs } }
  });
  await prisma.reservation.deleteMany({
    where: { session_id: { in: testSessionIds } }
  });
  await prisma.session.deleteMany({
    where: { id: { in: testSessionIds } }
  });

  const layouts = await prisma.seatLayout.findMany({ where: { name: { contains: `${TS}` } }, select: { id: true } });
  const layoutIds = layouts.map(l => l.id);
  if (layoutIds.length > 0) {
    await prisma.seat.deleteMany({ where: { layout_id: { in: layoutIds } } });
    await prisma.seatTable.deleteMany({ where: { layout_id: { in: layoutIds } } });
    await prisma.seatZone.deleteMany({ where: { layout_id: { in: layoutIds } } });
    await prisma.seatLayout.deleteMany({ where: { id: { in: layoutIds } } });
  }
  await prisma.user.deleteMany({
    where: { line_user_id: { contains: `${TS}` } }
  });
});
