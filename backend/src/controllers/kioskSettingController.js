import prisma from '../prismaClient.js';
import { ensureKioskSetting } from './dailySettingController.js';

export const getKioskSettings = async (req, res) => {
  try {
    const setting = await ensureKioskSetting(prisma);
    res.json(setting);
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
    max_unpaid_self_bookings
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

  try {
    const setting = await prisma.kioskSetting.upsert({
      where: { id: 1 },
      update: dataToUpdate,
      create: {
        id: 1,
        early_minutes: dataToUpdate.early_minutes ?? 30,
        after_close_minutes: dataToUpdate.after_close_minutes ?? 60,
        prepay_deadline_hour: dataToUpdate.prepay_deadline_hour ?? 12,
        max_unpaid_self_bookings: dataToUpdate.max_unpaid_self_bookings ?? 2
      }
    });
    res.json({ message: '半自助與進場共用設定已儲存', setting });
  } catch (error) {
    console.error('Error updating kiosk settings:', error);
    res.status(500).json({ error: '儲存半自助與進場共用設定失敗' });
  }
};
