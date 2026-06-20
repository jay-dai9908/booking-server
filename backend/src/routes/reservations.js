import express from 'express';
import { createReservation, getAdminReservations, getAdminReservationDetails, getMyReservations, cancelReservation, adminCreateReservation, updateAttendance, deleteReservationRecord, moveSeat, swapSeats, getSessionSeats, extendReservation } from '../controllers/reservationController.js';
import { verifyToken, requireAdmin } from '../middlewares/authMiddleware.js';

const router = express.Router();

router.post('/', verifyToken, createReservation);
router.get('/my', verifyToken, getMyReservations);
router.delete('/:id', verifyToken, cancelReservation);
router.delete('/:id/record', verifyToken, requireAdmin, deleteReservationRecord);
router.get('/admin', verifyToken, requireAdmin, getAdminReservations);
router.get('/admin/:booking_ref/details', verifyToken, requireAdmin, getAdminReservationDetails);
router.post('/admin', verifyToken, requireAdmin, adminCreateReservation);
router.post('/admin/:booking_ref/extend', verifyToken, requireAdmin, extendReservation);
router.patch('/:id/attendance', verifyToken, requireAdmin, updateAttendance);
router.put('/admin/move-seat', verifyToken, requireAdmin, moveSeat);
router.put('/admin/swap-seats', verifyToken, requireAdmin, swapSeats);
router.get('/admin/sessions/:id/seats', verifyToken, requireAdmin, getSessionSeats);

export default router;
