// shared/paymentMethods.js
// 付款方式代碼正規化與顯示名稱解析（純函式）

export const PAYMENT_METHOD_LABELS = {
  cash: '現金',
  line_pay: 'LINE Pay',
  linepay: 'LINE Pay',
  jkopay: '街口支付',
  card: '刷卡',
  transfer: '銀行轉帳',
  pass: '卡券折抵',
  other: '其他',
  none: '免收',
  mixed: '多種方式'
};

export const RESERVED_PAYMENT_KEYS = new Set(['pass', 'none', 'mixed', 'waive']);

/**
 * 正規化付款方式代碼：轉小寫、去掉前後空白、去掉 - 和 _
 * 例：'line_pay' / 'LinePay' / 'line-pay' -> 'linepay'
 * @param {string} key
 * @returns {string}
 */
export function normalizeMethodKey(key) {
  if (key == null) return '';
  return String(key).trim().toLowerCase().replace(/[-_]/g, '');
}

/**
 * 依設定清單與預設對照表解析付款方式顯示名稱：
 * 1. 先在設定清單 methods 裡用正規化後的 key 找 label
 * 2. 找不到再用 PAYMENT_METHOD_LABELS
 * 3. 都沒有就回原字串
 * @param {string} key
 * @param {Array<{key?: string, code?: string, label?: string}>} methods
 * @returns {string}
 */
export function methodLabel(key, methods = []) {
  if (key == null) return '';
  const raw = String(key).trim();
  if (!raw) return '';

  const norm = normalizeMethodKey(raw);
  if (Array.isArray(methods)) {
    for (const m of methods) {
      if (!m || typeof m !== 'object') continue;
      const mNorm = normalizeMethodKey(m.key ?? m.code);
      if (mNorm && mNorm === norm) {
        const lbl = typeof m.label === 'string' ? m.label.trim() : '';
        if (lbl) return lbl;
      }
    }
  }

  if (PAYMENT_METHOD_LABELS[raw]) return PAYMENT_METHOD_LABELS[raw];
  const lower = raw.toLowerCase();
  if (PAYMENT_METHOD_LABELS[lower]) return PAYMENT_METHOD_LABELS[lower];
  if (PAYMENT_METHOD_LABELS[norm]) return PAYMENT_METHOD_LABELS[norm];

  return raw;
}
