import express from 'express';
import { verifyToken, requireAnyPermission, requirePermissionGroup } from '../middlewares/authMiddleware.js';
import { MONEY_WRITE } from '../middlewares/permissionGroups.js';
import {
  getBillingDetails,
  putDraft,
  postCollect,
  postSupplement,
  postRefund,
  postWaive,
  postVoid,
  postMarkUnpaid,
  getMemberPasses
} from '../controllers/billingController.js';

const router = express.Router();
const checkoutStaffAuth = [
  verifyToken,
  requireAnyPermission(['reservations', 'seating', 'weekly', 'accounting', 'equipment', 'coupons'])
];

router.get('/:booking_ref', ...checkoutStaffAuth, getBillingDetails);
router.put('/:booking_ref/draft', ...checkoutStaffAuth, putDraft);
router.post('/:booking_ref/collect', ...checkoutStaffAuth, postCollect);
router.post('/:booking_ref/supplement', ...checkoutStaffAuth, postSupplement);
router.post('/:booking_ref/refund', verifyToken, requirePermissionGroup(MONEY_WRITE), postRefund);
router.post('/:booking_ref/waive', verifyToken, requirePermissionGroup(MONEY_WRITE), postWaive);
router.post('/payments/:id/void', verifyToken, requirePermissionGroup(MONEY_WRITE), postVoid);
router.post('/:booking_ref/mark-unpaid', verifyToken, requirePermissionGroup(MONEY_WRITE), postMarkUnpaid);
router.get('/:booking_ref/passes', ...checkoutStaffAuth, getMemberPasses);

export default router;
