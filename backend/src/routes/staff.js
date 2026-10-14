import express from 'express';
import { getStaffs, createStaff, updateStaff, deleteStaff } from '../controllers/staffController.js';
import { verifyToken, requireSuperAdmin } from '../middlewares/authMiddleware.js';

const router = express.Router();

router.use(verifyToken, requireSuperAdmin);

router.get('/', getStaffs);
router.post('/', createStaff);
router.put('/:id', updateStaff);
router.delete('/:id', deleteStaff);

export default router;
