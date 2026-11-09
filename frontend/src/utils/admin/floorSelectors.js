/**
 * Floor selectors and pure calculation functions for SeatingPage & Checkout
 */
import { isBookingCompleted } from '../../../../shared/floorSelectors.js';
import { formatTimerHMM, formatDiffMinutesText } from '../../../../shared/time.js';
import { displayBoardName } from '../../../../shared/billing.js';

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

export function formatElapsedText(personOrMinutes, maybeNow = new Date()) {
  let mins;
  if (typeof personOrMinutes === 'object' && personOrMinutes !== null) {
    mins = personElapsedMinutes(personOrMinutes, maybeNow);
  } else {
    mins = Number(personOrMinutes);
  }
  if (isNaN(mins) || mins < 0) return '';
  const h = Math.floor(mins / 60);
  const m = mins % 60;
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
  const pillClasses = {
    danger: 'bg-sg-danger-soft text-sg-danger font-bold',
    warning: 'bg-sg-honey-soft text-sg-honey font-bold',
    paused: 'bg-sg-paper text-sg-ink border border-sg-line',
    muted: 'bg-sg-paper text-sg-ink/60 border border-sg-line',
    active: 'bg-sg-sage-soft text-sg-sage-ink font-bold',
    default: 'bg-sg-paper text-sg-ink border border-sg-line'
  };

  const makeResult = (label, variant) => ({
    label,
    variant,
    pillClass: pillClasses[variant] || pillClasses.default
  });

  if (!booking) {
    return makeResult('待入座', 'default');
  }

  // Spec 2.2 item 4: 已結清的訂單不顯示「超時 x 分」
  const isPaid =
    booking.billing?.status === 'paid' ||
    booking.billing?.status === 'waived' ||
    booking.billing_status === 'paid' ||
    booking.billing_status === 'waived' ||
    booking.status === 'paid' ||
    booking.status === 'waived' ||
    booking.is_paid === true;

  if (isPaid) {
    return makeResult('已結清', 'muted');
  }

  // If not checked in
  if (booking.attendance !== 'checked_in') {
    const overdue = formatOverdueText(booking, now);
    if (overdue) {
      if (overdue.isOverdue) {
        return makeResult(overdue.text, 'danger');
      }
      return makeResult(overdue.text, 'warning');
    }
    return makeResult('待入座', 'default');
  }

  // If checked in but needs seating
  if (booking.needs_seating) {
    return makeResult('待帶位', 'warning');
  }

  const persons = booking.persons || [];
  if (persons.length === 0) {
    return makeResult('待入座', 'default');
  }

  // Check if all ended
  const allEnded = persons.every(p => p.timer?.timer_ended_at);
  if (allEnded) {
    return makeResult('已結束', 'muted');
  }

  // Active persons (not ended)
  const activePersons = persons.filter(p => !p.timer?.timer_ended_at && p.timer?.timer_started_at);
  if (activePersons.length === 0) {
    return makeResult('待帶位', 'warning');
  }

  // If all active are paused
  const allPaused = activePersons.every(p => p.timer?.paused_at);
  if (allPaused) {
    return makeResult('已暫停', 'paused');
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
    return makeResult(maxOvertime > 0 ? `超時 ${maxOvertime} 分` : '超時 1 分', 'danger');
  }

  if (hasExpiring) {
    return makeResult(`還有 ${minRemaining} 分`, 'warning');
  }

  return makeResult('計時中', 'active');
}

export { isBookingCompleted };

export function isSessionPast(session, now = new Date()) {
  if (!session) return false;
  const nowTaipeiStr = new Date(now).toLocaleDateString('en-CA', { timeZone: 'Asia/Taipei' });
  const currentHHMM = new Date(now).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Taipei' });

  if (session.session_date) {
    const sDateStr = typeof session.session_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(session.session_date.trim())
      ? session.session_date.trim()
      : new Date(session.session_date).toLocaleDateString('en-CA', { timeZone: 'Asia/Taipei' });
    if (sDateStr < nowTaipeiStr) return true;
    if (sDateStr > nowTaipeiStr) return false;
  }

  if (session.end_time) {
    return session.end_time <= currentHHMM;
  }
  return false;
}

