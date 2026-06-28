import prisma from '../prismaClient.js';
import { Prisma } from '@prisma/client';
import crypto from 'crypto';
import { allocateSeats } from '../utils/SeatAllocator.js';

// Helper function to group reservations by booking_ref
const groupReservations = (reservations) => {
  const groups = {};
  for (const r of reservations) {
    const ref = r.booking_ref;
    if (!groups[ref]) {
      groups[ref] = {
        booking_ref: ref,
        user_id: r.user_id,
        user: r.user,
        pax: r.pax,
        status: r.status,
        attendance: r.attendance,
        created_at: r.created_at,
        session_date: r.session.session_date,
        sessions: [],
        assigned_seats: r.assigned_seats || [],
        is_seat_locked: r.is_seat_locked || false,
        is_force_split: r.is_force_split || false,
        is_unlimited: r.is_unlimited || false,
        is_paid: r.is_paid || false,
        total_amount: r.total_amount || null,
        cancelled_at: r.cancelled_at || null,
        cancelled_by: r.cancelled_by || null
      };
    }
    groups[ref].sessions.push(r.session);
  }

  // Calculate start and end times for each group
  return Object.values(groups).map(group => {
    // Sort sessions by start_time
    group.sessions.sort((a, b) => a.start_time.localeCompare(b.start_time));
    const start_time = group.sessions[0].start_time;
    const end_time = group.sessions[group.sessions.length - 1].end_time;
    
    const time_blocks = [];
    let current_block = null;
    
    for (const session of group.sessions) {
      if (!current_block) {
        current_block = { start_time: session.start_time, end_time: session.end_time };
      } else {
        if (session.start_time === current_block.end_time) {
          // contiguous
          current_block.end_time = session.end_time;
        } else {
          // gap
          time_blocks.push(current_block);
          current_block = { start_time: session.start_time, end_time: session.end_time };
        }
      }
    }
    if (current_block) time_blocks.push(current_block);
    
    return {
      booking_ref: group.booking_ref,
      user_id: group.user_id,
      user: group.user,
      pax: group.pax,
      status: group.status,
      attendance: group.attendance,
      created_at: group.created_at,
      session_date: group.session_date,
      start_time,
      end_time,
      time_blocks,
      session_count: group.sessions.length,
      assigned_seats: group.assigned_seats,
      is_seat_locked: group.is_seat_locked,
      is_force_split: group.is_force_split,
      is_unlimited: group.is_unlimited,
      is_paid: group.is_paid,
      total_amount: group.total_amount,
      cancelled_at: group.cancelled_at,
      cancelled_by: group.cancelled_by
    };
  });
};

// Helper function to calculate total amount based on pricing rules
const calculateTotalAmount = async (tx, sessionDate, pax, sessionCount, is_unlimited) => {
  // Try to find DailySetting override
  const dailySetting = await tx.dailySetting.findUnique({
    where: { date: sessionDate }
  });

  let hourly_price = dailySetting?.hourly_price;
  let unlimited_price = dailySetting?.unlimited_price;

  // If daily setting doesn't have prices, fallback to GlobalSetting
  if (hourly_price == null || unlimited_price == null) {
    const globalSetting = await tx.globalSetting.findUnique({
      where: { id: 1 }
    });
    
    // Determine if sessionDate is weekend (0 = Sunday, 6 = Saturday)
    const dayOfWeek = new Date(sessionDate).getDay();
    const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;

    if (!globalSetting) {
      hourly_price = hourly_price ?? (isWeekend ? 150 : 100);
      unlimited_price = unlimited_price ?? (isWeekend ? 800 : 550);
    } else {
      hourly_price = hourly_price ?? (isWeekend ? globalSetting.weekend_hourly_price : globalSetting.weekday_hourly_price);
      unlimited_price = unlimited_price ?? (isWeekend ? globalSetting.weekend_unlimited_price : globalSetting.weekday_unlimited_price);
    }
  }

  const calculatedHourlyTotal = pax * hourly_price * sessionCount;
  const calculatedUnlimitedTotal = pax * unlimited_price;

  return Math.min(calculatedHourlyTotal, calculatedUnlimitedTotal);
};

