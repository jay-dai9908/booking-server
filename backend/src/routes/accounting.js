import express from 'express';
import {
  getAccountingSummary,
  getLedger,
  getPaymentsList,
  getEventsList,
  getPrintJobsList,
  getClosingPreview,
  postClosing,
  getClosingsList,
  getUnpaidFollowUp
} from '../controllers/accountingController.js';
import { verifyToken, requirePermission } from '../middlewares/authMiddleware.js';

const router = express.Router();

router.use(verifyToken, requirePermission('accounting'));

router.get('/summary', getAccountingSummary);
router.get('/ledger', getLedger);
router.get('/payments', getPaymentsList);
router.get('/events', getEventsList);
router.get('/print-jobs', getPrintJobsList);
router.get('/closing/preview', getClosingPreview);
router.post('/closing', postClosing);
router.get('/closings', getClosingsList);
router.get('/unpaid', getUnpaidFollowUp);

export default router;
