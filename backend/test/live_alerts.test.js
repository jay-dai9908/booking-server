import test from 'node:test';
import assert from 'node:assert/strict';
import prisma from '../src/prismaClient.js';
import { getLiveFloorData } from '../src/services/floor/liveService.js';
import { dateOnly } from '../../shared/time.js';

test('Live floor alerts overtime and ended timer test', async (t) => {
  const ts = Date.now();
  const todayStr = new Date().toISOString().slice(0, 10);
  const testDate = dateOnly(todayStr);
  const dStr = todayStr;

  const user = await prisma.user.upsert({
    where: { line_user_id: `test_live_alerts_${ts}` },
    update: { name: '林小美' },
    create: { line_user_id: `test_live_alerts_${ts}`, name: '林小美', phone: '0911222333' }
  });

  const session = await prisma.session.upsert({
    where: { session_date_start_time: { session_date: testDate, start_time: '08:00' } },
    update: { end_time: '09:00', max_capacity: 16 },
    create: { session_date: testDate, start_time: '08:00', end_time: '09:00', max_capacity: 16 }
  });

  t.after(async () => {
    await prisma.bookingPerson.deleteMany({ where: { booking_ref: { startsWith: `BK-ALERT-${ts}` } } });
    await prisma.payment.deleteMany({ where: { booking_ref: { startsWith: `BK-ALERT-${ts}` } } });
    await prisma.reservation.deleteMany({ where: { booking_ref: { startsWith: `BK-ALERT-${ts}` } } });
  });

  await t.test('Lin Hsiao-mei with ended timer and paid status does not trigger overtime alert', async () => {
    const bRef = `BK-ALERT-${ts}-PAID`;

    await prisma.reservation.create({
      data: {
        booking_ref: bRef,
        user_id: user.id,
        session_id: session.id,
        pax: 2,
        status: 'confirmed',
        attendance: 'checked_in',
        is_paid: true,
        assigned_seats: ['A1-1', 'A1-2'],
        total_amount: 300
      }
    });

    await prisma.bookingPerson.createMany({
      data: [
        {
          booking_ref: bRef,
          person_no: 1,
          seat_code: 'A1-1',
          status: 'active',
          timer_started_at: new Date(`${dStr}T10:00:00+08:00`),
          timer_ended_at: new Date(`${dStr}T11:00:00+08:00`),
          billing_start_at: new Date(`${dStr}T10:00:00+08:00`)
        },
        {
          booking_ref: bRef,
          person_no: 2,
          seat_code: 'A1-2',
          status: 'active',
          timer_started_at: new Date(`${dStr}T10:00:00+08:00`),
          timer_ended_at: new Date(`${dStr}T11:00:00+08:00`),
          billing_start_at: new Date(`${dStr}T10:00:00+08:00`)
        }
      ]
    });

    const liveData = await getLiveFloorData(dStr);
    const alert = liveData.alerts.find(a => a.booking_ref === bRef);
    assert.equal(alert, undefined, 'Lin Hsiao-mei who ended timer and paid should not have an overtime alert');
  });

  await t.test('Active overtime calculation accounts for pauses and uses table label', async () => {
    const bRef = `BK-ALERT-${ts}-ACTIVE`;
    const now = new Date();
    // Start session 90 minutes ago, 60 min session length
    const startMs = now.getTime() - 90 * 60 * 1000;
    const startH = String(new Date(startMs).getHours()).padStart(2, '0');
    const startM = String(new Date(startMs).getMinutes()).padStart(2, '0');
    const startStr = `${startH}:${startM}`;
    
    const endH = String((new Date(startMs).getHours() + 1) % 24).padStart(2, '0');
    const endStr = `${endH}:${startM}`;
    
    // We create or update a session for today at this time
    const activeSession = await prisma.session.upsert({
      where: { session_date_start_time: { session_date: testDate, start_time: startStr } },
      update: { end_time: endStr, max_capacity: 16 },
      create: {
        session_date: testDate,
        start_time: startStr,
        end_time: endStr,
        max_capacity: 16
      }
    });

    await prisma.reservation.create({
      data: {
        booking_ref: bRef,
        user_id: user.id,
        session_id: activeSession.id,
        pax: 2,
        status: 'confirmed',
        attendance: 'checked_in',
        is_paid: false,
        assigned_seats: ['A1-1', 'A1-2'],
        total_amount: 300
      }
    });

    // Person 1: started 90 mins ago, paused 20 mins -> actual = 70 mins. Booked = 60 mins -> overtime = 10 mins.
    // Person 2: started 90 mins ago, no pause -> actual = 90 mins. Booked = 60 mins -> overtime = 30 mins.
    await prisma.bookingPerson.createMany({
      data: [
        {
          booking_ref: bRef,
          person_no: 1,
          seat_code: 'A1-1',
          status: 'active',
          timer_started_at: new Date(startMs),
          billing_start_at: new Date(startMs),
          paused_seconds: 20 * 60
        },
        {
          booking_ref: bRef,
          person_no: 2,
          seat_code: 'A1-2',
          status: 'active',
          timer_started_at: new Date(startMs),
          billing_start_at: new Date(startMs),
          paused_seconds: 0
        }
      ]
    });

    const liveData = await getLiveFloorData(dStr);
    const bAlerts = liveData.alerts.filter(a => a.booking_ref === bRef);
    assert.equal(bAlerts.length, 1, 'Should only produce 1 overtime alert for the booking');
    assert.equal(bAlerts[0].type, 'overtime');
    assert.ok(bAlerts[0].title.includes('超時 30 分'), `Expected title to have max overtime 30 分, got: ${bAlerts[0].title}`);
  });

  await t.test('Order-level payment with empty person_nos array is recognized as paid and does not trigger overtime alert', async () => {
    const bRef = `BK-ALERT-${ts}-ORDER-PAID`;
    const now = new Date();
    const startMs = now.getTime() - 90 * 60 * 1000;

    await prisma.reservation.create({
      data: {
        booking_ref: bRef,
        user_id: user.id,
        session_id: session.id,
        pax: 1,
        status: 'confirmed',
        attendance: 'checked_in',
        is_paid: false,
        assigned_seats: ['A1-1'],
        total_amount: 150
      }
    });

    await prisma.bookingPerson.create({
      data: {
        booking_ref: bRef,
        person_no: 1,
        seat_code: 'A1-1',
        status: 'active',
        timer_started_at: new Date(startMs),
        billing_start_at: new Date(startMs)
      }
    });

    // Whole order payment with empty person_nos array (standard Postgres default)
    await prisma.payment.create({
      data: {
        payment_no: `PAY-${ts}-ORD`,
        batch_no: `B-${ts}-001`,
        booking_ref: bRef,
        amount: 150,
        cash_received: 150,
        change_given: 0,
        method: 'cash',
        kind: 'charge',
        status: 'valid',
        person_nos: [],
        staff_name: '測試人員',
        device_label: '櫃檯平板',
        breakdown_json: { persons: [] }
      }
    });

    const liveData = await getLiveFloorData(dStr);
    const alert = liveData.alerts.find(a => a.booking_ref === bRef);
    assert.equal(alert, undefined, 'Customer whose entire order was paid should not trigger overtime alert');
  });

  await t.test('Item 1: Deleted seat alert is not generated for completed bookings, but is generated for pending bookings without raw UUID', async () => {
    const rawUuid = 'b843d1a8-7970-4283-a123-456789abcdef';
    const bRefCompleted = `BK-ALERT-${ts}-COMPLETED`;
    const bRefPending = rawUuid;

    const testUser = await prisma.user.upsert({
      where: { line_user_id: `test_user_missing_seat_${ts}` },
      update: { name: '王小華' },
      create: { line_user_id: `test_user_missing_seat_${ts}`, name: '王小華', phone: '0988777666' }
    });

    // 1. Completed booking assigned to a nonexistent seat
    await prisma.reservation.create({
      data: {
        booking_ref: bRefCompleted,
        user_id: testUser.id,
        session_id: session.id,
        pax: 2,
        status: 'confirmed',
        attendance: 'completed',
        is_paid: true,
        assigned_seats: ['DEL-1', 'DEL-2'],
        total_amount: 300
      }
    });

    // 2. Pending booking assigned to a nonexistent seat
    await prisma.reservation.create({
      data: {
        booking_ref: bRefPending,
        user_id: testUser.id,
        session_id: session.id,
        pax: 2,
        status: 'confirmed',
        attendance: null,
        is_paid: false,
        assigned_seats: ['DEL-1', 'DEL-2'],
        total_amount: 300
      }
    });

    try {
      const liveData = await getLiveFloorData(dStr);

      // Completed booking alert should NOT exist
      const completedAlert = liveData.alerts.find(a => a.booking_ref === bRefCompleted && a.type === 'seat_missing');
      assert.equal(completedAlert, undefined, 'Completed booking should NOT have seat_missing alert');

      // Pending booking alert SHOULD exist
      const pendingAlert = liveData.alerts.find(a => a.booking_ref === bRefPending && a.type === 'seat_missing');
      assert.ok(pendingAlert, 'Pending booking on deleted seat SHOULD have seat_missing alert');
      assert.equal(pendingAlert.title, '座位 DEL-1、DEL-2 已不存在，請重新帶位');
      
      // Subtitle should not contain the raw UUID
      assert.equal(pendingAlert.subtitle.includes(rawUuid), false, 'Subtitle must NOT contain raw UUID');
      // Subtitle should follow format: 王小華 · BK-XXXX-XXXX · 原座位已在新版面刪除或停用
      assert.match(pendingAlert.subtitle, /^王小華 · BK-[A-Z0-9]{4}-[A-Z0-9]{4} · 原座位已在新版面刪除或停用$/);
    } finally {
      await prisma.reservation.deleteMany({
        where: { booking_ref: { in: [bRefCompleted, bRefPending] } }
      });
      await prisma.user.deleteMany({
        where: { id: testUser.id }
      });
    }
  });
});