export const createReservation = async (req, res) => {
  const { session_ids, pax, forceSplit } = req.body;
  const userId = req.user.id;

  if (!Array.isArray(session_ids) || session_ids.length === 0 || !pax || pax <= 0) {
    return res.status(400).json({ error: 'Valid session_ids array and pax are required.' });
  }

  try {
    const booking_ref = crypto.randomUUID();

    const result = await prisma.$transaction(async (tx) => {
      // 1. Get the requested sessions
      const requestedSessions = await tx.$queryRaw`
        SELECT id, max_capacity, session_date
        FROM "Session" 
        WHERE id IN (${Prisma.join(session_ids)}) 
        FOR UPDATE
      `;

      if (requestedSessions.length !== session_ids.length) {
        throw new Error('SOME_SESSIONS_NOT_FOUND');
      }

      const sessionDate = requestedSessions[0].session_date;

      // Lock ALL sessions for the same date to prevent race conditions across the day
      const allSessionsOfDay = await tx.$queryRaw`
        SELECT id
        FROM "Session"
        WHERE session_date = ${sessionDate}
        FOR UPDATE
      `;
      const allSessionIdsOfDay = allSessionsOfDay.map(s => s.id);

      // Fetch all confirmed reservations for the day
      const currentReservations = await tx.reservation.findMany({
        where: { session_id: { in: allSessionIdsOfDay }, status: 'confirmed' }
      });

      // Prepare the new reservation block
      const newReservationBlock = { 
        booking_ref: 'NEW_RES', 
        pax: parseInt(pax, 10), 
        session_ids: session_ids 
      };

      // Run Continuous Block Allocation algorithm
      const allocResult = allocateSeats(currentReservations, newReservationBlock, forceSplit === true);

      if (!allocResult.success) {
        if (allocResult.error === 'INSUFFICIENT_SEATS') throw new Error('INSUFFICIENT_CAPACITY');
        if (allocResult.error === 'SPLIT_REQUIRED') throw new Error('SPLIT_REQUIRED');
        throw new Error('ALLOCATION_FAILED');
      }

      // Apply Reshuffle Updates to existing reservations
      const sessionUpdates = []; 
      const newReservationsData = [];
      
      const mySeats = allocResult.updates.find(u => u.booking_ref === 'NEW_RES').assigned_seats;

      const is_unlimited = req.body.isUnlimited === true;
      const totalAmount = await calculateTotalAmount(tx, sessionDate, parseInt(pax, 10), session_ids.length, is_unlimited);

      for (const sessionId of session_ids) {
        newReservationsData.push({
          booking_ref,
          session_id: sessionId,
          user_id: userId,
          pax: parseInt(pax, 10),
          status: 'confirmed',
          assigned_seats: mySeats,
          is_force_split: forceSplit === true,
          is_unlimited: is_unlimited,
          total_amount: totalAmount
        });
      }

      for (const update of allocResult.updates) {
        if (update.booking_ref !== 'NEW_RES') {
          // Update all session records for this reshuffled booking_ref
          sessionUpdates.push(
            tx.reservation.updateMany({
              where: { booking_ref: update.booking_ref },
              data: { assigned_seats: update.assigned_seats }
            })
          );
        }
      }

      if (sessionUpdates.length > 0) {
        await Promise.all(sessionUpdates);
      }

      // Create the new reservations with their assigned seats
      const newReservations = await tx.reservation.createMany({
        data: newReservationsData
      });

      return { booking_ref, count: newReservations.count };
    });

    res.status(201).json({ message: 'Reservation successful', reservation: result });

  } catch (error) {
    console.error('Reservation error:', error);
    if (error.message === 'SOME_SESSIONS_NOT_FOUND') {
      return res.status(404).json({ error: 'One or more sessions not found.' });
    }
    if (error.message === 'INSUFFICIENT_CAPACITY') {
      return res.status(400).json({ error: 'Not enough capacity remaining for one or more selected sessions.' });
    }
    if (error.message === 'SPLIT_REQUIRED') {
      return res.status(409).json({ error: '連續座位不足，同行者將被拆散。是否確認預約？' });
    }
    res.status(500).json({ error: 'Failed to create reservation.' });
  }
};

