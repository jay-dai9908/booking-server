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
import {
  listDisplaySlidesHandler,
  createDisplaySlideHandler,
  updateDisplaySlideHandler,
  reorderDisplaySlidesHandler,
  deleteDisplaySlideHandler,
  downloadDisplaySlideHandler
} from '../controllers/displaySlideController.js';

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

// Admin display slides CRUD (settings permission)
router.get('/admin/slides', ...adminDisplayAuth, listDisplaySlidesHandler);
router.post(
  '/admin/slides',
  ...adminDisplayAuth,
  express.raw({ type: ['image/jpeg', 'image/png', 'image/webp', 'application/octet-stream'], limit: '4mb' }),
  express.json({ limit: '4mb' }),
  createDisplaySlideHandler
);
router.put('/admin/slides/order', ...adminDisplayAuth, reorderDisplaySlidesHandler);
router.patch('/admin/slides/:id', ...adminDisplayAuth, updateDisplaySlideHandler);
router.delete('/admin/slides/:id', ...adminDisplayAuth, deleteDisplaySlideHandler);

// Public slide image download (immutable cacheable via sha256)
router.get('/files/slides/:id/:sha256', downloadDisplaySlideHandler);

export default router;
