/**
 * Calculate chargeable hours for equipment based on multi-tier "Buy X get Y free" promotion
 * Optimal calculation (金額擇優計價): Finds the minimum chargeable hours for the customer.
 * Supports single-tier (legacy args or config object) and multi-tier promotions.
 *
 * @param {number} rentalHours - Total hours rented
 * @param {object|boolean} discountConfig - Discount configuration object or enabled flag
 * @param {number} [legacyBuyHours] - Legacy parameter for backward compatibility
 * @param {number} [legacyFreeHours] - Legacy parameter for backward compatibility
 * @param {boolean} [legacyStackable=true] - Legacy parameter for backward compatibility
 * @returns {number} Minimum chargeable hours
 */
export const calculateEquipmentChargeableHours = (
  rentalHours,
  discountConfig,
  legacyBuyHours,
  legacyFreeHours,
  legacyStackable = true
) => {
  const hours = parseInt(rentalHours, 10) || 0;
  if (hours <= 0) return 0;

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

  // Non-stackable mode: A discount package can be applied at most once per rental
  if (!isStackable) {
    let best = hours;
    if (t1Enabled) {
      if (hours >= t1Buy && hours < t1Buy + t1Free) {
        best = Math.min(best, t1Buy);
      } else if (hours >= t1Buy + t1Free) {
        best = Math.min(best, hours - t1Free);
      }
    }
    if (t2Enabled) {
      if (hours >= t2Buy && hours < t2Buy + t2Free) {
        best = Math.min(best, t2Buy);
      } else if (hours >= t2Buy + t2Free) {
        best = Math.min(best, hours - t2Free);
      }
    }
    return Math.max(0, best);
  }

  // Dynamic Programming table: cost[h] = minimum chargeable hours to cover h hours
  // Each tier package of (buy + free) hours charges 'buy' hours.
  // Within [buy, buy + free], a customer can cap at 'buy' hours (package ceiling optimization).
  const maxH = Math.max(hours, 24);
  const cost = new Array(maxH + 1).fill(0);

  for (let h = 1; h <= maxH; h++) {
    cost[h] = cost[h - 1] + 1;

    if (t1Enabled) {
      const cycle1 = t1Buy + t1Free;
      const prev1 = Math.max(0, h - cycle1);
      cost[h] = Math.min(cost[h], cost[prev1] + t1Buy);
      if (h <= cycle1 && h >= t1Buy) {
        cost[h] = Math.min(cost[h], t1Buy);
      }
    }

    if (t2Enabled) {
      const cycle2 = t2Buy + t2Free;
      const prev2 = Math.max(0, h - cycle2);
      cost[h] = Math.min(cost[h], cost[prev2] + t2Buy);
      if (h <= cycle2 && h >= t2Buy) {
        cost[h] = Math.min(cost[h], t2Buy);
      }
    }
  }

  // Monotonicity guarantee: cost[h] <= cost[h+1]
  for (let h = maxH - 1; h >= 1; h--) {
    cost[h] = Math.min(cost[h], cost[h + 1]);
  }

  return Math.min(hours, cost[hours]);
};