export const getAdminReservations = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const search = (req.query.search || '').trim();
    const month = req.query.month; // format: 'YYYY-MM'
    const date = req.query.date;   // format: 'YYYY-MM-DD'
    const sort = req.query.sort;   // format: 'start_time_asc'

    let whereClause = {};

    if (date) {
      const startDate = new Date(`${date}T00:00:00.000Z`);
      const endDate = new Date(startDate);
      endDate.setDate(endDate.getDate() + 1);
      
      whereClause.session = {
        session_date: {
          gte: startDate,
          lt: endDate
        }
      };
    } else if (month) {
      const startDate = new Date(`${month}-01T00:00:00.000Z`);
      const endDate = new Date(startDate);
      endDate.setMonth(endDate.getMonth() + 1);
      
      whereClause.session = {
        session_date: {
          gte: startDate,
          lt: endDate
        }
      };
    }

    if (search) {
      // If we already have a whereClause.session, we need to combine them with AND
      // The easiest way is to just assign the OR array directly to whereClause.OR
      whereClause.OR = [
        { booking_ref: { contains: search } },
        { user: { name: { contains: search } } },
        { user: { phone: { contains: search } } }
      ];
    }

    // Fetch all reservations matching criteria (for the month)
    const reservations = await prisma.reservation.findMany({
      where: whereClause,
      include: {
        session: true,
        user: {
          select: { name: true, phone: true }
        }
      },
      orderBy: {
        created_at: 'desc'
      }
    });

    // Group them
    let grouped = groupReservations(reservations);
    
    // Sort grouped reservations by session_date ascending, then start_time ascending
    grouped.sort((a, b) => {
      if (a.session_date > b.session_date) return 1;
      if (a.session_date < b.session_date) return -1;
      
      return a.start_time.localeCompare(b.start_time);
    });

    // Calculate total daily revenue if it's a specific date query
    let total_daily_revenue = 0;
    if (date && !search) {
      total_daily_revenue = grouped.reduce((sum, r) => {
        if (r.status === 'confirmed' && r.is_paid && r.total_amount) {
          return sum + r.total_amount;
        }
        return sum;
      }, 0);
    }

    const total = grouped.length;
    const totalPages = Math.ceil(total / limit);
    const paginatedData = grouped.slice((page - 1) * limit, page * limit);

    res.json({
      data: paginatedData,
      total,
      page,
      totalPages,
      total_daily_revenue
    });
  } catch (error) {
    console.error('Error fetching reservations:', error);
    res.status(500).json({ error: 'Failed to fetch reservations' });
  }
};

export const getAdminReservationDetails = async (req, res) => {
  const { booking_ref } = req.params;
  try {
    const reservations = await prisma.reservation.findMany({
      where: { booking_ref },
      include: {
        session: true,
        user: { select: { name: true, phone: true } }
      },
      orderBy: { created_at: 'desc' }
    });
    if (reservations.length === 0) {
      return res.status(404).json({ error: 'Reservation not found' });
    }
    const grouped = groupReservations(reservations);
    res.json(grouped[0]);
  } catch (error) {
    console.error('Error fetching reservation details:', error);
    res.status(500).json({ error: 'Failed to fetch reservation details' });
  }
};

export const getMyReservations = async (req, res) => {
  const userId = req.user.id;

  try {
    const reservations = await prisma.reservation.findMany({
      where: { user_id: userId },
      include: {
        session: true,
        user: true
      },
      orderBy: {
        created_at: 'desc'
      }
    });

    const grouped = groupReservations(reservations);
    res.json(grouped);
  } catch (error) {
    console.error('Error fetching my reservations:', error);
    res.status(500).json({ error: 'Failed to fetch your reservations' });
  }
};

export const cancelReservation = async (req, res) => {
  // We use :id parameter, but it actually receives booking_ref now.
  const { id: booking_ref } = req.params;
  const userId = req.user.id;
  const isAdmin = req.user.role === 'admin';

  try {
    // Find all reservations with this booking_ref
    const reservations = await prisma.reservation.findMany({
      where: { booking_ref }
    });

    if (reservations.length === 0) {
      return res.status(404).json({ error: 'Reservation not found' });
    }

    // Check ownership (only need to check first one since they share booking_ref)
    if (!isAdmin && reservations[0].user_id !== userId) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    if (reservations[0].status === 'cancelled') {
      return res.status(400).json({ error: 'Reservation is already cancelled' });
    }

    // Cancel all related rows
    const updated = await prisma.reservation.updateMany({
      where: { booking_ref },
      data: { 
        status: 'cancelled',
        cancelled_at: new Date(),
        cancelled_by: isAdmin ? 'admin' : 'customer'
      }
    });

    res.json({ message: 'Reservation cancelled successfully', count: updated.count });
  } catch (error) {
    console.error('Error cancelling reservation:', error);
    res.status(500).json({ error: 'Failed to cancel reservation' });
  }
};

export const deleteReservationRecord = async (req, res) => {
  const { id: booking_ref } = req.params;
  
  // This route is protected by requireAdmin middleware, so we know they are admin.
  try {
    const reservations = await prisma.reservation.findMany({
      where: { booking_ref }
    });

    if (reservations.length === 0) {
      return res.status(404).json({ error: 'Reservation not found' });
    }

    if (reservations[0].status !== 'cancelled') {
      return res.status(400).json({ error: 'Only cancelled reservations can be permanently deleted' });
    }

    // Hard delete all related rows
    const deleted = await prisma.reservation.deleteMany({
      where: { booking_ref }
    });

    res.json({ message: 'Reservation record deleted permanently', count: deleted.count });
  } catch (error) {
    console.error('Error deleting reservation record:', error);
    res.status(500).json({ error: 'Failed to delete reservation record' });
  }
};

