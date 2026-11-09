// shared/receipts.js
// 收據排版，產生商米 JSON 指令與 HTML 預覽（純函式，58mm / 31 半形字元安全預算）

import { PAYMENT_METHOD_LABELS, displayBoardName } from './billing.js';

export const RECEIPT_WIDTH = 31;
export const DIVIDER = '-------------------------------';

/**
 * 格式化預約代碼為 BK-XXXX-XXXX
 * @param {string} ref
 * @returns {string}
 */
export function formatBookingRef(ref) {
  if (!ref) return '';
  if (typeof ref !== 'string') ref = String(ref);
  if (/^BK-[A-Z0-9]{4}-[A-Z0-9]{4}$/i.test(ref)) return ref.toUpperCase();
  const clean = ref.replace(/[^a-zA-Z0-9]/g, '');
  if (clean.length >= 8) {
    return `BK-${clean.slice(0, 4).toUpperCase()}-${clean.slice(-4).toUpperCase()}`;
  }
  return ref;
}

/**
 * 計算字元顯示寬度（全形/中文算 2 格，半形算 1 格）
 * @param {string} char
 * @returns {number}
 */
export function charWidth(char) {
  const code = char.charCodeAt(0);
  // Full-width ranges: CJK, Full-width ASCII, CJK symbols & punctuation
  if (
    code >= 0x2e80 ||
    code === 0x3000 ||
    (code >= 0xff01 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6)
  ) {
    return 2;
  }
  return 1;
}

/**
 * 計算字串總顯示寬度
 * @param {string} str
 * @returns {number}
 */
export function strWidth(str) {
  if (typeof str !== 'string') return 0;
  let w = 0;
  for (let i = 0; i < str.length; i++) {
    w += charWidth(str[i]);
  }
  return w;
}

/**
 * 左右對齊一列（左邊太長截斷加 …，右邊金額完整保留；不附帶尾端換行）
 * @param {string} left
 * @param {string} right
 * @param {number} [width=31]
 * @returns {string}
 */
export function fitLine(left = '', right = '', width = RECEIPT_WIDTH) {
  const cleanLeft = String(left).trimEnd();
  const cleanRight = String(right).trim();
  const rightW = strWidth(cleanRight);

  const availLeft = width - rightW - 1; // 至少留 1 空格
  let finalLeft = cleanLeft;

  if (strWidth(cleanLeft) > availLeft) {
    let truncated = '';
    for (const ch of cleanLeft) {
      if (strWidth(truncated + ch + '…') > availLeft) {
        break;
      }
      truncated += ch;
    }
    finalLeft = truncated + '…';
  }

  const leftW = strWidth(finalLeft);
  const spacesNeeded = Math.max(1, width - leftW - rightW);
  return finalLeft + ' '.repeat(spacesNeeded) + cleanRight;
}

/**
 * 格式化收據上的金額：NT$1,650 或 -NT$30 (收據上用半形 -)
 * @param {number} amt
 * @returns {string}
 */
export function formatReceiptMoney(amt) {
  const n = Math.round(Number(amt) || 0);
  if (n < 0) {
    return `-NT$${Math.abs(n).toLocaleString('en-US')}`;
  }
  return `NT$${n.toLocaleString('en-US')}`;
}

/**
 * 格式化收據日期：11/04(三)
 * @param {Date|string|number} d
 * @returns {string}
 */
