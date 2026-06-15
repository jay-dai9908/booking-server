import prisma from '../prismaClient.js';
import { Prisma } from '@prisma/client';
import crypto from 'crypto';

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
      session_count: group.sessions.length
    };
  });
};

export const createReservation = async (req, res) => {
  const { session_ids, pax } = req.body;
  const userId = req.user.id;

  if (!Array.isArray(session_ids) || session_ids.length === 0 || !pax || pax <= 0) {
    return res.status(400).json({ error: 'Valid session_ids array and pax are required.' });
  }

  try {
    const booking_ref = crypto.randomUUID();

    const reservation = await prisma.$transaction(async (tx) => {
      // 1. Get the sessions and lock the rows
      const sessions = await tx.$queryRaw`
        SELECT id, max_capacity 
        FROM "Session" 
        WHERE id IN (${Prisma.join(session_ids)}) 
        FOR UPDATE
      `;
      
      if (sessions.length !== session_ids.length) {
        throw new Error('SOME_SESSIONS_NOT_FOUND');
      }

      // 2. Check capacity for all selected sessions
      for (const session of sessions) {
        const booked = await tx.reservation.aggregate({
          where: { session_id: session.id, status: 'confirmed' },
          _sum: { pax: true }
        });
        
        const currentlyBookedPax = booked._sum.pax || 0;
        const remainingCapacity = session.max_capacity - currentlyBookedPax;

        if (remainingCapacity < pax) {
          throw new Error('INSUFFICIENT_CAPACITY');
        }
      }

      // 3. Create reservations
      const reservationsData = session_ids.map(s_id => ({
        booking_ref,
        session_id: s_id,
        user_id: userId,
        pax: parseInt(pax, 10),
        status: 'confirmed'
      }));

      const newReservations = await tx.reservation.createMany({
        data: reservationsData
      });

      return { booking_ref, count: newReservations.count };
    });

    res.status(201).json({ message: 'Reservation successful', reservation });

  } catch (error) {
    console.error('Reservation error:', error);
    if (error.message === 'SOME_SESSIONS_NOT_FOUND') {
      return res.status(404).json({ error: 'One or more sessions not found.' });
    }
    if (error.message === 'INSUFFICIENT_CAPACITY') {
      return res.status(409).json({ error: 'Not enough capacity remaining for one or more selected sessions.' });
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

export const adminCreateReservation = async (req, res) => {
  const { session_ids, pax, name, phone } = req.body;
  
  if (!Array.isArray(session_ids) || session_ids.length === 0 || !pax || pax <= 0) {
    return res.status(400).json({ error: 'Valid session_ids array and pax are required.' });
  }

  if (!name || !phone) {
    return res.status(400).json({ error: 'Name and phone are required for manual booking.' });
  }

  try {
    const booking_ref = crypto.randomUUID();

    const reservation = await prisma.$transaction(async (tx) => {
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

      // 1. Get the sessions and lock the rows
      const sessions = await tx.$queryRaw`
        SELECT id, max_capacity 
        FROM "Session" 
        WHERE id IN (${Prisma.join(session_ids)}) 
        FOR UPDATE
      `;
      
      if (sessions.length !== session_ids.length) {
        throw new Error('SOME_SESSIONS_NOT_FOUND');
      }

      // 2. Check capacity for all selected sessions
      for (const session of sessions) {
        const booked = await tx.reservation.aggregate({
          where: { session_id: session.id, status: 'confirmed' },
          _sum: { pax: true }
        });
        
        const currentlyBookedPax = booked._sum.pax || 0;
        const remainingCapacity = session.max_capacity - currentlyBookedPax;

        if (remainingCapacity < pax) {
          throw new Error('INSUFFICIENT_CAPACITY');
        }
      }

      // 3. Create reservations
      const reservationsData = session_ids.map(s_id => ({
        booking_ref,
        session_id: s_id,
        user_id: targetUser.id,
        pax: parseInt(pax, 10),
        status: 'confirmed'
      }));

      const newReservations = await tx.reservation.createMany({
        data: reservationsData
      });

      return { booking_ref, count: newReservations.count };
    });

    res.status(201).json({ message: 'Manual reservation successful', reservation });

  } catch (error) {
    console.error('Manual Reservation error:', error);
    if (error.message === 'SOME_SESSIONS_NOT_FOUND') {
      return res.status(404).json({ error: 'One or more sessions not found.' });
    }
    if (error.message === 'INSUFFICIENT_CAPACITY') {
      return res.status(409).json({ error: 'Not enough capacity remaining for one or more selected sessions.' });
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
