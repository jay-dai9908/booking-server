import jwt from 'jsonwebtoken';
import prisma from '../prismaClient.js';
import { getActiveLayoutForDate } from '../services/seating/layoutService.js';
import { dateOnly, toTaipeiDateString } from '../../../shared/time.js';
import { syncAndVerifyAdminUser } from '../middlewares/authMiddleware.js';
import { bookableSessionWhere } from '../services/calendar/sessionFilters.js';
import auditService from '../services/audit/auditService.js';
import { getAdminDeviceInfo } from '../utils/deviceParser.js';

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_SESSION_RANGE_DAYS = 120;

async function isAdminCaller(req) {
  if (req.user?.isVerifiedAdmin || req.user?.role === 'admin') return true;
  const authHeader = req.headers?.authorization || '';
  const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;
  const token = req.cookies?.token || bearerToken;
  if (!token || !process.env.JWT_SECRET) return false;
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const verified = await syncAndVerifyAdminUser(decoded);
    return Boolean(verified);
  } catch {
    return false;
  }
}

function isValidYmd(str) {
  if (typeof str !== 'string' || !ISO_DATE_RE.test(str)) return false;
  const d = dateOnly(str);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === str;
}

export const getSessions = async (req, res) => {
  const { date, start_date, end_date } = req.query;

  if (date === undefined && (!start_date || !end_date)) {
    return res.status(400).json({ error: 'Date or start_date/end_date query parameters are required' });
  }

  try {
    let whereClause = {};
    if (date !== undefined) {
      const cleanDate = String(date).trim();
      if (!isValidYmd(cleanDate)) {
        return res.status(400).json({ error: '日期格式必須為 YYYY-MM-DD' });
      }
      whereClause.session_date = dateOnly(cleanDate);
    } else {
      const cleanStart = String(start_date).trim();
      const cleanEnd = String(end_date).trim();
      if (!isValidYmd(cleanStart) || !isValidYmd(cleanEnd)) {
        return res.status(400).json({ error: 'start_date 與 end_date 格式必須為 YYYY-MM-DD' });
      }
      const startObj = dateOnly(cleanStart);
      const endObj = dateOnly(cleanEnd);
      if (endObj < startObj) {
        return res.status(400).json({ error: 'end_date 不可早於 start_date' });
      }
      const diffDays = Math.round((endObj.getTime() - startObj.getTime()) / (24 * 60 * 60 * 1000));
      if (diffDays > MAX_SESSION_RANGE_DAYS) {
        return res.status(400).json({ error: `查詢區間不可超過 ${MAX_SESSION_RANGE_DAYS} 天` });
      }
      whereClause.session_date = {
        gte: startObj,
        lte: endObj
      };
    }
    
    const callerIsAdmin = await isAdminCaller(req);
    const includeClosed = callerIsAdmin && (req.query.include_closed === '1' || req.query.include_closed === 'true');
    if (!includeClosed) {
      whereClause = { ...whereClause, ...bookableSessionWhere() };
    }

    // Fetch sessions
    const sessions = await prisma.session.findMany({
      where: whereClause,
      include: {
        reservations: {
          where: { status: 'confirmed' },
          select: { pax: true, assigned_seats: true },
        },
      },
      orderBy: [
        { session_date: 'asc' },
        { start_time: 'asc' }
      ]
    });

    const activeLayoutMap = new Map();
    for (const s of sessions) {
      const dStr = s.session_date.toISOString().slice(0, 10);
      if (!activeLayoutMap.has(dStr)) {
        const layout = await getActiveLayoutForDate(prisma, s.session_date);
        activeLayoutMap.set(dStr, layout);
      }
    }

    // Calculate remaining capacity
    const formattedSessions = sessions.map(session => {
      const bookedPax = session.reservations.reduce((sum, res) => {
        return sum + res.pax;
      }, 0);
      const dStr = session.session_date.toISOString().slice(0, 10);
      const layout = activeLayoutMap.get(dStr);
      const totalSeats = (layout?.capacity && layout.capacity > 0) ? layout.capacity : (layout?.seats || []).filter(s => s.is_active).length || 16;

      return {
        id: session.id,
        session_date: session.session_date,
        start_time: session.start_time,
        end_time: session.end_time,
        max_capacity: session.max_capacity,
        remaining_capacity: Math.max(0, session.max_capacity - bookedPax),
        remaining_seats: Math.max(0, totalSeats - bookedPax),
        total_seats: totalSeats,
        ...(includeClosed ? {
          closed_at: session.closed_at || null,
          closed_by: session.closed_by || null
        } : {})
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

  if (dates.length === 0 || !start_time || !end_time) {
    return res.status(400).json({ error: 'Dates, start time and end time are required' });
  }

  try {
    const startHour = parseInt(start_time.split(':')[0], 10);
    const endHour = parseInt(end_time.split(':')[0], 10);
    
    if (startHour >= endHour) {
      return res.status(400).json({ error: 'End time must be after start time' });
    }

    let capacity = null;
    if (max_capacity !== undefined && max_capacity !== null && max_capacity !== '') {
      const parsed = parseInt(max_capacity, 10);
      if (!isNaN(parsed) && parsed > 0) {
        capacity = parsed;
      }
    }
    if (capacity === null) {
      const gs = await prisma.globalSetting.findUnique({ where: { id: 1 } });
      capacity = (gs && gs.default_session_capacity) ? gs.default_session_capacity : 16;
    }

    const sessionsToCreate = [];
    
    for (const d of dates) {
      const targetDate = dateOnly(d);

      for (let h = startHour; h < endHour; h++) {
        sessionsToCreate.push({
          session_date: targetDate,
          start_time: `${h.toString().padStart(2, '0')}:00`,
          end_time: `${(h + 1).toString().padStart(2, '0')}:00`,
          max_capacity: capacity,
        });
      }
    }

    const staffName = req.user?.name || '管理員';
    const staffId = req.user?.id || null;
    const deviceInfo = getAdminDeviceInfo(req);

    // Use transaction to upsert sessions and reopen any closed sessions for those slots
    await prisma.$transaction(async (tx) => {
      const reopenedSlots = [];
      for (const session of sessionsToCreate) {
        const existing = await tx.session.findUnique({
          where: {
            session_date_start_time: {
              session_date: session.session_date,
              start_time: session.start_time
            }
          }
        });

        if (existing && existing.closed_at) {
          const updated = await tx.session.update({
            where: { id: existing.id },
            data: {
              max_capacity: session.max_capacity,
              end_time: session.end_time,
              closed_at: null,
              closed_by: null
            }
          });
          reopenedSlots.push({
            id: updated.id,
            date: toTaipeiDateString(updated.session_date),
            start_time: updated.start_time,
            end_time: updated.end_time
          });
        } else {
          await tx.session.upsert({
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
          });
        }
      }

      if (reopenedSlots.length > 0) {
        for (const slot of reopenedSlots) {
          await auditService.log(tx, {
            event_type: 'session_reopened',
            category: 'session',
            target_type: 'session',
            target_ref: String(slot.id),
            summary: `重新開放時段 ${slot.date} ${slot.start_time}-${slot.end_time}`,
            after_json: { ...slot, max_capacity: capacity },
            staff_name: staffName,
            staff_id: staffId,
            device_id: deviceInfo.device_id,
            device_label: deviceInfo.device_label
          });
        }
      }
    });

    res.status(201).json({ message: 'Sessions created or updated successfully', count: sessionsToCreate.length });
  } catch (error) {
    console.error('Error creating sessions:', error);
    res.status(500).json({ error: 'Failed to create/update sessions' });
  }
};

export const deleteSession = async (req, res) => {
  const { id } = req.params;
  const sessionId = parseInt(id, 10);
  const staffName = req.user?.name || '管理員';
  const staffId = req.user?.id || null;
  const deviceInfo = getAdminDeviceInfo(req);

  try {
    const result = await prisma.$transaction(async (tx) => {
      const session = await tx.session.findUnique({
        where: { id: sessionId },
        include: {
          reservations: {
            select: { id: true, status: true }
          }
        }
      });

      if (!session) {
        return { notFound: true };
      }

      const confirmedCount = session.reservations.filter(r => r.status === 'confirmed').length;
      if (confirmedCount > 0) {
        return { hasConfirmed: true };
      }

      const dateStr = toTaipeiDateString(session.session_date);

      if (session.reservations.length > 0) {
        if (!session.closed_at) {
          await tx.session.update({
            where: { id: session.id },
            data: {
              closed_at: new Date(),
              closed_by: staffName
            }
          });
          await auditService.log(tx, {
            event_type: 'session_closed',
            category: 'session',
            target_type: 'session',
            target_ref: String(session.id),
            summary: `關閉時段 ${dateStr} ${session.start_time}-${session.end_time}（保留 ${session.reservations.length} 筆已取消預約紀錄）`,
            after_json: {
              date: dateStr,
              start_time: session.start_time,
              end_time: session.end_time,
              cancelled_count: session.reservations.length
            },
            staff_name: staffName,
            staff_id: staffId,
            device_id: deviceInfo.device_id,
            device_label: deviceInfo.device_label
          });
        }
        return { action: 'closed', deletedCount: 0, closedCount: session.closed_at ? 0 : 1 };
      }

      await tx.session.delete({ where: { id: session.id } });
      await auditService.log(tx, {
        event_type: 'session_deleted',
        category: 'session',
        target_type: 'session',
        target_ref: String(session.id),
        summary: `刪除空時段 ${dateStr} ${session.start_time}-${session.end_time}`,
        before_json: {
          date: dateStr,
          start_time: session.start_time,
          end_time: session.end_time,
          max_capacity: session.max_capacity
        },
        staff_name: staffName,
        staff_id: staffId,
        device_id: deviceInfo.device_id,
        device_label: deviceInfo.device_label
      });
      return { action: 'deleted', deletedCount: 1, closedCount: 0 };
    });

    if (result.notFound) {
      return res.status(404).json({ error: 'Session not found' });
    }
    if (result.hasConfirmed) {
      return res.status(400).json({ error: 'Cannot delete session with confirmed reservations' });
    }

    if (result.action === 'closed') {
      return res.json({
        message: '此時段有已取消的預約紀錄，已改為關閉（保留歷史帳務對照）',
        action: 'closed',
        deletedCount: 0,
        closedCount: result.closedCount
      });
    }

    res.json({
      message: 'Session deleted successfully',
      action: 'deleted',
      deletedCount: 1,
      closedCount: 0
    });
  } catch (error) {
    console.error('Error deleting session:', error);
    res.status(500).json({ error: 'Failed to delete session' });
  }
};

export const deleteSessionsByDate = async (req, res) => {
  const { date } = req.params;
  const staffName = req.user?.name || '管理員';
  const staffId = req.user?.id || null;
  const deviceInfo = getAdminDeviceInfo(req);

  try {
    const targetDate = dateOnly(date);
    const dateStr = toTaipeiDateString(targetDate);

    const outcome = await prisma.$transaction(async (tx) => {
      const sessions = await tx.session.findMany({
        where: { session_date: targetDate },
        include: {
          reservations: {
            select: { id: true, status: true }
          }
        },
        orderBy: { start_time: 'asc' }
      });

      if (sessions.length === 0) {
        return { notFound: true };
      }

      const withConfirmed = sessions.filter(s => s.reservations.some(r => r.status === 'confirmed'));
      const keptCount = withConfirmed.length;
      if (keptCount === sessions.length) {
        return { allConfirmed: true };
      }

      const toHardDelete = sessions.filter(s => s.reservations.length === 0);
      const toClose = sessions.filter(
        s => s.reservations.length > 0 && !s.reservations.some(r => r.status === 'confirmed') && !s.closed_at
      );

      let deletedCount = 0;
      if (toHardDelete.length > 0) {
        const delRes = await tx.session.deleteMany({
          where: { id: { in: toHardDelete.map(s => s.id) } }
        });
        deletedCount = delRes.count;
        await auditService.log(tx, {
          event_type: 'session_deleted',
          category: 'session',
          target_type: 'session',
          target_ref: dateStr,
          summary: `刪除 ${dateStr} 空時段共 ${deletedCount} 個`,
          before_json: {
            date: dateStr,
            sessions: toHardDelete.map(s => ({ id: s.id, start_time: s.start_time, end_time: s.end_time, max_capacity: s.max_capacity }))
          },
          staff_name: staffName,
          staff_id: staffId,
          device_id: deviceInfo.device_id,
          device_label: deviceInfo.device_label
        });
      }

      let closedCount = 0;
      if (toClose.length > 0) {
        const now = new Date();
        await tx.session.updateMany({
          where: { id: { in: toClose.map(s => s.id) } },
          data: { closed_at: now, closed_by: staffName }
        });
        closedCount = toClose.length;
        await auditService.log(tx, {
          event_type: 'session_closed',
          category: 'session',
          target_type: 'session',
          target_ref: dateStr,
          summary: `關閉 ${dateStr} 時段共 ${closedCount} 個（有已取消的預約紀錄）`,
          after_json: {
            date: dateStr,
            sessions: toClose.map(s => ({ id: s.id, start_time: s.start_time, end_time: s.end_time, cancelled_count: s.reservations.length }))
          },
          staff_name: staffName,
          staff_id: staffId,
          device_id: deviceInfo.device_id,
          device_label: deviceInfo.device_label
        });
      }

      return { deletedCount, closedCount, keptCount };
    });

    if (outcome.notFound) {
      return res.status(404).json({ error: 'No sessions found for this date.' });
    }
    if (outcome.allConfirmed) {
      return res.status(400).json({ error: 'All sessions on this date have confirmed reservations and cannot be deleted.' });
    }

    res.json({
      message: `刪除 ${outcome.deletedCount} 個、關閉 ${outcome.closedCount} 個（有已取消的預約紀錄）`,
      deletedCount: outcome.deletedCount,
      closedCount: outcome.closedCount,
      keptCount: outcome.keptCount
    });
  } catch (error) {
    console.error('Error clearing sessions by date:', error);
    res.status(500).json({ error: 'Failed to clear sessions' });
  }
};
