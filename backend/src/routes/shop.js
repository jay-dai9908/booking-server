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
import { verifyToken, requireAnyPermission } from '../middlewares/authMiddleware.js';

const router = express.Router();
const checkShopPermission = requireAnyPermission(['shop', 'reservations']);

// Public routes
router.get('/products', getPublicProducts);
router.get('/payment-methods', getPublicPaymentMethods);

// Customer routes
router.post('/orders', verifyToken, createProductOrder);
router.patch('/orders/:id/remittance', verifyToken, updateRemittanceLast5);
router.get('/my-orders', verifyToken, getMyProductOrders);

// Admin routes
router.get('/admin/orders', verifyToken, checkShopPermission, getAdminProductOrders);
router.patch('/admin/orders/:id/verify-payment', verifyToken, checkShopPermission, verifyOrderPayment);
router.patch('/admin/orders/:id', verifyToken, checkShopPermission, updateAdminOrder);
router.post('/admin/orders/notify-arrival', verifyToken, checkShopPermission, notifyOrderArrival);

// Account Pool management
router.get('/admin/account-pool', verifyToken, checkShopPermission, getAdminAccountPool);
router.post('/admin/account-pool/batch', verifyToken, checkShopPermission, batchImportAccountPool);
router.patch('/admin/account-pool/:id', verifyToken, checkShopPermission, updateAccountPoolItem);

// Payment Methods & Shop Settings
router.get('/admin/payment-methods', verifyToken, checkShopPermission, getAdminPaymentMethods);
router.put('/admin/payment-methods/:id', verifyToken, checkShopPermission, updateAdminPaymentMethod);
router.post('/admin/settings', verifyToken, checkShopPermission, updateShopGlobalSettings);

// Products management
router.get('/admin/products', verifyToken, checkShopPermission, getAdminProducts);
router.post('/admin/products', verifyToken, checkShopPermission, createAdminProduct);
router.put('/admin/products/:id', verifyToken, checkShopPermission, updateAdminProduct);

export default router;
