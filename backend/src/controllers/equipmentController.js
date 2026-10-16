import prisma from '../prismaClient.js';
import { calculateTotalAmount } from './reservationController.js';

// GET /api/equipment/availability?date=YYYY-MM-DD&sessions=13:00,14:00
export const getAvailableEquipment = async (req, res) => {
  const { date, sessions } = req.query;

  try {
    const configs = await prisma.equipmentConfig.findMany({
      where: {
        visibility_status: { not: 'HIDDEN' }
      },
      orderBy: { sort_order: 'asc' }
    });

    const globalSetting = await prisma.globalSetting.findUnique({
      where: { id: 1 }
    });
    const allow_exceed_pax = !!globalSetting?.allow_equipment_exceed_pax;

    if (configs.length === 0) {
      return res.json({ equipments: [], allow_exceed_pax });
    }

    if (!date || !sessions) {
      return res.json({
        equipments: configs.map(c => ({
          ...c,
          available_qty: c.id === 'bring_own' ? 9999 : (c.visibility_status === 'MAINTENANCE' ? 0 : (c.total_stock || 0))
        })),
        allow_exceed_pax
      });
    }

    const requestedSessions = Array.isArray(sessions) 
      ? sessions 
      : sessions.split(',').map(s => s.trim()).filter(Boolean);

    // Find all confirmed reservations on this date
    const targetDate = new Date(date);
    const reservations = await prisma.reservation.findMany({
      where: {
        status: { not: 'cancelled' },
        session: {
          session_date: targetDate
        }
      },
      include: {
        session: true
      }
    });

    const activeBookingRefs = Array.from(new Set(reservations.map(r => r.booking_ref)));

    // Map each booking_ref to its sessions (e.g. ["13:00", "14:00"] or ["13:00-14:00"])
    const bookingSessionsMap = {};
    reservations.forEach(r => {
      if (!bookingSessionsMap[r.booking_ref]) {
        bookingSessionsMap[r.booking_ref] = new Set();
      }
      bookingSessionsMap[r.booking_ref].add(r.session.start_time);
      bookingSessionsMap[r.booking_ref].add(`${r.session.start_time}-${r.session.end_time}`);
    });

    // Find all BookingEquipment for these active booking_refs
    const bookedEquipments = await prisma.bookingEquipment.findMany({
      where: {
        booking_ref: { in: activeBookingRefs }
      }
    });

    const results = configs.map(config => {
      if (config.id === 'bring_own') {
        return {
          ...config,
          available_qty: 9999
        };
      }

      if (config.visibility_status === 'MAINTENANCE') {
        return {
          ...config,
          available_qty: 0,
          status_note: config.status_note || '🔧 設備維護中，暫停借用'
        };
      }

      const totalStock = config.total_stock || 0;

      // Find maximum booked quantity among any of the requested sessions
      let maxBookedInAnySession = 0;

      for (const reqSess of requestedSessions) {
        let bookedInThisSession = 0;

        for (const be of bookedEquipments) {
          if (be.equipment_id !== config.id) continue;

          // Check if this booking covers reqSess
          const sessionsSet = bookingSessionsMap[be.booking_ref];
          const hasOverlap = (sessionsSet && (sessionsSet.has(reqSess) || Array.from(sessionsSet).some(s => s.startsWith(reqSess)))) ||
                            (be.covered_sessions && be.covered_sessions.includes(reqSess));

          if (hasOverlap) {
            bookedInThisSession += be.quantity;
          }
        }

        if (bookedInThisSession > maxBookedInAnySession) {
          maxBookedInAnySession = bookedInThisSession;
        }
      }

      const availableQty = Math.max(0, totalStock - maxBookedInAnySession);

      return {
        ...config,
        available_qty: availableQty
      };
    });

    res.json({
      equipments: results,
      allow_exceed_pax
    });
  } catch (error) {
    console.error('Error in getAvailableEquipment:', error);
    res.status(500).json({ error: '無法取得設備可用數量' });
  }
};

// GET /api/admin/equipment
export const getAdminEquipmentConfigs = async (req, res) => {
  try {
    const configs = await prisma.equipmentConfig.findMany({
      orderBy: { sort_order: 'asc' }
    });

    const globalSetting = await prisma.globalSetting.findUnique({
      where: { id: 1 }
    });

    res.json({
      configs,
      allow_equipment_exceed_pax: !!globalSetting?.allow_equipment_exceed_pax
    });
  } catch (error) {
    console.error('Error fetching equipment configs:', error);
    res.status(500).json({ error: '無法取得設備設定' });
  }
};

