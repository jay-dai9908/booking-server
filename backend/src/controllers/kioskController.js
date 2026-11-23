import crypto from 'crypto';
import prisma from '../prismaClient.js';
import auditService from '../services/audit/auditService.js';
import { getAdminDeviceInfo } from '../utils/deviceParser.js';
import { toTaipeiDateString } from '../../../shared/time.js';
import { sanitizeKioskSetting } from './kioskSettingController.js';
import { ensureKioskSetting as ensureKioskSettingRow } from '../services/selfService/prepayService.js';
import { processKioskSync, buildSevenDaysSchedule } from '../services/kiosk/syncService.js';
import { processKioskAccess } from '../services/kiosk/accessService.js';
import { getActiveLayoutForDate } from '../services/seating/layoutService.js';
import { buildFloorMap } from '../../../shared/floorMap.js';
import { sendKioskAlertMessage } from '../services/kiosk/alertService.js';
import { activeUserWhere } from '../utils/userQuery.js';

const ONLINE_THRESHOLD_MS = 10 * 60 * 1000;

export const postKioskSyncHandler = async (req, res) => {
  try {
    const syncBody = await processKioskSync(prisma, {
      device: req.kiosk.device,
      body: req.kiosk.body || {},
      clientIp: req.kiosk.clientIp,
      now: new Date()
    });
    return res.kioskReply({
      ok: true,
      code: 'OK',
      body: syncBody
    });
  } catch (err) {
    console.error('[kioskController] sync error:', err);
    return res.kioskReply({ ok: false, code: 'SERVER_ERROR', body: {} });
  }
};

export const postKioskAccessHandler = async (req, res) => {
  try {
    const { method, payload } = req.kiosk.body || {};
    const accessBody = await processKioskAccess(prisma, {
      device: req.kiosk.device,
      method,
      payload,
      now: new Date()
    });
    return res.kioskReply({
      ok: true,
      code: 'OK',
      body: accessBody
    });
  } catch (err) {
    console.error('[kioskController] access error:', err);
    return res.kioskReply({ ok: false, code: 'SERVER_ERROR', body: {} });
  }
};

export const getKioskAdminOverviewHandler = async (req, res) => {
  try {
    const now = new Date();
    const [devices, kioskSetting, globalSetting, days] = await Promise.all([
      prisma.kioskDevice.findMany({
        orderBy: [{ is_active: 'desc' }, { id: 'asc' }],
        select: {
          id: true,
          name: true,
          is_active: true,
          paired_at: true,
          last_seen_at: true,
          last_ip: true,
          fw_version: true,
          status_json: true,
          have_json: true,
          created_at: true
        }
      }),
      ensureKioskSettingRow(prisma),
      prisma.globalSetting.findUnique({
        where: { id: 1 },
        select: { official_line_url: true, line_button_url: true }
      }),
      buildSevenDaysSchedule(prisma, now)
    ]);

    const mappedDevices = devices.map((d) => {
      const online = Boolean(
        d.is_active &&
          d.last_seen_at &&
          now.getTime() - new Date(d.last_seen_at).getTime() <= ONLINE_THRESHOLD_MS
      );
      const st = d.status_json && typeof d.status_json === 'object' ? d.status_json : {};
      return {
        id: d.id,
        name: d.name,
        is_active: d.is_active,
        online,
        paired_at: d.paired_at,
        last_seen_at: d.last_seen_at,
        last_ip: d.last_ip,
        fw_version: d.fw_version,
        rssi: st.rssi ?? null,
        uptime_s: st.uptime_s ?? null,
        scanner_ok: typeof st.scanner_ok === 'boolean' ? st.scanner_ok : null,
        reset_reason: st.reset_reason ?? null,
        have: d.have_json || null
      };
    });

    const isSet = Boolean(kioskSetting.backup_code);
    const rev = kioskSetting.backup_code_rev ?? 0;
    const setAt = kioskSetting.backup_code_set_at || null;

    let usedCountSinceSet = 0;
    let lastUsedAt = null;
    if (isSet && setAt) {
      const logs = await prisma.kioskAccessLog.findMany({
        where: {
          method: 'backup_code',
          at: { gte: setAt }
        },
        orderBy: { at: 'desc' },
        select: { at: true }
      });
      usedCountSinceSet = logs.length;
      lastUsedAt = logs[0]?.at || null;
    }

    const activeDevices = mappedDevices.filter((d) => d.is_active);
    const primarySyncedDev = activeDevices.find(
      (d) => Number(d.have?.backup_code_rev) === rev && rev > 0
    );

    const todayMode = days[0] || {
      date: toTaipeiDateString(now),
      mode: 'closed',
      open: null,
      close: null,
      iron_text: ''
    };

    res.json({
      devices: mappedDevices,
      today_mode: todayMode,
      has_self_service_in_7_days: days.some((d) => d.mode === 'self'),
      backup_code_status: {
        is_set: isSet,
        rev,
        set_at: setAt,
        used_count_since_set: usedCountSinceSet,
        last_used_at: lastUsedAt,
        synced: Boolean(isSet && primarySyncedDev),
        synced_at: primarySyncedDev?.last_seen_at || null
      },
      setup_pin_status: {
        is_set: Boolean(kioskSetting.setup_pin),
        rev: kioskSetting.setup_pin_rev ?? 0
      },
      settings: sanitizeKioskSetting(kioskSetting, globalSetting)
    });
  } catch (err) {
    console.error('[kioskController] overview error:', err);
    res.status(500).json({ error: '無法取得報到機總覽資訊' });
  }
};

