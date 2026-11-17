import express from 'express';
import { getKioskSettings, updateKioskSettings } from '../controllers/kioskSettingController.js';
import {
  postKioskSyncHandler,
  postKioskAccessHandler,
  getKioskAdminOverviewHandler,
  updateKioskBackupCodeHandler,
  getKioskBackupCodeHandler,
  updateKioskSetupPinHandler,
  getKioskAccessLogsHandler,
  getFloorMapFileHandler
} from '../controllers/kioskController.js';
import { verifyToken, requireAnyPermission } from '../middlewares/authMiddleware.js';
import { kioskEnvelope } from '../middlewares/kioskEnvelope.js';

const router = express.Router();

// 後台報到機與半自助共用設定
router.get('/settings', verifyToken, requireAnyPermission(['settings', 'sessions']), getKioskSettings);
router.put('/settings', verifyToken, requireAnyPermission(['settings', 'sessions']), updateKioskSettings);

// 後台報到機管理端點（權限：settings）
router.get('/admin/overview', verifyToken, requireAnyPermission(['settings']), getKioskAdminOverviewHandler);
router.put('/admin/backup-code', verifyToken, requireAnyPermission(['settings']), updateKioskBackupCodeHandler);
router.get('/admin/backup-code', verifyToken, requireAnyPermission(['settings']), getKioskBackupCodeHandler);
router.put('/admin/setup-pin', verifyToken, requireAnyPermission(['settings']), updateKioskSetupPinHandler);
router.get('/admin/access-logs', verifyToken, requireAnyPermission(['settings']), getKioskAccessLogsHandler);

// 檔案下載（公開，靠檢查碼）
router.get('/files/floor-map/:version.json', getFloorMapFileHandler);

// 報到機 SGK1 v1 加密通訊端點
router.post('/v1/sync', kioskEnvelope('sync'), postKioskSyncHandler);
router.post('/v1/access', kioskEnvelope('access'), postKioskAccessHandler);

export default router;
