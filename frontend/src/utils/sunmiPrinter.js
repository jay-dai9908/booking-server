/**
 * 商米 Sunmi V2s WebView POS 熱感應印表機串接工具
 * 依據 docs/sunmi_pos_api_guide.md 規範實作 (58mm 紙寬 / 單行 31 半形字元安全預算)
 */

const DIVIDER = '-------------------------------\n';
const DOUBLE_DIVIDER = '===============================\n';

/**
 * 隱私遮罩手機號碼：0912345678 -> 0912***678
 */
export const maskPhoneNumber = (phone) => {
  if (!phone || typeof phone !== 'string') return '未提供';
  const clean = phone.trim();
  if (clean.length >= 10) {
    return `${clean.slice(0, 4)}***${clean.slice(-3)}`;
  }
  if (clean.length >= 6) {
    return `${clean.slice(0, 2)}***${clean.slice(-2)}`;
  }
  return clean;
};

/**
 * 檢查目前環境是否為商米 V2s POS App WebView
 */
export const isSunmiPosAvailable = () => {
  return typeof window !== 'undefined' && Boolean(window.AndroidPrinter);
};

export const PAYMENT_METHOD_LABELS = {
  cash: '現金付款',
  line_pay: 'LINE Pay',
  transfer: '銀行轉帳',
  other: '其他方式'
};

/**
 * 建立「整單結帳明細（含多人拆帳）」的商米 JSON 指令陣列与預覽結構
 */
