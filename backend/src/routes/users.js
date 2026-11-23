import express from 'express';
import {
  getUsers,
  getUserById,
  getUserReservations,
  getUserLoginLogs,
  updateUser,
  sendLineMessageToUser,
  getBindRequests,
  getUserBindRequests,
  approveBindRequest,
  rejectBindRequest
} from '../controllers/userController.js';
import { verifyToken, requirePermission, requireAnyPermission } from '../middlewares/authMiddleware.js';

const router = express.Router();

router.use(verifyToken);

// Sending LINE message can be performed by staff with either 'members' or 'reservations' permission
router.post('/:id/line-message', requireAnyPermission(['members', 'reservations']), sendLineMessageToUser);

// All other member management routes require 'members' permission
router.use(requirePermission('members'));

router.get('/', getUsers);
router.get('/bind-requests', getBindRequests);
router.post('/bind-requests/:id/approve', approveBindRequest);
router.post('/bind-requests/:id/reject', rejectBindRequest);
router.get('/:id', getUserById);
router.get('/:id/bind-requests', getUserBindRequests);
router.get('/:id/reservations', getUserReservations);
router.get('/:id/login-logs', getUserLoginLogs);
router.put('/:id', updateUser);

export default router;

