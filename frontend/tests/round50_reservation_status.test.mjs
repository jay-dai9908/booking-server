import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { reservationStatusPill, resolveReservationWindow } from '../src/utils/customer/reservationStatus.js';

describe('Round 50 Item 2: reservationStatusPill & resolveReservationWindow', () => {
  test('self-service status pills reflect real-time progress without false no-show', () => {
    const base = {
      status: 'confirmed',
      attendance: 'pending',
      is_self_service: true,
      session_date: '2026-12-02',
      start_time: '14:00',
      end_time: '18:00',
    };

    // Before start on same day in Taipei
    assert.deepEqual(
      reservationStatusPill(base, new Date('2026-12-02T05:00:00Z')),
      { variant: 'brand', text: '已預約 · 今天' }
    );
    // 1 day before (2026-12-01 23:00 Taipei = 2026-12-01T15:00:00Z)
    assert.deepEqual(
      reservationStatusPill(base, new Date('2026-12-01T15:00:00Z')),
      { variant: 'brand', text: '已預約 · 明天' }
    );
    // Past start + 30 min (14:30 Taipei = 06:30Z), not checked in -> 進行中
    assert.deepEqual(
      reservationStatusPill(base, new Date('2026-12-02T06:30:00Z')),
      { variant: 'ok', text: '進行中' }
    );
    // Checked in during session -> 已報到
    assert.deepEqual(
      reservationStatusPill({ ...base, attendance: 'checked_in' }, new Date('2026-12-02T07:00:00Z')),
      { variant: 'ok', text: '已報到' }
    );
    // After end without check-in -> 已結束
    assert.deepEqual(
      reservationStatusPill(base, new Date('2026-12-02T10:05:00Z')),
      { variant: 'full', text: '已結束' }
    );
    // After end with check-in -> 已完成
    assert.deepEqual(
      reservationStatusPill({ ...base, attendance: 'checked_in' }, new Date('2026-12-02T10:05:00Z')),
      { variant: 'full', text: '已完成' }
    );
    // Explicit no_show on self-service -> 已結束
    assert.deepEqual(
      reservationStatusPill({ ...base, attendance: 'no_show' }, new Date('2026-12-02T06:30:00Z')),
      { variant: 'full', text: '已結束' }
    );
  });

  test('normal-day status pills separate pending past-start from staff-marked no_show', () => {
    const base = {
      status: 'confirmed',
      attendance: 'pending',
      is_self_service: false,
      session_date: '2026-12-02',
      start_time: '14:00',
      end_time: '16:00',
    };

    // Cancelled always 已取消
    assert.deepEqual(
      reservationStatusPill({ ...base, status: 'cancelled' }, new Date('2026-12-02T06:30:00Z')),
      { variant: 'full', text: '已取消' }
    );
    // Past start+15m while still pending -> 已過開始時間
    assert.deepEqual(
      reservationStatusPill(base, new Date('2026-12-02T06:20:00Z')),
      { variant: 'low', text: '已過開始時間' }
    );
    // Staff marked no_show -> 預約未到
    assert.deepEqual(
      reservationStatusPill({ ...base, attendance: 'no_show' }, new Date('2026-12-02T06:20:00Z')),
      { variant: 'full', text: '預約未到' }
    );
  });

  test('resolveReservationWindow supports 24:00 and cross-midnight end times in +08:00', () => {
    const win24 = resolveReservationWindow({
      session_date: '2026-12-02',
      start_time: '18:00',
      end_time: '24:00',
    });
    assert.equal(win24.startDt.toISOString(), '2026-12-02T10:00:00.000Z');
    assert.equal(win24.endDt.toISOString(), '2026-12-02T16:00:00.000Z');

    const winCross = resolveReservationWindow({
      session_date: '2026-12-02',
      start_time: '22:00',
      end_time: '02:00',
    });
    assert.equal(winCross.startDt.toISOString(), '2026-12-02T14:00:00.000Z');
    assert.equal(winCross.endDt.toISOString(), '2026-12-02T18:00:00.000Z');
  });
});
