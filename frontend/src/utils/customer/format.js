// 拾光製所 格式化工具

const WEEKDAY_CHARS = ['日', '一', '二', '三', '四', '五', '六'];
const CN_NUMS = ['', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];

export function toDateObj(date) {
  if (date instanceof Date) return date;
  if (typeof date === 'string') {
    if (date.includes('-')) {
      const parts = date.split('T')[0].split('-').map(Number);
      return new Date(parts[0], parts[1] - 1, parts[2]);
    }
  }
  return new Date(date);
}

export function formatMoney(n) {
  return `NT$${Math.round(Number(n) || 0).toLocaleString('en-US')}`;
}

export function formatMoneyBig(n) {
  return `NT$ ${Math.round(Number(n) || 0).toLocaleString('en-US')}`;
}

export function formatMinus(n) {
  return `−NT$${Math.abs(Math.round(Number(n) || 0)).toLocaleString('en-US')}`;
}

export function formatPlus(n) {
  return `+NT$${Math.abs(Math.round(Number(n) || 0)).toLocaleString('en-US')}`;
}

export function weekdayChar(date) {
  const d = toDateObj(date);
  return WEEKDAY_CHARS[d.getDay()];
}

export function formatDateShort(date) {
  const d = toDateObj(date);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${mm}/${dd} 週${WEEKDAY_CHARS[d.getDay()]}`;
}

export function formatDateFull(date) {
  const d = toDateObj(date);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}/${mm}/${dd}`;
}

export function formatMonthTitle(date) {
  const d = toDateObj(date);
  return `${d.getFullYear()} 年 ${d.getMonth() + 1} 月`;
}

export function formatTimeRange(start, end) {
  return `${start} 到 ${end}`;
}

export function formatPhone(phone) {
  if (!phone) return '';
  const clean = String(phone).replace(/\D/g, '');
  if (clean.length === 10 && clean.startsWith('09')) {
    return `${clean.slice(0, 4)}-${clean.slice(4, 7)}-${clean.slice(7)}`;
  }
  return String(phone);
}

export function cnNum(n) {
  const num = parseInt(n, 10);
  if (num >= 1 && num <= 10) return CN_NUMS[num];
  return String(n);
}

export const formatBookingRef = (ref) => {
  if (!ref) return '';
  if (typeof ref !== 'string') ref = String(ref);
  if (ref.startsWith('BK-') && ref.length === 12) return ref;
  const clean = ref.replace(/[^a-zA-Z0-9]/g, '');
  if (clean.length >= 8) {
    return `BK-${clean.slice(0, 4).toUpperCase()}-${clean.slice(-4).toUpperCase()}`;
  }
  return ref;
};

export const formatShortRef = (ref) => {
  const full = formatBookingRef(ref);
  const parts = full.split('-');
  if (parts.length >= 2) return `${parts[0]}-${parts[1]}`;
  return full;
};
