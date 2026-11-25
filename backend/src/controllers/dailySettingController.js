import prisma from '../prismaClient.js';
import auditService from '../services/audit/auditService.js';
import { logSettingChange, diffFields } from '../services/audit/settingAudit.js';
import { getDayInfo, getDayInfoRange } from '../services/calendar/dayType.js';
import {
  getClosureImpact,
  buildClosureImpactCsv,
  batchCancelClosureBookings,
  dispatchClosureLineNotice
} from '../services/calendar/closureService.js';
import { formatSessionsToTimeRange } from '../services/booking/cancelService.js';
import { computeDayInfo } from '../../../shared/dayType.js';
import { dateOnly, toTaipeiDateString } from '../../../shared/time.js';
import { prepayDeadline, ironText } from '../../../shared/selfService.js';
import displayBus from '../services/display/displayBus.js';
import { isSafeHttpUrl, safeHttpUrl } from '../../../shared/safeUrl.js';
import { normalizeMethodKey, RESERVED_PAYMENT_KEYS } from '../../../shared/paymentMethods.js';
import { sanitizeGlobalSetting } from '../utils/sanitizeGlobalSetting.js';
import { getAdminDeviceInfo } from '../utils/deviceParser.js';
import {
  PERMISSION_LABELS,
  findSettingGroupForField,
  canAdminPermission,
} from '../middlewares/permissionGroups.js';

export async function ensureKioskSetting(txOrPrisma = prisma) {
  let ks = await txOrPrisma.kioskSetting.findUnique({ where: { id: 1 } });
  if (!ks) {
    ks = await txOrPrisma.kioskSetting.create({
      data: {
        id: 1,
        early_minutes: 30,
        after_close_minutes: 60,
        prepay_deadline_hour: 12,
        max_unpaid_self_bookings: 2
      }
    });
  }
  return ks;
}

const VALID_IRON_MODES = new Set(['today', 'next', 'date']);

function buildSelfServiceMeta(setting, kioskSetting, dateStr, nowMs = Date.now()) {
  if (!setting?.is_self_service) return null;
  const deadlineHour = kioskSetting?.prepay_deadline_hour ?? 12;
  const earlyMinutes = kioskSetting?.early_minutes ?? 30;
  const deadlineAt = prepayDeadline(dateStr, deadlineHour);
  return {
    early_minutes: earlyMinutes,
    prepay_deadline_hour: deadlineHour,
    prepay_deadline_at: deadlineAt.toISOString(),
    transfer_open: nowMs <= deadlineAt.getTime(),
    iron_mode: setting.iron_mode || 'today',
    iron_date: setting.iron_date ? toTaipeiDateString(setting.iron_date) : null,
    iron_text: ironText({
      iron_mode: setting.iron_mode || 'today',
      iron_date: setting.iron_date,
      date: dateStr,
      today: toTaipeiDateString(new Date(nowMs))
    }),
    allow_hourly: Boolean(setting.self_allow_hourly),
    allow_equipment: Boolean(setting.self_allow_equipment)
  };
}

const DEFAULT_BUSINESS_HOURS = {
  weekday: { start: '10:00', end: '21:00' },
  saturday: { start: '09:00', end: '21:00' },
  sunday: { start: '09:00', end: '21:00' }
};

export const DEFAULT_PAYMENT_METHODS = [
  { key: 'cash', label: '現金', enabled: true },
  { key: 'linepay', label: 'LINE Pay', enabled: true },
  { key: 'transfer', label: '銀行轉帳', enabled: true },
  { key: 'card', label: '信用卡', enabled: true }
];

export const getDailySetting = async (req, res) => {
  const { date, now } = req.query;

  if (!date) {
    return res.status(400).json({ error: 'Date query parameter is required' });
  }

  try {
    const dOnly = dateOnly(date);
    const dateStr = toTaipeiDateString(dOnly);
    const nowMs = (process.env.NODE_ENV === 'test' && now) ? new Date(now).getTime() : Date.now();
    const [setting, dayInfo] = await Promise.all([
      prisma.dailySetting.findUnique({ where: { date: dOnly } }),
      getDayInfo(prisma, dateStr)
    ]);

    if (!setting) {
      return res.json({
        date,
        allow_unlimited: true,
        is_self_service: false,
        self_allow_hourly: false,
        self_allow_equipment: false,
        iron_mode: 'today',
        iron_date: null,
        self_service: null,
        day_type: dayInfo.type,
        price_type: dayInfo.price_type,
        day_type_source: dayInfo.source,
        closed_note: dayInfo.closed_note,
        raw_day_type: null,
        raw_price_type: null
      });
    }

    let self_service = null;
    if (setting.is_self_service) {
      const kioskSetting = await ensureKioskSetting(prisma);
      self_service = buildSelfServiceMeta(setting, kioskSetting, dateStr, nowMs);
    }

    res.json({
      ...setting,
      iron_date: setting.iron_date ? toTaipeiDateString(setting.iron_date) : null,
      self_service,
      day_type: dayInfo.type,
      price_type: dayInfo.price_type,
      day_type_source: dayInfo.source,
      closed_note: dayInfo.closed_note,
      raw_day_type: setting.day_type ?? null,
      raw_price_type: setting.price_type ?? null
    });
  } catch (error) {
    console.error('Error fetching daily setting:', error);
    res.status(500).json({ error: 'Failed to fetch daily setting' });
  }
};

export const getDailySettingsRange = async (req, res) => {
  const { start, end } = req.query;
  if (!start || !end || !/^\d{4}-\d{2}-\d{2}$/.test(String(start)) || !/^\d{4}-\d{2}-\d{2}$/.test(String(end))) {
    return res.status(400).json({ error: '請提供有效的起訖日期 (start, end YYYY-MM-DD)' });
  }

  const startDate = dateOnly(start);
  const endDate = dateOnly(end);
  if (isNaN(startDate.getTime()) || isNaN(endDate.getTime()) || endDate < startDate) {
    return res.status(400).json({ error: '起訖日期範圍無效' });
  }

  const diffDays = Math.round((endDate.getTime() - startDate.getTime()) / (24 * 60 * 60 * 1000)) + 1;
  if (diffDays > 120) {
    return res.status(400).json({ error: '查詢範圍最多 120 天' });
  }

  try {
    const infoMap = await getDayInfoRange(prisma, startDate, endDate);
    res.json(
      Array.from(infoMap.values()).map((info) => ({
        date: info.date,
        is_self_service: Boolean(info.is_self_service),
        day_type: info.type,
        price_type: info.price_type,
        day_type_source: info.source,
        closed_note: info.closed_note
      }))
    );
  } catch (error) {
    console.error('Error fetching daily settings range:', error);
    res.status(500).json({ error: 'Failed to fetch daily settings range' });
  }
};

async function countConfirmedBookingsForDate(targetDate) {
  const rows = await prisma.reservation.findMany({
    where: {
      status: 'confirmed',
      session: { session_date: targetDate }
    },
    select: { booking_ref: true }
  });
  return new Set(rows.map(r => r.booking_ref)).size;
}

