import test from 'node:test';
import assert from 'node:assert/strict';
import prisma from '../src/prismaClient.js';
import { previewPublish, publishLayout } from '../src/controllers/seatLayoutController.js';
import { toTaipeiDateString, dateOnly } from '../../shared/time.js';

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

test('Layout publish reseat tests (Spec 1.5)', async (t) => {
  const todayStr = toTaipeiDateString(new Date());
  const todayDate = dateOnly(todayStr);

  // Setup test user
  const user = await prisma.user.upsert({
    where: { line_user_id: 'test_reseat_user' },
    update: { name: '換座測試客' },
    create: { line_user_id: 'test_reseat_user', name: '換座測試客', phone: '0900111222' }
  });

  const createdLayoutIds = [];
  const createdSessionIds = [];
  const createdBookingRefs = [];

  const cleanup = async () => {
    if (createdBookingRefs.length > 0) {
      await prisma.payment.deleteMany({ where: { booking_ref: { in: createdBookingRefs } } });
      await prisma.timerPause.deleteMany({ where: { person: { booking_ref: { in: createdBookingRefs } } } });
      await prisma.bookingPerson.deleteMany({ where: { booking_ref: { in: createdBookingRefs } } });
      await prisma.bookingEquipment.deleteMany({ where: { booking_ref: { in: createdBookingRefs } } });
      await prisma.reservation.deleteMany({ where: { booking_ref: { in: createdBookingRefs } } });
    }
    if (createdSessionIds.length > 0) {
      await prisma.reservation.deleteMany({ where: { session_id: { in: createdSessionIds } } });
      await prisma.session.deleteMany({ where: { id: { in: createdSessionIds } } });
    }
    if (createdLayoutIds.length > 0) {
      await prisma.seat.deleteMany({ where: { layout_id: { in: createdLayoutIds } } });
      await prisma.seatTable.deleteMany({ where: { layout_id: { in: createdLayoutIds } } });
      await prisma.seatZone.deleteMany({ where: { layout_id: { in: createdLayoutIds } } });
      await prisma.seatLayout.deleteMany({ where: { id: { in: createdLayoutIds } } });
    }
  };

  t.after(async () => {
    await cleanup();
  });

  // Ensure global settings
  await prisma.globalSetting.upsert({
    where: { id: 1 },
    update: { seat_layout_enabled: true },
    create: { id: 1, seat_layout_enabled: true }
  });

  // Helper to create a base layout
  async function createTestLayout(name, seatCodes, status = 'published') {
    const layout = await prisma.seatLayout.create({
      data: {
        name,
        status,
        effective_from: todayDate,
        capacity: seatCodes.length,
        canvas_w: 1000,
        canvas_h: 625,
        published_by_name: '店長',
        published_at: new Date(),
        rules_json: {
          spread_tables: true,
          avoid_opposite: true,
          avoid_beside: true,
          zone_mode: 'empty_tables_first'
        }
      }
    });
    createdLayoutIds.push(layout.id);

    const zone = await prisma.seatZone.create({
      data: { layout_id: layout.id, name: '主區', sort_order: 0 }
    });

    const table = await prisma.seatTable.create({
      data: {
        layout_id: layout.id,
        zone_id: zone.id,
        label: 'T1',
        cx: 300,
        cy: 300,
        w: 100,
        h: 100,
        sort_order: 0
      }
    });

    for (let i = 0; i < seatCodes.length; i++) {
      await prisma.seat.create({
        data: {
          layout_id: layout.id,
          zone_id: zone.id,
          table_id: table.id,
          code: seatCodes[i],
          lx: (i % 2 === 0 ? -40 : 40),
          ly: (Math.floor(i / 2) * 40 - 40),
          sort_order: i,
          is_active: true
        }
      });
    }

    return layout;
  }

  // Helper to get or create a session
  async function getOrCreateTestSession(start_time, end_time, sessionDate = todayDate) {
    let session = await prisma.session.findFirst({
      where: { session_date: sessionDate, start_time }
    });
    if (!session) {
      session = await prisma.session.create({
        data: {
          session_date: sessionDate,
          start_time,
          end_time,
          max_capacity: 16
        }
      });
      createdSessionIds.push(session.id);
    } else if (session.end_time !== end_time) {
      session = await prisma.session.update({
        where: { id: session.id },
        data: { end_time }
      });
    }
    return session;
  }

  // Initial base layout: B1-1, B1-2, B1-3, B1-4, A1-1, A1-2
  await createTestLayout('舊版面', ['B1-1', 'B1-2', 'B1-3', 'B1-4', 'A1-1', 'A1-2']);

  await t.test('1. 已結清訂單不擋：今天有一筆已結清、已離場的訂單坐在 B1-1，刪除 B1-1 後發布，結果成功，那筆訂單的 assigned_seats 不變', async () => {
    const session = await getOrCreateTestSession('10:00', '12:00');
    const bRef = 'BK-TEST-RESEAT-1';
    createdBookingRefs.push(bRef);

    const r = await prisma.reservation.create({
      data: {
        booking_ref: bRef,
        user_id: user.id,
        session_id: session.id,
        pax: 1,
        status: 'confirmed',
        attendance: 'completed',
        is_paid: true,
        assigned_seats: ['B1-1'],
        total_amount: 300
      }
    });

    await prisma.bookingPerson.create({
      data: {
        booking_ref: bRef,
        person_no: 1,
        seat_code: 'B1-1',
        status: 'active',
        timer_started_at: new Date(Date.now() - 7200000),
        timer_ended_at: new Date(Date.now() - 3600000)
      }
    });

    // Create draft layout without B1-1 (only has B1-2, B1-3, B1-4, A1-1, A1-2)
    const draft = await createTestLayout('新草稿1', ['B1-2', 'B1-3', 'B1-4', 'A1-1', 'A1-2'], 'draft');

    const { req, res } = createMockReqRes({
      params: { id: draft.id },
      body: { effective_from: todayStr, confirm: true }
    });

    await publishLayout(req, res);

    assert.equal(res.getStatusCode(), 200, `Expected 200 but got ${res.getStatusCode()}: ${JSON.stringify(res.getResponseData())}`);

    // Verify reservation's assigned_seats unchanged
    const afterRes = await prisma.reservation.findUnique({ where: { id: r.id } });
    assert.deepEqual(afterRes.assigned_seats, ['B1-1'], 'Historical completed booking assigned_seats must remain B1-1');
  });

  await t.test('2. 在場客人換座：一筆正在計時的訂單坐在 B1-1、B1-2，刪除這兩個座位後發布，結果成功', async () => {
    const session = await getOrCreateTestSession('14:00', '23:59');
    const bRef = 'BK-TEST-RESEAT-2';
    createdBookingRefs.push(bRef);

    const timerStart = new Date(Date.now() - 3600000); // started 1 hr ago
    const pauseStart = new Date(Date.now() - 1800000); // paused 30m ago

    const r = await prisma.reservation.create({
      data: {
        booking_ref: bRef,
        user_id: user.id,
        session_id: session.id,
        pax: 2,
        status: 'confirmed',
        attendance: 'checked_in',
        checked_in_at: timerStart,
        assigned_seats: ['B1-1', 'B1-2'],
        total_amount: 600
      }
    });

    const p1 = await prisma.bookingPerson.create({
      data: {
        booking_ref: bRef,
        person_no: 1,
        seat_code: 'B1-1',
        status: 'active',
        timer_started_at: timerStart,
        paused_at: pauseStart
      }
    });

    await prisma.timerPause.create({
      data: {
        person_id: p1.id,
        started_at: pauseStart,
        reason: '外出用餐',
        staff_name: '店員'
      }
    });

    const p2 = await prisma.bookingPerson.create({
      data: {
        booking_ref: bRef,
        person_no: 2,
        seat_code: 'B1-2',
        status: 'active',
        timer_started_at: timerStart
      }
    });

    const pay = await prisma.payment.create({
      data: {
        payment_no: 'R-TEST-001',
        batch_no: 'B-TEST-001',
        booking_ref: bRef,
        kind: 'charge',
        method: 'cash',
        amount: 600,
        person_nos: [1, 2],
        breakdown_json: {},
        staff_name: '店長',
        device_label: '櫃檯'
      }
    });

    // Draft removes B1-1 and B1-2, has new seats 2-1, 2-2, A1-1, A1-2
    const draft = await createTestLayout('新草稿2', ['2-1', '2-2', 'A1-1', 'A1-2'], 'draft');

    // 1. Preview publish test
    const { req: pReq, res: pRes } = createMockReqRes({
      params: { id: draft.id },
      body: { effective_from: todayStr }
    });
    await previewPublish(pReq, pRes);
    assert.equal(pRes.getStatusCode(), 200);
    const previewData = pRes.getResponseData();
    assert.ok(previewData.category_c || previewData.in_store_reseat, 'Preview should include category C reseat suggestions');

    // 2. Publish layout test
    const { req, res } = createMockReqRes({
      params: { id: draft.id },
      body: { effective_from: todayStr, confirm: true }
    });
    await publishLayout(req, res);
    assert.equal(res.getStatusCode(), 200, `Publish failed: ${JSON.stringify(res.getResponseData())}`);

    // Verify seats updated to new layout seats
    const updatedRes = await prisma.reservation.findUnique({ where: { id: r.id } });
    assert.ok(!updatedRes.assigned_seats.includes('B1-1') && !updatedRes.assigned_seats.includes('B1-2'), 'Should not sit on deleted seats');
    assert.equal(updatedRes.assigned_seats.length, 2);

    const updatedP1 = await prisma.bookingPerson.findUnique({ where: { id: p1.id }, include: { pauses: true } });
    const updatedP2 = await prisma.bookingPerson.findUnique({ where: { id: p2.id } });

    assert.equal(updatedP1.seat_code, updatedRes.assigned_seats[0]);
    assert.equal(updatedP2.seat_code, updatedRes.assigned_seats[1]);

    // Timers, pauses, payment snapshots untouched
    assert.equal(updatedP1.timer_started_at.getTime(), timerStart.getTime(), 'timer_started_at must not change');
    assert.equal(updatedP1.pauses.length, 1, 'Pause records must not change');
    assert.equal(updatedP1.pauses[0].reason, '外出用餐');

    const paymentAfter = await prisma.payment.findUnique({ where: { id: pay.id } });
    assert.equal(paymentAfter.amount, 600, 'Payment snapshot must not change');
  });

  await t.test('3. 未到預約改排：晚上的預約坐在要刪除的座位上，發布後改排到新座位。整段時間的座位一致', async () => {
    const tomorrowStr = toTaipeiDateString(new Date(Date.now() + 86400000));
    const tomorrowDate = dateOnly(tomorrowStr);
    const s1 = await getOrCreateTestSession('19:00', '20:00', tomorrowDate);
    const s2 = await getOrCreateTestSession('20:00', '21:00', tomorrowDate);
    const bRef = 'BK-TEST-RESEAT-3';
    createdBookingRefs.push(bRef);

    const r1 = await prisma.reservation.create({
      data: {
        booking_ref: bRef,
        user_id: user.id,
        session_id: s1.id,
        pax: 2,
        status: 'confirmed',
        attendance: 'pending',
        assigned_seats: ['B1-3', 'B1-4'],
        total_amount: 600
      }
    });

    const r2 = await prisma.reservation.create({
      data: {
        booking_ref: bRef,
        user_id: user.id,
        session_id: s2.id,
        pax: 2,
        status: 'confirmed',
        attendance: 'pending',
        assigned_seats: ['B1-3', 'B1-4'],
        total_amount: 600
      }
    });

    // Draft removes B1-3 and B1-4, has 3-1, 3-2, 3-3, 3-4
    const draft = await createTestLayout('新草稿3', ['3-1', '3-2', '3-3', '3-4'], 'draft');

    const { req, res } = createMockReqRes({
      params: { id: draft.id },
      body: { effective_from: todayStr, confirm: true }
    });

    await publishLayout(req, res);
    assert.equal(res.getStatusCode(), 200, `Publish failed: ${JSON.stringify(res.getResponseData())}`);

    const res1After = await prisma.reservation.findUnique({ where: { id: r1.id } });
    const res2After = await prisma.reservation.findUnique({ where: { id: r2.id } });

    assert.ok(!res1After.assigned_seats.includes('B1-3'), 'Must be reseated from deleted B1-3');
    assert.deepEqual(res1After.assigned_seats, res2After.assigned_seats, 'Seats must be consistent across all sessions');
  });

  await t.test('4. 新版面太小：放不下的訂單進入等待區，並列入 needs_manual，發布仍然成功', async () => {
    const tomorrowStr = toTaipeiDateString(new Date(Date.now() + 86400000));
    const tomorrowDate = dateOnly(tomorrowStr);
    const s = await getOrCreateTestSession('21:00', '22:00', tomorrowDate);
    const bRef = 'BK-TEST-RESEAT-4';
    createdBookingRefs.push(bRef);

    const r = await prisma.reservation.create({
      data: {
        booking_ref: bRef,
        user_id: user.id,
        session_id: s.id,
        pax: 4,
        status: 'confirmed',
        attendance: 'pending',
        assigned_seats: ['DEL-1', 'DEL-2', 'DEL-3', 'DEL-4'],
        total_amount: 1200
      }
    });

    // Draft has only 1 regular seat
    const draft = await createTestLayout('新草稿4', ['ONLY-1'], 'draft');

    const { req, res } = createMockReqRes({
      params: { id: draft.id },
      body: { effective_from: todayStr, confirm: true }
    });

    await publishLayout(req, res);
    assert.equal(res.getStatusCode(), 200, `Expected 200 publish success: ${JSON.stringify(res.getResponseData())}`);

    const resAfter = await prisma.reservation.findUnique({ where: { id: r.id } });
    assert.ok(resAfter.assigned_seats.some(s => s.startsWith('WAIT-')), 'Should be placed in waiting area WAIT-n');

    const data = res.getResponseData();
    assert.ok(data.needs_manual?.some(nm => nm.booking_ref === bRef), 'Should be listed in needs_manual');
  });

  await t.test('5. 極少數擋下的情況：新版面座位數加上等待區都放不下目前在場的人數，回 409，訊息提示不夠在場客人', async () => {
    const s = await getOrCreateTestSession('13:00', '23:59');
    const bRef = 'BK-TEST-RESEAT-5';
    createdBookingRefs.push(bRef);

    // 10 people actively seated
    await prisma.reservation.create({
      data: {
        booking_ref: bRef,
        user_id: user.id,
        session_id: s.id,
        pax: 10,
        status: 'confirmed',
        attendance: 'checked_in',
        checked_in_at: new Date(),
        assigned_seats: ['S-1', 'S-2', 'S-3', 'S-4', 'S-5', 'S-6', 'S-7', 'S-8', 'S-9', 'S-10'],
        total_amount: 3000
      }
    });

    for (let i = 1; i <= 10; i++) {
      await prisma.bookingPerson.create({
        data: {
          booking_ref: bRef,
          person_no: i,
          seat_code: `S-${i}`,
          status: 'active',
          timer_started_at: new Date()
        }
      });
    }

    // New draft has only 1 seat, and max_wait_capacity is 0 (or total seats + wait < 10)
    const draft = await createTestLayout('極小草稿', ['T-1'], 'draft');
    await prisma.seatLayout.update({
      where: { id: draft.id },
      data: { rules_json: { max_wait_capacity: 0 } }
    });

    const { req, res } = createMockReqRes({
      params: { id: draft.id },
      body: { effective_from: todayStr, confirm: true }
    });

    await publishLayout(req, res);
    assert.equal(res.getStatusCode(), 409, `Expected 409 when in-store guests exceed total layout+waiting capacity`);

    const data = res.getResponseData();
    assert.match(data.error, /新版面的座位不夠目前在場的 \d+ 位客人，請先調整版面或等客人離場/);

    await prisma.bookingPerson.deleteMany({ where: { booking_ref: bRef } });
    await prisma.reservation.deleteMany({ where: { booking_ref: bRef } });
  });

  await t.test('7. 在場客人超時未結清換座：即使預約時段已過，只要正在計時且未結清，發布版面時仍列為 Category C 並改排建議座位', async () => {
    // Session in the past relative to now (e.g. 10:00-11:00 today)
    const s = await getOrCreateTestSession('10:00', '11:00');
    const bRef = 'BK-TEST-RESEAT-7-OVERDUE';
    createdBookingRefs.push(bRef);

    const timerStart = new Date(Date.now() - 3600000);
    const r = await prisma.reservation.create({
      data: {
        booking_ref: bRef,
        user_id: user.id,
        session_id: s.id,
        pax: 2,
        status: 'confirmed',
        attendance: 'checked_in',
        checked_in_at: timerStart,
        assigned_seats: ['B1-1', 'B1-2'],
        total_amount: 600
      }
    });

    await prisma.bookingPerson.createMany({
      data: [
        { booking_ref: bRef, person_no: 1, seat_code: 'B1-1', status: 'active', timer_started_at: timerStart },
        { booking_ref: bRef, person_no: 2, seat_code: 'B1-2', status: 'active', timer_started_at: timerStart }
      ]
    });

    // Draft removes B1-1 and B1-2, has 7-1, 7-2
    const draft = await createTestLayout('新草稿7', ['7-1', '7-2', 'A1-1', 'A1-2'], 'draft');

    // 1. Preview publish: Must be classified into Category C, not ignored as Category A
    const { req: pReq, res: pRes } = createMockReqRes({
      params: { id: draft.id },
      body: { effective_from: todayStr }
    });
    await previewPublish(pReq, pRes);
    assert.equal(pRes.getStatusCode(), 200);
    const pData = pRes.getResponseData();
    assert.ok(pData.category_c?.some(c => c.booking_ref === bRef), 'Overdue in-store guest must be in Category C');

    // 2. Publish: Must update seats and retain active timer
    const { req, res } = createMockReqRes({
      params: { id: draft.id },
      body: { effective_from: todayStr, confirm: true }
    });
    await publishLayout(req, res);
    assert.equal(res.getStatusCode(), 200);

    const rAfter = await prisma.reservation.findUnique({ where: { id: r.id } });
    assert.ok(!rAfter.assigned_seats.includes('B1-1'), 'Seats should be updated');
    const p1After = await prisma.bookingPerson.findFirst({ where: { booking_ref: bRef, person_no: 1 } });
    assert.equal(p1After.timer_started_at.getTime(), timerStart.getTime(), 'Timer must be untouched');
  });
});
