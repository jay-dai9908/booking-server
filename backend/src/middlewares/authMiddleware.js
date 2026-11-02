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
  return crypto.createHmac('sha256', JWT_SECRET).update(envAdminPassword).digest('hex').slice(0, 16);
};

export const generateToken = (payload, options = {}) => {
  const expiresIn = options.expiresIn || '7d';
  return jwt.sign(payload, JWT_SECRET, { expiresIn });
};

/**
 * 驗證並同步當前管理員 (Super Admin 或 Staff) 資料庫最新狀態
 */
export const syncAndVerifyAdminUser = async (user) => {
  if (!user || user.role !== 'admin') return null;

  // 若已經完成驗證，直接回傳避免重複查詢資料庫
  if (user.isVerifiedAdmin) {
    return user;
  }

  // 1. 最高管理員 (無 staff id，需驗證以 HMAC-SHA256 產生的指紋)
  if (user.isSuperAdmin && !user.id) {
    const currentFp = getSuperAdminFingerprint();
    if (!currentFp || !user.pwd_hash) {
      return null;
    }
    const bufA = Buffer.from(user.pwd_hash, 'utf8');
    const bufB = Buffer.from(currentFp, 'utf8');
    if (bufA.length !== bufB.length || !crypto.timingSafeEqual(bufA, bufB)) {
      return null; // 密碼已被更換或指紋不符，舊 Token 即刻失效
    }
    return {
      role: 'admin',
      isSuperAdmin: true,
      name: user.name || '最高管理員',
      permissions: ['all'],
      isVerifiedAdmin: true
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
      token_version: staff.token_version,
      isVerifiedAdmin: true
    };
  }

  return null;
};

export const verifyToken = async (req, res, next) => {
  const authHeader = req.headers?.authorization || '';
  const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;
  const token = req.cookies?.token || bearerToken;
  if (!token) {
    return res.status(401).json({ error: '登入時效已過或尚未登入，請重新登入' });
  }
  try {
    const decoded = jwt.verify(token, JWT_SECRET);

    // 若 token 為管理員角色，即刻回資料庫或比對指紋驗證最新狀態
    if (decoded.role === 'admin') {
      const verifiedAdmin = await syncAndVerifyAdminUser(decoded);
      if (!verifiedAdmin) {
        res.clearCookie('token');
        return res.status(401).json({ error: '登入憑證已失效或帳號已被停用，請重新登入' });
      }
      req.user = verifiedAdmin;
      return next();
    }

    req.user = decoded; // { id, role, isTemp, ... }
    next();
  } catch (error) {
    res.clearCookie('token');
    return res.status(401).json({ error: '登入憑證已過期，請重新登入' });
  }
};

/**
 * 顧客專屬 API 驗證：必須是已註冊完成的正式會員（正整數 id，且非 isTemp），已驗證管理員一律放行
 */
export const requireRegisteredUser = (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({ error: '尚未登入，請先登入' });
  }
  if (req.user.isVerifiedAdmin || req.user.role === 'admin') {
    return next();
  }
  if (req.user.isTemp === true || !Number.isInteger(req.user.id) || req.user.id <= 0) {
    return res.status(401).json({ error: '尚未完成會員註冊或身分無效，請先完成註冊' });
  }
  next();
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


