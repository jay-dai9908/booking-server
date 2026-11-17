import express from 'express';
import { getKioskSettings, updateKioskSettings } from '../controllers/kioskSettingController.js';
import { verifyToken, requireAnyPermission } from '../middlewares/authMiddleware.js';

const router = express.Router();

router.get('/settings', verifyToken, requireAnyPermission(['settings', 'sessions']), getKioskSettings);
router.put('/settings', verifyToken, requireAnyPermission(['settings', 'sessions']), updateKioskSettings);

export default router;
