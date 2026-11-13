import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import prisma from '../src/prismaClient.js';
import { calculateBoardTotal } from '../../shared/boardPricing.js';
import { handleTimer, pauseBoard, resumeBoard, swapBoard } from '../src/controllers/floorController.js';
import { getBookingBill } from '../src/services/billing/billService.js';
import { dateOnly } from '../../shared/time.js';

function createMockReqRes({ body = {}, params = {}, user = { name: '店長', id: 1 } }) {
  const req = {
    body,
    params,
    query: {},
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

test('Round 23 Item 2: calculateBoardTotal subtracts pause minutes before rounding', () => {
  const discountConfig = {
    enabled: true,
    buy_hours: 3,
    free_hours: 1,
    stackable: true
  };

  // 14:00–18:00 (240 分) 扣掉 15:28–15:40 (12 分) -> 剩 228 分，套半小時取整 = 4 小時
  const calc4h = calculateBoardTotal({
    segments: [
      {
        start_at: '2026-11-21T14:00:00+08:00',
        end_at: '2026-11-21T18:00:00+08:00',
        rate: 90,
        name: '小板'
      }
    ],
    pauses: [
      {
        started_at: '2026-11-21T15:28:00+08:00',
        ended_at: '2026-11-21T15:40:00+08:00'
      }
    ],
    discountConfig
  });
  assert.equal(calc4h.pausedMinutes, 12);
  assert.equal(calc4h.effectiveMinutes, 228);
  assert.equal(calc4h.H, 4);

  // 14:00–17:15 (195 分, 原本 3.5h) 扣 12 分 -> 183 分 -> 取整降成 3.0h
  const calcDropBlock = calculateBoardTotal({
    segments: [
      {
        start_at: '2026-11-21T14:00:00+08:00',
        end_at: '2026-11-21T17:15:00+08:00',
        rate: 90,
        name: '小板'
      }
    ],
    pauses: [
      {
        started_at: '2026-11-21T15:28:00+08:00',
        ended_at: '2026-11-21T15:40:00+08:00'
      }
    ],
    discountConfig
  });
  assert.equal(calcDropBlock.pausedMinutes, 12);
  assert.equal(calcDropBlock.effectiveMinutes, 183);
  assert.equal(calcDropBlock.H, 3);
});

test('Round 23 Item 2: BoardPause controller & bill integration tests', async (t) => {
  const prevNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'test';

  const dateStr = '2026-11-21';
  const dbDate = dateOnly(dateStr);
  const createdBookingRefs = [];
  const createdUnitGroups = [];
  const createdSessionIds = [];

  await prisma.globalSetting.upsert({
    where: { id: 1 },
    update: {},
    create: { id: 1 }
  });

  await prisma.equipmentConfig.upsert({
    where: { id: 'pegboard_s' },
    update: { name: '小板 (52×52)', hourly_rate: 90, total_stock: 10 },
    create: { id: 'pegboard_s', name: '小板 (52×52)', hourly_rate: 90, total_stock: 10 }
  });
  await prisma.equipmentConfig.upsert({
    where: { id: 'pegboard_m' },
    update: { name: '中板 (78×78)', hourly_rate: 120, total_stock: 10 },
    create: { id: 'pegboard_m', name: '中板 (78×78)', hourly_rate: 120, total_stock: 10 }
  });

  const testUser = await prisma.user.upsert({
    where: { line_user_id: 'test_user_round23_bp' },
    update: { name: '板暫停測試客' },
    create: { line_user_id: 'test_user_round23_bp', name: '板暫停測試客', phone: '0911222333' }
  });

  const s14Existing = await prisma.session.findUnique({
    where: { session_date_start_time: { session_date: dbDate, start_time: '14:00' } }
  });
  const s14 = s14Existing || await prisma.session.create({
    data: { session_date: dbDate, start_time: '14:00', end_time: '16:00', max_capacity: 20 }
  });
  if (!s14Existing) createdSessionIds.push(s14.id);

  const s16Existing = await prisma.session.findUnique({
    where: { session_date_start_time: { session_date: dbDate, start_time: '16:00' } }
  });
  const s16 = s16Existing || await prisma.session.create({
    data: { session_date: dbDate, start_time: '16:00', end_time: '18:00', max_capacity: 20 }
  });
  if (!s16Existing) createdSessionIds.push(s16.id);

  async function seedSeatedWithBoard(suffix) {
    const bRef = `BK-R23BP-${suffix}`;
    const uGroup = crypto.randomUUID();
    createdBookingRefs.push(bRef);
    createdUnitGroups.push(uGroup);

    const startDt = new Date(`${dateStr}T14:00:00+08:00`);
    const endDt = new Date(`${dateStr}T18:00:00+08:00`);

    await prisma.reservation.create({
      data: {
        user_id: testUser.id,
        session_id: s14.id,
        pax: 1,
        booking_ref: bRef,
        status: 'confirmed',
        attendance: 'checked_in',
        assigned_seats: ['1-1']
      }
    });
    await prisma.reservation.create({
      data: {
        user_id: testUser.id,
        session_id: s16.id,
        pax: 1,
        booking_ref: bRef,
        status: 'confirmed',
        attendance: 'checked_in',
        assigned_seats: ['1-1']
      }
    });

    const person = await prisma.bookingPerson.create({
      data: {
        booking_ref: bRef,
        person_no: 1,
        seat_code: '1-1',
        status: 'active',
        billing_start_at: startDt,
        timer_started_at: startDt
      }
    });

    await prisma.bookingEquipment.create({
      data: {
        booking_ref: bRef,
        equipment_id: 'pegboard_s',
        equipment_name_snapshot: '小板 (52×52)',
        quantity: 1,
        rental_hours: 4,
        subtotal_price: 270,
        covered_sessions: [String(s14.id), String(s16.id)],
        person_id: person.id,
        unit_group: uGroup,
        segment_no: 1,
        start_at: startDt,
        planned_end_at: endDt,
        unit_rate: 90
      }
    });

    return { bRef, uGroup, person, startDt, endDt };
  }

  async function cleanupTestData() {
    const r23Equips = await prisma.bookingEquipment.findMany({
      where: { booking_ref: { startsWith: 'BK-R23BP-' } },
      select: { unit_group: true }
    });
    const allUgs = [...new Set([...createdUnitGroups, ...r23Equips.map(e => e.unit_group).filter(Boolean)])];
    if (allUgs.length) {
      await prisma.boardPause.deleteMany({ where: { unit_group: { in: allUgs } } });
    }
    await prisma.bookingEquipment.deleteMany({ where: { booking_ref: { startsWith: 'BK-R23BP-' } } });
    await prisma.timerPause.deleteMany({ where: { person: { booking_ref: { startsWith: 'BK-R23BP-' } } } });
    await prisma.bookingPerson.deleteMany({ where: { booking_ref: { startsWith: 'BK-R23BP-' } } });
    await prisma.payment.deleteMany({ where: { booking_ref: { startsWith: 'BK-R23BP-' } } });
    await prisma.reservation.deleteMany({ where: { booking_ref: { startsWith: 'BK-R23BP-' } } });
  }

  await cleanupTestData();

  t.after(async () => {
    process.env.NODE_ENV = prevNodeEnv;
    await cleanupTestData();
    if (createdSessionIds.length) {
      await prisma.session.deleteMany({ where: { id: { in: createdSessionIds } } });
    }
    await prisma.user.deleteMany({ where: { line_user_id: 'test_user_round23_bp' } });
  });

  await t.test('1. 板子 14:00–18:00，客人 15:28–15:40 暫停：板子計費扣掉 12 分鐘', async () => {
    const { bRef, uGroup } = await seedSeatedWithBoard('CASE1');

    const { req: reqP, res: resP } = createMockReqRes({
      params: { booking_ref: bRef },
      body: { action: 'pause', person_nos: [1], now: `${dateStr}T15:28:00+08:00`, reason: '休息' }
    });
    await handleTimer(reqP, resP);
    assert.equal(resP.getStatusCode(), 200);

    const openBp = await prisma.boardPause.findFirst({ where: { unit_group: uGroup, ended_at: null } });
    assert.ok(openBp, 'BoardPause should open when person pauses');
    assert.equal(openBp.source, 'person');

    const { req: reqR, res: resR } = createMockReqRes({
      params: { booking_ref: bRef },
      body: { action: 'resume', person_nos: [1], now: `${dateStr}T15:40:00+08:00` }
    });
    await handleTimer(reqR, resR);
    assert.equal(resR.getStatusCode(), 200);

    const pauses = await prisma.boardPause.findMany({ where: { unit_group: uGroup } });
    assert.equal(pauses.length, 1);
    assert.ok(pauses[0].ended_at, 'BoardPause should close when person resumes');

    const { bill } = await getBookingBill(bRef, prisma, new Date(`${dateStr}T18:00:00+08:00`));
    const boardUnit = bill.persons[0].board.units[0];
    assert.equal(boardUnit.pausedMinutes, 12);
    assert.equal(boardUnit.effectiveMinutes, 228);
  });

  await t.test('2. 單獨暫停 30 分鐘後繼續：板子計費扣掉 30 分鐘，客人計時不受影響', async () => {
    const { bRef, uGroup, person } = await seedSeatedWithBoard('CASE2');

    const { req: reqP, res: resP } = createMockReqRes({
      params: { booking_ref: bRef, unit_group: uGroup },
      body: { at: `${dateStr}T15:00:00+08:00` }
    });
    await pauseBoard(reqP, resP);
    assert.equal(resP.getStatusCode(), 200);

    const personDuringPause = await prisma.bookingPerson.findUnique({ where: { id: person.id }, include: { pauses: true } });
    assert.equal(personDuringPause.paused_at, null, 'Person timer must NOT pause during solo board pause');
    assert.equal(personDuringPause.pauses.length, 0);

    const { req: reqR, res: resR } = createMockReqRes({
      params: { booking_ref: bRef, unit_group: uGroup },
      body: { at: `${dateStr}T15:30:00+08:00` }
    });
    await resumeBoard(reqR, resR);
    assert.equal(resR.getStatusCode(), 200);

    const personAfterResume = await prisma.bookingPerson.findUnique({ where: { id: person.id } });
    assert.equal(personAfterResume.paused_seconds, 0);

    const { bill } = await getBookingBill(bRef, prisma, new Date(`${dateStr}T18:00:00+08:00`));
    const boardUnit = bill.persons[0].board.units[0];
    assert.equal(boardUnit.pausedMinutes, 30);
    assert.equal(boardUnit.effectiveMinutes, 210);
    assert.equal(boardUnit.H, 3.5);
    assert.equal(bill.persons[0].entry.hours, 4, 'Guest entry timer stays 4 hours untouched');
  });

  await t.test('3. 暫停中換板：舊的那段結束暫停，新的那段不帶暫停', async () => {
    const { bRef, uGroup } = await seedSeatedWithBoard('CASE3');

    const { req: reqP, res: resP } = createMockReqRes({
      params: { booking_ref: bRef, unit_group: uGroup },
      body: { at: `${dateStr}T15:00:00+08:00` }
    });
    await pauseBoard(reqP, resP);
    assert.equal(resP.getStatusCode(), 200);

    const { req: reqS, res: resS } = createMockReqRes({
      params: { booking_ref: bRef, unit_group: uGroup },
      body: {
        to_equipment_id: 'pegboard_m',
        boundary_at: `${dateStr}T15:30:00+08:00`,
        now: `${dateStr}T15:30:00+08:00`
      }
    });
    await swapBoard(reqS, resS);
    assert.equal(resS.getStatusCode(), 200);

    const openAfterSwap = await prisma.boardPause.findMany({ where: { unit_group: uGroup, ended_at: null } });
    assert.equal(openAfterSwap.length, 0, 'No open BoardPause should remain after swap');

    const closedPauses = await prisma.boardPause.findMany({ where: { unit_group: uGroup } });
    assert.equal(closedPauses.length, 1);
    assert.equal(closedPauses[0].ended_at.toISOString(), new Date(`${dateStr}T15:30:00+08:00`).toISOString());

    const segs = await prisma.bookingEquipment.findMany({
      where: { booking_ref: bRef, unit_group: uGroup },
      orderBy: { segment_no: 'asc' }
    });
    assert.equal(segs.length, 2);
    assert.equal(segs[0].ended_reason, 'swapped');
    assert.equal(segs[1].equipment_id, 'pegboard_m');
    assert.equal(segs[1].start_at.toISOString(), new Date(`${dateStr}T15:30:00+08:00`).toISOString());

    const { bill } = await getBookingBill(bRef, prisma, new Date(`${dateStr}T18:00:00+08:00`));
    const boardUnit = bill.persons[0].board.units[0];
    // Segment 1 (14:00-15:30 = 90m) minus 30m pause = 60m (1h * 90 = 90); Segment 2 (15:30-18:00 = 150m) 0m pause = 2.5h * 120 = 300; H = 3.5h
    assert.equal(boardUnit.pausedMinutes, 30);
    assert.equal(boardUnit.effectiveMinutes, 210);
    assert.equal(boardUnit.H, 3.5);
  });
});
