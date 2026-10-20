import jwt from 'jsonwebtoken';
import prisma from '../prismaClient.js';

const JWT_SECRET = process.env.JWT_SECRET || 'fallback_secret_for_development';

export const generateToken = (payload) => {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '7d' });
};

export const verifyToken = (req, res, next) => {
  const token = req.cookies.token;
  if (!token) {
    return res.status(401).json({ error: 'Unauthorized. No token provided.' });
  }
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded; // { id, role, isTemp, ... }
    next();
  } catch (error) {
    return res.status(401).json({ error: 'Invalid or expired token.' });
  }
};

export const requireAdmin = async (req, res, next) => {
  if (req.user && req.user.role === 'admin') {
    next();
  } else {
    return res.status(403).json({ error: 'Forbidden. Admin access required.' });
  }
};

const isLegacyOrSuperAdmin = (user) => {
  if (!user || user.role !== 'admin') return false;
  if (user.isSuperAdmin) return true;
  if (Array.isArray(user.permissions) && user.permissions.includes('all')) return true;
  if (!user.id && user.isSuperAdmin === undefined && !user.permissions) return true;
  return false;
};

export const requireSuperAdmin = async (req, res, next) => {
  if (isLegacyOrSuperAdmin(req.user)) {
    next();
  } else {
    return res.status(403).json({ error: 'Forbidden. Super admin access required.' });
  }
};

export const requirePermission = (permission) => {
  return (req, res, next) => {
    if (req.user && req.user.role === 'admin') {
      if (isLegacyOrSuperAdmin(req.user) || (Array.isArray(req.user.permissions) && req.user.permissions.includes(permission))) {
        return next();
      }
      return res.status(403).json({ error: '無此功能存取權限' });
    }
    return res.status(403).json({ error: 'Forbidden. Admin access required.' });
  };
};

export const requireAnyPermission = (permissions) => {
  return (req, res, next) => {
    if (req.user && req.user.role === 'admin') {
      if (isLegacyOrSuperAdmin(req.user)) return next();
      if (Array.isArray(req.user.permissions)) {
        const hasAny = permissions.some(p => req.user.permissions.includes(p));
        if (hasAny) return next();
      }
      return res.status(403).json({ error: '無此功能存取權限' });
    }
    return res.status(403).json({ error: 'Forbidden. Admin access required.' });
  };
};


