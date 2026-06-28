import express from 'express';
import { getAccountingSummary, getLedger, getUnpaidFollowUp } from '../controllers/accountingController.js';

const router = express.Router();

router.get('/summary', getAccountingSummary);
router.get('/ledger', getLedger);
router.get('/unpaid', getUnpaidFollowUp);

export default router;
