import prisma from '../prismaClient.js';
import { getClientIp } from '../utils/deviceParser.js';
import { unwrapPairKey, deriveKeys, openRequest, sealResponse } from '../services/kiosk/sgk1.js';

const AUTH_FAIL_WINDOW_MS = 10 * 60 * 1000;
const AUTH_FAIL_MAX = 10;
const DEVICE_RATE_WINDOW_MS = 60 * 1000;
const DEVICE_RATE_MAX = 60;
const REPLAY_TTL_MS = 10 * 60 * 1000;
const MAX_BODY_BYTES = 16 * 1024;

// 單一行程記憶體保留 10 分鐘已用過的 rid（key: `${deviceId}:${rid}` -> expiresAtMs）；若日後擴展為多行程或叢集部署，需改存資料庫或 Redis。
const seenRids = new Map();
const authFailuresByIp = new Map();
const deviceRequestRates = new Map();

function isIpAuthLimited(ip, nowMs) {
  const entry = authFailuresByIp.get(ip);
  if (!entry) return false;
  if (nowMs > entry.resetAt) {
    authFailuresByIp.delete(ip);
    return false;
  }
  return entry.count >= AUTH_FAIL_MAX;
}

function recordAuthFailure(ip, nowMs) {
  const entry = authFailuresByIp.get(ip);
  if (!entry || nowMs > entry.resetAt) {
    authFailuresByIp.set(ip, { count: 1, resetAt: nowMs + AUTH_FAIL_WINDOW_MS });
  } else {
    entry.count += 1;
  }
}

function isDeviceRateLimited(deviceId, nowMs) {
  const entry = deviceRequestRates.get(deviceId);
  if (!entry || nowMs > entry.resetAt) {
    deviceRequestRates.set(deviceId, { count: 1, resetAt: nowMs + DEVICE_RATE_WINDOW_MS });
    return false;
  }
  entry.count += 1;
  return entry.count > DEVICE_RATE_MAX;
}

function pruneExpiredRids(nowMs) {
  if (seenRids.size < 500) return;
  for (const [k, exp] of seenRids.entries()) {
    if (exp <= nowMs) seenRids.delete(k);
  }
}

/** 僅供單元測試重置記憶體計數器使用 */
export function resetKioskEnvelopeStateForTest() {
  seenRids.clear();
  authFailuresByIp.clear();
  deviceRequestRates.clear();
}

/**
 * 報到機 SGK1 加密信封驗證中介層（依協定第 3 節檢查順序）
 * @param {'sync'|'access'} op
 * @param {object} [options]
 */
export function createKioskEnvelope(op, options = {}) {
  const getNow = options.getNow || (() => Date.now());
  const db = options.prisma || prisma;

  return async function kioskEnvelopeMiddleware(req, res, next) {
    const nowMs = getNow();
    const clientIp = getClientIp(req);

    if (isIpAuthLimited(clientIp, nowMs)) {
      return res.status(429).json({ error: 'TOO_MANY_REQUESTS' });
    }

    const body = req.body;
    if (!body || typeof body !== 'object') {
      recordAuthFailure(clientIp, nowMs);
      return res.status(401).json({ error: 'KIOSK_AUTH' });
    }

    if (Buffer.byteLength(JSON.stringify(body), 'utf8') > MAX_BODY_BYTES) {
      return res.status(413).json({ error: 'PAYLOAD_TOO_LARGE' });
    }

    const deviceId = Number(body.d);
    if (body.v !== 1 || !Number.isInteger(deviceId) || deviceId < 1 || typeof body.n !== 'string' || typeof body.c !== 'string') {
      recordAuthFailure(clientIp, nowMs);
      return res.status(401).json({ error: 'KIOSK_AUTH' });
    }

    let device;
    let keys;
    let plaintext;

    try {
      device = await db.kioskDevice.findUnique({ where: { id: deviceId } });
      if (!device || !device.is_active) {
        recordAuthFailure(clientIp, nowMs);
        return res.status(401).json({ error: 'KIOSK_AUTH' });
      }

      const pairKey = unwrapPairKey(device.key_wrapped, options.jwtSecret || process.env.JWT_SECRET);
      keys = deriveKeys(pairKey);
      plaintext = openRequest(keys, op, body);
    } catch {
      recordAuthFailure(clientIp, nowMs);
      return res.status(401).json({ error: 'KIOSK_AUTH' });
    }

    if (isDeviceRateLimited(device.id, nowMs)) {
      return res.status(429).json({ error: 'TOO_MANY_REQUESTS' });
    }

    const replyFn = ({ ok = true, code = 'OK', body: replyBody = {} } = {}) => {
      const serverTs = Math.floor(getNow() / 1000);
      const sealed = sealResponse(keys, device.id, op, plaintext.rid, { ok, code, body: replyBody }, { ts: serverTs });
      return res.status(200).json(sealed);
    };

    const serverNowSec = Math.floor(nowMs / 1000);
    if (Math.abs(plaintext.ts - serverNowSec) > 120) {
      return replyFn({ ok: false, code: 'CLOCK_SKEW', body: {} });
    }

    pruneExpiredRids(nowMs);
    const replayKey = `${device.id}:${plaintext.rid}`;
    const existingExp = seenRids.get(replayKey);
    if (existingExp && existingExp > nowMs) {
      return replyFn({ ok: false, code: 'REPLAY', body: {} });
    }
    seenRids.set(replayKey, nowMs + REPLAY_TTL_MS);

    req.kiosk = {
      device,
      keys,
      rid: plaintext.rid,
      ts: plaintext.ts,
      body: plaintext.body || {},
      clientIp
    };
    res.kioskReply = replyFn;

    next();
  };
}

export const kioskEnvelope = (op) => createKioskEnvelope(op);
