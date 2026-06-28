import express from 'express';
import { getUsers, getUserById, getUserReservations, updateUser } from '../controllers/userController.js';
import { verifyToken, requireAdmin } from '../middlewares/authMiddleware.js';

const router = express.Router();

router.get('/', verifyToken, requireAdmin, getUsers);
router.get('/:id', verifyToken, requireAdmin, getUserById);
router.get('/:id/reservations', verifyToken, requireAdmin, getUserReservations);
router.put('/:id', verifyToken, requireAdmin, updateUser);

export default router;
