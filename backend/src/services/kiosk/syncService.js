import prisma from '../../prismaClient.js';
import { dateOnly, toTaipeiDateString } from '../../../../shared/time.js';
import { ironText } from '../../../../shared/selfService.js';
import { ensureKioskSetting } from '../selfService/prepayService.js';

export function addDaysYmd(ymd, offsetDays) {
  const [y, m, d] = String(ymd).split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + offsetDays));
  return dt.toISOString().slice(0, 10);
}

/**
 * 產生從今天（台北時間）起算 7 天的報到機每日模式與時段範圍
 * @param {import('@prisma/client').PrismaClient} [db]
 * @param {Date} [now]
 */
export async function buildSevenDaysSchedule(db = prisma, now = new Date()) {
  const todayStr = toTaipeiDateString(now);
  const dateStrs = Array.from({ length: 7 }, (_, i) => addDaysYmd(todayStr, i));
  const dateObjs = dateStrs.map((s) => dateOnly(s));

  const [sessions, dailySettings] = await Promise.all([
    db.session.findMany({
      where: { session_date: { in: dateObjs } },
      select: { session_date: true, start_time: true, end_time: true }
    }),
    db.dailySetting.findMany({
      where: { date: { in: dateObjs } },
      select: { date: true, is_self_service: true, iron_mode: true, iron_date: true }
    })
  ]);

  const sessionsByDate = new Map();
  for (const s of sessions) {
    const key = toTaipeiDateString(s.session_date);
    if (!sessionsByDate.has(key)) sessionsByDate.set(key, []);
    sessionsByDate.get(key).push(s);
  }

  const settingByDate = new Map(
    dailySettings.map((d) => [toTaipeiDateString(d.date), d])
  );

  return dateStrs.map((dateStr) => {
    const daySessions = sessionsByDate.get(dateStr) || [];
    const setting = settingByDate.get(dateStr) || null;

    if (daySessions.length === 0) {
      return {
        date: dateStr,
        mode: 'closed',
        open: null,
        close: null,
        iron_text: ''
      };
    }

    const sortedStarts = daySessions.map((s) => s.start_time).sort((a, b) => a.localeCompare(b));
    const sortedEnds = daySessions.map((s) => s.end_time).sort((a, b) => a.localeCompare(b));
    const open = sortedStarts[0];
    const close = sortedEnds[sortedEnds.length - 1];

    if (setting?.is_self_service) {
      return {
        date: dateStr,
        mode: 'self',
        open,
        close,
        iron_text: ironText({
          iron_mode: setting.iron_mode || 'today',
          iron_date: setting.iron_date,
          date: dateStr,
          today: dateStr
        })
      };
    }

    return {
      date: dateStr,
      mode: 'normal',
      open,
      close,
      iron_text: ''
    };
  });
}

/**
 * 處理報到機 sync 請求：更新裝置狀態、去重複儲存事件、組裝設定與 7 天模式清單
 */
export async function processKioskSync(db = prisma, { device, body = {}, clientIp = null, now = new Date() }) {
  const statusJson = {
    boot_id: body.boot_id ?? null,
    uptime_s: Number.isFinite(Number(body.uptime_s)) ? Number(body.uptime_s) : null,
    reset_reason: body.reset_reason ?? null,
    heap_kb: Number.isFinite(Number(body.heap_kb)) ? Number(body.heap_kb) : null,
    psram_kb: Number.isFinite(Number(body.psram_kb)) ? Number(body.psram_kb) : null,
    rssi: Number.isFinite(Number(body.rssi)) ? Number(body.rssi) : null,
    scanner_ok: typeof body.scanner_ok === 'boolean' ? body.scanner_ok : null,
    last_sync_at: now.toISOString()
  };

  const haveJson = body.have && typeof body.have === 'object' ? body.have : device.have_json;

  await db.kioskDevice.update({
    where: { id: device.id },
    data: {
      last_seen_at: now,
      last_ip: clientIp || null,
      fw_version: typeof body.fw === 'string' && body.fw.trim() ? body.fw.trim() : device.fw_version,
      status_json: statusJson,
      have_json: haveJson ?? undefined
    }
  });

  const events = Array.isArray(body.events) ? body.events : [];
  const ackEventIds = [];

  for (const ev of events) {
    if (!ev || typeof ev.id !== 'string' || !ev.id.trim()) continue;
    const eventId = ev.id.trim();

    if (ev.type === 'backup_open') {
      const evAtSec = ev.at === null || ev.at === undefined ? null : Number(ev.at);
      const hasValidTime = evAtSec !== null && Number.isFinite(evAtSec) && evAtSec > 0;
      const evAt = hasValidTime ? new Date(evAtSec * 1000) : now;
      const atUnknown = !hasValidTime;
      await db.kioskAccessLog.upsert({
        where: {
          device_id_event_id: {
            device_id: device.id,
            event_id: eventId
          }
        },
        update: {},
        create: {
          device_id: device.id,
          at: evAt,
          at_unknown: atUnknown,
          method: 'backup_code',
          result: 'BACKUP_OPEN',
          open_door: true,
          booking_ref: null,
          user_id: null,
          hint: null,
          offline: Boolean(ev.offline),
          event_id: eventId
        }
      });
    }

    ackEventIds.push(eventId);
  }

  const [kioskSetting, globalSetting, days] = await Promise.all([
    ensureKioskSetting(db),
    db.globalSetting.findUnique({
      where: { id: 1 },
      select: { official_line_url: true, line_button_url: true }
    }),
    buildSevenDaysSchedule(db, now)
  ]);

  const effectiveLineUrl =
    (kioskSetting.line_url && kioskSetting.line_url.trim()) ||
    globalSetting?.official_line_url ||
    globalSetting?.line_button_url ||
    '';

  return {
    sync_interval_s: 180,
    tz_offset_min: 480,
    config_rev: kioskSetting.config_rev ?? 1,
    days,
    rules: {
      early_minutes: kioskSetting.early_minutes ?? 30,
      after_close_minutes: kioskSetting.after_close_minutes ?? 60,
      result_seconds: 8,
      result_map_seconds: 15,
      pad_max_fail: 5,
      pad_lock_seconds: 300
    },
    contact: {
      line_url: effectiveLineUrl,
      line_id: kioskSetting.line_id || ''
    },
    backup_code: kioskSetting.backup_code
      ? { rev: kioskSetting.backup_code_rev ?? 0, code: kioskSetting.backup_code }
      : null,
    setup_pin: kioskSetting.setup_pin
      ? { rev: kioskSetting.setup_pin_rev ?? 0, pin: kioskSetting.setup_pin }
      : null,
    slides: { rev: 0, items: [] },
    floor_map: null,
    firmware: null,
    ack_event_ids: ackEventIds
  };
}