export const handleCollisionsAndReshuffle = async (sessionIds, updatedBookingRefs) => {
  // Find all confirmed reservations in the affected sessions
  const currentReservations = await prisma.reservation.findMany({
    where: { session_id: { in: sessionIds }, status: 'confirmed' }
  });

  // Collect newly assigned seats for the updated refs
  const updatedSeatsMap = new Map();
  for (const r of currentReservations) {
    if (updatedBookingRefs.includes(r.booking_ref)) {
      if (!updatedSeatsMap.has(r.session_id)) updatedSeatsMap.set(r.session_id, new Set());
      r.assigned_seats?.forEach(s => updatedSeatsMap.get(r.session_id).add(s));
    }
  }

  // Find colliding reservations
  const collidingRefs = new Set();
  for (const r of currentReservations) {
    if (updatedBookingRefs.includes(r.booking_ref)) continue;
    
    const updatedSeatsForSession = updatedSeatsMap.get(r.session_id);
    if (updatedSeatsForSession && r.assigned_seats) {
      if (r.assigned_seats.some(seat => updatedSeatsForSession.has(seat))) {
        collidingRefs.add(r.booking_ref);
      }
    }
  }

  let displacedCount = collidingRefs.size;

  if (displacedCount > 0) {
    // Unpin colliding reservations in memory
    for (const r of currentReservations) {
      if (collidingRefs.has(r.booking_ref)) {
        r.is_seat_locked = false;
        r.assigned_seats = []; // Strip to force reshuffle
      }
    }

    // Run allocation algorithm (pure reshuffle)
    const allocResult = allocateSeats(currentReservations, null, false);

    if (allocResult.updates && allocResult.updates.length > 0) {
      const sessionUpdates = [];
      for (const update of allocResult.updates) {
        sessionUpdates.push(
          prisma.reservation.updateMany({
            where: { booking_ref: update.booking_ref },
            data: { assigned_seats: update.assigned_seats }
          })
        );
      }
      if (sessionUpdates.length > 0) {
        await prisma.$transaction(sessionUpdates);
      }
    } else {
      // Very edge case: completely full, couldn't reshuffle. Put them in wait area
      const sessionUpdates = [];
      
      let maxWait = 0;
      for (const res of currentReservations) {
        if (res.assigned_seats) {
          for (const seat of res.assigned_seats) {
            if (seat.startsWith('WAIT-')) {
              const num = parseInt(seat.replace('WAIT-', ''), 10);
              if (!isNaN(num) && num > maxWait) maxWait = num;
            }
          }
        }
      }
      let waitCounter = maxWait + 1;
      for (const ref of collidingRefs) {
        const r = currentReservations.find(res => res.booking_ref === ref);
        const waitSeats = [];
        const paxCount = r ? r.pax : 1;
        for (let i = 0; i < paxCount; i++) {
          waitSeats.push(`WAIT-${waitCounter++}`);
        }
        sessionUpdates.push(
          prisma.reservation.updateMany({
            where: { booking_ref: ref },
            data: { assigned_seats: waitSeats }
          })
        );
      }
      await prisma.$transaction(sessionUpdates);
    }
  }

  return displacedCount;
};

export const moveSeat = async (req, res) => {
  const { id, assigned_seats } = req.body;

  if (!id || !assigned_seats || !Array.isArray(assigned_seats)) {
    return res.status(400).json({ error: 'Valid reservation id and assigned_seats array are required.' });
  }

  try {
    const targetRes = await prisma.reservation.findUnique({ where: { id: parseInt(id, 10) } });
    if (!targetRes) {
      return res.status(404).json({ error: 'Reservation not found' });
    }

    const group = await prisma.reservation.findMany({ 
      where: { booking_ref: targetRes.booking_ref }
    });
    const sessionIds = group.map(r => r.session_id);

    // Force update the target reservation
    await prisma.reservation.updateMany({
      where: { booking_ref: targetRes.booking_ref },
      data: {
        assigned_seats,
        is_seat_locked: true
      }
    });

    const displacedCount = await handleCollisionsAndReshuffle(sessionIds, [targetRes.booking_ref]);

    const singleUpdated = await prisma.reservation.findUnique({ where: { id: parseInt(id, 10) } });

    res.json({ 
      message: 'Seat moved successfully', 
      reservation: singleUpdated,
      displacedCount
    });
  } catch (error) {
    console.error('Error moving seat:', error);
    res.status(500).json({ error: 'Failed to move seat' });
  }
};

