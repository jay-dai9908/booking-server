import express from 'express';
import {
  getPublicProducts,
  getPublicPaymentMethods,
  createProductOrder,
  updateRemittanceLast5,
  getMyProductOrders,
  getAdminProductOrders,
  verifyOrderPayment,
  updateAdminOrder,
  notifyOrderArrival,
  getAdminAccountPool,
  batchImportAccountPool,
  updateAccountPoolItem,
  getAdminPaymentMethods,
  updateAdminPaymentMethod,
  updateShopGlobalSettings,
  getAdminProducts,
  createAdminProduct,
  updateAdminProduct
} from '../controllers/shopController.js';
import { verifyToken, requireAdmin } from '../middlewares/authMiddleware.js';

const router = express.Router();

// Public routes
router.get('/products', getPublicProducts);
router.get('/payment-methods', getPublicPaymentMethods);

// Customer routes
router.post('/orders', verifyToken, createProductOrder);
router.patch('/orders/:id/remittance', verifyToken, updateRemittanceLast5);
router.get('/my-orders', verifyToken, getMyProductOrders);

// Admin routes
router.get('/admin/orders', verifyToken, requireAdmin, getAdminProductOrders);
router.patch('/admin/orders/:id/verify-payment', verifyToken, requireAdmin, verifyOrderPayment);
router.patch('/admin/orders/:id', verifyToken, requireAdmin, updateAdminOrder);
router.post('/admin/orders/notify-arrival', verifyToken, requireAdmin, notifyOrderArrival);

// Account Pool management
router.get('/admin/account-pool', verifyToken, requireAdmin, getAdminAccountPool);
router.post('/admin/account-pool/batch', verifyToken, requireAdmin, batchImportAccountPool);
router.patch('/admin/account-pool/:id', verifyToken, requireAdmin, updateAccountPoolItem);

// Payment Methods & Shop Settings
router.get('/admin/payment-methods', verifyToken, requireAdmin, getAdminPaymentMethods);
router.put('/admin/payment-methods/:id', verifyToken, requireAdmin, updateAdminPaymentMethod);
router.post('/admin/settings', verifyToken, requireAdmin, updateShopGlobalSettings);

// Products management
router.get('/admin/products', verifyToken, requireAdmin, getAdminProducts);
router.post('/admin/products', verifyToken, requireAdmin, createAdminProduct);
router.put('/admin/products/:id', verifyToken, requireAdmin, updateAdminProduct);

export default router;
