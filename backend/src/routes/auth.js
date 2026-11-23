import express from 'express';
import {
  lineCallback,
  register,
  adminLogin,
  getAdminLockStatusHandler,
  adminUnlockHandler,
  getAdminGuardHandler,
  setupAdminTotpHandler,
  confirmAdminTotpHandler,
  regenerateBackupCodesHandler,
  disableAdminTotpHandler,
  logout,
  me
} from '../controllers/authController.js';
import { verifyToken, generateToken, requireSuperAdmin } from '../middlewares/authMiddleware.js';
import { lineCallbackLimiter, registerLimiter } from '../middlewares/rateLimiter.js';

const router = express.Router();

router.post('/line/callback', lineCallbackLimiter, lineCallback);
router.post('/register', verifyToken, registerLimiter, register);
router.get('/admin/lock-status', getAdminLockStatusHandler);
router.post('/admin/unlock', adminUnlockHandler);
router.get('/admin/guard', verifyToken, requireSuperAdmin, getAdminGuardHandler);
router.post('/admin/guard/totp/setup', verifyToken, requireSuperAdmin, setupAdminTotpHandler);
router.post('/admin/guard/totp/confirm', verifyToken, requireSuperAdmin, confirmAdminTotpHandler);
router.post('/admin/guard/backup-codes/regenerate', verifyToken, requireSuperAdmin, regenerateBackupCodesHandler);
router.post('/admin/guard/totp/disable', verifyToken, requireSuperAdmin, disableAdminTotpHandler);
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
