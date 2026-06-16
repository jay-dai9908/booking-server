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
        is_force_split: r.is_force_split || false
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
      session_count: group.sessions.length,
      assigned_seats: group.assigned_seats,
      is_seat_locked: group.is_seat_locked,
      is_force_split: group.is_force_split
    };
  });
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

      for (const sessionId of session_ids) {
        newReservationsData.push({
          booking_ref,
          session_id: sessionId,
          user_id: userId,
          pax: parseInt(pax, 10),
          status: 'confirmed',
          assigned_seats: mySeats,
          is_force_split: forceSplit === true
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
    const search = req.query.search || '';
    const month = req.query.month; // format: 'YYYY-MM'

    let whereClause = {};

    if (month && !search) {
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
    
    // Sort grouped reservations by session_date descending, then start_time descending
    grouped.sort((a, b) => {
      if (a.session_date > b.session_date) return -1;
      if (a.session_date < b.session_date) return 1;
      return b.start_time.localeCompare(a.start_time);
    });

    const total = grouped.length;
    const totalPages = Math.ceil(total / limit);
    const paginatedData = grouped.slice((page - 1) * limit, page * limit);

    res.json({
      data: paginatedData,
      total,
      page,
      totalPages
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
        session: true
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
      data: { status: 'cancelled' }
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

export const moveSeat = async (req, res) => {
  const { id } = req.body; // id of the specific session's reservation that was clicked
  const { assigned_seats } = req.body;

  if (!id || !assigned_seats || !Array.isArray(assigned_seats)) {
    return res.status(400).json({ error: 'Valid reservation id and assigned_seats array are required.' });
  }

  try {
    const targetRes = await prisma.reservation.findUnique({ where: { id: parseInt(id, 10) } });
    if (!targetRes) {
      return res.status(404).json({ error: 'Reservation not found' });
    }

    // Find all reservations for this booking_ref
    const group = await prisma.reservation.findMany({ 
      where: { booking_ref: targetRes.booking_ref }
    });
    const sessionIds = group.map(r => r.session_id);

    // Check for collisions in ANY of the involved sessions
    const conflicts = await prisma.reservation.findMany({
      where: {
        session_id: { in: sessionIds },
        booking_ref: { not: targetRes.booking_ref },
        status: 'confirmed'
      }
    });

    const isConflict = conflicts.some(c => 
      c.assigned_seats && c.assigned_seats.some(seat => assigned_seats.includes(seat))
    );

    if (isConflict) {
      return res.status(400).json({ 
        error: '目標座位在該顧客的其他預約時段中已被佔用。請確保新座位在該筆訂單的所有時段中皆為空位。' 
      });
    }

    // Update ALL reservations for this booking_ref
    const updated = await prisma.reservation.updateMany({
      where: { booking_ref: targetRes.booking_ref },
      data: {
        assigned_seats,
        is_seat_locked: true // Lock the seat so it's not moved by the algorithm
      }
    });

    // Return the updated single reservation for frontend compatibility
    const singleUpdated = await prisma.reservation.findUnique({ where: { id: parseInt(id, 10) } });

    res.json({ message: 'Seat moved successfully', reservation: singleUpdated });
  } catch (error) {
    console.error('Error moving seat:', error);
    res.status(500).json({ error: 'Failed to move seat' });
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
  const { session_ids, pax, name, phone, forceSplit } = req.body;
  
  if (!Array.isArray(session_ids) || session_ids.length === 0 || !pax || pax <= 0) {
    return res.status(400).json({ error: 'Valid session_ids array and pax are required.' });
  }

  if (!name || !phone) {
    return res.status(400).json({ error: 'Name and phone are required for manual booking.' });
  }

  try {
    const booking_ref = crypto.randomUUID();

    const result = await prisma.$transaction(async (tx) => {
      // 0. Handle user finding / creation
      let targetUser = await tx.user.findFirst({
        where: { phone }
      });

      if (!targetUser) {
        // Create manual user
        targetUser = await tx.user.create({
          data: {
            line_user_id: `manual_${crypto.randomUUID()}`,
            name,
            phone
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

      // Run Continuous Block Allocation algorithm
      const allocResult = allocateSeats(currentReservations, newReservationBlock, forceSplit === true || forceSplit === 'true');

      if (!allocResult.success) {
        if (allocResult.error === 'INSUFFICIENT_SEATS') throw new Error('INSUFFICIENT_CAPACITY');
        if (allocResult.error === 'SPLIT_REQUIRED') throw new Error('SPLIT_REQUIRED');
        throw new Error('ALLOCATION_FAILED');
      }

      // Apply Reshuffle Updates to existing reservations
      const sessionUpdates = []; 
      const newReservationsData = [];
      
      const mySeats = allocResult.updates.find(u => u.booking_ref === 'NEW_RES').assigned_seats;

      for (const sessionId of session_ids) {
        newReservationsData.push({
          booking_ref,
          session_id: sessionId,
          user_id: targetUser.id,
          pax: parseInt(pax, 10),
          status: 'confirmed',
          assigned_seats: mySeats,
          is_force_split: forceSplit === true || forceSplit === 'true'
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