export const swapSeats = async (req, res) => {
  const { source_booking_ref, source_assigned_seats, target_booking_ref, target_assigned_seats } = req.body;

  if (!source_booking_ref || !target_booking_ref || !Array.isArray(source_assigned_seats) || !Array.isArray(target_assigned_seats)) {
    return res.status(400).json({ error: 'Invalid parameters for swapping seats' });
  }

  try {
    const sourceGroup = await prisma.reservation.findMany({ where: { booking_ref: source_booking_ref } });
    const targetGroup = await prisma.reservation.findMany({ where: { booking_ref: target_booking_ref } });
    
    const sessionIdsSet = new Set([...sourceGroup.map(r => r.session_id), ...targetGroup.map(r => r.session_id)]);
    const sessionIds = Array.from(sessionIdsSet);

    await prisma.$transaction([
      prisma.reservation.updateMany({
        where: { booking_ref: source_booking_ref },
        data: { assigned_seats: source_assigned_seats, is_seat_locked: true }
      }),
      prisma.reservation.updateMany({
        where: { booking_ref: target_booking_ref },
        data: { assigned_seats: target_assigned_seats, is_seat_locked: true }
      })
    ]);

    const displacedCount = await handleCollisionsAndReshuffle(sessionIds, [source_booking_ref, target_booking_ref]);

    res.json({ message: 'Seats swapped successfully', displacedCount });
  } catch (error) {
    console.error('Error swapping seats:', error);
    res.status(500).json({ error: 'Failed to swap seats' });
  }
};

export const getSessionSeats = async (req, res) => {
  const { id } = req.params;

  try {
    const session = await prisma.session.findUnique({
      where: { id: parseInt(id, 10) }
    });

    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    const reservations = await prisma.reservation.findMany({
      where: { session_id: parseInt(id, 10), status: 'confirmed' },
      include: {
        user: {
          select: { name: true, phone: true }
        }
      }
    });

    // --- Self-Healing Mechanism ---
    const SEAT_REGEX = /^[AB][12]-[1-4]$/;
    const WAIT_REGEX = /^WAIT-\d+$/;
    const occupiedSeats = new Set();
    let maxWait = 0;

    for (const r of reservations) {
      if (r.assigned_seats && Array.isArray(r.assigned_seats)) {
        for (const s of r.assigned_seats) {
          if (WAIT_REGEX.test(s)) {
            const num = parseInt(s.split('-')[1], 10);
            if (num > maxWait) maxWait = num;
          }
        }
      }
    }

    let waitCounter = maxWait + 1;
    const healUpdates = [];

    for (let i = 0; i < reservations.length; i++) {
      const r = reservations[i];
      let isMissing = false;

      if (!r.assigned_seats || !Array.isArray(r.assigned_seats) || r.assigned_seats.length === 0) {
        isMissing = true;
      } else {
        for (const s of r.assigned_seats) {
          if (!SEAT_REGEX.test(s) && !WAIT_REGEX.test(s)) {
            isMissing = true;
            break;
          }
          if (occupiedSeats.has(s)) {
            isMissing = true; // Overlap detected! One of them must be pushed to wait.
            break;
          }
        }
      }

      if (isMissing) {
        const waitSeats = [];
        const paxCount = r.pax || 1;
        for (let j = 0; j < paxCount; j++) {
          waitSeats.push(`WAIT-${waitCounter++}`);
        }
        r.assigned_seats = waitSeats; // Update memory for current response
        healUpdates.push(
          prisma.reservation.updateMany({
            where: { booking_ref: r.booking_ref },
            data: { assigned_seats: waitSeats }
          })
        );
      } else {
        // Valid and no overlap, mark seats as occupied
        for (const s of r.assigned_seats) {
          occupiedSeats.add(s);
        }
      }
    }

    if (healUpdates.length > 0) {
      await prisma.$transaction(healUpdates);
      console.log(`Self-healed ${healUpdates.length} missing/overlapping reservations in session ${id}`);
    }
    // --- End Self-Healing ---

    // Find the end_time of the entire booking for each reservation
    const bookingRefs = [...new Set(reservations.map(r => r.booking_ref))];
    const allRelatedReservations = await prisma.reservation.findMany({
      where: {
        booking_ref: { in: bookingRefs },
        status: 'confirmed'
      },
      include: {
        session: true
      }
    });

    const endTimeMap = {};
    allRelatedReservations.forEach(r => {
      if (!endTimeMap[r.booking_ref] || r.session.end_time > endTimeMap[r.booking_ref]) {
        endTimeMap[r.booking_ref] = r.session.end_time;
      }
    });

    const reservationsWithEndTime = reservations.map(r => ({
      ...r,
      booking_end_time: endTimeMap[r.booking_ref] || session.end_time
    }));

    res.json({
      session,
      reservations: reservationsWithEndTime
    });
  } catch (error) {
    console.error('Error fetching session seats:', error);
    res.status(500).json({ error: 'Failed to fetch session seats' });
  }
};