export const updateKioskBackupCodeHandler = async (req, res) => {
  const code = String(req.body?.code ?? '').trim();

  if (!/^\d{10}$/.test(code)) {
    return res.status(422).json({ error: '備用開門密碼必須為 10 碼純數字' });
  }
  if (code.startsWith('09')) {
    return res.status(422).json({ error: '備用開門密碼不可為 09 開頭，以免與手機號碼混淆' });
  }

  try {
    const current = await ensureKioskSettingRow(prisma);
    if (current.backup_code === code) {
      return res.status(422).json({ error: '新備用開門密碼不可與目前密碼相同' });
    }

    const now = new Date();
    const updated = await prisma.kioskSetting.update({
      where: { id: 1 },
      data: {
        backup_code: code,
        backup_code_rev: { increment: 1 },
        backup_code_set_at: now,
        config_rev: { increment: 1 }
      }
    });

    const deviceInfo = getAdminDeviceInfo(req);
    await auditService.log(prisma, {
      event_type: 'kiosk_backup_code_changed',
      category: 'setting',
      summary: `更換報到機備用開門密碼（第 ${updated.backup_code_rev} 版）`,
      staff_name: req.user?.name || '管理員',
      staff_id: req.user?.id || null,
      device_id: deviceInfo?.device_id || null,
      device_label: deviceInfo?.device_label || '後台'
    });

    res.json({
      message: '備用開門密碼已儲存，報到機將於下次同步時更新',
      backup_code_rev: updated.backup_code_rev,
      backup_code_set_at: updated.backup_code_set_at
    });
  } catch (err) {
    console.error('[kioskController] updateBackupCode error:', err);
    res.status(500).json({ error: '更新備用開門密碼失敗' });
  }
};

export const getKioskBackupCodeHandler = async (req, res) => {
  try {
    const setting = await ensureKioskSettingRow(prisma);
    const deviceInfo = getAdminDeviceInfo(req);
    await auditService.log(prisma, {
      event_type: 'kiosk_backup_code_viewed',
      category: 'setting',
      summary: '查看備用開門密碼',
      staff_name: req.user?.name || '管理員',
      staff_id: req.user?.id || null,
      device_id: deviceInfo?.device_id || null,
      device_label: deviceInfo?.device_label || '後台'
    });

    res.json({
      is_set: Boolean(setting.backup_code),
      code: setting.backup_code || null,
      rev: setting.backup_code_rev ?? 0,
      set_at: setting.backup_code_set_at || null
    });
  } catch (err) {
    console.error('[kioskController] getBackupCode error:', err);
    res.status(500).json({ error: '讀取備用開門密碼失敗' });
  }
};

