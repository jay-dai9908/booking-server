import test from 'node:test';
import assert from 'node:assert/strict';
import { isBookingCompleted } from '../floorSelectors.js';

test('isBookingCompleted shared selector tests', async (t) => {
  await t.test('1. Completed attendance returns true', () => {
    assert.strictEqual(isBookingCompleted({ attendance: 'completed' }), true);
  });

  await t.test('2. Cancelled status returns true', () => {
    assert.strictEqual(isBookingCompleted({ status: 'cancelled' }), true);
  });

  await t.test('3. Checked in with all persons ended timer does NOT return true if slot has not ended and attendance not completed', () => {
    const booking = {
      attendance: 'checked_in',
      end_at: '2026-11-08T14:00:00Z',
      persons: [
        { person_no: 1, timer: { timer_started_at: '2026-11-08T10:00:00Z', timer_ended_at: '2026-11-08T12:00:00Z' } },
        { person_no: 2, timer: { timer_started_at: '2026-11-08T10:00:00Z', timer_ended_at: '2026-11-08T11:30:00Z' } }
      ]
    };
    assert.strictEqual(isBookingCompleted(booking, new Date('2026-11-08T12:30:00Z')), false);
  });

  await t.test('4. Checked in active unpaid returns false', () => {
    const booking = {
      attendance: 'checked_in',
      billing: { status: 'unpaid' },
      end_at: '2026-11-08T16:00:00Z',
      persons: [
        { person_no: 1, timer: { timer_started_at: '2026-11-08T10:00:00Z', timer_ended_at: null }, paid: false }
      ]
    };
    assert.strictEqual(isBookingCompleted(booking, new Date('2026-11-08T11:00:00Z')), false);
  });

  await t.test('5. Paid booking whose slot has ended returns true (e.g. 心夜 236m overdue)', () => {
    const booking = {
      attendance: 'checked_in',
      billing: { status: 'paid' },
      end_at: '2026-11-08T14:00:00Z',
      persons: [
        { person_no: 1, timer: { timer_started_at: '2026-11-08T12:00:00Z', timer_ended_at: null }, paid: true },
        { person_no: 2, timer: { timer_started_at: '2026-11-08T12:00:00Z', timer_ended_at: null }, paid: true }
      ]
    };
    // Current time is 17:56 (236 min after 14:00)
    assert.strictEqual(isBookingCompleted(booking, new Date('2026-11-08T17:56:00Z')), true);
  });

  await t.test('6. Paid booking whose slot has NOT ended returns false (remains in-use)', () => {
    const booking = {
      attendance: 'checked_in',
      billing: { status: 'paid' },
      end_at: '2026-11-08T19:00:00Z',
      persons: [
        { person_no: 1, timer: { timer_started_at: '2026-11-08T15:00:00Z', timer_ended_at: null, paused_at: '2026-11-08T16:00:00Z' }, paid: true }
      ]
    };
    // Even though paid, booking time slot is not ended yet -> must return false
    assert.strictEqual(isBookingCompleted(booking, new Date('2026-11-08T16:30:00Z')), false);
  });

  await t.test('7. Partial paid booking where someone running is not paid returns false', () => {
    const booking = {
      attendance: 'checked_in',
      billing: { status: 'partial' },
      end_at: '2026-11-08T18:00:00Z',
      persons: [
        { person_no: 1, timer: { timer_started_at: '2026-11-08T15:00:00Z', timer_ended_at: null }, paid: true },
        { person_no: 2, timer: { timer_started_at: '2026-11-08T15:00:00Z', timer_ended_at: null }, paid: false }
      ]
    };
    assert.strictEqual(isBookingCompleted(booking, new Date('2026-11-08T16:00:00Z')), false);
  });

  await t.test('8. Paid booking with session object whose slot ended returns true, not ended returns false', () => {
    const booking = {
      attendance: 'checked_in',
      billing_status: 'paid',
      session: {
        session_date: '2026-11-08',
        end_time: '18:00'
      }
    };
    assert.strictEqual(isBookingCompleted(booking, new Date('2026-11-08T17:30:00+08:00')), false);
    assert.strictEqual(isBookingCompleted(booking, new Date('2026-11-08T18:05:00+08:00')), true);
  });
});

