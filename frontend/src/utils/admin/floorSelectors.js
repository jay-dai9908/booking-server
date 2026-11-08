/**
 * Floor selectors and pure calculation functions for SeatingPage & Checkout
 */

export function extractTimeHHMM(isoString) {
  if (!isoString) return '';
  const d = new Date(isoString);
  if (isNaN(d.getTime())) return '';
  const hours = String(d.getHours()).padStart(2, '0');
  const minutes = String(d.getMinutes()).padStart(2, '0');
  return `${hours}:${minutes}`;
}

export function formatBookingRef(ref) {
  if (!ref) return '';
  const clean = String(ref).replace(/^BK-/i, '');
  if (clean.length >= 8) {
    return `BK-${clean.slice(0, 4).toUpperCase()}-${clean.slice(4, 8).toUpperCase()}`;
  }
  return `BK-${clean.toUpperCase()}`;
}

export function bookingTimeRange(booking) {
  if (!booking) return '';
  const start = extractTimeHHMM(booking.start_at);
  const end = extractTimeHHMM(booking.end_at);
  if (start && end) {
    return `${start} 到 ${end}`;
  }
  return booking.time_range || '';
}

export function bookedMinutes(booking) {
  if (!booking?.start_at || !booking?.end_at) {
    if (booking?.session_count) return booking.session_count * 60;
    return 60;
  }
  const s = new Date(booking.start_at).getTime();
  const e = new Date(booking.end_at).getTime();
  if (isNaN(s) || isNaN(e) || e <= s) return 60;
  return Math.round((e - s) / 60000);
}

export function bookingDurationText(booking) {
  const range = bookingTimeRange(booking);
  const mins = bookedMinutes(booking);
  const hours = mins / 60;
  const hoursText = Number.isInteger(hours) ? `${hours} 小時` : `${hours.toFixed(1)} 小時`;
  if (range) {
    return `${range} · ${hoursText}`;
  }
  return hoursText;
}

export function personElapsedMinutes(person, now = new Date()) {
  const timer = person?.timer;
  if (!timer) return 0;

  const startIso = timer.billing_start_at || timer.timer_started_at;
  if (!startIso) return 0;

  const startTime = new Date(startIso).getTime();
  if (isNaN(startTime)) return 0;

  let endTime;
  if (timer.timer_ended_at) {
    endTime = new Date(timer.timer_ended_at).getTime();
  } else if (timer.paused_at) {
    endTime = new Date(timer.paused_at).getTime();
  } else {
    endTime = (now instanceof Date ? now : new Date(now)).getTime();
  }

  const pausedSec = timer.paused_seconds || 0;
  const totalSeconds = Math.max(0, Math.floor((endTime - startTime) / 1000) - pausedSec);
  return Math.floor(totalSeconds / 60);
}

export function formatElapsedText(elapsedMinutes) {
  const h = Math.floor(elapsedMinutes / 60);
  const m = elapsedMinutes % 60;
  return `${h}:${String(m).padStart(2, '0')}`;
}

export function personTimerState(person, booking, now = new Date()) {
  const timer = person?.timer;
  if (!timer || !timer.timer_started_at) return 'not_started';
  if (timer.timer_ended_at) return 'ended';
  if (timer.paused_at) return 'paused';

  const elapsed = personElapsedMinutes(person, now);
  const total = bookedMinutes(booking);
  if (elapsed >= total) return 'overtime';
  if (total - elapsed <= 15) return 'expiring';
  return 'running';
}

export function formatOverdueText(booking, now = new Date()) {
  if (booking?.attendance === 'checked_in') return null;
  if (!booking?.start_at) return null;

  const start = new Date(booking.start_at).getTime();
  const current = (now instanceof Date ? now : new Date(now)).getTime();
  const diffMins = Math.floor((current - start) / 60000);

  if (diffMins <= 0) return null;
  if (diffMins <= 15) {
    return { text: `遲到 ${diffMins} 分`, isLate: true, isOverdue: false, minutes: diffMins };
  }
  const overdueMins = diffMins - 15;
  return { text: `已過保留時間 ${overdueMins} 分`, isLate: false, isOverdue: true, minutes: overdueMins };
}

export function groupTimerPill(booking, now = new Date()) {
  if (!booking) {
    return { label: '待入座', variant: 'default' };
  }

  // If not checked in
  if (booking.attendance !== 'checked_in') {
    const overdue = formatOverdueText(booking, now);
    if (overdue) {
      if (overdue.isOverdue) {
        return { label: overdue.text, variant: 'danger' };
      }
      return { label: overdue.text, variant: 'warning' };
    }
    return { label: '待入座', variant: 'default' };
  }

  // If checked in but needs seating
  if (booking.needs_seating) {
    return { label: '待帶位', variant: 'warning' };
  }

  const persons = booking.persons || [];
  if (persons.length === 0) {
    return { label: '待入座', variant: 'default' };
  }

  // Check if all ended
  const allEnded = persons.every(p => p.timer?.timer_ended_at);
  if (allEnded) {
    return { label: '已結束', variant: 'muted' };
  }

  // Active persons (not ended)
  const activePersons = persons.filter(p => !p.timer?.timer_ended_at && p.timer?.timer_started_at);
  if (activePersons.length === 0) {
    return { label: '待帶位', variant: 'warning' };
  }

  // If all active are paused
  const allPaused = activePersons.every(p => p.timer?.paused_at);
  if (allPaused) {
    return { label: '已暫停', variant: 'paused' };
  }

  // Check overtime / expiring
  const totalBooked = bookedMinutes(booking);
  let maxOvertime = 0;
  let minRemaining = Infinity;
  let hasOvertime = false;
  let hasExpiring = false;

  for (const p of activePersons) {
    if (p.timer?.paused_at) continue;
    const elapsed = personElapsedMinutes(p, now);
    if (elapsed >= totalBooked) {
      hasOvertime = true;
      const over = elapsed - totalBooked;
      if (over > maxOvertime) maxOvertime = over;
    } else {
      const remaining = totalBooked - elapsed;
      if (remaining <= 15) {
        hasExpiring = true;
        if (remaining < minRemaining) minRemaining = remaining;
      }
    }
  }

  if (hasOvertime) {
    return { label: maxOvertime > 0 ? `超時 ${maxOvertime} 分` : '已超時', variant: 'danger' };
  }

  if (hasExpiring) {
    return { label: `剩餘 ${minRemaining} 分`, variant: 'warning' };
  }

  return { label: '計時中', variant: 'active' };
}
