import express from 'express';
import { createReservation, getAdminReservations, getMyReservations, cancelReservation, adminCreateReservation, updateAttendance } from '../controllers/reservationController.js';
import { verifyToken, requireAdmin } from '../middlewares/authMiddleware.js';

const router = express.Router();

router.post('/', verifyToken, createReservation);
router.get('/my', verifyToken, getMyReservations);
router.delete('/:id', verifyToken, cancelReservation);
router.get('/admin', verifyToken, requireAdmin, getAdminReservations);
router.post('/admin', verifyToken, requireAdmin, adminCreateReservation);
router.patch('/:id/attendance', verifyToken, requireAdmin, updateAttendance);

export default router;
