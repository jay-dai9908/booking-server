import express from 'express';
import {
  grantUserPass,
  redeemUserPass,
  getUserPassesAdmin,
  getMyPasses,
  getPassPlans,
  togglePassStatus
} from '../controllers/passController.js';
import { verifyToken, requireAdmin } from '../middlewares/authMiddleware.js';

const router = express.Router();

// Public / Common
router.get('/plans', getPassPlans);

// Customer routes
router.get('/my', verifyToken, getMyPasses);

// Admin routes
router.post('/admin/grant', verifyToken, requireAdmin, grantUserPass);
router.post('/admin/redeem', verifyToken, requireAdmin, redeemUserPass);
router.get('/admin/user/:userId', verifyToken, requireAdmin, getUserPassesAdmin);
router.patch('/admin/:id/status', verifyToken, requireAdmin, togglePassStatus);

export default router;