export const updateKioskSetupPinHandler = async (req, res) => {
  const pin = String(req.body?.pin ?? '').trim();
  if (!/^\d{6}$/.test(pin)) {
    return res.status(422).json({ error: '設定模式密碼必須為 6 碼數字' });
  }

  try {
    await ensureKioskSettingRow(prisma);
    const updated = await prisma.kioskSetting.update({
      where: { id: 1 },
      data: {
        setup_pin: pin,
        setup_pin_rev: { increment: 1 },
        config_rev: { increment: 1 }
      }
    });

    const deviceInfo = getAdminDeviceInfo(req);
    await auditService.log(prisma, {
      event_type: 'kiosk_setup_pin_changed',
      category: 'setting',
      summary: `更換報到機設定模式密碼（第 ${updated.setup_pin_rev} 版）`,
      staff_name: req.user?.name || '管理員',
      staff_id: req.user?.id || null,
      device_id: deviceInfo?.device_id || null,
      device_label: deviceInfo?.device_label || '後台'
    });

    res.json({
      message: '設定模式密碼已儲存',
      setup_pin_rev: updated.setup_pin_rev
    });
  } catch (err) {
    console.error('[kioskController] updateSetupPin error:', err);
    res.status(500).json({ error: '更新設定模式密碼失敗' });
  }
};

export const getKioskAccessLogsHandler = async (req, res) => {
  const rawDate = req.query.date ? String(req.query.date).trim() : toTaipeiDateString(new Date());
  if (!/^\d{4}-\d{2}-\d{2}$/.test(rawDate)) {
    return res.status(400).json({ error: '日期格式必須為 YYYY-MM-DD' });
  }

  try {
    const startAt = new Date(`${rawDate}T00:00:00.000+08:00`);
    const endAt = new Date(startAt.getTime() + 24 * 60 * 60 * 1000);

    const logs = await prisma.kioskAccessLog.findMany({
      where: {
        at: { gte: startAt, lt: endAt }
      },
      orderBy: [{ at: 'desc' }, { id: 'desc' }]
    });

    const userIds = [...new Set(logs.map((l) => l.user_id).filter(Boolean))];
    const users = userIds.length
      ? await prisma.user.findMany({
          where: { id: { in: userIds } },
          select: { id: true, name: true }
        })
      : [];
    const userMap = new Map(users.map((u) => [u.id, u.name]));

    res.json({
      date: rawDate,
      logs: logs.map((l) => ({
        id: l.id,
        device_id: l.device_id,
        at: l.at,
        at_unknown: Boolean(l.at_unknown),
        method: l.method,
        result: l.result,
        open_door: l.open_door,
        booking_ref: l.booking_ref,
        user_id: l.user_id,
        user_name: l.user_id ? userMap.get(l.user_id) || '會員' : null,
        hint: l.hint,
        offline: l.offline
      }))
    });
  } catch (err) {
    console.error('[kioskController] getAccessLogs error:', err);
    res.status(500).json({ error: '取得報到機進出紀錄失敗' });
  }
};

