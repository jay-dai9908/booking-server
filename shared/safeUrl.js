/**
 * Return true only if value is a string that trims and parses as an http:// or https:// URL.
 */
export function isSafeHttpUrl(value) {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (!trimmed) return false;
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Return the trimmed http(s) URL if valid, or fallback otherwise.
 */
export function safeHttpUrl(value, fallback = null) {
  if (!isSafeHttpUrl(value)) return fallback;
  return value.trim();
}
