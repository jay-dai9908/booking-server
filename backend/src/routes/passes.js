import express from 'express';
import {
  grantUserPass,
  redeemUserPass,
  getUserPassesAdmin,
  getMyPasses,
  getPassPlans,
  togglePassStatus
} from '../controllers/passController.js';
import { verifyToken, requireAnyPermission } from '../middlewares/authMiddleware.js';

const router = express.Router();
const checkPassPermission = requireAnyPermission(['members', 'coupons', 'reservations']);

// Public / Common
router.get('/plans', getPassPlans);

// Customer routes
router.get('/my', verifyToken, getMyPasses);

// Admin routes
router.post('/admin/grant', verifyToken, checkPassPermission, grantUserPass);
router.post('/admin/redeem', verifyToken, checkPassPermission, redeemUserPass);
router.get('/admin/user/:userId', verifyToken, checkPassPermission, getUserPassesAdmin);
router.patch('/admin/:id/status', verifyToken, checkPassPermission, togglePassStatus);

export default router;