export const updateDailySetting = async (req, res) => {
  const {
    date,
    allow_unlimited,
    hourly_price,
    unlimited_price,
    is_self_service,
    self_allow_hourly,
    self_allow_equipment,
    iron_mode,
    iron_date
  } = req.body;

  if (!date) {
    return res.status(400).json({ error: 'Date is required' });
  }

  try {
    const targetDate = dateOnly(date);
    const targetDateStr = toTaipeiDateString(targetDate);
    const existing = await prisma.dailySetting.findUnique({ where: { date: targetDate } });

    const prevIsSelf = Boolean(existing?.is_self_service);
    if (typeof is_self_service === 'boolean' && is_self_service !== prevIsSelf) {
      const bookingCount = await countConfirmedBookingsForDate(targetDate);
      if (bookingCount > 0) {
        return res.status(422).json({
          error: `這天已經有 ${bookingCount} 筆預約，請先處理後再切換`,
          booking_count: bookingCount
        });
      }
    }

    const effectiveIronMode = iron_mode !== undefined ? String(iron_mode) : (existing?.iron_mode || 'today');
    if (!VALID_IRON_MODES.has(effectiveIronMode)) {
      return res.status(422).json({ error: '熨燙時間模式必須為 today、next 或 date' });
    }

    let parsedIronDate = existing?.iron_date ?? null;
    if (effectiveIronMode === 'date') {
      const rawIronDate = iron_date !== undefined ? iron_date : existing?.iron_date;
      if (!rawIronDate) {
        return res.status(422).json({ error: '選擇指定日期時，請填寫熨燙日期' });
      }
      const d = dateOnly(rawIronDate);
      if (isNaN(d.getTime())) {
        return res.status(422).json({ error: '熨燙日期格式無效' });
      }
      if (d < targetDate) {
        return res.status(422).json({ error: `指定熨燙日期（${toTaipeiDateString(d)}）不可早於使用日（${targetDateStr}）` });
      }
      parsedIronDate = d;
    } else if (iron_mode !== undefined) {
      parsedIronDate = null;
    }

    const dataToUpdate = {};
    if (typeof allow_unlimited === 'boolean') dataToUpdate.allow_unlimited = allow_unlimited;
    if (hourly_price !== undefined) dataToUpdate.hourly_price = (hourly_price === null || hourly_price === '') ? null : parseInt(hourly_price, 10);
    if (unlimited_price !== undefined) dataToUpdate.unlimited_price = (unlimited_price === null || unlimited_price === '') ? null : parseInt(unlimited_price, 10);
    if (typeof is_self_service === 'boolean') dataToUpdate.is_self_service = is_self_service;
    if (typeof self_allow_hourly === 'boolean') dataToUpdate.self_allow_hourly = self_allow_hourly;
    if (typeof self_allow_equipment === 'boolean') dataToUpdate.self_allow_equipment = self_allow_equipment;
    if (iron_mode !== undefined) {
      dataToUpdate.iron_mode = effectiveIronMode;
      dataToUpdate.iron_date = parsedIronDate;
    } else if (iron_date !== undefined && effectiveIronMode === 'date') {
      dataToUpdate.iron_date = parsedIronDate;
    }

    const setting = await prisma.$transaction(async (tx) => {
      const saved = await tx.dailySetting.upsert({
        where: { date: targetDate },
        update: dataToUpdate,
        create: {
          date: targetDate,
          ...dataToUpdate,
          allow_unlimited: allow_unlimited !== undefined ? allow_unlimited : true,
          is_self_service: is_self_service !== undefined ? Boolean(is_self_service) : false,
          self_allow_hourly: self_allow_hourly !== undefined ? Boolean(self_allow_hourly) : false,
          self_allow_equipment: self_allow_equipment !== undefined ? Boolean(self_allow_equipment) : false,
          iron_mode: effectiveIronMode,
          iron_date: parsedIronDate
        }
      });

      const beforeSnap = existing
        ? {
            allow_unlimited: existing.allow_unlimited,
            hourly_price: existing.hourly_price,
            unlimited_price: existing.unlimited_price,
            is_self_service: existing.is_self_service,
            self_allow_hourly: existing.self_allow_hourly,
            self_allow_equipment: existing.self_allow_equipment,
            iron_mode: existing.iron_mode,
            iron_date: existing.iron_date ? toTaipeiDateString(existing.iron_date) : null
          }
        : {};
      const afterSnap = {
        allow_unlimited: saved.allow_unlimited,
        hourly_price: saved.hourly_price,
        unlimited_price: saved.unlimited_price,
        is_self_service: saved.is_self_service,
        self_allow_hourly: saved.self_allow_hourly,
        self_allow_equipment: saved.self_allow_equipment,
        iron_mode: saved.iron_mode,
        iron_date: saved.iron_date ? toTaipeiDateString(saved.iron_date) : null
      };
      const auditFields = existing
        ? diffFields(beforeSnap, Object.fromEntries(Object.keys(dataToUpdate).map((k) => [k, afterSnap[k]])))
        : { beforeChanged: {}, afterChanged: afterSnap, changedKeys: Object.keys(afterSnap) };

      if (auditFields.changedKeys.length > 0) {
        const deviceInfo = getAdminDeviceInfo(req);
        await auditService.log(tx, {
          event_type: 'daily_setting_changed',
          category: 'setting',
          target_type: 'daily_setting',
          target_ref: targetDateStr,
          summary: `修改單日設定 ${targetDateStr}：${auditFields.changedKeys.join('、')}`,
          before_json: auditFields.beforeChanged,
          after_json: auditFields.afterChanged,
          staff_name: req.user?.name || '管理員',
          staff_id: req.user?.id || null,
          device_id: deviceInfo?.device_id || null,
          device_label: deviceInfo?.device_label || '後台'
        });
      }

      return saved;
    });

    res.json({ message: 'Daily setting updated successfully', setting });
    displayBus.settingsChanged();
  } catch (error) {
    console.error('Error updating daily setting:', error);
    res.status(500).json({ error: 'Failed to update daily setting' });
  }
};

const VALID_DAY_TYPE_INPUTS = new Set(['auto', 'weekday', 'holiday', 'self', 'closed']);

function parseDayTypeInputs({ day_type, price_type, closed_note }) {
  const cleanDayType = String(day_type ?? '').trim();
  if (!VALID_DAY_TYPE_INPUTS.has(cleanDayType)) {
    return { error: { status: 422, message: '日期類型必須為 auto、weekday、holiday、self 或 closed' } };
  }
  const dbDayType = cleanDayType === 'auto' ? null : cleanDayType;

  let dbPriceType = null;
  if (cleanDayType === 'self' || cleanDayType === 'closed') {
    const rawPt = price_type === undefined || price_type === null ? '' : String(price_type).trim();
    if (rawPt && rawPt !== 'auto') {
      if (rawPt !== 'weekday' && rawPt !== 'holiday') {
        return { error: { status: 422, message: '價格比照必須為依星期、平日或假日' } };
      }
      dbPriceType = rawPt;
    }
  }

  let dbClosedNote = null;
  if (cleanDayType === 'closed' && closed_note !== undefined && closed_note !== null) {
    const trimmedNote = String(closed_note).trim();
    if (trimmedNote.length > 60) {
      return { error: { status: 422, message: '公休說明最多 60 個字' } };
    }
    dbClosedNote = trimmedNote || null;
  }

  return {
    cleanDayType,
    dbDayType,
    dbPriceType,
    dbClosedNote
  };
}

async function findAffectedLegacyUnpaidBookingsForDates(client, dateObjs) {
  const rows = await client.reservation.findMany({
    where: {
      status: 'confirmed',
      is_paid: false,
      session: { session_date: { in: dateObjs } }
    },
    select: {
      booking_ref: true,
      pax: true,
      is_paid: true,
      is_self_service: true,
      billing_status: true,
      pricing_snapshot: true,
      user: { select: { name: true } },
      session: { select: { session_date: true } }
    }
  });

  const candidateRows = rows.filter((r) => {
    if (r.is_paid) return false;
    if (r.billing_status === 'paid' || r.billing_status === 'waived') return false;
    if (r.pricing_snapshot !== null && r.pricing_snapshot !== undefined) return false;
    return true;
  });

  if (candidateRows.length === 0) return [];

  const refs = Array.from(new Set(candidateRows.map((r) => r.booking_ref)));
  const prepays = await client.bookingPrepay.findMany({
    where: { booking_ref: { in: refs } },
    select: { booking_ref: true, pricing_snapshot: true }
  });
  const prepayWithSnap = new Set(
    prepays.filter((p) => p.pricing_snapshot !== null && p.pricing_snapshot !== undefined).map((p) => p.booking_ref)
  );

  const byRef = new Map();
  for (const r of candidateRows) {
    if (prepayWithSnap.has(r.booking_ref)) continue;
    if (!byRef.has(r.booking_ref)) {
      byRef.set(r.booking_ref, {
        booking_ref: r.booking_ref,
        date: toTaipeiDateString(r.session.session_date),
        user_name: r.user?.name || '顧客',
        pax: r.pax
      });
    }
  }
  return Array.from(byRef.values());
}

