// backend/src/services/accounting/revenueScope.js
// 營收口徑共用定義（第 44 輪第 1 項）：排除商城（source: 'shop'），包含預約（booking）與卡券販售（pass_sale）

export const REVENUE_PAYMENT_SOURCES = ['booking', 'pass_sale'];

/**
 * 建構用於 Prisma Payment 查詢的營收範圍條件（排除 source = 'shop'）
 * @param {object} extra
 * @returns {object}
 */
export function revenuePaymentWhere(extra = {}) {
  return {
    source: { in: REVENUE_PAYMENT_SOURCES },
    ...extra
  };
}

/**
 * 判斷單筆 Payment 是否屬於門市營收範圍（非商城）
 * @param {object} payment
 * @returns {boolean}
 */
export function isRevenuePayment(payment) {
  return Boolean(payment && payment.source !== 'shop');
}
