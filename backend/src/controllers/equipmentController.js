import prisma from '../prismaClient.js';
import { calculateTotalAmount, recalculateReservationTotal } from './reservationController.js';
import { calculateEquipmentChargeableHours } from '../utils/equipmentPricing.js';

export const DEFAULT_EQUIPMENT_CONFIGS = [
  {
    id: 'pegboard_s',
    name: '小板 (52×52)',
    visibility_status: 'ACTIVE',
    total_stock: 5,
    hourly_rate: 100,
    daily_cap: 500,
    min_contiguous_hours: 2,
    allow_exceed_pax: false,
    sort_order: 1
  },
  {
    id: 'pegboard_m',
    name: '中板 (78×78)',
    visibility_status: 'ACTIVE',
    total_stock: 2,
    hourly_rate: 120,
    daily_cap: 600,
    min_contiguous_hours: 2,
    allow_exceed_pax: false,
    sort_order: 2
  },
  {
    id: 'pegboard_l',
    name: '大板 (104×104)',
    visibility_status: 'ACTIVE',
    total_stock: 3,
    hourly_rate: 140,
    daily_cap: 700,
    min_contiguous_hours: 2,
    allow_exceed_pax: false,
    sort_order: 3
  },
  {
    id: 'bring_own',
    name: '自帶智能拼豆板',
    visibility_status: 'ACTIVE',
    total_stock: null,
    hourly_rate: 50,
    daily_cap: 400,
    min_contiguous_hours: 1,
    allow_exceed_pax: false,
    sort_order: 4
  }
];

export const ensureDefaultEquipmentConfigs = async () => {
  try {
    for (const item of DEFAULT_EQUIPMENT_CONFIGS) {
      const existing = await prisma.equipmentConfig.findUnique({
        where: { id: item.id }
      });
      if (!existing) {
        await prisma.equipmentConfig.create({
          data: item
        });
        console.log(`[EquipmentConfig] Auto-seeded default item: ${item.id} (${item.name})`);
      }
    }
  } catch (err) {
    console.error('Failed to ensure default equipment configs:', err);
  }
};

