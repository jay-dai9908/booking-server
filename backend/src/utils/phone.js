/**
 * Check whether a value is a primitive string (rejects objects, arrays, numbers, etc.).
 */
export function isPlainString(value) {
  return typeof value === 'string';
}

/**
 * Normalize a Taiwan mobile phone number (09xxxxxxxx).
 * Returns null for non-strings or strings not matching ^09\d{8}$ after stripping spaces and hyphens.
 */
export function normalizeTwMobile(value) {
  if (!isPlainString(value)) return null;
  const cleaned = value.trim().replace(/[\s-]+/g, '');
  return /^09\d{8}$/.test(cleaned) ? cleaned : null;
}
