import { chargeableHours } from '../../../shared/boardPricing.js';

export const calculateEquipmentChargeableHours = (
  rentalHours,
  discountConfig,
  legacyBuyHours,
  legacyFreeHours,
  legacyStackable = true
) => {
  return chargeableHours(rentalHours, discountConfig, legacyBuyHours, legacyFreeHours, legacyStackable);
};

