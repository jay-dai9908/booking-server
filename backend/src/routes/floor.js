import express from 'express';
import { verifyToken, requireAnyPermission } from '../middlewares/authMiddleware.js';
import {
  getLive,
  checkIn,
  moveSeat,
  moveGroup,
  handleTimer,
  addPerson,
  removePerson,
  swapBoard,
  returnBoard,
  reassignBoard,
  addBoardRental,
  pauseBoard,
  resumeBoard
} from '../controllers/floorController.js';

const router = express.Router();
const floorAuth = [verifyToken, requireAnyPermission(['reservations', 'seating', 'weekly'])];

router.get('/live', ...floorAuth, getLive);
router.post('/:booking_ref/check-in', ...floorAuth, checkIn);
router.post('/:booking_ref/move-seat', ...floorAuth, moveSeat);
router.post('/:booking_ref/move-group', ...floorAuth, moveGroup);
router.post('/:booking_ref/timer', ...floorAuth, handleTimer);
router.post('/:booking_ref/persons', ...floorAuth, addPerson);
router.delete('/:booking_ref/persons/:person_no', ...floorAuth, removePerson);
router.post('/:booking_ref/boards', ...floorAuth, addBoardRental);
router.post('/:booking_ref/boards/:unit_group/swap', ...floorAuth, swapBoard);
router.post('/:booking_ref/boards/:unit_group/return', ...floorAuth, returnBoard);
router.post('/:booking_ref/boards/:unit_group/pause', ...floorAuth, pauseBoard);
router.post('/:booking_ref/boards/:unit_group/resume', ...floorAuth, resumeBoard);
router.patch('/:booking_ref/boards/:unit_group', ...floorAuth, reassignBoard);

export default router;