export function getBookingTimeRangeMs(b, fallbackDateStr = null) {
  let startMs = null;
  let endMs = null;

  if (b?.start_at && b?.end_at) {
    const s = new Date(b.start_at).getTime();
    const e = new Date(b.end_at).getTime();
    if (!isNaN(s) && !isNaN(e)) {
      startMs = s;
      endMs = e;
    }
  }

  const d = b?.session_date || b?.date || b?.session?.session_date || fallbackDateStr || new Date().toISOString().slice(0, 10);
  const dStr = typeof d === 'string' ? d.slice(0, 10) : (d instanceof Date ? d.toISOString().slice(0, 10) : '');

  if ((startMs === null || endMs === null) && Array.isArray(b?.sessions) && b.sessions.length > 0) {
    const sorted = [...b.sessions].sort((x, y) => (x.start_time || '').localeCompare(y.start_time || ''));
    const firstS = sorted[0];
    const lastS = sorted[sorted.length - 1];
    const sDate = firstS.session_date ? (typeof firstS.session_date === 'string' ? firstS.session_date.slice(0, 10) : firstS.session_date.toISOString().slice(0, 10)) : dStr;
    if (sDate && firstS.start_time && lastS.end_time) {
      startMs = new Date(`${sDate}T${firstS.start_time}:00+08:00`).getTime();
      endMs = new Date(`${sDate}T${lastS.end_time}:00+08:00`).getTime();
    }
  }

  if (startMs === null || endMs === null) {
    const sess = b?.session || b;
    const st = sess?.start_time || b?.start_time;
    const et = sess?.end_time || b?.end_time;
    if (dStr && st && et) {
      startMs = new Date(`${dStr}T${st}:00+08:00`).getTime();
      endMs = new Date(`${dStr}T${et}:00+08:00`).getTime();
    }
  }

  if (startMs !== null && endMs === null) {
    endMs = startMs + bookedMinutes(b) * 60000;
  }

  return { startMs, endMs };
}

/**
 * Builds seat states map and attention list for FloorPlan and SeatTiles
 *
 * Rules (Round 13b item 1):
 * 1. 已入座、還沒離場的組別永遠優先，不能被覆蓋。
 * 2. 座位空著時，才顯示待入座的預約，而且只看「預約結束時間還沒過」的；有好幾筆時，取開始時間最接近現在的那筆。
 * 3. 預約時段已經結束、還沒報到的（沒來的客人），不佔座位，改列在「需要注意」：「王小華 12:00 的預約沒有報到」，提供「標記未到」。
 *
 * @param {object} layout
 * @param {Array} bookings
 * @param {Date|string|number} [now=new Date()]
 * @param {object} [options={}] - { isSlotPreview: boolean, realNow: Date|string|number }
 * @returns {object} map keyed by seat code with .attentionList attached
 */