// PUT /api/admin/equipment/:id
export const updateEquipmentConfig = async (req, res) => {
  const { id } = req.params;
  const { 
    name, 
    visibility_status, 
    status_note, 
    total_stock, 
    hourly_rate, 
    daily_cap, 
    min_contiguous_hours,
    sort_order 
  } = req.body;

  try {
    const existing = await prisma.equipmentConfig.findUnique({ where: { id } });
    if (!existing) {
      return res.status(404).json({ error: '找不到該設備規格' });
    }

    // Check future conflicts if stock is decreased or status is set to MAINTENANCE/HIDDEN
    const warnings = [];
    const newStock = total_stock !== undefined ? parseInt(total_stock, 10) : existing.total_stock;
    const newStatus = visibility_status || existing.visibility_status;

    if (id !== 'bring_own' && (newStock < existing.total_stock || newStatus !== 'ACTIVE')) {
      const today = new Date();
      today.setHours(0, 0, 0, 0);

      const futureReservations = await prisma.reservation.findMany({
        where: {
          status: { not: 'cancelled' },
          session: {
            session_date: { gte: today }
          }
        },
        include: {
          session: true,
          user: true
        }
      });

      const futureRefs = Array.from(new Set(futureReservations.map(r => r.booking_ref)));
      const futureBookedEquipments = await prisma.bookingEquipment.findMany({
        where: {
          equipment_id: id,
          booking_ref: { in: futureRefs }
        }
      });

      if (futureBookedEquipments.length > 0) {
        // Group by date and session to find if any exceeds newStock
        const sessionOccupancy = {};
        futureReservations.forEach(r => {
          const dateStr = r.session.session_date.toISOString().split('T')[0];
          const timeSlot = `${dateStr} ${r.session.start_time}`;
          const eq = futureBookedEquipments.find(b => b.booking_ref === r.booking_ref);
          if (eq) {
            if (!sessionOccupancy[timeSlot]) {
              sessionOccupancy[timeSlot] = {
                date: dateStr,
                time: r.session.start_time,
                totalBooked: 0,
                affectedOrders: []
              };
            }
            sessionOccupancy[timeSlot].totalBooked += eq.quantity;
            sessionOccupancy[timeSlot].affectedOrders.push({
              booking_ref: r.booking_ref,
              name: r.user?.name || '未知顧客',
              phone: r.user?.phone || '',
              quantity: eq.quantity
            });
          }
        });

        for (const slotKey of Object.keys(sessionOccupancy)) {
          const slot = sessionOccupancy[slotKey];
          if ((newStatus !== 'ACTIVE' && slot.totalBooked > 0) || (newStock !== null && slot.totalBooked > newStock)) {
            warnings.push({
              date: slot.date,
              time: slot.time,
              totalBooked: slot.totalBooked,
              newStock: newStatus !== 'ACTIVE' ? 0 : newStock,
              orders: slot.affectedOrders
            });
          }
        }
      }
    }

    const updated = await prisma.equipmentConfig.update({
      where: { id },
      data: {
        ...(name !== undefined && { name }),
        ...(visibility_status !== undefined && { visibility_status }),
        ...(status_note !== undefined && { status_note }),
        ...(total_stock !== undefined && { total_stock: total_stock === null ? null : parseInt(total_stock, 10) }),
        ...(hourly_rate !== undefined && { hourly_rate: parseInt(hourly_rate, 10) }),
        ...(daily_cap !== undefined && { daily_cap: parseInt(daily_cap, 10) }),
        ...(min_contiguous_hours !== undefined && { min_contiguous_hours: parseInt(min_contiguous_hours, 10) }),
        ...(sort_order !== undefined && { sort_order: parseInt(sort_order, 10) })
      }
    });

    res.json({
      equipment: updated,
      warnings
    });
  } catch (error) {
    console.error('Error updating equipment config:', error);
    res.status(500).json({ error: '更新設備設定失敗' });
  }
};

