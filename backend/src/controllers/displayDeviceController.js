import bcrypt from 'bcryptjs';
import prisma from '../prismaClient.js';
import { getClientIp } from '../utils/deviceParser.js';
import { signDisplayToken, invalidateDisplayAuthCache } from '../middlewares/displayAuth.js';
import displayBus from '../services/display/displayBus.js';

// In-memory rate limiter for display login: 10 failures within 10 minutes per IP -> 429
const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const MAX_LOGIN_FAILURES = 10;
const loginFailuresByIp = new Map();

const cleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [ip, rec] of loginFailuresByIp.entries()) {
    if (now > rec.resetAt) {
      loginFailuresByIp.delete(ip);
    }
  }
}, 60 * 1000);
if (cleanupTimer.unref) cleanupTimer.unref();

export function clearDisplayLoginFailures() {
  loginFailuresByIp.clear();
}

function isLoginRateLimited(ip) {
  const rec = loginFailuresByIp.get(ip);
  if (!rec) return false;
  if (Date.now() > rec.resetAt) {
    loginFailuresByIp.delete(ip);
    return false;
  }
  return rec.failures >= MAX_LOGIN_FAILURES;
}

function recordLoginFailure(ip) {
  const now = Date.now();
  const rec = loginFailuresByIp.get(ip);
  if (!rec || now > rec.resetAt) {
    loginFailuresByIp.set(ip, { failures: 1, resetAt: now + LOGIN_WINDOW_MS });
  } else {
    rec.failures += 1;
  }
}

function sanitizeDevice(d) {
  if (!d) return null;
  return {
    id: d.id,
    name: d.name,
    token_version: d.token_version,
    last_seen_at: d.last_seen_at,
    last_ip: d.last_ip,
    current_view: d.current_view,
    created_at: d.created_at
  };
}

export async function listPublicDisplayDevices(req, res) {
  try {
    const devices = await prisma.displayDevice.findMany({
      orderBy: { id: 'asc' },
      select: { id: true, name: true }
    });
    return res.json({ devices });
  } catch (err) {
    console.error('[displayDevice] listPublicDisplayDevices error:', err.message);
    return res.status(500).json({ error: '無法取得顯示屏裝置列表' });
  }
}

export async function displayLogin(req, res) {
  const ip = getClientIp(req);
  if (isLoginRateLimited(ip)) {
    return res.status(429).json({ error: '登入失敗次數過多，請 10 分鐘後再試' });
  }

  const { device_id, name, password } = req.body || {};
  if (!password || typeof password !== 'string') {
    return res.status(400).json({ error: '請輸入顯示屏密碼' });
  }

  try {
    let device = null;
    if (device_id !== undefined && device_id !== null && String(device_id).trim() !== '') {
      const numericId = Number(device_id);
      if (Number.isInteger(numericId) && numericId > 0) {
        device = await prisma.displayDevice.findUnique({ where: { id: numericId } });
      } else {
        device = await prisma.displayDevice.findFirst({
          where: { name: String(device_id).trim() },
          orderBy: { id: 'asc' }
        });
      }
    } else if (name && typeof name === 'string' && name.trim()) {
      device = await prisma.displayDevice.findFirst({
        where: { name: name.trim() },
        orderBy: { id: 'asc' }
      });
    } else {
      return res.status(400).json({ error: '請指定顯示屏裝置' });
    }

    if (!device) {
      recordLoginFailure(ip);
      return res.status(401).json({ error: '裝置或密碼錯誤' });
    }

    const ok = await bcrypt.compare(password, device.password_hash);
    if (!ok) {
      recordLoginFailure(ip);
      return res.status(401).json({ error: '裝置或密碼錯誤' });
    }

    loginFailuresByIp.delete(ip);

    const updated = await prisma.displayDevice.update({
      where: { id: device.id },
      data: {
        last_seen_at: new Date(),
        last_ip: ip
      }
    });

    const token = signDisplayToken(updated);
    return res.json({
      token,
      device: {
        id: updated.id,
        name: updated.name
      }
    });
  } catch (err) {
    console.error('[displayDevice] displayLogin error:', err.message);
    return res.status(500).json({ error: '顯示屏登入失敗' });
  }
}

export async function listAdminDevices(req, res) {
  try {
    const devices = await prisma.displayDevice.findMany({
      orderBy: { id: 'asc' },
      select: {
        id: true,
        name: true,
        token_version: true,
        last_seen_at: true,
        last_ip: true,
        current_view: true,
        created_at: true
      }
    });
    return res.json({ devices: devices.map(sanitizeDevice) });
  } catch (err) {
    console.error('[displayDevice] listAdminDevices error:', err.message);
    return res.status(500).json({ error: '無法讀取顯示屏裝置' });
  }
}

export async function createAdminDevice(req, res) {
  const { name, password } = req.body || {};
  const cleanName = typeof name === 'string' ? name.trim() : '';

  if (!cleanName || cleanName.length > 64) {
    return res.status(422).json({ error: '裝置名稱不可為空，且最多 64 字' });
  }
  if (typeof password !== 'string' || password.length < 8) {
    return res.status(422).json({ error: '密碼至少需要 8 碼' });
  }

  try {
    const password_hash = await bcrypt.hash(password, 10);
    const created = await prisma.displayDevice.create({
      data: {
        name: cleanName,
        password_hash,
        token_version: 1
      }
    });
    return res.status(201).json({ device: sanitizeDevice(created) });
  } catch (err) {
    console.error('[displayDevice] createAdminDevice error:', err.message);
    return res.status(500).json({ error: '新增顯示屏裝置失敗' });
  }
}

export async function updateAdminDevicePassword(req, res) {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: '無效的裝置編號' });
  }

  const { password } = req.body || {};
  if (typeof password !== 'string' || password.length < 8) {
    return res.status(422).json({ error: '密碼至少需要 8 碼' });
  }

  try {
    const existing = await prisma.displayDevice.findUnique({ where: { id } });
    if (!existing) {
      return res.status(404).json({ error: '找不到顯示屏裝置' });
    }

    const password_hash = await bcrypt.hash(password, 10);
    const updated = await prisma.displayDevice.update({
      where: { id },
      data: {
        password_hash,
        token_version: { increment: 1 }
      }
    });

    invalidateDisplayAuthCache(id);
    displayBus.deviceLoggedOut(id);

    return res.json({ ok: true, device: sanitizeDevice(updated) });
  } catch (err) {
    console.error('[displayDevice] updateAdminDevicePassword error:', err.message);
    return res.status(500).json({ error: '變更密碼失敗' });
  }
}

export async function logoutAdminDevice(req, res) {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: '無效的裝置編號' });
  }

  try {
    const existing = await prisma.displayDevice.findUnique({ where: { id } });
    if (!existing) {
      return res.status(404).json({ error: '找不到顯示屏裝置' });
    }

    const updated = await prisma.displayDevice.update({
      where: { id },
      data: {
        token_version: { increment: 1 }
      }
    });

    invalidateDisplayAuthCache(id);
    displayBus.deviceLoggedOut(id);

    return res.json({ ok: true, device: sanitizeDevice(updated) });
  } catch (err) {
    console.error('[displayDevice] logoutAdminDevice error:', err.message);
    return res.status(500).json({ error: '登出顯示屏裝置失敗' });
  }
}
