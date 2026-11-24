import test from 'node:test';
import assert from 'node:assert/strict';
import { isBookingCompleted, isPersonOnSeat, walkInBillingEndAt } from '../floorSelectors.js';

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

  await t.test('5. Paid booking with seated guests whose slot has ended stays false until all left_at are set (2026-11-22 rule)', () => {
    const bookingStillSeated = {
      attendance: 'checked_in',
      billing: { status: 'paid' },
      end_at: '2026-11-08T14:00:00Z',
      persons: [
        { person_no: 1, seat_code: 'A1-1', status: 'active', left_at: null, timer: { timer_started_at: '2026-11-08T12:00:00Z', timer_ended_at: '2026-11-08T13:30:00Z' }, paid: true },
        { person_no: 2, seat_code: 'A1-2', status: 'active', left_at: null, timer: { timer_started_at: '2026-11-08T12:00:00Z', timer_ended_at: '2026-11-08T13:30:00Z' }, paid: true }
      ]
    };
    assert.strictEqual(isBookingCompleted(bookingStillSeated, new Date('2026-11-08T17:56:00Z')), false);

    const bookingAllLeft = {
      ...bookingStillSeated,
      persons: bookingStillSeated.persons.map(p => ({ ...p, left_at: '2026-11-08T18:00:00Z' }))
    };
    assert.strictEqual(isBookingCompleted(bookingAllLeft, new Date('2026-11-08T17:56:00Z')), true);
  });

  await t.test('5b. Paid un-checked-in booking whose slot has ended still returns true', () => {
    const unpaidCheckedInNotSeated = {
      attendance: null,
      billing: { status: 'paid' },
      end_at: '2026-11-08T14:00:00Z'
    };
    assert.strictEqual(isBookingCompleted(unpaidCheckedInNotSeated, new Date('2026-11-08T17:56:00Z')), true);
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

  await t.test('9. Round 39 / Round 41 Item 2: isPersonOnSeat checks left_at rather than timer_ended_at', () => {
    const checkedInBooking = { attendance: 'checked_in' };
    const pendingBooking = { attendance: null };
    assert.strictEqual(
      isPersonOnSeat({ status: 'active', seat_code: 'A1-1', timer_ended_at: null, left_at: null }, checkedInBooking),
      true
    );
    // Paid (timer_ended_at set) but still seated (left_at null) -> true
    assert.strictEqual(
      isPersonOnSeat({ status: 'active', seat_code: 'A1-1', timer_ended_at: '2026-11-08T15:30:00Z', left_at: null }, checkedInBooking),
      true
    );
    // Physically left (left_at set) -> false
    assert.strictEqual(
      isPersonOnSeat({ status: 'active', seat_code: 'A1-1', timer_ended_at: '2026-11-08T15:30:00Z', left_at: '2026-11-08T16:00:00Z' }, checkedInBooking),
      false
    );
    // Removed -> false
    assert.strictEqual(
      isPersonOnSeat({ status: 'removed', seat_code: 'A1-1', left_at: null }, checkedInBooking),
      false
    );
    // No seat_code -> false
    assert.strictEqual(
      isPersonOnSeat({ status: 'active', seat_code: null, left_at: null }, checkedInBooking),
      false
    );
    // WAIT-1 -> false
    assert.strictEqual(
      isPersonOnSeat({ status: 'active', seat_code: 'WAIT-1', left_at: null }, checkedInBooking),
      false
    );
    // Not checked in -> false
    assert.strictEqual(
      isPersonOnSeat({ status: 'active', seat_code: 'A1-1', left_at: null }, pendingBooking),
      false
    );
  });

  await t.test('12. walkInBillingEndAt adds bookedMinutes to billingStartAt (14:40 + 120m = 16:40)', () => {
    const end = walkInBillingEndAt({
      billingStartAt: '2099-11-24T14:40:00+08:00',
      bookedMinutes: 120
    });
    assert.ok(end instanceof Date);
    assert.equal(end.toISOString(), new Date('2099-11-24T16:40:00+08:00').toISOString());
    assert.equal(walkInBillingEndAt({ billingStartAt: null, bookedMinutes: 120 }), null);
    assert.equal(walkInBillingEndAt({ billingStartAt: '2099-11-24T14:40:00+08:00', bookedMinutes: 0 }), null);
  });
});

