import express from 'express';
import { createReservation, getAdminReservations, getAdminReservationDetails, getMyReservations, cancelReservation, adminCreateReservation, updateAttendance, deleteReservationRecord, moveSeat, swapSeats, getSessionSeats, extendReservation, updatePaymentStatus, updateAmount } from '../controllers/reservationController.js';
import { verifyToken, requireAnyPermission } from '../middlewares/authMiddleware.js';
import { rateLimiter } from '../middlewares/rateLimiter.js';

import { modifyBookingEquipment } from '../controllers/equipmentController.js';

const router = express.Router();

const queryLimiter = rateLimiter({ windowMs: 3 * 60 * 1000, max: 15, reason: 'Too many reservation queries' });

const reservationStaffAuth = [verifyToken, requireAnyPermission(['reservations', 'seating', 'weekly'])];

router.post('/', verifyToken, createReservation);
router.get('/my', queryLimiter, verifyToken, getMyReservations);
router.delete('/:id', verifyToken, cancelReservation);
router.patch('/:booking_ref/equipment', verifyToken, modifyBookingEquipment);
router.delete('/:id/record', ...reservationStaffAuth, deleteReservationRecord);
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


