// shared/twqr.js
// TWQR 台灣共用支付條碼純函式（前後端共用，無第三方依賴）

/**
 * 產生銀行轉帳 TWQR 條碼內容（已整串百分比編碼，僅含大寫英數與 % 等安全字元）
 * 原文格式：TWQRP://個人轉帳/158/02/V1?D5=<3碼銀行>&D6=<16位左補0帳號>&D10=901
 * @param {string} bankCode
 * @param {string} account
 * @returns {string} 編碼後的條碼字串；欄位格式不符回傳空字串
 */
export function buildTransferPayload(bankCode, account) {
  const bank = String(bankCode ?? '').replace(/\D/g, '');
  const acct = String(account ?? '').replace(/\D/g, '');
  if (bank.length !== 3 || acct.length < 6 || acct.length > 16) {
    return '';
  }
  const raw = `TWQRP://個人轉帳/158/02/V1?D5=${bank}&D6=${acct.padStart(16, '0')}&D10=901`;
  return encodeURIComponent(raw);
}

/**
 * 正規化貼上或掃描得到的 TWQR 內容：
 * - 原文（TWQRP:// 開頭）-> 整串 encodeURIComponent
 * - 已編碼（TWQRP%3A 開頭，且解碼後為 TWQRP://）-> 維持原樣
 * - 其他（例如 https://...）-> 回傳 null
 * @param {string} text
 * @returns {string|null}
 */
export function normalizePayload(text) {
  const t = String(text ?? '').trim();
  if (!t) return null;

  if (/^TWQRP:\/\//i.test(t)) {
    // 確保前綴大寫 TWQRP://
    const canonical = 'TWQRP://' + t.slice(8);
    return encodeURIComponent(canonical);
  }

  if (/^TWQRP%3A/i.test(t)) {
    try {
      const decoded = decodeURIComponent(t);
      if (/^TWQRP:\/\//i.test(decoded)) {
        return t;
      }
    } catch {
      return null;
    }
  }

  return null;
}

/**
 * 解析 TWQR 內容，回傳交易類型、銀行代碼、帳號末四碼等資訊
 * @param {string} text
 * @returns {{ name: string, country_code: string, type: string, version: string, bank_code: string, account: string, account_last4: string, currency: string }|null}
 */
export function parsePayload(text) {
  const t = String(text ?? '').trim();
  if (!t) return null;

  let raw = t;
  if (/^TWQRP%3A/i.test(t)) {
    try {
      raw = decodeURIComponent(t);
    } catch {
      return null;
    }
  }

  const m = raw.match(/^TWQRP:\/\/([^/]*)\/(\d{3})\/(\d{2})\/(V\d+)\?(.*)$/i);
  if (!m) return null;

  const q = {};
  for (const kv of m[5].split('&')) {
    if (!kv) continue;
    const eq = kv.indexOf('=');
    const k = eq >= 0 ? kv.slice(0, eq) : kv;
    const v = eq >= 0 ? kv.slice(eq + 1) : '';
    q[k] = v;
  }

  const account = q.D6 || '';
  return {
    name: m[1],
    country_code: m[2],
    type: m[3],
    version: m[4].toUpperCase(),
    bank_code: q.D5 || '',
    account,
    account_last4: account ? account.slice(-4) : '',
    currency: q.D10 || ''
  };
}

/**
 * 遮罩 TWQR 內容中的帳號（D6= / D6%3D）中段數字，僅保留末四碼
 * @param {string} payload
 * @returns {string}
 */
export function maskTwqrPayload(payload) {
  const t = String(payload ?? '');
  if (!t) return '';
  return t.replace(/(D6(?:%3D|=))(\d+)/gi, (_m, key, digits) => {
    if (digits.length <= 4) return key + digits;
    return key + '•'.repeat(digits.length - 4) + digits.slice(-4);
  });
}
