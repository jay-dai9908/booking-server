import express from 'express';
import { 
  getAvailableEquipment, 
  getAdminEquipmentConfigs, 
  updateEquipmentConfig, 
  createEquipmentConfig, 
  deleteEquipmentConfig, 
  updateGlobalEquipmentSetting,
  getEquipmentOccupancy
} from '../controllers/equipmentController.js';
import { verifyToken, requirePermission, requireAnyPermission } from '../middlewares/authMiddleware.js';

const router = express.Router();

// Public / Customer endpoint
router.get('/availability', getAvailableEquipment);

// Admin endpoints
router.get('/admin', verifyToken, requireAnyPermission(['sessions', 'seating', 'staff', 'equipment']), getAdminEquipmentConfigs);
router.get('/admin/occupancy', verifyToken, requireAnyPermission(['sessions', 'seating', 'equipment']), getEquipmentOccupancy);
router.put('/admin/:id', verifyToken, requireAnyPermission(['sessions', 'staff', 'equipment']), updateEquipmentConfig);
router.post('/admin', verifyToken, requireAnyPermission(['sessions', 'staff', 'equipment']), createEquipmentConfig);
router.delete('/admin/:id', verifyToken, requireAnyPermission(['sessions', 'staff', 'equipment']), deleteEquipmentConfig);
router.patch('/admin/settings', verifyToken, requireAnyPermission(['sessions', 'staff', 'equipment']), updateGlobalEquipmentSetting);

export default router;
