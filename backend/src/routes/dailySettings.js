import express from 'express';
import {
  getDailySetting,
  getDailySettingsRange,
  updateDailySetting,
  updateDayType,
  batchUpdateDailySettings,
  getGlobalSetting,
  updateGlobalSetting,
  getClosureImpactHandler,
  getClosureImpactCsvHandler,
  postClosureCancelHandler,
  postClosureNotifySingleHandler
} from '../controllers/dailySettingController.js';
import { verifyToken, requireAdmin, requirePermission } from '../middlewares/authMiddleware.js';

const router = express.Router();

router.get('/global', getGlobalSetting);
router.put('/global', verifyToken, requireAdmin, updateGlobalSetting);
router.get('/range', getDailySettingsRange);

router.post('/batch', verifyToken, requirePermission('sessions'), batchUpdateDailySettings);
router.put('/day-type', verifyToken, requirePermission('sessions'), updateDayType);

router.get('/', getDailySetting);
router.put('/', verifyToken, requirePermission('sessions'), updateDailySetting);

router.get('/:date/closure-impact.csv', verifyToken, requirePermission('sessions'), getClosureImpactCsvHandler);
router.get('/:date/closure-impact', verifyToken, requirePermission('sessions'), getClosureImpactHandler);
router.post('/:date/closure/cancel', verifyToken, requirePermission('sessions'), postClosureCancelHandler);
router.post('/:date/closure/notify', verifyToken, requirePermission('sessions'), postClosureNotifySingleHandler);

export default router;

