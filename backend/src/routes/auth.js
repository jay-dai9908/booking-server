import express from 'express';
import { lineCallback, register, adminLogin, logout, me } from '../controllers/authController.js';
import { verifyToken } from '../middlewares/authMiddleware.js';
import { rateLimiter } from '../middlewares/rateLimiter.js';

const router = express.Router();

const loginLimiter = rateLimiter({ windowMs: 3 * 60 * 1000, max: 3, reason: 'Too many login attempts' });

router.post('/line/callback', loginLimiter, lineCallback);
router.post('/register', verifyToken, register);
router.post('/admin/login', loginLimiter, adminLogin);
router.post('/logout', logout);
router.get('/me', verifyToken, me);

export default router;
