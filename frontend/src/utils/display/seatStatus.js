// frontend/src/utils/display/seatStatus.js

export const BEAD_COLORS = {
  run: { bg: '#E7EEE2', bd: '#7E9A72', fg: '#4A6541' },
  soon: { bg: '#F6EAD2', bd: '#D9A441', fg: '#7A4F12' },
  over: { bg: '#B4553F', bd: '#B4553F', fg: '#FFFDF9' },
  unl: { bg: '#F7E3DA', bd: '#E7B4A2', fg: '#8A4A36' },
  paused: { bg: '#E3ECF2', bd: '#4F7FA0', fg: '#2F5872' },
  booked: { bg: '#FFFDF9', bd: '#C9BFB4', fg: '#6F645B' }
};

export const DAY_TYPE_LABELS = {
  self: '半自助日',
  weekday: '平日',
  holiday: '假日',
  closed: '公休日'
};

/**
 * Format seconds as h:mm (e.g. 0:05, 3:08).
 * Floors to whole minutes, matching live floor timer display.
 */
export function formatDurationHMM(seconds) {
  const s = Math.max(0, Math.floor(Math.abs(Number(seconds) || 0)));
  const totalMins = Math.floor(s / 60);
  const hrs = Math.floor(totalMins / 60);
  const mins = totalMins % 60;
  return `${hrs}:${String(mins).padStart(2, '0')}`;
}

/**
 * Format timestamp / Date / ISO string as HH:mm in Asia/Taipei.
 */
export function formatTaipeiHHmm(msOrDate) {
  const d = msOrDate instanceof Date ? msOrDate : new Date(msOrDate);
  if (Number.isNaN(d.getTime())) return '--:--';
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Taipei',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).formatToParts(d);
  const map = Object.fromEntries(parts.map(p => [p.type, p.value]));
  const hr = map.hour === '24' ? '00' : map.hour;
  return `${hr}:${map.minute}`;
}

/**
 * Format timestamp / Date / ISO string as MM/DD（X） in Asia/Taipei (matches mock: 11/22（日）).
 */
export function formatTaipeiDateShort(msOrDate) {
  const d = msOrDate instanceof Date ? msOrDate : new Date(msOrDate);
  if (Number.isNaN(d.getTime())) return '';
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Taipei',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short'
  }).formatToParts(d);
  const map = Object.fromEntries(parts.map(p => [p.type, p.value]));
  const dateStr = `${map.year}-${map.month}-${map.day}`;
  const midnight = new Date(`${dateStr}T12:00:00+08:00`);
  const dayNames = ['日', '一', '二', '三', '四', '五', '六'];
  const w = dayNames[midnight.getUTCDay()] || '';
  return `${map.month}/${map.day}（${w}）`;
}

/**
 * Compute Taipei YYYY-MM-DD from msOrDate.
 */
export function getTaipeiDateStr(msOrDate) {
  const d = msOrDate instanceof Date ? msOrDate : new Date(msOrDate);
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Taipei',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(d);
}

/**
 * Compute seat tile visual state and displayed time string.
 * @param {object|null} seat - { code, state, origin_at, mode, hours, paused_seconds, paused_at, has_board }
 * @param {{ nowMs: number, soonMinutes?: number, timeMode?: 'remain'|'used' }} opts
 */
