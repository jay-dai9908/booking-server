import prisma from '../prismaClient.js';
import { sendLinePushMessage, buildBrandFlexMessage, formatBookingRef } from '../utils/lineMessaging.js';
import { isPlainString } from '../utils/phone.js';
import { activeUserWhere } from '../utils/userQuery.js';
import auditService from '../services/audit/auditService.js';
import { dateOnly, toTaipeiDateString } from '../../../shared/time.js';

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
    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 20;
    const search = (req.query.search || '').trim();
    const includeMerged = req.query.include_merged === '1' || req.query.include_merged === 'true';
    const pendingBindOnly = req.query.pending_bind === '1' || req.query.pending_bind === 'true';

    const skip = (page - 1) * limit;

    const andConditions = [];
    if (!includeMerged) {
      andConditions.push(activeUserWhere());
    }
    if (search) {
      andConditions.push({
        OR: [
          { name: { contains: search, mode: 'insensitive' } },
          { phone: { contains: search, mode: 'insensitive' } },
          { line_display_name: { contains: search, mode: 'insensitive' } }
        ]
      });
    }
    if (pendingBindOnly) {
      andConditions.push({
        OR: [
          { bind_requests_as_new: { some: { status: 'pending' } } },
          { bind_requests_as_manual: { some: { status: 'pending' } } }
        ]
      });
    }

    const whereClause = andConditions.length > 0 ? { AND: andConditions } : {};

    const [users, total, pendingRequests] = await Promise.all([
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
          merged_into_user_id: true,
          merged_at: true,
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
      prisma.user.count({ where: whereClause }),
      prisma.memberBindRequest.findMany({
        where: { status: 'pending' },
        select: { id: true, new_user_id: true, manual_user_id: true }
      })
    ]);

    const pendingUserSet = new Set();
    for (const r of pendingRequests) {
      pendingUserSet.add(r.new_user_id);
      pendingUserSet.add(r.manual_user_id);
    }

    const enrichedUsers = users.map(u => {
      const stats = computeUserDualStats(u.reservations);
      const { reservations, ...userWithoutReservations } = u;
      return {
        ...userWithoutReservations,
        has_pending_bind: pendingUserSet.has(u.id),
        stats
      };
    });

    res.json({
      data: enrichedUsers,
      total,
      page,
      totalPages: Math.ceil(total / limit),
      pending_bind_requests_count: pendingRequests.length
    });
  } catch (error) {
    console.error('Error fetching users:', error);
    res.status(500).json({ error: 'Failed to fetch users' });
  }
};