// POST /api/admin/equipment
export const createEquipmentConfig = async (req, res) => {
  const { id, name, visibility_status, status_note, total_stock, hourly_rate, daily_cap, min_contiguous_hours, sort_order } = req.body;

  if (!id || !name || hourly_rate === undefined || daily_cap === undefined) {
    return res.status(400).json({ error: '請提供完整的規格資料 (代碼、名稱、費率與封頂價)' });
  }

  try {
    const existing = await prisma.equipmentConfig.findUnique({ where: { id } });
    if (existing) {
      return res.status(400).json({ error: '此設備代碼已存在' });
    }

    const created = await prisma.equipmentConfig.create({
      data: {
        id,
        name,
        visibility_status: visibility_status || 'ACTIVE',
        status_note,
        total_stock: total_stock !== null && total_stock !== undefined ? parseInt(total_stock, 10) : null,
        hourly_rate: parseInt(hourly_rate, 10),
        daily_cap: parseInt(daily_cap, 10),
        min_contiguous_hours: parseInt(min_contiguous_hours || 2, 10),
        sort_order: parseInt(sort_order || 0, 10)
      }
    });

    res.status(201).json(created);
  } catch (error) {
    console.error('Error creating equipment config:', error);
    res.status(500).json({ error: '建立設備規格失敗' });
  }
};

// DELETE /api/admin/equipment/:id
export const deleteEquipmentConfig = async (req, res) => {
  const { id } = req.params;

  const defaultIds = ['pegboard_s', 'pegboard_m', 'pegboard_l', 'bring_own'];
  if (defaultIds.includes(id)) {
    return res.status(400).json({ error: '預設標準規格不可刪除，若不使用請設為「前台隱藏」' });
  }

  try {
    // Check if any booking equipment references this
    const count = await prisma.bookingEquipment.count({ where: { equipment_id: id } });
    if (count > 0) {
      return res.status(400).json({ error: '已有訂單記錄使用此設備，無法刪除，請改為「前台隱藏」' });
    }

    await prisma.equipmentConfig.delete({ where: { id } });
    res.json({ message: '設備規格已刪除' });
  } catch (error) {
    console.error('Error deleting equipment config:', error);
    res.status(500).json({ error: '刪除設備規格失敗' });
  }
};

// PATCH /api/admin/equipment/settings
export const updateGlobalEquipmentSetting = async (req, res) => {
  const { allow_equipment_exceed_pax } = req.body;

  try {
    const updated = await prisma.globalSetting.upsert({
      where: { id: 1 },
      update: {
        allow_equipment_exceed_pax: !!allow_equipment_exceed_pax
      },
      create: {
        id: 1,
        allow_equipment_exceed_pax: !!allow_equipment_exceed_pax
      }
    });

    res.json(updated);
  } catch (error) {
    console.error('Error updating global equipment setting:', error);
    res.status(500).json({ error: '更新全域設備設定失敗' });
  }
};

// GET /api/admin/equipment/occupancy?date=YYYY-MM-DD
export const getEquipmentOccupancy = async (req, res) => {
  const { date } = req.query;
  if (!date) {
    return res.status(400).json({ error: '缺少日期參數' });
  }

  try {
    const targetDate = new Date(date);
    const sessions = await prisma.session.findMany({
      where: { session_date: targetDate },
      orderBy: { start_time: 'asc' }
    });

    const reservations = await prisma.reservation.findMany({
      where: {
        status: { not: 'cancelled' },
        session: { session_date: targetDate }
      },
      include: {
        session: true
      }
    });

    const activeBookingRefs = Array.from(new Set(reservations.map(r => r.booking_ref)));
    const bookedEquipments = await prisma.bookingEquipment.findMany({
      where: { booking_ref: { in: activeBookingRefs } },
      include: { equipment: true }
    });

    const bookingSessionsMap = {};
    reservations.forEach(r => {
      if (!bookingSessionsMap[r.booking_ref]) {
        bookingSessionsMap[r.booking_ref] = new Set();
      }
      bookingSessionsMap[r.booking_ref].add(r.session.start_time);
    });

    const configs = await prisma.equipmentConfig.findMany({
      where: { id: { not: 'bring_own' } },
      orderBy: { sort_order: 'asc' }
    });

    const sessionSummary = {};
    sessions.forEach(sess => {
      sessionSummary[sess.start_time] = {
        session_id: sess.id,
        start_time: sess.start_time,
        end_time: sess.end_time,
        boards: {}
      };

      configs.forEach(cfg => {
        sessionSummary[sess.start_time].boards[cfg.id] = {
          id: cfg.id,
          name: cfg.name,
          total: cfg.total_stock || 0,
          booked: 0
        };
      });

      bookedEquipments.forEach(be => {
        const sessSet = bookingSessionsMap[be.booking_ref];
        if (sessSet && sessSet.has(sess.start_time) && sessionSummary[sess.start_time].boards[be.equipment_id]) {
          sessionSummary[sess.start_time].boards[be.equipment_id].booked += be.quantity;
        }
      });
    });

    res.json(sessionSummary);
  } catch (error) {
    console.error('Error fetching equipment occupancy:', error);
    res.status(500).json({ error: '無法取得設備佔用狀態' });
  }
};

