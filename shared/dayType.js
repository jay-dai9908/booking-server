import { toTaipeiDateString } from './time.js';

export const VALID_MANUAL_DAY_TYPES = ['weekday', 'holiday', 'self', 'closed'];
export const VALID_PRICE_TYPES = ['weekday', 'holiday'];

export function normalizeDateStr(dateInput) {
  if (typeof dateInput === 'string') {
    const trimmed = dateInput.trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
  }
  return toTaipeiDateString(dateInput || new Date());
}

/**
 * 依台北日期字串推算系統預設平假日（週六日為 holiday，其餘為 weekday）。
 */
export function autoDayTypeByWeekday(dateInput) {
  const dateStr = normalizeDateStr(dateInput);
  const [y, m, d] = dateStr.split('-').map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d, 12, 0, 0)).getUTCDay();
  return dow === 0 || dow === 6 ? 'holiday' : 'weekday';
}

/**
 * 單一日期類型與計價基準推算函式（前後端與遷移腳本共用）
 * 判斷順序：
 * 1. day_type = 'closed' -> closed
 * 2. bookableSessionCount <= 0（無可預約時段或全被關閉）-> closed
 * 3. is_self_service = true 或 day_type = 'self' -> self
 * 4. day_type = 'weekday' | 'holiday' -> 依指定
 * 5. 自動依星期六日判斷 holiday / weekday
 *
 * price_type：weekday/holiday 固定等於 type；self/closed 依 dailySetting.price_type 或星期幾。
 *
 * @param {object} params
 * @param {string|Date} params.date
 * @param {object|null} [params.dailySetting]
 * @param {number|null} [params.bookableSessionCount]
 * @param {boolean} [params.ignoreManual]
 * @returns {{ date: string, type: 'weekday'|'holiday'|'self'|'closed', price_type: 'weekday'|'holiday', source: 'manual'|'migrated'|'auto', closed_note: string|null }}
 */
export function computeDayInfo({
  date,
  dailySetting = null,
  bookableSessionCount = undefined,
  ignoreManual = false
} = {}) {
  const dateStr = normalizeDateStr(date);
  const autoPriceType = autoDayTypeByWeekday(dateStr);

  const rawDayType = ignoreManual ? null : (dailySetting?.day_type || null);
  const rawPriceType = ignoreManual ? null : (dailySetting?.price_type || null);
  const rawSource = ignoreManual ? null : (dailySetting?.day_type_source || null);
  const hasZeroBookableSessions =
    bookableSessionCount !== undefined &&
    bookableSessionCount !== null &&
    Number(bookableSessionCount) <= 0;
  const isSelf = Boolean(dailySetting?.is_self_service) || rawDayType === 'self';

  let type;
  let source = 'auto';

  if (rawDayType === 'closed') {
    type = 'closed';
    source = rawSource === 'migrated' ? 'migrated' : 'manual';
  } else if (hasZeroBookableSessions) {
    type = 'closed';
    source = 'auto';
  } else if (isSelf) {
    type = 'self';
    if (!ignoreManual) {
      source = rawSource === 'migrated' ? 'migrated' : 'manual';
    }
  } else if (rawDayType === 'weekday' || rawDayType === 'holiday') {
    type = rawDayType;
    source = rawSource === 'migrated' ? 'migrated' : 'manual';
  } else {
    type = autoPriceType;
    source = 'auto';
  }

  let price_type;
  if (type === 'weekday' || type === 'holiday') {
    price_type = type;
  } else {
    price_type =
      rawPriceType === 'weekday' || rawPriceType === 'holiday'
        ? rawPriceType
        : autoPriceType;
  }

  const trimmedNote = dailySetting?.closed_note ? String(dailySetting.closed_note).trim() : '';
  const closed_note = type === 'closed' && trimmedNote ? trimmedNote : null;

  return {
    date: dateStr,
    type,
    price_type,
    source,
    closed_note
  };
}

export function enumerateDateStrs(startStr, endStr) {
  const s = normalizeDateStr(startStr);
  const e = normalizeDateStr(endStr);
  if (!s || !e || e < s) return [];
  const [sy, sm, sd] = s.split('-').map(Number);
  const [ey, em, ed] = e.split('-').map(Number);
  const cur = new Date(Date.UTC(sy, sm - 1, sd, 12, 0, 0));
  const end = new Date(Date.UTC(ey, em - 1, ed, 12, 0, 0));
  const list = [];
  while (cur <= end) {
    list.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return list;
}

export default {
  VALID_MANUAL_DAY_TYPES,
  VALID_PRICE_TYPES,
  normalizeDateStr,
  autoDayTypeByWeekday,
  computeDayInfo,
  enumerateDateStrs
};
