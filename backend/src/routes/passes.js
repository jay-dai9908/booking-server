import express from 'express';
import {
  grantUserPass,
  redeemUserPass,
  getUserPassesAdmin,
  getAllPassesAdmin,
  getPassesSummaryAdmin,
  getMyPasses,
  getPassPlans,
  getAdminPassPlans,
  togglePassStatus,
  refundUserPassSaleHandler,
  createPassPlan,
  updatePassPlan
} from '../controllers/passController.js';
import { verifyToken, requireAnyPermission, requirePermissionGroup, requireRegisteredUser } from '../middlewares/authMiddleware.js';
import { PASS_GRANT } from '../middlewares/permissionGroups.js';

const router = express.Router();
const checkPassPermission = requireAnyPermission(['members', 'coupons', 'reservations']);

// Public / Common
router.get('/plans', getPassPlans);

// Customer routes
router.get('/my', verifyToken, requireRegisteredUser, getMyPasses);

// Admin routes
router.get('/admin/plans', verifyToken, checkPassPermission, getAdminPassPlans);
router.post('/admin/plans', verifyToken, checkPassPermission, createPassPlan);
router.put('/admin/plans/:id', verifyToken, checkPassPermission, updatePassPlan);
router.post('/admin/grant', verifyToken, requirePermissionGroup(PASS_GRANT), grantUserPass);
router.post('/admin/redeem', verifyToken, checkPassPermission, redeemUserPass);
router.get('/admin/all', verifyToken, checkPassPermission, getAllPassesAdmin);
router.get('/admin/summary', verifyToken, checkPassPermission, getPassesSummaryAdmin);
router.get('/admin/user/:userId', verifyToken, checkPassPermission, getUserPassesAdmin);
router.patch('/admin/:id/status', verifyToken, checkPassPermission, togglePassStatus);
router.post('/admin/:id/refund', verifyToken, checkPassPermission, refundUserPassSaleHandler);

export default router;
