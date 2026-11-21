import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import prisma from '../prismaClient.js';

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET || JWT_SECRET.length < 32) {
  console.error('[FATAL] JWT_SECRET missing or < 32 chars');
  process.exit(1);
}

// Separate HMAC-SHA256 derived signing key so display tokens and user/admin tokens never cross-validate
const DISPLAY_TOKEN_KEY = crypto
  .createHmac('sha256', JWT_SECRET)
  .update('display-token-key')
  .digest('hex');

const DEVICE_CACHE_TTL_MS = 30 * 1000;
const deviceCache = new Map();

export function invalidateDisplayAuthCache(displayId) {
  if (displayId != null) {
    deviceCache.delete(Number(displayId));
  } else {
    deviceCache.clear();
  }
}

export function signDisplayToken(device) {
  return jwt.sign(
    {
      display_id: device.id,
      tv: device.token_version,
      typ: 'display'
    },
    DISPLAY_TOKEN_KEY
  );
}

export function verifyDisplayTokenSignature(token) {
  const decoded = jwt.verify(token, DISPLAY_TOKEN_KEY);
  if (
    !decoded ||
    decoded.typ !== 'display' ||
    !Number.isInteger(decoded.display_id) ||
    !Number.isInteger(decoded.tv)
  ) {
    throw new Error('INVALID_DISPLAY_TOKEN_PAYLOAD');
  }
  return decoded;
}

export async function verifyDisplayDeviceVersion(displayId, tokenVersion) {
  const id = Number(displayId);
  const now = Date.now();
  const cached = deviceCache.get(id);

  if (cached && now < cached.expiresAt) {
    if (cached.tv !== tokenVersion) {
      return { ok: false, device: null };
    }
    return { ok: true, device: { id, name: cached.name, token_version: cached.tv } };
  }

  const device = await prisma.displayDevice.findUnique({
    where: { id },
    select: { id: true, name: true, token_version: true }
  });

  if (!device) {
    deviceCache.delete(id);
    return { ok: false, device: null };
  }

  deviceCache.set(id, {
    tv: device.token_version,
    name: device.name,
    expiresAt: now + DEVICE_CACHE_TTL_MS
  });

  if (device.token_version !== tokenVersion) {
    return { ok: false, device: null };
  }

  return { ok: true, device };
}

export function displayAuth({ allowQuery = false } = {}) {
  return async (req, res, next) => {
    const authHeader = req.headers?.authorization || '';
    const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;
    const queryToken = allowQuery && typeof req.query?.token === 'string' ? req.query.token.trim() : null;
    const token = bearerToken || queryToken;

    if (!token) {
      return res.status(401).json({ error: 'DISPLAY_UNAUTHORIZED' });
    }

    let decoded;
    try {
      decoded = verifyDisplayTokenSignature(token);
    } catch {
      return res.status(401).json({ error: 'DISPLAY_INVALID_TOKEN' });
    }

    try {
      const check = await verifyDisplayDeviceVersion(decoded.display_id, decoded.tv);
      if (!check.ok) {
        return res.status(401).json({ error: 'DISPLAY_LOGGED_OUT' });
      }
      req.displayDevice = check.device;
      return next();
    } catch {
      // Never log req.url or token on error
      return res.status(500).json({ error: 'DISPLAY_AUTH_ERROR' });
    }
  };
}