export const adminCreateReservation = async (req, res) => {
  const { session_ids, pax, name, phone, forceSplit, isForceWait, isWalkIn } = req.body;
  
  if (!Array.isArray(session_ids) || session_ids.length === 0 || !pax || pax <= 0) {
    return res.status(400).json({ error: 'Valid session_ids array and pax are required.' });
  }

  if (!name) {
    return res.status(400).json({ error: 'Name is required for manual booking.' });
  }

  try {
    const booking_ref = crypto.randomUUID();

    const result = await prisma.$transaction(async (tx) => {
      // 0. Handle user finding / creation
      let targetUser = null;
      if (phone) {
        targetUser = await tx.user.findFirst({
          where: { phone }
        });
      }

      if (!targetUser) {
        // Create manual user
        targetUser = await tx.user.create({
          data: {
            line_user_id: `manual_${crypto.randomUUID()}`,
            name,
            phone: phone || null
          }
        });
      }

      // 1. Get the requested sessions
      const requestedSessions = await tx.$queryRaw`
        SELECT id, max_capacity, session_date
        FROM "Session" 
        WHERE id IN (${Prisma.join(session_ids)}) 
        FOR UPDATE
      `;

      if (requestedSessions.length !== session_ids.length) {
        throw new Error('SOME_SESSIONS_NOT_FOUND');
      }

      const sessionDate = requestedSessions[0].session_date;

      // Lock ALL sessions for the same date to prevent race conditions across the day
      const allSessionsOfDay = await tx.$queryRaw`
        SELECT id
        FROM "Session"
        WHERE session_date = ${sessionDate}
        FOR UPDATE
      `;
      const allSessionIdsOfDay = allSessionsOfDay.map(s => s.id);

      // Fetch all confirmed reservations for the day
      const currentReservations = await tx.reservation.findMany({
        where: { session_id: { in: allSessionIdsOfDay }, status: 'confirmed' }
      });

      // Prepare the new reservation block
      const newReservationBlock = { 
        booking_ref: 'NEW_RES', 
        pax: parseInt(pax, 10), 
        session_ids: session_ids 
      };

      // Run Allocation algorithm or Force Wait
      let mySeats = [];
      const sessionUpdates = [];

      if (isForceWait === true || isForceWait === 'true') {
        let waitCounter = 1;
        const requestedSessionIdsSet = new Set(session_ids);
        for (const r of currentReservations) {
          if (requestedSessionIdsSet.has(r.session_id) && r.assigned_seats) {
            for (const s of r.assigned_seats) {
              if (s.startsWith('WAIT-')) {
                const num = parseInt(s.split('-')[1]);
                if (num >= waitCounter) waitCounter = num + 1;
              }
            }
          }
        }
        for (let i = 0; i < parseInt(pax, 10); i++) {
          mySeats.push(`WAIT-${waitCounter++}`);
        }
      } else {
        const allocResult = allocateSeats(currentReservations, newReservationBlock, forceSplit === true || forceSplit === 'true');

        if (!allocResult.success) {
          if (allocResult.error === 'INSUFFICIENT_SEATS') throw new Error('INSUFFICIENT_CAPACITY');
          if (allocResult.error === 'SPLIT_REQUIRED') throw new Error('SPLIT_REQUIRED');
          throw new Error('ALLOCATION_FAILED');
        }

        mySeats = allocResult.updates.find(u => u.booking_ref === 'NEW_RES').assigned_seats;

        for (const update of allocResult.updates) {
          if (update.booking_ref !== 'NEW_RES') {
            sessionUpdates.push(
              tx.reservation.updateMany({
                where: { booking_ref: update.booking_ref },
                data: { assigned_seats: update.assigned_seats }
              })
            );
          }
        }
      }

      const newReservationsData = [];
      const is_unlimited = req.body.isUnlimited === true || req.body.isUnlimited === 'true';
      const totalAmount = await calculateTotalAmount(tx, sessionDate, parseInt(pax, 10), session_ids.length, is_unlimited);

      for (const sessionId of session_ids) {
        newReservationsData.push({
          booking_ref,
          session_id: sessionId,
          user_id: targetUser.id,
          pax: parseInt(pax, 10),
          status: 'confirmed',
          assigned_seats: mySeats,
          is_force_split: forceSplit === true || forceSplit === 'true',
          is_walk_in: isWalkIn === true || isWalkIn === 'true',
          is_unlimited: is_unlimited,
          total_amount: totalAmount
        });
      }

      if (sessionUpdates.length > 0) {
        await Promise.all(sessionUpdates);
      }

      // Create the new reservations with their assigned seats
      const newReservations = await tx.reservation.createMany({
        data: newReservationsData
      });

      return { booking_ref, count: newReservations.count };
    });

    res.status(201).json({ message: 'Manual reservation successful', reservation: result });

  } catch (error) {
    console.error('Manual Reservation error:', error);
    if (error.message === 'SOME_SESSIONS_NOT_FOUND') {
      return res.status(404).json({ error: 'One or more sessions not found.' });
    }
    if (error.message === 'INSUFFICIENT_CAPACITY') {
      return res.status(400).json({ error: 'Not enough capacity remaining for one or more selected sessions.' });
    }
    if (error.message === 'SPLIT_REQUIRED') {
      return res.status(409).json({ error: '連續座位不足，同行者將被拆散。是否確認預約？' });
    }
    res.status(500).json({ error: 'Failed to create manual reservation.' });
  }
};