export const updateDayType = async (req, res) => {
  const { date, day_type, price_type, closed_note, confirm_affected } = req.body || {};
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(String(date).trim())) {
    return res.status(400).json({ error: '請提供有效日期 (YYYY-MM-DD)' });
  }

  const targetDateStr = String(date).trim();
  const targetDate = dateOnly(targetDateStr);
  if (isNaN(targetDate.getTime()) || targetDate.toISOString().slice(0, 10) !== targetDateStr) {
    return res.status(400).json({ error: '日期格式無效' });
  }

  const todayStr = toTaipeiDateString(new Date());
  if (targetDateStr < todayStr) {
    return res.status(422).json({ error: '不可修改今天以前（台北時間）的日期類型' });
  }

  const parsed = parseDayTypeInputs({ day_type, price_type, closed_note });
  if (parsed.error) {
    return res.status(parsed.error.status).json({ error: parsed.error.message });
  }

  const { cleanDayType, dbDayType, dbPriceType, dbClosedNote } = parsed;

  try {
    const existing = await prisma.dailySetting.findUnique({ where: { date: targetDate } });
    const prevIsSelf = Boolean(existing?.is_self_service);
    const nextIsSelf = cleanDayType === 'self'
      ? true
      : (cleanDayType === 'closed' ? prevIsSelf : false);

    if (nextIsSelf !== prevIsSelf) {
      const bookingCount = await countConfirmedBookingsForDate(targetDate);
      if (bookingCount > 0) {
        return res.status(422).json({
          error: `這天已經有 ${bookingCount} 筆預約，請先處理後再切換半自助模式`,
          booking_count: bookingCount
        });
      }
    }

    const prevPriceType = computeDayInfo({
      date: targetDateStr,
      dailySetting: existing,
      bookableSessionCount: 1
    }).price_type;
    const nextPriceType = computeDayInfo({
      date: targetDateStr,
      dailySetting: {
        ...(existing || {}),
        day_type: dbDayType,
        price_type: dbPriceType,
        is_self_service: nextIsSelf
      },
      bookableSessionCount: 1
    }).price_type;

    if (prevPriceType !== nextPriceType && confirm_affected !== true) {
      const affected = await findAffectedLegacyUnpaidBookingsForDates(prisma, [targetDate]);
      if (affected.length > 0) {
        const fromLabel = prevPriceType === 'holiday' ? '假日' : '平日';
        const toLabel = nextPriceType === 'holiday' ? '假日' : '平日';
        return res.status(409).json({
          code: 'AFFECTS_UNPAID',
          count: affected.length,
          bookings: affected,
          from_price_type: prevPriceType,
          to_price_type: nextPriceType,
          error: `這天有 ${affected.length} 筆舊預約還沒付款，價格會從${fromLabel}改成${toLabel}`
        });
      }
    }

    const actorName = req.user?.name || '管理員';
    const nowAt = new Date();
    const setting = await prisma.$transaction(async (tx) => {
      const saved = await tx.dailySetting.upsert({
        where: { date: targetDate },
        update: {
          day_type: dbDayType,
          price_type: dbPriceType,
          day_type_source: 'manual',
          day_type_updated_by: actorName,
          day_type_updated_at: nowAt,
          closed_note: dbClosedNote,
          ...(cleanDayType !== 'closed' ? { is_self_service: nextIsSelf } : {})
        },
        create: {
          date: targetDate,
          allow_unlimited: true,
          is_self_service: nextIsSelf,
          self_allow_hourly: false,
          self_allow_equipment: false,
          iron_mode: 'today',
          iron_date: null,
          day_type: dbDayType,
          price_type: dbPriceType,
          day_type_source: 'manual',
          day_type_updated_by: actorName,
          day_type_updated_at: nowAt,
          closed_note: dbClosedNote
        }
      });

      const deviceInfo = getAdminDeviceInfo(req);
      await auditService.log(tx, {
        event_type: 'daily_setting_changed',
        category: 'setting',
        target_type: 'daily_setting',
        target_ref: targetDateStr,
        summary: `設定日期類型 ${targetDateStr}：${cleanDayType}${dbPriceType ? `（價格比照 ${dbPriceType}）` : ''}`,
        before_json: existing
          ? {
              day_type: existing.day_type ?? null,
              price_type: existing.price_type ?? null,
              closed_note: existing.closed_note ?? null,
              is_self_service: existing.is_self_service
            }
          : {},
        after_json: {
          day_type: saved.day_type ?? null,
          price_type: saved.price_type ?? null,
          closed_note: saved.closed_note ?? null,
          is_self_service: saved.is_self_service
        },
        staff_name: actorName,
        staff_id: req.user?.id || null,
        device_id: deviceInfo?.device_id || null,
        device_label: deviceInfo?.device_label || '後台'
      });

      return saved;
    });

    const dayInfo = await getDayInfo(prisma, targetDateStr);
    displayBus.settingsChanged();

    res.json({
      message: '日期類型已更新',
      setting: {
        ...setting,
        day_type: dayInfo.type,
        price_type: dayInfo.price_type,
        day_type_source: dayInfo.source,
        closed_note: dayInfo.closed_note,
        raw_day_type: setting.day_type ?? null,
        raw_price_type: setting.price_type ?? null
      }
    });
  } catch (error) {
    console.error('Error updating day type:', error);
    res.status(500).json({ error: '更新日期類型失敗' });
  }
};

export const getClosureImpactHandler = async (req, res) => {
  const { date } = req.params;
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(String(date).trim())) {
    return res.status(400).json({ error: '請提供有效日期 (YYYY-MM-DD)' });
  }
  try {
    const impact = await getClosureImpact(prisma, String(date).trim());
    res.json(impact);
  } catch (err) {
    console.error('Error getting closure impact:', err);
    res.status(500).json({ error: '讀取公休影響預約清單失敗' });
  }
};

