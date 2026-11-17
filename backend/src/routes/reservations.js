import express from 'express';
import { createReservation, getAdminReservations, getAdminReservationDetails, getMyReservations, cancelReservation, adminCreateReservation, updateAttendance, deleteReservationRecord, moveSeat, swapSeats, getSessionSeats, extendReservation, updatePaymentStatus, updateAmount, updateReservationNotes, getAdminNavBadges, adminQuickLookup, getReservationEntryPassHandler } from '../controllers/reservationController.js';
import { verifyToken, requireAdmin, requireAnyPermission, requireRegisteredUser } from '../middlewares/authMiddleware.js';

import { modifyBookingEquipment } from '../controllers/equipmentController.js';
import {
  getPrepayOptionsHandler,
  postPrepayQuoteHandler,
  patchRemittanceLast5Handler,
  getAdminPrepaysHandler,
  verifyAdminPrepayHandler,
  mismatchAdminPrepayHandler,
  remindAdminPrepayHandler
} from '../controllers/prepayController.js';
import { prepayQuoteLimiter, entryPassLimiter } from '../middlewares/rateLimiter.js';

const router = express.Router();

const reservationStaffAuth = [verifyToken, requireAnyPermission(['reservations', 'seating', 'weekly'])];
const prepayStaffAuth = [verifyToken, requireAnyPermission(['reservations', 'shop'])];

router.get('/prepay-options', verifyToken, requireRegisteredUser, getPrepayOptionsHandler);
router.post('/prepay-quote', verifyToken, requireRegisteredUser, prepayQuoteLimiter, postPrepayQuoteHandler);
router.patch('/:booking_ref/prepay/remittance', verifyToken, requireRegisteredUser, patchRemittanceLast5Handler);
router.get('/:booking_ref/entry', verifyToken, requireRegisteredUser, entryPassLimiter, getReservationEntryPassHandler);

router.get('/admin/prepays', ...prepayStaffAuth, getAdminPrepaysHandler);
router.post('/admin/prepays/:booking_ref/verify', ...prepayStaffAuth, verifyAdminPrepayHandler);
router.post('/admin/prepays/:booking_ref/mismatch', ...prepayStaffAuth, mismatchAdminPrepayHandler);
router.post('/admin/prepays/:booking_ref/remind', ...prepayStaffAuth, remindAdminPrepayHandler);

router.post('/', verifyToken, requireRegisteredUser, createReservation);
router.get('/my', verifyToken, requireRegisteredUser, getMyReservations);
router.delete('/:id', verifyToken, requireRegisteredUser, cancelReservation);
router.patch('/:booking_ref/notes', verifyToken, requireRegisteredUser, updateReservationNotes);
router.patch('/:booking_ref/equipment', verifyToken, requireRegisteredUser, modifyBookingEquipment);
router.delete('/:id/record', ...reservationStaffAuth, deleteReservationRecord);
router.get('/admin/nav-badges', verifyToken, requireAdmin, getAdminNavBadges);
router.get('/admin/quick-lookup', verifyToken, requireAnyPermission(['reservations', 'seating', 'shop', 'members', 'coupons', 'accounting', 'weekly']), adminQuickLookup);
router.get('/admin', ...reservationStaffAuth, getAdminReservations);
router.get('/admin/:booking_ref/details', ...reservationStaffAuth, getAdminReservationDetails);
router.post('/admin', ...reservationStaffAuth, adminCreateReservation);
router.post('/admin/:booking_ref/extend', ...reservationStaffAuth, extendReservation);
router.patch('/admin/:booking_ref/payment', ...reservationStaffAuth, updatePaymentStatus);
router.patch('/admin/:booking_ref/amount', ...reservationStaffAuth, updateAmount);
router.patch('/:id/attendance', ...reservationStaffAuth, updateAttendance);
router.put('/admin/move-seat', ...reservationStaffAuth, moveSeat);
router.put('/admin/swap-seats', ...reservationStaffAuth, swapSeats);
router.get('/admin/sessions/:id/seats', ...reservationStaffAuth, getSessionSeats);

export default router;


