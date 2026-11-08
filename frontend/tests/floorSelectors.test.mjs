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
  isBookingCompleted,
  isSessionPast,
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
    // Test dual string/date parameters
    assert.strictEqual(bookingTimeRange(sampleBooking.start_at, sampleBooking.end_at), '11:00 到 15:00');
    assert.strictEqual(bookedMinutes(sampleBooking.start_at, sampleBooking.end_at), 240);
    assert.strictEqual(bookingDurationText(sampleBooking.start_at, sampleBooking.end_at), '11:00 到 15:00 · 4 小時');
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

  await t.test('3. Spec test: 預約 3 小時，計時 3:08', () => {
    const threeHourBooking = {
      start_at: '2026-11-08T10:00:00+08:00',
      end_at: '2026-11-08T13:00:00+08:00',
      attendance: 'checked_in',
      pax: 1,
      persons: [
        {
          person_no: 1,
          seat_code: 'A1-1',
          timer: {
            billing_start_at: '2026-11-08T10:00:00+08:00',
            timer_started_at: '2026-11-08T10:00:00+08:00',
            timer_ended_at: null,
            paused_at: null,
            paused_seconds: 0
          }
        }
      ]
    };
    assert.strictEqual(bookedMinutes(threeHourBooking), 180);
    assert.strictEqual(bookingDurationText(threeHourBooking), '10:00 到 13:00 · 3 小時');

    // 3 hours and 8 minutes later: 13:08
    const now1308 = new Date('2026-11-08T13:08:00+08:00');
    const elapsed = personElapsedMinutes(threeHourBooking.persons[0], now1308);
    assert.strictEqual(elapsed, 188);
    assert.strictEqual(formatElapsedText(elapsed), '3:08');
    assert.strictEqual(personTimerState(threeHourBooking.persons[0], threeHourBooking, now1308), 'overtime');
  });

  await t.test('4. Spec test: 超時 31 分', () => {
    const overtimeBooking = {
      start_at: '2026-11-08T10:00:00+08:00',
      end_at: '2026-11-08T12:00:00+08:00', // 2 hours = 120 mins
      attendance: 'checked_in',
      pax: 1,
      persons: [
        {
          person_no: 1,
          seat_code: 'A1-1',
          timer: {
            billing_start_at: '2026-11-08T10:00:00+08:00',
            timer_started_at: '2026-11-08T10:00:00+08:00',
            timer_ended_at: null,
            paused_at: null,
            paused_seconds: 0
          }
        }
      ]
    };
    // 2 hours + 31 mins = 12:31
    const now1231 = new Date('2026-11-08T12:31:00+08:00');
    const pill = groupTimerPill(overtimeBooking, now1231);
    assert.strictEqual(pill.variant, 'danger');
    assert.strictEqual(pill.label, '超時 31 分');
  });

  await t.test('5. Spec test: 剩 30 分鐘內顯示「還有 x 分」', () => {
    const expiringBooking = {
      start_at: '2026-11-08T10:00:00+08:00',
      end_at: '2026-11-08T12:00:00+08:00', // 120 mins
      attendance: 'checked_in',
      pax: 1,
      persons: [
        {
          person_no: 1,
          seat_code: 'A1-1',
          timer: {
            billing_start_at: '2026-11-08T10:00:00+08:00',
            timer_started_at: '2026-11-08T10:00:00+08:00',
            timer_ended_at: null,
            paused_at: null,
            paused_seconds: 0
          }
        }
      ]
    };
    // 11:35 -> elapsed 95 mins, remaining 25 mins <= 30 mins
    const now1135 = new Date('2026-11-08T11:35:00+08:00');
    const pill = groupTimerPill(expiringBooking, now1135);
    assert.strictEqual(pill.variant, 'warning');
    assert.strictEqual(pill.label, '還有 25 分');
  });

  await t.test('6. Spec test: 暫停中 (全部暫停才顯示「已暫停」)', () => {
    const pausedBooking = {
      start_at: '2026-11-08T10:00:00+08:00',
      end_at: '2026-11-08T12:00:00+08:00',
      attendance: 'checked_in',
      pax: 1,
      persons: [
        {
          person_no: 1,
          seat_code: 'A1-1',
          timer: {
            billing_start_at: '2026-11-08T10:00:00+08:00',
            timer_started_at: '2026-11-08T10:00:00+08:00',
            timer_ended_at: null,
            paused_at: '2026-11-08T10:30:00+08:00',
            paused_seconds: 0
          }
        }
      ]
    };
    const now1100 = new Date('2026-11-08T11:00:00+08:00');
    assert.strictEqual(personTimerState(pausedBooking.persons[0], pausedBooking, now1100), 'paused');
    const pill = groupTimerPill(pausedBooking, now1100);
    assert.strictEqual(pill.variant, 'paused');
    assert.strictEqual(pill.label, '已暫停');
  });

  await t.test('7. Spec test: 已離場', () => {
    const endedBooking = {
      start_at: '2026-11-08T10:00:00+08:00',
      end_at: '2026-11-08T12:00:00+08:00',
      attendance: 'checked_in',
      pax: 1,
      persons: [
        {
          person_no: 1,
          seat_code: 'A1-1',
          timer: {
            billing_start_at: '2026-11-08T10:00:00+08:00',
            timer_started_at: '2026-11-08T10:00:00+08:00',
            timer_ended_at: '2026-11-08T11:45:00+08:00',
            paused_at: null,
            paused_seconds: 0
          }
        }
      ]
    };
    const now1200 = new Date('2026-11-08T12:00:00+08:00');
    assert.strictEqual(personTimerState(endedBooking.persons[0], endedBooking, now1200), 'ended');
    const pill = groupTimerPill(endedBooking, now1200);
    assert.strictEqual(pill.variant, 'muted');
    assert.strictEqual(pill.label, '已結束');
  });

  await t.test('8. Spec test: 沒有 BookingPerson', () => {
    const unseatedBooking = {
      start_at: '2026-11-08T10:00:00+08:00',
      end_at: '2026-11-08T12:00:00+08:00',
      attendance: 'checked_in',
      needs_seating: true,
      pax: 2,
      persons: []
    };
    const now1010 = new Date('2026-11-08T10:10:00+08:00');
    const pill = groupTimerPill(unseatedBooking, now1010);
    assert.strictEqual(pill.variant, 'warning');
    assert.strictEqual(pill.label, '待帶位');
  });

  await t.test('9. groupTimerPill for late & overdue un-checked-in booking', () => {
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

    // 11:13 -> 73 mins from 10:00, 58 mins past retain time (<60m)
    const now1113 = new Date('2026-11-08T11:13:00+08:00');
    const pillOverdue = groupTimerPill(lateBooking, now1113);
    assert.strictEqual(pillOverdue.label, '已過保留時間 58 分');
    assert.strictEqual(pillOverdue.variant, 'danger');

    // 11:53 -> 113 mins from 10:00, 98 mins past retain time (1 hr 38 mins)
    const now1153 = new Date('2026-11-08T11:53:00+08:00');
    const pillOverdueHour = groupTimerPill(lateBooking, now1153);
    assert.strictEqual(pillOverdueHour.label, '已過保留時間 1 小時 38 分');
    assert.strictEqual(pillOverdueHour.variant, 'danger');
  });

  await t.test('10. Spec 2.1: Lin Hsiao-mei 15:00-19:00 booked duration and raw person timer calculation', () => {
    const linBooking = {
      start_time: '15:00',
      end_time: '19:00'
    };
    assert.strictEqual(bookedMinutes(linBooking), 240);
    assert.strictEqual(bookingDurationText(linBooking), '15:00 到 19:00 · 4 小時');

    // Raw person directly from GET /billing/:ref without nested .timer object
    const rawPerson = {
      person_no: 1,
      billing_start_at: '2026-11-08T15:00:00+08:00',
      timer_started_at: '2026-11-08T15:00:00+08:00',
      timer_ended_at: null,
      paused_at: null,
      paused_seconds: 0
    };
    const now = new Date('2026-11-08T15:39:00+08:00');
    const elapsed = personElapsedMinutes(rawPerson, now);
    assert.strictEqual(elapsed, 39);
    assert.strictEqual(formatElapsedText(elapsed), '0:39');
  });

  await t.test('11. Spec 2.2: isBookingCompleted returns true when all persons have ended timer', () => {
    const activeBooking = {
      attendance: 'checked_in',
      persons: [
        { person_no: 1, timer: { timer_started_at: '2026-11-08T10:00:00+08:00', timer_ended_at: null } },
        { person_no: 2, timer: { timer_started_at: '2026-11-08T10:00:00+08:00', timer_ended_at: '2026-11-08T12:00:00+08:00' } }
      ]
    };
    assert.strictEqual(isBookingCompleted(activeBooking), false);

    const allEndedBooking = {
      attendance: 'checked_in',
      billing: { status: 'paid' },
      persons: [
        { person_no: 1, timer: { timer_started_at: '2026-11-08T10:00:00+08:00', timer_ended_at: '2026-11-08T12:00:00+08:00' } },
        { person_no: 2, timer: { timer_started_at: '2026-11-08T10:00:00+08:00', timer_ended_at: '2026-11-08T12:00:00+08:00' } }
      ]
    };
    assert.strictEqual(isBookingCompleted(allEndedBooking), true);
  });

  await t.test('12. Spec 2.8: isSessionPast disables past sessions', () => {
    // Current time: 2026-11-08 20:00 (Asia/Taipei)
    const now2000 = new Date('2026-11-08T20:00:00+08:00');
    
    // 14:00~15:00 on same day -> ended at 15:00 <= 20:00 -> true
    assert.strictEqual(isSessionPast({ start_time: '14:00', end_time: '15:00', session_date: '2026-11-08' }, now2000), true);
    
    // 19:00~20:00 on same day -> ended at 20:00 <= 20:00 -> true
    assert.strictEqual(isSessionPast({ start_time: '19:00', end_time: '20:00', session_date: '2026-11-08' }, now2000), true);
    
    // 20:00~21:00 on same day -> ends at 21:00 > 20:00 -> false
    assert.strictEqual(isSessionPast({ start_time: '20:00', end_time: '21:00', session_date: '2026-11-08' }, now2000), false);
    
    // Tomorrow 14:00~15:00 -> false
    assert.strictEqual(isSessionPast({ start_time: '14:00', end_time: '15:00', session_date: '2026-11-09' }, now2000), false);
  });
});
