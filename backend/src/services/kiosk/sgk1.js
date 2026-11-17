import crypto from 'crypto';

export const OPS = ['sync', 'access'];

const hmac = (key, msg) => crypto.createHmac('sha256', key).update(msg).digest();

/**
 * 由 32 位元組配對金鑰導出請求與回應兩把方向金鑰
 * @param {Buffer} pairKey
 * @returns {{ req: Buffer, res: Buffer }}
 */
export function deriveKeys(pairKey) {
  if (!Buffer.isBuffer(pairKey) || pairKey.length !== 32) {
    throw new Error('pair key must be 32 bytes');
  }
  return {
    req: hmac(pairKey, 'sgk1-req'),
    res: hmac(pairKey, 'sgk1-res')
  };
}

function seal(key, aad, plaintext, nonce = crypto.randomBytes(12)) {
  const c = crypto.createCipheriv('aes-256-gcm', key, nonce);
  c.setAAD(Buffer.from(aad, 'utf8'));
  const ct = Buffer.concat([c.update(plaintext, 'utf8'), c.final(), c.getAuthTag()]);
  return { n: nonce.toString('base64'), c: ct.toString('base64') };
}

function open(key, aad, n, c) {
  const nonce = Buffer.from(String(n), 'base64');
  const ct = Buffer.from(String(c), 'base64');
  if (nonce.length !== 12 || ct.length < 17) {
    throw new Error('bad envelope');
  }
  const d = crypto.createDecipheriv('aes-256-gcm', key, nonce);
  d.setAAD(Buffer.from(aad, 'utf8'));
  d.setAuthTag(ct.subarray(ct.length - 16));
  return Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]).toString('utf8');
}

/**
 * 將 32-byte 配對金鑰使用 HMAC-SHA256(JWT_SECRET, "kiosk-key-wrap") 做 AES-256-GCM 加密保存於資料庫
 * 若伺服器 JWT_SECRET 更換，既有的 key_wrapped 將無法解密，需重新配對。
 * @param {Buffer} pairKey
 * @param {string} [serverSecret]
 * @returns {string}
 */
export function wrapPairKey(pairKey, serverSecret = process.env.JWT_SECRET) {
  if (!serverSecret || String(serverSecret).length < 16) {
    throw new Error('JWT_SECRET is required to wrap kiosk pair key');
  }
  if (!Buffer.isBuffer(pairKey) || pairKey.length !== 32) {
    throw new Error('pairKey must be 32 bytes');
  }
  const wrapKey = hmac(serverSecret, 'kiosk-key-wrap');
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', wrapKey, nonce);
  cipher.setAAD(Buffer.from('sgk1|wrap', 'utf8'));
  const sealed = Buffer.concat([cipher.update(pairKey), cipher.final(), cipher.getAuthTag()]);
  return `v1:${nonce.toString('base64')}:${sealed.toString('base64')}`;
}

/**
 * 解開資料庫中的 key_wrapped，還原 32-byte 配對金鑰
 * @param {string} keyWrapped
 * @param {string} [serverSecret]
 * @returns {Buffer}
 */
export function unwrapPairKey(keyWrapped, serverSecret = process.env.JWT_SECRET) {
  if (!serverSecret || typeof keyWrapped !== 'string') {
    throw new Error('Cannot unwrap kiosk key');
  }
  const parts = keyWrapped.split(':');
  if (parts.length !== 3 || parts[0] !== 'v1') {
    throw new Error('Unsupported wrapped kiosk key format');
  }
  const nonce = Buffer.from(parts[1], 'base64');
  const ct = Buffer.from(parts[2], 'base64');
  if (nonce.length !== 12 || ct.length < 32 + 16) {
    throw new Error('Malformed wrapped kiosk key');
  }
  const wrapKey = hmac(serverSecret, 'kiosk-key-wrap');
  const decipher = crypto.createDecipheriv('aes-256-gcm', wrapKey, nonce);
  decipher.setAAD(Buffer.from('sgk1|wrap', 'utf8'));
  decipher.setAuthTag(ct.subarray(ct.length - 16));
  const plain = Buffer.concat([decipher.update(ct.subarray(0, ct.length - 16)), decipher.final()]);
  if (plain.length !== 32) {
    throw new Error('Invalid unwrapped kiosk key length');
  }
  return plain;
}

/** 報到機：封裝請求信封，回傳 { httpBody, rid } */
export function sealRequest(keys, deviceId, op, body, { rid = crypto.randomBytes(16).toString('hex'), ts = Math.floor(Date.now() / 1000), nonce } = {}) {
  const env = seal(keys.req, `sgk1|req|${op}|${deviceId}`, JSON.stringify({ rid, ts, body }), nonce);
  return { httpBody: { v: 1, d: deviceId, ...env }, rid };
}

