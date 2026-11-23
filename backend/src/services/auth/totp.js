import crypto from 'crypto';

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export const BACKUP_CODE_CHARSET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/**
 * Encode a Buffer into uppercase RFC 4648 Base32 without '=' padding.
 */
export function base32Encode(buf) {
  if (!Buffer.isBuffer(buf) || buf.length === 0) return '';
  let bits = 0;
  let value = 0;
  let output = '';

  for (let i = 0; i < buf.length; i += 1) {
    value = (value << 8) | buf[i];
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }

  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return output;
}

/**
 * Decode an RFC 4648 Base32 string (ignoring whitespace and '=' padding) into a Buffer.
 */
export function base32Decode(str) {
  if (typeof str !== 'string') {
    throw new Error('Base32 input must be a string');
  }
  const clean = str.replace(/[\s=]+/g, '').toUpperCase();
  if (!clean) {
    throw new Error('Base32 input is empty');
  }

  let bits = 0;
  let value = 0;
  const bytes = [];

  for (let i = 0; i < clean.length; i += 1) {
    const idx = BASE32_ALPHABET.indexOf(clean[i]);
    if (idx === -1) {
      throw new Error(`Invalid Base32 character: ${clean[i]}`);
    }
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }

  return Buffer.from(bytes);
}

/**
 * Generate a 20-byte random TOTP secret encoded as Base32 (no padding).
 */
export function generateSecret() {
  return base32Encode(crypto.randomBytes(20));
}

/**
 * Compute 6-digit RFC 6238 TOTP (HMAC-SHA1, 30s period) for a given step counter.
 */
export function totpAt(secretBase32, step) {
  const key = base32Decode(secretBase32);
  const counterBuf = Buffer.alloc(8);
  counterBuf.writeBigUInt64BE(BigInt(step), 0);

  const hmac = crypto.createHmac('sha1', key).update(counterBuf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binCode =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);

  return String(binCode % 1000000).padStart(6, '0');
}

/**
 * Verify a 6-digit TOTP code across [step - 1, step, step + 1] using timingSafeEqual,
 * enforcing strictly increasing time steps (matched step > lastStep).
 */
export function verifyTotp(secretBase32, code, { nowMs = Date.now(), lastStep = null } = {}) {
  if (typeof code !== 'string' || !/^\d{6}$/.test(code)) {
    return { ok: false, step: null };
  }

  const currentStep = Math.floor(nowMs / 1000 / 30);
  const codeBuf = Buffer.from(code, 'utf8');

  for (const candidateStep of [currentStep - 1, currentStep, currentStep + 1]) {
    if (candidateStep < 0) continue;
    const expected = totpAt(secretBase32, candidateStep);
    const expectedBuf = Buffer.from(expected, 'utf8');
    const matched =
      codeBuf.length === expectedBuf.length && crypto.timingSafeEqual(codeBuf, expectedBuf);
    if (matched) {
      if (lastStep !== null && lastStep !== undefined && candidateStep <= Number(lastStep)) {
        continue;
      }
      return { ok: true, step: candidateStep };
    }
  }

  return { ok: false, step: null };
}

/**
 * Build otpauth:// URI for authenticator apps.
 */
export function buildOtpauthUri(secretBase32) {
  const label = encodeURIComponent('拾光製所後台');
  const issuer = encodeURIComponent('拾光製所');
  return `otpauth://totp/${label}?secret=${secretBase32}&issuer=${issuer}&algorithm=SHA1&digits=6&period=30`;
}

function deriveKey(info, jwtSecret = process.env.JWT_SECRET) {
  if (!jwtSecret || String(jwtSecret).length < 16) {
    throw new Error('JWT_SECRET is required for TOTP key derivation');
  }
  const derived = crypto.hkdfSync(
    'sha256',
    Buffer.from(String(jwtSecret), 'utf8'),
    Buffer.alloc(0),
    Buffer.from(info, 'utf8'),
    32
  );
  return Buffer.from(derived);
}

/**
 * Encrypt Base32 TOTP secret using HKDF-SHA256 + AES-256-GCM.
 */
export function encryptTotpSecret(secretBase32, jwtSecret = process.env.JWT_SECRET) {
  if (typeof secretBase32 !== 'string' || !secretBase32) {
    throw new Error('Secret must be a non-empty string');
  }
  const key = deriveKey('sg-admin-totp-v1', jwtSecret);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(secretBase32, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString('base64')}:${tag.toString('base64')}:${ct.toString('base64')}`;
}

/**
 * Decrypt a v1 AES-256-GCM sealed TOTP secret.
 */
export function decryptTotpSecret(sealed, jwtSecret = process.env.JWT_SECRET) {
  if (typeof sealed !== 'string') {
    throw new Error('Invalid sealed secret');
  }
  const parts = sealed.split(':');
  if (parts.length !== 4 || parts[0] !== 'v1') {
    throw new Error('Unsupported sealed TOTP secret format');
  }
  const iv = Buffer.from(parts[1], 'base64');
  const tag = Buffer.from(parts[2], 'base64');
  const ct = Buffer.from(parts[3], 'base64');
  if (iv.length !== 12 || tag.length !== 16 || ct.length === 0) {
    throw new Error('Malformed sealed TOTP secret');
  }
  const key = deriveKey('sg-admin-totp-v1', jwtSecret);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

export function normalizeBackupCode(raw) {
  return String(raw || '').replace(/[\s-]+/g, '').toUpperCase();
}

export function hashBackupCode(code, jwtSecret = process.env.JWT_SECRET) {
  const key = deriveKey('sg-admin-backup-v1', jwtSecret);
  const normalized = normalizeBackupCode(code);
  return crypto.createHmac('sha256', key).update(normalized, 'utf8').digest('hex');
}

export function verifyBackupCodeHash(code, expectedHex, jwtSecret = process.env.JWT_SECRET) {
  const normalized = normalizeBackupCode(code);
  if (!normalized || typeof expectedHex !== 'string' || !/^[0-9a-f]+$/i.test(expectedHex)) {
    return false;
  }
  const actualHex = hashBackupCode(normalized, jwtSecret);
  if (actualHex.length !== expectedHex.length) {
    return false;
  }
  return crypto.timingSafeEqual(Buffer.from(actualHex, 'hex'), Buffer.from(expectedHex, 'hex'));
}

export function generateBackupCodes(count = 8) {
  const codes = [];
  for (let i = 0; i < count; i += 1) {
    let raw = '';
    for (let j = 0; j < 10; j += 1) {
      raw += BACKUP_CODE_CHARSET[crypto.randomInt(0, BACKUP_CODE_CHARSET.length)];
    }
    codes.push(`${raw.slice(0, 5)}-${raw.slice(5)}`);
  }
  return codes;
}
