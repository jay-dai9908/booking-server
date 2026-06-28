import prisma from '../prismaClient.js';

export const getAccountingSummary = async (req, res) => {
  const { start_date, end_date } = req.query;

  try {
    const start = start_date ? new Date(start_date) : new Date();
    if (!start_date) start.setHours(0, 0, 0, 0);

    const end = end_date ? new Date(end_date) : new Date();
    if (!end_date) end.setHours(23, 59, 59, 999);

    // We only care about reservations where the SESSION falls in this date range.
    // And for revenue, only those that are PAID.
    const reservations = await prisma.reservation.findMany({
      where: {
        session: {
          session_date: {
            gte: start,
            lte: end
          }
        }
      },
      include: {
        session: true
      }
    });

    let totalRevenue = 0;
    let paidCount = 0;
    let unpaidCount = 0;
    let totalPax = 0;

    const seenRefs = new Set();
    const uniqueReservations = [];
    reservations.forEach(r => {
      if (!seenRefs.has(r.booking_ref)) {
        seenRefs.add(r.booking_ref);
        uniqueReservations.push(r);
      }
    });

    uniqueReservations.forEach(r => {
      if (r.is_paid) {
        totalRevenue += (r.total_amount || 0);
        paidCount++;
        totalPax += r.pax;
      } else {
        unpaidCount++;
      }
    });

    res.json({
      totalRevenue,
      paidCount,
      unpaidCount,
      totalPax,
      avgPrice: totalPax > 0 ? Math.round(totalRevenue / totalPax) : 0
    });
  } catch (error) {
    console.error('Error fetching accounting summary:', error);
    res.status(500).json({ error: 'Failed to fetch accounting summary' });
  }
};

export const getLedger = async (req, res) => {
  const { start_date, end_date } = req.query;

  try {
    const start = start_date ? new Date(start_date) : new Date();
    if (!start_date) start.setHours(0, 0, 0, 0);

    const end = end_date ? new Date(end_date) : new Date();
    if (!end_date) end.setHours(23, 59, 59, 999);

    const ledgers = await prisma.reservation.findMany({
      where: {
        is_paid: true,
        session: {
          session_date: {
            gte: start,
            lte: end
          }
        }
      },
      include: {
        user: true,
        session: true
      },
      orderBy: {
        paid_at: 'desc'
      }
    });

    const seenRefs = new Set();
    const uniqueLedgers = [];
    ledgers.forEach(r => {
      if (!seenRefs.has(r.booking_ref)) {
        seenRefs.add(r.booking_ref);
        uniqueLedgers.push(r);
      }
    });

    res.json(uniqueLedgers);
  } catch (error) {
    console.error('Error fetching ledger:', error);
    res.status(500).json({ error: 'Failed to fetch ledger' });
  }
};

export const getUnpaidFollowUp = async (req, res) => {
  try {
    // Unpaid orders where the session date is up to today
    // Helpful to find people who haven't paid.
    const end = new Date();
    end.setHours(23, 59, 59, 999);

    const unpaid = await prisma.reservation.findMany({
      where: {
        is_paid: false,
        attendance: 'checked_in',
        session: {
          session_date: {
            lte: end
          }
        }
      },
      include: {
        user: true,
        session: true
      },
      orderBy: {
        session: {
          session_date: 'desc'
        }
      }
    });

    const seenRefs = new Set();
    const uniqueUnpaid = [];
    unpaid.forEach(r => {
      if (!seenRefs.has(r.booking_ref)) {
        seenRefs.add(r.booking_ref);
        uniqueUnpaid.push(r);
      }
    });

    res.json(uniqueUnpaid);
  } catch (error) {
    console.error('Error fetching unpaid follow up:', error);
    res.status(500).json({ error: 'Failed to fetch unpaid follow up' });
  }
};
