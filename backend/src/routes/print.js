import express from 'express';
import { verifyToken, requireAnyPermission } from '../middlewares/authMiddleware.js';
import verifyPrintStation from '../middlewares/printStationAuth.js';
import {
  stationHeartbeat,
  stationClaim,
  stationReportResult,
  getStatus,
  createJob,
  getJobById,
  listJobs,
  retryJob,
  cancelJob,
  markJobPrinted,
  reportLocalJob,
  getStations,
  updateStation,
  pairStation,
  unpairStation,
  testStation
} from '../controllers/printController.js';

const router = express.Router();

const printStaffAuth = [
  verifyToken,
  requireAnyPermission(['reservations', 'seating', 'weekly', 'accounting', 'equipment', 'coupons', 'settings'])
];
const settingsAuth = [
  verifyToken,
  requireAnyPermission(['settings'])
];

// Print station communication endpoints
router.post('/station/heartbeat', verifyPrintStation, stationHeartbeat);
router.post('/station/claim', verifyPrintStation, stationClaim);
router.post('/station/jobs/:id/result', verifyPrintStation, stationReportResult);

// Admin printer endpoints
router.get('/status', ...printStaffAuth, getStatus);
router.post('/jobs', ...printStaffAuth, createJob);
router.get('/jobs/:id', ...printStaffAuth, getJobById);
router.get('/jobs', ...printStaffAuth, listJobs);
router.post('/jobs/:id/retry', ...printStaffAuth, retryJob);
router.post('/jobs/:id/cancel', ...printStaffAuth, cancelJob);
router.post('/jobs/:id/mark-printed', ...printStaffAuth, markJobPrinted);
router.post('/jobs/:id/local', ...printStaffAuth, reportLocalJob);

// Station management endpoints
router.get('/stations', ...printStaffAuth, getStations);
router.patch('/stations/:id', ...printStaffAuth, updateStation);
router.post('/stations/pair', ...settingsAuth, pairStation);
router.post('/stations/:id/unpair', ...settingsAuth, unpairStation);
router.post('/stations/:id/test', ...printStaffAuth, testStation);

export default router;
