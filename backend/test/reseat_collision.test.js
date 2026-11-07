import test from 'node:test';
import assert from 'node:assert/strict';
import prisma from '../src/prismaClient.js';
import { checkIn } from '../src/controllers/floorController.js';
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

test('Reseat collision and displacement tests (Section 1.2)', async (t) => {
  const TS = Date.now();
  const testDate = dateOnly('2026-11-28');

  // Setup GlobalSetting
  await prisma.globalSetting.upsert({
    where: { id: 1 },
    update: { seat_layout_enabled: true },
    create: { id: 1, seat_layout_enabled: true }
  });

  // Setup Users
  const user1 = await prisma.user.upsert({
    where: { line_user_id: `test_user_g1_${TS}` },
    update: { name: '組1預約客' },
    create: { line_user_id: `test_user_g1_${TS}`, name: '組1預約客', phone: '0901000001' }
  });
  const user7 = await prisma.user.upsert({
    where: { line_user_id: `test_user_g7_${TS}` },
    update: { name: '組7預約客' },
    create: { line_user_id: `test_user_g7_${TS}`, name: '組7預約客', phone: '0907000007' }
  });
  const userWang = await prisma.user.upsert({
    where: { line_user_id: `test_user_wang_${TS}` },
    update: { name: '現場王' },
    create: { line_user_id: `test_user_wang_${TS}`, name: '現場王', phone: '0909000009' }
  });

  // Create layout with Table 1 (1-1, 1-2) and Table 3 (3-3, 3-4)
  const layout = await prisma.seatLayout.create({
    data: {
      name: `測試格局_${TS}`,
      status: 'published',
      effective_from: testDate,
      canvas_w: 1000,
      canvas_h: 625,
      capacity: 4,
      rules_json: {
        spread_tables: false,
        avoid_opposite: false,
        avoid_beside: false,
        zone_mode: 'empty_tables_first',
        weights: { zone: 1, zone_fill_first: 50, opposite: 3, beside: 6, second: 20, last: 100, split: 4 }
      },
      zones: {
        create: [{ name: '一般區', sort_order: 0 }]
      }
    },
    include: { zones: true }
  });

  const zoneId = layout.zones[0].id;

  const table1 = await prisma.seatTable.create({
    data: {
      layout_id: layout.id,
      zone_id: zoneId,
      label: '桌1',
      shape: 'rect',
      arrangement: 'one_side',
      cx: 200,
      cy: 200,
      w: 80,
      h: 120,
      sort_order: 1
    }
  });

  const table3 = await prisma.seatTable.create({
    data: {
      layout_id: layout.id,
      zone_id: zoneId,
      label: '桌3',
      shape: 'rect',
      arrangement: 'one_side',
      cx: 500,
      cy: 200,
      w: 80,
      h: 120,
      sort_order: 3
    }
  });

  await prisma.seat.createMany({
    data: [
      { layout_id: layout.id, table_id: table1.id, zone_id: zoneId, code: '1-1', lx: -40, ly: -30, side_mode: 'auto', priority: 'normal', is_active: true, sort_order: 0 },
      { layout_id: layout.id, table_id: table1.id, zone_id: zoneId, code: '1-2', lx: -40, ly: 30, side_mode: 'auto', priority: 'normal', is_active: true, sort_order: 1 },
      { layout_id: layout.id, table_id: table3.id, zone_id: zoneId, code: '3-3', lx: -40, ly: -30, side_mode: 'auto', priority: 'normal', is_active: true, sort_order: 0 },
      { layout_id: layout.id, table_id: table3.id, zone_id: zoneId, code: '3-4', lx: -40, ly: 30, side_mode: 'auto', priority: 'normal', is_active: true, sort_order: 1 }
    ]
  });

  // Sessions: 21:00-22:00 (sess21), 22:00-23:00 (sess22)
  const sess21 = await prisma.session.create({
    data: { session_date: testDate, start_time: '21:00', end_time: '22:00', max_capacity: 4 }
  });
  const sess22 = await prisma.session.create({
    data: { session_date: testDate, start_time: '22:00', end_time: '23:00', max_capacity: 4 }
  });

  // Helper to verify 0 collisions
  async function assertZeroCollisions() {
    const collisions = await prisma.$queryRawUnsafe(`
      select session_id, seat, count(distinct booking_ref)::int as count
      from "Reservation", unnest(assigned_seats) seat
      where status <> 'cancelled' and seat not like 'WAIT-%'
      group by 1, 2 having count(distinct booking_ref) > 1;
    `);
    assert.equal(collisions.length, 0, `Expected 0 duplicate seat assignments, but found: ${JSON.stringify(collisions)}`);
  }

  t.after(async () => {
    await prisma.bookingPerson.deleteMany({ where: { booking_ref: { startsWith: `BK-RESEAT-${TS}-` } } });
    await prisma.reservation.deleteMany({ where: { session_id: { in: [sess21.id, sess22.id] } } });
    await prisma.session.deleteMany({ where: { id: { in: [sess21.id, sess22.id] } } });
    await prisma.seat.deleteMany({ where: { layout_id: layout.id } });
    await prisma.seatTable.deleteMany({ where: { layout_id: layout.id } });
    await prisma.seatZone.deleteMany({ where: { layout_id: layout.id } });
    await prisma.seatLayout.delete({ where: { id: layout.id } });
  });

  await t.test('1. 重現情境：組1在1-1、1-2，組7在3-3。現場王報到選1-1，組1挪到3-3、3-4，組7挪到1-2，無重複', async () => {
    const bG1 = `BK-RESEAT-${TS}-G1`;
    const bG7 = `BK-RESEAT-${TS}-G7`;
    const bWang = `BK-RESEAT-${TS}-WANG`;

    // Group 1: 2 pax, at sess22, seats 1-1, 1-2
    await prisma.reservation.create({
      data: {
        booking_ref: bG1,
        user_id: user1.id,
        session_id: sess22.id,
        pax: 2,
        assigned_seats: ['1-1', '1-2'],
        status: 'confirmed',
        attendance: 'confirmed',
        seat_source: 'auto',
        is_seat_locked: false
      }
    });

    // Group 7: 1 pax, at sess22, seat 3-3
    await prisma.reservation.create({
      data: {
        booking_ref: bG7,
        user_id: user7.id,
        session_id: sess22.id,
        pax: 1,
        assigned_seats: ['3-3'],
        status: 'confirmed',
        attendance: 'confirmed',
        seat_source: 'auto',
        is_seat_locked: false
      }
    });

    // Wang: 1 pax, walk-in at sess22
    await prisma.reservation.create({
      data: {
        booking_ref: bWang,
        user_id: userWang.id,
        session_id: sess22.id,
        pax: 1,
        assigned_seats: ['WAIT-1'],
        status: 'confirmed',
        is_walk_in: true
      }
    });

    // Check-in Wang to 1-1
    const { req, res } = createMockReqRes({
      params: { booking_ref: bWang },
      body: { seats: ['1-1'] }
    });

    await checkIn(req, res);
    assert.equal(res.getStatusCode(), 200, 'Check in should succeed');

    const resWang = await prisma.reservation.findFirst({ where: { booking_ref: bWang, session_id: sess22.id } });
    const resG1 = await prisma.reservation.findFirst({ where: { booking_ref: bG1, session_id: sess22.id } });
    const resG7 = await prisma.reservation.findFirst({ where: { booking_ref: bG7, session_id: sess22.id } });

    assert.deepEqual(resWang.assigned_seats, ['1-1']);
    // Group 1 moved to 3-3, 3-4
    assert.deepEqual(resG1.assigned_seats.sort(), ['3-3', '3-4']);
    // Group 7 moved to 1-2
    assert.deepEqual(resG7.assigned_seats, ['1-2']);

    // Check displaced list returned in response includes both G1 and G7!
    const respData = res.getResponseData();
    assert.ok(respData.displaced?.some(d => d.booking_ref === bG1), 'G1 should be in displaced');
    assert.ok(respData.displaced?.some(d => d.booking_ref === bG7), 'G7 should be in displaced');

    await assertZeroCollisions();

    // Clean up
    await prisma.bookingPerson.deleteMany({ where: { booking_ref: { in: [bG1, bG7, bWang] } } });
    await prisma.reservation.deleteMany({ where: { booking_ref: { in: [bG1, bG7, bWang] } } });
  });

  await t.test('2. 座位真的不夠時：回 409，所有預約的座位都和報到前完全一樣', async () => {
    const bG1 = `BK-RESEAT-${TS}-FULL-G1`;
    const bG7 = `BK-RESEAT-${TS}-FULL-G7`;
    const bG8 = `BK-RESEAT-${TS}-FULL-G8`;
    const bWang = `BK-RESEAT-${TS}-FULL-WANG`;

    // Group 1: 2 pax on 1-1, 1-2
    await prisma.reservation.create({
      data: {
        booking_ref: bG1,
        user_id: user1.id,
        session_id: sess22.id,
        pax: 2,
        assigned_seats: ['1-1', '1-2'],
        status: 'confirmed',
        seat_source: 'auto'
      }
    });

    // Group 7: 1 pax on 3-3 (pinned)
    await prisma.reservation.create({
      data: {
        booking_ref: bG7,
        user_id: user7.id,
        session_id: sess22.id,
        pax: 1,
        assigned_seats: ['3-3'],
        status: 'confirmed',
        is_seat_locked: true // LOCKED, cannot move!
      }
    });

    // Group 8: 1 pax on 3-4 (pinned)
    await prisma.reservation.create({
      data: {
        booking_ref: bG8,
        user_id: userWang.id,
        session_id: sess22.id,
        pax: 1,
        assigned_seats: ['3-4'],
        status: 'confirmed',
        is_seat_locked: true // LOCKED, cannot move!
      }
    });

    // Wang: 1 pax trying to take 1-1
    await prisma.reservation.create({
      data: {
        booking_ref: bWang,
        user_id: userWang.id,
        session_id: sess22.id,
        pax: 1,
        assigned_seats: ['WAIT-1'],
        status: 'confirmed'
      }
    });

    const { req, res } = createMockReqRes({
      params: { booking_ref: bWang },
      body: { seats: ['1-1'] }
    });

    await checkIn(req, res);
    assert.equal(res.getStatusCode(), 409, 'Should fail with 409 when seats insufficient');

    // DB should remain completely unchanged
    const afterG1 = await prisma.reservation.findFirst({ where: { booking_ref: bG1, session_id: sess22.id } });
    const afterG7 = await prisma.reservation.findFirst({ where: { booking_ref: bG7, session_id: sess22.id } });
    const afterG8 = await prisma.reservation.findFirst({ where: { booking_ref: bG8, session_id: sess22.id } });
    const afterWang = await prisma.reservation.findFirst({ where: { booking_ref: bWang, session_id: sess22.id } });

    assert.deepEqual(afterG1.assigned_seats, ['1-1', '1-2']);
    assert.deepEqual(afterG7.assigned_seats, ['3-3']);
    assert.deepEqual(afterG8.assigned_seats, ['3-4']);
    assert.deepEqual(afterWang.assigned_seats, ['WAIT-1']);

    await assertZeroCollisions();

    // Clean up
    await prisma.reservation.deleteMany({ where: { booking_ref: { in: [bG1, bG7, bG8, bWang] } } });
  });

  await t.test('3. 被挪動的預約如果是多時段，每個時段的座位都要一致', async () => {
    const bG1 = `BK-RESEAT-${TS}-MULTI-G1`;
    const bG7 = `BK-RESEAT-${TS}-MULTI-G7`;
    const bWang = `BK-RESEAT-${TS}-MULTI-WANG`;

    // Group 1: 2 pax on 1-1, 1-2 across sess21 and sess22
    for (const sid of [sess21.id, sess22.id]) {
      await prisma.reservation.create({
        data: {
          booking_ref: bG1,
          user_id: user1.id,
          session_id: sid,
          pax: 2,
          assigned_seats: ['1-1', '1-2'],
          status: 'confirmed',
          seat_source: 'auto'
        }
      });
    }

    // Group 7: 1 pax on 3-3 across sess21 and sess22
    for (const sid of [sess21.id, sess22.id]) {
      await prisma.reservation.create({
        data: {
          booking_ref: bG7,
          user_id: user7.id,
          session_id: sid,
          pax: 1,
          assigned_seats: ['3-3'],
          status: 'confirmed',
          seat_source: 'auto'
        }
      });
    }

    // Wang: at sess21 and sess22, wants 1-1
    for (const sid of [sess21.id, sess22.id]) {
      await prisma.reservation.create({
        data: {
          booking_ref: bWang,
          user_id: userWang.id,
          session_id: sid,
          pax: 1,
          assigned_seats: ['WAIT-1'],
          status: 'confirmed'
        }
      });
    }

    const { req, res } = createMockReqRes({
      params: { booking_ref: bWang },
      body: { seats: ['1-1'] }
    });

    await checkIn(req, res);
    assert.equal(res.getStatusCode(), 200);

    const g1Resvs = await prisma.reservation.findMany({ where: { booking_ref: bG1 } });
    const g7Resvs = await prisma.reservation.findMany({ where: { booking_ref: bG7 } });

    assert.equal(g1Resvs.length, 2);
    assert.equal(g7Resvs.length, 2);

    // Group 1 seats should be consistent across both sessions
    assert.deepEqual(g1Resvs[0].assigned_seats.sort(), g1Resvs[1].assigned_seats.sort());
    // Group 7 seats should be consistent across both sessions
    assert.deepEqual(g7Resvs[0].assigned_seats.sort(), g7Resvs[1].assigned_seats.sort());

    await assertZeroCollisions();

    // Clean up
    await prisma.reservation.deleteMany({ where: { booking_ref: { in: [bG1, bG7, bWang] } } });
  });

  await t.test('4. 單時段報到挪動多時段預約，防線涵蓋所有涉及時段且無任何碰撞', async () => {
    const bG1 = `BK-RESEAT-${TS}-CROSS-G1`;
    const bG7 = `BK-RESEAT-${TS}-CROSS-G7`;
    const bWang = `BK-RESEAT-${TS}-CROSS-WANG`;

    // G1: 2 pax across sess21 and sess22 on 1-1, 1-2
    for (const sid of [sess21.id, sess22.id]) {
      await prisma.reservation.create({
        data: {
          booking_ref: bG1,
          user_id: user1.id,
          session_id: sid,
          pax: 2,
          assigned_seats: ['1-1', '1-2'],
          status: 'confirmed',
          seat_source: 'auto'
        }
      });
    }

    // G7: 1 pax across sess21 and sess22 on 3-3
    for (const sid of [sess21.id, sess22.id]) {
      await prisma.reservation.create({
        data: {
          booking_ref: bG7,
          user_id: user7.id,
          session_id: sid,
          pax: 1,
          assigned_seats: ['3-3'],
          status: 'confirmed',
          seat_source: 'auto'
        }
      });
    }

    // Wang: only in sess21! Takes 1-1
    await prisma.reservation.create({
      data: {
        booking_ref: bWang,
        user_id: userWang.id,
        session_id: sess21.id,
        pax: 1,
        assigned_seats: ['WAIT-1'],
        status: 'confirmed'
      }
    });

    const { req, res } = createMockReqRes({
      params: { booking_ref: bWang },
      body: { seats: ['1-1'] }
    });

    await checkIn(req, res);
    assert.equal(res.getStatusCode(), 200);

    // G1 must be consistent across sess21 and sess22
    const g1Resvs = await prisma.reservation.findMany({ where: { booking_ref: bG1 } });
    assert.equal(g1Resvs.length, 2);
    assert.deepEqual(g1Resvs[0].assigned_seats.sort(), g1Resvs[1].assigned_seats.sort());

    await assertZeroCollisions();

    // Clean up
    await prisma.reservation.deleteMany({ where: { booking_ref: { in: [bG1, bG7, bWang] } } });
  });

  await t.test('5. 重現情境：22:00 有 9 組預約，16 個座位只剩 1 個空位。現場王報到選 1-1，被改座位的預約不超過 2 組且無重複劃位', async () => {
    const testDate16 = dateOnly('2026-11-29');
    // Create layout with 16 seats (Table 1, Table 2, Table 3, Table L)
    const layout16 = await prisma.seatLayout.create({
      data: {
        name: `測試16座格局_${TS}`,
        status: 'published',
        effective_from: testDate16,
        canvas_w: 1200,
        canvas_h: 625,
        capacity: 16,
        rules_json: {
          spread_tables: false,
          avoid_opposite: false,
          avoid_beside: false,
          zone_mode: 'empty_tables_first',
          weights: { zone: 1, zone_fill_first: 50, opposite: 3, beside: 6, second: 20, last: 100, split: 4 }
        },
        zones: {
          create: [{ name: '一般區', sort_order: 0 }]
        }
      },
      include: { zones: true }
    });
    const zId = layout16.zones[0].id;

    const t1 = await prisma.seatTable.create({
      data: { layout_id: layout16.id, zone_id: zId, label: '桌1', shape: 'rect', arrangement: 'one_side', cx: 200, cy: 200, w: 80, h: 200, sort_order: 1 }
    });
    const t2 = await prisma.seatTable.create({
      data: { layout_id: layout16.id, zone_id: zId, label: '桌2', shape: 'rect', arrangement: 'one_side', cx: 400, cy: 200, w: 80, h: 200, sort_order: 2 }
    });
    const t3 = await prisma.seatTable.create({
      data: { layout_id: layout16.id, zone_id: zId, label: '桌3', shape: 'rect', arrangement: 'one_side', cx: 600, cy: 200, w: 80, h: 200, sort_order: 3 }
    });
    const tL = await prisma.seatTable.create({
      data: { layout_id: layout16.id, zone_id: zId, label: '桌L', shape: 'rect', arrangement: 'one_side', cx: 800, cy: 200, w: 80, h: 200, sort_order: 4 }
    });

    const seatData = [
      { layout_id: layout16.id, table_id: t1.id, zone_id: zId, code: '1-1', lx: -40, ly: -75, side_mode: 'auto', priority: 'normal', is_active: true, sort_order: 0 },
      { layout_id: layout16.id, table_id: t1.id, zone_id: zId, code: '1-2', lx: -40, ly: -25, side_mode: 'auto', priority: 'normal', is_active: true, sort_order: 1 },
      { layout_id: layout16.id, table_id: t1.id, zone_id: zId, code: '1-3', lx: -40, ly: 25, side_mode: 'auto', priority: 'normal', is_active: true, sort_order: 2 },
      { layout_id: layout16.id, table_id: t1.id, zone_id: zId, code: '1-4', lx: -40, ly: 75, side_mode: 'auto', priority: 'normal', is_active: true, sort_order: 3 },

      { layout_id: layout16.id, table_id: t2.id, zone_id: zId, code: '2-1', lx: -40, ly: -75, side_mode: 'auto', priority: 'normal', is_active: true, sort_order: 0 },
      { layout_id: layout16.id, table_id: t2.id, zone_id: zId, code: '2-2', lx: -40, ly: -25, side_mode: 'auto', priority: 'normal', is_active: true, sort_order: 1 },
      { layout_id: layout16.id, table_id: t2.id, zone_id: zId, code: '2-3', lx: -40, ly: 25, side_mode: 'auto', priority: 'normal', is_active: true, sort_order: 2 },
      { layout_id: layout16.id, table_id: t2.id, zone_id: zId, code: '2-4', lx: -40, ly: 75, side_mode: 'auto', priority: 'normal', is_active: true, sort_order: 3 },

      { layout_id: layout16.id, table_id: t3.id, zone_id: zId, code: '3-1', lx: -40, ly: -75, side_mode: 'auto', priority: 'normal', is_active: true, sort_order: 0 },
      { layout_id: layout16.id, table_id: t3.id, zone_id: zId, code: '3-2', lx: -40, ly: -25, side_mode: 'auto', priority: 'normal', is_active: true, sort_order: 1 },
      { layout_id: layout16.id, table_id: t3.id, zone_id: zId, code: '3-3', lx: -40, ly: 25, side_mode: 'auto', priority: 'normal', is_active: true, sort_order: 2 },
      { layout_id: layout16.id, table_id: t3.id, zone_id: zId, code: '3-4', lx: -40, ly: 75, side_mode: 'auto', priority: 'normal', is_active: true, sort_order: 3 },

      { layout_id: layout16.id, table_id: tL.id, zone_id: zId, code: 'L-1', lx: -40, ly: -75, side_mode: 'auto', priority: 'normal', is_active: true, sort_order: 0 },
      { layout_id: layout16.id, table_id: tL.id, zone_id: zId, code: 'L-2', lx: -40, ly: -25, side_mode: 'auto', priority: 'normal', is_active: true, sort_order: 1 },
      { layout_id: layout16.id, table_id: tL.id, zone_id: zId, code: 'L-3', lx: -40, ly: 25, side_mode: 'auto', priority: 'normal', is_active: true, sort_order: 2 },
      { layout_id: layout16.id, table_id: tL.id, zone_id: zId, code: 'L-4', lx: -40, ly: 75, side_mode: 'auto', priority: 'normal', is_active: true, sort_order: 3 }
    ];
    await prisma.seat.createMany({ data: seatData });

    // Session sess16 (22:00)
    const oldSessions = await prisma.session.findMany({ where: { session_date: testDate16 } });
    const oldSids = oldSessions.map(s => s.id);
    const oldResvs = await prisma.reservation.findMany({ where: { session_id: { in: oldSids } } });
    const oldRefs = oldResvs.map(r => r.booking_ref);
    await prisma.bookingPerson.deleteMany({ where: { booking_ref: { in: oldRefs } } });
    await prisma.reservation.deleteMany({ where: { session_id: { in: oldSids } } });
    await prisma.session.deleteMany({ where: { id: { in: oldSids } } });
    const sess16 = await prisma.session.create({
      data: { session_date: testDate16, start_time: '22:00', end_time: '23:00', max_capacity: 16 }
    });

    // 9 groups with 15 pax total (3-4 is empty)
    // Group 1: 2 pax on 1-1, 1-2
    // Group 2: 2 pax on 1-3, 1-4
    // Group 3: 2 pax on 2-1, 2-2
    // Group 4: 2 pax on 2-3, 2-4
    // Group 5: 2 pax on 3-1, 3-2
    // Group 6: 2 pax on L-1, L-2
    // Group 7: 1 pax on 3-3
    // Group 8: 1 pax on L-3
    // Group 9: 1 pax on L-4
    const groups = [
      { no: 1, pax: 2, seats: ['1-1', '1-2'] },
      { no: 2, pax: 2, seats: ['1-3', '1-4'] },
      { no: 3, pax: 2, seats: ['2-1', '2-2'] },
      { no: 4, pax: 2, seats: ['2-3', '2-4'] },
      { no: 5, pax: 2, seats: ['3-1', '3-2'] },
      { no: 6, pax: 2, seats: ['L-1', 'L-2'] },
      { no: 7, pax: 1, seats: ['3-3'] },
      { no: 8, pax: 1, seats: ['L-3'] },
      { no: 9, pax: 1, seats: ['L-4'] }
    ];

    const groupRefs = [];
    for (const g of groups) {
      const ref = `BK-RESEAT-${TS}-9G-${g.no}`;
      groupRefs.push(ref);
      await prisma.reservation.create({
        data: {
          booking_ref: ref,
          user_id: user1.id,
          session_id: sess16.id,
          pax: g.pax,
          assigned_seats: g.seats,
          status: 'confirmed',
          attendance: 'confirmed',
          seat_source: 'auto',
          is_seat_locked: false
        }
      });
    }

    const bWang = `BK-RESEAT-${TS}-9G-WANG`;
    await prisma.reservation.create({
      data: {
        booking_ref: bWang,
        user_id: userWang.id,
        session_id: sess16.id,
        pax: 1,
        assigned_seats: ['WAIT-1'],
        status: 'confirmed',
        is_walk_in: true
      }
    });

    const { req, res } = createMockReqRes({
      params: { booking_ref: bWang },
      body: { seats: ['1-1'] }
    });

    await checkIn(req, res);
    assert.equal(res.getStatusCode(), 200, 'Check in should succeed');

    const respData = res.getResponseData();
    assert.ok(respData.displaced, 'Displaced list should exist');
    // Displaced should move at most 2 groups (e.g. Group 1 and Group 9)
    assert.ok(respData.displaced.length <= 2, `Expected at most 2 displaced groups, but got ${respData.displaced.length}`);

    await assertZeroCollisions();

    // Clean up
    await prisma.bookingPerson.deleteMany({ where: { booking_ref: { in: [...groupRefs, bWang] } } });
    await prisma.reservation.deleteMany({ where: { booking_ref: { in: [...groupRefs, bWang] } } });
    await prisma.session.delete({ where: { id: sess16.id } });
    await prisma.seat.deleteMany({ where: { layout_id: layout16.id } });
    await prisma.seatTable.deleteMany({ where: { layout_id: layout16.id } });
    await prisma.seatZone.deleteMany({ where: { layout_id: layout16.id } });
    await prisma.seatLayout.delete({ where: { id: layout16.id } });
  });

  await t.test('6. 有空位可以直接放時，只有被擠走的那一組改座位', async () => {
    const bG1 = `BK-RESEAT-${TS}-DIRECT-G1`;
    const bG7 = `BK-RESEAT-${TS}-DIRECT-G7`;
    const bWang = `BK-RESEAT-${TS}-DIRECT-WANG`;

    // Group 1: 1 pax on 1-1
    await prisma.reservation.create({
      data: {
        booking_ref: bG1,
        user_id: user1.id,
        session_id: sess21.id,
        pax: 1,
        assigned_seats: ['1-1'],
        status: 'confirmed',
        attendance: 'confirmed',
        seat_source: 'auto',
        is_seat_locked: false
      }
    });

    // Group 7: 1 pax on 1-2
    await prisma.reservation.create({
      data: {
        booking_ref: bG7,
        user_id: user7.id,
        session_id: sess21.id,
        pax: 1,
        assigned_seats: ['1-2'],
        status: 'confirmed',
        attendance: 'confirmed',
        seat_source: 'auto',
        is_seat_locked: false
      }
    });

    // Wang: 1 pax walk-in, chooses 1-1
    // Notice 3-3 and 3-4 are EMPTY in sess21!
    await prisma.reservation.create({
      data: {
        booking_ref: bWang,
        user_id: userWang.id,
        session_id: sess21.id,
        pax: 1,
        assigned_seats: ['WAIT-1'],
        status: 'confirmed',
        is_walk_in: true
      }
    });

    const { req, res } = createMockReqRes({
      params: { booking_ref: bWang },
      body: { seats: ['1-1'] }
    });

    await checkIn(req, res);
    assert.equal(res.getStatusCode(), 200, 'Check in should succeed');

    const respData = res.getResponseData();
    // Only Group 1 should be displaced!
    assert.equal(respData.displaced.length, 1, `Expected only 1 displaced group, got ${respData.displaced.length}`);
    assert.equal(respData.displaced[0].booking_ref, bG1);

    // Group 7 seats should remain 1-2 unchanged
    const resG7 = await prisma.reservation.findFirst({ where: { booking_ref: bG7, session_id: sess21.id } });
    assert.deepEqual(resG7.assigned_seats, ['1-2']);

    await assertZeroCollisions();

    // Clean up
    await prisma.bookingPerson.deleteMany({ where: { booking_ref: { in: [bG1, bG7, bWang] } } });
    await prisma.reservation.deleteMany({ where: { booking_ref: { in: [bG1, bG7, bWang] } } });
  });
});
