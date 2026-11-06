// shared/time.js
// 10/30 規則、分鐘與小時換算、台北時間工具（純函式，無任何第三方依賴）

export function floorMinutes(ms) {
  if (typeof ms !== 'number' || isNaN(ms)) return 0;
  return Math.floor(ms / 60000);
}

/**
 * 10/30 規則：每 30 分鐘算一格，最後不滿 30 分鐘的部分，超過 10 分鐘才多算一格
 * @param {number} minutes
 * @param {{ grace?: number, block?: number }} [options]
 * @returns {number} blocks
 */
export function blocksBy1030(minutes, { grace = 10, block = 30 } = {}) {
  const m = Math.floor(Number(minutes) || 0);
  if (!(m > 0)) return 0;
  const full = Math.floor(m / block);
  const rest = m - full * block;
  return rest > grace ? full + 1 : full;
}

/**
 * 換板時間選項與建議
 * @param {number} segStart - 毫秒時間戳
 * @param {number} at - 按下換板的毫秒時間戳
 * @param {{ grace?: number }} [options]
 * @returns {{ options: number[], suggested: number }}
 */
export function swapBoundaryOptions(segStart, at, { grace = 10 } = {}) {
  const sStart = Number(segStart);
  const sAt = Number(at);
  const used = Math.max(0, floorMinutes(sAt - sStart));
  const blocks = blocksBy1030(used, { grace, block: 30 });
  const down = sStart + Math.floor(used / 30) * 30 * 60000;
  const up = down + 30 * 60000;
  const suggested = sStart + blocks * 30 * 60000;
  const uniqueOptions = Array.from(new Set([down, up])).sort((a, b) => a - b);
  return { options: uniqueOptions, suggested };
}

/**
 * 格式化台北時間：YYYY-MM-DD
 * @param {Date|string|number} d
 * @returns {string}
 */
export function toTaipeiDateString(d) {
  const date = d instanceof Date ? d : new Date(d);
  if (isNaN(date.getTime())) return '';
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Taipei',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });
  return formatter.format(date);
}

/**
 * 產生 @db.Date 專用 UTC 零點 Date 物件（YYYY-MM-DDT00:00:00Z）
 * 解決 +08:00 比對 @db.Date 導致 Prisma UTC 截斷讀到前一天的問題
 * @param {Date|string|number} str
 * @returns {Date}
 */
export function dateOnly(str) {
  if (!str) return new Date();
  if (typeof str === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(str)) {
    return new Date(`${str}T00:00:00Z`);
  }
  const dateStr = toTaipeiDateString(str);
  return new Date(`${dateStr}T00:00:00Z`);
}

/**
 * 格式化台北時間：HH:mm
 * @param {Date|string|number} d
 * @returns {string}
 */
export function formatTimeHHmm(d) {
  const date = d instanceof Date ? d : new Date(d);
  if (isNaN(date.getTime())) return '';
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Taipei',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  });
  return formatter.format(date);
}

/**
 * 格式化台北時間：MM/DD 週X
 * @param {Date|string|number} d
 * @returns {string}
 */
export function formatDisplayDate(d) {
  const date = d instanceof Date ? d : new Date(d);
  if (isNaN(date.getTime())) return '';
  const days = ['週日', '週一', '週二', '週三', '週四', '週五', '週六'];
  const month = String(date.toLocaleString('en-US', { timeZone: 'Asia/Taipei', month: 'numeric' })).padStart(2, '0');
  const day = String(date.toLocaleString('en-US', { timeZone: 'Asia/Taipei', day: 'numeric' })).padStart(2, '0');
  // Day of week in Taipei
  const taipeiDate = new Date(date.toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
  const w = days[taipeiDate.getDay()];
  return `${month}/${day} ${w}`;
}

/**
 * 計時 h:mm 格式（不補零的小時）
 * @param {number} totalMinutes
 * @returns {string}
 */
export function formatTimerHMM(totalMinutes) {
  const m = Math.max(0, Math.floor(Number(totalMinutes) || 0));
  const hrs = Math.floor(m / 60);
  const mins = m % 60;
  return `${hrs}:${String(mins).padStart(2, '0')}`;
}

/**
 * 收費時數顯示：4 小時 或 4.5 小時
 * @param {number} hours
 * @returns {string}
 */
export function formatBillingHours(hours) {
  const h = Number(hours) || 0;
  const str = Number.isInteger(h) ? `${h}` : `${h.toFixed(1)}`;
  return `${str} 小時`;
}

/**
 * 剩餘、超時文案
 * 「還有 20 分」「超時 40 分」；超過 60 分鐘寫「超時 1 小時 5 分」
 * @param {number} diffMinutes - 負數為剩餘，正數為超時
 * @returns {string}
 */
export function formatDiffMinutesText(diffMinutes) {
  const m = Math.floor(Number(diffMinutes) || 0);
  if (m <= 0) {
    return `還有 ${Math.abs(m)} 分`;
  }
  if (m < 60) {
    return `超時 ${m} 分`;
  }
  const hrs = Math.floor(m / 60);
  const rest = m % 60;
  return rest === 0 ? `超時 ${hrs} 小時` : `超時 ${hrs} 小時 ${rest} 分`;
}
