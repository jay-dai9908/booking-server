import crypto from 'crypto';

export const LINE_STATE_COOKIE_NAME = 'sg_line_state';
export const LINE_STATE_COOKIE_PATH = '/api/auth/line';
export const LINE_STATE_TTL_MS = 30 * 60 * 1000;
export const LINE_STATE_MAX_ENTRIES = 5;

/**
 * Validate and normalize an in-site relative redirect path.
 * Allows paths starting with single '/' (not '//'), no backslashes, no control chars, length <= 200.
 */
export function sanitizeReturnPath(rawReturn) {
  if (typeof rawReturn !== 'string') return '/booking';
  const trimmed = rawReturn.trim();
  if (
    !trimmed ||
    !trimmed.startsWith('/') ||
    trimmed.startsWith('//') ||
    trimmed.includes('\\') ||
    /[\r\n\0]/.test(trimmed) ||
    trimmed.length > 200
  ) {
    return '/booking';
  }
  return trimmed;
}

export function generateLineState(prefix = '') {
  const cleanPrefix = prefix === 'preorder' ? 'preorder_' : '';
  return `${cleanPrefix}${crypto.randomBytes(16).toString('hex')}`;
}

function sha256Hex(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function deriveLineStateKey(jwtSecret = process.env.JWT_SECRET) {
  if (!jwtSecret || String(jwtSecret).length < 16) {
    throw new Error('JWT_SECRET is required for LINE OAuth state signing');
  }
  const derived = crypto.hkdfSync(
    'sha256',
    Buffer.from(String(jwtSecret), 'utf8'),
    Buffer.alloc(0),
    Buffer.from('sg-line-state-v1', 'utf8'),
    32
  );
  return Buffer.from(derived);
}

export function signLineStateCookie(entries, jwtSecret = process.env.JWT_SECRET) {
  const payloadB64 = Buffer.from(JSON.stringify(entries), 'utf8').toString('base64url');
  const sig = crypto
    .createHmac('sha256', deriveLineStateKey(jwtSecret))
    .update(payloadB64, 'utf8')
    .digest('base64url');
  return `${payloadB64}.${sig}`;
}

export function verifyLineStateCookie(cookieVal, jwtSecret = process.env.JWT_SECRET) {
  if (typeof cookieVal !== 'string' || !cookieVal) return null;
  const parts = cookieVal.split('.');
  if (parts.length !== 2) return null;
  const [payloadB64, actualSig] = parts;
  if (!payloadB64 || !actualSig) return null;

  let expectedSig;
  try {
    expectedSig = crypto
      .createHmac('sha256', deriveLineStateKey(jwtSecret))
      .update(payloadB64, 'utf8')
      .digest('base64url');
  } catch {
    return null;
  }

  const bufA = Buffer.from(actualSig, 'utf8');
  const bufB = Buffer.from(expectedSig, 'utf8');
  if (bufA.length !== bufB.length || !crypto.timingSafeEqual(bufA, bufB)) {
    return null;
  }

  try {
    const parsed = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function appendLineStateEntry(
  existingCookieVal,
  { state, returnPath, nowMs = Date.now(), jwtSecret = process.env.JWT_SECRET }
) {
  const existing = verifyLineStateCookie(existingCookieVal, jwtSecret) || [];
  const validExisting = existing.filter(
    (item) =>
      item &&
      typeof item.h === 'string' &&
      typeof item.r === 'string' &&
      Number.isFinite(Number(item.e)) &&
      Number(item.e) > nowMs
  );

  const nextEntries = [
    {
      h: sha256Hex(state),
      r: sanitizeReturnPath(returnPath),
      e: nowMs + LINE_STATE_TTL_MS
    },
    ...validExisting
  ].slice(0, LINE_STATE_MAX_ENTRIES);

  return signLineStateCookie(nextEntries, jwtSecret);
}

export function consumeLineStateEntry(
  cookieVal,
  state,
  { nowMs = Date.now(), jwtSecret = process.env.JWT_SECRET } = {}
) {
  if (typeof cookieVal !== 'string' || !cookieVal || typeof state !== 'string' || !state) {
    return { ok: false, returnPath: null, nextCookieVal: null };
  }

  const entries = verifyLineStateCookie(cookieVal, jwtSecret);
  if (!entries || entries.length === 0) {
    return { ok: false, returnPath: null, nextCookieVal: null };
  }

  const targetHash = sha256Hex(state);
  const targetBuf = Buffer.from(targetHash, 'utf8');

  let matchedIdx = -1;
  for (let i = 0; i < entries.length; i += 1) {
    const item = entries[i];
    if (!item || typeof item.h !== 'string' || !Number.isFinite(Number(item.e))) continue;
    if (Number(item.e) <= nowMs) continue;
    const itemBuf = Buffer.from(item.h, 'utf8');
    if (itemBuf.length === targetBuf.length && crypto.timingSafeEqual(itemBuf, targetBuf)) {
      matchedIdx = i;
      break;
    }
  }

  if (matchedIdx === -1) {
    return { ok: false, returnPath: null, nextCookieVal: null };
  }

  const matched = entries[matchedIdx];
  const remaining = entries.filter(
    (item, idx) =>
      idx !== matchedIdx &&
      item &&
      typeof item.h === 'string' &&
      Number.isFinite(Number(item.e)) &&
      Number(item.e) > nowMs
  );

  return {
    ok: true,
    returnPath: sanitizeReturnPath(matched.r),
    nextCookieVal: signLineStateCookie(remaining, jwtSecret)
  };
}
