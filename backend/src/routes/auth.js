import express from 'express';
import { lineCallback, register, adminLogin, logout, me } from '../controllers/authController.js';
import { verifyToken } from '../middlewares/authMiddleware.js';

const router = express.Router();

router.post('/line/callback', lineCallback);
router.post('/register', verifyToken, register);
router.post('/admin/login', adminLogin);
router.post('/logout', logout);
router.get('/me', verifyToken, me);

export default router;