export const getClosureImpactCsvHandler = async (req, res) => {
  const { date } = req.params;
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(String(date).trim())) {
    return res.status(400).json({ error: '請提供有效日期 (YYYY-MM-DD)' });
  }
  try {
    const dateStr = String(date).trim();
    const impact = await getClosureImpact(prisma, dateStr);
    const csv = buildClosureImpactCsv(impact);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="closure-impact-${dateStr}.csv"`);
    res.send(csv);
  } catch (err) {
    console.error('Error exporting closure impact CSV:', err);
    res.status(500).json({ error: '匯出需處理清單失敗' });
  }
};

export const postClosureCancelHandler = async (req, res) => {
  const { date } = req.params;
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(String(date).trim())) {
    return res.status(400).json({ error: '請提供有效日期 (YYYY-MM-DD)' });
  }
  const { booking_refs = [], notify_line = false, message = '' } = req.body || {};
  try {
    const result = await batchCancelClosureBookings(prisma, {
      dateStr: String(date).trim(),
      booking_refs,
      notify_line: Boolean(notify_line),
      message,
      staffName: req.user?.name || '管理員',
      staffId: req.user?.id || null,
      deviceInfo: getAdminDeviceInfo(req)
    });
    res.json(result);
  } catch (err) {
    if (err.status) {
      return res.status(err.status).json({ error: err.message });
    }
    console.error('Error batch cancelling closure bookings:', err);
    res.status(500).json({ error: '批次取消公休預約失敗' });
  }
};

export const postClosureNotifySingleHandler = async (req, res) => {
  const { date } = req.params;
  const { booking_ref, message = '' } = req.body || {};
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(String(date).trim()) || !booking_ref) {
    return res.status(400).json({ error: '請提供有效日期與預約編號' });
  }
  const trimmedMsg = message ? String(message).trim() : '';
  if (trimmedMsg.length > 300) {
    return res.status(422).json({ error: '公告內容最多 300 個字' });
  }
  try {
    const dateStr = String(date).trim();
    const dayInfo = await getDayInfo(prisma, dateStr);
    if (dayInfo.type !== 'closed') {
      return res.status(409).json({ error: '這天尚未設為公休' });
    }
    const rows = await prisma.reservation.findMany({
      where: { booking_ref: String(booking_ref), session: { session_date: dateOnly(dateStr) } },
      include: {
        session: true,
        user: { select: { id: true, name: true, line_user_id: true } }
      }
    });
    if (rows.length === 0) {
      return res.status(404).json({ error: '找不到這天的預約' });
    }
    const user = rows[0].user;
    if (!user?.line_user_id || user.line_user_id.startsWith('manual_')) {
      return res.status(400).json({ error: '此顧客尚未綁定 LINE' });
    }
    const timeRange = formatSessionsToTimeRange(rows.map((r) => r.session));
    const rendered = await dispatchClosureLineNotice(prisma, {
      booking_ref: String(booking_ref),
      user,
      dateStr,
      timeRange,
      pax: rows[0].pax,
      closedNote: dayInfo.closed_note,
      messageTemplate: trimmedMsg,
      staffName: req.user?.name || '管理員',
      staffId: req.user?.id || null,
      deviceInfo: getAdminDeviceInfo(req)
    });
    res.json({ ok: true, booking_ref, message: rendered });
  } catch (err) {
    if (err.status) {
      return res.status(err.status).json({ error: err.message });
    }
    console.error('Error sending single closure notice:', err);
    res.status(500).json({ error: '補發公休通知失敗' });
  }
};

export const batchUpdateDailySettings = async (req, res) => {
  const {
    start_date,
    end_date,
    days_of_week,
    hourly_price,
    unlimited_price,
    clear_hourly_price,
    clear_unlimited_price,
    allow_unlimited,
    dates,
    is_self_service,
    self_allow_hourly,
    self_allow_equipment,
    iron_mode,
    iron_date,
    day_type,
    price_type,
    closed_note,
    confirm_affected
  } = req.body;

  let datesToUpdate = [];

  if (dates && Array.isArray(dates) && dates.length > 0) {
    datesToUpdate = dates.map(d => dateOnly(d));
  } else if (start_date && end_date) {
    const startDate = dateOnly(start_date);
    const endDate = dateOnly(end_date);

    let currentDate = new Date(startDate);
    while (currentDate <= endDate) {
      const day = currentDate.getUTCDay(); // 0 (Sun) to 6 (Sat)

      if (!days_of_week || days_of_week.includes(day)) {
        datesToUpdate.push(new Date(currentDate));
      }
      currentDate.setUTCDate(currentDate.getUTCDate() + 1);
    }
  } else {
    return res.status(400).json({ error: '請提供日期陣列 (dates) 或起訖日期 (start_date, end_date)' });
  }

  if (datesToUpdate.length === 0) {
    return res.status(400).json({ error: '未選取任何有效日期' });
  }

  try {
    if (iron_mode !== undefined && !VALID_IRON_MODES.has(String(iron_mode))) {
      return res.status(422).json({ error: '熨燙時間模式必須為 today、next 或 date' });
    }

    let parsedIronDate = null;
    if (iron_mode === 'date') {
      if (!iron_date) {
        return res.status(422).json({ error: '選擇指定日期時，請填寫熨燙日期' });
      }
      parsedIronDate = dateOnly(iron_date);
      if (isNaN(parsedIronDate.getTime())) {
        return res.status(422).json({ error: '熨燙日期格式無效' });
      }
      const earlierDates = datesToUpdate.filter(d => parsedIronDate < d);
      if (earlierDates.length > 0) {
        return res.status(422).json({
          error: `指定熨燙日期不可早於使用日（${earlierDates.map(d => toTaipeiDateString(d)).join('、')}）`
        });
      }
    }

    const dataToUpdate = {};
    if (typeof allow_unlimited === 'boolean') {
      dataToUpdate.allow_unlimited = allow_unlimited;
    }

    if (clear_hourly_price === true) {
      dataToUpdate.hourly_price = null;
    } else if (hourly_price !== undefined && hourly_price !== null && String(hourly_price).trim() !== '') {
      const parsedHourly = parseStrictInt(hourly_price);
      if (parsedHourly === null || parsedHourly < 0 || parsedHourly > 10000) {
        return res.status(422).json({ field: 'hourly_price', error: '每小時價格必須為 0 至 10000 的整數' });
      }
      dataToUpdate.hourly_price = parsedHourly;
    }

    if (clear_unlimited_price === true) {
      dataToUpdate.unlimited_price = null;
    } else if (unlimited_price !== undefined && unlimited_price !== null && String(unlimited_price).trim() !== '') {
      const parsedUnlimited = parseStrictInt(unlimited_price);
      if (parsedUnlimited === null || parsedUnlimited < 0 || parsedUnlimited > 10000) {
        return res.status(422).json({ field: 'unlimited_price', error: '不限時價格必須為 0 至 10000 的整數' });
      }
      dataToUpdate.unlimited_price = parsedUnlimited;
    }

    const hasDayTypeChange = day_type !== undefined && day_type !== null && String(day_type).trim() !== '';
    let parsedDayType = null;
    if (hasDayTypeChange) {
      parsedDayType = parseDayTypeInputs({ day_type, price_type, closed_note });
      if (parsedDayType.error) {
        return res.status(parsedDayType.error.status).json({ error: parsedDayType.error.message });
      }
    }

    const touchesPricingOrUnlimited =
      dataToUpdate.hourly_price !== undefined ||
      dataToUpdate.unlimited_price !== undefined ||
      dataToUpdate.allow_unlimited !== undefined ||
      hasDayTypeChange;

    if (touchesPricingOrUnlimited) {
      const todayStr = toTaipeiDateString(new Date());
      const pastDates = datesToUpdate
        .map(d => toTaipeiDateString(d))
        .filter(dStr => dStr < todayStr);
      if (pastDates.length > 0) {
        return res.status(422).json({
          field: 'dates',
          past_dates: pastDates,
          error: `不可批次修改今天以前日期的設定（${pastDates.join('、')}），整批未修改`
        });
      }
    }

    const targetIsSelfService = hasDayTypeChange
      ? (parsedDayType.cleanDayType === 'self' ? true : (parsedDayType.cleanDayType === 'closed' ? null : false))
      : (typeof is_self_service === 'boolean' ? is_self_service : null);

    const existingRowsForCheck = (targetIsSelfService !== null || hasDayTypeChange)
      ? await prisma.dailySetting.findMany({ where: { date: { in: datesToUpdate } } })
      : [];
    const existingRowByDate = new Map(existingRowsForCheck.map(r => [toTaipeiDateString(r.date), r]));

    if (targetIsSelfService !== null) {
      const confirmedRows = await prisma.reservation.findMany({
        where: {
          status: 'confirmed',
          session: { session_date: { in: datesToUpdate } }
        },
        include: { session: { select: { session_date: true } } }
      });
      const refsByDate = new Map();
      for (const r of confirmedRows) {
        const dStr = toTaipeiDateString(r.session.session_date);
        if (!refsByDate.has(dStr)) refsByDate.set(dStr, new Set());
        refsByDate.get(dStr).add(r.booking_ref);
      }

      const conflicts = [];
      for (const dt of datesToUpdate) {
        const dStr = toTaipeiDateString(dt);
        const prev = Boolean(existingRowByDate.get(dStr)?.is_self_service);
        if (targetIsSelfService !== prev) {
          const cnt = refsByDate.get(dStr)?.size || 0;
          if (cnt > 0) {
            conflicts.push({ date: dStr, count: cnt });
          }
        }
      }

      if (conflicts.length > 0) {
        const detail = conflicts.map(c => `${c.date}（${c.count} 筆）`).join('、');
        return res.status(422).json({
          error: `以下日期已有確認預約，整批未修改，請先處理後再切換：${detail}`,
          conflict_dates: conflicts
        });
      }
    }

    if (hasDayTypeChange && confirm_affected !== true) {
      const priceChangingDates = [];
      for (const dt of datesToUpdate) {
        const dStr = toTaipeiDateString(dt);
        const prevRow = existingRowByDate.get(dStr) || null;
        const nextIsSelf = parsedDayType.cleanDayType === 'self'
          ? true
          : (parsedDayType.cleanDayType === 'closed' ? Boolean(prevRow?.is_self_service) : false);
        const prevPt = computeDayInfo({ date: dStr, dailySetting: prevRow, bookableSessionCount: 1 }).price_type;
        const nextPt = computeDayInfo({
          date: dStr,
          dailySetting: {
            ...(prevRow || {}),
            day_type: parsedDayType.dbDayType,
            price_type: parsedDayType.dbPriceType,
            is_self_service: nextIsSelf
          },
          bookableSessionCount: 1
        }).price_type;
        if (prevPt !== nextPt) {
          priceChangingDates.push(dt);
        }
      }
      if (priceChangingDates.length > 0) {
        const affected = await findAffectedLegacyUnpaidBookingsForDates(prisma, priceChangingDates);
        if (affected.length > 0) {
          return res.status(409).json({
            code: 'AFFECTS_UNPAID',
            count: affected.length,
            bookings: affected,
            error: `這些日期中有 ${affected.length} 筆舊預約還沒付款，價格將會變動`
          });
        }
      }
    }

    if (hasDayTypeChange) {
      const actorName = req.user?.name || '管理員';
      dataToUpdate.day_type = parsedDayType.dbDayType;
      dataToUpdate.price_type = parsedDayType.dbPriceType;
      dataToUpdate.day_type_source = 'manual';
      dataToUpdate.day_type_updated_by = actorName;
      dataToUpdate.day_type_updated_at = new Date();
      dataToUpdate.closed_note = parsedDayType.dbClosedNote;
      if (parsedDayType.cleanDayType !== 'closed') {
        dataToUpdate.is_self_service = parsedDayType.cleanDayType === 'self';
      }
    } else if (typeof is_self_service === 'boolean') {
      dataToUpdate.is_self_service = is_self_service;
    }
    if (typeof self_allow_hourly === 'boolean') dataToUpdate.self_allow_hourly = self_allow_hourly;
    if (typeof self_allow_equipment === 'boolean') dataToUpdate.self_allow_equipment = self_allow_equipment;
    if (iron_mode !== undefined) {
      dataToUpdate.iron_mode = String(iron_mode);
      dataToUpdate.iron_date = iron_mode === 'date' ? parsedIronDate : null;
    }

    await prisma.$transaction(async (tx) => {
      const existingBeforeRows = await tx.dailySetting.findMany({
        where: { date: { in: datesToUpdate } }
      });
      const existingByDateStr = new Map(existingBeforeRows.map((r) => [toTaipeiDateString(r.date), r]));

      for (const date of datesToUpdate) {
        await tx.dailySetting.upsert({
          where: { date },
          update: dataToUpdate,
          create: {
            date,
            ...dataToUpdate,
            allow_unlimited: typeof allow_unlimited === 'boolean' ? allow_unlimited : true,
            is_self_service: dataToUpdate.is_self_service !== undefined
              ? Boolean(dataToUpdate.is_self_service)
              : (is_self_service !== undefined ? Boolean(is_self_service) : false),
            self_allow_hourly: self_allow_hourly !== undefined ? Boolean(self_allow_hourly) : false,
            self_allow_equipment: self_allow_equipment !== undefined ? Boolean(self_allow_equipment) : false,
            iron_mode: iron_mode !== undefined ? String(iron_mode) : 'today',
            iron_date: iron_mode === 'date' ? parsedIronDate : null
          }
        });
      }

      const dateStrings = datesToUpdate.map((d) => toTaipeiDateString(d));
      const beforeByDate = {};
      const changedFields = Object.keys(dataToUpdate);
      for (const dStr of dateStrings) {
        const prev = existingByDateStr.get(dStr);
        if (!prev) {
          beforeByDate[dStr] = null;
        } else {
          const snap = {};
          for (const f of changedFields) {
            snap[f] = f === 'iron_date' && prev[f] ? toTaipeiDateString(prev[f]) : (prev[f] ?? null);
          }
          beforeByDate[dStr] = snap;
        }
      }

      const serializedChanges = { ...dataToUpdate };
      if (serializedChanges.iron_date instanceof Date) {
        serializedChanges.iron_date = toTaipeiDateString(serializedChanges.iron_date);
      }

      const deviceInfo = getAdminDeviceInfo(req);
      await auditService.log(tx, {
        event_type: 'daily_setting_changed',
        category: 'setting',
        target_type: 'daily_setting',
        target_ref: dateStrings.join(','),
        summary: `批次修改 ${dateStrings.length} 天設定（${dateStrings[0]}～${dateStrings[dateStrings.length - 1]}）：${changedFields.join('、')}`,
        before_json: beforeByDate,
        after_json: { dates: dateStrings, changes: serializedChanges },
        staff_name: req.user?.name || '管理員',
        staff_id: req.user?.id || null,
        device_id: deviceInfo?.device_id || null,
        device_label: deviceInfo?.device_label || '後台'
      });
    });

    displayBus.settingsChanged();
    res.json({ message: `Successfully updated ${datesToUpdate.length} days` });
  } catch (error) {
    console.error('Error batch updating daily settings:', error);
    res.status(500).json({ error: 'Failed to batch update daily settings' });
  }
};

export const getGlobalSetting = async (req, res) => {
  try {
    let setting = await prisma.globalSetting.findUnique({ where: { id: 1 } });
    if (!setting) {
      setting = await prisma.globalSetting.create({
        data: { 
          weekday_hourly_price: 100, 
          weekday_unlimited_price: 550,
          weekend_hourly_price: 150,
          weekend_unlimited_price: 800
        }
      });
    }

    const rawMethods = Array.isArray(setting.payment_methods_json) && setting.payment_methods_json.length > 0
      ? setting.payment_methods_json
      : DEFAULT_PAYMENT_METHODS;
    const payment_methods_json = rawMethods.filter(m => String(m.key || m.code || '').trim().toLowerCase() !== 'pass');

    const baseSafe = sanitizeGlobalSetting(setting);
    const safeSetting = {
      ...baseSafe,
      payment_methods_json,
      business_hours_json: setting.business_hours_json || DEFAULT_BUSINESS_HOURS,
      line_auto_notify_booking: setting.line_auto_notify_booking ?? false,
      line_auto_notify_cancel: setting.line_auto_notify_cancel ?? false,
      shop_enabled: setting.shop_enabled ?? true,
      show_shop_button: setting.show_shop_button ?? setting.shop_enabled ?? true,
      default_session_capacity: setting.default_session_capacity ?? 16,
      print_enabled: setting.print_enabled ?? true,
      billing_grace_minutes: setting.billing_grace_minutes ?? 10,
      billing_block_minutes: setting.billing_block_minutes ?? 30,
      board_swap_grace_minutes: setting.board_swap_grace_minutes ?? 10,
      early_leave_mode: setting.early_leave_mode || 'booked',
      default_split_mode: setting.default_split_mode || 'proportional',
      cash_float_amount: setting.cash_float_amount ?? 2000,
      auto_print_receipt: setting.auto_print_receipt ?? true,
      auto_print_summary: setting.auto_print_summary ?? true,
      receipt_footer_text: setting.receipt_footer_text ?? null
    };

    res.json(safeSetting);
  } catch (error) {
    console.error('Error fetching global setting:', error);
    res.status(500).json({ error: 'Failed to fetch global setting' });
  }
};

const READONLY_GLOBAL_META_FIELDS = new Set([
  'id',
  'created_at',
  'updated_at',
  'has_line_messaging_token',
  'line_messaging_token_masked',
]);

const GLOBAL_BOOLEAN_FIELDS = new Set([
  'show_price_cards',
  'show_announcement',
  'show_line_button',
  'require_line_login_every_time',
  'enable_preview_page',
  'allow_equipment_exceed_pax',
  'show_equipment_live_stock',
  'equipment_discount_enabled',
  'equipment_discount_stackable',
  'equipment_discount2_enabled',
  'line_auto_notify_booking',
  'line_auto_notify_cancel',
  'show_shop_button',
  'shop_enabled',
  'print_enabled',
  'auto_print_receipt',
  'auto_print_summary',
]);

const GLOBAL_INT_FIELDS = new Set([
  'weekday_hourly_price',
  'weekday_unlimited_price',
  'weekend_hourly_price',
  'weekend_unlimited_price',
  'default_session_capacity',
  'billing_grace_minutes',
  'billing_block_minutes',
  'board_swap_grace_minutes',
  'cash_float_amount',
]);

const HH_MM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function parseStrictInt(val) {
  if (typeof val === 'number') {
    return Number.isInteger(val) ? val : null;
  }
  if (typeof val === 'string') {
    const trimmed = val.trim();
    if (!/^-?\d+$/.test(trimmed)) return null;
    const parsed = Number(trimmed);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  return null;
}

const VALID_BILLING_BLOCKS = new Set([15, 30, 60]);
const VALID_EARLY_LEAVE_MODES = new Set(['booked', 'actual']);
const VALID_DEFAULT_SPLIT_MODES = new Set(['proportional', 'even', 'first']);

const EQUIPMENT_HOUR_FALLBACKS = {
  equipment_discount_buy_hours: 3,
  equipment_discount_free_hours: 1,
  equipment_discount2_buy_hours: 8,
  equipment_discount2_free_hours: 4,
};

function normalizePaymentMethods(raw) {
  if (!Array.isArray(raw)) return null;
  const methods = raw
    .filter(pm => String(pm?.key || pm?.code || '').trim().toLowerCase() !== 'pass')
    .map(pm => {
      const key = String(pm?.key || pm?.code || '').trim();
      const isCash = key.toLowerCase() === 'cash';
      return {
        key,
        label: pm?.label || (isCash ? '現金' : key),
        enabled: isCash ? true : Boolean(pm?.enabled)
      };
    });
  const hasCash = methods.some(m => m.key.toLowerCase() === 'cash');
  if (!hasCash) {
    methods.unshift({ key: 'cash', label: '現金', enabled: true });
  }
  return methods;
}

function normalizeBookingNoteChips(arr) {
  if (!Array.isArray(arr)) return null;
  return arr
    .map((s) => String(s || '').trim())
    .filter(Boolean)
    .map((s) => s.slice(0, 12))
    .slice(0, 8);
}

function getEffectiveOldSetting(oldSetting) {
  const rawMethods = Array.isArray(oldSetting?.payment_methods_json) && oldSetting.payment_methods_json.length > 0
    ? oldSetting.payment_methods_json
    : DEFAULT_PAYMENT_METHODS;
  const lineButtonUrl = oldSetting?.line_button_url ?? 'https://lin.ee/vsZhRW5';
  return {
    weekday_hourly_price: oldSetting?.weekday_hourly_price ?? 100,
    weekday_unlimited_price: oldSetting?.weekday_unlimited_price ?? 550,
    weekend_hourly_price: oldSetting?.weekend_hourly_price ?? 150,
    weekend_unlimited_price: oldSetting?.weekend_unlimited_price ?? 800,
    show_price_cards: oldSetting?.show_price_cards ?? true,
    price_notice_text: oldSetting?.price_notice_text ?? '費用皆含基礎傳統拼豆板與豆子無限使用．預約現場保留 15 分鐘．離場前請預留 10 分鐘壓平作品',
    show_announcement: oldSetting?.show_announcement ?? true,
    announcement_text: oldSetting?.announcement_text ?? '✨ 歡迎來到拾光製所！線上預約享即時選位，智能拼豆板租借滿時數再享買送折抵優惠',
    show_line_button: oldSetting?.show_line_button ?? true,
    line_button_url: lineButtonUrl,
    official_line_url: oldSetting?.official_line_url ?? lineButtonUrl,
    require_line_login_every_time: oldSetting?.require_line_login_every_time ?? false,
    enable_preview_page: oldSetting?.enable_preview_page ?? true,
    preview_disabled_text: oldSetting?.preview_disabled_text ?? '系統維護中，請點擊下方按鈕使用 LINE 進行預約',
    allow_equipment_exceed_pax: oldSetting?.allow_equipment_exceed_pax ?? false,
    show_equipment_live_stock: oldSetting?.show_equipment_live_stock ?? true,
    equipment_discount_enabled: oldSetting?.equipment_discount_enabled ?? true,
    equipment_discount_buy_hours: oldSetting?.equipment_discount_buy_hours ?? 3,
    equipment_discount_free_hours: oldSetting?.equipment_discount_free_hours ?? 1,
    equipment_discount_stackable: oldSetting?.equipment_discount_stackable ?? true,
    equipment_discount2_enabled: oldSetting?.equipment_discount2_enabled ?? false,
    equipment_discount2_buy_hours: oldSetting?.equipment_discount2_buy_hours ?? 8,
    equipment_discount2_free_hours: oldSetting?.equipment_discount2_free_hours ?? 4,
    line_auto_notify_booking: oldSetting?.line_auto_notify_booking ?? false,
    line_auto_notify_cancel: oldSetting?.line_auto_notify_cancel ?? false,
    show_shop_button: oldSetting?.show_shop_button ?? oldSetting?.shop_enabled ?? true,
    shop_enabled: oldSetting?.shop_enabled ?? true,
    business_hours_json: oldSetting?.business_hours_json || DEFAULT_BUSINESS_HOURS,
    booking_note_chips: Array.isArray(oldSetting?.booking_note_chips)
      ? normalizeBookingNoteChips(oldSetting.booking_note_chips)
      : null,
    guest_line_hint_text: oldSetting?.guest_line_hint_text ?? null,
    default_session_capacity: oldSetting?.default_session_capacity ?? 16,
    payment_methods_json: normalizePaymentMethods(rawMethods),
    print_enabled: oldSetting?.print_enabled ?? true,
    billing_grace_minutes: oldSetting?.billing_grace_minutes ?? 10,
    billing_block_minutes: oldSetting?.billing_block_minutes ?? 30,
    board_swap_grace_minutes: oldSetting?.board_swap_grace_minutes ?? 10,
    early_leave_mode: oldSetting?.early_leave_mode ?? 'booked',
    default_split_mode: oldSetting?.default_split_mode ?? 'proportional',
    cash_float_amount: oldSetting?.cash_float_amount ?? 2000,
    auto_print_receipt: oldSetting?.auto_print_receipt ?? true,
    auto_print_summary: oldSetting?.auto_print_summary ?? true,
    receipt_footer_text: oldSetting?.receipt_footer_text ?? '謝謝光臨，作品記得帶回家',
    has_line_messaging_token: Boolean(oldSetting?.line_messaging_token && String(oldSetting.line_messaging_token).trim()),
  };
}

function didGlobalSettingFieldChange(field, incoming, oldSetting, effectiveOld) {
  if (incoming === undefined || READONLY_GLOBAL_META_FIELDS.has(field)) return false;

  if (field === 'cancel_pending_jobs' || field === 'cancel_unprinted_jobs') {
    return Boolean(incoming);
  }
  if (field === 'line_messaging_token') {
    if (typeof incoming === 'string' && (incoming.includes('•') || incoming.includes('****'))) {
      return false;
    }
    if (incoming === '' || incoming === null) {
      return Boolean(oldSetting?.line_messaging_token);
    }
    return String(incoming).trim() !== String(oldSetting?.line_messaging_token || '').trim();
  }
  if (field === 'payment_methods_json') {
    if (!Array.isArray(incoming)) return false;
    return JSON.stringify(normalizePaymentMethods(incoming)) !== JSON.stringify(effectiveOld.payment_methods_json);
  }
  if (field === 'business_hours_json') {
    return JSON.stringify(incoming) !== JSON.stringify(effectiveOld.business_hours_json);
  }
  if (field === 'booking_note_chips') {
    if (!Array.isArray(incoming)) return false;
    return JSON.stringify(normalizeBookingNoteChips(incoming)) !== JSON.stringify(effectiveOld.booking_note_chips);
  }
  if (field === 'official_line_url' || field === 'line_button_url') {
    const normalizedIn = incoming === null ? null : String(incoming).trim();
    const normalizedOld = effectiveOld[field] === null ? null : String(effectiveOld[field]).trim();
    return normalizedIn !== normalizedOld;
  }
  if (field === 'guest_line_hint_text') {
    const normalizedIn = typeof incoming === 'string' ? incoming.trim() : null;
    const normalizedOld = typeof effectiveOld.guest_line_hint_text === 'string'
      ? effectiveOld.guest_line_hint_text.trim()
      : null;
    return normalizedIn !== normalizedOld;
  }
  if (GLOBAL_INT_FIELDS.has(field)) {
    if (incoming === null || incoming === '') return true;
    const parsed = parseStrictInt(incoming);
    if (parsed === null) return true;
    return parsed !== effectiveOld[field];
  }
  if (field === 'receipt_footer_text') {
    const normalizedIn = typeof incoming === 'string' ? (incoming.trim() || null) : null;
    const normalizedOld = typeof effectiveOld.receipt_footer_text === 'string'
      ? (effectiveOld.receipt_footer_text.trim() || null)
      : null;
    return normalizedIn !== normalizedOld;
  }
  if (Object.prototype.hasOwnProperty.call(EQUIPMENT_HOUR_FALLBACKS, field)) {
    const parsed = Math.max(1, parseInt(incoming, 10) || EQUIPMENT_HOUR_FALLBACKS[field]);
    return parsed !== effectiveOld[field];
  }
  if (GLOBAL_BOOLEAN_FIELDS.has(field)) {
    return Boolean(incoming) !== Boolean(effectiveOld[field]);
  }
  if (incoming !== null && typeof incoming === 'object') {
    return JSON.stringify(incoming) !== JSON.stringify(oldSetting?.[field] ?? null);
  }
  const currentVal = Object.prototype.hasOwnProperty.call(effectiveOld, field)
    ? effectiveOld[field]
    : oldSetting?.[field];
  return incoming !== currentVal;
}

export const updateGlobalSetting = async (req, res) => {
  const { 
    weekday_hourly_price, 
    weekday_unlimited_price, 
    weekend_hourly_price, 
    weekend_unlimited_price,
    show_price_cards,
    price_notice_text,
    show_announcement,
    announcement_text,
    show_line_button,
    line_button_url,
    official_line_url,
    require_line_login_every_time,
    enable_preview_page,
    preview_disabled_text,
    allow_equipment_exceed_pax,
    show_equipment_live_stock,
    equipment_discount_enabled,
    equipment_discount_buy_hours,
    equipment_discount_free_hours,
    equipment_discount_stackable,
    equipment_discount2_enabled,
    equipment_discount2_buy_hours,
    equipment_discount2_free_hours,
    line_messaging_token,
    line_auto_notify_booking,
    line_auto_notify_cancel,
    show_shop_button,
    shop_enabled,
    business_hours_json,
    booking_note_chips,
    guest_line_hint_text,
    default_session_capacity,
    payment_methods_json,
    print_enabled,
    cancel_pending_jobs,
    cancel_unprinted_jobs,
    billing_grace_minutes,
    billing_block_minutes,
    board_swap_grace_minutes,
    early_leave_mode,
    default_split_mode,
    cash_float_amount,
    auto_print_receipt,
    auto_print_summary,
    receipt_footer_text
  } = req.body;

  try {
    const oldSetting = await prisma.globalSetting.findUnique({ where: { id: 1 } });
    const effectiveOld = getEffectiveOldSetting(oldSetting);

    if (!canAdminPermission(req.user, 'settings')) {
      const disallowedFields = [];
      const missingGroups = [];

      for (const field of Object.keys(req.body || {})) {
        if (!didGlobalSettingFieldChange(field, req.body[field], oldSetting, effectiveOld)) {
          continue;
        }
        const requiredGroup = findSettingGroupForField(field);
        if (!canAdminPermission(req.user, requiredGroup)) {
          disallowedFields.push(field);
          if (!missingGroups.includes(requiredGroup)) {
            missingGroups.push(requiredGroup);
          }
        }
      }

      if (disallowedFields.length > 0) {
        const labels = missingGroups.map((g) => PERMISSION_LABELS[g] || g);
        return res.status(403).json({
          code: 'PERMISSION_REQUIRED',
          fields: disallowedFields,
          required: missingGroups,
          error: `修改這些欄位需要「${labels.join('、')}」權限`,
        });
      }
    }

    const dataToUpdate = {};

    // Strict range & format validations (any error returns 422 { error, field } before writing anything)
    if (billing_grace_minutes !== undefined) {
      const parsed = parseStrictInt(billing_grace_minutes);
      if (parsed === null || parsed < 0 || parsed > 30) {
        return res.status(422).json({ field: 'billing_grace_minutes', error: '超時寬限必須為 0 至 30 的整數' });
      }
      dataToUpdate.billing_grace_minutes = parsed;
    }
    if (billing_block_minutes !== undefined) {
      const parsed = parseStrictInt(billing_block_minutes);
      if (parsed === null || !VALID_BILLING_BLOCKS.has(parsed)) {
        return res.status(422).json({ field: 'billing_block_minutes', error: '計費單位只能是 15、30 或 60 分鐘' });
      }
      dataToUpdate.billing_block_minutes = parsed;
    }
    if (board_swap_grace_minutes !== undefined) {
      const parsed = parseStrictInt(board_swap_grace_minutes);
      if (parsed === null || parsed < 0 || parsed > 30) {
        return res.status(422).json({ field: 'board_swap_grace_minutes', error: '換板寬限必須為 0 至 30 的整數' });
      }
      dataToUpdate.board_swap_grace_minutes = parsed;
    }
    if (early_leave_mode !== undefined) {
      if (typeof early_leave_mode !== 'string' || !VALID_EARLY_LEAVE_MODES.has(early_leave_mode)) {
        return res.status(422).json({ field: 'early_leave_mode', error: '提早離開計費模式必須為 booked 或 actual' });
      }
      dataToUpdate.early_leave_mode = early_leave_mode;
    }
    if (default_split_mode !== undefined) {
      if (typeof default_split_mode !== 'string' || !VALID_DEFAULT_SPLIT_MODES.has(default_split_mode)) {
        return res.status(422).json({ field: 'default_split_mode', error: '預設分攤方式必須為 proportional、even 或 first' });
      }
      dataToUpdate.default_split_mode = default_split_mode;
    }
    if (cash_float_amount !== undefined) {
      const parsed = parseStrictInt(cash_float_amount);
      if (parsed === null || parsed < 0 || parsed > 100000) {
        return res.status(422).json({ field: 'cash_float_amount', error: '收銀機起始零用金必須為 0 至 100000 的整數' });
      }
      dataToUpdate.cash_float_amount = parsed;
    }
    if (auto_print_receipt !== undefined) {
      if (typeof auto_print_receipt !== 'boolean') {
        return res.status(422).json({ field: 'auto_print_receipt', error: '完成結帳就列印必須為布林值' });
      }
      dataToUpdate.auto_print_receipt = auto_print_receipt;
    }
    if (auto_print_summary !== undefined) {
      if (typeof auto_print_summary !== 'boolean') {
        return res.status(422).json({ field: 'auto_print_summary', error: '整組結清時自動印總表必須為布林值' });
      }
      dataToUpdate.auto_print_summary = auto_print_summary;
    }
    if (receipt_footer_text !== undefined) {
      if (receipt_footer_text === null) {
        dataToUpdate.receipt_footer_text = null;
      } else if (typeof receipt_footer_text !== 'string') {
        return res.status(422).json({ field: 'receipt_footer_text', error: '收據頁尾文字必須為字串' });
      } else {
        const trimmed = receipt_footer_text.trim();
        if (trimmed === '') {
          dataToUpdate.receipt_footer_text = null;
        } else {
          if (trimmed.length > 60) {
            return res.status(422).json({ field: 'receipt_footer_text', error: '收據頁尾文字不可超過 60 字' });
          }
          const newlineCount = (trimmed.match(/\r?\n/g) || []).length;
          if (newlineCount > 2) {
            return res.status(422).json({ field: 'receipt_footer_text', error: '收據頁尾文字最多只能有 2 個換行' });
          }
          dataToUpdate.receipt_footer_text = trimmed;
        }
      }
    }

    const priceFields = [
      ['weekday_hourly_price', weekday_hourly_price, '平日每小時價格'],
      ['weekday_unlimited_price', weekday_unlimited_price, '平日不限時價格'],
      ['weekend_hourly_price', weekend_hourly_price, '假日每小時價格'],
      ['weekend_unlimited_price', weekend_unlimited_price, '假日不限時價格']
    ];
    for (const [pKey, pVal, pLabel] of priceFields) {
      if (pVal !== undefined) {
        const parsed = parseStrictInt(pVal);
        if (parsed === null || parsed < 0 || parsed > 10000) {
          return res.status(422).json({ field: pKey, error: `${pLabel}必須為 0 至 10000 的整數` });
        }
        dataToUpdate[pKey] = parsed;
      }
    }

    if (default_session_capacity !== undefined) {
      const parsed = parseStrictInt(default_session_capacity);
      if (parsed === null || parsed < 1 || parsed > 200) {
        return res.status(422).json({ field: 'default_session_capacity', error: '預設時段人數上限必須為 1 至 200 的整數' });
      }
      dataToUpdate.default_session_capacity = parsed;
    }

    if (business_hours_json !== undefined && didGlobalSettingFieldChange('business_hours_json', business_hours_json, oldSetting, effectiveOld)) {
      if (!business_hours_json || typeof business_hours_json !== 'object' || Array.isArray(business_hours_json)) {
        return res.status(422).json({ field: 'business_hours_json', error: '營業時間格式無效' });
      }
      for (const [, dayHours] of Object.entries(business_hours_json)) {
        if (
          !dayHours ||
          typeof dayHours !== 'object' ||
          typeof dayHours.start !== 'string' ||
          typeof dayHours.end !== 'string' ||
          !HH_MM_RE.test(dayHours.start) ||
          !HH_MM_RE.test(dayHours.end) ||
          dayHours.start >= dayHours.end
        ) {
          return res.status(422).json({
            field: 'business_hours_json',
            error: '每天的營業時間須為 HH:MM，且開始時間必須早於結束時間'
          });
        }
      }
      dataToUpdate.business_hours_json = business_hours_json;
    }

    if (official_line_url !== undefined) {
      if (official_line_url !== null && (typeof official_line_url !== 'string' || (official_line_url.trim() && !isSafeHttpUrl(official_line_url)))) {
        return res.status(422).json({ field: 'official_line_url', code: 'INVALID_URL', error: '網址必須以 http:// 或 https:// 開頭' });
      }
      const cleanOfficialUrl = safeHttpUrl(official_line_url, null);
      dataToUpdate.official_line_url = cleanOfficialUrl;
      if (line_button_url === undefined) {
        dataToUpdate.line_button_url = cleanOfficialUrl;
      }
    }
    if (line_button_url !== undefined) {
      if (line_button_url !== null && (typeof line_button_url !== 'string' || (line_button_url.trim() && !isSafeHttpUrl(line_button_url)))) {
        return res.status(422).json({ field: 'line_button_url', code: 'INVALID_URL', error: '網址必須以 http:// 或 https:// 開頭' });
      }
      const cleanBtnUrl = safeHttpUrl(line_button_url, null);
      dataToUpdate.line_button_url = cleanBtnUrl;
      if (dataToUpdate.official_line_url === undefined) {
        dataToUpdate.official_line_url = cleanBtnUrl;
      }
    }

    if (print_enabled !== undefined) {
      dataToUpdate.print_enabled = Boolean(print_enabled);
      if (dataToUpdate.print_enabled === false && (cancel_pending_jobs || cancel_unprinted_jobs)) {
        const unprintedJobs = await prisma.printJob.findMany({
          where: { status: { in: ['queued', 'claimed'] } }
        });
        if (unprintedJobs.length > 0) {
          await prisma.printJob.updateMany({
            where: { id: { in: unprintedJobs.map(j => j.id) } },
            data: { status: 'cancelled' }
          });
          await auditService.log(prisma, {
            event_type: 'print_jobs_cancelled',
            category: 'print',
            summary: `關閉列印，已取消 ${unprintedJobs.length} 張未印單據`,
            staff_name: req.user?.name || '管理員',
            device_label: '後台'
          }).catch(err => console.error('Failed to log audit event for print_jobs_cancelled:', err));
        }
      }
    }
    let removedPaymentMethodsToCheck = [];
    if (payment_methods_json !== undefined) {
      if (!Array.isArray(payment_methods_json) || payment_methods_json.length === 0) {
        return res.status(422).json({ error: '付款方式清單不可為空', field: 'payment_methods_json' });
      }
      if (payment_methods_json.length > 12) {
        return res.status(422).json({ error: '付款方式最多 12 個', field: 'payment_methods_json' });
      }

      const keyRe = /^[a-z][a-z0-9_]{1,23}$/;
      const seenNormKeys = new Set();
      const seenLabels = new Set();
      const validatedMethods = [];

      for (const pm of payment_methods_json) {
        const key = String(pm?.key ?? pm?.code ?? '').trim();
        if (!keyRe.test(key)) {
          return res.status(422).json({
            error: `付款方式代碼「${key || '(空)'}」須為小寫英文開頭、僅含小寫英數與底線（2～24 字）`,
            field: 'payment_methods_json'
          });
        }
        const normKey = normalizeMethodKey(key);
        if (RESERVED_PAYMENT_KEYS.has(key) || RESERVED_PAYMENT_KEYS.has(normKey)) {
          return res.status(422).json({
            error: `保留字「${key}」不可作為付款方式代碼`,
            field: 'payment_methods_json'
          });
        }
        if (seenNormKeys.has(normKey)) {
          return res.status(422).json({
            error: `付款方式代碼「${key}」正規化後重複`,
            field: 'payment_methods_json'
          });
        }
        seenNormKeys.add(normKey);

        const isCash = normKey === 'cash';
        const label = isCash ? '現金' : String(pm?.label ?? '').trim();
        if (!isCash && (!label || label.length > 12)) {
          return res.status(422).json({
            error: '付款方式名稱須為 1～12 字',
            field: 'payment_methods_json'
          });
        }
        if (seenLabels.has(label)) {
          return res.status(422).json({
            error: `付款方式名稱「${label}」不可重複`,
            field: 'payment_methods_json'
          });
        }
        seenLabels.add(label);

        validatedMethods.push({
          key,
          label,
          enabled: isCash ? true : Boolean(pm?.enabled)
        });
      }

      if (!seenNormKeys.has('cash')) {
        if (validatedMethods.length >= 12) {
          return res.status(422).json({ error: '付款方式最多 12 個（須保留現金）', field: 'payment_methods_json' });
        }
        if (seenLabels.has('現金')) {
          return res.status(422).json({ error: '付款方式名稱「現金」不可重複', field: 'payment_methods_json' });
        }
        validatedMethods.unshift({ key: 'cash', label: '現金', enabled: true });
        seenNormKeys.add('cash');
      }

      removedPaymentMethodsToCheck = (effectiveOld.payment_methods_json || []).filter((oldPm) => {
        const oldNorm = normalizeMethodKey(oldPm?.key || oldPm?.code);
        return oldNorm && !RESERVED_PAYMENT_KEYS.has(oldNorm) && !seenNormKeys.has(oldNorm);
      });

      dataToUpdate.payment_methods_json = validatedMethods;
    }
    if (booking_note_chips !== undefined) {
      if (Array.isArray(booking_note_chips)) {
        const cleaned = booking_note_chips
          .map((s) => String(s || '').trim())
          .filter(Boolean)
          .map((s) => s.slice(0, 12))
          .slice(0, 8);
        dataToUpdate.booking_note_chips = cleaned;
      }
    }
    if (guest_line_hint_text !== undefined) {
      dataToUpdate.guest_line_hint_text = typeof guest_line_hint_text === 'string' ? guest_line_hint_text.trim() : null;
    }
    if (show_price_cards !== undefined) dataToUpdate.show_price_cards = Boolean(show_price_cards);
    if (price_notice_text !== undefined) dataToUpdate.price_notice_text = price_notice_text;
    if (show_announcement !== undefined) dataToUpdate.show_announcement = Boolean(show_announcement);
    if (announcement_text !== undefined) dataToUpdate.announcement_text = announcement_text;
    if (show_line_button !== undefined) dataToUpdate.show_line_button = Boolean(show_line_button);
    if (require_line_login_every_time !== undefined) dataToUpdate.require_line_login_every_time = Boolean(require_line_login_every_time);
    if (enable_preview_page !== undefined) dataToUpdate.enable_preview_page = Boolean(enable_preview_page);
    if (preview_disabled_text !== undefined) dataToUpdate.preview_disabled_text = preview_disabled_text;
    if (allow_equipment_exceed_pax !== undefined) dataToUpdate.allow_equipment_exceed_pax = Boolean(allow_equipment_exceed_pax);
    if (show_equipment_live_stock !== undefined) dataToUpdate.show_equipment_live_stock = Boolean(show_equipment_live_stock);
    if (equipment_discount_enabled !== undefined) dataToUpdate.equipment_discount_enabled = Boolean(equipment_discount_enabled);
    if (equipment_discount_buy_hours !== undefined) dataToUpdate.equipment_discount_buy_hours = Math.max(1, parseInt(equipment_discount_buy_hours, 10) || 3);
    if (equipment_discount_free_hours !== undefined) dataToUpdate.equipment_discount_free_hours = Math.max(1, parseInt(equipment_discount_free_hours, 10) || 1);
    if (equipment_discount_stackable !== undefined) dataToUpdate.equipment_discount_stackable = Boolean(equipment_discount_stackable);
    if (equipment_discount2_enabled !== undefined) dataToUpdate.equipment_discount2_enabled = Boolean(equipment_discount2_enabled);
    if (equipment_discount2_buy_hours !== undefined) dataToUpdate.equipment_discount2_buy_hours = Math.max(1, parseInt(equipment_discount2_buy_hours, 10) || 8);
    if (equipment_discount2_free_hours !== undefined) dataToUpdate.equipment_discount2_free_hours = Math.max(1, parseInt(equipment_discount2_free_hours, 10) || 4);

    if (line_messaging_token !== undefined) {
      if (line_messaging_token === '' || line_messaging_token === null) {
        dataToUpdate.line_messaging_token = null;
      } else if (typeof line_messaging_token === 'string' && !line_messaging_token.includes('•') && !line_messaging_token.includes('****')) {
        dataToUpdate.line_messaging_token = line_messaging_token.trim();
      }
    }
    if (line_auto_notify_booking !== undefined) dataToUpdate.line_auto_notify_booking = Boolean(line_auto_notify_booking);
    if (line_auto_notify_cancel !== undefined) dataToUpdate.line_auto_notify_cancel = Boolean(line_auto_notify_cancel);
    if (show_shop_button !== undefined) dataToUpdate.show_shop_button = Boolean(show_shop_button);
    if (shop_enabled !== undefined) dataToUpdate.shop_enabled = Boolean(shop_enabled);

    const deviceInfo = req?.headers
      ? getAdminDeviceInfo(req)
      : { device_id: null, device_label: '後台' };
    const auditBefore = {
      ...effectiveOld,
      line_messaging_token: oldSetting?.line_messaging_token || null,
      has_line_messaging_token: Boolean(oldSetting?.line_messaging_token && String(oldSetting.line_messaging_token).trim())
    };

    const setting = await prisma.$transaction(async (tx) => {
      if (removedPaymentMethodsToCheck.length > 0) {
        const usedRows = await tx.payment.findMany({
          distinct: ['method'],
          select: { method: true }
        });
        const usedNormSet = new Set(usedRows.map(r => normalizeMethodKey(r.method)).filter(Boolean));
        for (const oldPm of removedPaymentMethodsToCheck) {
          const oldNorm = normalizeMethodKey(oldPm?.key || oldPm?.code);
          if (usedNormSet.has(oldNorm)) {
            throw {
              status: 422,
              field: 'payment_methods_json',
              message: `付款方式「${oldPm.label || oldPm.key}」已有收款紀錄，只能停用`
            };
          }
        }
      }

      const saved = await tx.globalSetting.upsert({
        where: { id: 1 },
        update: dataToUpdate,
        create: {
          id: 1,
          weekday_hourly_price: dataToUpdate.weekday_hourly_price ?? 100,
          weekday_unlimited_price: dataToUpdate.weekday_unlimited_price ?? 550,
          weekend_hourly_price: dataToUpdate.weekend_hourly_price ?? 150,
          weekend_unlimited_price: dataToUpdate.weekend_unlimited_price ?? 800,
          show_price_cards: dataToUpdate.show_price_cards ?? true,
          price_notice_text: dataToUpdate.price_notice_text ?? "費用皆含基礎傳統拼豆板與豆子無限使用．預約現場保留 15 分鐘．離場前請預留 10 分鐘壓平作品",
          show_announcement: dataToUpdate.show_announcement ?? true,
          announcement_text: dataToUpdate.announcement_text ?? "✨ 歡迎來到拾光製所！線上預約享即時選位，智能拼豆板租借滿時數再享買送折抵優惠",
          show_line_button: dataToUpdate.show_line_button ?? true,
          line_button_url: dataToUpdate.line_button_url ?? "https://lin.ee/vsZhRW5",
          require_line_login_every_time: dataToUpdate.require_line_login_every_time ?? false,
          enable_preview_page: dataToUpdate.enable_preview_page ?? true,
          preview_disabled_text: dataToUpdate.preview_disabled_text ?? "系統維護中，請點擊下方按鈕使用 LINE 進行預約",
          business_hours_json: dataToUpdate.business_hours_json ?? DEFAULT_BUSINESS_HOURS,
          default_session_capacity: dataToUpdate.default_session_capacity ?? 16,
          billing_grace_minutes: dataToUpdate.billing_grace_minutes ?? 10,
          billing_block_minutes: dataToUpdate.billing_block_minutes ?? 30,
          board_swap_grace_minutes: dataToUpdate.board_swap_grace_minutes ?? 10,
          early_leave_mode: dataToUpdate.early_leave_mode ?? 'booked',
          default_split_mode: dataToUpdate.default_split_mode ?? 'proportional',
          cash_float_amount: dataToUpdate.cash_float_amount ?? 2000,
          auto_print_receipt: dataToUpdate.auto_print_receipt ?? true,
          auto_print_summary: dataToUpdate.auto_print_summary ?? true,
          receipt_footer_text: dataToUpdate.receipt_footer_text !== undefined ? dataToUpdate.receipt_footer_text : '謝謝光臨，作品記得帶回家'
        }
      });

      await logSettingChange(tx, {
        before: auditBefore,
        after: dataToUpdate,
        staff: {
          id: req.user?.id || null,
          name: req.user?.name || '管理員',
          device_id: deviceInfo?.device_id || null,
          device_label: deviceInfo?.device_label || '後台'
        },
        scope: 'global'
      });

      return saved;
    });

    if (dataToUpdate.payment_methods_json !== undefined) {
      displayBus.settingsChanged();
    }

    res.json({ message: 'Global setting updated successfully', setting: sanitizeGlobalSetting(setting) });
  } catch (error) {
    if (error?.status) {
      return res.status(error.status).json({
        error: error.message,
        ...(error.field ? { field: error.field } : {})
      });
    }
    console.error('Error updating global setting:', error);
    res.status(500).json({ error: 'Failed to update global setting' });
  }
};

