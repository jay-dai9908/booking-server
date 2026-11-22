import prisma from '../prismaClient.js';
import auditService from '../services/audit/auditService.js';
import { dateOnly, toTaipeiDateString } from '../../../shared/time.js';
import { prepayDeadline, ironText } from '../../../shared/selfService.js';
import displayBus from '../services/display/displayBus.js';

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
    const setting = await prisma.dailySetting.findUnique({
      where: { date: dOnly }
    });

    if (!setting) {
      return res.json({
        date,
        allow_unlimited: true,
        is_self_service: false,
        self_allow_hourly: false,
        self_allow_equipment: false,
        iron_mode: 'today',
        iron_date: null,
        self_service: null
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
      self_service
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
    const rows = await prisma.dailySetting.findMany({
      where: {
        date: {
          gte: startDate,
          lte: endDate
        }
      },
      orderBy: { date: 'asc' },
      select: {
        date: true,
        is_self_service: true
      }
    });

    res.json(
      rows.map(r => ({
        date: toTaipeiDateString(r.date),
        is_self_service: Boolean(r.is_self_service)
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

    const setting = await prisma.dailySetting.upsert({
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

    res.json({ message: 'Daily setting updated successfully', setting });
  } catch (error) {
    console.error('Error updating daily setting:', error);
    res.status(500).json({ error: 'Failed to update daily setting' });
  }
};

export const batchUpdateDailySettings = async (req, res) => {
  const {
    start_date,
    end_date,
    days_of_week,
    hourly_price,
    unlimited_price,
    allow_unlimited,
    dates,
    is_self_service,
    self_allow_hourly,
    self_allow_equipment,
    iron_mode,
    iron_date
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

    if (typeof is_self_service === 'boolean') {
      const existingRows = await prisma.dailySetting.findMany({
        where: { date: { in: datesToUpdate } },
        select: { date: true, is_self_service: true }
      });
      const existingByDate = new Map(existingRows.map(r => [toTaipeiDateString(r.date), Boolean(r.is_self_service)]));

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
        const prev = existingByDate.get(dStr) ?? false;
        if (is_self_service !== prev) {
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

    const dataToUpdate = {};
    if (typeof allow_unlimited === 'boolean') dataToUpdate.allow_unlimited = allow_unlimited;
    if (hourly_price !== undefined) dataToUpdate.hourly_price = (hourly_price === null || hourly_price === '') ? null : parseInt(hourly_price, 10);
    if (unlimited_price !== undefined) dataToUpdate.unlimited_price = (unlimited_price === null || unlimited_price === '') ? null : parseInt(unlimited_price, 10);
    if (typeof is_self_service === 'boolean') dataToUpdate.is_self_service = is_self_service;
    if (typeof self_allow_hourly === 'boolean') dataToUpdate.self_allow_hourly = self_allow_hourly;
    if (typeof self_allow_equipment === 'boolean') dataToUpdate.self_allow_equipment = self_allow_equipment;
    if (iron_mode !== undefined) {
      dataToUpdate.iron_mode = String(iron_mode);
      dataToUpdate.iron_date = iron_mode === 'date' ? parsedIronDate : null;
    }

    const upserts = datesToUpdate.map(date =>
      prisma.dailySetting.upsert({
        where: { date },
        update: dataToUpdate,
        create: {
          date,
          ...dataToUpdate,
          allow_unlimited: allow_unlimited !== undefined ? allow_unlimited : true,
          is_self_service: is_self_service !== undefined ? Boolean(is_self_service) : false,
          self_allow_hourly: self_allow_hourly !== undefined ? Boolean(self_allow_hourly) : false,
          self_allow_equipment: self_allow_equipment !== undefined ? Boolean(self_allow_equipment) : false,
          iron_mode: iron_mode !== undefined ? String(iron_mode) : 'today',
          iron_date: iron_mode === 'date' ? parsedIronDate : null
        }
      })
    );

    await prisma.$transaction(upserts);

    res.json({ message: `Successfully updated ${upserts.length} days` });
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

    // Never expose plain text LINE messaging token to frontend
    const rawToken = setting.line_messaging_token || process.env.LINE_MESSAGING_ACCESS_TOKEN || '';
    const has_line_messaging_token = Boolean(rawToken);
    let line_messaging_token_masked = '';
    if (rawToken) {
      line_messaging_token_masked = `••••••••${rawToken.slice(-4)}`;
    }

    const rawMethods = Array.isArray(setting.payment_methods_json) && setting.payment_methods_json.length > 0
      ? setting.payment_methods_json
      : DEFAULT_PAYMENT_METHODS;
    const payment_methods_json = rawMethods.filter(m => String(m.key || m.code || '').trim().toLowerCase() !== 'pass');

    const safeSetting = {
      ...setting,
      payment_methods_json,
      business_hours_json: setting.business_hours_json || DEFAULT_BUSINESS_HOURS,
      has_line_messaging_token,
      line_messaging_token_masked,
      line_auto_notify_booking: setting.line_auto_notify_booking ?? false,
      line_auto_notify_cancel: setting.line_auto_notify_cancel ?? false,
      shop_enabled: setting.shop_enabled ?? true,
      show_shop_button: setting.show_shop_button ?? setting.shop_enabled ?? true,
      default_session_capacity: setting.default_session_capacity ?? 16,
      print_enabled: setting.print_enabled ?? true
    };
    delete safeSetting.line_messaging_token;

    res.json(safeSetting);
  } catch (error) {
    console.error('Error fetching global setting:', error);
    res.status(500).json({ error: 'Failed to fetch global setting' });
  }
};

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
    cancel_unprinted_jobs
  } = req.body;

  try {
    const dataToUpdate = {};
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
    if (payment_methods_json !== undefined) {
      if (Array.isArray(payment_methods_json)) {
        let methods = payment_methods_json
          .filter(pm => String(pm.key || pm.code || '').trim().toLowerCase() !== 'pass')
          .map(pm => {
            const key = String(pm.key || pm.code || '').trim();
            const isCash = key.toLowerCase() === 'cash';
            return {
              key,
              label: pm.label || (isCash ? '現金' : key),
              enabled: isCash ? true : Boolean(pm.enabled)
            };
          });
        const hasCash = methods.some(m => m.key.toLowerCase() === 'cash');
        if (!hasCash) {
          methods.unshift({ key: 'cash', label: '現金', enabled: true });
        }
        dataToUpdate.payment_methods_json = methods;
      }
    }
    if (default_session_capacity !== undefined && default_session_capacity !== null && default_session_capacity !== '') {
      const parsed = parseInt(default_session_capacity, 10);
      if (!isNaN(parsed) && parsed > 0) {
        dataToUpdate.default_session_capacity = parsed;
      }
    }
    if (business_hours_json !== undefined) {
      dataToUpdate.business_hours_json = business_hours_json;
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
    if (official_line_url !== undefined) {
      dataToUpdate.official_line_url = official_line_url;
      if (line_button_url === undefined) {
        dataToUpdate.line_button_url = official_line_url;
      }
    }
    if (line_button_url !== undefined) {
      dataToUpdate.line_button_url = line_button_url;
      if (dataToUpdate.official_line_url === undefined) {
        dataToUpdate.official_line_url = line_button_url;
      }
    }
    if (weekday_hourly_price !== undefined && weekday_hourly_price !== null && weekday_hourly_price !== '') {
      dataToUpdate.weekday_hourly_price = parseInt(weekday_hourly_price, 10);
    }
    if (weekday_unlimited_price !== undefined && weekday_unlimited_price !== null && weekday_unlimited_price !== '') {
      dataToUpdate.weekday_unlimited_price = parseInt(weekday_unlimited_price, 10);
    }
    if (weekend_hourly_price !== undefined && weekend_hourly_price !== null && weekend_hourly_price !== '') {
      dataToUpdate.weekend_hourly_price = parseInt(weekend_hourly_price, 10);
    }
    if (weekend_unlimited_price !== undefined && weekend_unlimited_price !== null && weekend_unlimited_price !== '') {
      dataToUpdate.weekend_unlimited_price = parseInt(weekend_unlimited_price, 10);
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

    const oldSetting = await prisma.globalSetting.findUnique({ where: { id: 1 } });

    const setting = await prisma.globalSetting.upsert({
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
        default_session_capacity: dataToUpdate.default_session_capacity ?? 16
      }
    });

    if (dataToUpdate.booking_note_chips !== undefined) {
      await auditService.log(prisma, {
        event_type: '設定變更',
        category: 'setting',
        summary: '更新預約備註快速選項',
        before_json: oldSetting?.booking_note_chips ? JSON.stringify(oldSetting.booking_note_chips) : null,
        after_json: JSON.stringify(dataToUpdate.booking_note_chips),
        staff_name: req.user?.name || '管理員',
        device_label: '後台'
      }).catch(err => console.error('Failed to log audit event for booking_note_chips:', err));
    }

    if (dataToUpdate.payment_methods_json !== undefined) {
      displayBus.settingsChanged();
    }

    res.json({ message: 'Global setting updated successfully', setting });
  } catch (error) {
    console.error('Error updating global setting:', error);
    res.status(500).json({ error: 'Failed to update global setting' });
  }
};