export function computeSeatVisualState(seat, { nowMs, soonMinutes = 10, timeMode = 'remain' } = {}) {
  if (!seat) {
    return {
      cls: 'empty',
      timeText: '',
      colors: null,
      hasBoard: false,
      remainSeconds: null,
      usedSeconds: 0
    };
  }

  const hasBoard = Boolean(seat.has_board);
  const originMs = seat.origin_at ? new Date(seat.origin_at).getTime() : NaN;
  const currentMs = Number.isFinite(nowMs) ? nowMs : Date.now();

  if (seat.state === 'booked' || (Number.isFinite(originMs) && currentMs < originMs)) {
    return {
      cls: 'booked',
      timeText: Number.isFinite(originMs) ? formatTaipeiHHmm(originMs) : '--:--',
      colors: BEAD_COLORS.booked,
      hasBoard,
      remainSeconds: null,
      usedSeconds: 0
    };
  }

  const pausedSec = Math.max(0, Number(seat.paused_seconds) || 0);
  const pausedAtMs = seat.paused_at ? new Date(seat.paused_at).getTime() : NaN;
  const refMs = Number.isFinite(pausedAtMs) ? Math.min(currentMs, pausedAtMs) : currentMs;
  const rawElapsedSec = Number.isFinite(originMs) ? Math.max(0, Math.floor((refMs - originMs) / 1000)) : 0;
  const usedSeconds = Math.max(0, rawElapsedSec - pausedSec);

  if (seat.mode === 'unlimited' || seat.state === 'unlimited') {
    const cls = seat.state === 'paused' ? 'paused' : 'unl';
    return {
      cls,
      timeText: formatDurationHMM(usedSeconds),
      colors: BEAD_COLORS[cls],
      hasBoard,
      remainSeconds: null,
      usedSeconds
    };
  }

  const totalSeconds = Math.max(0, Number(seat.hours || 0) * 3600);
  const remainSeconds = totalSeconds - usedSeconds;

  if (remainSeconds <= 0) {
    return {
      cls: 'over',
      timeText: `+${formatDurationHMM(-remainSeconds)}`,
      colors: BEAD_COLORS.over,
      hasBoard,
      remainSeconds,
      usedSeconds
    };
  }

  const timeText = timeMode === 'used'
    ? formatDurationHMM(usedSeconds)
    : formatDurationHMM(remainSeconds);

  if (seat.state === 'paused' || pausedSec > 0) {
    return {
      cls: 'paused',
      timeText,
      colors: BEAD_COLORS.paused,
      hasBoard,
      remainSeconds,
      usedSeconds
    };
  }

  const soonLimitSec = Math.max(1, Number(soonMinutes) || 10) * 60;
  if (remainSeconds <= soonLimitSec) {
    return {
      cls: 'soon',
      timeText,
      colors: BEAD_COLORS.soon,
      hasBoard,
      remainSeconds,
      usedSeconds
    };
  }

  return {
    cls: 'run',
    timeText,
    colors: BEAD_COLORS.run,
    hasBoard,
    remainSeconds,
    usedSeconds
  };
}

function parseTimeToMinutes(hhmm) {
  if (!hhmm || typeof hhmm !== 'string') return null;
  const m = hhmm.trim().match(/^(\d{1,2}):(\d{2})/);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

/**
 * Compute closing warning text for the bottom ticker bar.
 * Returns empty string when not in the closing warning window.
 */
export function getClosingWarning({
  closingWarn = true,
  closingMinutes = 30,
  closeTime = null,
  openTime = null,
  nowMs,
  dateStr = null,
  closeAtMs = null
} = {}) {
  if (!closingWarn) return '';
  const currentMs = Number.isFinite(nowMs) ? nowMs : Date.now();
  const limitMin = Math.max(1, Number(closingMinutes) || 30);

  let targetCloseMs = closeAtMs;
  let closeHHmm = closeTime;

  if (!Number.isFinite(targetCloseMs)) {
    if (!closeTime) return '';
    const dStr = dateStr || getTaipeiDateStr(currentMs);
    if (!dStr) return '';
    const closeMinOfDay = parseTimeToMinutes(closeTime);
    const openMinOfDay = parseTimeToMinutes(openTime);
    if (closeMinOfDay === null) return '';

    const padClose = `${String(Math.floor(closeMinOfDay / 60) % 24).padStart(2, '0')}:${String(closeMinOfDay % 60).padStart(2, '0')}`;
    closeHHmm = padClose;
    const baseCloseMs = new Date(`${dStr}T${padClose}:00+08:00`).getTime();
    if (openMinOfDay !== null && closeMinOfDay <= openMinOfDay) {
      targetCloseMs = baseCloseMs + 86400000;
    } else {
      targetCloseMs = baseCloseMs;
    }
  } else if (!closeHHmm) {
    closeHHmm = formatTaipeiHHmm(targetCloseMs);
  }

  if (!Number.isFinite(targetCloseMs)) return '';
  const leftMinutes = Math.round((targetCloseMs - currentMs) / 60000);
  if (leftMinutes > limitMin || leftMinutes < -60) {
    return '';
  }
  if (leftMinutes > 0) {
    return `還有 ${leftMinutes} 分鐘打烊（${closeHHmm}），請開始收拾作品，豆子倒回原格`;
  }
  return `已經打烊（${closeHHmm}），請收拾作品並到櫃檯結帳`;
}

/**
 * Compute OLED burn-in protection shift in pixels (1..8 px total travel, 0 when off).
 */
export function computeBurnInShift(nowMs, shiftMinutes = 3, isOff = false) {
  if (isOff) return { dx: 0, dy: 0 };
  const intervalMs = Math.max(1, Number(shiftMinutes) || 3) * 60000;
  const block = Math.floor((Number.isFinite(nowMs) ? nowMs : Date.now()) / intervalMs);
  const offsets = [-4, -3, -2, -1, 1, 2, 3, 4];
  const dx = offsets[((block * 5) % offsets.length + offsets.length) % offsets.length];
  const dy = offsets[((block * 3 + 2) % offsets.length + offsets.length) % offsets.length];
  return { dx, dy };
}
