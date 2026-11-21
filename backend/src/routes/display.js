import express from 'express';
import { verifyToken, requireAnyPermission } from '../middlewares/authMiddleware.js';
import { displayAuth } from '../middlewares/displayAuth.js';
import {
  listPublicDisplayDevices,
  displayLogin,
  listAdminDevices,
  createAdminDevice,
  updateAdminDevicePassword,
  logoutAdminDevice
} from '../controllers/displayDeviceController.js';
import {
  getDisplaySettings,
  updateDisplaySettings
} from '../controllers/displaySettingController.js';
import {
  getDisplayStateHandler,
  streamDisplayHandler,
  postDisplayHeartbeat,
  reloadAdminDevice
} from '../controllers/displayStateController.js';

const router = express.Router();
const adminDisplayAuth = [verifyToken, requireAnyPermission(['settings'])];

// Display device login & public device list (id + name only)
router.get('/devices', listPublicDisplayDevices);
router.post('/login', displayLogin);

// Display device authenticated endpoints
router.get('/state', displayAuth(), getDisplayStateHandler);
router.get('/stream', displayAuth({ allowQuery: true }), streamDisplayHandler);
router.post('/heartbeat', displayAuth(), postDisplayHeartbeat);

// Admin device management (settings permission)
router.get('/admin/devices', ...adminDisplayAuth, listAdminDevices);
router.post('/admin/devices', ...adminDisplayAuth, createAdminDevice);
router.put('/admin/devices/:id/password', ...adminDisplayAuth, updateAdminDevicePassword);
router.post('/admin/devices/:id/logout', ...adminDisplayAuth, logoutAdminDevice);
router.post('/admin/devices/:id/reload', ...adminDisplayAuth, reloadAdminDevice);

// Admin display settings (settings permission)
router.get('/admin/settings', ...adminDisplayAuth, getDisplaySettings);
router.put('/admin/settings', ...adminDisplayAuth, updateDisplaySettings);

export default router;
