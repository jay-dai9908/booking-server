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
        user: r.user,
        pax: r.pax,
        status: r.status,
        attendance: r.attendance,
        created_at: r.created_at,
        session_date: r.session.session_date,
        sessions: [],
        assigned_seats: r.assigned_seats || [],
        is_seat_locked: r.is_seat_locked || false
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
      is_seat_locked: group.is_seat_locked
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
      // 1. Get the sessions and lock the rows (Pessimistic Lock)
      const sessions = await tx.$queryRaw`
        SELECT id, max_capacity 
        FROM "Session" 
        WHERE id IN (${Prisma.join(session_ids)}) 
        FOR UPDATE
      `;
      
      if (sessions.length !== session_ids.length) {
        throw new Error('SOME_SESSIONS_NOT_FOUND');
      }

      // We need to perform the seating algorithm for EACH selected session independently,
      // because different sessions might have different reservations and empty seats.
      const sessionUpdates = []; // Collect all updates to perform later
      const newReservationsData = [];

      for (const session of sessions) {
        // Fetch all confirmed reservations for this session to know current seating
        const currentReservations = await tx.reservation.findMany({
          where: { session_id: session.id, status: 'confirmed' }
        });

        // The new reservation we are trying to place
        const newReservationMock = { id: 'NEW_RES', pax: parseInt(pax, 10), assigned_seats: null };

        // Run the Smart Local Reshuffle algorithm
        const allocResult = allocateSeats(currentReservations, newReservationMock, forceSplit);

        if (!allocResult.success) {
          if (allocResult.error === 'INSUFFICIENT_SEATS') throw new Error('INSUFFICIENT_CAPACITY');
          if (allocResult.error === 'SPLIT_REQUIRED') throw new Error('SPLIT_REQUIRED');
          throw new Error('ALLOCATION_FAILED');
        }

        // Store the newly calculated seats for the new reservation
        const mySeats = allocResult.updates.find(u => u.id === 'NEW_RES').assigned_seats;
        newReservationsData.push({
          booking_ref,
          session_id: session.id,
          user_id: userId,
          pax: parseInt(pax, 10),
          status: 'confirmed',
          assigned_seats: mySeats,
          is_force_split: forceSplit === true
        });

        // Collect updates for existing reservations that got reshuffled
        allocResult.updates.forEach(update => {
          if (update.id !== 'NEW_RES') {
            sessionUpdates.push({ id: update.id, assigned_seats: update.assigned_seats });
          }
        });
      }

      // 3. Apply Reshuffle Updates to existing reservations
      for (const update of sessionUpdates) {
        await tx.reservation.update({
          where: { id: update.id },
          data: { assigned_seats: update.assigned_seats }
        });
      }

      // 4. Create the new reservations with their assigned seats
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
    const reservations = await prisma.reservation.findMany({
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

    const grouped = groupReservations(reservations);
    res.json(grouped);
  } catch (error) {
    console.error('Error fetching reservations:', error);
    res.status(500).json({ error: 'Failed to fetch reservations' });
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
  const { id } = req.body; // id of the reservation to update
  const { assigned_seats } = req.body;

  if (!id || !assigned_seats || !Array.isArray(assigned_seats)) {
    return res.status(400).json({ error: 'Valid reservation id and assigned_seats array are required.' });
  }

  try {
    const updated = await prisma.reservation.update({
      where: { id: parseInt(id, 10) },
      data: {
        assigned_seats,
        is_seat_locked: true // Lock the seat so it's not moved by the algorithm
      }
    });

    res.json({ message: 'Seat moved successfully', reservation: updated });
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

    res.json({
      session,
      reservations
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

      // 1. Get the sessions and lock the rows (Pessimistic Lock)
      const sessions = await tx.$queryRaw`
        SELECT id, max_capacity 
        FROM "Session" 
        WHERE id IN (${Prisma.join(session_ids)}) 
        FOR UPDATE
      `;
      
      if (sessions.length !== session_ids.length) {
        throw new Error('SOME_SESSIONS_NOT_FOUND');
      }

      const sessionUpdates = []; 
      const newReservationsData = [];

      // 2. Perform the seating algorithm for EACH selected session independently
      for (const session of sessions) {
        const currentReservations = await tx.reservation.findMany({
          where: { session_id: session.id, status: 'confirmed' }
        });

        const newReservationMock = { id: 'NEW_RES', pax: parseInt(pax, 10), assigned_seats: null };

        // For admin, we might pass true to forceSplit directly if we don't want the prompt,
        // but let's support it similarly to user side.
        const allocResult = allocateSeats(currentReservations, newReservationMock, forceSplit || false);

        if (!allocResult.success) {
          if (allocResult.error === 'INSUFFICIENT_SEATS') throw new Error('INSUFFICIENT_CAPACITY');
          if (allocResult.error === 'SPLIT_REQUIRED') throw new Error('SPLIT_REQUIRED');
          throw new Error('ALLOCATION_FAILED');
        }

        const mySeats = allocResult.updates.find(u => u.id === 'NEW_RES').assigned_seats;
        newReservationsData.push({
          booking_ref,
          session_id: session.id,
          user_id: targetUser.id,
          pax: parseInt(pax, 10),
          status: 'confirmed',
          assigned_seats: mySeats,
          is_force_split: forceSplit === true
        });

        allocResult.updates.forEach(update => {
          if (update.id !== 'NEW_RES') {
            sessionUpdates.push({ id: update.id, assigned_seats: update.assigned_seats });
          }
        });
      }

      // 3. Apply Reshuffle Updates to existing reservations
      for (const update of sessionUpdates) {
        await tx.reservation.update({
          where: { id: update.id },
          data: { assigned_seats: update.assigned_seats }
        });
      }

      // 4. Create the new reservations
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
