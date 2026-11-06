import test from 'node:test';
import assert from 'node:assert/strict';
import prisma from '../src/prismaClient.js';
import { getBookingBill, saveDraft, currentRevOf } from '../src/services/billing/billService.js';
import { dateOnly } from '../../shared/time.js';

test('Draft rev concurrency tests (Section 1.1)', async (t) => {
  const TS = Date.now();
  const sessionDate = dateOnly('2026-11-04');

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
      billing_block_minutes: 30
    }
  });

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

  const user = await prisma.user.upsert({
    where: { line_user_id: `test_user_rev_${TS}` },
    update: { name: '測試客' },
    create: { line_user_id: `test_user_rev_${TS}`, name: '測試客', phone: '0912345678' }
  });

  const staffUser = '門市人員小陳';
  const staffId = 99;
  const deviceInfo = { device_id: 'dev-pos-1', device_label: '櫃檯平板' };

  t.after(async () => {
    await prisma.payment.deleteMany({ where: { booking_ref: { startsWith: `BK-DRAFT-${TS}-` } } });
    await prisma.bookingEquipment.deleteMany({ where: { booking_ref: { startsWith: `BK-DRAFT-${TS}-` } } });
    await prisma.bookingPerson.deleteMany({ where: { booking_ref: { startsWith: `BK-DRAFT-${TS}-` } } });
    await prisma.reservation.deleteMany({ where: { booking_ref: { startsWith: `BK-DRAFT-${TS}-` } } });
  });

  await t.test('1. 新訂單：GET 之後拿回傳的 rev 去 PUT，結果是 200', async () => {
    const bRef = `BK-DRAFT-${TS}-1`;
    await prisma.reservation.create({
      data: {
        booking_ref: bRef,
        user_id: user.id,
        session_id: session.id,
        pax: 1,
        status: 'confirmed',
        checkout_details: null
      }
    });

    const getRes = await getBookingBill(bRef);
    const initialRev = getRes.draft.rev;
    assert.equal(initialRev, 0, 'New order draft rev should be 0');

    const newDraft = {
      ...getRes.draft,
      note: '第一次儲存草稿'
    };

    const saveResult = await saveDraft(bRef, initialRev, newDraft, staffUser, staffId, deviceInfo);
    assert.ok(saveResult, 'Save draft should return result');
    assert.equal(saveResult.draft?.rev || saveResult.rev, 1, 'Draft rev should increment to 1');
  });

  await t.test('2. 連續 3 次 PUT，每次都用上一次回傳的 rev，3 次都是 200', async () => {
    const bRef = `BK-DRAFT-${TS}-2`;
    await prisma.reservation.create({
      data: {
        booking_ref: bRef,
        user_id: user.id,
        session_id: session.id,
        pax: 1,
        status: 'confirmed',
        checkout_details: null
      }
    });

    let currentRev = (await getBookingBill(bRef)).draft.rev; // 0
    for (let i = 1; i <= 3; i++) {
      const draft = {
        note: `第 ${i} 次修改草稿`
      };
      const result = await saveDraft(bRef, currentRev, draft, staffUser, staffId, deviceInfo);
      const nextRev = result.draft?.rev ?? result.rev;
      assert.equal(nextRev, i, `Step ${i} rev should be ${i}`);
      currentRev = nextRev;
    }
    assert.equal(currentRev, 3, 'Final rev should be 3');
  });

  await t.test('3. 拿舊的 rev 去 PUT，結果是 409', async () => {
    const bRef = `BK-DRAFT-${TS}-3`;
    await prisma.reservation.create({
      data: {
        booking_ref: bRef,
        user_id: user.id,
        session_id: session.id,
        pax: 1,
        status: 'confirmed',
        checkout_details: null
      }
    });

    const r1 = await saveDraft(bRef, 0, { note: 'v1' }, staffUser, staffId, deviceInfo);
    const rev1 = r1.draft?.rev ?? r1.rev; // 1

    // Try saving with stale rev (0)
    await assert.rejects(
      async () => {
        await saveDraft(bRef, 0, { note: 'stale update' }, staffUser, staffId, deviceInfo);
      },
      (err) => {
        assert.equal(err.status, 409);
        assert.equal(err.code, 'REV_CONFLICT');
        return true;
      }
    );
  });

  await t.test('4. 有 v1 checkout_details 的舊訂單：GET 之後 PUT，結果是 200', async () => {
    const bRef = `BK-DRAFT-${TS}-4`;
    await prisma.reservation.create({
      data: {
        booking_ref: bRef,
        user_id: user.id,
        session_id: session.id,
        pax: 1,
        status: 'confirmed',
        checkout_details: {
          note: '舊版 v1 備註',
          custom_field: 123
        }
      }
    });

    const billRes = await getBookingBill(bRef);
    assert.equal(billRes.draft.rev, 0, 'v1 checkout_details rev should be 0');

    const result = await saveDraft(bRef, billRes.draft.rev, { note: '升級為 v2 草稿' }, staffUser, staffId, deviceInfo);
    const nextRev = result.draft?.rev ?? result.rev;
    assert.equal(nextRev, 1, 'Draft rev upgraded to 1');
  });

  await t.test('5. 端對端：用林小美範例存入加購、IG 打卡折、手動折讓 $30，應收是 NT$1,650', async () => {
    const bRef = `BK-DRAFT-${TS}-5`;
    const resv = await prisma.reservation.create({
      data: {
        booking_ref: bRef,
        user_id: user.id,
        session_id: session.id,
        pax: 2,
        assigned_seats: ['2-3', '2-4'],
        status: 'confirmed',
        checkout_details: null
      }
    });

    const p1 = await prisma.bookingPerson.create({
      data: {
        booking_ref: bRef,
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
        booking_ref: bRef,
        person_no: 2,
        seat_code: '2-4',
        status: 'active',
        billing_start_at: new Date('2026-11-04T14:00:00+08:00'),
        timer_started_at: new Date('2026-11-04T14:00:00+08:00'),
        timer_ended_at: new Date('2026-11-04T18:43:00+08:00'),
        paused_seconds: 720
      }
    });

    await prisma.bookingEquipment.create({
      data: {
        booking_ref: bRef,
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
        booking_ref: bRef,
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

    const billData = await getBookingBill(bRef, prisma, new Date('2026-11-04T19:00:00+08:00'));
    const draftPayload = {
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
    };

    const saveRes = await saveDraft(bRef, billData.draft.rev, draftPayload, staffUser, staffId, deviceInfo);
    const billFinal = await getBookingBill(bRef, prisma, new Date('2026-11-04T19:00:00+08:00'));
    assert.equal(billFinal.bill.summary.amount_due, 1650, '應收應為 NT$1,650');
  });
});