export const getUserById = async (req, res) => {
  try {
    const userId = parseInt(req.params.id, 10);
    if (!Number.isInteger(userId) || userId <= 0) {
      return res.status(400).json({ error: '無效的會員 ID' });
    }
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
        merged_into_user_id: true,
        merged_at: true,
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
      if (!isPlainString(name)) {
        return res.status(400).json({ error: '會員姓名格式不正確' });
      }
      const trimmedName = name.trim();
      if (!trimmedName) {
        return res.status(400).json({ error: '會員姓名不可為空白' });
      }
      dataToUpdate.name = trimmedName;
    }

    if (phone !== undefined) {
      if (phone !== null && !isPlainString(phone)) {
        return res.status(400).json({ error: '電話號碼格式不正確' });
      }
      const trimmedPhone = phone === null ? '' : phone.trim();
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

async function enrichBindRequests(requests) {
  if (!requests || requests.length === 0) return [];
  const manualIds = [...new Set(requests.map((r) => r.manual_user_id))];
  const todayDate = dateOnly(toTaipeiDateString(new Date()));

  const [reservations, productOrders] = await Promise.all([
    prisma.reservation.findMany({
      where: { user_id: { in: manualIds } },
      select: {
        user_id: true,
        booking_ref: true,
        status: true,
        session: { select: { session_date: true } }
      }
    }),
    prisma.productOrder.groupBy({
      by: ['user_id'],
      where: { user_id: { in: manualIds } },
      _count: { _all: true }
    })
  ]);

  const resStatsByUser = new Map();
  for (const row of reservations) {
    if (!resStatsByUser.has(row.user_id)) {
      resStatsByUser.set(row.user_id, { allRefs: new Set(), futureRefs: new Set() });
    }
    const entry = resStatsByUser.get(row.user_id);
    if (row.status !== 'cancelled') {
      entry.allRefs.add(row.booking_ref);
      if (row.session?.session_date && row.session.session_date >= todayDate) {
        entry.futureRefs.add(row.booking_ref);
      }
    }
  }

  const orderCountByUser = new Map();
  for (const row of productOrders) {
    orderCountByUser.set(row.user_id, row._count?._all || 0);
  }

  return requests.map((reqRow) => {
    const resStats = resStatsByUser.get(reqRow.manual_user_id);
    return {
      ...reqRow,
      pass_summary: Array.isArray(reqRow.pass_summary) ? reqRow.pass_summary : [],
      manual_stats: {
        reservation_count: resStats ? resStats.allRefs.size : 0,
        future_reservation_count: resStats ? resStats.futureRefs.size : 0,
        product_order_count: orderCountByUser.get(reqRow.manual_user_id) || 0
      }
    };
  });
}

const BIND_USER_SELECT = {
  id: true,
  name: true,
  phone: true,
  line_user_id: true,
  line_display_name: true,
  line_picture_url: true,
  created_at: true,
  is_blacklisted: true,
  notes: true,
  merged_into_user_id: true
};

export const getBindRequests = async (req, res) => {
  try {
    const status = String(req.query.status || 'pending').trim();
    const where = status && status !== 'all' ? { status } : {};

    const rows = await prisma.memberBindRequest.findMany({
      where,
      include: {
        new_user: { select: BIND_USER_SELECT },
        manual_user: { select: BIND_USER_SELECT }
      },
      orderBy: [{ created_at: 'desc' }, { id: 'desc' }]
    });

    const enriched = await enrichBindRequests(rows);
    res.json({ total: enriched.length, requests: enriched });
  } catch (error) {
    console.error('getBindRequests error:', error);
    res.status(500).json({ error: '獲取帳號綁定申請列表失敗' });
  }
};

export const getUserBindRequests = async (req, res) => {
  const userId = parseInt(req.params.id, 10);
  if (!Number.isInteger(userId) || userId <= 0) {
    return res.status(400).json({ error: '無效的會員 ID' });
  }

  try {
    const rows = await prisma.memberBindRequest.findMany({
      where: {
        OR: [{ new_user_id: userId }, { manual_user_id: userId }]
      },
      include: {
        new_user: { select: BIND_USER_SELECT },
        manual_user: { select: BIND_USER_SELECT }
      },
      orderBy: [{ created_at: 'desc' }, { id: 'desc' }]
    });

    // Sort pending requests first
    rows.sort((a, b) => {
      if (a.status === 'pending' && b.status !== 'pending') return -1;
      if (a.status !== 'pending' && b.status === 'pending') return 1;
      return 0;
    });

    const enriched = await enrichBindRequests(rows);
    res.json({ requests: enriched });
  } catch (error) {
    console.error('getUserBindRequests error:', error);
    res.status(500).json({ error: '獲取會員綁定申請失敗' });
  }
};

export const approveBindRequest = async (req, res) => {
  const reqId = parseInt(req.params.id, 10);
  if (!Number.isInteger(reqId) || reqId <= 0) {
    return res.status(400).json({ error: '無效的申請 ID' });
  }

  const note = req.body?.note !== undefined && req.body?.note !== null
    ? String(req.body.note).trim()
    : null;

  try {
    const result = await prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw`
        SELECT id, status, new_user_id, manual_user_id
        FROM "MemberBindRequest"
        WHERE id = ${reqId}
        FOR UPDATE
      `;

      if (!locked || locked.length === 0) {
        const err = new Error('找不到該綁定申請');
        err.status = 404;
        throw err;
      }

      const bindReq = locked[0];
      if (bindReq.status !== 'pending') {
        const err = new Error('此綁定申請已處理，無法重複核准');
        err.status = 409;
        err.code = 'BIND_REQUEST_NOT_PENDING';
        throw err;
      }

      const [newUser, manualUser] = await Promise.all([
        tx.user.findUnique({ where: { id: bindReq.new_user_id } }),
        tx.user.findUnique({ where: { id: bindReq.manual_user_id } })
      ]);

      if (!newUser || !manualUser) {
        const err = new Error('找不到對應的會員資料');
        err.status = 404;
        throw err;
      }

      if (manualUser.merged_into_user_id !== null) {
        const err = new Error('此代建會員已併入其他帳號');
        err.status = 409;
        err.code = 'MANUAL_USER_ALREADY_MERGED';
        throw err;
      }

      const now = new Date();
      const manualId = manualUser.id;
      const newId = newUser.id;

      // Move all 7 user-referencing tables from manualUser -> newUser
      const [
        loginLogsRes,
        reservationsRes,
        productOrdersRes,
        userPassesRes,
        bookingPrepaysRes,
        kioskLogsRes,
        poolAccountsRes
      ] = await Promise.all([
        tx.userLoginLog.updateMany({ where: { user_id: manualId }, data: { user_id: newId } }),
        tx.reservation.updateMany({ where: { user_id: manualId }, data: { user_id: newId } }),
        tx.productOrder.updateMany({ where: { user_id: manualId }, data: { user_id: newId } }),
        tx.userPass.updateMany({ where: { user_id: manualId }, data: { user_id: newId } }),
        tx.bookingPrepay.updateMany({ where: { user_id: manualId }, data: { user_id: newId } }),
        tx.kioskAccessLog.updateMany({ where: { user_id: manualId }, data: { user_id: newId } }),
        tx.oneTimeAccountPool.updateMany({ where: { assigned_user_id: manualId }, data: { assigned_user_id: newId } })
      ]);

      const movedCounts = {
        login_logs: loginLogsRes.count,
        reservations: reservationsRes.count,
        product_orders: productOrdersRes.count,
        user_passes: userPassesRes.count,
        booking_prepays: bookingPrepaysRes.count,
        kiosk_access_logs: kioskLogsRes.count,
        one_time_pool_accounts: poolAccountsRes.count
      };

      // Merge notes & blacklist onto newUser
      const newUserUpdate = {};
      if (manualUser.is_blacklisted) {
        newUserUpdate.is_blacklisted = true;
      }
      if (manualUser.notes && manualUser.notes.trim()) {
        const mergedNoteLine = `[合併自櫃檯建檔] ${manualUser.notes.trim()}`;
        newUserUpdate.notes = newUser.notes && newUser.notes.trim()
          ? `${newUser.notes.trim()}\n${mergedNoteLine}`
          : mergedNoteLine;
      }
      if (Object.keys(newUserUpdate).length > 0) {
        await tx.user.update({
          where: { id: newId },
          data: newUserUpdate
        });
      }

      // Mark manualUser merged (keep old phone intact per product decision)
      await tx.user.update({
        where: { id: manualId },
        data: {
          merged_into_user_id: newId,
          merged_at: now
        }
      });

      const decidedByName = req.user?.name || '店員';
      const decidedById = req.user?.id || null;

      const updatedRequest = await tx.memberBindRequest.update({
        where: { id: reqId },
        data: {
          status: 'approved',
          decided_at: now,
          decided_by_name: decidedByName,
          decided_by_id: decidedById,
          decision_note: note
        }
      });

      // Reject any other pending bind requests for this manual user
      await tx.memberBindRequest.updateMany({
        where: {
          manual_user_id: manualId,
          id: { not: reqId },
          status: 'pending'
        },
        data: {
          status: 'rejected',
          decided_at: now,
          decided_by_name: decidedByName,
          decided_by_id: decidedById,
          decision_note: '已併入其他帳號'
        }
      });

      await auditService.log(tx, {
        event_type: 'member_merged',
        category: 'member',
        summary: `核准合併代建會員 #${manualId} 至 LINE 會員 #${newId}`,
        before_json: {
          bind_request_id: reqId,
          new_user_id: newId,
          manual_user_id: manualId
        },
        after_json: {
          bind_request_id: reqId,
          new_user_id: newId,
          manual_user_id: manualId,
          moved_counts: movedCounts
        },
        reason: note,
        staff_name: decidedByName,
        staff_id: decidedById
      });

      return { updatedRequest, movedCounts };
    });

    res.json({
      ok: true,
      message: '已核准合併會員資料',
      request: result.updatedRequest,
      moved_counts: result.movedCounts
    });
  } catch (error) {
    if (error.status) {
      return res.status(error.status).json({ error: error.message, code: error.code });
    }
    console.error('approveBindRequest error:', error);
    res.status(500).json({ error: '核准合併失敗' });
  }
};

