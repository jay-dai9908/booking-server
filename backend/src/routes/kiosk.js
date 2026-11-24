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
  getFloorMapFileHandler,
  listSlidesHandler,
  createSlideHandler,
  updateSlideHandler,
  reorderSlidesHandler,
  deleteSlideHandler,
  downloadSlideHandler,
  listFirmwareHandler,
  uploadFirmwareHandler,
  setFirmwareTargetHandler,
  deleteFirmwareHandler,
  downloadFirmwareHandler,
  getAlertRecipientsHandler,
  updateAlertRecipientsHandler,
  sendTestAlertHandler
} from '../controllers/kioskController.js';
import { verifyToken, requireAnyPermission, requirePermissionGroup } from '../middlewares/authMiddleware.js';
import { KIOSK_SETTINGS_WRITE } from '../middlewares/permissionGroups.js';
import { kioskEnvelope } from '../middlewares/kioskEnvelope.js';

const router = express.Router();

// 後台報到機與半自助共用設定
router.get('/settings', verifyToken, requireAnyPermission(['settings', 'sessions']), getKioskSettings);
router.put('/settings', verifyToken, requirePermissionGroup(KIOSK_SETTINGS_WRITE), updateKioskSettings);

// 後台報到機管理端點（權限：settings）
router.get('/admin/overview', verifyToken, requireAnyPermission(['settings']), getKioskAdminOverviewHandler);
router.put('/admin/backup-code', verifyToken, requireAnyPermission(['settings']), updateKioskBackupCodeHandler);
router.get('/admin/backup-code', verifyToken, requireAnyPermission(['settings']), getKioskBackupCodeHandler);
router.put('/admin/setup-pin', verifyToken, requireAnyPermission(['settings']), updateKioskSetupPinHandler);
router.get('/admin/access-logs', verifyToken, requireAnyPermission(['settings']), getKioskAccessLogsHandler);

// 待機輪播圖管理（權限：settings）
router.get('/admin/slides', verifyToken, requireAnyPermission(['settings']), listSlidesHandler);
router.post(
  '/admin/slides',
  verifyToken,
  requireAnyPermission(['settings']),
  express.raw({ type: ['application/octet-stream', 'application/x-raw-rgb565'], limit: '2mb' }),
  express.json({ limit: '2mb' }),
  createSlideHandler
);
router.patch('/admin/slides/:id', verifyToken, requireAnyPermission(['settings']), updateSlideHandler);
router.put('/admin/slides/order', verifyToken, requireAnyPermission(['settings']), reorderSlidesHandler);
router.delete('/admin/slides/:id', verifyToken, requireAnyPermission(['settings']), deleteSlideHandler);

// 韌體 OTA 管理（權限：settings，上限 5 MB）
router.get('/admin/firmware', verifyToken, requireAnyPermission(['settings']), listFirmwareHandler);
router.post(
  '/admin/firmware',
  verifyToken,
  requireAnyPermission(['settings']),
  express.raw({ type: ['application/octet-stream', 'application/x-esp32-bin'], limit: '5mb' }),
  express.json({ limit: '5mb' }),
  uploadFirmwareHandler
);
router.put('/admin/firmware/target', verifyToken, requireAnyPermission(['settings']), setFirmwareTargetHandler);
router.delete('/admin/firmware/:id', verifyToken, requireAnyPermission(['settings']), deleteFirmwareHandler);

// 警報通知收件人設定（權限：settings）
router.get('/admin/alerts/recipients', verifyToken, requireAnyPermission(['settings']), getAlertRecipientsHandler);
router.put('/admin/alerts/recipients', verifyToken, requireAnyPermission(['settings']), updateAlertRecipientsHandler);
router.post('/admin/alerts/test', verifyToken, requireAnyPermission(['settings']), sendTestAlertHandler);

// 檔案下載（公開，靠檢查碼）
router.get('/files/floor-map/:version.json', getFloorMapFileHandler);
router.get('/files/slides/:id.bin', downloadSlideHandler);
router.get('/files/firmware/:id.bin', downloadFirmwareHandler);

// 報到機 SGK1 v1 加密通訊端點
router.post('/v1/sync', kioskEnvelope('sync'), postKioskSyncHandler);
router.post('/v1/access', kioskEnvelope('access'), postKioskAccessHandler);

export default router;
