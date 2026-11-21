// frontend/src/utils/display/taipeiReload.js
import { getTaipeiDateStr } from './seatStatus.js';

/**
 * Compute milliseconds until next 04:00:00 Asia/Taipei (at least 1000ms in the future).
 * @param {number} nowMs
 * @returns {number}
 */
export function msUntilNextTaipei0400(nowMs = Date.now()) {
  const current = Number.isFinite(nowMs) ? nowMs : Date.now();
  const todayStr = getTaipeiDateStr(current);
  const today0400 = new Date(`${todayStr}T04:00:00+08:00`).getTime();
  if (current < today0400 - 1000) {
    return today0400 - current;
  }
  const tomorrowMs = current + 86400000;
  const tomorrowStr = getTaipeiDateStr(tomorrowMs);
  const tomorrow0400 = new Date(`${tomorrowStr}T04:00:00+08:00`).getTime();
  if (tomorrow0400 > current) {
    return tomorrow0400 - current;
  }
  return today0400 + 86400000 - current;
}
