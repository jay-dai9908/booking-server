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
    if (req.method === 'GET' || req.method === 'DELETE') {
      try {
        const settings = await prisma.globalSetting.findUnique({ where: { id: 1 } });
        if (settings && settings.is_lockdown_mode) {
          return res.status(403).json({ error: 'SYSTEM LOCKED DOWN DUE TO SECURITY THREAT. Read/Delete access revoked.' });
        }
      } catch (err) {
        console.error('Failed to check lockdown status', err);
      }
    }
    next();
  } else {
    return res.status(403).json({ error: 'Forbidden. Admin access required.' });
  }
};
