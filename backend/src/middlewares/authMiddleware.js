import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import prisma from '../prismaClient.js';

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET || JWT_SECRET.length < 32) {
  console.error('\x1b[31m[FATAL] JWT_SECRET 未設定或長度少於 32 字元！為保障系統資安，伺服器已拒絕啟動。\x1b[0m');
  console.error('\x1b[33m請在 backend/.env 中設定高強度金鑰（例如使用 openssl rand -hex 32 產生）。\x1b[0m');
  process.exit(1);
}

export const getSuperAdminFingerprint = () => {
  const envAdminPassword = process.env.ADMIN_PASSWORD
    ? String(process.env.ADMIN_PASSWORD).trim().replace(/^["']|["']$/g, '').replace(/[\r\n]/g, '')
    : '';
  if (!envAdminPassword) return '';
  return crypto.createHash('sha256').update(envAdminPassword).digest('hex').slice(0, 16);
};

export const generateToken = (payload, options = {}) => {
  const expiresIn = options.expiresIn || '7d';
  return jwt.sign(payload, JWT_SECRET, { expiresIn });
};

export const verifyToken = (req, res, next) => {
  const authHeader = req.headers?.authorization || '';
  const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;
  const token = req.cookies?.token || bearerToken;
  if (!token) {
    return res.status(401).json({ error: '登入時效已過或尚未登入，請重新使用 LINE 登入' });
  }
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded; // { id, role, isTemp, token_version, pwd_hash, ... }
    next();
  } catch (error) {
    return res.status(401).json({ error: '登入憑證已過期，請重新登入' });
  }
};

/**
 * 驗證並同步當前管理員 (Super Admin 或 Staff) 資料庫最新狀態
 */
export const syncAndVerifyAdminUser = async (user) => {
  if (!user || user.role !== 'admin') return null;

  // 1. 最高管理員 (無 staff id)
  if (user.isSuperAdmin && !user.id) {
    const currentFp = getSuperAdminFingerprint();
    if (!currentFp || user.pwd_hash !== currentFp) {
      return null; // 密碼已被更改或無指紋，舊 Token 即刻失效
    }
    return {
      role: 'admin',
      isSuperAdmin: true,
      name: user.name || '最高管理員',
      permissions: ['all']
    };
  }

  // 2. 門市員工管理員 (有 staff id，需查驗資料庫 is_active 與 token_version)
  if (user.id) {
    const staff = await prisma.adminUser.findUnique({
      where: { id: user.id }
    });

    if (!staff || !staff.is_active) {
      return null; // 帳號不存在或已被停用
    }

    if (staff.token_version !== user.token_version) {
      return null; // 密碼/權限/狀態變更過，token_version 不符，舊 Token 失效
    }

    const isSuper = staff.role === 'super_admin';
    return {
      id: staff.id,
      role: 'admin',
      isSuperAdmin: isSuper,
      name: staff.name,
      permissions: isSuper ? ['all'] : (staff.permissions || []),
      token_version: staff.token_version
    };
  }

  return null;
};

export const requireAdmin = async (req, res, next) => {
  const verifiedAdmin = await syncAndVerifyAdminUser(req.user);
  if (verifiedAdmin) {
    req.user = verifiedAdmin;
    next();
  } else {
    return res.status(403).json({ error: '權限不足或登入憑證已失效，請重新登入' });
  }
};

export const requireSuperAdmin = async (req, res, next) => {
  const verifiedAdmin = await syncAndVerifyAdminUser(req.user);
  if (verifiedAdmin && (verifiedAdmin.isSuperAdmin || verifiedAdmin.permissions?.includes('all'))) {
    req.user = verifiedAdmin;
    next();
  } else {
    return res.status(403).json({ error: '需要最高管理員權限' });
  }
};

export const requirePermission = (permission) => {
  return async (req, res, next) => {
    const verifiedAdmin = await syncAndVerifyAdminUser(req.user);
    if (!verifiedAdmin) {
      return res.status(403).json({ error: '權限不足或登入憑證已失效，請重新登入' });
    }
    req.user = verifiedAdmin;

    if (verifiedAdmin.isSuperAdmin || verifiedAdmin.permissions?.includes('all') || verifiedAdmin.permissions?.includes(permission)) {
      return next();
    }
    return res.status(403).json({ error: '無此功能存取權限' });
  };
};

export const requireAnyPermission = (permissions) => {
  return async (req, res, next) => {
    const verifiedAdmin = await syncAndVerifyAdminUser(req.user);
    if (!verifiedAdmin) {
      return res.status(403).json({ error: '權限不足或登入憑證已失效，請重新登入' });
    }
    req.user = verifiedAdmin;

    if (verifiedAdmin.isSuperAdmin || verifiedAdmin.permissions?.includes('all')) {
      return next();
    }
    if (Array.isArray(verifiedAdmin.permissions)) {
      const hasAny = permissions.some(p => verifiedAdmin.permissions.includes(p));
      if (hasAny) return next();
    }
    return res.status(403).json({ error: '無此功能存取權限' });
  };
};


