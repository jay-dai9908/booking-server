import express from 'express';
import { getSessions, createBulkSessions, deleteSession, deleteSessionsByDate } from '../controllers/sessionController.js';
import { verifyToken, requireAdmin } from '../middlewares/authMiddleware.js';

const router = express.Router();

router.get('/', getSessions);
router.post('/', verifyToken, requireAdmin, createBulkSessions);
router.delete('/date/:date', verifyToken, requireAdmin, deleteSessionsByDate);
router.delete('/:id', verifyToken, requireAdmin, deleteSession);

export default router;
