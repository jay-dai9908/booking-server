import { format } from 'date-fns';

// 拾光製所 格式化工具

const WEEKDAY_CHARS = ['日', '一', '二', '三', '四', '五', '六'];
const CN_NUMS = ['', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];

export function toDateObj(date) {
  if (!date) return new Date(NaN);
  if (date instanceof Date) return date;
  if (typeof date === 'string') {
    if (date.includes('-')) {
      const parts = date.split('T')[0].split('-').map(Number);
      return new Date(parts[0], parts[1] - 1, parts[2] || 1);
    }
  }
  return new Date(date);
}

export function safeFormatDate(date, fmt = 'yyyy/MM/dd', fallback = '—') {
  if (!date) return fallback;
  try {
    const d = toDateObj(date);
    if (!d || isNaN(d.getTime())) return fallback;
    return format(d, fmt);
  } catch (e) {
    return fallback;
  }
}

const TAIPEI_DT_FORMATTER = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Asia/Taipei',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23'
});

export function formatDateTime(ts, fmt = 'MM/dd HH:mm', fallback = '—') {
  if (!ts) return fallback;
  try {
    const d = ts instanceof Date ? ts : new Date(ts);
    if (!d || isNaN(d.getTime())) return fallback;
    const parts = {};
    for (const p of TAIPEI_DT_FORMATTER.formatToParts(d)) {
      if (p.type !== 'literal') parts[p.type] = p.value;
    }
    const hour = parts.hour === '24' ? '00' : parts.hour;
    return fmt
      .replace('yyyy', parts.year)
      .replace('MM', parts.month)
      .replace('dd', parts.day)
      .replace('HH', hour)
      .replace('mm', parts.minute)
      .replace('ss', parts.second);
  } catch (e) {
    return fallback;
  }
}

export function formatMoney(n) {
  return `NT$${Math.round(Number(n) || 0).toLocaleString('en-US')}`;
}

export function formatMoneyBig(n) {
  return `NT$ ${Math.round(Number(n) || 0).toLocaleString('en-US')}`;
}

export function formatMinus(n) {
  const rounded = Math.round(Number(n) || 0);
  if (rounded === 0) return 'NT$0';
  return `-NT$${Math.abs(rounded).toLocaleString('en-US')}`;
}

export function formatPlus(n) {
  return `+NT$${Math.abs(Math.round(Number(n) || 0)).toLocaleString('en-US')}`;
}

export function weekdayChar(date) {
  if (!date) return '';
  const d = toDateObj(date);
  if (!d || isNaN(d.getTime())) return '';
  return WEEKDAY_CHARS[d.getDay()] || '';
}

export function formatDateShort(date, fallback = '—') {
  if (!date) return fallback;
  const d = toDateObj(date);
  if (!d || isNaN(d.getTime())) return fallback;
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${mm}/${dd} 週${WEEKDAY_CHARS[d.getDay()]}`;
}

export function formatDateFull(date, fallback = '—') {
  if (!date) return fallback;
  const d = toDateObj(date);
  if (!d || isNaN(d.getTime())) return fallback;
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

export function formatYMD(date) {
  if (!date) return '';
  if (typeof date === 'string' && /^\d{4}-\d{2}-\d{2}/.test(date)) {
    return date.slice(0, 10);
  }
  const d = toDateObj(date);
  if (isNaN(d.getTime())) return '';
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