export const extendReservation = async (req, res) => {
  const { booking_ref } = req.params;
  const { session_ids, extendMode, forceSplit } = req.body;
  
  if (!Array.isArray(session_ids) || session_ids.length === 0) {
    return res.status(400).json({ error: 'Valid session_ids array is required.' });
  }

  try {
    const result = await prisma.$transaction(async (tx) => {
      // Find the existing reservation details
      const existingReservations = await tx.reservation.findMany({
        where: { booking_ref, status: 'confirmed' },
        orderBy: { session_id: 'desc' }
      });

      if (existingReservations.length === 0) {
        throw new Error('RESERVATION_NOT_FOUND');
      }

      const baseReservation = existingReservations[0];
      const { user_id, pax, assigned_seats, is_walk_in } = baseReservation;

      // Ensure sessions exist
      const sessions = await tx.session.findMany({
        where: { id: { in: session_ids } },
        include: { reservations: { where: { status: 'confirmed' }, select: { pax: true, assigned_seats: true } } }
      });

      if (sessions.length !== session_ids.length) {
        throw new Error('SOME_SESSIONS_NOT_FOUND');
      }

      let mySeats = [];
      const sessionUpdates = [];

      // Fetch current reservations for all affected sessions for allocator
      const allCurrentReservations = await tx.reservation.findMany({
        where: { session_id: { in: session_ids }, status: 'confirmed' }
      });

      if (extendMode === 'force_wait') {
        let maxWait = 0;
        for (const r of allCurrentReservations) {
          if (r.assigned_seats) {
            for (const seat of r.assigned_seats) {
              if (seat.startsWith('WAIT-')) {
                const num = parseInt(seat.replace('WAIT-', ''), 10);
                if (!isNaN(num) && num > maxWait) maxWait = num;
              }
            }
          }
        }
        let waitCounter = maxWait + 1;
        for (let i = 0; i < pax; i++) {
          mySeats.push(`WAIT-${waitCounter++}`);
        }
      } else {
        // Capacity check for non-wait modes
        for (const session of sessions) {
          const bookedPax = session.reservations.reduce((sum, res) => {
            if (res.assigned_seats && res.assigned_seats.length > 0 && res.assigned_seats[0].startsWith('WAIT')) {
              return sum;
            }
            return sum + res.pax;
          }, 0);
          if (session.max_capacity - bookedPax < pax) {
            throw new Error('INSUFFICIENT_CAPACITY');
          }
        }

        if (extendMode === 'keep_seat') {
          mySeats = assigned_seats || [];
        } else if (extendMode === 'system_allocate') {
          const newBlock = { booking_ref: 'NEW_RES', pax, session_ids };
          const allocResult = allocateSeats(allCurrentReservations, newBlock, forceSplit === true || forceSplit === 'true');
          
          if (!allocResult.success) {
            if (allocResult.error === 'INSUFFICIENT_SEATS') throw new Error('INSUFFICIENT_CAPACITY');
            if (allocResult.error === 'SPLIT_REQUIRED') throw new Error('SPLIT_REQUIRED');
            throw new Error('ALLOCATION_FAILED');
          }

          mySeats = allocResult.updates.find(u => u.booking_ref === 'NEW_RES').assigned_seats;

          for (const update of allocResult.updates) {
            if (update.booking_ref !== 'NEW_RES') {
              sessionUpdates.push(
                tx.reservation.updateMany({
                  where: { booking_ref: update.booking_ref },
                  data: { assigned_seats: update.assigned_seats }
                })
              );
            }
          }
        }
      }

      const is_unlimited = baseReservation.is_unlimited;
      const sessionDate = sessions[0].session_date;
      const totalAmount = await calculateTotalAmount(tx, sessionDate, pax, existingReservations.length + session_ids.length, is_unlimited);

      // Update total_amount for existing reservations
      await tx.reservation.updateMany({
        where: { booking_ref },
        data: { total_amount: totalAmount }
      });

      const newReservationsData = [];
      for (const sessionId of session_ids) {
        newReservationsData.push({
          booking_ref,
          session_id: sessionId,
          user_id,
          pax,
          status: 'confirmed',
          assigned_seats: mySeats,
          is_force_split: forceSplit === true || forceSplit === 'true',
          is_walk_in,
          is_unlimited,
          total_amount: totalAmount
        });
      }

      if (sessionUpdates.length > 0) {
        await Promise.all(sessionUpdates);
      }

      // Create the new extended reservations
      const newReservations = await tx.reservation.createMany({
        data: newReservationsData
      });

      // If keep_seat, we must trigger reshuffle NOW to push colliding reservations
      if (extendMode === 'keep_seat') {
        // We do this outside the createMany but inside the tx, but handleCollisionsAndReshuffle uses its own queries/txs.
        // Wait, handleCollisionsAndReshuffle uses `prisma` directly! We cannot run it inside `tx` if it uses `prisma`.
        // So we just return success, and we'll run reshuffle AFTER the tx commits!
      }

      return { count: newReservations.count };
    });

    if (extendMode === 'keep_seat') {
      await handleCollisionsAndReshuffle(session_ids, [booking_ref]);
    }

    res.status(201).json({ message: 'Reservation extended successfully', result });

  } catch (error) {
    console.error('Extend Reservation error:', error);
    if (error.message === 'RESERVATION_NOT_FOUND') {
      return res.status(404).json({ error: 'Original reservation not found.' });
    }
    if (error.message === 'SOME_SESSIONS_NOT_FOUND') {
      return res.status(404).json({ error: 'One or more sessions not found.' });
    }
    if (error.message === 'INSUFFICIENT_CAPACITY') {
      return res.status(400).json({ error: 'Not enough capacity remaining for one or more selected sessions.' });
    }
    if (error.message === 'SPLIT_REQUIRED') {
      return res.status(409).json({ error: '連續座位不足，同行者將被拆散。是否確認預約？' });
    }
    res.status(500).json({ error: 'Failed to extend reservation.' });
  }
};