export const buildFullReceiptCommands = (data) => {
  const {
    bookingRef = '',
    customerName = '現場貴賓',
    customerPhone = '',
    sessionDate = '',
    timeRange = '',
    seats = [],
    people = [],
    orderAddons = [],
    appliedPromos = [],
    subtotalSeating = 0,
    subtotalEquipment = 0,
    subtotalAddons = 0,
    discountAmount = 0,
    totalAmount = 0,
    paymentMethod = 'cash',
    note = ''
  } = data;

  const shortRef = String(bookingRef).slice(0, 8).toUpperCase();
  const maskedPhone = maskPhoneNumber(customerPhone);
  const nowStr = new Date().toLocaleString('zh-TW', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  });

  const commands = [
    { type: 'title', text: '拾光製所 結帳明細\n', size: 32 },
    { type: 'text', text: '手作拼豆 · 療癒時光空間\n', size: 22, align: 1 },
    { type: 'text', text: DOUBLE_DIVIDER, size: 24, align: 1 },
    { type: 'text', text: `單號: #${shortRef}\n`, size: 24, align: 0 },
    { type: 'text', text: `時間: ${nowStr}\n`, size: 22, align: 0 },
    { type: 'text', text: `場次: ${sessionDate} ${timeRange}\n`, size: 22, align: 0 },
    { type: 'text', text: `貴賓: ${customerName} (${maskedPhone})\n`, size: 22, align: 0 }
  ];

  if (seats && seats.length > 0) {
    commands.push({
      type: 'text',
      text: `座位: ${seats.join(', ')}\n`,
      size: 22,
      align: 0
    });
  }

  commands.push({ type: 'text', text: DIVIDER, size: 24, align: 1 });
  commands.push({
    type: 'columns',
    cols: ['項目 / 拆帳明細', '金額'],
    weights: [2, 1],
    aligns: [0, 2]
  });
  commands.push({ type: 'text', text: DIVIDER, size: 24, align: 1 });

  // Per-person breakdown
  people.forEach((p, idx) => {
    const label = p.label || `第 ${idx + 1} 位`;
    const modeStr = p.is_unlimited
      ? '不限時封頂'
      : `計時 ${p.total_hours}h${p.extra_half_hours > 0 ? `(含加時+${p.extra_half_hours * 0.5}h)` : ''}`;

    commands.push({
      type: 'columns',
      cols: [`[${label}] ${modeStr}`, `NT$${p.person_total}`],
      weights: [2, 1],
      aligns: [0, 2]
    });

    // Sub-details for this person
    const subParts = [`座位$${p.seating_fee}`];
    if (p.equipment_fee > 0) subParts.push(`洞洞板$${p.equipment_fee}`);
    if (p.addons_fee > 0) subParts.push(`加購$${p.addons_fee}`);
    if (p.discount_fee > 0) subParts.push(`折抵-$${p.discount_fee}`);

    commands.push({
      type: 'text',
      text: `  └ ${subParts.join(' / ')}\n`,
      size: 20,
      align: 0
    });

    if (Array.isArray(p.addons) && p.addons.length > 0) {
      p.addons.forEach(a => {
        commands.push({
          type: 'text',
          text: `    + ${a.name} x${a.qty || 1} ($${(a.price || 0) * (a.qty || 1)})\n`,
          size: 20,
          align: 0
        });
      });
    }
  });

  // Order-level shared addons
  if (Array.isArray(orderAddons) && orderAddons.length > 0) {
    commands.push({ type: 'text', text: DIVIDER, size: 24, align: 1 });
    commands.push({ type: 'text', text: '【整單吊飾 / 周邊加購】\n', size: 22, bold: true, align: 0 });
    orderAddons.forEach(item => {
      const sub = (item.price || 0) * (item.qty || 1);
      commands.push({
        type: 'columns',
        cols: [`${item.name} x${item.qty || 1}`, `NT$${sub}`],
        weights: [2, 1],
        aligns: [0, 2]
      });
    });
  }

  commands.push({ type: 'text', text: DIVIDER, size: 24, align: 1 });

  // Subtotals
  commands.push({
    type: 'columns',
    cols: ['座位與時數小計', `NT$${subtotalSeating}`],
    weights: [2, 1],
    aligns: [0, 2]
  });

  if (subtotalEquipment > 0) {
    commands.push({
      type: 'columns',
      cols: ['智慧洞洞板租借', `NT$${subtotalEquipment}`],
      weights: [2, 1],
      aligns: [0, 2]
    });
  }

  if (subtotalAddons > 0) {
    commands.push({
      type: 'columns',
      cols: ['吊飾與周邊加購', `NT$${subtotalAddons}`],
      weights: [2, 1],
      aligns: [0, 2]
    });
  }

  if (discountAmount > 0) {
    const promoNames = appliedPromos.length > 0
      ? appliedPromos.map(c => c.code || c.name).join(',')
      : '優惠折抵';
    commands.push({
      type: 'columns',
      cols: [`折扣 (${promoNames})`, `-NT$${discountAmount}`],
      weights: [2, 1],
      aligns: [0, 2]
    });
  }

  commands.push({ type: 'text', text: DOUBLE_DIVIDER, size: 24, align: 1 });
  commands.push({
    type: 'columns',
    cols: ['總計應收', `NT$ ${totalAmount}`],
    weights: [1, 1],
    aligns: [0, 2]
  });
  commands.push({
    type: 'columns',
    cols: ['付款方式', PAYMENT_METHOD_LABELS[paymentMethod] || '現金付款'],
    weights: [1, 1],
    aligns: [0, 2]
  });

  if (note && note.trim()) {
    commands.push({ type: 'text', text: `備註: ${note.trim()}\n`, size: 20, align: 0 });
  }

  commands.push({ type: 'text', text: DIVIDER, size: 24, align: 1 });
  commands.push({
    type: 'text',
    text: '感謝您的光臨，期待下次相見！\n',
    size: 22,
    bold: true,
    align: 1
  });
  commands.push({ type: 'lineWrap', lines: 4 });

  return commands;
};

/**
 * 建立「單人分拆結帳單」的商米 JSON 指令陣列 (方便同行朋友各自拿收據報帳或分攤)
 */
