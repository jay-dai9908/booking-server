// shared/accountingExport.js
// 帳務明細 CSV 產生與每日營收統計工具（前後端共用純函式）

import { formatBookingRef } from './receipts.js';
import { methodLabel } from './paymentMethods.js';
import { toTaipeiDateString } from './time.js';

function resolveMethodFormatter(getMethodLabelOrMethods) {
  if (typeof getMethodLabelOrMethods === 'function') {
    return getMethodLabelOrMethods;
  }
  const list = Array.isArray(getMethodLabelOrMethods) ? getMethodLabelOrMethods : [];
  return (m) => methodLabel(m, list);
}

function formatSourceLabel(source) {
  if (source === 'shop') return '商城';
  if (source === 'pass_sale') return '卡券販售';
  return '預約';
}

/**
 * Builds UTF-8 BOM CSV string for payments.
 * @param {Array} payments
 * @param {Function|Array} getMethodLabelOrMethods
 * @returns {string}
 */
export function buildPaymentsCsv(payments = [], getMethodLabelOrMethods = []) {
  const resolveLabel = resolveMethodFormatter(getMethodLabelOrMethods);
  const headers = ['付款編號', '預約單號', '顧客', '種類', '方式', '金額', '經手店員', '時間', '備註', '來源'];
  const rows = payments.map((p) => [
    p.payment_no || '',
    p.source && p.source !== 'booking' ? (p.source_ref || p.booking_ref || '') : (formatBookingRef(p.booking_ref) || ''),
    p.breakdown_json?.customer_name || p.target_label || '現場顧客',
    p.kind === 'refund' ? '退款' : p.kind === 'supplement' ? '補收' : p.kind === 'waive' ? '免收' : '收款',
    resolveLabel(p.method),
    p.amount ?? 0,
    p.created_by_name || p.staff_name || '',
    p.created_at ? new Date(p.created_at).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' }) : '',
    p.note || '',
    formatSourceLabel(p.source)
  ]);

  const csvRows = [headers, ...rows].map((row) =>
    row.map((cell) => `"${String(cell ?? '').replace(/"/g, '""')}"`).join(',')
  );

  return '\uFEFF' + csvRows.join('\r\n');
}

/**
 * Builds UTF-8 BOM CSV string for audit events.
 * @param {Array} events
 * @returns {string}
 */
export function buildEventsCsv(events = []) {
  const headers = ['時間', '經手人員', '裝置', '預約單號', '摘要', '類別', '原因'];
  const rows = events.map((e) => [
    e.created_at ? new Date(e.created_at).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' }) : '',
    e.staff_name || '門市人員',
    e.device_label || '',
    formatBookingRef(e.booking_ref) || '',
    e.summary || '',
    e.category || '',
    e.reason || ''
  ]);

  const csvRows = [headers, ...rows].map((row) =>
    row.map((cell) => `"${String(cell ?? '').replace(/"/g, '""')}"`).join(',')
  );

  return '\uFEFF' + csvRows.join('\r\n');
}

/**
 * Groups payments by YYYY-MM-DD Taipei date and computes daily net revenue.
 * @param {Array} payments
 * @param {string} startDateStr
 * @param {string} endDateStr
 * @returns {Array}
 */
export function computeDailyRevenue(payments = [], startDateStr, endDateStr) {
  const dailyMap = {};

  if (startDateStr && endDateStr) {
    let cur = new Date(`${startDateStr}T00:00:00.000Z`);
    const end = new Date(`${endDateStr}T00:00:00.000Z`);
    while (cur <= end) {
      const dStr = cur.toISOString().slice(0, 10);
      dailyMap[dStr] = { date: dStr, revenue: 0, count: 0 };
      cur.setUTCDate(cur.getUTCDate() + 1);
    }
  }

  for (const p of payments) {
    if (p.status === 'voided' || p.source === 'shop') continue;
    const dateStr = p.created_at ? toTaipeiDateString(p.created_at) : '';
    if (!dateStr) continue;

    if (!dailyMap[dateStr]) {
      dailyMap[dateStr] = { date: dateStr, revenue: 0, count: 0 };
    }

    if (p.kind === 'refund') {
      if (p.method !== 'pass') {
        dailyMap[dateStr].revenue -= (p.amount || 0);
      }
    } else if (p.kind === 'charge' || p.kind === 'supplement') {
      if (p.method !== 'pass') {
        dailyMap[dateStr].revenue += (p.amount || 0);
        dailyMap[dateStr].count += 1;
      }
    }
  }

  return Object.values(dailyMap).sort((a, b) => a.date.localeCompare(b.date));
}
