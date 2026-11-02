import express from 'express';
import { createReservation, getAdminReservations, getAdminReservationDetails, getMyReservations, cancelReservation, adminCreateReservation, updateAttendance, deleteReservationRecord, moveSeat, swapSeats, getSessionSeats, extendReservation, updatePaymentStatus, updateAmount, updateReservationNotes, getAdminNavBadges, adminQuickLookup } from '../controllers/reservationController.js';
import { verifyToken, requireAdmin, requireAnyPermission, requireRegisteredUser } from '../middlewares/authMiddleware.js';

import { modifyBookingEquipment } from '../controllers/equipmentController.js';

const router = express.Router();

const reservationStaffAuth = [verifyToken, requireAnyPermission(['reservations', 'seating', 'weekly'])];

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


