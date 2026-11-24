// shared/promo.js
// 統一優惠碼規則正規化與折抵計算（線上預約、半自助日、櫃檯帳單共用）

import { splitAmount } from './splitAmount.js';

/**
 * 將資料庫 PromoCode 轉為標準化的 rule_v: 2 規則物件
 * - percentage: percent_off 優先；否則 discount_value 1~50 當折掉 %, 51~99 當「幾折」(100 - val), 100 當 100
 * - free_hours: 以套用當下 hourly_price × discount_value 四捨五入換算固定金額
 * @param {object} promo
 * @param {{ hourly_price?: number }} [opts]
 * @returns {object}
 */
export function normalizePromoRule(promo, { hourly_price } = {}) {
  const rate = hourly_price !== null && hourly_price !== undefined && Number.isFinite(Number(hourly_price))
    ? Number(hourly_price)
    : 150;
  const maxCapRaw = promo?.max_discount_amount;
  const max_discount_amount = maxCapRaw !== null && maxCapRaw !== undefined && Number(maxCapRaw) > 0
    ? Math.round(Number(maxCapRaw))
    : null;

  const base = {
    rule_v: 2,
    promo_id: promo?.id ?? promo?.promo_id ?? null,
    code: promo?.code || '',
    name: promo?.name || promo?.code || '',
    discount_type: promo?.discount_type || 'fixed_order',
    target_scope: promo?.target_scope || 'all',
    max_discount_amount
  };

  if (base.discount_type === 'percentage') {
    let pct_off = 0;
    if (promo?.percent_off !== null && promo?.percent_off !== undefined && Number.isFinite(Number(promo.percent_off))) {
      pct_off = Math.max(0, Math.min(100, Math.round(Number(promo.percent_off))));
    } else {
      const val = Number(promo?.discount_value) || 0;
      if (val >= 1 && val <= 50) {
        pct_off = val;
      } else if (val > 50 && val < 100) {
        pct_off = Math.round((100 - val) * 100) / 100;
      } else if (val >= 100) {
        pct_off = 100;
      } else {
        pct_off = 0;
      }
    }
    return { ...base, pct_off };
  }

  if (base.discount_type === 'free_hours') {
    const hours = Math.max(0, Number(promo?.discount_value) || 0);
    const free_hours_amount = Math.max(0, Math.round(rate * hours));
    return { ...base, free_hours_amount };
  }

  const value = Math.max(0, Math.round(Number(promo?.discount_value) || 0));
  return { ...base, value };
}

/**
 * 依標準化規則與每人金額計算折抵金額
 * @param {object} rule - normalizePromoRule 產出之 rule_v: 2 規則
 * @param {Array<{ person_no: number, entry_amount?: number, board_amount?: number, base_amount?: number }>} persons
 * @returns {{ total: number, per_person: Array<{ person_no: number, amount: number }> }}
 */
export function computePromoDiscount(rule, persons = []) {
  if (!rule || !Array.isArray(persons) || persons.length === 0) {
    return { total: 0, per_person: [] };
  }

  const scope = rule.target_scope || 'all';
  const normalizedPersons = persons.map((p) => {
    const entryAmt = Math.max(0, Math.round(Number(p.entry_amount ?? p.entry?.amount ?? 0) || 0));
    const boardAmt = Math.max(0, Math.round(Number(p.board_amount ?? p.board?.amount ?? 0) || 0));
    const baseAmt = Math.max(0, Math.round(Number(p.base_amount ?? (entryAmt + boardAmt)) || 0));
    const scopeAmt = scope === 'seating' ? entryAmt : scope === 'equipment' ? boardAmt : baseAmt;
    return {
      person_no: Number(p.person_no),
      scopeAmt
    };
  });

  let rawList = [];
  if (rule.discount_type === 'percentage') {
    const pct = Math.max(0, Math.min(100, Number(rule.pct_off) || 0));
    rawList = normalizedPersons.map((p) => ({
      person_no: p.person_no,
      amount: Math.min(p.scopeAmt, Math.round((p.scopeAmt * pct) / 100))
    }));
  } else if (rule.discount_type === 'fixed_per_pax') {
    const val = Math.max(0, Math.round(Number(rule.value) || 0));
    rawList = normalizedPersons.map((p) => ({
      person_no: p.person_no,
      amount: Math.min(p.scopeAmt, val)
    }));
  } else {
    // fixed_order or free_hours
    const rawRuleAmt = rule.discount_type === 'free_hours'
      ? Math.max(0, Math.round(Number(rule.free_hours_amount) || 0))
      : Math.max(0, Math.round(Number(rule.value) || 0));
    const scopeSum = normalizedPersons.reduce((s, p) => s + p.scopeAmt, 0);
    const totalToSplit = Math.min(rawRuleAmt, scopeSum);
    rawList = splitAmount(
      totalToSplit,
      normalizedPersons.map((p) => ({ person_no: p.person_no, weight: p.scopeAmt }))
    );
  }

  const rawTotal = rawList.reduce((s, r) => s + r.amount, 0);
  const maxCap = rule.max_discount_amount != null && Number(rule.max_discount_amount) > 0
    ? Math.round(Number(rule.max_discount_amount))
    : null;

  if (maxCap != null && rawTotal > maxCap) {
    const cappedSplit = splitAmount(
      maxCap,
      rawList.map((r) => ({ person_no: r.person_no, weight: r.amount }))
    );
    const scopeByNo = new Map(normalizedPersons.map((p) => [p.person_no, p.scopeAmt]));
    const per_person = cappedSplit.map((r) => ({
      person_no: r.person_no,
      amount: Math.min(r.amount, scopeByNo.get(r.person_no) ?? r.amount)
    }));
    const total = per_person.reduce((s, r) => s + r.amount, 0);
    return { total, per_person };
  }

  return { total: rawTotal, per_person: rawList };
}
