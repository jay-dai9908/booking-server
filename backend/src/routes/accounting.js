import express from 'express';
import {
  getAccountingSummary,
  getDailyRevenue,
  getLedger,
  getPaymentsList,
  getPaymentsCsv,
  getEventsList,
  getEventsCsv,
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
router.get('/daily', getDailyRevenue);
router.get('/ledger', getLedger);
router.get('/payments', getPaymentsList);
router.get('/payments.csv', getPaymentsCsv);
router.get('/events', getEventsList);
router.get('/events.csv', getEventsCsv);
router.get('/print-jobs', getPrintJobsList);
router.get('/closing/preview', getClosingPreview);
router.post('/closing', postClosing);
router.get('/closings', getClosingsList);
router.get('/unpaid', getUnpaidFollowUp);

export default router;