// PATCH /api/reservations/:booking_ref/equipment (Retroactive Add-on / Modify)
export const modifyBookingEquipment = async (req, res) => {
  const { booking_ref } = req.params;
  const { equipments } = req.body; // Array of { equipment_id, quantity, rental_hours }
  const userId = req.user?.id;
  const isAdmin = req.user?.role === 'admin';

  if (!Array.isArray(equipments)) {
    return res.status(400).json({ error: 'equipments 必須是陣列' });
  }

  try {
    // 1. Fetch reservation group
    const reservations = await prisma.reservation.findMany({
      where: { booking_ref },
      include: { session: true, user: true }
    });

    if (reservations.length === 0) {
      return res.status(404).json({ error: '找不到該筆預約' });
    }

    const firstRes = reservations[0];
    if (!isAdmin && firstRes.user_id !== userId) {
      return res.status(403).json({ error: '無權限修改此預約' });
    }

    if (firstRes.status === 'cancelled') {
      return res.status(400).json({ error: '預約已結束或已取消，無法異動智能板', code: 'ORDER_EXPIRED' });
    }

    // Sort sessions to find overall start and end times
    reservations.sort((a, b) => a.session.start_time.localeCompare(b.session.start_time));
    const firstSession = reservations[0].session;
    const lastSession = reservations[reservations.length - 1].session;

    const sessionDateStr = firstSession.session_date.toISOString().split('T')[0];
    const [startH, startM] = firstSession.start_time.split(':').map(Number);
    const [endH, endM] = lastSession.end_time.split(':').map(Number);

    const bookingStartTime = new Date(`${sessionDateStr}T${firstSession.start_time}:00`);
    const bookingEndTime = new Date(`${sessionDateStr}T${lastSession.end_time}:00`);
    const now = new Date();

    // Verification 2: Order expired check
    if (!isAdmin && now >= bookingEndTime) {
      return res.status(400).json({ error: '預約已結束，無法異動智能板', code: 'ORDER_EXPIRED' });
    }

    // Verification 3: Remaining time check (< 120 minutes)
    if (!isAdmin) {
      const effectiveStart = now > bookingStartTime ? now : bookingStartTime;
      const remainingMinutes = (bookingEndTime.getTime() - effectiveStart.getTime()) / (1000 * 60);
      if (remainingMinutes < 120) {
        return res.status(400).json({ 
          error: '距離離場時間已不足 2 小時，無法線上補預約智能板；如需借用請洽現場店員。', 
          code: 'INSUFFICIENT_REMAINING_TIME' 
        });
      }
    }

    // Existing equipments on this booking
    const existingEquipments = await prisma.bookingEquipment.findMany({
      where: { booking_ref }
    });
    const existingMap = {};
    existingEquipments.forEach(e => { existingMap[e.equipment_id] = e.quantity; });

    // Verification 4: Pre-class lock (within 60 mins of start time or during session, new_qty >= old_qty)
    if (!isAdmin && now >= new Date(bookingStartTime.getTime() - 60 * 60 * 1000)) {
      for (const [eqId, oldQty] of Object.entries(existingMap)) {
        const item = equipments.find(e => e.equipment_id === eqId);
        const newQty = item ? parseInt(item.quantity, 10) : 0;
        if (newQty < oldQty) {
          return res.status(403).json({
            error: '距離體驗開始已不足 1 小時（或體驗進行中），線上僅開放追加設備，退租請洽現場門市人員。',
            code: 'CANCEL_LOCKED'
          });
        }
      }
    }

    // Verification 1: Visibility check for newly added or increased equipments
    const allConfigs = await prisma.equipmentConfig.findMany();
    const configMap = {};
    allConfigs.forEach(c => { configMap[c.id] = c; });

    for (const eq of equipments) {
      const qty = parseInt(eq.quantity, 10) || 0;
      if (qty <= 0) continue;
      const config = configMap[eq.equipment_id];
      if (!config) {
        return res.status(400).json({ error: `找不到設備規格 ${eq.equipment_id}` });
      }

      const oldQty = existingMap[eq.equipment_id] || 0;
      if (qty > oldQty && !isAdmin && config.visibility_status !== 'ACTIVE') {
        return res.status(400).json({ error: `「${config.name}」目前未開放線上租借`, code: 'EQUIPMENT_UNAVAILABLE' });
      }
    }

    // Verification 5: Pax quota & stock check
    const totalBoardsRequested = equipments.reduce((sum, e) => sum + (parseInt(e.quantity, 10) || 0), 0);
    const globalSetting = await prisma.globalSetting.findUnique({ where: { id: 1 } });
    if (!globalSetting?.allow_equipment_exceed_pax && !isAdmin) {
      if (totalBoardsRequested > firstRes.pax) {
        return res.status(400).json({ 
          error: `預約總人數為 ${firstRes.pax} 人，智能板配置總數不能超過 ${firstRes.pax} 台`, 
          code: 'EXCEED_PAX_LIMIT' 
        });
      }
    }

    // Check stock availability for each requested item
    const sessionTimes = reservations.map(r => r.session.start_time);
    const otherBookings = await prisma.bookingEquipment.findMany({
      where: {
        booking_ref: { not: booking_ref }
      },
      include: {
        equipment: true
      }
    });

    const otherReservations = await prisma.reservation.findMany({
      where: {
        status: { not: 'cancelled' },
        session: { session_date: firstSession.session_date },
        booking_ref: { not: booking_ref }
      },
      include: { session: true }
    });

    const otherSessionMap = {};
    otherReservations.forEach(r => {
      if (!otherSessionMap[r.booking_ref]) otherSessionMap[r.booking_ref] = new Set();
      otherSessionMap[r.booking_ref].add(r.session.start_time);
    });

    for (const eq of equipments) {
      const qty = parseInt(eq.quantity, 10) || 0;
      if (qty <= 0) continue;
      if (eq.equipment_id === 'bring_own') continue;

      const config = configMap[eq.equipment_id];
      const totalStock = config.total_stock || 0;

      for (const timeStr of sessionTimes) {
        let bookedByOthers = 0;
        for (const ob of otherBookings) {
          if (ob.equipment_id !== eq.equipment_id) continue;
          const sSet = otherSessionMap[ob.booking_ref];
          if (sSet && sSet.has(timeStr)) {
            bookedByOthers += ob.quantity;
          }
        }

        if (bookedByOthers + qty > totalStock) {
          return res.status(409).json({
            error: `抱歉！「${config.name}」在庫存不足，請重新調整數量。`,
            code: 'EQUIPMENT_OUT_OF_STOCK'
          });
        }
      }
    }

    // Execute Transaction: Update BookingEquipment and recalculate total_amount
    const coveredSessionsStrings = reservations.map(r => `${r.session.start_time}-${r.session.end_time}`);
    const totalOrderHours = reservations.length;

    let totalEquipmentFee = 0;
    const newEquipmentRecords = [];

    for (const eq of equipments) {
      const qty = parseInt(eq.quantity, 10) || 0;
      if (qty <= 0) continue;

      const config = configMap[eq.equipment_id];
      const minHours = config.min_contiguous_hours || 2;
      const rentalHours = totalOrderHours < minHours 
        ? totalOrderHours 
        : Math.max(minHours, Math.min(totalOrderHours, parseInt(eq.rental_hours, 10) || totalOrderHours));

      const singleBoardPrice = Math.min(config.hourly_rate * rentalHours, config.daily_cap);
      const subtotalPrice = singleBoardPrice * qty;

      totalEquipmentFee += subtotalPrice;

      newEquipmentRecords.push({
        booking_ref,
        equipment_id: eq.equipment_id,
        equipment_name_snapshot: config.name,
        quantity: qty,
        rental_hours: rentalHours,
        subtotal_price: subtotalPrice,
        covered_sessions: coveredSessionsStrings
      });
    }

    // Calculate base seating price
    const baseSeatingPrice = await calculateTotalAmount(
      prisma,
      firstSession.session_date,
      firstRes.pax,
      totalOrderHours,
      firstRes.is_unlimited
    );

    const newGrandTotal = baseSeatingPrice + totalEquipmentFee;

    await prisma.$transaction([
      prisma.bookingEquipment.deleteMany({ where: { booking_ref } }),
      ...(newEquipmentRecords.length > 0 ? [prisma.bookingEquipment.createMany({ data: newEquipmentRecords })] : []),
      prisma.reservation.updateMany({
        where: { booking_ref },
        data: {
          total_amount: newGrandTotal
        }
      })
    ]);

    res.json({
      message: '智能拼豆板配置已更新',
      total_amount: newGrandTotal,
      equipments: newEquipmentRecords
    });

  } catch (error) {
    console.error('Error modifying booking equipment:', error);
    res.status(500).json({ error: '更新智能拼豆板失敗' });
  }
};
