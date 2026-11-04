import crypto from 'crypto';
import prisma from '../prismaClient.js';
import { getClientIp } from '../utils/deviceParser.js';

// In-memory rate limiting for station auth failures (10 failures per 10 mins per IP)
const authFailuresByIp = new Map();

function isRateLimited(ip) {
  const now = Date.now();
  const entry = authFailuresByIp.get(ip);
  if (!entry) return false;
  if (now > entry.resetAt) {
    authFailuresByIp.delete(ip);
    return false;
  }
  return entry.count >= 10;
}

function recordFailure(ip) {
  const now = Date.now();
  const entry = authFailuresByIp.get(ip);
  if (!entry || now > entry.resetAt) {
    authFailuresByIp.set(ip, { count: 1, resetAt: now + 10 * 60 * 1000 });
  } else {
    entry.count += 1;
  }
}

/**
 * Middleware verifying PrintStation credentials (spec 5.7 & 7.2)
 * Authorization: Station <station_id>.<secret>
 */
export async function verifyPrintStation(req, res, next) {
  const clientIp = getClientIp(req);
  if (isRateLimited(clientIp)) {
    return res.status(429).json({ error: '認證失敗次數過多，請稍後再試' });
  }

  const authHeader = req.headers.authorization || '';
  if (!authHeader.startsWith('Station ')) {
    recordFailure(clientIp);
    return res.status(401).json({ error: '缺少列印站憑證' });
  }

  const token = authHeader.slice(8).trim();
  const dotIndex = token.indexOf('.');
  if (dotIndex === -1) {
    recordFailure(clientIp);
    return res.status(401).json({ error: '無效的憑證格式' });
  }

  const stationId = parseInt(token.slice(0, dotIndex), 10);
  const secret = token.slice(dotIndex + 1);

  if (!stationId || !secret) {
    recordFailure(clientIp);
    return res.status(401).json({ error: '無效的憑證資訊' });
  }

  try {
    const station = await prisma.printStation.findUnique({
      where: { id: stationId }
    });

    if (!station || !station.is_active) {
      recordFailure(clientIp);
      return res.status(401).json({ error: '列印站不存在或已停用' });
    }

    const calculatedHash = crypto.createHash('sha256').update(secret).digest('hex');
    const bufA = Buffer.from(calculatedHash, 'utf8');
    const bufB = Buffer.from(station.secret_hash, 'utf8');

    if (bufA.length !== bufB.length || !crypto.timingSafeEqual(bufA, bufB)) {
      recordFailure(clientIp);
      return res.status(401).json({ error: '金鑰驗證失敗' });
    }

    req.printStation = station;
    next();
  } catch (error) {
    console.error('[verifyPrintStation] Error:', error);
    return res.status(500).json({ error: '驗證伺服器錯誤' });
  }
}

export default verifyPrintStation;
