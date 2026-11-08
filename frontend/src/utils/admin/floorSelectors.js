/**
 * Floor selectors and pure calculation functions for SeatingPage & Checkout
 */

export function extractTimeHHMM(isoString) {
  if (!isoString) return '';
  if (typeof isoString === 'string') {
    const match = isoString.trim().match(/^(\d{1,2}:\d{2})(?::\d{2})?$/);
    if (match) {
      return match[1].length === 4 ? `0${match[1]}` : match[1];
    }
  }
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

export function bookingTimeRange(bookingOrStart, maybeEnd) {
  if (!bookingOrStart) return '';
  if (typeof bookingOrStart === 'object' && !(bookingOrStart instanceof Date)) {
    const st = extractTimeHHMM(bookingOrStart.start_time) || bookingOrStart.start_time;
    const et = extractTimeHHMM(bookingOrStart.end_time) || bookingOrStart.end_time;
    if (st && et) {
      return `${st} 到 ${et}`;
    }
    if (Array.isArray(bookingOrStart.sessions) && bookingOrStart.sessions.length > 0) {
      const sorted = [...bookingOrStart.sessions].sort((a, b) => a.start_time.localeCompare(b.start_time));
      const s = extractTimeHHMM(sorted[0].start_time) || sorted[0].start_time;
      const e = extractTimeHHMM(sorted[sorted.length - 1].end_time) || sorted[sorted.length - 1].end_time;
      return `${s} 到 ${e}`;
    }
    const start = extractTimeHHMM(bookingOrStart.start_at);
    const end = extractTimeHHMM(bookingOrStart.end_at);
    if (start && end) {
      return `${start} 到 ${end}`;
    }
    return bookingOrStart.time_range || '';
  }
  const start = extractTimeHHMM(bookingOrStart) || bookingOrStart;
  const end = extractTimeHHMM(maybeEnd) || maybeEnd;
  if (start && end) {
    return `${start} 到 ${end}`;
  }
  return '';
}

function parseTimeToMinutes(t) {
  if (!t || typeof t !== 'string') return null;
  const match = t.trim().match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
  if (!match) return null;
  return parseInt(match[1], 10) * 60 + parseInt(match[2], 10);
}

export function bookedMinutes(booking, maybeEnd) {
  let start_at = booking?.start_at;
  let end_at = booking?.end_at;
  if ((typeof booking === 'string' || booking instanceof Date) && (typeof maybeEnd === 'string' || maybeEnd instanceof Date)) {
    start_at = booking;
    end_at = maybeEnd;
  }

  const startTimeStr = booking?.start_time || (typeof start_at === 'string' && start_at.includes(':') && !start_at.includes('T') ? start_at : null);
  const endTimeStr = booking?.end_time || (typeof end_at === 'string' && end_at.includes(':') && !end_at.includes('T') ? end_at : null);

  if (startTimeStr && endTimeStr) {
    const sMin = parseTimeToMinutes(startTimeStr);
    const eMin = parseTimeToMinutes(endTimeStr);
    if (sMin !== null && eMin !== null && eMin > sMin) {
      return eMin - sMin;
    }
  }

  if (Array.isArray(booking?.sessions) && booking.sessions.length > 0) {
    const sorted = [...booking.sessions].sort((a, b) => (a.start_time || '').localeCompare(b.start_time || ''));
    const sMin = parseTimeToMinutes(sorted[0].start_time);
    const eMin = parseTimeToMinutes(sorted[sorted.length - 1].end_time);
    if (sMin !== null && eMin !== null && eMin > sMin) {
      return eMin - sMin;
    }
  }

  if (!start_at || !end_at) {
    if (booking?.session_count) return booking.session_count * 60;
    return 60;
  }
  const s = new Date(start_at).getTime();
  const e = new Date(end_at).getTime();
  if (isNaN(s) || isNaN(e) || e <= s) {
    if (booking?.session_count) return booking.session_count * 60;
    return 60;
  }
  return Math.round((e - s) / 60000);
}

export function bookingDurationText(booking, maybeEnd) {
  const range = bookingTimeRange(booking, maybeEnd);
  const mins = bookedMinutes(booking, maybeEnd);
  const hours = mins / 60;
  const hoursText = Number.isInteger(hours) ? `${hours} 小時` : `${hours.toFixed(1)} 小時`;
  if (range) {
    return `${range} · ${hoursText}`;
  }
  return hoursText;
}

export function personElapsedMinutes(person, now = new Date()) {
  const timer = person?.timer || person;
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
  const timer = person?.timer || person;
  if (!timer || !timer.timer_started_at) return 'not_started';
  if (timer.timer_ended_at) return 'ended';
  if (timer.paused_at) return 'paused';

  const elapsed = personElapsedMinutes(person, now);
  const total = bookedMinutes(booking);
  if (elapsed >= total) return 'overtime';
  if (total - elapsed <= 15) return 'expiring';
  return 'running';
}

export function formatOverdueText(bookingOrMins, now = new Date()) {
  let diffMins;
  if (typeof bookingOrMins === 'number') {
    diffMins = bookingOrMins;
  } else {
    if (bookingOrMins?.attendance === 'checked_in') return null;
    if (!bookingOrMins?.start_at) return null;
    const start = new Date(bookingOrMins.start_at).getTime();
    const current = (now instanceof Date ? now : new Date(now)).getTime();
    diffMins = Math.floor((current - start) / 60000);
  }

  if (diffMins <= 0) return null;
  if (diffMins <= 15) {
    return { text: `遲到 ${diffMins} 分`, isLate: true, isOverdue: false, severity: 'warning', minutes: diffMins };
  }
  const overdueMins = diffMins - 15;
  let overdueStr;
  if (overdueMins >= 60) {
    const h = Math.floor(overdueMins / 60);
    const m = overdueMins % 60;
    overdueStr = m > 0 ? `${h} 小時 ${m} 分` : `${h} 小時`;
  } else {
    overdueStr = `${overdueMins} 分`;
  }
  return { text: `已過保留時間 ${overdueStr}`, isLate: false, isOverdue: true, severity: 'danger', minutes: overdueMins };
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
    if (elapsed > totalBooked) {
      hasOvertime = true;
      const over = elapsed - totalBooked;
      if (over > maxOvertime) maxOvertime = over;
    } else {
      const remaining = totalBooked - elapsed;
      if (remaining <= 30) {
        hasExpiring = true;
        if (remaining < minRemaining) minRemaining = remaining;
      }
    }
  }

  if (hasOvertime) {
    return { label: maxOvertime > 0 ? `超時 ${maxOvertime} 分` : '超時 1 分', variant: 'danger' };
  }

  if (hasExpiring) {
    return { label: `還有 ${minRemaining} 分`, variant: 'warning' };
  }

  return { label: '計時中', variant: 'active' };
}

export function isBookingCompleted(booking) {
  if (!booking) return false;
  if (booking.attendance === 'completed') return true;
  if (booking.attendance === 'checked_in') {
    const persons = booking.persons || [];
    if (persons.length > 0 && persons.every(p => {
      const tm = p.timer || p;
      return Boolean(tm.timer_ended_at);
    })) {
      return true;
    }
  }
  return false;
}

