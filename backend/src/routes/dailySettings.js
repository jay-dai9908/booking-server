import express from 'express';
import { getDailySetting, getDailySettingsRange, updateDailySetting, updateDayType, batchUpdateDailySettings, getGlobalSetting, updateGlobalSetting } from '../controllers/dailySettingController.js';
import { verifyToken, requireAdmin, requirePermission } from '../middlewares/authMiddleware.js';

const router = express.Router();

router.get('/global', getGlobalSetting);
router.put('/global', verifyToken, requireAdmin, updateGlobalSetting);
router.get('/range', getDailySettingsRange);

router.post('/batch', verifyToken, requirePermission('sessions'), batchUpdateDailySettings);
router.put('/day-type', verifyToken, requirePermission('sessions'), updateDayType);

router.get('/', getDailySetting);
router.put('/', verifyToken, requirePermission('sessions'), updateDailySetting);

export default router;

