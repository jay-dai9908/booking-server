/**
 * Calculate chargeable hours for equipment based on "Buy X get Y free" promotion
 * @param {number} rentalHours - Total hours rented
 * @param {boolean} discountEnabled - Whether promotion is enabled
 * @param {number} buyHours - Buy X hours (e.g. 3)
 * @param {number} freeHours - Get Y hours free (e.g. 1)
 * @param {boolean} stackable - Whether discount can be stacked across multiple cycles
 * @returns {number} Chargeable hours
 */
export const calculateEquipmentChargeableHours = (rentalHours, discountEnabled, buyHours, freeHours, stackable = true) => {
  const hours = parseInt(rentalHours, 10) || 0;
  if (hours <= 0) return 0;
  if (!discountEnabled || !buyHours || buyHours <= 0 || !freeHours || freeHours <= 0) {
    return hours;
  }
  if (hours < buyHours) {
    return hours;
  }
  const cycles = stackable !== false ? Math.floor(hours / buyHours) : 1;
  const freeCount = cycles * freeHours;
  return Math.max(0, hours - freeCount);
};
