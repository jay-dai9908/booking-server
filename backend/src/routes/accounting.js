import express from 'express';
import { getAccountingSummary, getLedger, getUnpaidFollowUp } from '../controllers/accountingController.js';
import { verifyToken, requirePermission } from '../middlewares/authMiddleware.js';

const router = express.Router();

router.use(verifyToken, requirePermission('accounting'));

router.get('/summary', getAccountingSummary);
router.get('/ledger', getLedger);
router.get('/unpaid', getUnpaidFollowUp);

export default router;

