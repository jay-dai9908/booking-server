import prisma from '../prismaClient.js';

export const getSessions = async (req, res) => {
  const { date, start_date, end_date } = req.query; 
  
  if (!date && (!start_date || !end_date)) {
    return res.status(400).json({ error: 'Date or start_date/end_date query parameters are required' });
  }

  try {
    let whereClause = {};
    if (date) {
      whereClause.session_date = new Date(date);
    } else {
      whereClause.session_date = {
        gte: new Date(start_date),
        lte: new Date(end_date)
      };
    }
    
    // Fetch sessions
    const sessions = await prisma.session.findMany({
      where: whereClause,
      include: {
        reservations: {
          where: { status: 'confirmed' },
          select: { pax: true },
        },
      },
      orderBy: [
        { session_date: 'asc' },
        { start_time: 'asc' }
      ]
    });

    // Calculate remaining capacity
    const formattedSessions = sessions.map(session => {
      const bookedPax = session.reservations.reduce((sum, res) => sum + res.pax, 0);
      return {
        id: session.id,
        session_date: session.session_date,
        start_time: session.start_time,
        end_time: session.end_time,
        max_capacity: session.max_capacity,
        remaining_capacity: session.max_capacity - bookedPax
      };
    });

    res.json(formattedSessions);
  } catch (error) {
    console.error('Error fetching sessions:', error);
    res.status(500).json({ error: 'Failed to fetch sessions' });
  }
};

export const createBulkSessions = async (req, res) => {
  const { session_dates, session_date, start_time, end_time, max_capacity } = req.body;
  const dates = session_dates || (session_date ? [session_date] : []);

  if (dates.length === 0 || !start_time || !end_time || max_capacity === undefined) {
    return res.status(400).json({ error: 'All fields are required' });
  }

  try {
    const startHour = parseInt(start_time.split(':')[0], 10);
    const endHour = parseInt(end_time.split(':')[0], 10);
    
    if (startHour >= endHour) {
      return res.status(400).json({ error: 'End time must be after start time' });
    }

    const sessionsToCreate = [];
    
    for (const d of dates) {
      const targetDate = new Date(d);
      for (let h = startHour; h < endHour; h++) {
        sessionsToCreate.push({
          session_date: targetDate,
          start_time: `${h.toString().padStart(2, '0')}:00`,
          end_time: `${(h + 1).toString().padStart(2, '0')}:00`,
          max_capacity: parseInt(max_capacity, 10),
        });
      }
    }

    // Use transaction with upsert to overwrite old ones if they exist
    await prisma.$transaction(
      sessionsToCreate.map(session => 
        prisma.session.upsert({
          where: {
            session_date_start_time: {
              session_date: session.session_date,
              start_time: session.start_time
            }
          },
          update: {
            max_capacity: session.max_capacity,
            end_time: session.end_time
          },
          create: session
        })
      )
    );

    res.status(201).json({ message: 'Sessions created or updated successfully', count: sessionsToCreate.length });
  } catch (error) {
    console.error('Error creating sessions:', error);
    res.status(500).json({ error: 'Failed to create/update sessions' });
  }
};

export const deleteSession = async (req, res) => {
  const { id } = req.params;

  try {
    const session = await prisma.session.findUnique({
      where: { id: parseInt(id) },
      include: {
        reservations: {
          where: { status: 'confirmed' }
        }
      }
    });

    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    if (session.reservations.length > 0) {
      return res.status(400).json({ error: 'Cannot delete session with confirmed reservations' });
    }

    // Delete session and any cancelled reservations safely
    await prisma.$transaction([
      prisma.reservation.deleteMany({ where: { session_id: session.id } }),
      prisma.session.delete({ where: { id: parseInt(id) } })
    ]);

    res.json({ message: 'Session deleted successfully' });
  } catch (error) {
    console.error('Error deleting session:', error);
    res.status(500).json({ error: 'Failed to delete session' });
  }
};

export const deleteSessionsByDate = async (req, res) => {
  const { date } = req.params;

  try {
    const targetDate = new Date(date);

    // Find all sessions for this date
    const sessions = await prisma.session.findMany({
      where: { session_date: targetDate },
      include: {
        reservations: {
          where: { status: 'confirmed' }
        }
      }
    });

    if (sessions.length === 0) {
      return res.status(404).json({ error: 'No sessions found for this date.' });
    }

    // Filter sessions that can be deleted (no confirmed reservations)
    const sessionsToDelete = sessions.filter(s => s.reservations.length === 0);
    const sessionsKept = sessions.length - sessionsToDelete.length;

    if (sessionsToDelete.length === 0) {
      return res.status(400).json({ error: 'All sessions on this date have confirmed reservations and cannot be deleted.' });
    }

    // Delete them
    const deleteResult = await prisma.session.deleteMany({
      where: {
        id: { in: sessionsToDelete.map(s => s.id) }
      }
    });

    // Also delete cancelled reservations associated with these sessions to clean up
    await prisma.reservation.deleteMany({
      where: {
        session_id: { in: sessionsToDelete.map(s => s.id) },
        status: 'cancelled'
      }
    });

    res.json({ 
      message: 'Sessions cleared successfully', 
      deletedCount: deleteResult.count,
      keptCount: sessionsKept
    });
  } catch (error) {
    console.error('Error clearing sessions by date:', error);
    res.status(500).json({ error: 'Failed to clear sessions' });
  }
};