export const updateAttendance = async (req, res) => {
  const { id: booking_ref } = req.params;
  const { attendance } = req.body; // 'checked_in', 'no_show', or null

  try {
    const updated = await prisma.reservation.updateMany({
      where: { booking_ref },
      data: { attendance }
    });

    if (updated.count === 0) {
      return res.status(404).json({ error: 'Reservation not found' });
    }

    res.json({ message: 'Attendance updated successfully', count: updated.count });
  } catch (error) {
    console.error('Error updating attendance:', error);
    res.status(500).json({ error: 'Failed to update attendance' });
  }
};

export const updatePaymentStatus = async (req, res) => {
  const { booking_ref } = req.params;
  const { is_paid } = req.body;

  if (typeof is_paid !== 'boolean') {
    return res.status(400).json({ error: 'Invalid payment status' });
  }

  try {
    let totalAmount = undefined;

    if (is_paid) {
      // Recalculate amount
      await prisma.$transaction(async (tx) => {
        const reservations = await tx.reservation.findMany({
          where: { booking_ref },
          include: { session: true }
        });
        
        if (reservations.length > 0) {
          const firstRes = reservations[0];
          const sessionDate = firstRes.session.session_date;
          const pax = firstRes.pax;
          const is_unlimited = firstRes.is_unlimited;
          
          totalAmount = await calculateTotalAmount(tx, sessionDate, pax, reservations.length, is_unlimited);
        }

        const updated = await tx.reservation.updateMany({
          where: { booking_ref },
          data: { is_paid, ...(totalAmount !== undefined && { total_amount: totalAmount }) }
        });

        if (updated.count === 0) {
          throw new Error('NOT_FOUND');
        }
      });
      res.json({ message: 'Payment status updated successfully', total_amount: totalAmount });
    } else {
      const updated = await prisma.reservation.updateMany({
        where: { booking_ref },
        data: { is_paid }
      });
      
      if (updated.count === 0) {
        return res.status(404).json({ error: 'Reservation not found' });
      }
      
      res.json({ message: 'Payment status updated successfully', count: updated.count });
    }
  } catch (error) {
    console.error('Error updating payment status:', error);
    if (error.message === 'NOT_FOUND') {
      return res.status(404).json({ error: 'Reservation not found' });
    }
    res.status(500).json({ error: 'Failed to update payment status' });
  }
};
