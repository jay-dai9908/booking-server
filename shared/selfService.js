// shared/selfService.js
// 半自助日共用純函式（前後端皆可直接引用）

import { toTaipeiDateString } from './time.js';

const WEEKDAY_ZH = ['日', '一', '二', '三', '四', '五', '六'];

function normalizeYmd(input) {
  if (!input) return '';
  if (typeof input === 'string') {
    const trimmed = input.trim();
    if (/^\d{4}-\d{2}-\d{2}/.test(trimmed)) {
      return trimmed.slice(0, 10);
    }
  }
  return toTaipeiDateString(input);
}

/**
 * 計算半自助日付款期限（使用日前一日的 hour:00 台北時間）
 * @param {string|Date} dateStr
 * @param {number} [hour=12]
 * @returns {Date}
 */
export function prepayDeadline(dateStr, hour = 12) {
  const ymd = normalizeYmd(dateStr);
  if (!ymd) return new Date(NaN);
  const [y, m, d] = ymd.split('-').map(Number);
  const prevUtc = new Date(Date.UTC(y, m - 1, d - 1));
  const py = prevUtc.getUTCFullYear();
  const pm = String(prevUtc.getUTCMonth() + 1).padStart(2, '0');
  const pd = String(prevUtc.getUTCDate()).padStart(2, '0');
  const hRaw = hour === undefined || hour === null ? 12 : Number(hour);
  const hSafe = Math.max(0, Math.min(23, Number.isFinite(hRaw) ? Math.floor(hRaw) : 12));
  const hh = String(hSafe).padStart(2, '0');
  return new Date(`${py}-${pm}-${pd}T${hh}:00:00+08:00`);
}

/**
 * 計算最早可進場時間（HH:MM），不跨到前一天（最小 00:00）
 * @param {string} startTime
 * @param {number} [earlyMinutes=30]
 * @returns {string}
 */
export function earliestEntry(startTime, earlyMinutes = 30) {
  if (!startTime || typeof startTime !== 'string') return '';
  const [h, m] = startTime.split(':').map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return startTime;
  const early = Math.max(0, Number(earlyMinutes) || 0);
  const totalMins = Math.max(0, h * 60 + m - early);
  const resH = Math.floor(totalMins / 60);
  const resM = totalMins % 60;
  return `${String(resH).padStart(2, '0')}:${String(resM).padStart(2, '0')}`;
}

/**
 * 產生半自助日熨燙時間說明文字
 * @param {{ iron_mode?: string, iron_date?: string|Date|null, date?: string|Date|null, today?: string|Date|null }} [options]
 * @returns {string}
 */
export function ironText({ iron_mode = 'today', iron_date = null, date = null, today = null } = {}) {
  const mode = iron_mode || 'today';
  if (mode === 'next') {
    return '店員會在隔天協助熨燙';
  }
  if (mode === 'date') {
    const dStr = normalizeYmd(iron_date);
    if (!dStr) return '店員會在指定日期協助熨燙';
    const [y, m, d] = dStr.split('-').map(Number);
    const utcDt = new Date(Date.UTC(y, m - 1, d));
    const wk = WEEKDAY_ZH[utcDt.getUTCDay()];
    return `店員會在 ${m}/${d}（${wk}）協助熨燙`;
  }
  const targetStr = normalizeYmd(date);
  const todayStr = today ? normalizeYmd(today) : toTaipeiDateString(new Date());
  if (targetStr && todayStr && targetStr === todayStr) {
    return '店員會在今天下午到店協助熨燙';
  }
  return '店員會在當天下午到店協助熨燙';
}

/**
 * 取得智能板在半自助日的適用條件（空值退回平常設定，可租數量取較小值）
 * @param {object} config
 * @returns {{ hourly_rate: number, daily_cap: number|null, stock: number|null }}
 */
export function selfEquipmentTerms(config = {}) {
  const hourly_rate = config.self_hourly_rate != null
    ? Number(config.self_hourly_rate)
    : Number(config.hourly_rate || 0);

  const daily_cap = config.self_daily_cap != null
    ? Number(config.self_daily_cap)
    : (config.daily_cap != null ? Number(config.daily_cap) : null);

  let stock = null;
  if (config.id === 'bring_own') {
    stock = null;
  } else {
    const baseStock = config.total_stock != null ? Number(config.total_stock) : null;
    const selfStock = config.self_stock != null ? Number(config.self_stock) : null;
    if (baseStock != null && selfStock != null) {
      stock = Math.min(baseStock, selfStock);
    } else if (selfStock != null) {
      stock = selfStock;
    } else {
      stock = baseStock;
    }
  }

  return { hourly_rate, daily_cap, stock };
}
