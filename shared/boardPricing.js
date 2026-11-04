// shared/boardPricing.js
// 智能板買送計費（支援半小時格、多層階梯、擇優計價）

/**
 * 計算智能板應計費時數（支援 0.5 小時步進）
 * @param {number} rentalHours
 * @param {object|boolean} discountConfig
 * @param {number} [legacyBuyHours]
 * @param {number} [legacyFreeHours]
 * @param {boolean} [legacyStackable=true]
 * @returns {number} 應收時數
 */
export function chargeableHours(
  rentalHours,
  discountConfig,
  legacyBuyHours,
  legacyFreeHours,
  legacyStackable = true
) {
  const hours = Number(rentalHours) || 0;
  if (hours <= 0) return 0;

  // 轉換成半小時格 (blocks of 0.5h)
  const blocks = Math.round(hours * 2);
  if (blocks <= 0) return 0;

  let t1Enabled = false;
  let t1Buy = 3;
  let t1Free = 1;
  let t2Enabled = false;
  let t2Buy = 8;
  let t2Free = 4;

  if (typeof discountConfig === 'object' && discountConfig !== null) {
    t1Enabled = discountConfig.enabled !== false;
    t1Buy = Math.max(1, parseInt(discountConfig.buy_hours, 10) || 3);
    t1Free = Math.max(1, parseInt(discountConfig.free_hours, 10) || 1);
    t2Enabled = discountConfig.tier2_enabled === true;
    t2Buy = Math.max(1, parseInt(discountConfig.tier2_buy_hours, 10) || 8);
    t2Free = Math.max(1, parseInt(discountConfig.tier2_free_hours, 10) || 4);
  } else {
    t1Enabled = discountConfig !== false;
    t1Buy = Math.max(1, parseInt(legacyBuyHours, 10) || 3);
    t1Free = Math.max(1, parseInt(legacyFreeHours, 10) || 1);
  }

  if (!t1Enabled && !t2Enabled) {
    return hours;
  }

  const isStackable = typeof discountConfig === 'object' && discountConfig !== null
    ? discountConfig.stackable !== false
    : legacyStackable !== false;

  // 轉換成半小時單位
  const b1Buy = t1Buy * 2;
  const b1Free = t1Free * 2;
  const b2Buy = t2Buy * 2;
  const b2Free = t2Free * 2;

  if (!isStackable) {
    let best = blocks;
    if (t1Enabled) {
      if (blocks >= b1Buy && blocks < b1Buy + b1Free) {
        best = Math.min(best, b1Buy);
      } else if (blocks >= b1Buy + b1Free) {
        best = Math.min(best, blocks - b1Free);
      }
    }
    if (t2Enabled) {
      if (blocks >= b2Buy && blocks < b2Buy + b2Free) {
        best = Math.min(best, b2Buy);
      } else if (blocks >= b2Buy + b2Free) {
        best = Math.min(best, blocks - b2Free);
      }
    }
    return Math.max(0, best) / 2;
  }

  // 動態規劃表：cost[b] = 涵蓋 b 個半小時格的最少計費格數
  const maxB = Math.max(blocks, 48); // 至少 24 小時 = 48 格
  const cost = new Array(maxB + 1).fill(0);

  for (let b = 1; b <= maxB; b++) {
    cost[b] = cost[b - 1] + 1;

    if (t1Enabled) {
      const cycle1 = b1Buy + b1Free;
      const prev1 = Math.max(0, b - cycle1);
      cost[b] = Math.min(cost[b], cost[prev1] + b1Buy);
      if (b <= cycle1 && b >= b1Buy) {
        cost[b] = Math.min(cost[b], b1Buy);
      }
    }

    if (t2Enabled) {
      const cycle2 = b2Buy + b2Free;
      const prev2 = Math.max(0, b - cycle2);
      cost[b] = Math.min(cost[b], cost[prev2] + b2Buy);
      if (b <= cycle2 && b >= b2Buy) {
        cost[b] = Math.min(cost[b], b2Buy);
      }
    }
  }

  for (let b = maxB - 1; b >= 1; b--) {
    cost[b] = Math.min(cost[b], cost[b + 1]);
  }

  return cost[blocks] / 2;
}

/**
 * 計算同一台板子（含分段換板）的金額（方案 B）
 * @param {{ segments: Array<{ hours: number, rate: number, name?: string, start_at?: any, end_at?: any }>, discountConfig: any }} params
 * @returns {{ H: number, gross: number, chargeable: number, free: number, cheapest: number, discount: number, total: number }}
 */
export function calculateBoardTotal({ segments = [], discountConfig }) {
  const H = segments.reduce((sum, s) => sum + (Number(s.hours) || 0), 0);
  const gross = segments.reduce((sum, s) => sum + Math.round((Number(s.hours) || 0) * (Number(s.rate) || 0)), 0);
  const chargeable = chargeableHours(H, discountConfig);
  const free = Math.max(0, H - chargeable);
  const activeSegs = segments.filter(s => (Number(s.hours) || 0) > 0);
  const cheapest = activeSegs.length > 0
    ? Math.min(...activeSegs.map(s => Number(s.rate) || 0))
    : 0;
  const discount = Math.round(free * cheapest);
  const total = Math.max(0, gross - discount);

  return {
    H,
    gross,
    chargeable,
    free,
    cheapest,
    discount,
    total
  };
}
