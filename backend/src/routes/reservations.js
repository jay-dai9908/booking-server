import express from 'express';
import { createReservation, getAdminReservations, getMyReservations, cancelReservation, adminCreateReservation, updateAttendance, deleteReservationRecord, moveSeat, getSessionSeats } from '../controllers/reservationController.js';
import { verifyToken, requireAdmin } from '../middlewares/authMiddleware.js';

const router = express.Router();

router.post('/', verifyToken, createReservation);
router.get('/my', verifyToken, getMyReservations);
router.delete('/:id', verifyToken, cancelReservation);
router.delete('/:id/record', verifyToken, requireAdmin, deleteReservationRecord);
router.get('/admin', verifyToken, requireAdmin, getAdminReservations);
router.post('/admin', verifyToken, requireAdmin, adminCreateReservation);
router.patch('/:id/attendance', verifyToken, requireAdmin, updateAttendance);
router.put('/admin/move-seat', verifyToken, requireAdmin, moveSeat);
router.get('/admin/sessions/:id/seats', verifyToken, requireAdmin, getSessionSeats);

export default router;
