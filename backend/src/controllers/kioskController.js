import prisma from '../prismaClient.js';
import auditService from '../services/audit/auditService.js';
import { getAdminDeviceInfo } from '../utils/deviceParser.js';
import { toTaipeiDateString } from '../../../shared/time.js';
import { sanitizeKioskSetting } from './kioskSettingController.js';
import { ensureKioskSetting as ensureKioskSettingRow } from '../services/selfService/prepayService.js';
import { processKioskSync, buildSevenDaysSchedule } from '../services/kiosk/syncService.js';
import { processKioskAccess } from '../services/kiosk/accessService.js';

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
