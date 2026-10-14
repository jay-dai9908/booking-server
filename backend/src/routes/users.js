import express from 'express';
import { getUsers, getUserById, getUserReservations, updateUser } from '../controllers/userController.js';
import { verifyToken, requirePermission } from '../middlewares/authMiddleware.js';

const router = express.Router();

router.use(verifyToken, requirePermission('members'));

router.get('/', getUsers);
router.get('/:id', getUserById);
router.get('/:id/reservations', getUserReservations);
router.put('/:id', updateUser);

export default router;

