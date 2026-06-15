import express from 'express';
import { getUsers, getUserReservations, updateUser } from '../controllers/userController.js';
import { verifyToken, requireAdmin } from '../middlewares/authMiddleware.js';

const router = express.Router();

router.get('/', verifyToken, requireAdmin, getUsers);
router.get('/:id/reservations', verifyToken, requireAdmin, getUserReservations);
router.put('/:id', verifyToken, requireAdmin, updateUser);

export default router;
