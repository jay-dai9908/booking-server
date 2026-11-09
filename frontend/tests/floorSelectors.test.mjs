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
  buildSeatStates,
  getPersonStatusText
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

  await t.test('11. Prompt 10: isBookingCompleted only returns true when completed or paid and slot ended', () => {
    const activeBooking = {
      attendance: 'checked_in',
      end_at: '2026-11-08T15:00:00+08:00',
      persons: [
        { person_no: 1, timer: { timer_started_at: '2026-11-08T10:00:00+08:00', timer_ended_at: null } },
        { person_no: 2, timer: { timer_started_at: '2026-11-08T10:00:00+08:00', timer_ended_at: '2026-11-08T12:00:00+08:00' } }
      ]
    };
    assert.strictEqual(isBookingCompleted(activeBooking), false);

    const allEndedBooking = {
      attendance: 'checked_in',
      billing: { status: 'paid' },
      end_at: '2026-11-08T15:00:00+08:00',
      persons: [
        { person_no: 1, timer: { timer_started_at: '2026-11-08T10:00:00+08:00', timer_ended_at: '2026-11-08T12:00:00+08:00' } },
        { person_no: 2, timer: { timer_started_at: '2026-11-08T10:00:00+08:00', timer_ended_at: '2026-11-08T12:00:00+08:00' } }
      ]
    };
    // Slot not ended yet at 13:00 -> false
    assert.strictEqual(isBookingCompleted(allEndedBooking, new Date('2026-11-08T13:00:00+08:00')), false);
    // Slot ended at 15:05 -> true
    assert.strictEqual(isBookingCompleted(allEndedBooking, new Date('2026-11-08T15:05:00+08:00')), true);
    // Explicit completed attendance -> true
    assert.strictEqual(isBookingCompleted({ attendance: 'completed' }), true);
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

    // Date object created with local midnight / UTC
    const dateObjUtc = new Date('2026-11-08T00:00:00.000Z');
    assert.strictEqual(isSessionPast({ start_time: '14:00', end_time: '15:00', session_date: dateObjUtc }, now2000), true);
    assert.strictEqual(isSessionPast({ start_time: '20:00', end_time: '21:00', session_date: dateObjUtc }, now2000), false);
  });

  await t.test('13. Spec 2.2 item 4: paid booking displays 已結清 instead of 超時 x 分', () => {
    const paidOverdueBooking = {
      start_at: '2026-11-08T10:00:00+08:00',
      end_at: '2026-11-08T12:00:00+08:00', // 2 hours
      attendance: 'checked_in',
      pax: 1,
      billing: { status: 'paid' },
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
    // 4 hours later (2 hours overdue)
    const now1400 = new Date('2026-11-08T14:00:00+08:00');
    const pill = groupTimerPill(paidOverdueBooking, now1400);
    assert.strictEqual(pill.variant, 'muted');
    assert.strictEqual(pill.label, '已結清');
  });

  await t.test('14. Round 13b item 1: buildSeatStates prevents in-use guest from being overwritten by pending bookings', () => {
    const layout = {
      seats: [
        { id: 1, code: 'A1-1', is_active: true },
        { id: 2, code: 'A1-2', is_active: true }
      ]
    };

    // Guest A: In-use, 14:00~18:00, checked-in
    const bookingA = {
      booking_ref: 'BK-A',
      name: '計時甲',
      attendance: 'checked_in',
      assigned_seats: ['A1-1'],
      start_at: '2026-11-10T14:00:00+08:00',
      end_at: '2026-11-10T18:00:00+08:00',
      persons: [
        {
          person_no: 1,
          seat_code: 'A1-1',
          timer: {
            timer_started_at: '2026-11-10T14:00:00+08:00',
            billing_start_at: '2026-11-10T14:00:00+08:00',
            timer_ended_at: null,
            paused_at: null
          }
        }
      ]
    };

    // Guest B: Unattended 12:00 booking (ended at 14:00), pending
    const bookingB = {
      booking_ref: 'BK-B',
      name: '王小華',
      attendance: 'pending',
      assigned_seats: ['A1-1'],
      start_at: '2026-11-10T12:00:00+08:00',
      end_at: '2026-11-10T14:00:00+08:00'
    };

    // Guest C: Evening 19:00 booking, pending
    const bookingC = {
      booking_ref: 'BK-C',
      name: '預約丙',
      attendance: 'pending',
      assigned_seats: ['A1-1'],
      start_at: '2026-11-10T19:00:00+08:00',
      end_at: '2026-11-10T21:00:00+08:00'
    };

    // Case 1: At 15:00, A is in-use. A must be displayed on A1-1. B and C must not overwrite A.
    const now1500 = new Date('2026-11-10T15:00:00+08:00');
    const statesAt1500 = buildSeatStates(layout, [bookingA, bookingB, bookingC], now1500);
    assert.strictEqual(statesAt1500['A1-1'].state, 'in_use');
    assert.strictEqual(statesAt1500['A1-1'].paxName, '計時甲');
    assert.strictEqual(statesAt1500['A1-1'].bookingRef, 'BK-A');

    // B does not appear on seat A1-1, but is listed in attention list
    assert.ok(statesAt1500.attentionList.some(al => al.booking_ref === 'BK-B' && al.title.includes('王小華 12:00 的預約沒有報到')));

    // Case 2: A departs (marked completed)
    const bookingADeparted = {
      ...bookingA,
      attendance: 'completed'
    };
    const statesAfterADeparted = buildSeatStates(layout, [bookingADeparted, bookingB, bookingC], now1500);
    // Now seat A1-1 is free for pending bookings whose end_at is not past.
    // B's end_at is 14:00 (past), so B still never appears on seat A1-1.
    // C's end_at is 21:00 (not past), so C is displayed.
    assert.strictEqual(statesAfterADeparted['A1-1'].state, 'reserved');
    assert.strictEqual(statesAfterADeparted['A1-1'].paxName, '預約丙');
    assert.strictEqual(statesAfterADeparted['A1-1'].bookingRef, 'BK-C');
    assert.notStrictEqual(statesAfterADeparted['A1-1'].paxName, '王小華');
  });

  await t.test('15. Round 13b item 3: time slot chip selection previews scheduled seats and respects ending bookings', () => {
    const layout = {
      seats: [
        { id: 1, code: 'A1-1', is_active: true },
        { id: 2, code: 'A1-2', is_active: true }
      ]
    };

    // Guest A: In-use, 11:00~14:00, checked-in on A1-1
    const bookingA = {
      booking_ref: 'BK-A',
      name: '計時甲',
      attendance: 'checked_in',
      assigned_seats: ['A1-1'],
      start_at: '2026-11-10T11:00:00+08:00',
      end_at: '2026-11-10T14:00:00+08:00',
      persons: [
        {
          person_no: 1,
          seat_code: 'A1-1',
          timer: {
            timer_started_at: '2026-11-10T11:00:00+08:00',
            billing_start_at: '2026-11-10T11:00:00+08:00',
            timer_ended_at: null
          }
        }
      ]
    };

    // Guest X: In-use, 17:00~20:00, checked-in on A1-2 (crosses 19:00 slot)
    const bookingX = {
      booking_ref: 'BK-X',
      name: '跨時段客人',
      attendance: 'checked_in',
      assigned_seats: ['A1-2'],
      start_at: '2026-11-10T17:00:00+08:00',
      end_at: '2026-11-10T20:00:00+08:00',
      persons: [
        {
          person_no: 1,
          seat_code: 'A1-2',
          timer: {
            timer_started_at: '2026-11-10T17:00:00+08:00',
            billing_start_at: '2026-11-10T17:00:00+08:00',
            timer_ended_at: null
          }
        }
      ]
    };

    // Guest C: 19:00~21:00 pending reservation on A1-1
    const bookingC = {
      booking_ref: 'BK-C',
      name: '預約丙',
      attendance: 'pending',
      assigned_seats: ['A1-1'],
      start_at: '2026-11-10T19:00:00+08:00',
      end_at: '2026-11-10T21:00:00+08:00'
    };

    // Guest F: 17:00~18:00 future booking relative to realNow 15:00
    const bookingF = {
      booking_ref: 'BK-F',
      name: '未來客人',
      attendance: 'pending',
      assigned_seats: ['A1-2'],
      start_at: '2026-11-10T17:00:00+08:00',
      end_at: '2026-11-10T18:00:00+08:00'
    };

    const realNow1500 = new Date('2026-11-10T15:00:00+08:00');
    const slot1900 = new Date('2026-11-10T19:00:00+08:00');

    // Case 1: Slot chip 19:00 selected (isSlotPreview: true)
    const statesAt1900 = buildSeatStates(layout, [bookingA, bookingX, bookingC, bookingF], slot1900, {
      isSlotPreview: true,
      realNow: realNow1500
    });

    // 1. Booking A ended at 14:00 (before 19:00), so A does NOT show on seat A1-1 at 19:00.
    // Instead, seat A1-1 displays Booking C (reserved at 19:00 到).
    assert.strictEqual(statesAt1900['A1-1'].state, 'reserved');
    assert.strictEqual(statesAt1900['A1-1'].paxName, '預約丙');
    assert.strictEqual(statesAt1900['A1-1'].timerText, '19:00 到');

    // 2. Booking X (17:00~20:00) has NOT ended at 19:00, so X照樣顯示 on A1-2.
    assert.strictEqual(statesAt1900['A1-2'].state, 'in_use');
    assert.strictEqual(statesAt1900['A1-2'].paxName, '跨時段客人');

    // 3. Attention list must NOT flag future 17:00 bookingF as unattended when realNow is 15:00
    assert.ok(!statesAt1900.attentionList.some(al => al.booking_ref === 'BK-F'));

    // Case 2: Selected "現在" (isSlotPreview: false, realNow 15:00)
    const statesAtNow1500 = buildSeatStates(layout, [bookingA, bookingX, bookingC, bookingF], realNow1500, {
      isSlotPreview: false,
      realNow: realNow1500
    });
    // In real-time at 15:00, Booking A is physically in-use (overtime 1 hour) and cannot be overwritten by C
    assert.strictEqual(statesAtNow1500['A1-1'].paxName, '計時甲');
    assert.strictEqual(statesAtNow1500['A1-1'].state, 'over');
  });

  await t.test('16. Round 13b item 4: getPersonStatusText shows 已付款 for paid seated guest until actual departure', () => {
    // 1. Paid member, timer ended at checkout, but reservation attendance is still checked_in
    const seatedPaidPerson = {
      person_no: 1,
      paid: true,
      timer: {
        timer_started_at: '2026-11-10T16:00:00+08:00',
        timer_ended_at: '2026-11-10T18:00:00+08:00',
        paused_at: null
      }
    };
    const checkedInBooking = {
      attendance: 'checked_in',
      is_paid: true
    };
    assert.strictEqual(getPersonStatusText(seatedPaidPerson, checkedInBooking), '已付款');

    // 2. Paid member, staff clicked "全組離場", reservation attendance is completed
    const departedBooking = {
      attendance: 'completed',
      is_paid: true
    };
    assert.strictEqual(getPersonStatusText(seatedPaidPerson, departedBooking), '已離場 18:00');

    // 3. Unpaid customer whose timer ended
    const unpaidEndedPerson = {
      person_no: 1,
      paid: false,
      timer: {
        timer_started_at: '2026-11-10T16:00:00+08:00',
        timer_ended_at: '2026-11-10T18:06:00+08:00',
        paused_at: null
      }
    };
    const unpaidBooking = {
      attendance: 'checked_in',
      is_paid: false
    };
    assert.strictEqual(getPersonStatusText(unpaidEndedPerson, unpaidBooking), '已離場 18:06');

    // 4. Running timer customer
    const runningPerson = {
      person_no: 1,
      paid: false,
      timer: {
        timer_started_at: '2026-11-10T16:00:00+08:00',
        timer_ended_at: null,
        paused_at: null
      }
    };
    assert.strictEqual(getPersonStatusText(runningPerson, unpaidBooking), '計時中');

    // 5. Paused customer
    const pausedPerson = {
      person_no: 1,
      paid: false,
      timer: {
        timer_started_at: '2026-11-10T16:00:00+08:00',
        timer_ended_at: null,
        paused_at: '2026-11-10T17:00:00+08:00'
      }
    };
    assert.strictEqual(getPersonStatusText(pausedPerson, unpaidBooking), '已暫停');
  });
});

