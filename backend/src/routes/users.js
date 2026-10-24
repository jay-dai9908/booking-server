import express from 'express';
import {
  getUsers,
  getUserById,
  getUserReservations,
  getUserLoginLogs,
  updateUser,
  sendLineMessageToUser
} from '../controllers/userController.js';
import { verifyToken, requirePermission, requireAnyPermission } from '../middlewares/authMiddleware.js';

const router = express.Router();

router.use(verifyToken);

// Sending LINE message can be performed by staff with either 'members' or 'reservations' permission
router.post('/:id/line-message', requireAnyPermission(['members', 'reservations']), sendLineMessageToUser);

// All other member management routes require 'members' permission
router.use(requirePermission('members'));

router.get('/', getUsers);
router.get('/:id', getUserById);
router.get('/:id/reservations', getUserReservations);
router.get('/:id/login-logs', getUserLoginLogs);
router.put('/:id', updateUser);

export default router;