export const rejectBindRequest = async (req, res) => {
  const reqId = parseInt(req.params.id, 10);
  if (!Number.isInteger(reqId) || reqId <= 0) {
    return res.status(400).json({ error: '無效的申請 ID' });
  }

  const note = req.body?.note !== undefined && req.body?.note !== null
    ? String(req.body.note).trim()
    : null;

  try {
    const updatedRequest = await prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw`
        SELECT id, status, new_user_id, manual_user_id
        FROM "MemberBindRequest"
        WHERE id = ${reqId}
        FOR UPDATE
      `;

      if (!locked || locked.length === 0) {
        const err = new Error('找不到該綁定申請');
        err.status = 404;
        throw err;
      }

      const bindReq = locked[0];
      if (bindReq.status !== 'pending') {
        const err = new Error('此綁定申請已處理，無法重複拒絕');
        err.status = 409;
        err.code = 'BIND_REQUEST_NOT_PENDING';
        throw err;
      }

      const now = new Date();
      const decidedByName = req.user?.name || '店員';
      const decidedById = req.user?.id || null;

      const updated = await tx.memberBindRequest.update({
        where: { id: reqId },
        data: {
          status: 'rejected',
          decided_at: now,
          decided_by_name: decidedByName,
          decided_by_id: decidedById,
          decision_note: note
        }
      });

      await auditService.log(tx, {
        event_type: 'member_bind_rejected',
        category: 'member',
        summary: `拒絕合併代建會員 #${bindReq.manual_user_id} 至 LINE 會員 #${bindReq.new_user_id}`,
        before_json: {
          bind_request_id: reqId,
          new_user_id: bindReq.new_user_id,
          manual_user_id: bindReq.manual_user_id,
          status: 'pending'
        },
        after_json: {
          bind_request_id: reqId,
          new_user_id: bindReq.new_user_id,
          manual_user_id: bindReq.manual_user_id,
          status: 'rejected'
        },
        reason: note,
        staff_name: decidedByName,
        staff_id: decidedById
      });

      return updated;
    });

    res.json({
      ok: true,
      message: '已拒絕合併申請',
      request: updatedRequest
    });
  } catch (error) {
    if (error.status) {
      return res.status(error.status).json({ error: error.message, code: error.code });
    }
    console.error('rejectBindRequest error:', error);
    res.status(500).json({ error: '拒絕申請失敗' });
  }
};

