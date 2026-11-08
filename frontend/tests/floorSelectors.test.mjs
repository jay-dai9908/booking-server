import test from 'node:test';
import assert from 'node:assert/strict';
import {
  bookingTimeRange,
  bookedMinutes,
  bookingDurationText,
  personElapsedMinutes,
  formatElapsedText,
  personTimerState,
  formatOverdueText,
  groupTimerPill,
} from '../src/utils/admin/floorSelectors.js';

test('floorSelectors pure function tests', async (t) => {
  const sampleBooking = {
    booking_ref: 'BK-595B-9D59',
    start_at: '2026-11-08T11:00:00+08:00',
    end_at: '2026-11-08T15:00:00+08:00',
    attendance: 'checked_in',
    pax: 2,
    persons: [
      {
        person_no: 1,
        seat_code: 'A1-1',
        timer: {
          billing_start_at: '2026-11-08T11:00:00+08:00',
          timer_started_at: '2026-11-08T11:00:00+08:00',
          timer_ended_at: null,
          paused_at: null,
          paused_seconds: 600, // 10 mins paused
        }
      },
      {
        person_no: 2,
        seat_code: 'A1-2',
        timer: {
          billing_start_at: '2026-11-08T11:00:00+08:00',
          timer_started_at: '2026-11-08T11:00:00+08:00',
          timer_ended_at: null,
          paused_at: '2026-11-08T11:30:00+08:00', // currently paused
          paused_seconds: 0,
        }
      }
    ]
  };

  await t.test('1. bookingTimeRange & bookedMinutes', () => {
    assert.strictEqual(bookingTimeRange(sampleBooking), '11:00 到 15:00');
    assert.strictEqual(bookedMinutes(sampleBooking), 240);
    assert.strictEqual(bookingDurationText(sampleBooking), '11:00 到 15:00 · 4 小時');
  });

  await t.test('2. personElapsedMinutes calculates elapsed minus paused seconds', () => {
    // Current time: 12:00:00 (60 minutes since 11:00)
    const now = new Date('2026-11-08T12:00:00+08:00');
    // Person 1: 60 min - 10 min paused = 50 min
    const elapsed1 = personElapsedMinutes(sampleBooking.persons[0], now);
    assert.strictEqual(elapsed1, 50);
    assert.strictEqual(formatElapsedText(elapsed1), '0:50');

    // Person 2: paused at 11:30:00, so elapsed is 30 min
    const elapsed2 = personElapsedMinutes(sampleBooking.persons[1], now);
    assert.strictEqual(elapsed2, 30);
  });

  await t.test('3. personTimerState', () => {
    const now = new Date('2026-11-08T12:00:00+08:00');
    assert.strictEqual(personTimerState(sampleBooking.persons[0], sampleBooking, now), 'running');
    assert.strictEqual(personTimerState(sampleBooking.persons[1], sampleBooking, now), 'paused');

    // Check overtime
    const future = new Date('2026-11-08T15:30:00+08:00'); // 4.5 hours later
    assert.strictEqual(personTimerState(sampleBooking.persons[0], sampleBooking, future), 'overtime');
  });

  await t.test('4. groupTimerPill for checked in group', () => {
    const now = new Date('2026-11-08T12:00:00+08:00');
    const pill = groupTimerPill(sampleBooking, now);
    assert.strictEqual(pill.variant, 'active');
    assert.strictEqual(pill.label, '計時中');
  });

  await t.test('5. groupTimerPill for late & overdue un-checked-in booking', () => {
    const lateBooking = {
      start_at: '2026-11-08T10:00:00+08:00',
      end_at: '2026-11-08T12:00:00+08:00',
      attendance: null
    };

    // 10:12 -> 12 mins late (within 15 min grace period)
    const now1012 = new Date('2026-11-08T10:12:00+08:00');
    const pillLate = groupTimerPill(lateBooking, now1012);
    assert.strictEqual(pillLate.label, '遲到 12 分');
    assert.strictEqual(pillLate.variant, 'warning');

    // 11:13 -> 73 mins from 10:00, 58 mins past retain time
    const now1113 = new Date('2026-11-08T11:13:00+08:00');
    const pillOverdue = groupTimerPill(lateBooking, now1113);
    assert.strictEqual(pillOverdue.label, '已過保留時間 58 分');
    assert.strictEqual(pillOverdue.variant, 'danger');
  });
});
