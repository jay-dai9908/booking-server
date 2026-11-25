const NUMERIC_STRING_RE = /^-?\d+(\.\d+)?$/;

function isNumericScalar(v) {
  if (typeof v === 'number') return Number.isFinite(v);
  if (typeof v === 'string') {
    const trimmed = v.trim();
    return trimmed !== '' && NUMERIC_STRING_RE.test(trimmed);
  }
  return false;
}

export function isSettingValueEqual(a, b) {
  if (Object.is(a, b)) return true;
  if (a == null || b == null) return false;

  if (isNumericScalar(a) && isNumericScalar(b)) {
    return Number(a) === Number(b);
  }

  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, idx) => isSettingValueEqual(item, b[idx]));
  }

  if (typeof a === 'object' && typeof b === 'object') {
    const keysA = Object.keys(a);
    const keysB = Object.keys(b);
    if (keysA.length !== keysB.length) return false;
    return keysA.every(
      (k) => Object.prototype.hasOwnProperty.call(b, k) && isSettingValueEqual(a[k], b[k])
    );
  }

  return false;
}

/**
 * Compare current form draft against last loaded/saved server snapshot,
 * returning an object containing only keys whose values changed.
 */
export function diffSettings(saved = {}, draft = {}) {
  if (!draft || typeof draft !== 'object') return {};
  const base = saved && typeof saved === 'object' ? saved : {};
  const diff = {};
  for (const key of Object.keys(draft)) {
    if (draft[key] === undefined) continue;
    if (!isSettingValueEqual(base[key], draft[key])) {
      diff[key] = draft[key];
    }
  }
  return diff;
}