/** 伺服器：解開請求信封 */
export function openRequest(keys, op, httpBody) {
  if (!httpBody || httpBody.v !== 1) throw new Error('bad version');
  const p = JSON.parse(open(keys.req, `sgk1|req|${op}|${httpBody.d}`, httpBody.n, httpBody.c));
  if (typeof p.rid !== 'string' || !/^[0-9a-f]{32}$/.test(p.rid) || !Number.isInteger(p.ts)) {
    throw new Error('bad payload');
  }
  return p;
}

/** 伺服器：封裝回應信封，綁定該次請求的 rid */
export function sealResponse(keys, deviceId, op, rid, { ok = true, code = 'OK', body = {} } = {}, { ts = Math.floor(Date.now() / 1000), nonce } = {}) {
  const env = seal(keys.res, `sgk1|res|${op}|${deviceId}|${rid}`, JSON.stringify({ rid, ts, ok, code, body }), nonce);
  return { v: 1, ...env };
}

/** 報到機：解開回應信封並檢查 rid 是否一致 */
export function openResponse(keys, deviceId, op, rid, httpBody) {
  if (!httpBody || httpBody.v !== 1) throw new Error('bad version');
  const p = JSON.parse(open(keys.res, `sgk1|res|${op}|${deviceId}|${rid}`, httpBody.n, httpBody.c));
  if (p.rid !== rid) throw new Error('rid mismatch');
  return p;
}

// ---- 動態進場條碼（SG1） ----
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32(buf) {
  let bits = 0;
  let val = 0;
  let out = '';
  for (const byte of buf) {
    val = (val << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(val >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(val << (5 - bits)) & 31];
  return out;
}

export const QR_WINDOW_SECONDS = 300;
export const qrKeyFrom = (serverSecret = process.env.JWT_SECRET) => hmac(serverSecret, 'sgqr1-key');
export const entryCodeOf = (bookingRef) => String(bookingRef).replace(/-/g, '').slice(0, 10).toUpperCase();
/** 進場碼開頭對應的 booking_ref 前綴（查資料庫用）：3F2A9C1E7B -> 3f2a9c1e-7b */
export const bookingRefPrefix = (entry) => `${entry.slice(0, 8)}-${entry.slice(8)}`.toLowerCase();

export function qrCodeFor(qrKey, bookingRef, unixSeconds = Math.floor(Date.now() / 1000)) {
  const win = Math.floor(unixSeconds / QR_WINDOW_SECONDS);
  const mac = base32(hmac(qrKey, `${bookingRef}|${win}`).subarray(0, 5));
  return {
    code: `SG1-${entryCodeOf(bookingRef)}-${mac}`,
    expires_at: (win + 1) * QR_WINDOW_SECONDS
  };
}

export function parseQr(text) {
  const m = /^SG1-([0-9A-F]{10})-([A-Z2-7]{8})$/.exec(String(text || '').trim().toUpperCase());
  return m ? { entry: m[1], mac: m[2] } : null;
}

/** 伺服器：接受目前與前一個時段，回傳 'ok' | 'expired' */
export function verifyQrMac(qrKey, bookingRef, mac, unixSeconds = Math.floor(Date.now() / 1000)) {
  const win = Math.floor(unixSeconds / QR_WINDOW_SECONDS);
  for (const w of [win, win - 1]) {
    const expect = base32(hmac(qrKey, `${bookingRef}|${w}`).subarray(0, 5));
    if (expect.length === mac.length && crypto.timingSafeEqual(Buffer.from(expect), Buffer.from(mac))) {
      return 'ok';
    }
  }
  return 'expired';
}

// ---- 配對字串 ----
export const pairingString = (baseUrl, deviceId, pairKey) =>
  `SGPAIR1|${String(baseUrl).replace(/\/+$/, '')}|${deviceId}|${pairKey.toString('base64url')}`;

export function parsePairing(text) {
  const p = String(text || '').trim().split('|');
  if (p.length !== 4 || p[0] !== 'SGPAIR1') return null;
  const key = Buffer.from(p[3], 'base64url');
  const id = Number(p[2]);
  if (key.length !== 32 || !Number.isInteger(id) || id < 1 || !/^https?:\/\//.test(p[1])) return null;
  return { baseUrl: p[1].replace(/\/+$/, ''), deviceId: id, pairKey: key };
}
