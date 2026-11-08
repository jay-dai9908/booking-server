import { formatBookingRef } from './floorSelectors.js';

/**
 * Builds UTF-8 BOM CSV string for payments.
 */
export function buildPaymentsCsv(payments = [], getMethodLabel = (m) => m) {
  const headers = ['付款編號', '預約單號', '顧客', '種類', '方式', '金額', '經手店員', '時間', '備註'];
  const rows = payments.map(p => [
    p.payment_no || '',
    formatBookingRef(p.booking_ref) || '',
    p.breakdown_json?.customer_name || '現場顧客',
    p.kind === 'refund' ? '退款' : p.kind === 'supplement' ? '補收' : p.kind === 'waive' ? '免收' : '收款',
    getMethodLabel(p.method),
    p.amount ?? 0,
    p.created_by_name || p.staff_name || '',
    p.created_at ? new Date(p.created_at).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' }) : '',
    (p.note || '').replace(/"/g, '""')
  ]);

  const csvRows = [headers, ...rows].map(row =>
    row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(',')
  );

  return '\uFEFF' + csvRows.join('\r\n');
}

/**
 * Builds UTF-8 BOM CSV string for audit events.
 */
export function buildEventsCsv(events = []) {
  const headers = ['時間', '經手人員', '裝置', '預約單號', '摘要', '類別', '原因'];
  const rows = events.map(e => [
    e.created_at ? new Date(e.created_at).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' }) : '',
    e.staff_name || '門市人員',
    e.device_label || '',
    formatBookingRef(e.booking_ref) || '',
    (e.summary || '').replace(/"/g, '""'),
    e.category || '',
    (e.reason || '').replace(/"/g, '""')
  ]);

  const csvRows = [headers, ...rows].map(row =>
    row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(',')
  );

  return '\uFEFF' + csvRows.join('\r\n');
}

/**
 * Groups payments by YYYY-MM-DD date and computes daily net revenue.
 */
export function computeDailyRevenue(payments = [], startDateStr, endDateStr) {
  const dailyMap = {};

  // Initialize all dates in range if provided
  if (startDateStr && endDateStr) {
    let cur = new Date(startDateStr);
    const end = new Date(endDateStr);
    while (cur <= end) {
      const dStr = cur.toISOString().slice(0, 10);
      dailyMap[dStr] = { date: dStr, revenue: 0, count: 0 };
      cur.setDate(cur.getDate() + 1);
    }
  }

  for (const p of payments) {
    if (p.status === 'voided') continue;
    const dateStr = p.created_at ? p.created_at.slice(0, 10) : '';
    if (!dateStr) continue;

    if (!dailyMap[dateStr]) {
      dailyMap[dateStr] = { date: dateStr, revenue: 0, count: 0 };
    }

    if (p.kind === 'refund') {
      dailyMap[dateStr].revenue -= (p.amount || 0);
    } else if (p.kind === 'charge' || p.kind === 'supplement') {
      if (p.method !== 'pass') {
        dailyMap[dateStr].revenue += (p.amount || 0);
        dailyMap[dateStr].count += 1;
      }
    }
  }

  return Object.values(dailyMap).sort((a, b) => a.date.localeCompare(b.date));
}
