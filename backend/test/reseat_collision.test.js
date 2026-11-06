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
});
