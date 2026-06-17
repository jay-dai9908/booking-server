import express from 'express';
import { getDailySetting, updateDailySetting } from '../controllers/dailySettingController.js';
import { requireAdmin } from '../middlewares/authMiddleware.js';

const router = express.Router();

router.get('/', getDailySetting);
router.put('/', requireAdmin, updateDailySetting);

export default router;
