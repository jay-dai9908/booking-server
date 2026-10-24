import prisma from '../prismaClient.js';
import { sendLinePushMessage, buildBrandFlexMessage, formatBookingRef } from '../utils/lineMessaging.js';

/**
 * Compute dual-track member statistics from a user's raw reservation rows.
 * Groups by booking_ref first so multi-hour bookings are evaluated per order.
 * Only completed/valid visits (status === 'confirmed' && (attendance === 'checked_in' || is_paid === true))
 * are counted toward consumption & hours metrics.
 */
export const computeUserDualStats = (reservations = []) => {
  const orderMap = {};

  for (const r of reservations) {
    const ref = r.booking_ref;
    if (!orderMap[ref]) {
      orderMap[ref] = {
        booking_ref: ref,
        pax: r.pax || 1,
        status: r.status,
        attendance: r.attendance,
        is_unlimited: !!r.is_unlimited,
        is_paid: !!r.is_paid,
        total_amount: r.total_amount ?? 0,
        checkout_unlimited_pax: r.checkout_unlimited_pax,
        checkout_regular_hours: r.checkout_regular_hours,
        session_count: 1
      };
    } else {
      orderMap[ref].session_count += 1;
      if (r.attendance === 'checked_in') {
        orderMap[ref].attendance = 'checked_in';
      } else if (!orderMap[ref].attendance && r.attendance) {
        orderMap[ref].attendance = r.attendance;
      }
      if (r.is_paid) {
        orderMap[ref].is_paid = true;
      }
      if (r.is_unlimited) {
        orderMap[ref].is_unlimited = true;
      }
      if (r.total_amount != null) {
        orderMap[ref].total_amount = r.total_amount;
      }
      if (r.checkout_unlimited_pax != null) {
        orderMap[ref].checkout_unlimited_pax = r.checkout_unlimited_pax;
      }
      if (r.checkout_regular_hours != null) {
        orderMap[ref].checkout_regular_hours = r.checkout_regular_hours;
      }
    }
  }

  let unlimited_pax_count = 0;      // 不限時(封頂)累計人次 (考慮人數)
  let unlimited_orders_count = 0;   // 不限時(封頂)訂單筆數
  let regular_person_hours = 0;     // 一般計時累計人時 (人數 × 時數 或 拆帳實際計時總時數)
  let regular_pure_hours = 0;       // 一般計時純時段小時數
  let regular_orders_count = 0;     // 一般計時訂單筆數
  let completed_visits_count = 0;   // 實際到訪/結帳完成總筆數
  let total_spent = 0;              // 累計消費總金額
  let no_show_count = 0;            // 爽約未到筆數
  let cancelled_count = 0;          // 取消筆數

  for (const order of Object.values(orderMap)) {
    if (order.status === 'cancelled') {
      cancelled_count += 1;
      continue;
    }

    if (order.attendance === 'no_show') {
      no_show_count += 1;
      continue;
    }

    // Count only checked-in or paid orders as valid completed visits
    if (order.attendance === 'checked_in' || order.is_paid) {
      completed_visits_count += 1;
      total_spent += Number(order.total_amount || 0);

      const hasSplitOverride = order.checkout_unlimited_pax != null || order.checkout_regular_hours != null;

      if (hasSplitOverride) {
        const uPax = Number(order.checkout_unlimited_pax || 0);
        const rHours = Number(order.checkout_regular_hours || 0);
        if (uPax > 0) {
          unlimited_pax_count += uPax;
          unlimited_orders_count += 1;
        }
        if (rHours > 0) {
          regular_person_hours += rHours;
          regular_pure_hours += order.session_count;
          regular_orders_count += 1;
        }
      } else {
        if (order.is_unlimited) {
          unlimited_pax_count += Number(order.pax || 1);
          unlimited_orders_count += 1;
        } else {
          const pax = Number(order.pax || 1);
          const hours = Number(order.session_count || 1);
          regular_person_hours += pax * hours;
          regular_pure_hours += hours;
          regular_orders_count += 1;
        }
      }
    }
  }

  // Round to 1 decimal place to avoid floating point artifacts for 0.5h extensions
  regular_person_hours = Math.round(regular_person_hours * 10) / 10;

  return {
    unlimited_pax_count,
    unlimited_orders_count,
    regular_person_hours,
    regular_pure_hours,
    regular_orders_count,
    completed_visits_count,
    total_spent,
    no_show_count,
    cancelled_count
  };
};