export const getFloorMapFileHandler = async (req, res) => {
  try {
    const { version } = req.params;
    const now = new Date();
    const globalSetting = await prisma.globalSetting.findUnique({
      where: { id: 1 },
      select: { seat_layout_enabled: true }
    });
    if (!globalSetting?.seat_layout_enabled) {
      return res.status(404).json({ error: 'FLOOR_MAP_NOT_ENABLED' });
    }
    const activeLayout = await getActiveLayoutForDate(prisma, now);
    if (!activeLayout || !activeLayout.id || activeLayout.status !== 'published') {
      return res.status(404).json({ error: 'FLOOR_MAP_NOT_FOUND' });
    }
    const floorMap = buildFloorMap(activeLayout);
    if (floorMap.version !== version) {
      return res.status(404).json({ error: 'FLOOR_MAP_VERSION_MISMATCH' });
    }
    const jsonBuf = Buffer.from(JSON.stringify(floorMap), 'utf8');
    if (jsonBuf.length > 16384) {
      console.warn(`[kiosk] Floor map size ${jsonBuf.length} bytes exceeds 16KB limit (version: ${version})`);
    }
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Length', jsonBuf.length);
    return res.end(jsonBuf);
  } catch (err) {
    console.error('[kioskController] getFloorMapFileHandler error:', err);
    return res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
};

/**
 * 待機輪播圖（RGB565，協定 Section 8）
 */
export const listSlidesHandler = async (req, res) => {
  try {
    const slides = await prisma.kioskSlide.findMany({
      orderBy: [{ sort_order: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        title: true,
        sort_order: true,
        duration_sec: true,
        seconds: true,
        preview: true,
        enabled: true,
        sha256: true,
        created_at: true
      }
    });

    res.json({
      ok: true,
      slides: slides.map((s) => ({
        ...s,
        seconds: s.seconds ?? s.duration_sec ?? 8,
        duration_sec: s.seconds ?? s.duration_sec ?? 8,
        size: 768000
      }))
    });
  } catch (err) {
    console.error('[kioskController] listSlidesHandler error:', err);
    res.status(500).json({ error: '取得輪播圖列表失敗' });
  }
};

export const createSlideHandler = async (req, res) => {
  try {
    let rawBuffer = null;
    let title = '待機圖片';
    let durationSec = 8;
    let enabled = true;
    let preview = null;

    if (Buffer.isBuffer(req.body)) {
      rawBuffer = req.body;
      if (req.query.title) title = String(req.query.title).trim();
      if (req.query.duration_sec || req.query.seconds) {
        durationSec = parseInt(req.query.seconds || req.query.duration_sec, 10) || 8;
      }
      if (req.query.enabled !== undefined) enabled = req.query.enabled === 'true';
      if (req.query.preview) preview = String(req.query.preview);
    } else if (req.body && typeof req.body === 'object') {
      const { title: t, duration_sec: d, seconds: sec, enabled: e, raw_base64: b64, preview: prev } = req.body;
      if (t) title = String(t).trim();
      if (sec !== undefined || d !== undefined) durationSec = parseInt(sec !== undefined ? sec : d, 10) || 8;
      if (e !== undefined) enabled = Boolean(e);
      if (b64) rawBuffer = Buffer.from(b64, 'base64');
      if (prev) preview = String(prev);
    }

    if (!rawBuffer || rawBuffer.length !== 768000) {
      return res.status(422).json({
        error: 'SLIDE_INVALID_SIZE',
        message: `待機輪播圖大小必須恰好 768,000 bytes (800x480 RGB565)，目前為 ${rawBuffer ? rawBuffer.length : 0} bytes`
      });
    }

    if (enabled) {
      const enabledCount = await prisma.kioskSlide.count({ where: { enabled: true } });
      if (enabledCount >= 5) {
        return res.status(422).json({
          error: 'MAX_SLIDES_EXCEEDED',
          message: '最多只能有 5 張啟用中的待機輪播圖'
        });
      }
    }

    const sha256 = crypto.createHash('sha256').update(rawBuffer).digest('hex');
    const maxOrder = await prisma.kioskSlide.aggregate({ _max: { sort_order: true } });
    const sortOrder = (maxOrder._max.sort_order ?? -1) + 1;
    const finalSeconds = Math.max(3, Math.min(60, durationSec));

    const slide = await prisma.kioskSlide.create({
      data: {
        title,
        sort_order: sortOrder,
        duration_sec: finalSeconds,
        seconds: finalSeconds,
        preview: preview || null,
        enabled,
        sha256,
        bytes: rawBuffer
      }
    });

    await prisma.kioskSetting.upsert({
      where: { id: 1 },
      update: { slides_rev: { increment: 1 } },
      create: { id: 1, slides_rev: 1 }
    });

    res.status(201).json({
      ok: true,
      slide: {
        id: slide.id,
        title: slide.title,
        sort_order: slide.sort_order,
        duration_sec: slide.duration_sec,
        seconds: slide.seconds,
        preview: slide.preview,
        enabled: slide.enabled,
        sha256: slide.sha256,
        size: 768000,
        created_at: slide.created_at
      }
    });
  } catch (err) {
    console.error('[kioskController] createSlideHandler error:', err);
    res.status(500).json({ error: '新增輪播圖失敗' });
  }
};

export const updateSlideHandler = async (req, res) => {
  try {
    const slideId = parseInt(req.params.id, 10);
    const existing = await prisma.kioskSlide.findUnique({ where: { id: slideId } });
    if (!existing) {
      return res.status(404).json({ error: 'SLIDE_NOT_FOUND' });
    }

    const { title, sort_order, duration_sec, seconds, enabled, preview } = req.body;
    let revNeedsIncrement = false;
    const dataToUpdate = {};

    if (title !== undefined) {
      dataToUpdate.title = String(title).trim();
    }
    const secVal = seconds !== undefined ? seconds : duration_sec;
    if (secVal !== undefined) {
      const d = Math.max(3, Math.min(60, parseInt(secVal, 10) || 8));
      if (d !== existing.duration_sec || d !== existing.seconds) revNeedsIncrement = true;
      dataToUpdate.duration_sec = d;
      dataToUpdate.seconds = d;
    }
    if (preview !== undefined) {
      dataToUpdate.preview = preview ? String(preview) : null;
    }
    if (sort_order !== undefined) {
      const s = parseInt(sort_order, 10) || 0;
      if (s !== existing.sort_order) revNeedsIncrement = true;
      dataToUpdate.sort_order = s;
    }
    if (enabled !== undefined) {
      const e = Boolean(enabled);
      if (e && !existing.enabled) {
        const enabledCount = await prisma.kioskSlide.count({ where: { enabled: true } });
        if (enabledCount >= 5) {
          return res.status(422).json({
            error: 'MAX_SLIDES_EXCEEDED',
            message: '最多只能有 5 張啟用中的待機輪播圖'
          });
        }
      }
      if (e !== existing.enabled) revNeedsIncrement = true;
      dataToUpdate.enabled = e;
    }

    const updated = await prisma.kioskSlide.update({
      where: { id: slideId },
      data: dataToUpdate
    });

    if (revNeedsIncrement) {
      await prisma.kioskSetting.upsert({
        where: { id: 1 },
        update: { slides_rev: { increment: 1 } },
        create: { id: 1, slides_rev: 1 }
      });
    }

    res.json({
      ok: true,
      slide: {
        id: updated.id,
        title: updated.title,
        sort_order: updated.sort_order,
        duration_sec: updated.duration_sec,
        seconds: updated.seconds ?? updated.duration_sec,
        preview: updated.preview,
        enabled: updated.enabled,
        sha256: updated.sha256,
        size: 768000,
        updated_at: updated.updated_at
      }
    });
  } catch (err) {
    console.error('[kioskController] updateSlideHandler error:', err);
    res.status(500).json({ error: '更新輪播圖失敗' });
  }
};

export const reorderSlidesHandler = async (req, res) => {
  try {
    const { orders } = req.body;
    if (!Array.isArray(orders)) {
      return res.status(400).json({ error: 'INVALID_ORDERS_ARRAY' });
    }

    await prisma.$transaction(
      orders.map((item) =>
        prisma.kioskSlide.update({
          where: { id: parseInt(item.id, 10) },
          data: { sort_order: parseInt(item.sort_order, 10) || 0 }
        })
      )
    );

    await prisma.kioskSetting.upsert({
      where: { id: 1 },
      update: { slides_rev: { increment: 1 } },
      create: { id: 1, slides_rev: 1 }
    });

    res.json({ ok: true });
  } catch (err) {
    console.error('[kioskController] reorderSlidesHandler error:', err);
    res.status(500).json({ error: '重新排序輪播圖失敗' });
  }
};

export const deleteSlideHandler = async (req, res) => {
  try {
    const slideId = parseInt(req.params.id, 10);
    await prisma.kioskSlide.delete({ where: { id: slideId } });

    await prisma.kioskSetting.upsert({
      where: { id: 1 },
      update: { slides_rev: { increment: 1 } },
      create: { id: 1, slides_rev: 1 }
    });

    res.json({ ok: true });
  } catch (err) {
    console.error('[kioskController] deleteSlideHandler error:', err);
    res.status(500).json({ error: '刪除輪播圖失敗' });
  }
};

export const downloadSlideHandler = async (req, res) => {
  try {
    const slideId = parseInt(req.params.id, 10);
    const slide = await prisma.kioskSlide.findUnique({
      where: { id: slideId }
    });

    if (!slide) {
      return res.status(404).json({ error: 'SLIDE_NOT_FOUND' });
    }

    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Length', slide.bytes.length);
    res.setHeader('Cache-Control', 'public, max-age=86400, immutable');
    res.setHeader('ETag', `"${slide.sha256}"`);
    return res.end(slide.bytes);
  } catch (err) {
    console.error('[kioskController] downloadSlideHandler error:', err);
    res.status(500).json({ error: '下載輪播圖失敗' });
  }
};

/**
 * 韌體 OTA 管理（協定 Section 7）
 */
export const listFirmwareHandler = async (req, res) => {
  try {
    const [firmwares, setting] = await Promise.all([
      prisma.kioskFirmware.findMany({
        orderBy: { created_at: 'desc' },
        select: {
          id: true,
          version: true,
          size: true,
          sha256: true,
          note: true,
          uploaded_by: true,
          uploaded_by_name: true,
          created_at: true
        }
      }),
      ensureKioskSettingRow(prisma)
    ]);

    res.json({
      ok: true,
      firmwares,
      target: {
        id: setting.fw_target_id,
        policy: setting.fw_policy || 'none',
        set_at: setting.fw_policy_set_at
      }
    });
  } catch (err) {
    console.error('[kioskController] listFirmwareHandler error:', err);
    res.status(500).json({ error: '取得韌體列表失敗' });
  }
};

export const uploadFirmwareHandler = async (req, res) => {
  try {
    let rawBuffer = null;
    let note = null;

    if (Buffer.isBuffer(req.body)) {
      rawBuffer = req.body;
      if (req.query.note) note = String(req.query.note).trim();
    } else if (req.body && typeof req.body === 'object') {
      const { note: n, raw_base64: b64 } = req.body;
      if (n) note = String(n).trim();
      if (b64) rawBuffer = Buffer.from(b64, 'base64');
    }

    // 檢查大小：64 bytes 至 4,194,304 bytes (4MB)
    if (!rawBuffer || rawBuffer.length <= 64 || rawBuffer.length > 4194304) {
      return res.status(422).json({
        error: 'INVALID_FIRMWARE_SIZE',
        message: '韌體大小不合格（必須介於 64 bytes 至 4,194,304 bytes 之間）'
      });
    }

    // 檢查 ESP32 image magic byte (0xE9)
    if (rawBuffer[0] !== 0xe9) {
      return res.status(422).json({
        error: 'INVALID_FIRMWARE_HEADER',
        message: '無效的 ESP32 韌體檔頭（第 1 個位元組必須為 0xE9）'
      });
    }

    // 位移 32 檢查：應用程式描述魔術字元 32 54 CD AB
    if (
      rawBuffer.length < 112 ||
      rawBuffer[32] !== 0x32 ||
      rawBuffer[33] !== 0x54 ||
      rawBuffer[34] !== 0xcd ||
      rawBuffer[35] !== 0xab
    ) {
      return res.status(422).json({
        error: 'INVALID_APP_DESC_MAGIC',
        message: '位移 32 之應用程式描述魔術字元必須為 32 54 CD AB'
      });
    }

    // 版本字串在 offset 0x30 (48) 處，最長 32 bytes
    const verBytes = rawBuffer.subarray(48, 80);
    let nullIdx = verBytes.indexOf(0);
    if (nullIdx === -1) nullIdx = verBytes.length;
    const version = verBytes.subarray(0, nullIdx).toString('ascii').trim();

    if (!version) {
      return res.status(422).json({
        error: 'INVALID_FIRMWARE_VERSION',
        message: '韌體檔頭 offset 0x30 處未找到有效 ASCII 版本字串'
      });
    }

    // 專案名稱在 offset 0x50 (80) 處，最長 32 bytes，固定 kiosk-firmware
    const projBytes = rawBuffer.subarray(80, 112);
    let projNullIdx = projBytes.indexOf(0);
    if (projNullIdx === -1) projNullIdx = projBytes.length;
    const projName = projBytes.subarray(0, projNullIdx).toString('ascii').trim();

    if (projName !== 'kiosk-firmware') {
      return res.status(422).json({
        error: 'INVALID_PROJECT_NAME',
        message: `位移 80 之專案名稱必須為 kiosk-firmware，目前為：${projName || '空'}`
      });
    }

    // 同一個版本已經上傳過回 409
    const existingVer = await prisma.kioskFirmware.findFirst({
      where: { version }
    });
    if (existingVer) {
      return res.status(409).json({
        error: 'FIRMWARE_VERSION_EXISTS',
        message: `版本 ${version} 已經上傳過`
      });
    }

    const sha256 = crypto.createHash('sha256').update(rawBuffer).digest('hex');
    const uploader = req.user?.name || '管理員';

    const fw = await prisma.kioskFirmware.create({
      data: {
        version,
        size: rawBuffer.length,
        sha256,
        bytes: rawBuffer,
        note: note || null,
        uploaded_by: uploader,
        uploaded_by_name: uploader
      }
    });

    // 只保留最新 3 份，以及目前指定要更新的那一份
    const kioskSetting = await ensureKioskSettingRow(prisma);
    const targetId = kioskSetting.fw_target_id;
    const allFirmwares = await prisma.kioskFirmware.findMany({
      orderBy: { created_at: 'desc' }
    });

    const keepIds = new Set(allFirmwares.slice(0, 3).map((f) => f.id));
    if (targetId) keepIds.add(targetId);

    const toDeleteIds = allFirmwares
      .filter((f) => !keepIds.has(f.id))
      .map((f) => f.id);

    if (toDeleteIds.length > 0) {
      await prisma.kioskFirmware.deleteMany({
        where: { id: { in: toDeleteIds } }
      });
    }

    res.status(201).json({
      ok: true,
      firmware: {
        id: fw.id,
        version: fw.version,
        size: fw.size,
        sha256: fw.sha256,
        note: fw.note,
        uploaded_by: fw.uploaded_by,
        uploaded_by_name: fw.uploaded_by_name,
        created_at: fw.created_at
      }
    });
  } catch (err) {
    console.error('[kioskController] uploadFirmwareHandler error:', err);
    res.status(500).json({ error: '上傳韌體失敗' });
  }
};

export const setFirmwareTargetHandler = async (req, res) => {
  try {
    const { target_id, firmware_id, policy = 'none' } = req.body;
    const rawTarget = firmware_id !== undefined ? firmware_id : target_id;
    const targetId = rawTarget === null || rawTarget === undefined ? null : parseInt(rawTarget, 10);

    // 規範政策：none, night, now；相容舊版：force -> now, idle_only -> night
    let validPolicy = 'none';
    if (policy === 'night' || policy === 'idle_only') validPolicy = 'night';
    else if (policy === 'now' || policy === 'force') validPolicy = 'now';
    else if (policy === 'none') validPolicy = 'none';

    if (targetId !== null) {
      const exists = await prisma.kioskFirmware.findUnique({ where: { id: targetId } });
      if (!exists) {
        return res.status(404).json({ error: 'FIRMWARE_NOT_FOUND', message: '指定的韌體版本不存在' });
      }
    }

    await prisma.kioskSetting.upsert({
      where: { id: 1 },
      update: {
        fw_target_id: targetId,
        fw_policy: validPolicy,
        fw_policy_set_at: new Date(),
        config_rev: { increment: 1 }
      },
      create: {
        id: 1,
        fw_target_id: targetId,
        fw_policy: validPolicy,
        fw_policy_set_at: new Date(),
        config_rev: 2
      }
    });

    res.json({
      ok: true,
      target_id: targetId,
      firmware_id: targetId,
      policy: validPolicy
    });
  } catch (err) {
    console.error('[kioskController] setFirmwareTargetHandler error:', err);
    res.status(500).json({ error: '設定韌體目標失敗' });
  }
};

export const deleteFirmwareHandler = async (req, res) => {
  try {
    const fwId = parseInt(req.params.id, 10);
    const kioskSetting = await ensureKioskSettingRow(prisma);

    if (kioskSetting.fw_target_id === fwId) {
      return res.status(400).json({
        error: 'CANNOT_DELETE_TARGET_FIRMWARE',
        message: '此韌體正被指定為目標版本，無法刪除'
      });
    }

    await prisma.kioskFirmware.delete({ where: { id: fwId } });
    res.json({ ok: true });
  } catch (err) {
    console.error('[kioskController] deleteFirmwareHandler error:', err);
    res.status(500).json({ error: '刪除韌體失敗' });
  }
};

export const downloadFirmwareHandler = async (req, res) => {
  try {
    const fwId = parseInt(req.params.id, 10);
    const kioskSetting = await ensureKioskSettingRow(prisma);

    if (
      kioskSetting.fw_target_id !== fwId ||
      !kioskSetting.fw_policy ||
      kioskSetting.fw_policy === 'none'
    ) {
      return res.status(404).json({ error: 'FIRMWARE_NOT_TARGET' });
    }

    const fw = await prisma.kioskFirmware.findUnique({ where: { id: fwId } });
    if (!fw) {
      return res.status(404).json({ error: 'FIRMWARE_NOT_FOUND' });
    }

    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Length', fw.bytes.length);
    res.setHeader('Cache-Control', 'public, max-age=86400, immutable');
    res.setHeader('ETag', `"${fw.sha256}"`);
    return res.end(fw.bytes);
  } catch (err) {
    console.error('[kioskController] downloadFirmwareHandler error:', err);
    res.status(500).json({ error: '下載韌體失敗' });
  }
};

/**
 * 報到機警報通知收件人設定（Item 5）
 */
export const getAlertRecipientsHandler = async (req, res) => {
  try {
    const setting = await ensureKioskSettingRow(prisma);
    const alertUserIds = Array.isArray(setting.alert_user_ids) ? setting.alert_user_ids : [];

    // 尋找已綁定真實 LINE 的會員/員工帳號供勾選
    const users = await prisma.user.findMany({
      where: activeUserWhere(),
      select: { id: true, name: true, phone: true, line_user_id: true }
    });

    const candidates = users
      .filter((u) => u.line_user_id && !u.line_user_id.startsWith('manual_'))
      .map((u) => ({
        id: u.id,
        name: u.name,
        phone: u.phone,
        has_line: true
      }));

    res.json({
      ok: true,
      alert_user_ids: alertUserIds,
      candidates
    });
  } catch (err) {
    console.error('[kioskController] getAlertRecipientsHandler error:', err);
    res.status(500).json({ error: '取得警報收件人列表失敗' });
  }
};

export const updateAlertRecipientsHandler = async (req, res) => {
  try {
    const { user_ids } = req.body;
    const userIds = Array.isArray(user_ids)
      ? user_ids.map(Number).filter((n) => Number.isInteger(n))
      : [];

    if (userIds.length > 3) {
      return res.status(422).json({
        error: 'MAX_ALERT_RECIPIENTS_EXCEEDED',
        message: '警報通知收件人最多只能設定 3 位'
      });
    }

    await prisma.kioskSetting.upsert({
      where: { id: 1 },
      update: { alert_user_ids: userIds },
      create: { id: 1, alert_user_ids: userIds }
    });

    res.json({ ok: true, alert_user_ids: userIds });
  } catch (err) {
    console.error('[kioskController] updateAlertRecipientsHandler error:', err);
    res.status(500).json({ error: '更新警報收件人失敗' });
  }
};

export const sendTestAlertHandler = async (req, res) => {
  try {
    const result = await sendKioskAlertMessage(
      prisma,
      '這是來自門口報到機系統的測試通知，LINE 警報推播設定正常。'
    );
    res.json({ ok: true, result });
  } catch (err) {
    console.error('[kioskController] sendTestAlertHandler error:', err);
    res.status(500).json({ error: '發送測試通知失敗' });
  }
};