export function formatReceiptDate(d) {
  const date = d instanceof Date ? d : new Date(d);
  if (isNaN(date.getTime())) return '';
  const days = ['日', '一', '二', '三', '四', '五', '六'];
  const month = String(date.toLocaleString('en-US', { timeZone: 'Asia/Taipei', month: 'numeric' })).padStart(2, '0');
  const day = String(date.toLocaleString('en-US', { timeZone: 'Asia/Taipei', day: 'numeric' })).padStart(2, '0');
  const taipeiDate = new Date(date.toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
  const w = days[taipeiDate.getDay()];
  return `${month}/${day}(${w})`;
}

/**
 * 格式化收據時間：14:00-18:00
 * @param {string|Date} start
 * @param {string|Date} end
 * @returns {string}
 */
export function formatReceiptTimeRange(start, end) {
  if (typeof start === 'string' && start.length === 5 && typeof end === 'string' && end.length === 5) {
    return `${start}-${end}`;
  }
  const s = new Date(start);
  const e = new Date(end);
  const sStr = s.toLocaleTimeString('en-GB', { timeZone: 'Asia/Taipei', hour: '2-digit', minute: '2-digit', hour12: false });
  const eStr = e.toLocaleTimeString('en-GB', { timeZone: 'Asia/Taipei', hour: '2-digit', minute: '2-digit', hour12: false });
  return `${sStr}-${eStr}`;
}

/**
 * 從預約與付款物件中擷取日期、時段與桌名
 * 優先使用預約時段（start_time-end_time）而非付款時間（Section 4.5）
 */
export function extractReceiptSessionInfo(booking = {}, payment = {}) {
  const dateVal = booking.session_date || booking.session?.session_date || booking.start_at || payment.created_at || Date.now();
  const dateStr = formatReceiptDate(dateVal);

  let timeRange = '';
  const startTime = booking.start_time || booking.session?.start_time;
  const endTime = booking.end_time || booking.session?.end_time;
  if (startTime && endTime) {
    timeRange = `${startTime}-${endTime}`;
  } else if (booking.start_at && booking.end_at) {
    timeRange = formatReceiptTimeRange(booking.start_at, booking.end_at);
  } else {
    timeRange = formatReceiptTimeRange(payment.created_at || Date.now(), payment.created_at || Date.now());
  }

  let tableLabel = booking.table_label || '';
  if (!tableLabel && Array.isArray(booking.assigned_seats) && booking.assigned_seats.length > 0) {
    const s0 = String(booking.assigned_seats[0]);
    const m = s0.match(/^([A-Za-z0-9]+)-/);
    if (m) tableLabel = `桌 ${m[1]}`;
  }

  return { dateStr, timeRange, tableLabel: tableLabel ? ` ${tableLabel}` : '' };
}

/**
 * 產生通用收據底部指令（QR, 標語, 換行）
 */
function appendReceiptFooter(commands, bookingRef, opts = {}) {
  const publicSiteUrl = opts.publicSiteUrl || (typeof process !== 'undefined' && process.env?.PUBLIC_SITE_URL) || 'https://shiguang.tw';
  const qrUrl = `${publicSiteUrl}/history?tab=bookings&ref=${bookingRef}`;
  const footerText = opts.receiptFooterText || '謝謝光臨，作品記得帶回家';

  commands.push({ type: 'text', text: DIVIDER, size: 24, align: 1 });
  commands.push({ type: 'qr', data: qrUrl, size: 6, align: 1 });
  commands.push({ type: 'text', text: '掃描查看預約明細', size: 22, align: 1 });
  commands.push({ type: 'text', text: footerText, size: 22, align: 1 });
  commands.push({ type: 'lineWrap', lines: 3 });
}

/**
 * Section 8.2 / 8.3 結帳收據（分開收款或整單收款）
 * @param {object} payment
 * @param {object} booking
 * @param {object} [opts]
 * @returns {Array<object>} 商米指令陣列
 */
export function buildReceipt(payment, booking = {}, opts = {}) {
  const commands = [];
  const breakdown = payment.breakdown_json || {};
  const persons = breakdown.persons || [];
  const isReprint = Boolean(opts.isReprint || payment.is_reprint);
  const bookingRef = booking.booking_ref || payment.booking_ref || '';
  const refDisplay = opts.refDisplay || formatBookingRef(bookingRef);

  // Header
  commands.push({ type: 'title', text: '拾光製所', size: 32, align: 1 });
  if (isReprint) {
    commands.push({ type: 'text', text: '*** 補印 ***', size: 24, align: 1, bold: true });
  }

  const orderMeta = breakdown.order || {};
  const personsTotal = orderMeta.persons_total || booking.pax || (persons.length || 1);
  const personsPaidAfter = orderMeta.persons_paid_after ?? (
    booking.paid_persons != null ? booking.paid_persons : persons.length
  );
  const isFullOrder = opts.isFullOrder !== undefined
    ? opts.isFullOrder
    : (personsTotal > 0 &&
       (payment.person_nos || []).length >= personsTotal &&
       personsPaidAfter >= personsTotal &&
       (!booking.payments || booking.payments.length <= 1));

  commands.push({ type: 'text', text: `結帳單 ${refDisplay}`, size: 28, align: 1, bold: true });

  const { dateStr, timeRange, tableLabel } = extractReceiptSessionInfo(booking, payment);
  commands.push({ type: 'text', text: fitLine(`${dateStr} ${timeRange}${tableLabel}`, ''), size: 22 });

  const staffName = payment.staff_name || opts.staffName || '櫃檯';
  const payTime = new Date(payment.created_at || Date.now()).toLocaleTimeString('en-GB', {
    timeZone: 'Asia/Taipei',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  });
  commands.push({ type: 'text', text: fitLine(`收款 ${payTime}`, `店員 ${staffName}`), size: 22 });
  commands.push({ type: 'text', text: DIVIDER, size: 24, align: 1 });

  // Body: per person breakdown or full summary
  if (isFullOrder && persons.length > 0) {
    // Section 8.3: 一起付（整單結帳單）
    for (const p of persons) {
      commands.push({
        type: 'text',
        text: fitLine(`${p.label} 入場 ${p.entry.hours} 小時`, formatReceiptMoney(p.entry.amount)),
        size: 22
      });
      if (p.board?.amount > 0) {
        commands.push({
          type: 'text',
          text: fitLine(`${p.label} 智能板`, formatReceiptMoney(p.board.amount)),
          size: 22
        });
      }
    }
    // Shared Addons / Promos
    const allAddons = persons.flatMap(p => p.addons || []);
    if (allAddons.length > 0) {
      const addonNames = allAddons.map(a => a.name).join('、');
      const addonTot = allAddons.reduce((s, a) => s + (a.subtotal || a.price * a.qty), 0);
      commands.push({ type: 'text', text: fitLine(`加購 ${addonNames}`, formatReceiptMoney(addonTot)), size: 22 });
    }
    // Promos / Manual discounts
    const allPromos = persons.flatMap(p => p.promos || []);
    const allShares = persons.flatMap(p => (p.shares || []).filter(s => s.amount < 0));
    if (allPromos.length > 0 || allShares.length > 0) {
      const discNames = [...allPromos.map(pr => pr.name || pr.code), ...allShares.map(sh => sh.label)].filter(Boolean).join('、') || '折扣與折讓';
      const discTot = allPromos.reduce((s, pr) => s + pr.amount, 0) + allShares.reduce((s, sh) => s + sh.amount, 0);
      commands.push({ type: 'text', text: fitLine(discNames, formatReceiptMoney(discTot)), size: 22 });
    }
  } else {
    // Section 8.2: 分開收款明細
    for (const p of persons) {
      const seatCode = p.seat_code ? `座位 ${p.seat_code}` : (booking.assigned_seats?.[p.person_no - 1] ? `座位 ${booking.assigned_seats[p.person_no - 1]}` : '');
      const seatText = seatCode ? `  ${seatCode}` : '';
      commands.push({ type: 'text', text: `${p.label}${seatText}`, size: 22, bold: true });

      // Entry
      if (p.entry) {
        commands.push({
          type: 'text',
          text: fitLine(`  入場 ${p.entry.hours || 0} 小時`, formatReceiptMoney(p.entry.amount || 0)),
          size: 22
        });
        if (p.entry.paused_minutes > 0) {
          commands.push({
            type: 'text',
            text: `  (已扣暫停 ${p.entry.paused_minutes} 分)`,
            size: 20
          });
        }
      }

      // Board
      if (p.board?.amount > 0) {
        for (const u of (p.board.units || [])) {
          const segNames = (u.segments || []).map(s => displayBoardName(s.name)).join('→') || '智能板';
          commands.push({
            type: 'text',
            text: fitLine(`  智能板 ${segNames}`, formatReceiptMoney(u.total)),
            size: 22
          });
          for (const s of (u.segments || [])) {
            const from = s.from || (s.start_at ? new Date(s.start_at).toLocaleTimeString('en-GB', { timeZone: 'Asia/Taipei', hour: '2-digit', minute: '2-digit', hour12: false }) : '');
            const to = s.to || (s.end_at ? new Date(s.end_at).toLocaleTimeString('en-GB', { timeZone: 'Asia/Taipei', hour: '2-digit', minute: '2-digit', hour12: false }) : '');
            commands.push({
              type: 'text',
              text: `   ${displayBoardName(s.name)} ${from}-${to} ${s.hours}h`,
              size: 20
            });
          }
          if (u.discount > 0) {
            const freeH = u.free_hours || 1;
            commands.push({
              type: 'text',
              text: fitLine(`   ${u.discount_label || '買送折抵'} 折 ${freeH}h`, formatReceiptMoney(-u.discount)),
              size: 20
            });
          }
        }
      }

      // Addons
      for (const a of (p.addons || [])) {
        commands.push({
          type: 'text',
          text: fitLine(`  ${a.name} ×${a.qty}`, formatReceiptMoney(a.subtotal || a.price * a.qty)),
          size: 22
        });
      }

      // Shares
      for (const sh of (p.shares || [])) {
        commands.push({
          type: 'text',
          text: fitLine(`  分攤 ${sh.label}`, formatReceiptMoney(sh.amount)),
          size: 22
        });
      }

      // Adjust
      if (p.adjust?.amount) {
        commands.push({
          type: 'text',
          text: fitLine(`  金額調整（${p.adjust.reason || '調整'}）`, formatReceiptMoney(p.adjust.amount)),
          size: 22
        });
      }
    }
  }

  commands.push({ type: 'text', text: DIVIDER, size: 24, align: 1 });

  // Pass discount if any
  if (payment.pass_json && Array.isArray(payment.pass_json) && payment.pass_json.length > 0) {
    for (const pt of payment.pass_json) {
      commands.push({
        type: 'text',
        text: fitLine(`卡券折抵 ${pt.plan_name || ''}`, formatReceiptMoney(-pt.value)),
        size: 22
      });
    }
  }

  // Payment totals
  const paxLabel = (isFullOrder && persons.length > 1) ? `（${persons.length} 位）` : '';
  commands.push({
    type: 'text',
    text: fitLine(`本次收款${paxLabel}`, formatReceiptMoney(payment.amount)),
    size: 30,
    bold: true
  });

  const methodLabel = PAYMENT_METHOD_LABELS[payment.method] || payment.method || '現金';
  if (payment.method === 'cash') {
    const recv = payment.cash_received != null ? `  收 ${formatReceiptMoney(payment.cash_received)}` : '';
    const chg = payment.change_given != null ? `  找 ${formatReceiptMoney(payment.change_given)}` : '';
    commands.push({ type: 'text', text: `現金${recv}${chg}`, size: 22 });
  } else {
    commands.push({ type: 'text', text: fitLine(methodLabel, formatReceiptMoney(payment.amount)), size: 22 });
  }

  // Status line (Section 8.2 / 8.3)
  if (personsTotal != null && personsPaidAfter != null) {
    if (personsPaidAfter >= personsTotal) {
      commands.push({ type: 'text', text: isFullOrder ? `狀態 已結清 ${personsTotal}/${personsTotal}` : `整單已結清 ${personsTotal}/${personsTotal}`, size: 22 });
    } else {
      const left = Math.max(0, personsTotal - personsPaidAfter);
      commands.push({ type: 'text', text: `整單 ${personsTotal} 位：已結 ${personsPaidAfter} 位，尚 ${left} 位`, size: 22 });
    }
  }

  if (payment.note) {
    commands.push({ type: 'text', text: `備註：${payment.note}`, size: 22 });
  }

  appendReceiptFooter(commands, bookingRef, opts);
  return commands;
}

/**
 * Section 8.4 補收收據
 */
export function buildSupplementReceipt(payment, booking = {}, opts = {}) {
  const commands = [];
  const isReprint = Boolean(opts.isReprint || payment.is_reprint);
  const bookingRef = booking.booking_ref || payment.booking_ref || '';
  const refDisplay = opts.refDisplay || formatBookingRef(bookingRef);

  commands.push({ type: 'title', text: '拾光製所', size: 32, align: 1 });
  if (isReprint) {
    commands.push({ type: 'text', text: '*** 補印 ***', size: 24, align: 1, bold: true });
  }
  commands.push({ type: 'text', text: `補收單 ${refDisplay}`, size: 28, align: 1, bold: true });

  const { dateStr, timeRange, tableLabel } = extractReceiptSessionInfo(booking, payment);
  commands.push({ type: 'text', text: fitLine(`${dateStr} ${timeRange}${tableLabel}`, ''), size: 22 });

  const staffName = payment.staff_name || opts.staffName || '櫃檯';
  const payTime = new Date(payment.created_at || Date.now()).toLocaleTimeString('en-GB', {
    timeZone: 'Asia/Taipei',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  });
  commands.push({ type: 'text', text: fitLine(`收款 ${payTime}`, `店員 ${staffName}`), size: 22 });
  commands.push({ type: 'text', text: DIVIDER, size: 24, align: 1 });

  const pNo = payment.person_nos?.[0] || 1;
  const seatCode = booking.assigned_seats?.[pNo - 1] ? `  座位 ${booking.assigned_seats[pNo - 1]}` : '';
  commands.push({ type: 'text', text: `第 ${pNo} 位${seatCode}`, size: 22, bold: true });

  const breakdown = payment.breakdown_json || {};
  const items = breakdown.items || [];
  for (const it of items) {
    const lbl = it.name || it.label || '補收項目';
    const qtyStr = it.qty ? ` ×${it.qty}` : '';
    commands.push({ type: 'text', text: fitLine(`  ${lbl}${qtyStr}`, formatReceiptMoney(it.amount || it.price)), size: 22 });
  }

  commands.push({ type: 'text', text: DIVIDER, size: 24, align: 1 });
  commands.push({ type: 'text', text: fitLine('本次補收', formatReceiptMoney(payment.amount)), size: 30, bold: true });

  if (payment.method === 'cash') {
    const recv = payment.cash_received != null ? `  收 ${formatReceiptMoney(payment.cash_received)}` : '';
    const chg = payment.change_given != null ? `  找 ${formatReceiptMoney(payment.change_given)}` : '';
    commands.push({ type: 'text', text: `現金${recv}${chg}`, size: 22 });
  } else {
    commands.push({ type: 'text', text: fitLine(PAYMENT_METHOD_LABELS[payment.method] || payment.method, formatReceiptMoney(payment.amount)), size: 22 });
  }

  if (breakdown.person_total_paid != null) {
    commands.push({ type: 'text', text: fitLine(`第 ${pNo} 位合計已付`, formatReceiptMoney(breakdown.person_total_paid)), size: 22 });
  }

  appendReceiptFooter(commands, bookingRef, opts);
  return commands;
}

/**
 * Section 8.5 退款單（兩聯，商家聯與顧客聯）
 */
function buildSingleRefundSlip(payment, booking = {}, opts = {}, isCustomerCopy = false) {
  const commands = [];
  const bookingRef = booking.booking_ref || payment.booking_ref || '';
  const refDisplay = opts.refDisplay || formatBookingRef(bookingRef);

  commands.push({ type: 'title', text: '拾光製所', size: 32, align: 1 });
  if (isCustomerCopy) {
    commands.push({ type: 'text', text: '顧客聯', size: 22, align: 1 });
  }
  commands.push({ type: 'text', text: `退款單 ${refDisplay}`, size: 28, align: 1, bold: true });

  const staffName = payment.staff_name || opts.staffName || '櫃檯';
  const payTime = new Date(payment.created_at || Date.now()).toLocaleTimeString('en-GB', {
    timeZone: 'Asia/Taipei',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  });
  commands.push({ type: 'text', text: fitLine(`退款 ${payTime}`, `店員 ${staffName}`), size: 22 });
  commands.push({ type: 'text', text: DIVIDER, size: 24, align: 1 });

  const pNo = payment.person_nos?.[0] || 1;
  const seatCode = booking.assigned_seats?.[pNo - 1]
    ? `  座位 ${booking.assigned_seats[pNo - 1]}`
    : (payment.breakdown_json?.seat_code ? `  座位 ${payment.breakdown_json.seat_code}` : '');
  commands.push({ type: 'text', text: `第 ${pNo} 位${seatCode}`, size: 22 });

  const breakdown = payment.breakdown_json || {};
  if (breakdown.original_payment_summary || breakdown.original_amount) {
    const origSummary = breakdown.original_payment_summary || '原收款';
    commands.push({
      type: 'text',
      text: fitLine(origSummary.startsWith('原收款') ? origSummary : `原收款 ${origSummary}`, formatReceiptMoney(breakdown.original_amount)),
      size: 22
    });
  }
  commands.push({ type: 'text', text: fitLine('退款', formatReceiptMoney(-payment.amount)), size: 26, bold: true });
  const methodLabel = payment.method === 'cash' ? '現金退回' : payment.method === 'line_pay' ? 'LINE Pay 退回' : '其他退回';
  commands.push({ type: 'text', text: `方式 ${methodLabel}`, size: 22 });
  commands.push({ type: 'text', text: `原因 ${payment.reason || '現場調整'}`, size: 22 });
  commands.push({ type: 'text', text: DIVIDER, size: 24, align: 1 });

  commands.push({ type: 'text', text: '店員簽名 ____________', size: 22 });
  commands.push({ type: 'text', text: '顧客簽名 ____________', size: 22 });
  commands.push({ type: 'lineWrap', lines: 3 });

  return commands;
}

export function buildRefundSlip(payment, booking = {}, opts = {}) {
  if (opts.singleCopy || (opts.isCustomerCopy !== undefined && !opts.bothCopies)) {
    return buildSingleRefundSlip(payment, booking, opts, Boolean(opts.isCustomerCopy));
  }
  // 依規格 Section 8.5 預設印兩聯：店家一張、顧客一張（第二張在店名下印「顧客聯」）
  const merchantCopy = buildSingleRefundSlip(payment, booking, opts, false);
  const customerCopy = buildSingleRefundSlip(payment, booking, opts, true);
  return [...merchantCopy, ...customerCopy];
}

/**
 * Section 8.6 整單總表（店家留存，分兩次以上收款、結清時自動印）
 */
export function buildOrderSummary(booking = {}, payments = [], opts = {}) {
  const commands = [];
  const bookingRef = booking.booking_ref || '';
  const refDisplay = opts.refDisplay || formatBookingRef(bookingRef);

  commands.push({ type: 'title', text: '拾光製所', size: 32, align: 1 });
  commands.push({ type: 'text', text: '整單總表（店家留存）', size: 28, align: 1, bold: true });

  const paxStr = booking.pax ? ` ${booking.pax} 位` : '';
  const nameStr = booking.customer_name || booking.name || '現場顧客';
  commands.push({ type: 'text', text: fitLine(`${refDisplay}  ${nameStr}${paxStr}`, ''), size: 22 });

  const { dateStr, timeRange, tableLabel } = extractReceiptSessionInfo(booking, payments[0] || {});
  commands.push({ type: 'text', text: fitLine(`${dateStr} ${timeRange}${tableLabel}`, ''), size: 22 });
  commands.push({ type: 'text', text: DIVIDER, size: 24, align: 1 });

  let orderTotal = 0;
  for (const pay of payments) {
    const status = pay.status || 'valid';
    if (status !== 'valid') continue;

    const pNos = (pay.person_nos || []).join('、') || '1';
    const mLabel = PAYMENT_METHOD_LABELS[pay.method] || pay.method || '現金';
    const timeStr = pay.created_at
      ? new Date(pay.created_at).toLocaleTimeString('en-GB', {
          timeZone: 'Asia/Taipei',
          hour: '2-digit',
          minute: '2-digit',
          hour12: false
        })
      : '';

    const kind = pay.kind || 'charge';
    if (kind === 'charge') {
      orderTotal += (pay.amount || 0);
      commands.push({
        type: 'text',
        text: fitLine(`第 ${pNos} 位 ${mLabel} ${timeStr}`, formatReceiptMoney(pay.amount || 0)),
        size: 22
      });
    } else if (kind === 'supplement') {
      orderTotal += (pay.amount || 0);
      commands.push({
        type: 'text',
        text: fitLine(`  補收 ${mLabel} ${timeStr}`, formatReceiptMoney(pay.amount || 0)),
        size: 20
      });
    } else if (kind === 'refund') {
      orderTotal -= (pay.amount || 0);
      commands.push({
        type: 'text',
        text: fitLine(`  退款 ${mLabel}退回 ${timeStr}`, formatReceiptMoney(-(pay.amount || 0))),
        size: 20
      });
    }
  }

  commands.push({ type: 'text', text: DIVIDER, size: 24, align: 1 });
  commands.push({ type: 'text', text: fitLine('整單合計', formatReceiptMoney(orderTotal)), size: 30, bold: true });
  commands.push({ type: 'text', text: `狀態 已結清 ${booking.pax || '全'}/${booking.pax || '全'}`, size: 22 });

  if (opts.reprintCount) {
    const rTime = new Date().toLocaleTimeString('en-GB', { timeZone: 'Asia/Taipei', hour: '2-digit', minute: '2-digit', hour12: false });
    commands.push({ type: 'text', text: `補印 ${opts.reprintCount} 次 · ${rTime} 印出`, size: 20 });
  }

  commands.push({ type: 'lineWrap', lines: 3 });
  return commands;
}

/**
 * Section 8.7 日結單
 */
export function buildClosingSlip(closing = {}, opts = {}) {
  const commands = [];
  const dateStr = formatReceiptDate(closing.business_date || closing.created_at || Date.now());
  const staffName = closing.staff_name || opts.staffName || '櫃檯';
  const printTime = new Date(closing.created_at || Date.now()).toLocaleTimeString('en-GB', {
    timeZone: 'Asia/Taipei',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  });

  commands.push({ type: 'title', text: '拾光製所', size: 32, align: 1 });
  commands.push({ type: 'text', text: `${dateStr} 日結單`, size: 28, align: 1, bold: true });
  commands.push({ type: 'text', text: fitLine(`列印 ${printTime}`, `店員 ${staffName}`), size: 22 });

  const totals = closing.totals_json || {};
  const rawByMethod = totals.by_method;
  const byMethod = Array.isArray(rawByMethod)
    ? rawByMethod
    : Object.entries(rawByMethod || {}).map(([method, d]) => ({
        method,
        count: d?.count || 0,
        amount: d?.amount || 0
      }));

  const totalCount = totals.total_count ?? byMethod.reduce((s, m) => s + (m.count || 0), 0);
  const bizHours = opts.businessHours || '09:00-21:00';
  commands.push({ type: 'text', text: fitLine(`營業 ${bizHours}`, `收款 ${totalCount} 筆`), size: 22 });
  commands.push({ type: 'text', text: DIVIDER, size: 24, align: 1 });

  // Breakdown by method
  for (const bm of byMethod) {
    const lbl = PAYMENT_METHOD_LABELS[bm.method] || bm.method;
    commands.push({
      type: 'text',
      text: fitLine(`${lbl} ${bm.count} 筆`, formatReceiptMoney(bm.amount)),
      size: 22
    });
  }

  const refundAmount = totals.refund_amount ?? totals.refunds?.amount ?? 0;
  const refundCount = totals.refund_count ?? totals.refunds?.count ?? (refundAmount > 0 ? 1 : 0);
  if (refundAmount > 0) {
    commands.push({
      type: 'text',
      text: fitLine(`退款 ${refundCount} 筆`, formatReceiptMoney(-refundAmount)),
      size: 22
    });
  }

  commands.push({ type: 'text', text: DIVIDER, size: 24, align: 1 });
  const actualReceived = totals.actual_received ?? totals.net_sales ?? totals.net_revenue ?? 0;
  commands.push({
    type: 'text',
    text: fitLine('今日實收', formatReceiptMoney(actualReceived)),
    size: 30,
    bold: true
  });

  const passAmount = totals.pass_amount ?? totals.pass_value ?? 0;
  const passCount = totals.pass_count ?? 0;
  if (passAmount > 0) {
    commands.push({
      type: 'text',
      text: fitLine(`卡券折抵 ${passCount} 筆（不計入）`, formatReceiptMoney(passAmount)),
      size: 20
    });
  }

  const voidAmount = totals.void_amount ?? totals.voids_amount ?? 0;
  const voidCount = totals.void_count ?? totals.voids_count ?? 0;
  if (voidAmount > 0) {
    commands.push({
      type: 'text',
      text: fitLine(`作廢 ${voidCount} 筆（不計入）`, formatReceiptMoney(voidAmount)),
      size: 20
    });
  }

  const unpaidAmount = totals.unpaid_amount ?? 0;
  const unpaidCount = totals.unpaid_count ?? 0;
  if (unpaidAmount > 0) {
    commands.push({
      type: 'text',
      text: fitLine(`未結 ${unpaidCount} 筆`, formatReceiptMoney(unpaidAmount)),
      size: 20
    });
  }

  commands.push({ type: 'text', text: DIVIDER, size: 24, align: 1 });
  commands.push({ type: 'text', text: fitLine('零用金', formatReceiptMoney(closing.float_amount || 0)), size: 22 });
  commands.push({ type: 'text', text: fitLine('現金應有', formatReceiptMoney(closing.expected_cash || 0)), size: 22 });

  if (closing.counted_cash != null) {
    commands.push({ type: 'text', text: fitLine('實點現金', formatReceiptMoney(closing.counted_cash)), size: 22 });
    commands.push({ type: 'text', text: fitLine('差額', formatReceiptMoney(closing.difference || 0)), size: 24, bold: true });
  } else {
    commands.push({ type: 'text', text: '實點現金 ____________', size: 22 });
    commands.push({ type: 'text', text: '差額 ____________', size: 22 });
  }

  commands.push({ type: 'text', text: DIVIDER, size: 24, align: 1 });
  commands.push({ type: 'text', text: '店員簽名 ____________', size: 22 });
  commands.push({ type: 'lineWrap', lines: 3 });

  return commands;
}

/**
 * 測試頁列印
 */
export function buildTestPage(station = {}, opts = {}) {
  const commands = [];
  commands.push({ type: 'title', text: '拾光製所', size: 32, align: 1 });
  commands.push({ type: 'text', text: '印表機測試頁', size: 28, align: 1, bold: true });
  commands.push({ type: 'text', text: DIVIDER, size: 24, align: 1 });
  commands.push({ type: 'text', text: `列印站：${station?.name || '櫃檯商米'}`, size: 22 });
  commands.push({ type: 'text', text: '狀態：正常在線', size: 22 });
  commands.push({ type: 'text', text: `時間：${new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' })}`, size: 22 });
  commands.push({ type: 'text', text: DIVIDER, size: 24, align: 1 });
  commands.push({ type: 'text', text: '列印功能運作正常！', size: 24, align: 1, bold: true });
  commands.push({ type: 'lineWrap', lines: 3 });
  return commands;
}

/**
 * 將商米指令陣列轉換成等寬 HTML 預覽（58mm，純文字排版）
 * @param {Array<object>} commands
 * @returns {string} HTML 字串
 */
export function commandsToPreviewHtml(commands = []) {
  let content = '';
  for (const cmd of commands) {
    if (cmd.type === 'title') {
      content += `<div style="text-align:center;font-size:18px;font-weight:bold;margin:4px 0;">${escapeHtml(cmd.text)}</div>`;
    } else if (cmd.type === 'text') {
      const align = cmd.align === 1 ? 'center' : cmd.align === 2 ? 'right' : 'left';
      const weight = cmd.bold ? 'bold' : 'normal';
      const size = cmd.size >= 28 ? '16px' : cmd.size >= 24 ? '14px' : '12px';
      content += `<div style="text-align:${align};font-weight:${weight};font-size:${size};white-space:pre;">${escapeHtml(cmd.text)}</div>`;
    } else if (cmd.type === 'qr') {
      content += `<div style="text-align:center;padding:12px;background:#f0ece6;border-radius:6px;margin:8px 0;font-size:11px;color:#666;">[QR Code 預覽]<br><span style="font-size:10px;word-break:break-all;">${escapeHtml(cmd.data)}</span></div>`;
    } else if (cmd.type === 'barcode') {
      content += `<div style="text-align:center;padding:8px;background:#eee;border-radius:4px;margin:6px 0;font-size:11px;">[條碼: ${escapeHtml(cmd.data)}]</div>`;
    } else if (cmd.type === 'lineWrap') {
      content += `<div style="height:${(cmd.lines || 1) * 16}px;"></div>`;
    }
  }

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>收據預覽</title>
  <style>
    body {
      margin: 0;
      padding: 16px;
      background: #F6F1EA;
      font-family: 'Courier New', Courier, monospace, 'Noto Sans TC', sans-serif;
      display: flex;
      justify-content: center;
    }
    .receipt-paper {
      width: 58mm;
      max-width: 280px;
      background: #FFFDF9;
      padding: 12px 14px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.1);
      border-radius: 4px;
      color: #2A231E;
      line-height: 1.45;
    }
    @media print {
      body { background: white; padding: 0; }
      .receipt-paper { width: 58mm; max-width: none; box-shadow: none; border-radius: 0; padding: 0; margin: 0; }
    }
  </style>
</head>
<body>
  <div class="receipt-paper">
    ${content}
  </div>
</body>
</html>
  `.trim();
}

function escapeHtml(str) {
  if (typeof str !== 'string') return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
