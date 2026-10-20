import express from 'express';
import {
  validatePromoCode,
  getPromoCodes,
  createPromoCode,
  updatePromoCode,
  deletePromoCode,
  getAddonItems,
  createAddonItem,
  updateAddonItem,
  deleteAddonItem,
  submitReservationCheckout
} from '../controllers/checkoutController.js';
import { verifyToken, requireAnyPermission } from '../middlewares/authMiddleware.js';

const router = express.Router();

const checkoutStaffAuth = [
  verifyToken,
  requireAnyPermission(['reservations', 'seating', 'weekly', 'accounting', 'equipment', 'coupons'])
];

// Customer + Admin promo code validation
router.post('/promo-codes/validate', verifyToken, validatePromoCode);

// Promo code management & POS quick select
router.get('/promo-codes', ...checkoutStaffAuth, getPromoCodes);
router.post('/promo-codes', ...checkoutStaffAuth, createPromoCode);
router.put('/promo-codes/:id', ...checkoutStaffAuth, updatePromoCode);
router.delete('/promo-codes/:id', ...checkoutStaffAuth, deletePromoCode);

// Addon items (charms, accessories, ironing service)
router.get('/addons', ...checkoutStaffAuth, getAddonItems);
router.post('/addons', ...checkoutStaffAuth, createAddonItem);
router.put('/addons/:id', ...checkoutStaffAuth, updateAddonItem);
router.delete('/addons/:id', ...checkoutStaffAuth, deleteAddonItem);

// Reservation split-billing checkout submission
router.post('/reservations/:booking_ref', ...checkoutStaffAuth, submitReservationCheckout);

export default router;
