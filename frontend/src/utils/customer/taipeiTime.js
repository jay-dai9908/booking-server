import { toTaipeiDateString } from '../../../../shared/time.js';

export function taipeiToday(now = new Date()) {
  return toTaipeiDateString(now);
}

export function taipeiAddDays(ymd, n) {
  const [y, m, d] = String(ymd).split('-').map(Number);
  const dt = new Date(Date.UTC(y, (m || 1) - 1, (d || 1) + (n || 0)));
  return dt.toISOString().slice(0, 10);
}

export function sessionStartAt(dateStr, hhmm) {
  const cleanTime = /^\d{2}:\d{2}$/.test(String(hhmm || '').trim()) ? String(hhmm).trim() : '00:00';
  return new Date(`${dateStr}T${cleanTime}:00+08:00`);
}