export const getUsers = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const search = (req.query.search || '').trim();
    
    const skip = (page - 1) * limit;

    let whereClause = {};
    if (search) {
      whereClause = {
        OR: [
          { name: { contains: search, mode: 'insensitive' } },
          { phone: { contains: search, mode: 'insensitive' } },
          { line_display_name: { contains: search, mode: 'insensitive' } }
        ]
      };
    }

    const [users, total] = await Promise.all([
      prisma.user.findMany({
        where: whereClause,
        orderBy: { created_at: 'desc' },
        skip,
        take: limit,
        select: {
          id: true,
          line_user_id: true,
          name: true,
          phone: true,
          line_display_name: true,
          line_picture_url: true,
          line_status_msg: true,
          last_login_at: true,
          created_at: true,
          is_blacklisted: true,
          notes: true,
          reservations: {
            select: {
              booking_ref: true,
              pax: true,
              status: true,
              attendance: true,
              is_unlimited: true,
              is_paid: true,
              total_amount: true,
              checkout_unlimited_pax: true,
              checkout_regular_hours: true
            }
          }
        }
      }),
      prisma.user.count({ where: whereClause })
    ]);

    const enrichedUsers = users.map(u => {
      const stats = computeUserDualStats(u.reservations);
      const { reservations, ...userWithoutReservations } = u;
      return {
        ...userWithoutReservations,
        stats
      };
    });

    res.json({
      data: enrichedUsers,
      total,
      page,
      totalPages: Math.ceil(total / limit)
    });
  } catch (error) {
    console.error('Error fetching users:', error);
    res.status(500).json({ error: 'Failed to fetch users' });
  }
};

export const getUserById = async (req, res) => {
  try {
    const userId = parseInt(req.params.id, 10);
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        line_user_id: true,
        name: true,
        phone: true,
        line_display_name: true,
        line_picture_url: true,
        line_status_msg: true,
        last_login_at: true,
        created_at: true,
        is_blacklisted: true,
        notes: true,
        reservations: {
          select: {
            booking_ref: true,
            pax: true,
            status: true,
            attendance: true,
            is_unlimited: true,
            is_paid: true,
            total_amount: true,
            checkout_unlimited_pax: true,
            checkout_regular_hours: true
          }
        }
      }
    });

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const stats = computeUserDualStats(user.reservations);
    const { reservations, ...userWithoutReservations } = user;

    res.json({
      ...userWithoutReservations,
      stats
    });
  } catch (error) {
    console.error('Error fetching user:', error);
    res.status(500).json({ error: 'Failed to fetch user' });
  }
};

export const getUserReservations = async (req, res) => {
  const { id } = req.params;
  try {
    const reservations = await prisma.reservation.findMany({
      where: { user_id: parseInt(id, 10) },
      include: {
        session: true
      },
      orderBy: {
        session: {
          session_date: 'desc'
        }
      }
    });

    const bookingRefs = Array.from(new Set(reservations.map(r => r.booking_ref)));
    const bookingEquipments = await prisma.bookingEquipment.findMany({
      where: { booking_ref: { in: bookingRefs } },
      include: { equipment: true }
    });

    const eqMap = {};
    bookingEquipments.forEach(be => {
      if (!eqMap[be.booking_ref]) {
        eqMap[be.booking_ref] = [];
      }
      eqMap[be.booking_ref].push(be);
    });

    const enrichedReservations = reservations.map(r => ({
      ...r,
      equipments: eqMap[r.booking_ref] || []
    }));

    res.json(enrichedReservations);
  } catch (error) {
    console.error('Error fetching user reservations:', error);
    res.status(500).json({ error: 'Failed to fetch user reservations' });
  }
};

export const getUserLoginLogs = async (req, res) => {
  const { id } = req.params;
  try {
    const userId = parseInt(id, 10);
    const sixtyDaysAgo = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);

    // Clean up any logs older than 60 days (2 months)
    await prisma.userLoginLog.deleteMany({
      where: {
        created_at: { lt: sixtyDaysAgo }
      }
    });

    const [logs, bannedIps] = await Promise.all([
      prisma.userLoginLog.findMany({
        where: {
          user_id: userId,
          created_at: { gte: sixtyDaysAgo }
        },
        orderBy: { created_at: 'desc' },
        take: 100
      }),
      prisma.bannedIP.findMany({
        select: { ip: true }
      })
    ]);

    const bannedSet = new Set(bannedIps.map(b => b.ip));
    const enrichedLogs = logs.map(log => ({
      ...log,
      is_ip_banned: log.ip_address ? bannedSet.has(log.ip_address) : false
    }));

    res.json(enrichedLogs);
  } catch (error) {
    console.error('Error fetching user login logs:', error);
    res.status(500).json({ error: 'Failed to fetch user login logs' });
  }
};

