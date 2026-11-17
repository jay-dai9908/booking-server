import express from 'express';
import { getDailySetting, getDailySettingsRange, updateDailySetting, batchUpdateDailySettings, getGlobalSetting, updateGlobalSetting } from '../controllers/dailySettingController.js';
import { verifyToken, requirePermission, requireAnyPermission } from '../middlewares/authMiddleware.js';

const router = express.Router();

router.get('/global', getGlobalSetting);
router.put('/global', verifyToken, requireAnyPermission(['settings', 'sessions', 'equipment']), updateGlobalSetting);
router.get('/range', getDailySettingsRange);

router.post('/batch', verifyToken, requirePermission('sessions'), batchUpdateDailySettings);

router.get('/', getDailySetting);
router.put('/', verifyToken, requirePermission('sessions'), updateDailySetting);

export default router;

