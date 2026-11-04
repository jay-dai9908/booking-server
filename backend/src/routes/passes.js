import express from 'express';
import {
  grantUserPass,
  redeemUserPass,
  getUserPassesAdmin,
  getMyPasses,
  getPassPlans,
  togglePassStatus,
  createPassPlan,
  updatePassPlan
} from '../controllers/passController.js';
import { verifyToken, requireAnyPermission, requireRegisteredUser } from '../middlewares/authMiddleware.js';

const router = express.Router();
const checkPassPermission = requireAnyPermission(['members', 'coupons', 'reservations']);

// Public / Common
router.get('/plans', getPassPlans);

// Customer routes
router.get('/my', verifyToken, requireRegisteredUser, getMyPasses);

// Admin routes
router.get('/admin/plans', verifyToken, checkPassPermission, getPassPlans);
router.post('/admin/plans', verifyToken, checkPassPermission, createPassPlan);
router.put('/admin/plans/:id', verifyToken, checkPassPermission, updatePassPlan);
router.post('/admin/grant', verifyToken, checkPassPermission, grantUserPass);
router.post('/admin/redeem', verifyToken, checkPassPermission, redeemUserPass);
router.get('/admin/user/:userId', verifyToken, checkPassPermission, getUserPassesAdmin);
router.patch('/admin/:id/status', verifyToken, checkPassPermission, togglePassStatus);

export default router;