export function buildSeatStates(layout = {}, bookings = [], now = new Date(), options = {}) {
  const currentNow = now instanceof Date ? now : new Date(now);
  const currentMs = currentNow.getTime();
  const isSlotPreview = Boolean(options.isSlotPreview);
  const realNowMs = (options.realNow ? (options.realNow instanceof Date ? options.realNow : new Date(options.realNow)) : currentNow).getTime();

  const map = {};
  for (const s of (layout.seats || [])) {
    map[s.code] = {
      state: s.is_active ? 'empty' : 'off',
      isPaid: false,
      timerText: s.is_active ? '空位' : '已停用',
      paxName: null,
      bookingRef: null,
      booking: null,
      boards: [],
      personNo: null
    };
  }

  // Filter bookings:
  // Checked-in active: attendance === 'checked_in' and not completed
  const checkedInActiveBookings = [];
  const candidatePendingBookings = [];
  const unattendedPastBookings = [];

  for (const b of (bookings || [])) {
    if (b.status === 'cancelled') continue;
    if (b.attendance === 'completed') continue;
    const completed = isBookingCompleted(b, currentNow);

    if (b.attendance === 'checked_in') {
      if (completed) continue;
      if (isSlotPreview) {
        // Round 13b Item 3: 選了某個時段時，已入座的人，如果預約到那時還沒結束就照樣顯示
        const { endMs } = getBookingTimeRangeMs(b);
        if (endMs !== null && endMs <= currentMs) {
          // Booking has ended before this preview slot; seat is available for that slot's bookings
          continue;
        }
      }
      checkedInActiveBookings.push(b);
    } else if (b.attendance === 'pending' || !b.attendance) {
      if (completed) continue;
      const { startMs, endMs } = getBookingTimeRangeMs(b);
      const isPastForSlot = endMs !== null && endMs <= currentMs;
      const isPastForAlert = endMs !== null && endMs <= realNowMs;

      if (isPastForSlot) {
        if (isPastForAlert) {
          unattendedPastBookings.push(b);
        }
      } else {
        candidatePendingBookings.push({
          booking: b,
          startMs: startMs ?? currentMs,
          endMs,
          diffFromNow: Math.abs((startMs ?? currentMs) - currentMs)
        });
      }
    }
  }

  // 1. Populate checked-in active bookings (ALWAYS PRIORITY, cannot be overwritten)
  for (const b of checkedInActiveBookings) {
    const isPaid =
      b.billing?.status === 'paid' ||
      b.billing?.status === 'waived' ||
      b.billing_status === 'paid' ||
      b.billing_status === 'waived' ||
      b.status === 'paid' ||
      b.status === 'waived' ||
      Boolean(b.is_paid);

    const bSeats = b.assigned_seats || [];
    bSeats.forEach((seatCode, idx) => {
      if (!seatCode || seatCode.startsWith('WAIT-')) return;
      if (!map[seatCode]) return;

      const person = (b.persons || [])[idx];
      let timerText = '計時中';
      let state = 'in_use';

      if (isPaid) {
        state = 'in_use';
        timerText = '已結清';
      } else if (person) {
        const tm = person.timer || person;
        const isPaused = Boolean(tm.paused_at && !tm.timer_ended_at);
        const rawElapsed = personElapsedMinutes(person, currentNow);
        const totalBooked = bookedMinutes(b);
        const diffMins = rawElapsed - totalBooked;

        if (isPaused) {
          state = 'paused';
          timerText = rawElapsed > 0 ? `暫停 ${formatTimerHMM(rawElapsed)}` : '已暫停';
        } else if (diffMins > 0) {
          state = 'over';
          timerText = formatDiffMinutesText(diffMins);
        } else if (totalBooked - rawElapsed <= 15 && totalBooked > 0) {
          state = 'warn';
          timerText = formatTimerHMM(rawElapsed);
        } else {
          state = 'in_use';
          timerText = formatTimerHMM(rawElapsed);
        }
      }

      const personBoards = (b.boards || []).filter(bd => bd.person_no === (idx + 1));
      const boardLabels = personBoards.map(bd => {
        const segs = bd.segments || [];
        return segs.map(s => displayBoardName(s.name)).join('→');
      });

      map[seatCode] = {
        state,
        isPaid,
        timerText,
        paxName: b.name,
        bookingRef: b.booking_ref,
        booking: b,
        boards: boardLabels,
        personNo: idx + 1
      };
    });
  }

  // 2. Populate pending candidate bookings for empty seats only
  for (const s of (layout.seats || [])) {
    const seatCode = s.code;
    if (!map[seatCode] || map[seatCode].state !== 'empty') {
      // Seat is inactive (off) or already occupied by checked-in active booking
      continue;
    }

    const seatCandidates = candidatePendingBookings.filter(c => {
      const seats = c.booking.assigned_seats || [];
      return seats.includes(seatCode);
    });

    if (seatCandidates.length > 0) {
      // Sort by diffFromNow asc (closest to currentNow)
      seatCandidates.sort((a, b) => a.diffFromNow - b.diffFromNow);
      const best = seatCandidates[0];
      const b = best.booking;
      const seatIdx = (b.assigned_seats || []).indexOf(seatCode);
      const startTimeStr = extractTimeHHMM(b.start_at || b.start_time || (b.sessions && b.sessions[0]?.start_time)) ||
        (b.start_at ? new Date(b.start_at).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Taipei' }) : '');

      map[seatCode] = {
        state: 'reserved',
        isPaid: Boolean(b.is_paid),
        timerText: `${startTimeStr} 到`,
        startTimeStr,
        isLocked: Boolean(b.is_seat_locked || b.seat_source === 'staff'),
        paxName: b.name,
        bookingRef: b.booking_ref,
        booking: b,
        boards: [],
        personNo: seatIdx >= 0 ? seatIdx + 1 : 1
      };
    }
  }

  // 3. Build attention list for un-checked-in past bookings
  const attentionList = unattendedPastBookings.map(b => {
    const startTimeStr = extractTimeHHMM(b.start_at || b.start_time || (b.sessions && b.sessions[0]?.start_time)) ||
      (b.start_at ? new Date(b.start_at).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Taipei' }) : '12:00');
    const title = `${b.name || '客人'} ${startTimeStr} 的預約沒有報到`;
    return {
      type: 'unattended_past',
      booking_ref: b.booking_ref,
      title,
      subtitle: '預約時段已過，尚未報到',
      text: title,
      hint: '提供標記未到',
      action: 'mark_no_show',
      booking: b
    };
  });

  map.attentionList = attentionList;

  return map;
}

/**
 * Round 13b Item 4: 還沒按離場、已付款的人寫「已付款」；真的離場的人才寫「已離場 18:06」
 */
export function getPersonStatusText(p, booking) {
  const isPaused = Boolean(p?.timer?.paused_at && !p?.timer?.timer_ended_at);
  if (isPaused) return '已暫停';

  const isPaid = Boolean(
    p?.paid ||
    booking?.is_paid ||
    booking?.billing?.status === 'paid' ||
    booking?.billing_status === 'paid' ||
    booking?.status === 'paid'
  );

  const isDeparted = booking?.attendance === 'completed';

  if (isPaid) {
    if (isDeparted) {
      const tStr = extractTimeHHMM(p?.timer?.timer_ended_at);
      return tStr ? `已離場 ${tStr}` : '已離場';
    }
    return '已付款';
  }

  if (isDeparted || p?.timer?.timer_ended_at) {
    const tStr = extractTimeHHMM(p?.timer?.timer_ended_at);
    return tStr ? `已離場 ${tStr}` : '已離場';
  }

  return '計時中';
}