// GET /api/equipment/availability?date=YYYY-MM-DD&sessions=13:00,14:00
export const getAvailableEquipment = async (req, res) => {
  const { date, sessions } = req.query;

  try {
    await ensureDefaultEquipmentConfigs();

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
    const show_equipment_live_stock = globalSetting?.show_equipment_live_stock !== false;
    const equipment_discount_enabled = globalSetting ? globalSetting.equipment_discount_enabled !== false : true;
    const equipment_discount_buy_hours = globalSetting?.equipment_discount_buy_hours ?? 3;
    const equipment_discount_free_hours = globalSetting?.equipment_discount_free_hours ?? 1;
    const equipment_discount_stackable = globalSetting ? globalSetting.equipment_discount_stackable !== false : true;
    const equipment_discount2_enabled = !!globalSetting?.equipment_discount2_enabled;
    const equipment_discount2_buy_hours = globalSetting?.equipment_discount2_buy_hours ?? 8;
    const equipment_discount2_free_hours = globalSetting?.equipment_discount2_free_hours ?? 4;

    if (configs.length === 0) {
      return res.json({ 
        equipments: [], 
        allow_exceed_pax, 
        show_equipment_live_stock,
        equipment_discount_enabled,
        equipment_discount_buy_hours,
        equipment_discount_free_hours,
        equipment_discount_stackable,
        equipment_discount2_enabled,
        equipment_discount2_buy_hours,
        equipment_discount2_free_hours
      });
    }

    if (!date || !sessions) {
      return res.json({
        equipments: configs.map(c => ({
          ...c,
          available_qty: c.id === 'bring_own' ? 9999 : (c.visibility_status === 'MAINTENANCE' ? 0 : (c.total_stock || 0))
        })),
        allow_exceed_pax,
        show_equipment_live_stock,
        equipment_discount_enabled,
        equipment_discount_buy_hours,
        equipment_discount_free_hours,
        equipment_discount_stackable,
        equipment_discount2_enabled,
        equipment_discount2_buy_hours,
        equipment_discount2_free_hours
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

          // Check if this booking covers reqSess (prioritize covered_sessions)
          let hasOverlap = false;
          if (Array.isArray(be.covered_sessions) && be.covered_sessions.length > 0) {
            hasOverlap = be.covered_sessions.includes(reqSess) || be.covered_sessions.some(s => s.startsWith(reqSess));
          } else {
            const sessionsSet = bookingSessionsMap[be.booking_ref];
            hasOverlap = sessionsSet && (sessionsSet.has(reqSess) || Array.from(sessionsSet).some(s => s.startsWith(reqSess)));
          }

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
      allow_exceed_pax,
      show_equipment_live_stock,
      equipment_discount_enabled,
      equipment_discount_buy_hours,
      equipment_discount_free_hours,
      equipment_discount_stackable,
      equipment_discount2_enabled,
      equipment_discount2_buy_hours,
      equipment_discount2_free_hours
    });
  } catch (error) {
    console.error('Error in getAvailableEquipment:', error);
    res.status(500).json({ error: '無法取得設備可用數量' });
  }
};

// GET /api/admin/equipment
export const getAdminEquipmentConfigs = async (req, res) => {
  try {
    await ensureDefaultEquipmentConfigs();

    const configs = await prisma.equipmentConfig.findMany({
      orderBy: { sort_order: 'asc' }
    });

    const globalSetting = await prisma.globalSetting.findUnique({
      where: { id: 1 }
    });

    res.json({
      configs,
      allow_equipment_exceed_pax: !!globalSetting?.allow_equipment_exceed_pax,
      show_equipment_live_stock: globalSetting?.show_equipment_live_stock !== false,
      equipment_discount_enabled: globalSetting ? globalSetting.equipment_discount_enabled !== false : true,
      equipment_discount_buy_hours: globalSetting?.equipment_discount_buy_hours ?? 3,
      equipment_discount_free_hours: globalSetting?.equipment_discount_free_hours ?? 1,
      equipment_discount_stackable: globalSetting ? globalSetting.equipment_discount_stackable !== false : true,
      equipment_discount2_enabled: !!globalSetting?.equipment_discount2_enabled,
      equipment_discount2_buy_hours: globalSetting?.equipment_discount2_buy_hours ?? 8,
      equipment_discount2_free_hours: globalSetting?.equipment_discount2_free_hours ?? 4
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
              quantity: eq.quantity,
              session_time: `${r.session.start_time}-${r.session.end_time}`
            });
          }
        });

        for (const slotKey of Object.keys(sessionOccupancy)) {
          const slot = sessionOccupancy[slotKey];
          if ((newStatus !== 'ACTIVE' && slot.totalBooked > 0) || (newStock !== null && slot.totalBooked > newStock)) {
            slot.affectedOrders.forEach(order => {
              warnings.push({
                date: slot.date,
                session: order.session_time || slot.time,
                booking_ref: order.booking_ref,
                customer_name: order.name || '未知顧客',
                customer_phone: order.phone || '無電話',
                booked_qty: order.quantity,
                totalBooked: slot.totalBooked,
                newStock: newStatus !== 'ACTIVE' ? 0 : newStock
              });
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
        ...(daily_cap !== undefined && { daily_cap: (daily_cap === null || daily_cap === '' || isNaN(parseInt(daily_cap, 10)) || parseInt(daily_cap, 10) <= 0) ? null : parseInt(daily_cap, 10) }),
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

  if (!id || !name || hourly_rate === undefined) {
    return res.status(400).json({ error: '請提供完整的規格資料 (代碼、名稱與費率)' });
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
        daily_cap: (daily_cap === null || daily_cap === '' || isNaN(parseInt(daily_cap, 10)) || parseInt(daily_cap, 10) <= 0) ? null : parseInt(daily_cap, 10),
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
  const { 
    allow_equipment_exceed_pax, 
    show_equipment_live_stock,
    equipment_discount_enabled,
    equipment_discount_buy_hours,
    equipment_discount_free_hours,
    equipment_discount_stackable,
    equipment_discount2_enabled,
    equipment_discount2_buy_hours,
    equipment_discount2_free_hours
  } = req.body;

  try {
    const updated = await prisma.globalSetting.upsert({
      where: { id: 1 },
      update: {
        ...(allow_equipment_exceed_pax !== undefined && { allow_equipment_exceed_pax: !!allow_equipment_exceed_pax }),
        ...(show_equipment_live_stock !== undefined && { show_equipment_live_stock: !!show_equipment_live_stock }),
        ...(equipment_discount_enabled !== undefined && { equipment_discount_enabled: !!equipment_discount_enabled }),
        ...(equipment_discount_buy_hours !== undefined && { equipment_discount_buy_hours: Math.max(1, parseInt(equipment_discount_buy_hours, 10)) }),
        ...(equipment_discount_free_hours !== undefined && { equipment_discount_free_hours: Math.max(1, parseInt(equipment_discount_free_hours, 10)) }),
        ...(equipment_discount_stackable !== undefined && { equipment_discount_stackable: !!equipment_discount_stackable }),
        ...(equipment_discount2_enabled !== undefined && { equipment_discount2_enabled: !!equipment_discount2_enabled }),
        ...(equipment_discount2_buy_hours !== undefined && { equipment_discount2_buy_hours: Math.max(1, parseInt(equipment_discount2_buy_hours, 10)) }),
        ...(equipment_discount2_free_hours !== undefined && { equipment_discount2_free_hours: Math.max(1, parseInt(equipment_discount2_free_hours, 10)) })
      },
      create: {
        id: 1,
        allow_equipment_exceed_pax: !!allow_equipment_exceed_pax,
        show_equipment_live_stock: show_equipment_live_stock !== undefined ? !!show_equipment_live_stock : true,
        equipment_discount_enabled: equipment_discount_enabled !== undefined ? !!equipment_discount_enabled : true,
        equipment_discount_buy_hours: equipment_discount_buy_hours !== undefined ? Math.max(1, parseInt(equipment_discount_buy_hours, 10)) : 3,
        equipment_discount_free_hours: equipment_discount_free_hours !== undefined ? Math.max(1, parseInt(equipment_discount_free_hours, 10)) : 1,
        equipment_discount_stackable: equipment_discount_stackable !== undefined ? !!equipment_discount_stackable : true,
        equipment_discount2_enabled: !!equipment_discount2_enabled,
        equipment_discount2_buy_hours: equipment_discount2_buy_hours !== undefined ? Math.max(1, parseInt(equipment_discount2_buy_hours, 10)) : 8,
        equipment_discount2_free_hours: equipment_discount2_free_hours !== undefined ? Math.max(1, parseInt(equipment_discount2_free_hours, 10)) : 4
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
    await ensureDefaultEquipmentConfigs();

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
      orderBy: { sort_order: 'asc' }
    });

    const sessionSummary = {};
    const occupancy = {};

    sessions.forEach(sess => {
      occupancy[sess.id] = {};
      configs.forEach(cfg => {
        occupancy[sess.id][cfg.id] = 0;
      });

      sessionSummary[sess.start_time] = {
        session_id: sess.id,
        start_time: sess.start_time,
        end_time: sess.end_time,
        boards: {}
      };

      configs.forEach(cfg => {
        if (cfg.id !== 'bring_own') {
          sessionSummary[sess.start_time].boards[cfg.id] = {
            id: cfg.id,
            name: cfg.name,
            total: cfg.total_stock || 0,
            booked: 0
          };
        }
      });

      bookedEquipments.forEach(be => {
        let isOccupied = false;
        if (Array.isArray(be.covered_sessions) && be.covered_sessions.length > 0) {
          isOccupied = be.covered_sessions.includes(sess.start_time) || be.covered_sessions.some(s => s.startsWith(sess.start_time));
        } else {
          const sessSet = bookingSessionsMap[be.booking_ref];
          isOccupied = sessSet && sessSet.has(sess.start_time);
        }

        if (isOccupied) {
          occupancy[sess.id][be.equipment_id] = (occupancy[sess.id][be.equipment_id] || 0) + be.quantity;
          if (sessionSummary[sess.start_time]?.boards?.[be.equipment_id]) {
            sessionSummary[sess.start_time].boards[be.equipment_id].booked += be.quantity;
          }
        }
      });
    });

    const enrichedSessions = sessions.map(sess => {
      const bookedPax = reservations
        .filter(r => r.session_id === sess.id && r.status === 'confirmed')
        .reduce((sum, r) => sum + r.pax, 0);
      return {
        ...sess,
        booked_pax: bookedPax,
        remaining_capacity: Math.max(0, sess.max_capacity - bookedPax)
      };
    });

    res.json({
      sessions: enrichedSessions,
      configs,
      occupancy,
      sessionSummary
    });
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
    await ensureDefaultEquipmentConfigs();

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

    const bookingStartTime = new Date(`${sessionDateStr}T${firstSession.start_time}:00+08:00`);
    const bookingEndTime = new Date(`${sessionDateStr}T${lastSession.end_time}:00+08:00`);
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
      if (r.session?.start_time) {
        otherSessionMap[r.booking_ref].add(r.session.start_time);
      }
    });

    const validOtherBookingRefs = Object.keys(otherSessionMap);
    const otherBookings = validOtherBookingRefs.length > 0
      ? await prisma.bookingEquipment.findMany({
          where: {
            booking_ref: { in: validOtherBookingRefs }
          },
          include: {
            equipment: true
          }
        })
      : [];

    const sortedReservations = [...reservations].sort((a, b) => a.session.start_time.localeCompare(b.session.start_time));
    const totalOrderHours = reservations.length;

    for (const eq of equipments) {
      const qty = parseInt(eq.quantity, 10) || 0;
      if (qty <= 0) continue;
      if (eq.equipment_id === 'bring_own') continue;

      const config = configMap[eq.equipment_id];
      const totalStock = config.total_stock || 0;
      const minHours = config.min_contiguous_hours || 2;
      const rentalHours = totalOrderHours < minHours 
        ? totalOrderHours 
        : Math.max(minHours, Math.min(totalOrderHours, parseInt(eq.rental_hours, 10) || totalOrderHours));
      const targetSessions = sortedReservations.slice(0, rentalHours).map(r => r.session.start_time);

      for (const timeStr of targetSessions) {
        let bookedByOthers = 0;
        for (const ob of otherBookings) {
          if (ob.equipment_id !== eq.equipment_id) continue;
          let coversThis = false;
          if (Array.isArray(ob.covered_sessions) && ob.covered_sessions.length > 0) {
            coversThis = ob.covered_sessions.includes(timeStr) || ob.covered_sessions.some(s => s.startsWith(timeStr));
          } else {
            const sSet = otherSessionMap[ob.booking_ref];
            coversThis = sSet && sSet.has(timeStr);
          }
          if (coversThis) {
            bookedByOthers += ob.quantity;
          }
        }

        if (bookedByOthers + qty > totalStock) {
          return res.status(409).json({
            error: `抱歉！「${config.name}」在 ${timeStr} 庫存不足，請重新調整數量。`,
            code: 'EQUIPMENT_OUT_OF_STOCK'
          });
        }
      }
    }

    // Execute Transaction: Update BookingEquipment and recalculate total_amount

    const discountConfig = {
      enabled: globalSetting ? globalSetting.equipment_discount_enabled !== false : true,
      buy_hours: globalSetting?.equipment_discount_buy_hours ?? 3,
      free_hours: globalSetting?.equipment_discount_free_hours ?? 1,
      tier2_enabled: !!globalSetting?.equipment_discount2_enabled,
      tier2_buy_hours: globalSetting?.equipment_discount2_buy_hours ?? 8,
      tier2_free_hours: globalSetting?.equipment_discount2_free_hours ?? 4
    };

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

      const chargeableHours = calculateEquipmentChargeableHours(rentalHours, discountConfig);

      const singleBoardPrice = (config.daily_cap && config.daily_cap > 0)
        ? Math.min(config.hourly_rate * chargeableHours, config.daily_cap)
        : (config.hourly_rate * chargeableHours);
      const subtotalPrice = singleBoardPrice * qty;

      totalEquipmentFee += subtotalPrice;

      const eqCoveredSessions = sortedReservations.slice(0, rentalHours).map(r => `${r.session.start_time}-${r.session.end_time}`);

      newEquipmentRecords.push({
        booking_ref,
        equipment_id: eq.equipment_id,
        equipment_name_snapshot: config.name,
        quantity: qty,
        rental_hours: rentalHours,
        subtotal_price: subtotalPrice,
        covered_sessions: eqCoveredSessions
      });
    }

    // Unified recalculation preserving promo codes and addons
    const newGrandTotal = await prisma.$transaction(async (tx) => {
      await tx.bookingEquipment.deleteMany({ where: { booking_ref } });
      if (newEquipmentRecords.length > 0) {
        await tx.bookingEquipment.createMany({ data: newEquipmentRecords });
      }
      return await recalculateReservationTotal(tx, booking_ref);
    });

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
