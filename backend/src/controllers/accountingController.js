import prisma from '../prismaClient.js';
import { format, subDays, startOfDay, endOfDay } from 'date-fns';

export const getAccountingSummary = async (req, res) => {
  const { start_date, end_date } = req.query;

  try {
    const startDate = start_date ? new Date(start_date) : startOfDay(new Date());
    const endDate = end_date ? new Date(end_date) : endOfDay(new Date());

    // We only care about reservations where the SESSION falls in this date range.
    // And for revenue, only those that are PAID.
    const reservations = await prisma.reservation.findMany({
      where: {
        session: {
          session_date: {
            gte: startDate,
            lte: endDate
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

    reservations.forEach(r => {
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
    const startDate = start_date ? new Date(start_date) : startOfDay(new Date());
    const endDate = end_date ? new Date(end_date) : endOfDay(new Date());

    const ledgers = await prisma.reservation.findMany({
      where: {
        is_paid: true,
        session: {
          session_date: {
            gte: startDate,
            lte: endDate
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

    res.json(ledgers);
  } catch (error) {
    console.error('Error fetching ledger:', error);
    res.status(500).json({ error: 'Failed to fetch ledger' });
  }
};

export const getUnpaidFollowUp = async (req, res) => {
  try {
    // Unpaid orders where the session date is up to today
    // Helpful to find people who haven't paid.
    const endDate = endOfDay(new Date());

    const unpaid = await prisma.reservation.findMany({
      where: {
        is_paid: false,
        session: {
          session_date: {
            lte: endDate
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

    res.json(unpaid);
  } catch (error) {
    console.error('Error fetching unpaid follow up:', error);
    res.status(500).json({ error: 'Failed to fetch unpaid follow up' });
  }
};
