import { parseYMD } from './pricing.js';

export function isSessionPast(dateStr, session, now = new Date()) {
  const [h, m] = session.start_time.split(':').map(Number);
  const start = parseYMD(dateStr);
  start.setHours(h, m, 0, 0);
  return now >= start;
}

export function slotState(dateStr, s, now = new Date()) {
  if (isSessionPast(dateStr, s, now)) return 'past';
  if (s.remaining_capacity <= 0) return 'full';
  return s.remaining_capacity / s.max_capacity >= 0.5 ? 'ok' : 'low';
}

export const meterBeads = (remaining, max) =>
  remaining <= 0 || max <= 0 ? 0 : Math.min(5, Math.ceil((remaining / max) * 5));

export function dayState(dateStr, sessionsOfDay, now = new Date()) {
  if (!sessionsOfDay || !sessionsOfDay.length) return 'closed';
  const open = sessionsOfDay.filter((s) => !isSessionPast(dateStr, s, now));
  if (!open.length) return 'full';
  const rem = open.reduce((a, s) => a + Math.max(0, s.remaining_capacity), 0);
  const cap = open.reduce((a, s) => a + s.max_capacity, 0);
  if (rem <= 0) return 'full';
  return rem / cap >= 0.5 ? 'ok' : 'low';
}

export function canPlace(units, candidate, avail, hourStartTimes) {
  for (let k = candidate.from; k < candidate.to; k++) {
    const t = hourStartTimes[k];
    const usedByOthers = units.filter(
      (u) => u.uid !== candidate.uid && u.equipment_id === candidate.equipment_id && u.from <= k && k < u.to
    ).length;
    if (usedByOthers + 1 > (avail[candidate.equipment_id]?.[t] ?? 0)) {
      return { ok: false, hour: t };
    }
  }
  return { ok: true };
}
