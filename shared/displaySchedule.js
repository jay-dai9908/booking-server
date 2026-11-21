// shared/displaySchedule.js
// 店內顯示屏開關與內容排程純函式（前後端共用，無任何第三方依賴）

import { toTaipeiDateString, formatTimeHHmm } from './time.js';

export const VALID_DISPLAY_MODES = ['biz', 'fixed', 'always', 'never'];
export const VALID_DISPLAY_CONTENTS = ['timers', 'timers_self', 'slides_self', 'slides_gen', 'off'];
export const VALID_DAY_TYPES = ['self', 'weekday', 'holiday', 'closed'];

export const DEFAULT_DISPLAY_SCHEDULE = {
  self:    { mode: 'biz',   before: 30, after: 30, on: '09:30', off: '21:30', content: 'slides_self' },
  weekday: { mode: 'biz',   before: 15, after: 15, on: '09:45', off: '21:15', content: 'timers' },
  holiday: { mode: 'biz',   before: 15, after: 30, on: '09:45', off: '21:30', content: 'timers' },
  closed:  { mode: 'never', before: 0,  after: 0,  on: '',      off: '',      content: 'off' }
};

/**
 * 將 'HH:mm' 轉成自 00:00 起的分鐘數；格式無效回傳 null
 * @param {string} hhmm
 * @returns {number|null}
 */
export function parseHHmmToMinutes(hhmm) {
  if (typeof hhmm !== 'string') return null;
  const m = hhmm.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (!Number.isInteger(h) || !Number.isInteger(min) || h < 0 || h > 24 || min < 0 || min > 59) {
    return null;
  }
  if (h === 24 && min !== 0) return null;
  return h * 60 + min;
}

/**
 * 計算單一營業日的顯示窗格毫秒區間（台北時間 +08:00）
 */
export function computeScheduleWindow({
  dayType = 'weekday',
  schedule = DEFAULT_DISPLAY_SCHEDULE,
  specialDates = [],
  date,
  openTime,
  closeTime
} = {}) {
  const dateStr = typeof date === 'string' && /^\d{4}-\d{2}-\d{2}/.test(date.trim())
    ? date.trim().slice(0, 10)
    : toTaipeiDateString(date || new Date());

  const mergedSched = {
    ...DEFAULT_DISPLAY_SCHEDULE,
    ...(schedule && typeof schedule === 'object' ? schedule : {})
  };
  const rule = mergedSched[dayType] || DEFAULT_DISPLAY_SCHEDULE[dayType] || DEFAULT_DISPLAY_SCHEDULE.weekday;
  const mode = rule.mode || 'never';
  const targetContent = rule.content || 'off';

  if (mode === 'never') {
    return { dateStr, rule, startMs: null, endMs: null, window: null, targetContent: 'off' };
  }

  const midnightMs = new Date(`${dateStr}T00:00:00+08:00`).getTime();
  const special = Array.isArray(specialDates)
    ? specialDates.find(s => s && String(s.date).slice(0, 10) === dateStr && s.off)
    : null;

  if (mode === 'always') {
    let endMin = 1440;
    let endLabel = '24:00';
    if (special) {
      const spOff = parseHHmmToMinutes(special.off);
      if (spOff !== null) {
        endMin = spOff <= 0 ? spOff + 1440 : spOff;
        endLabel = formatTimeHHmm(new Date(midnightMs + endMin * 60000));
      }
    }
    const startMs = midnightMs;
    const endMs = midnightMs + endMin * 60000;
    return {
      dateStr,
      rule,
      startMs,
      endMs,
      window: ['00:00', endLabel],
      targetContent
    };
  }

  let startMin = null;
  let endMin = null;

  if (mode === 'biz') {
    const openMin = parseHHmmToMinutes(openTime);
    const closeMinRaw = parseHHmmToMinutes(closeTime);
    if (openMin === null || closeMinRaw === null) {
      return { dateStr, rule, startMs: null, endMs: null, window: null, targetContent: 'off' };
    }
    const closeMin = closeMinRaw <= openMin ? closeMinRaw + 1440 : closeMinRaw;
    const before = Math.max(0, Number(rule.before) || 0);
    const after = Math.max(0, Number(rule.after) || 0);
    startMin = openMin - before;
    endMin = closeMin + after;
  } else if (mode === 'fixed') {
    const onMin = parseHHmmToMinutes(rule.on || '10:00');
    const offMinRaw = parseHHmmToMinutes(rule.off || '21:00');
    if (onMin === null || offMinRaw === null) {
      return { dateStr, rule, startMs: null, endMs: null, window: null, targetContent: 'off' };
    }
    startMin = onMin;
    endMin = offMinRaw <= onMin ? offMinRaw + 1440 : offMinRaw;
  } else {
    return { dateStr, rule, startMs: null, endMs: null, window: null, targetContent: 'off' };
  }

  // 特殊日期覆蓋關閉時間（若 off <= startMin 代表跨過午夜）
  if (special) {
    const spOff = parseHHmmToMinutes(special.off);
    if (spOff !== null) {
      endMin = spOff <= startMin ? spOff + 1440 : spOff;
    }
  }

  const startMs = midnightMs + startMin * 60000;
  const endMs = midnightMs + endMin * 60000;
  return {
    dateStr,
    rule,
    startMs,
    endMs,
    window: [formatTimeHHmm(new Date(startMs)), formatTimeHHmm(new Date(endMs))],
    targetContent
  };
}

/**
 * 判斷目前是否應亮屏以及顯示內容
 * @param {{
 *   dayType: 'self'|'weekday'|'holiday'|'closed',
 *   schedule?: object,
 *   specialDates?: Array<{ date: string, off: string, note?: string }>,
 *   date?: string|Date,
 *   now?: Date|string|number,
 *   openTime?: string|null,
 *   closeTime?: string|null
 * }} params
 * @returns {{ on: boolean, content: string, window: [string, string]|null }}
 */
export function decide({
  dayType = 'weekday',
  schedule = DEFAULT_DISPLAY_SCHEDULE,
  specialDates = [],
  date,
  now = new Date(),
  openTime = null,
  closeTime = null
} = {}) {
  let nowMs;
  if (typeof now === 'string' && /^\d{1,2}:\d{2}$/.test(now.trim())) {
    const dateStr = typeof date === 'string' && /^\d{4}-\d{2}-\d{2}/.test(date.trim())
      ? date.trim().slice(0, 10)
      : toTaipeiDateString(new Date());
    const mins = parseHHmmToMinutes(now.trim());
    nowMs = new Date(`${dateStr}T00:00:00+08:00`).getTime() + mins * 60000;
  } else {
    nowMs = now instanceof Date ? now.getTime() : new Date(now).getTime();
  }

  const resolvedDate = date || toTaipeiDateString(new Date(nowMs));
  const win = computeScheduleWindow({
    dayType,
    schedule,
    specialDates,
    date: resolvedDate,
    openTime,
    closeTime
  });

  if (win.startMs === null || win.endMs === null || win.targetContent === 'off') {
    return { on: false, content: 'off', window: win.window };
  }

  const on = nowMs >= win.startMs && nowMs < win.endMs;
  return {
    on,
    content: on ? win.targetContent : 'off',
    window: win.window
  };
}
