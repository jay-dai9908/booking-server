/**
 * Shared floor selector pure functions
 * Used across backend (liveService, seatLayoutController) and frontend (SeatingPage, floorSelectors)
 */

/**
 * Checks whether a booking is considered completed / departed (Spec 2.2 item 3)
 * @param {object} booking
 * @param {Date|string|number} [now=new Date()]
 * @returns {boolean}
 */
export function isBookingCompleted(booking, now = new Date()) {
  if (!booking) return false;
  if (booking.attendance === 'completed') return true;
  if (booking.status === 'cancelled') return true;

  // 2026-11-22 店主定案：只要已經報到而且還有人實際在座（left_at 為 null），
  // 即使已結清且預約時段結束，仍不算離場，直到按離場才釋出座位
  if (booking.attendance === 'checked_in' && Array.isArray(booking.persons)) {
    if (booking.persons.some(p => isPersonOnSeat(p, booking))) {
      return false;
    }
  }

  // Paid or waived condition:
  // 已結清或免收，而且預約時段已經結束
  const isPaidOrWaived =
    booking.billing?.status === 'paid' ||
    booking.billing?.status === 'waived' ||
    booking.billing_status === 'paid' ||
    booking.billing_status === 'waived' ||
    booking.status === 'paid' ||
    booking.status === 'waived' ||
    booking.is_paid === true;

  if (isPaidOrWaived) {
    const nowMs = now instanceof Date ? now.getTime() : new Date(now).getTime();

    // 預約時段已經結束
    if (booking.end_at) {
      const endMs = new Date(booking.end_at).getTime();
      if (!isNaN(endMs) && endMs <= nowMs) {
        return true;
      }
    } else if (Array.isArray(booking.sessions) && booking.sessions.length > 0) {
      const sorted = [...booking.sessions].sort((a, b) => (a.start_time || '').localeCompare(b.start_time || ''));
      const lastSession = sorted[sorted.length - 1];
      if (lastSession.session_date && lastSession.end_time) {
        const dStr = typeof lastSession.session_date === 'string'
          ? lastSession.session_date.slice(0, 10)
          : lastSession.session_date.toISOString().slice(0, 10);
        const endMs = new Date(`${dStr}T${lastSession.end_time}:00+08:00`).getTime();
        if (!isNaN(endMs) && endMs <= nowMs) {
          return true;
        }
      }
    } else if (booking.session?.end_time && (booking.session?.session_date || booking.session_date || booking.date)) {
      const d = booking.session.session_date || booking.session_date || booking.date;
      const dStr = typeof d === 'string' ? d.slice(0, 10) : d.toISOString().slice(0, 10);
      const endMs = new Date(`${dStr}T${booking.session.end_time}:00+08:00`).getTime();
      if (!isNaN(endMs) && endMs <= nowMs) {
        return true;
      }
    } else if (booking.end_time && (booking.date || booking.session_date)) {
      const d = (booking.date || booking.session_date);
      const dStr = typeof d === 'string' ? d.slice(0, 10) : d.toISOString().slice(0, 10);
      const endMs = new Date(`${dStr}T${booking.end_time}:00+08:00`).getTime();
      if (!isNaN(endMs) && endMs <= nowMs) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Checks whether a person is physically seated on an active seat (Item 2 / Round 41 Item 2 hook)
 * @param {object} person
 * @param {object} booking
 * @returns {boolean}
 */
export function isPersonOnSeat(person, booking) {
  if (!person || !booking) return false;
  if (booking.attendance !== 'checked_in') return false;
  if (person.status != null && person.status !== 'active') return false;
  const seatCode = person.seat_code ? String(person.seat_code) : '';
  if (!seatCode || seatCode.startsWith('WAIT-')) return false;
  const leftAt = person.left_at !== undefined
    ? person.left_at
    : (person.timer ? person.timer.left_at : null);
  return leftAt == null;
}

/**
 * Compute walk-in billing end time from actual billing start time + booked minutes.
 * @param {{ billingStartAt: Date|string|null|undefined, bookedMinutes: number }} params
 * @returns {Date|null}
 */
export function walkInBillingEndAt({ billingStartAt, bookedMinutes } = {}) {
  if (!billingStartAt) return null;
  const startMs = billingStartAt instanceof Date
    ? billingStartAt.getTime()
    : new Date(billingStartAt).getTime();
  const mins = Number(bookedMinutes);
  if (!Number.isFinite(startMs) || !Number.isFinite(mins) || mins <= 0) return null;
  return new Date(startMs + mins * 60000);
}