export const buildPersonSplitReceiptCommands = (person, index, data) => {
  const {
    bookingRef = '',
    customerName = '現場貴賓',
    sessionDate = '',
    timeRange = '',
    paymentMethod = 'cash'
  } = data;

  const shortRef = String(bookingRef).slice(0, 8).toUpperCase();
  const label = person.label || `第 ${index + 1} 位`;
  const nowStr = new Date().toLocaleString('zh-TW', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  });

  const modeStr = person.is_unlimited
    ? '不限時封頂方案'
    : `計時 ${person.total_hours} 小時${person.extra_half_hours > 0 ? ` (含加時 +${person.extra_half_hours * 0.5}h)` : ''}`;

  const commands = [
    { type: 'title', text: '拾光製所 分拆結帳單\n', size: 30 },
    { type: 'text', text: `【${label} 專屬明細】\n`, size: 24, bold: true, align: 1 },
    { type: 'text', text: DOUBLE_DIVIDER, size: 24, align: 1 },
    { type: 'text', text: `主單號: #${shortRef}-${index + 1}\n`, size: 22, align: 0 },
    { type: 'text', text: `時間: ${nowStr}\n`, size: 22, align: 0 },
    { type: 'text', text: `場次: ${sessionDate} ${timeRange}\n`, size: 22, align: 0 },
    { type: 'text', text: `預約代表: ${customerName}\n`, size: 22, align: 0 },
    { type: 'text', text: DIVIDER, size: 24, align: 1 },
    {
      type: 'columns',
      cols: [modeStr, `NT$${person.seating_fee}`],
      weights: [2, 1],
      aligns: [0, 2]
    }
  ];

  if (person.equipment_fee > 0) {
    commands.push({
      type: 'columns',
      cols: [`智慧洞洞板 (${person.equipment_hours || person.base_hours}h)`, `NT$${person.equipment_fee}`],
      weights: [2, 1],
      aligns: [0, 2]
    });
  }

  if (Array.isArray(person.addons) && person.addons.length > 0) {
    person.addons.forEach(a => {
      const sub = (a.price || 0) * (a.qty || 1);
      commands.push({
        type: 'columns',
        cols: [`加購:${a.name} x${a.qty || 1}`, `NT$${sub}`],
        weights: [2, 1],
        aligns: [0, 2]
      });
    });
  }

  if (person.discount_fee > 0) {
    commands.push({
      type: 'columns',
      cols: ['個人分攤折扣', `-NT$${person.discount_fee}`],
      weights: [2, 1],
      aligns: [0, 2]
    });
  }

  commands.push({ type: 'text', text: DOUBLE_DIVIDER, size: 24, align: 1 });
  commands.push({
    type: 'columns',
    cols: [`${label} 應付金額`, `NT$ ${person.person_total}`],
    weights: [1, 1],
    aligns: [0, 2]
  });
  commands.push({
    type: 'columns',
    cols: ['付款方式', PAYMENT_METHOD_LABELS[paymentMethod] || '現金付款'],
    weights: [1, 1],
    aligns: [0, 2]
  });
  commands.push({ type: 'text', text: DIVIDER, size: 24, align: 1 });
  commands.push({
    type: 'text',
    text: '感謝您的光臨，祝您創作愉快！\n',
    size: 22,
    bold: true,
    align: 1
  });
  commands.push({ type: 'lineWrap', lines: 4 });

  return commands;
};

/**
 * 發送列印任務至商米 V2s POS 機；若非商米環境則回傳 false 由前端彈出 58mm 預覽視窗
 */
export const sendCommandsToSunmiPrinter = (commands) => {
  return new Promise((resolve) => {
    if (typeof window === 'undefined' || !window.AndroidPrinter) {
      resolve({ printedOnDevice: false, message: '非商米 POS 環境，已開啟收據預覽' });
      return;
    }

    try {
      const jsonPayload = JSON.stringify(commands);

      // 註冊一次性全域回呼
      window.onPOSPrintComplete = function (success, msg) {
        resolve({
          printedOnDevice: true,
          success: Boolean(success),
          message: msg || (success ? '商米 V2s 出紙成功' : '列印失敗')
        });
      };

      if (typeof window.AndroidPrinter.printReceiptWithCallback === 'function') {
        window.AndroidPrinter.printReceiptWithCallback(jsonPayload, 'onPOSPrintComplete');
      } else if (typeof window.AndroidPrinter.printReceipt === 'function') {
        window.AndroidPrinter.printReceipt(jsonPayload);
        resolve({ printedOnDevice: true, success: true, message: '已發送列印指令至商米 V2s' });
      } else {
        resolve({ printedOnDevice: false, message: '找不到 AndroidPrinter 列印方法' });
      }
    } catch (err) {
      console.error('Sunmi print error:', err);
      resolve({ printedOnDevice: true, success: false, message: err.message || '列印發生例外錯誤' });
    }
  });
};
