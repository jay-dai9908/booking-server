import prisma from '../prismaClient.js';
import { ensureKioskSetting } from './dailySettingController.js';

export function sanitizeKioskSetting(setting, globalSetting = null) {
  if (!setting) return null;
  const effectiveLineUrl =
    (setting.line_url && setting.line_url.trim()) ||
    globalSetting?.official_line_url ||
    globalSetting?.line_button_url ||
    '';

  return {
    id: setting.id,
    early_minutes: setting.early_minutes,
    after_close_minutes: setting.after_close_minutes,
    prepay_deadline_hour: setting.prepay_deadline_hour,
    max_unpaid_self_bookings: setting.max_unpaid_self_bookings,
    line_url: effectiveLineUrl,
    line_id: setting.line_id || '',
    config_rev: setting.config_rev ?? 1,
    has_backup_code: Boolean(setting.backup_code),
    backup_code_rev: setting.backup_code_rev ?? 0,
    backup_code_set_at: setting.backup_code_set_at || null,
    has_setup_pin: Boolean(setting.setup_pin),
    setup_pin_rev: setting.setup_pin_rev ?? 0,
    updated_at: setting.updated_at
  };
}

export const getKioskSettings = async (req, res) => {
  try {
    const [setting, globalSetting] = await Promise.all([
      ensureKioskSetting(prisma),
      prisma.globalSetting.findUnique({
        where: { id: 1 },
        select: { official_line_url: true, line_button_url: true }
      })
    ]);
    res.json(sanitizeKioskSetting(setting, globalSetting));
  } catch (error) {
    console.error('Error fetching kiosk settings:', error);
    res.status(500).json({ error: '無法讀取報到機與半自助共用設定' });
  }
};

export const updateKioskSettings = async (req, res) => {
  const {
    early_minutes,
    after_close_minutes,
    prepay_deadline_hour,
    max_unpaid_self_bookings,
    line_url,
    line_id
  } = req.body;

  const dataToUpdate = {};

  const parseIntStrict = (val, min, max, label) => {
    const num = Number(val);
    if (!Number.isInteger(num) || num < min || num > max) {
      return { error: `${label}必須為 ${min} 到 ${max} 的整數` };
    }
    return { value: num };
  };

  if (early_minutes !== undefined) {
    const r = parseIntStrict(early_minutes, 0, 120, '最早提前進場分鐘');
    if (r.error) return res.status(422).json({ error: r.error });
    dataToUpdate.early_minutes = r.value;
  }
  if (after_close_minutes !== undefined) {
    const r = parseIntStrict(after_close_minutes, 0, 240, '打烊後可進門分鐘');
    if (r.error) return res.status(422).json({ error: r.error });
    dataToUpdate.after_close_minutes = r.value;
  }
  if (prepay_deadline_hour !== undefined) {
    const r = parseIntStrict(prepay_deadline_hour, 0, 23, '付款期限小時');
    if (r.error) return res.status(422).json({ error: r.error });
    dataToUpdate.prepay_deadline_hour = r.value;
  }
  if (max_unpaid_self_bookings !== undefined) {
    const r = parseIntStrict(max_unpaid_self_bookings, 1, 10, '每位會員最多同時待付款筆數');
    if (r.error) return res.status(422).json({ error: r.error });
    dataToUpdate.max_unpaid_self_bookings = r.value;
  }
  if (line_url !== undefined) {
    const cleanUrl = String(line_url ?? '').trim();
    if (cleanUrl && !/^https?:\/\//i.test(cleanUrl)) {
      return res.status(422).json({ error: 'LINE 連結必須以 http:// 或 https:// 開頭' });
    }
    dataToUpdate.line_url = cleanUrl || null;
  }
  if (line_id !== undefined) {
    const cleanId = String(line_id ?? '').trim().slice(0, 64);
    dataToUpdate.line_id = cleanId || null;
  }

  try {
    const [setting, globalSetting] = await Promise.all([
      prisma.kioskSetting.upsert({
        where: { id: 1 },
        update: {
          ...dataToUpdate,
          config_rev: { increment: 1 }
        },
        create: {
          id: 1,
          early_minutes: dataToUpdate.early_minutes ?? 30,
          after_close_minutes: dataToUpdate.after_close_minutes ?? 60,
          prepay_deadline_hour: dataToUpdate.prepay_deadline_hour ?? 12,
          max_unpaid_self_bookings: dataToUpdate.max_unpaid_self_bookings ?? 2,
          line_url: dataToUpdate.line_url ?? null,
          line_id: dataToUpdate.line_id ?? null,
          config_rev: 1
        }
      }),
      prisma.globalSetting.findUnique({
        where: { id: 1 },
        select: { official_line_url: true, line_button_url: true }
      })
    ]);
    res.json({
      message: '半自助與進場共用設定已儲存',
      setting: sanitizeKioskSetting(setting, globalSetting)
    });
  } catch (error) {
    console.error('Error updating kiosk settings:', error);
    res.status(500).json({ error: '儲存半自助與進場共用設定失敗' });
  }
};
