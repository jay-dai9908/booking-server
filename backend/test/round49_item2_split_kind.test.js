import test from 'node:test';
import assert from 'node:assert/strict';
import prisma from '../src/prismaClient.js';
import { createReservationHandler } from '../src/controllers/reservationController.js';
import { allocateSeats } from '../src/utils/SeatAllocator.js';
import { loadAllocatorContext } from '../src/services/seating/layoutService.js';
import { cleanupTestPublishedLayout } from './helpers/seedTestLayout.js';
import { dateOnly } from '../../shared/time.js';

function createMockRes() {
  return {
    statusCode: 200,
    body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; }
  };
}

test('Round 49 Item 2: SPLIT_REQUIRED distinguishes split vs no_seat, preserves WAIT-n & is_self_service, and does not mutate DB on 409', async () => {
  const ts = Date.now();
  const normalDateStr = '2099-07-05';
  const selfDateStr = '2099-07-06';
  const normalDate = dateOnly(normalDateStr);
  const selfDate = dateOnly(selfDateStr);

  let origGlobal = null;
  let customer = null;
  let layout1Id = null;
  let layout2Id = null;
  let version1Id = null;
  let version2Id = null;
  const createdSessionIds = [];
  const createdRefs = [];

  try {
    origGlobal = await prisma.globalSetting.findUnique({ where: { id: 1 } });
    await prisma.globalSetting.upsert({
      where: { id: 1 },
      update: { seat_layout_enabled: true, max_active_bookings_per_user: 0 },
      create: { id: 1, seat_layout_enabled: true, max_active_bookings_per_user: 0 }
    });

    customer = await prisma.user.create({
      data: {
        name: 'R49分桌測試客',
        phone: `0961${String(ts).slice(-6)}`,
        line_user_id: `r49_i2_cust_${ts}`
      }
    });

    // Ensure layout 1 (2 tables x 2 seats = 4 seats) effective from 2099-07-01
    const layout1 = await prisma.seatLayout.create({
      data: {
        name: `R49 Split Layout 1 ${ts}`,
        status: 'published',
        effective_from: dateOnly('2099-07-01'),
        capacity: 4
      }
    });
    layout1Id = layout1.id;
    const zone1 = await prisma.seatZone.create({
      data: { layout_id: layout1.id, name: '主區', sort_order: 1 }
    });
    const t1 = await prisma.seatTable.create({
      data: { layout_id: layout1.id, zone_id: zone1.id, label: 'T1', shape: 'rect', arrangement: 'single_side', cx: 200, cy: 200, sort_order: 1 }
    });
    const t2 = await prisma.seatTable.create({
      data: { layout_id: layout1.id, zone_id: zone1.id, label: 'T2', shape: 'rect', arrangement: 'single_side', cx: 400, cy: 200, sort_order: 2 }
    });
    await prisma.seat.createMany({
      data: [
        { layout_id: layout1.id, zone_id: zone1.id, table_id: t1.id, code: 'T1-1', lx: -20, ly: 0, side_mode: 'auto', is_active: true, sort_order: 1 },
        { layout_id: layout1.id, zone_id: zone1.id, table_id: t1.id, code: 'T1-2', lx: 20, ly: 0, side_mode: 'auto', is_active: true, sort_order: 2 },
        { layout_id: layout1.id, zone_id: zone1.id, table_id: t2.id, code: 'T2-1', lx: -20, ly: 0, side_mode: 'auto', is_active: true, sort_order: 3 },
        { layout_id: layout1.id, zone_id: zone1.id, table_id: t2.id, code: 'T2-2', lx: 20, ly: 0, side_mode: 'auto', is_active: true, sort_order: 4 }
      ]
    });

    // Clean any pre-existing sessions on test dates
    await prisma.dailySetting.deleteMany({ where: { date: { in: [normalDate, selfDate] } } });
    const oldSess = await prisma.session.findMany({ where: { session_date: { in: [normalDate, selfDate] } }, select: { id: true } });
    if (oldSess.length) {
      await prisma.reservation.deleteMany({ where: { session_id: { in: oldSess.map((s) => s.id) } } });
      await prisma.session.deleteMany({ where: { id: { in: oldSess.map((s) => s.id) } } });
    }

    const sNormal = await prisma.session.create({
      data: { session_date: normalDate, start_time: '13:00', end_time: '14:00', max_capacity: 10 }
    });
    const sSelf = await prisma.session.create({
      data: { session_date: selfDate, start_time: '13:00', end_time: '14:00', max_capacity: 10 }
    });
    createdSessionIds.push(sNormal.id, sSelf.id);

    await prisma.dailySetting.create({
      data: { date: selfDate, is_self_service: true, self_allow_hourly: true }
    });

    const handler = createReservationHandler({ now: () => new Date(`${normalDateStr}T09:00:00+08:00`) });

    // Case A: 2 tables x 2 seats, pin 1 checked-in guest on T1-1 and 1 checked-in guest on T2-1 -> remaining 1+1 non-adjacent
    const refPin1 = `R49-PIN1-${ts}`;
    const refPin2 = `R49-PIN2-${ts}`;
    createdRefs.push(refPin1, refPin2);
    await prisma.reservation.create({
      data: {
        booking_ref: refPin1,
        session_id: sNormal.id,
        user_id: customer.id,
        pax: 1,
        status: 'confirmed',
        attendance: 'checked_in',
        assigned_seats: ['T1-1'],
        seat_source: 'staff'
      }
    });
    await prisma.reservation.create({
      data: {
        booking_ref: refPin2,
        session_id: sNormal.id,
        user_id: customer.id,
        pax: 1,
        status: 'confirmed',
        attendance: 'checked_in',
        assigned_seats: ['T2-1'],
        seat_source: 'staff'
      }
    });

    const beforeRowsSplit = await prisma.reservation.findMany({ where: { session_id: sNormal.id }, orderBy: { id: 'asc' } });
    const resSplit = createMockRes();
    await handler({
      user: { id: customer.id, name: customer.name },
      body: { session_ids: [sNormal.id], pax: 2, isUnlimited: false }
    }, resSplit);
    assert.equal(resSplit.statusCode, 409);
    assert.equal(resSplit.body.code, 'SPLIT_REQUIRED');
    assert.equal(resSplit.body.split_kind, 'split');
    assert.equal(resSplit.body.pax, 2);
    assert.equal(resSplit.body.is_self_service, false);

    // Ensure 409 did not mutate DB
    const afterRowsSplit = await prisma.reservation.findMany({ where: { session_id: sNormal.id }, orderBy: { id: 'asc' } });
    assert.equal(afterRowsSplit.length, beforeRowsSplit.length);
    assert.deepEqual(afterRowsSplit.map((r) => r.assigned_seats), beforeRowsSplit.map((r) => r.assigned_seats));

    // Case B: fill remaining 2 seats (now all 4 seats taken) -> 1 more pax -> 409 no_seat, pax 1
    const refPin3 = `R49-PIN3-${ts}`;
    const refPin4 = `R49-PIN4-${ts}`;
    createdRefs.push(refPin3, refPin4);
    await prisma.reservation.create({
      data: {
        booking_ref: refPin3,
        session_id: sNormal.id,
        user_id: customer.id,
        pax: 2,
        status: 'confirmed',
        attendance: 'checked_in',
        assigned_seats: ['T1-2', 'T2-2'],
        seat_source: 'staff'
      }
    });

    const ctxBefore = await loadAllocatorContext(prisma, normalDate);
    const existingAll = await prisma.reservation.findMany({ where: { session_id: sNormal.id, status: 'confirmed' } });
    const expectedForced = allocateSeats(existingAll, { booking_ref: 'NEW_RES', pax: 1, session_ids: [sNormal.id] }, true, ctxBefore);
    const expectedWaitSeats = expectedForced.updates.find((u) => u.booking_ref === 'NEW_RES')?.assigned_seats;

    const resNoSeat = createMockRes();
    await handler({
      user: { id: customer.id, name: customer.name },
      body: { session_ids: [sNormal.id], pax: 1, isUnlimited: false }
    }, resNoSeat);
    assert.equal(resNoSeat.statusCode, 409);
    assert.equal(resNoSeat.body.code, 'SPLIT_REQUIRED');
    assert.equal(resNoSeat.body.split_kind, 'no_seat');
    assert.equal(resNoSeat.body.pax, 1);
    assert.equal(resNoSeat.body.is_self_service, false);

    // Confirm 409 did not mutate DB
    const afterRowsNoSeat = await prisma.reservation.findMany({ where: { session_id: sNormal.id } });
    assert.equal(afterRowsNoSeat.length, 3);

    // With forceSplit: true -> 201 and assigned_seats matches allocator result (WAIT-1)
    const resForced = createMockRes();
    await handler({
      user: { id: customer.id, name: customer.name },
      body: { session_ids: [sNormal.id], pax: 1, isUnlimited: false, forceSplit: true }
    }, resForced);
    assert.equal(resForced.statusCode, 201);
    createdRefs.push(resForced.body.reservation.booking_ref);
    assert.deepEqual(resForced.body.reservation.assigned_seats, expectedWaitSeats);
    assert.ok(expectedWaitSeats.some((s) => s.startsWith('WAIT-')));

    // Case C: Self-service day same full layout -> is_self_service: true
    createdRefs.push(refPin4);
    await prisma.reservation.create({
      data: {
        booking_ref: refPin4,
        session_id: sSelf.id,
        user_id: customer.id,
        pax: 4,
        status: 'confirmed',
        attendance: 'checked_in',
        assigned_seats: ['T1-1', 'T1-2', 'T2-1', 'T2-2'],
        seat_source: 'staff'
      }
    });
    const resSelfNoSeat = createMockRes();
    await handler({
      user: { id: customer.id, name: customer.name },
      body: { session_ids: [sSelf.id], pax: 1, isUnlimited: false }
    }, resSelfNoSeat);
    assert.equal(resSelfNoSeat.statusCode, 409);
    assert.equal(resSelfNoSeat.body.code, 'SPLIT_REQUIRED');
    assert.equal(resSelfNoSeat.body.split_kind, 'no_seat');
    assert.equal(resSelfNoSeat.body.is_self_service, true);
  } finally {
    await prisma.bookingEquipment.deleteMany({ where: { booking_ref: { in: createdRefs } } }).catch(() => {});
    await prisma.bookingPerson.deleteMany({ where: { booking_ref: { in: createdRefs } } }).catch(() => {});
    await prisma.bookingPrepay.deleteMany({ where: { booking_ref: { in: createdRefs } } }).catch(() => {});
    await prisma.payment.deleteMany({ where: { booking_ref: { in: createdRefs } } }).catch(() => {});
    await prisma.reservation.deleteMany({ where: { session_id: { in: createdSessionIds } } }).catch(() => {});
    await prisma.dailySetting.deleteMany({ where: { date: { in: [normalDate, selfDate] } } }).catch(() => {});
    await prisma.session.deleteMany({ where: { id: { in: createdSessionIds } } }).catch(() => {});
    if (layout1Id) {
      await cleanupTestPublishedLayout(prisma, layout1Id).catch(() => {});
    }
    if (customer) await prisma.user.deleteMany({ where: { id: customer.id } }).catch(() => {});
    if (origGlobal) {
      await prisma.globalSetting.update({
        where: { id: 1 },
        data: {
          seat_layout_enabled: origGlobal.seat_layout_enabled,
          max_active_bookings_per_user: origGlobal.max_active_bookings_per_user
        }
      }).catch(() => {});
    }
  }
});
