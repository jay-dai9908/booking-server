// shared/splitAmount.js
// 最大餘數法分攤金額（確保每一筆加總剛好等於 total，不能差 1 元）

/**
 * 最大餘數法分攤金額（確保每一筆加總剛好等於 total，不能差 1 元）
 * @param {number} total - 要分攤的總金額（可正可負）
 * @param {Array<{ person_no: number, weight: number }>} items
 * @returns {Array<{ person_no: number, amount: number }>}
 */
export function splitAmount(total, items = []) {
  if (!items || items.length === 0) return [];
  const tot = Math.round(Number(total) || 0);
  if (tot === 0) {
    return items.map(it => ({ person_no: it.person_no, amount: 0 }));
  }

  const sign = tot < 0 ? -1 : 1;
  const T = Math.abs(tot);
  const totalWeight = items.reduce((sum, it) => sum + Math.max(0, Number(it.weight) || 0), 0);
  const hasPositiveWeight = totalWeight > 0;
  const W = hasPositiveWeight ? totalWeight : items.length;
  const weights = hasPositiveWeight ? items.map(it => Math.max(0, Number(it.weight) || 0)) : items.map(() => 1);

  const raw = weights.map(w => (T * w) / W);
  const base = raw.map(Math.floor);
  let left = T - base.reduce((s, b) => s + b, 0);

  // 排序：餘數大者優先，若餘數相同則 person_no 小者優先
  const order = raw
    .map((r, i) => ({ i, frac: r - Math.floor(r), no: items[i].person_no }))
    .sort((a, b) => b.frac - a.frac || a.no - b.no);

  for (const o of order) {
    if (left <= 0) break;
    base[o.i] += 1;
    left -= 1;
  }

  return items.map((it, i) => ({
    person_no: it.person_no,
    amount: sign * base[i]
  }));
}