export const updateUser = async (req, res) => {
  const { id } = req.params;
  const { name, phone, is_blacklisted, notes } = req.body;
  
  try {
    const userId = parseInt(id, 10);
    const dataToUpdate = {};

    if (name !== undefined) {
      const trimmedName = String(name).trim();
      if (!trimmedName) {
        return res.status(400).json({ error: '會員姓名不可為空白' });
      }
      dataToUpdate.name = trimmedName;
    }

    if (phone !== undefined) {
      const trimmedPhone = String(phone).trim();
      dataToUpdate.phone = trimmedPhone || null;
    }

    if (is_blacklisted !== undefined) {
      dataToUpdate.is_blacklisted = Boolean(is_blacklisted);
    }

    if (notes !== undefined) {
      dataToUpdate.notes = notes;
    }

    const updatedUser = await prisma.user.update({
      where: { id: userId },
      data: dataToUpdate,
      select: {
        id: true,
        line_user_id: true,
        name: true,
        phone: true,
        line_display_name: true,
        line_picture_url: true,
        line_status_msg: true,
        last_login_at: true,
        created_at: true,
        is_blacklisted: true,
        notes: true,
        reservations: {
          select: {
            booking_ref: true,
            pax: true,
            status: true,
            attendance: true,
            is_unlimited: true,
            is_paid: true,
            total_amount: true,
            checkout_unlimited_pax: true,
            checkout_regular_hours: true
          }
        }
      }
    });

    const stats = computeUserDualStats(updatedUser.reservations);
    const { reservations, ...userWithoutReservations } = updatedUser;

    res.json({
      message: 'User updated successfully',
      user: {
        ...userWithoutReservations,
        stats
      }
    });
  } catch (error) {
    console.error('Error updating user:', error);
    res.status(500).json({ error: 'Failed to update user' });
  }
};

/**
 * Send a direct LINE message to a specific user
 */
export const sendLineMessageToUser = async (req, res) => {
  const userId = parseInt(req.params.id, 10);
  const { message_type, title, content, booking_info } = req.body;

  if (isNaN(userId)) {
    return res.status(400).json({ error: '無效的會員 ID' });
  }

  if (!content || !content.trim()) {
    return res.status(400).json({ error: '請輸入訊息內容' });
  }

  try {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        name: true,
        phone: true,
        line_user_id: true,
        line_display_name: true
      }
    });

    if (!user) {
      return res.status(404).json({ error: '找不到該會員資料' });
    }

    if (!user.line_user_id || user.line_user_id.startsWith('manual_')) {
      return res.status(400).json({ error: '此會員為櫃檯手動建檔，尚未綁定真實 LINE 帳號，無法發送 LINE 訊息' });
    }

    let linePayload;
    if (message_type === 'flex') {
      const infoRows = [];
      if (booking_info) {
        if (booking_info.booking_ref) {
          infoRows.push({
            label: '相關預約',
            value: formatBookingRef(booking_info.booking_ref)
          });
        }
        if (booking_info.session_date) {
          infoRows.push({
            label: '預約日期',
            value: booking_info.session_date
          });
        }
        if (booking_info.time_range) {
          infoRows.push({
            label: '預約時段',
            value: booking_info.time_range
          });
        }
      }

      const frontendUrl = process.env.FRONTEND_URL || 'https://shiguangstudio.com';
      linePayload = buildBrandFlexMessage({
        title: title || '拾光製所 會員專屬通知',
        subtitle: `發送對象：${user.name || user.line_display_name || '顧客'}`,
        bodyText: content.trim(),
        infoRows,
        buttonLabel: '開啟拾光製所預約系統',
        buttonUrl: `${frontendUrl}/history`,
        tagText: '門市通知'
      });
    } else {
      linePayload = {
        type: 'text',
        text: content.trim()
      };
    }

    await sendLinePushMessage(user.line_user_id, [linePayload]);

    res.json({ message: 'LINE 訊息已成功發送至顧客手機！' });
  } catch (error) {
    console.error('sendLineMessageToUser error:', error);
    const statusCode = error.status || 500;
    res.status(statusCode).json({ error: error.message || '發送 LINE 訊息失敗' });
  }
};

