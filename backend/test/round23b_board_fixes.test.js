import test from 'node:test';
import assert from 'node:assert/strict';
import prisma from '../src/prismaClient.js';
import { adminCreateReservation } from '../src/controllers/reservationController.js';
import {
  checkIn,
  addBoardRental,
  handleTimer,
  pauseBoard,
  resumeBoard,
  swapBoard,
  returnBoard
} from '../src/controllers/floorController.js';
import { getBookingBill } from '../src/services/billing/billService.js';
import { dateOnly } from '../../shared/time.js';

function createMockReqRes({ body = {}, params = {}, query = {}, user = { name: '店長', id: 1 } }) {
  const req = {
    body,
    params,
    query,
    user,
    headers: { 'user-agent': 'NodeTestAgent' },
    ip: '127.0.0.1'
  };
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

test('Round 23b Board Fixes (Items 1-3)', async (t) => {
  const prevNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'test';

  const dateStr = '2026-11-28';
  const dbDate = dateOnly(dateStr);
  const createdBookingRefs = [];
  const createdSessionIds = [];
  let testLayout = null;
  let seatSeq = 0;

  await prisma.globalSetting.upsert({
    where: { id: 1 },
    update: {
      seat_layout_enabled: true,
      equipment_discount_enabled: true,
      equipment_discount_buy_hours: 3,
      equipment_discount_free_hours: 1,
      equipment_discount_stackable: true
    },
    create: {
      id: 1,
      seat_layout_enabled: true,
      equipment_discount_enabled: true,
      equipment_discount_buy_hours: 3,
      equipment_discount_free_hours: 1,
      equipment_discount_stackable: true
    }
  });

  await prisma.equipmentConfig.upsert({
    where: { id: 'pegboard_s' },
    update: { name: '小板 (52×52)', hourly_rate: 90, total_stock: 10, visibility_status: 'ACTIVE', min_contiguous_hours: 1 },
    create: { id: 'pegboard_s', name: '小板 (52×52)', hourly_rate: 90, total_stock: 10, visibility_status: 'ACTIVE', min_contiguous_hours: 1 }
  });
  await prisma.equipmentConfig.upsert({
    where: { id: 'pegboard_m' },
    update: { name: '中板 (78×78)', hourly_rate: 120, total_stock: 10, visibility_status: 'ACTIVE', min_contiguous_hours: 1 },
    create: { id: 'pegboard_m', name: '中板 (78×78)', hourly_rate: 120, total_stock: 10, visibility_status: 'ACTIVE', min_contiguous_hours: 1 }
  });

  // Pre-clean any leftover test records on dateStr from aborted runs
  const staleResvs = await prisma.reservation.findMany({
    where: { session: { session_date: dbDate } },
    select: { booking_ref: true }
  });
  const staleRefs = [...new Set(staleResvs.map(r => r.booking_ref))];
  if (staleRefs.length) {
    const staleEqs = await prisma.bookingEquipment.findMany({
      where: { booking_ref: { in: staleRefs } },
      select: { unit_group: true }
    });
    const staleUgs = staleEqs.map(e => e.unit_group).filter(Boolean);
    if (staleUgs.length) {
      await prisma.boardPause.deleteMany({ where: { unit_group: { in: staleUgs } } });
    }
    await prisma.bookingEquipment.deleteMany({ where: { booking_ref: { in: staleRefs } } });
    await prisma.timerPause.deleteMany({ where: { person: { booking_ref: { in: staleRefs } } } });
    await prisma.bookingPerson.deleteMany({ where: { booking_ref: { in: staleRefs } } });
    await prisma.payment.deleteMany({ where: { booking_ref: { in: staleRefs } } });
    await prisma.reservation.deleteMany({ where: { booking_ref: { in: staleRefs } } });
  }

  // Create published seat layout on dateStr with plenty of seats
  testLayout = await prisma.seatLayout.create({
    data: {
      name: `Round 23b Layout ${Date.now()}`,
      status: 'published',
      effective_from: dbDate,
      canvas_w: 800,
      canvas_h: 600,
      capacity: 10
    }
  });
  const zone = await prisma.seatZone.create({
    data: { layout_id: testLayout.id, name: 'R23B主區', sort_order: 0 }
  });
  const table1 = await prisma.seatTable.create({
    data: {
      layout_id: testLayout.id,
      zone_id: zone.id,
      label: 'T1',
      shape: 'rect',
      arrangement: 'two_sides',
      cx: 200,
      cy: 200,
      w: 90,
      h: 220,
      rotation: 0,
      sort_order: 0
    }
  });
  const seatCodes = [];
  for (let i = 1; i <= 8; i++) {
    const code = `R23B-${i}`;
    seatCodes.push(code);
    await prisma.seat.create({
      data: {
        layout_id: testLayout.id,
        table_id: table1.id,
        zone_id: zone.id,
        code,
        lx: i <= 4 ? -45 : 45,
        ly: ((i - 1) % 4) * 40 - 60,
        side_mode: 'auto',
        priority: 'normal',
        is_active: true,
        sort_order: i - 1
      }
    });
  }

  // Create hourly sessions 19:00..22:00 on dateStr
  const sessionHours = [
    ['19:00', '20:00'],
    ['20:00', '21:00'],
    ['21:00', '22:00']
  ];
  const sessions = [];
  for (const [st, et] of sessionHours) {
    let s = await prisma.session.findUnique({
      where: { session_date_start_time: { session_date: dbDate, start_time: st } }
    });
    if (!s) {
      s = await prisma.session.create({
        data: { session_date: dbDate, start_time: st, end_time: et, max_capacity: 20 }
      });
      createdSessionIds.push(s.id);
    }
    sessions.push(s);
  }

  async function createCheckedInBooking({ name, phone, sessionList = sessions, equipments = [] }) {
    const seatCode = seatCodes[seatSeq++];
    const { req: createReq, res: createRes } = createMockReqRes({
      body: {
        session_ids: sessionList.map(s => s.id),
        pax: 1,
        name,
        phone,
        equipments,
        isForceWait: true
      }
    });
    await adminCreateReservation(createReq, createRes);
    assert.equal(createRes.getStatusCode(), 201, `adminCreateReservation failed: ${JSON.stringify(createRes.getResponseData())}`);
    const bRef = createRes.getResponseData().reservation.booking_ref;
    createdBookingRefs.push(bRef);

    const { req: ciReq, res: ciRes } = createMockReqRes({
      params: { booking_ref: bRef },
      body: { seats: [seatCode], start_timer: true }
    });
    await checkIn(ciReq, ciRes);
    assert.equal(ciRes.getStatusCode(), 200, `checkIn failed: ${JSON.stringify(ciRes.getResponseData())}`);

    return { booking_ref: bRef, seatCode };
  }

  async function cleanup() {
    if (createdBookingRefs.length) {
      const equips = await prisma.bookingEquipment.findMany({
        where: { booking_ref: { in: createdBookingRefs } },
        select: { unit_group: true }
      });
      const ugs = equips.map(e => e.unit_group).filter(Boolean);
      if (ugs.length) {
        await prisma.boardPause.deleteMany({ where: { unit_group: { in: ugs } } });
      }
      await prisma.bookingEquipment.deleteMany({ where: { booking_ref: { in: createdBookingRefs } } });
      await prisma.timerPause.deleteMany({ where: { person: { booking_ref: { in: createdBookingRefs } } } });
      await prisma.bookingPerson.deleteMany({ where: { booking_ref: { in: createdBookingRefs } } });
      await prisma.payment.deleteMany({ where: { booking_ref: { in: createdBookingRefs } } });
      await prisma.reservation.deleteMany({ where: { booking_ref: { in: createdBookingRefs } } });
    }
  }

  t.after(async () => {
    process.env.NODE_ENV = prevNodeEnv;
    await cleanup();
    await prisma.user.deleteMany({ where: { phone: { startsWith: '0988777' } } });
    if (createdSessionIds.length) {
      await prisma.session.deleteMany({ where: { id: { in: createdSessionIds } } });
    }
    if (testLayout) {
      await prisma.seat.deleteMany({ where: { layout_id: testLayout.id } });
      await prisma.seatTable.deleteMany({ where: { layout_id: testLayout.id } });
      await prisma.seatZone.deleteMany({ where: { layout_id: testLayout.id } });
      await prisma.seatLayout.deleteMany({ where: { id: testLayout.id } });
    }
    await prisma.equipmentConfig.update({ where: { id: 'pegboard_m' }, data: { total_stock: 10, min_contiguous_hours: 2 } }).catch(() => {});
  });

  await t.test('Item 1: addBoardRental leaves end_at null so person pause & solo board pause work and billing is intact', async () => {
    const { booking_ref } = await createCheckedInBooking({
      name: '加租測試客一',
      phone: '0988777001'
    });

    // Align person billing_start_at / timer_started_at to 19:00 on dateStr
    const start19 = new Date(`${dateStr}T19:00:00+08:00`);
    await prisma.bookingPerson.updateMany({
      where: { booking_ref, person_no: 1 },
      data: { billing_start_at: start19, timer_started_at: start19 }
    });

    // Rent pegboard_m for 20:00-22:00 via real addBoardRental controller
    const { req: addReq, res: addRes } = createMockReqRes({
      params: { booking_ref },
      body: { person_no: 1, equipment_id: 'pegboard_m', from_at: '20:00', to_at: '22:00' }
    });
    await addBoardRental(addReq, addRes);
    assert.equal(addRes.getStatusCode(), 200, `addBoardRental failed: ${JSON.stringify(addRes.getResponseData())}`);

    const rentedEq = addRes.getResponseData().booking_equipment;
    assert.equal(rentedEq.end_at, null, 'addBoardRental must leave end_at as null');
    assert.equal(
      new Date(rentedEq.planned_end_at).getTime(),
      new Date(`${dateStr}T22:00:00+08:00`).getTime(),
      'planned_end_at should be 22:00'
    );
    assert.deepEqual(rentedEq.covered_sessions, ['20:00-21:00', '21:00-22:00']);

    // Check bill amount before pauses (2 hours @ 120 = 240)
    const billBefore = await getBookingBill(booking_ref);
    assert.equal(billBefore.bill.summary.board_total, 240, 'board_total should be NT$240 for 20:00-22:00');

    // Pause person -> BoardPause(source='person') should be auto-created
    const { req: pReq, res: pRes } = createMockReqRes({
      params: { booking_ref },
      body: { action: 'pause', person_nos: [1], now: `${dateStr}T20:10:00+08:00`, reason: '休息' }
    });
    await handleTimer(pReq, pRes);
    assert.equal(pRes.getStatusCode(), 200);

    const personPause = await prisma.boardPause.findFirst({
      where: { unit_group: rentedEq.unit_group, ended_at: null }
    });
    assert.ok(personPause, 'BoardPause should be automatically opened when person pauses');
    assert.equal(personPause.source, 'person');

    // Resume person
    const { req: rReq, res: rRes } = createMockReqRes({
      params: { booking_ref },
      body: { action: 'resume', person_nos: [1], now: `${dateStr}T20:15:00+08:00` }
    });
    await handleTimer(rReq, rRes);
    assert.equal(rRes.getStatusCode(), 200);

    // Solo pause board -> should return 200 and create BoardPause(source='solo')
    const { req: bpReq, res: bpRes } = createMockReqRes({
      params: { booking_ref, unit_group: rentedEq.unit_group },
      body: { at: `${dateStr}T20:20:00+08:00` }
    });
    await pauseBoard(bpReq, bpRes);
    assert.equal(bpRes.getStatusCode(), 200, `pauseBoard failed: ${JSON.stringify(bpRes.getResponseData())}`);
    assert.equal(bpRes.getResponseData().board_pause.source, 'solo');

    // Resume board cleanly so bill stays intact
    const { req: brReq, res: brRes } = createMockReqRes({
      params: { booking_ref, unit_group: rentedEq.unit_group },
      body: { at: `${dateStr}T20:25:00+08:00` }
    });
    await resumeBoard(brReq, brRes);
    assert.equal(brRes.getStatusCode(), 200);

    // Release stock at end of Item 1 via returnBoard API
    const { req: ret1Req, res: ret1Res } = createMockReqRes({
      params: { booking_ref, unit_group: rentedEq.unit_group },
      body: { at: `${dateStr}T20:30:00+08:00` }
    });
    await returnBoard(ret1Req, ret1Res);
    assert.equal(ret1Res.getStatusCode(), 200);
  });

  await t.test('Item 2a: board added via addBoardRental can swapBoard & returnBoard cleanly with HH:MM-HH:MM covered_sessions', async () => {
    const { booking_ref } = await createCheckedInBooking({
      name: '加租換歸還客',
      phone: '0988777002'
    });

    const start19 = new Date(`${dateStr}T19:00:00+08:00`);
    await prisma.bookingPerson.updateMany({
      where: { booking_ref, person_no: 1 },
      data: { billing_start_at: start19, timer_started_at: start19 }
    });

    const { req: addReq, res: addRes } = createMockReqRes({
      params: { booking_ref },
      body: { person_no: 1, equipment_id: 'pegboard_s', from_at: '19:00', to_at: '22:00' }
    });
    await addBoardRental(addReq, addRes);
    assert.equal(addRes.getStatusCode(), 200);
    const ug = addRes.getResponseData().booking_equipment.unit_group;

    // Swap at 20:00 (segment 1 = 19:00-20:00, segment 2 = 20:00-22:00)
    const { req: swReq, res: swRes } = createMockReqRes({
      params: { booking_ref, unit_group: ug },
      body: {
        to_equipment_id: 'pegboard_m',
        boundary_at: `${dateStr}T20:00:00+08:00`,
        now: `${dateStr}T20:10:00+08:00`
      }
    });
    await swapBoard(swReq, swRes);
    assert.equal(swRes.getStatusCode(), 200, `swapBoard failed: ${JSON.stringify(swRes.getResponseData())}`);

    const afterSwapSegs = await prisma.bookingEquipment.findMany({
      where: { booking_ref, unit_group: ug },
      orderBy: { segment_no: 'asc' }
    });
    assert.equal(afterSwapSegs.length, 2);
    assert.deepEqual(afterSwapSegs[0].covered_sessions, ['19:00-20:00', '20:00-21:00']);
    assert.deepEqual(afterSwapSegs[1].covered_sessions, ['20:00-21:00', '21:00-22:00']);
    // 1h small (90) + 2h medium (240) = 330 (total 3h < buy 3 + free 1)
    assert.equal(swRes.getResponseData().bill.summary.board_total, 330);

    // Return at 20:30 (during 20:00-21:00) -> 21:00-22:00 released from covered_sessions
    const { req: retReq, res: retRes } = createMockReqRes({
      params: { booking_ref, unit_group: ug },
      body: { at: `${dateStr}T20:30:00+08:00` }
    });
    await returnBoard(retReq, retRes);
    assert.equal(retRes.getStatusCode(), 200, `returnBoard failed: ${JSON.stringify(retRes.getResponseData())}`);

    const afterRetSegs = await prisma.bookingEquipment.findMany({
      where: { booking_ref, unit_group: ug },
      orderBy: { segment_no: 'asc' }
    });
    assert.equal(afterRetSegs[1].ended_reason, 'returned');
    assert.deepEqual(afterRetSegs[1].covered_sessions, ['20:00-21:00']);
    assert.equal(retRes.getResponseData().bill.summary.board_total, 330);
  });

  await t.test('Item 2b: board added at reservation creation swaps & returns cleanly with HH:MM-HH:MM covered_sessions', async () => {
    const { booking_ref } = await createCheckedInBooking({
      name: '預約帶板客',
      phone: '0988777003',
      equipments: [{ equipment_id: 'pegboard_s', quantity: 1, rental_hours: 3 }]
    });

    const segs = await prisma.bookingEquipment.findMany({
      where: { booking_ref },
      orderBy: { segment_no: 'asc' }
    });
    assert.equal(segs.length, 1);
    const ug = segs[0].unit_group;
    assert.ok(ug, 'checkIn splitBoardUnits should assign unit_group');
    assert.deepEqual(segs[0].covered_sessions, ['19:00-20:00', '20:00-21:00', '21:00-22:00']);

    const { req: swReq, res: swRes } = createMockReqRes({
      params: { booking_ref, unit_group: ug },
      body: {
        to_equipment_id: 'pegboard_m',
        boundary_at: `${dateStr}T20:30:00+08:00`,
        now: `${dateStr}T20:40:00+08:00`
      }
    });
    await swapBoard(swReq, swRes);
    assert.equal(swRes.getStatusCode(), 200, `swapBoard failed: ${JSON.stringify(swRes.getResponseData())}`);

    const afterSwap = await prisma.bookingEquipment.findMany({
      where: { booking_ref, unit_group: ug },
      orderBy: { segment_no: 'asc' }
    });
    assert.equal(afterSwap.length, 2);
    assert.deepEqual(afterSwap[0].covered_sessions, ['19:00-20:00', '20:00-21:00']);
    assert.deepEqual(afterSwap[1].covered_sessions, ['20:00-21:00', '21:00-22:00']);
    // 1.5h small (135) + 1.5h medium (180) = 315 (total 3h < buy 3 + free 1)
    assert.equal(swRes.getResponseData().bill.summary.board_total, 315);

    const { req: retReq, res: retRes } = createMockReqRes({
      params: { booking_ref, unit_group: ug },
      body: { at: `${dateStr}T20:45:00+08:00` }
    });
    await returnBoard(retReq, retRes);
    assert.equal(retRes.getStatusCode(), 200);
    const afterRet = await prisma.bookingEquipment.findMany({
      where: { booking_ref, unit_group: ug },
      orderBy: { segment_no: 'asc' }
    });
    assert.deepEqual(afterRet[1].covered_sessions, ['20:00-21:00']);
  });

  await t.test('Item 2c: swapBoard returns 409 when on-site addBoardRental board occupies last medium board stock', async () => {
    await prisma.equipmentConfig.update({
      where: { id: 'pegboard_m' },
      data: { total_stock: 1 }
    });

    try {
      const { booking_ref: occupierRef } = await createCheckedInBooking({
        name: '佔用庫存客',
        phone: '0988777004'
      });

      const { req: addReq, res: addRes } = createMockReqRes({
        params: { booking_ref: occupierRef },
        body: { person_no: 1, equipment_id: 'pegboard_m', from_at: '20:00', to_at: '22:00' }
      });
      await addBoardRental(addReq, addRes);
      assert.equal(addRes.getStatusCode(), 200);

      const { booking_ref: swapperRef } = await createCheckedInBooking({
        name: '想換中板客',
        phone: '0988777005',
        equipments: [{ equipment_id: 'pegboard_s', quantity: 1, rental_hours: 3 }]
      });
      const swapperEq = await prisma.bookingEquipment.findFirst({ where: { booking_ref: swapperRef } });

      const { req: swReq, res: swRes } = createMockReqRes({
        params: { booking_ref: swapperRef, unit_group: swapperEq.unit_group },
        body: {
          to_equipment_id: 'pegboard_m',
          boundary_at: `${dateStr}T20:00:00+08:00`,
          now: `${dateStr}T20:05:00+08:00`
        }
      });
      await swapBoard(swReq, swRes);
      assert.equal(swRes.getStatusCode(), 409, `Expected 409 when stock is occupied by on-site addBoardRental, got ${swRes.getStatusCode()}`);
    } finally {
      await prisma.equipmentConfig.update({
        where: { id: 'pegboard_m' },
        data: { total_stock: 10 }
      });
    }
  });

  await t.test('Item 2d: legacy BookingEquipment with session ID covered_sessions can still be returned cleanly', async () => {
    const { booking_ref } = await createCheckedInBooking({
      name: '舊格式兼容客',
      phone: '0988777006',
      equipments: [{ equipment_id: 'pegboard_s', quantity: 1, rental_hours: 3 }]
    });

    const seg = await prisma.bookingEquipment.findFirst({ where: { booking_ref } });
    // Simulate legacy DB row where covered_sessions stored numeric session ID strings
    await prisma.bookingEquipment.update({
      where: { id: seg.id },
      data: { covered_sessions: sessions.map(s => String(s.id)) }
    });

    const { req: retReq, res: retRes } = createMockReqRes({
      params: { booking_ref, unit_group: seg.unit_group },
      body: { at: `${dateStr}T20:30:00+08:00` }
    });
    await returnBoard(retReq, retRes);
    assert.equal(retRes.getStatusCode(), 200, `returnBoard on legacy ID format failed: ${JSON.stringify(retRes.getResponseData())}`);

    const updatedSeg = await prisma.bookingEquipment.findFirst({ where: { id: seg.id } });
    assert.equal(updatedSeg.ended_reason, 'returned');
    assert.deepEqual(updatedSeg.covered_sessions, ['19:00-20:00', '20:00-21:00']);
  });

  await t.test('Item 3: pauseBoard and resumeBoard ignore client at outside NODE_ENV=test', async () => {
    const { booking_ref } = await createCheckedInBooking({
      name: '忽略客戶端時間客',
      phone: '0988777007'
    });

    const { req: addReq, res: addRes } = createMockReqRes({
      params: { booking_ref },
      body: { person_no: 1, equipment_id: 'pegboard_s', from_at: '19:00', to_at: '22:00' }
    });
    await addBoardRental(addReq, addRes);
    assert.equal(addRes.getStatusCode(), 200);
    const ug = addRes.getResponseData().booking_equipment.unit_group;

    const twoHoursAgo = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
    const oneHourAgo = new Date(Date.now() - 1 * 3600 * 1000).toISOString();

    process.env.NODE_ENV = 'production';
    try {
      const beforePause = Date.now();
      const { req: pReq, res: pRes } = createMockReqRes({
        params: { booking_ref, unit_group: ug },
        body: { at: twoHoursAgo }
      });
      await pauseBoard(pReq, pRes);
      const afterPause = Date.now();
      assert.equal(pRes.getStatusCode(), 200);

      const startedMs = new Date(pRes.getResponseData().board_pause.started_at).getTime();
      assert.ok(
        startedMs >= beforePause - 5000 && startedMs <= afterPause + 5000,
        `Expected BoardPause.started_at (${new Date(startedMs).toISOString()}) to be current server time, not 2 hours ago`
      );

      const beforeResume = Date.now();
      const { req: rReq, res: rRes } = createMockReqRes({
        params: { booking_ref, unit_group: ug },
        body: { at: oneHourAgo }
      });
      await resumeBoard(rReq, rRes);
      const afterResume = Date.now();
      assert.equal(rRes.getStatusCode(), 200);

      const closedPause = await prisma.boardPause.findFirst({ where: { unit_group: ug } });
      const endedMs = new Date(closedPause.ended_at).getTime();
      assert.ok(
        endedMs >= beforeResume - 5000 && endedMs <= afterResume + 5000,
        `Expected BoardPause.ended_at (${new Date(endedMs).toISOString()}) to be current server time, not 1 hour ago`
      );
    } finally {
      process.env.NODE_ENV = 'test';
    }
  });
});
