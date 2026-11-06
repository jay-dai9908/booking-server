import test from 'node:test';
import assert from 'node:assert/strict';
import prisma from '../src/prismaClient.js';
import { getBookingBill } from '../src/services/billing/billService.js';
import { dateOnly } from '../../shared/time.js';

test('Section 3.4 Integration Tests with Real Database', async (t) => {
  // Ensure default GlobalSetting exists
  await prisma.globalSetting.upsert({
    where: { id: 1 },
    update: {
      weekday_hourly_price: 150,
      weekday_unlimited_price: 750,
      weekend_hourly_price: 180,
      weekend_unlimited_price: 1100,
      billing_grace_minutes: 10,
      billing_block_minutes: 30,
      early_leave_mode: 'booked',
      default_split_mode: 'proportional',
      equipment_discount_enabled: true,
      equipment_discount_buy_hours: 3,
      equipment_discount_free_hours: 1,
      equipment_discount_stackable: true,
      equipment_discount2_enabled: true,
      equipment_discount2_buy_hours: 8,
      equipment_discount2_free_hours: 4
    },
    create: {
      id: 1,
      weekday_hourly_price: 150,
      weekday_unlimited_price: 750,
      billing_grace_minutes: 10,
      billing_block_minutes: 30,
      early_leave_mode: 'booked',
      default_split_mode: 'proportional',
      equipment_discount_enabled: true,
      equipment_discount_buy_hours: 3,
      equipment_discount_free_hours: 1,
      equipment_discount_stackable: true
    }
  });

  // Ensure equipment configs exist
  await prisma.equipmentConfig.upsert({
    where: { id: 'pegboard_s' },
    update: { hourly_rate: 90, visibility_status: 'ACTIVE' },
    create: { id: 'pegboard_s', name: '小板', hourly_rate: 90, visibility_status: 'ACTIVE' }
  });
  await prisma.equipmentConfig.upsert({
    where: { id: 'pegboard_m' },
    update: { hourly_rate: 120, visibility_status: 'ACTIVE' },
    create: { id: 'pegboard_m', name: '中板', hourly_rate: 120, visibility_status: 'ACTIVE' }
  });

  // Test user
  const user = await prisma.user.upsert({
    where: { line_user_id: 'test_user_lin' },
    update: { name: '林小美' },
    create: { line_user_id: 'test_user_lin', name: '林小美', phone: '0912345678' }
  });

  // Test session on weekday
  const sessionDate = dateOnly('2026-11-04'); // Wednesday
  const session = await prisma.session.upsert({
    where: {
      session_date_start_time: {
        session_date: sessionDate,
        start_time: '14:00'
      }
    },
    update: { end_time: '18:00', max_capacity: 20 },
    create: {
      session_date: sessionDate,
      start_time: '14:00',
      end_time: '18:00',
      max_capacity: 20
    }
  });

  await t.test('1. 林小美 2 位帳單計算 (Section 4.5.4)', async () => {
    const bookingRef = 'BK-LIN-0001';

    // Clean up any previous test data
    await prisma.payment.deleteMany({ where: { booking_ref: bookingRef } });
    await prisma.bookingEquipment.deleteMany({ where: { booking_ref: bookingRef } });
    await prisma.bookingPerson.deleteMany({ where: { booking_ref: bookingRef } });
    await prisma.reservation.deleteMany({ where: { booking_ref: bookingRef } });

    const reservation = await prisma.reservation.create({
      data: {
        booking_ref: bookingRef,
        user_id: user.id,
        session_id: session.id,
        pax: 2,
        assigned_seats: ['2-3', '2-4'],
        status: 'confirmed',
        checkout_details: {
          version: 2,
          order_addons: [
            { key: 'a1', name: '夜光吊飾扣', price: 60, qty: 1, split: { mode: 'proportional' } }
          ],
          order_promos: [
            { key: 'p1', code: 'IG50', name: 'IG 打卡折', discount_type: 'fixed_order', discount_value: 50, split: { mode: 'proportional' } }
          ],
          manual_discount: {
            amount: 30,
            reason: '熟客優惠',
            split: { mode: 'proportional' }
          },
          persons: [
            { person_no: 1, addons: [] },
            { person_no: 2, addons: [{ key: 'iron_m', name: '代燙 中板', price: 50, qty: 1 }] }
          ]
        }
      }
    });

    const p1 = await prisma.bookingPerson.create({
      data: {
        booking_ref: bookingRef,
        person_no: 1,
        seat_code: '2-3',
        status: 'active',
        billing_start_at: new Date('2026-11-04T14:00:00+08:00'),
        timer_started_at: new Date('2026-11-04T14:00:00+08:00'),
        timer_ended_at: new Date('2026-11-04T18:06:00+08:00'),
        paused_seconds: 720
      }
    });

    const p2 = await prisma.bookingPerson.create({
      data: {
        booking_ref: bookingRef,
        person_no: 2,
        seat_code: '2-4',
        status: 'active',
        billing_start_at: new Date('2026-11-04T14:00:00+08:00'),
        timer_started_at: new Date('2026-11-04T14:00:00+08:00'),
        timer_ended_at: new Date('2026-11-04T18:43:00+08:00'),
        paused_seconds: 720
      }
    });

    // Board swap: S 1.5h ($90) -> M 2.5h ($120)
    await prisma.bookingEquipment.create({
      data: {
        booking_ref: bookingRef,
        equipment_id: 'pegboard_s',
        equipment_name_snapshot: '小板',
        person_id: p2.id,
        unit_group: 'b1',
        segment_no: 1,
        rental_hours: 4,
        start_at: new Date('2026-11-04T14:00:00+08:00'),
        end_at: new Date('2026-11-04T15:30:00+08:00'),
        ended_reason: 'swapped',
        unit_rate: 90
      }
    });
    await prisma.bookingEquipment.create({
      data: {
        booking_ref: bookingRef,
        equipment_id: 'pegboard_m',
        equipment_name_snapshot: '中板',
        person_id: p2.id,
        unit_group: 'b1',
        segment_no: 2,
        rental_hours: 4,
        start_at: new Date('2026-11-04T15:30:00+08:00'),
        end_at: new Date('2026-11-04T18:00:00+08:00'),
        ended_reason: null,
        unit_rate: 120
      }
    });

    const billResult = await getBookingBill(bookingRef, prisma, new Date('2026-11-04T19:00:00+08:00'));
    const bill = billResult.bill;

    const person1 = bill.persons.find(p => p.person_no === 1);
    const person2 = bill.persons.find(p => p.person_no === 2);

    assert.equal(person1.entry.amount, 600);
    assert.equal(person2.entry.amount, 675);
    assert.equal(person2.board.amount, 345);
    assert.equal(person1.total, 593);
    assert.equal(person2.total, 1057);
    assert.equal(bill.summary.amount_due, 1650);
    assert.equal(bill.summary.regular_hours_total, 8.5);
  });

  await t.test('2. 陳大明 4 位預約，第 3 位提早離開 (Section 4.3.5, 4.4.2)', async () => {
    const bookingRef = 'BK-CHEN-0002';

    await prisma.payment.deleteMany({ where: { booking_ref: bookingRef } });
    await prisma.bookingEquipment.deleteMany({ where: { booking_ref: bookingRef } });
    await prisma.bookingPerson.deleteMany({ where: { booking_ref: bookingRef } });
    await prisma.reservation.deleteMany({ where: { booking_ref: bookingRef } });

    const sessionChen = await prisma.session.upsert({
      where: {
        session_date_start_time: {
          session_date: sessionDate,
          start_time: '10:00'
        }
      },
      update: { end_time: '13:00', max_capacity: 20 },
      create: {
        session_date: sessionDate,
        start_time: '10:00',
        end_time: '13:00',
        max_capacity: 20
      }
    });

    await prisma.reservation.create({
      data: {
        booking_ref: bookingRef,
        user_id: user.id,
        session_id: sessionChen.id,
        pax: 4,
        assigned_seats: ['1-1', '1-2', '1-3', '1-4'],
        status: 'confirmed',
        checkout_details: {
          version: 2,
          order_addons: [
            { key: 'a_chen', name: '夜光吊飾扣', price: 60, qty: 1, split: { mode: 'proportional' } }
          ],
          persons: []
        }
      }
    });

    // Person 1: actual 188 min (3h8m) -> in grace -> 3h = 450
    const p1 = await prisma.bookingPerson.create({
      data: {
        booking_ref: bookingRef,
        person_no: 1,
        seat_code: '1-1',
        status: 'active',
        billing_start_at: new Date('2026-11-04T10:00:00+08:00'),
        timer_started_at: new Date('2026-11-04T10:00:00+08:00'),
        timer_ended_at: new Date('2026-11-04T13:08:00+08:00'),
        paused_seconds: 0
      }
    });

    // Person 2: actual 215 min -> 3.5h = 525
    await prisma.bookingPerson.create({
      data: {
        booking_ref: bookingRef,
        person_no: 2,
        seat_code: '1-2',
        status: 'active',
        billing_start_at: new Date('2026-11-04T10:00:00+08:00'),
        timer_started_at: new Date('2026-11-04T10:00:00+08:00'),
        timer_ended_at: new Date('2026-11-04T13:47:00+08:00'),
        paused_seconds: 720
      }
    });

    // Person 3: actual 125 min (early leave) -> booked mode收 3h = 450
    const p3 = await prisma.bookingPerson.create({
      data: {
        booking_ref: bookingRef,
        person_no: 3,
        seat_code: '1-3',
        status: 'active',
        billing_start_at: new Date('2026-11-04T10:00:00+08:00'),
        timer_started_at: new Date('2026-11-04T10:00:00+08:00'),
        timer_ended_at: new Date('2026-11-04T12:05:00+08:00'),
        paused_seconds: 0
      }
    });

    // Person 4: actual 180 min -> 3h = 450, board S 3h = 270 -> 720
    const p4 = await prisma.bookingPerson.create({
      data: {
        booking_ref: bookingRef,
        person_no: 4,
        seat_code: '1-4',
        status: 'active',
        billing_start_at: new Date('2026-11-04T10:00:00+08:00'),
        timer_started_at: new Date('2026-11-04T10:00:00+08:00'),
        timer_ended_at: new Date('2026-11-04T13:00:00+08:00'),
        paused_seconds: 0
      }
    });

    await prisma.bookingEquipment.create({
      data: {
        booking_ref: bookingRef,
        equipment_id: 'pegboard_s',
        equipment_name_snapshot: '小板',
        person_id: p4.id,
        unit_group: 'b_chen_4',
        segment_no: 1,
        rental_hours: 3,
        subtotal_price: 270,
        start_at: new Date('2026-11-04T10:00:00+08:00'),
        end_at: new Date('2026-11-04T13:00:00+08:00'),
        unit_rate: 90
      }
    });

    const billResult = await getBookingBill(bookingRef, prisma, new Date('2026-11-04T14:00:00+08:00'));
    const bill = billResult.bill;

    const person3 = bill.persons.find(p => p.person_no === 3);
    assert.equal(person3.entry.hours, 3, 'Person 3 early leave charges booked 3 hours');
    assert.equal(person3.entry.amount, 450);
    assert.equal(bill.summary.amount_due, 2205);
  });

  await t.test('3. 第 1 位付款後，第 2 位加購鑰匙圈並抹零 −17 (Section 4.5.5)', async () => {
    const bookingRef = 'BK-LIN-0001';

    // Mock payment 1 for person 1 ($593)
    const p1Snapshot = {
      person_no: 1,
      seat_code: '2-3',
      label: '第 1 位',
      entry: { mode: 'hourly', hours: 4, amount: 600 },
      board: { amount: 0, units: [] },
      addons: [],
      shares: [
        { source_key: 'order_addon:a1', label: '夜光吊飾扣', amount: 22 },
        { source_key: 'promo:IG50', label: 'IG 打卡折', amount: -18 },
        { source_key: 'manual', label: '手動折讓（熟客優惠）', amount: -11 }
      ],
      promos: [],
      adjust: null,
      total: 593
    };

    await prisma.payment.create({
      data: {
        booking_ref: bookingRef,
        payment_no: 'R-TEST-0001',
        batch_no: 'B-TEST-0001',
        kind: 'charge',
        status: 'valid',
        method: 'cash',
        amount: 593,
        person_nos: [1],
        staff_name: '測試人員',
        device_label: '櫃檯平板',
        breakdown_json: { persons: [p1Snapshot] }
      }
    });

    // Update draft: person 2 adds keychain NT$60 and adjust -17
    await prisma.reservation.updateMany({
      where: { booking_ref: bookingRef },
      data: {
        checkout_details: {
          version: 2,
          order_addons: [
            { key: 'a1', name: '夜光吊飾扣', price: 60, qty: 1, split: { mode: 'proportional' } }
          ],
          order_promos: [
            { key: 'p1', code: 'IG50', name: 'IG 打卡折', discount_type: 'fixed_order', discount_value: 50, split: { mode: 'proportional' } }
          ],
          manual_discount: {
            amount: 30,
            reason: '熟客優惠',
            split: { mode: 'proportional' }
          },
          persons: [
            { person_no: 1, addons: [] },
            {
              person_no: 2,
              addons: [
                { key: 'iron_m', name: '代燙 中板', price: 50, qty: 1 },
                { key: 'kc', name: '鑰匙圈', price: 60, qty: 1 }
              ],
              adjust: { amount: -17, reason: '抹零' }
            }
          ]
        }
      }
    });

    const billResult = await getBookingBill(bookingRef, prisma, new Date('2026-11-04T19:00:00+08:00'));
    const p1 = billResult.bill.persons.find(p => p.person_no === 1);
    const p2 = billResult.bill.persons.find(p => p.person_no === 2);

    assert.equal(p1.total, 593);
    assert.equal(p1.is_frozen, true);
    assert.equal(p2.total, 1100);
  });

  await t.test('4. 付款後才加代燙大板 NT$80，選「也分給已付的人」 (Section 4.5.5)', async () => {
    const bookingRef = 'BK-LIN-0001';

    // Update draft with order addon added after payment with include_paid = true
    await prisma.reservation.updateMany({
      where: { booking_ref: bookingRef },
      data: {
        checkout_details: {
          version: 2,
          order_addons: [
            { key: 'a1', name: '夜光吊飾扣', price: 60, qty: 1, split: { mode: 'proportional' } },
            {
              key: 'a_post_iron',
              name: '代燙大板',
              price: 80,
              qty: 1,
              added_after_payment: true,
              include_paid: true,
              split: { mode: 'proportional' }
            }
          ],
          order_promos: [
            { key: 'p1', code: 'IG50', name: 'IG 打卡折', discount_type: 'fixed_order', discount_value: 50, split: { mode: 'proportional' } }
          ],
          manual_discount: {
            amount: 30,
            reason: '熟客優惠',
            split: { mode: 'proportional' }
          },
          persons: [
            { person_no: 1, addons: [] },
            {
              person_no: 2,
              addons: [
                { key: 'iron_m', name: '代燙 中板', price: 50, qty: 1 }
              ]
            }
          ]
        }
      }
    });

    const billResult = await getBookingBill(bookingRef, prisma, new Date('2026-11-04T19:00:00+08:00'));
    const p1 = billResult.bill.persons.find(p => p.person_no === 1);
    const p2 = billResult.bill.persons.find(p => p.person_no === 2);

    assert.equal(p1.pending_supplement, 29, 'Person 1 pending supplement is NT$29');
    // Person 2 base was 1070 - 13 = 1057; + 51 = 1108
    assert.equal(p2.total, 1108, 'Person 2 share +NT$51 gives 1108');
  });

  await t.test('5. 暫停中直接結帳 (Section 3.3)', async () => {
    const bookingRef = 'BK-PAUSE-0001';

    await prisma.payment.deleteMany({ where: { booking_ref: bookingRef } });
    await prisma.bookingPerson.deleteMany({ where: { booking_ref: bookingRef } });
    await prisma.reservation.deleteMany({ where: { booking_ref: bookingRef } });

    await prisma.reservation.create({
      data: {
        booking_ref: bookingRef,
        user_id: user.id,
        session_id: session.id,
        pax: 1,
        assigned_seats: ['3-1'],
        status: 'confirmed'
      }
    });

    // Started at 14:00, paused at 16:00, checking out at 16:30 while still paused
    // Elapsed = 150m, currently paused = 30m -> actual = 120m (2 hours)
    // Booked = 240m (4 hours), early leave mode = booked -> charge 4 hours = NT$600
    await prisma.bookingPerson.create({
      data: {
        booking_ref: bookingRef,
        person_no: 1,
        seat_code: '3-1',
        status: 'active',
        billing_start_at: new Date('2026-11-04T14:00:00+08:00'),
        timer_started_at: new Date('2026-11-04T14:00:00+08:00'),
        timer_ended_at: null,
        paused_at: new Date('2026-11-04T16:00:00+08:00'),
        paused_seconds: 0
      }
    });

    const billResult = await getBookingBill(bookingRef, prisma, new Date('2026-11-04T16:30:00+08:00'));
    const p1 = billResult.bill.persons[0];
    assert.equal(p1.entry.hours, 4);
    assert.equal(p1.entry.amount, 600);
  });
});
