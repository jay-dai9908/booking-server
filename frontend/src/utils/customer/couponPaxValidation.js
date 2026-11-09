/**
 * 檢查優惠券人數條件，若不符合則回傳取消狀態與提示訊息
 * 規格 Round 18 Item 2: 人數改變時重新檢查已套用的優惠條件。不符合就取消套用，toast（逐字）「此優惠券需滿 3 人方可使用，已自動取消套用」。
 * @param {object|null} promo - 已套用的優惠券物件 (例如 { code, min_pax, ... })
 * @param {number} pax - 目前人數
 * @returns {{ valid: boolean, cancelled: boolean, message?: string }}
 */
export function validateCouponPax(promo, pax) {
  if (!promo) {
    return { valid: true, cancelled: false };
  }
  const minPax = promo.min_pax != null ? Number(promo.min_pax) : 1;
  const currentPax = Number(pax) || 0;
  if (minPax > 1 && currentPax < minPax) {
    return {
      valid: false,
      cancelled: true,
      message: `此優惠券需滿 ${minPax} 人方可使用，已自動取消套用`
    };
  }
  return { valid: true, cancelled: false };
}
