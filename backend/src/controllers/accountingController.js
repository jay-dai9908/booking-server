import prisma from '../prismaClient.js';
import { calculateTotalAmount } from './reservationController.js';

export const getAccountingSummary = async (req, res) => {
  const { start_date, end_date } = req.query;

  try {
    const start = start_date ? new Date(start_date) : new Date();
    if (!start_date) start.setHours(0, 0, 0, 0);

    const end = end_date ? new Date(end_date) : new Date();
    if (!end_date) end.setHours(23, 59, 59, 999);

    // Fetch confirmed (non-cancelled) reservations in this date range
    const reservations = await prisma.reservation.findMany({
      where: {
        status: { not: 'cancelled' },
        session: {
          session_date: {
            gte: start,
            lte: end
          }
        }
      },
      include: {
        session: true,
        user: {
          select: { id: true, name: true, phone: true }
        }
      },
      orderBy: {
        session: {
          start_time: 'asc'
        }
      }
    });

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
          session_date: r.session.session_date,
          sessions: [],
          is_unlimited: r.is_unlimited || false,
          is_paid: r.is_paid || false,
          total_amount: r.total_amount,
          paid_at: r.paid_at,
          payment_method: r.payment_method,
          promo_code: r.promo_code,
          discount_amount: r.discount_amount || 0,
          addons_amount: r.addons_amount || 0
        };
      }
      groups[ref].sessions.push(r.session);
    }

    const uniqueReservations = Object.values(groups);
    const activeBookingRefs = Object.keys(groups);

    // Fetch equipment bookings for these active booking refs
    const bookingEquipments = await prisma.bookingEquipment.findMany({
      where: { booking_ref: { in: activeBookingRefs } }
    });
    const eqAmountMap = {};
    bookingEquipments.forEach(be => {
      eqAmountMap[be.booking_ref] = (eqAmountMap[be.booking_ref] || 0) + (be.subtotal_price || 0);
    });
    for (const group of uniqueReservations) {
      group.equipment_amount = eqAmountMap[group.booking_ref] || 0;
    }

    let expectedRevenue = 0;
    let totalRevenue = 0;
    let paidCount = 0;
    let unpaidCount = 0;
    let paidPax = 0;
    let totalExpectedPax = 0;

    const dailyDataMap = {};

    for (const group of uniqueReservations) {
      let amount = group.total_amount;
      if (amount == null) {
        const baseSeating = await calculateTotalAmount(
          prisma,
          group.session_date,
          group.pax,
          group.sessions.length,
          group.is_unlimited
        );
        amount = Math.max(0, baseSeating + (group.equipment_amount || 0) + (group.addons_amount || 0) - (group.discount_amount || 0));
      }
      group.calculated_amount = amount;

      expectedRevenue += amount;
      totalExpectedPax += group.pax;

      const dateStr = group.session_date.toISOString().split('T')[0].substring(5).replace('-', '/'); // "MM/DD"
      if (!dailyDataMap[dateStr]) {
        dailyDataMap[dateStr] = {
          date: dateStr,
          revenue: 0,
          expected: 0
        };
      }
      dailyDataMap[dateStr].expected += amount;

      if (group.is_paid) {
        totalRevenue += amount;
        paidCount++;
        paidPax += group.pax;
        dailyDataMap[dateStr].revenue += amount;
      } else {
        unpaidCount++;
      }
    }

    const dailyData = Object.values(dailyDataMap).sort((a, b) => a.date.localeCompare(b.date));

    const bookingsBreakdown = uniqueReservations.map(g => {
      g.sessions.sort((a, b) => a.start_time.localeCompare(b.start_time));
      return {
        booking_ref: g.booking_ref,
        name: g.user?.name || '未知顧客',
        phone: g.user?.phone || '',
        session_date: g.session_date,
        start_time: g.sessions[0]?.start_time,
        end_time: g.sessions[g.sessions.length - 1]?.end_time,
        pax: g.pax,
        is_paid: g.is_paid,
        is_unlimited: g.is_unlimited,
        attendance: g.attendance,
        amount: g.calculated_amount,
        payment_method: g.payment_method || (g.is_paid ? 'cash' : ''),
        discount_amount: g.discount_amount || 0,
        addons_amount: g.addons_amount || 0,
        equipment_amount: g.equipment_amount || 0,
        promo_code: g.promo_code || null
      };
    });

    res.json({
      expectedRevenue,
      totalRevenue,
      pendingRevenue: Math.max(0, expectedRevenue - totalRevenue),
      totalOrders: uniqueReservations.length,
      paidCount,
      unpaidCount,
      totalExpectedPax,
      paidPax,
      avgPrice: totalExpectedPax > 0 ? Math.round(expectedRevenue / totalExpectedPax) : 0,
      dailyData,
      bookingsBreakdown
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
        status: { not: 'cancelled' },
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
    const ledgerRefs = [];
    ledgers.forEach(r => {
      if (!seenRefs.has(r.booking_ref)) {
        seenRefs.add(r.booking_ref);
        uniqueLedgers.push(r);
        ledgerRefs.push(r.booking_ref);
      }
    });

    const eqRecords = await prisma.bookingEquipment.findMany({
      where: { booking_ref: { in: ledgerRefs } }
    });
    const eqMap = {};
    eqRecords.forEach(e => {
      eqMap[e.booking_ref] = (eqMap[e.booking_ref] || 0) + (e.subtotal_price || 0);
    });

    const results = uniqueLedgers.map(r => ({
      ...r,
      equipment_amount: eqMap[r.booking_ref] || 0
    }));

    res.json(results);
  } catch (error) {
    console.error('Error fetching ledger:', error);
    res.status(500).json({ error: 'Failed to fetch ledger' });
  }
};

export const getUnpaidFollowUp = async (req, res) => {
  try {
    // Unpaid orders where the session date is up to today
    // Helpful to find people who haven't paid.
    // Filter from 2026-06-28 onwards since this feature was added then
    const end = new Date();
    end.setHours(23, 59, 59, 999);
    
    const start = new Date('2026-06-28T00:00:00Z');

    const unpaid = await prisma.reservation.findMany({
      where: {
        status: { not: 'cancelled' },
        is_paid: false,
        attendance: 'checked_in',
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
