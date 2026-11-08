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

  const persons = booking.persons || [];

  // 1. All persons have ended timer
  if (persons.length > 0 && persons.every(p => {
    const tm = p.timer || p;
    return Boolean(tm.timer_ended_at);
  })) {
    return true;
  }

  // 2. Paid or waived condition:
  // 訂單狀態是已結清或免收，而且符合下面任一項，就算已離場：
  // - 每一位都已結束計時。
  // - 預約時段已經結束。
  // - 計時還在跑的人都已經被收款涵蓋。
  const isPaidOrWaived =
    booking.billing?.status === 'paid' ||
    booking.billing?.status === 'waived' ||
    booking.billing_status === 'paid' ||
    booking.billing_status === 'waived' ||
    booking.status === 'paid' ||
    booking.status === 'waived' ||
    booking.is_paid === true;

  if (isPaidOrWaived) {
    // Condition a: 每一位都已結束計時
    if (persons.length > 0 && persons.every(p => {
      const tm = p.timer || p;
      return Boolean(tm.timer_ended_at);
    })) {
      return true;
    }

    const nowMs = now instanceof Date ? now.getTime() : new Date(now).getTime();

    // Condition b: 預約時段已經結束
    if (booking.end_at) {
      const endMs = new Date(booking.end_at).getTime();
      if (!isNaN(endMs) && endMs <= nowMs) {
        return true;
      }
    } else if (Array.isArray(booking.sessions) && booking.sessions.length > 0) {
      const sorted = [...booking.sessions].sort((a, b) => a.start_time.localeCompare(b.start_time));
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
    }

    // Condition c: 計時還在跑的人都已經被收款涵蓋
    const runningPersons = persons.filter(p => {
      const tm = p.timer || p;
      return Boolean(tm.timer_started_at || tm.billing_start_at) && !tm.timer_ended_at;
    });

    if (runningPersons.length === 0) {
      return true;
    }

    if (runningPersons.every(p => Boolean(p.paid || p.is_paid))) {
      return true;
    }
  }

  return false;
}
