import express from 'express';
import { lineCallback, register, adminLogin, logout, me } from '../controllers/authController.js';
import { verifyToken, generateToken } from '../middlewares/authMiddleware.js';
import { adminLoginLimiter, lineCallbackLimiter } from '../middlewares/rateLimiter.js';

const router = express.Router();

router.post('/line/callback', lineCallbackLimiter, lineCallback);
router.post('/register', verifyToken, register);
router.post('/admin/login', adminLoginLimiter, adminLogin);
router.post('/logout', logout);
router.get('/me', verifyToken, me);

if (process.env.NODE_ENV !== 'production') {
  router.post('/test-login', (req, res) => {
    const { id = 1, role = 'customer' } = req.body || {};
    const token = generateToken({ id, role });
    res.json({ token });
  });
}

export default router;
