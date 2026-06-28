import express from 'express';
import { getDailySetting, updateDailySetting, batchUpdateDailySettings, getGlobalSetting, updateGlobalSetting } from '../controllers/dailySettingController.js';
import { verifyToken, requireAdmin } from '../middlewares/authMiddleware.js';

const router = express.Router();

router.get('/global', getGlobalSetting);
router.put('/global', verifyToken, requireAdmin, updateGlobalSetting);

router.post('/batch', verifyToken, requireAdmin, batchUpdateDailySettings);

router.get('/', getDailySetting);
router.put('/', verifyToken, requireAdmin, updateDailySetting);

export default router;
