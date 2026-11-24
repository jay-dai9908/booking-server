/**
 * Compute authoritative discount value for a single pass tender applied to a person's bill.
 * Shared across backend pass quote / collect / member-passes APIs and unit tests.
 */
export function resolvePassCheckoutEffect(checkout_effect, pass_type) {
  if (checkout_effect) return checkout_effect;
  return pass_type === 'TIME_PASS' ? 'entry_hours' : 'entry_full';
}

export function computePassTenderValue({
  checkout_effect,
  pass_type,
  checkout_scope = 'entry',
  discount_percent = 0,
  checkout_value = 0,
  units = 1,
  person = {},
  hourly_price = 150,
  already_covered = 0
} = {}) {
  const effect = resolvePassCheckoutEffect(checkout_effect, pass_type);
  const entryAmount = Math.max(0, Number(person?.entry?.amount ?? 0));
  const personTotal = Math.max(0, Number(person?.total ?? 0));
  const covered = Math.max(0, Number(already_covered ?? 0));
  const remainingDue = Math.max(0, personTotal - covered);
  const effectiveUnits = effect === 'entry_full' ? 1 : Math.max(1, Number(units) || 1);
  const hourly = Math.max(0, Number(hourly_price) || 150);

  let rawDiscount = 0;
  if (effect === 'entry_hours') {
    rawDiscount = Math.min(entryAmount, effectiveUnits * hourly);
  } else if (effect === 'entry_full') {
    rawDiscount = entryAmount;
  } else if (effect === 'percent_off') {
    const scopeBase = checkout_scope === 'all' ? personTotal : entryAmount;
    rawDiscount = Math.round(scopeBase * (Number(discount_percent) || 0) / 100);
  } else if (effect === 'fixed_amount') {
    const scopeBase = checkout_scope === 'all' ? personTotal : entryAmount;
    rawDiscount = Math.min(Math.max(0, Number(checkout_value) || 0), scopeBase);
  }

  return Math.max(0, Math.min(Math.round(rawDiscount), remainingDue));
}
