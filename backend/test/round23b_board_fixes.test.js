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
    update: { seat_layout_enabled: true },
    create: { id: 1, seat_layout_enabled: true }
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
  });
});
