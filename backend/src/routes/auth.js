import express from 'express';
import { lineCallback, register, adminLogin, getAdminLockStatusHandler, adminUnlockHandler, logout, me } from '../controllers/authController.js';
import { verifyToken, generateToken } from '../middlewares/authMiddleware.js';
import { lineCallbackLimiter, registerLimiter } from '../middlewares/rateLimiter.js';

const router = express.Router();

router.post('/line/callback', lineCallbackLimiter, lineCallback);
router.post('/register', verifyToken, registerLimiter, register);
router.get('/admin/lock-status', getAdminLockStatusHandler);
router.post('/admin/unlock', adminUnlockHandler);
router.post('/admin/login', adminLogin);
router.post('/logout', logout);
router.get('/me', verifyToken, me);

if (process.env.NODE_ENV === 'test') {
  router.post('/test-login', (req, res) => {
    const { id = 1, role = 'customer' } = req.body || {};
    const payload = role === 'customer' ? { id, role, typ: 'customer' } : { id, role };
    const token = generateToken(payload);
    res.json({ token });
  });
}

export default router;
