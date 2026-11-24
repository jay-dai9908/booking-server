import { normalizePromoRule } from '../../../shared/promo.js';

/**
 * 將「打幾折（1~9.9）」或「折掉幾 %（1~99）」轉為後端 percent_off (1~99)
 */
export function parsePercentInput({ mode = 'zhe', value }) {
  const num = Number(value);
  if (mode === 'zhe') {
    const tenths = Math.round(num * 10);
    if (
      value === '' ||
      value === null ||
      value === undefined ||
      !Number.isFinite(num) ||
      num < 1 ||
      num > 9.9 ||
      Math.abs(num * 10 - tenths) > 1e-6
    ) {
      return { valid: false, percent_off: null, error: '打幾折請輸入 1～9.9（最多一位小數）' };
    }
    return { valid: true, percent_off: 100 - tenths, error: null };
  }

  if (
    value === '' ||
    value === null ||
    value === undefined ||
    !Number.isInteger(num) ||
    num < 1 ||
    num > 99
  ) {
    return { valid: false, percent_off: null, error: '折掉幾 % 請輸入 1～99 的整數' };
  }
  return { valid: true, percent_off: num, error: null };
}

/**
 * 依 normalizePromoRule 結果回推編輯表單初始輸入（打幾折 / 折掉幾 %）
 */
export function initPercentInputFromPromo(promo) {
  const pct = Math.round(Number(normalizePromoRule(promo).pct_off) || 10);
  if (pct >= 1 && pct <= 90) {
    const zhe = Number(((100 - pct) / 10).toFixed(1));
    return { mode: 'zhe', value: String(zhe) };
  }
  return { mode: 'pct', value: String(Math.min(99, Math.max(1, pct))) };
}

/**
 * 即時顯示換算：「顧客付 85%（8.5 折），600 元折 90 元」
 */
export function formatPercentConversionHint(percentOff, sampleBase = 600) {
  const pct = Number(percentOff);
  if (!Number.isFinite(pct) || pct <= 0 || pct > 100) return '';
  const payPct = Number((100 - pct).toFixed(1));
  const zhe = Number((payPct / 10).toFixed(1));
  const saved = Math.round((sampleBase * pct) / 100);
  const zheLabel = pct >= 100 ? '免費' : `${zhe} 折`;
  return `顧客付 ${payPct}%（${zheLabel}），${sampleBase} 元折 ${saved} 元`;
}

/**
 * 列表卡片顯示百分比：「9 折（折 10%）」— 直接讀 normalizePromoRule 結果
 */
export function formatPercentageBadge(promo) {
  const pct = Math.round(Number(normalizePromoRule(promo).pct_off) || 0);
  if (pct >= 100) return '免費（折 100%）';
  const zhe = Number(((100 - pct) / 10).toFixed(1));
  return `${zhe} 折（折 ${pct}%）`;
}
