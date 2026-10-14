import express from 'express';
import { getSessions, createBulkSessions, deleteSession, deleteSessionsByDate } from '../controllers/sessionController.js';
import { verifyToken, requirePermission } from '../middlewares/authMiddleware.js';

const router = express.Router();

router.get('/', getSessions);
router.post('/', verifyToken, requirePermission('sessions'), createBulkSessions);
router.delete('/date/:date', verifyToken, requirePermission('sessions'), deleteSessionsByDate);
router.delete('/:id', verifyToken, requirePermission('sessions'), deleteSession);

export default router;

