import test from 'node:test';
import assert from 'node:assert/strict';
import prisma from '../src/prismaClient.js';
import { publishLayout } from '../src/controllers/seatLayoutController.js';
import { adminCreateReservation } from '../src/controllers/reservationController.js';
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

test('Item 3: Fresh DB without GlobalSetting enables seat layout upon publishing', async (t) => {
  const TS = Date.now();
  const testDate = dateOnly('2026-12-01');

  // 1. Completely clear GlobalSetting to simulate fresh database
  await prisma.globalSetting.deleteMany();

  // 2. Setup user and session
  const user = await prisma.user.upsert({
    where: { line_user_id: `test_fresh_db_user_${TS}` },
    update: { name: '新版面預約客' },
    create: { line_user_id: `test_fresh_db_user_${TS}`, name: '新版面預約客', phone: '0933000000' }
  });

  const session = await prisma.session.upsert({
    where: { session_date_start_time: { session_date: testDate, start_time: '10:00' } },
    update: { end_time: '11:00', max_capacity: 4 },
    create: { session_date: testDate, start_time: '10:00', end_time: '11:00', max_capacity: 4 }
  });

  // 3. Create a draft layout with custom seat codes: NEW-1-1, NEW-1-2
  const layout = await prisma.seatLayout.create({
    data: {
      name: `新店格局_${TS}`,
      status: 'draft',
      effective_from: testDate,
      canvas_w: 1000,
      canvas_h: 625,
      capacity: 2,
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
      label: '新桌1',
      shape: 'rect',
      arrangement: 'one_side',
      cx: 200,
      cy: 200,
      w: 80,
      h: 120,
      sort_order: 1
    }
  });

  await prisma.seat.createMany({
    data: [
      { layout_id: layout.id, table_id: table.id, zone_id: zoneId, code: 'NEW-1-1', lx: -40, ly: -30, side_mode: 'auto', priority: 'normal', is_active: true, sort_order: 0 },
      { layout_id: layout.id, table_id: table.id, zone_id: zoneId, code: 'NEW-1-2', lx: -40, ly: 30, side_mode: 'auto', priority: 'normal', is_active: true, sort_order: 1 }
    ]
  });

  t.after(async () => {
    const resvs = await prisma.reservation.findMany({ where: { session_id: session.id } });
    const refs = resvs.map(r => r.booking_ref);
    await prisma.bookingPerson.deleteMany({ where: { booking_ref: { in: refs } } });
    await prisma.reservation.deleteMany({ where: { session_id: session.id } });
    await prisma.session.delete({ where: { id: session.id } });
    await prisma.seat.deleteMany({ where: { layout_id: layout.id } });
    await prisma.seatTable.deleteMany({ where: { layout_id: layout.id } });
    await prisma.seatZone.deleteMany({ where: { layout_id: layout.id } });
    await prisma.seatLayout.delete({ where: { id: layout.id } });
    // Restore GlobalSetting with seat_layout_enabled: true
    await prisma.globalSetting.upsert({
      where: { id: 1 },
      update: { seat_layout_enabled: true },
      create: { id: 1, seat_layout_enabled: true }
    });
  });

  // 4. Publish the layout draft
  const { req: pubReq, res: pubRes } = createMockReqRes({
    params: { id: layout.id },
    body: { confirm: true, effective_from: '2026-12-01' }
  });
  await publishLayout(pubReq, pubRes);
  assert.equal(pubRes.getStatusCode(), 200, 'Publishing draft should return 200');

  // Check GlobalSetting in DB: seat_layout_enabled MUST be true!
  const gs = await prisma.globalSetting.findFirst();
  assert.ok(gs, 'GlobalSetting row must exist after publishing');
  assert.equal(gs.seat_layout_enabled, true, 'seat_layout_enabled must be true');

  // 5. Create a reservation on this session
  const bRef = `BK-FRESH-DB-${TS}`;
  const { req: bookReq, res: bookRes } = createMockReqRes({
    body: {
      name: '新版面預約客',
      phone: '0933000000',
      pax: 1,
      session_ids: [session.id]
    }
  });

  await adminCreateReservation(bookReq, bookRes);
  assert.equal(bookRes.getStatusCode(), 201, 'Create reservation should return 201');

  const createdRes = await prisma.reservation.findFirst({
    where: { session_id: session.id, status: 'confirmed' }
  });
  assert.ok(createdRes, 'Reservation should be created');
  assert.ok(
    createdRes.assigned_seats.includes('NEW-1-1'),
    `Assigned seats should use new layout code NEW-1-1, but got ${JSON.stringify(createdRes.assigned_seats)}`
  );
});
