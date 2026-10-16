/**
 * Calculate chargeable hours for equipment based on "Buy X get Y free" promotion
 * @param {number} rentalHours - Total hours rented
 * @param {boolean} discountEnabled - Whether promotion is enabled
 * @param {number} buyHours - Buy X hours (e.g. 3)
 * @param {number} freeHours - Get Y hours free (e.g. 1)
 * @returns {number} Chargeable hours
 */
export const calculateEquipmentChargeableHours = (rentalHours, discountEnabled, buyHours, freeHours) => {
  const hours = parseInt(rentalHours, 10) || 0;
  if (hours <= 0) return 0;
  if (!discountEnabled || !buyHours || buyHours <= 0 || !freeHours || freeHours <= 0) {
    return hours;
  }
  const cycle = buyHours + freeHours;
  const fullCycles = Math.floor(hours / cycle);
  const remainder = hours % cycle;
  const chargeableRemainder = Math.min(remainder, buyHours);
  return (fullCycles * buyHours) + chargeableRemainder;
};
