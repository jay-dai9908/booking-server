import express from 'express';
import { getKioskSettings, updateKioskSettings } from '../controllers/kioskSettingController.js';
import { postKioskSyncHandler, postKioskAccessHandler } from '../controllers/kioskController.js';
import { verifyToken, requireAnyPermission } from '../middlewares/authMiddleware.js';
import { kioskEnvelope } from '../middlewares/kioskEnvelope.js';

const router = express.Router();

// 後台報到機與半自助共用設定
router.get('/settings', verifyToken, requireAnyPermission(['settings', 'sessions']), getKioskSettings);
router.put('/settings', verifyToken, requireAnyPermission(['settings', 'sessions']), updateKioskSettings);

// 報到機 SGK1 v1 加密通訊端點
router.post('/v1/sync', kioskEnvelope('sync'), postKioskSyncHandler);
router.post('/v1/access', kioskEnvelope('access'), postKioskAccessHandler);

export default router;
