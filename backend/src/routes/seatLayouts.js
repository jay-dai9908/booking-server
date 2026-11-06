import express from 'express';
import { verifyToken, requireAnyPermission } from '../middlewares/authMiddleware.js';
import {
  getActiveLayout,
  listLayouts,
  getLayoutById,
  createLayoutDraft,
  updateLayoutDraft,
  previewPublish,
  publishLayout,
  updateLayoutRules,
  deleteLayout,
  allocatePreview
} from '../controllers/seatLayoutController.js';

const router = express.Router();

const readAuth = [verifyToken, requireAnyPermission(['seating', 'reservations', 'weekly'])];
const writeAuth = [verifyToken, requireAnyPermission(['seating'])];

router.get('/active', ...readAuth, getActiveLayout);
router.get('/', ...readAuth, listLayouts);
router.get('/:id', ...readAuth, getLayoutById);
router.post('/', ...writeAuth, createLayoutDraft);
router.post('/draft', ...writeAuth, createLayoutDraft);
router.put('/:id', ...writeAuth, updateLayoutDraft);
router.post('/:id/preview-publish', ...writeAuth, previewPublish);
router.post('/:id/publish', ...writeAuth, publishLayout);
router.put('/:id/rules', ...writeAuth, updateLayoutRules);
router.delete('/:id', ...writeAuth, deleteLayout);
router.post('/allocate-preview', ...readAuth, allocatePreview);

export default router;
