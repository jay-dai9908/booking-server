/**
 * Resolve Express `trust proxy` setting from TRUST_PROXY environment variable.
 * Defaults to 'loopback' (safe when Nginx runs on the same host).
 */
export function resolveTrustProxy(rawValue) {
  if (rawValue === undefined || rawValue === null) {
    return 'loopback';
  }
  const trimmed = String(rawValue).trim();
  if (!trimmed) {
    return 'loopback';
  }
  if (trimmed.toLowerCase() === 'false') {
    return false;
  }
  if (/^\d+$/.test(trimmed)) {
    return Number(trimmed);
  }
  return trimmed;
}
