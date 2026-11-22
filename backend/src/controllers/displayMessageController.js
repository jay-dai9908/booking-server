import crypto from 'crypto';
import prisma from '../prismaClient.js';
import auditService from '../services/audit/auditService.js';
import { getAdminDeviceInfo } from '../utils/deviceParser.js';
import { ensureDisplaySetting } from './displaySettingController.js';
import displayBus from '../services/display/displayBus.js';

const MAX_MESSAGE_LEN = 40;

export async function postDisplayMessage(req, res) {
  const rawText = req.body?.text;
  const cleanText = String(rawText ?? '')
    .replace(/[\r\n]+/g, ' ')
    .trim();

  if (!cleanText) {
    return res.status(422).json({ error: '訊息內容不可為空' });
  }
  if ([...cleanText].length > MAX_MESSAGE_LEN) {
    return res.status(422).json({ error: `訊息最多 ${MAX_MESSAGE_LEN} 字` });
  }

  try {
    const setting = await ensureDisplaySetting(prisma);
    const messageMinutes = Math.max(1, Math.min(30, Number(setting.message_minutes) || 3));
    const ttlMs = messageMinutes * 60 * 1000;
    const now = new Date();
    const expiresAt = new Date(now.getTime() + ttlMs);

    const payload = {
      active: true,
      id: crypto.randomUUID(),
      text: cleanText,
      message_minutes: messageMinutes,
      created_at: now.toISOString(),
      expires_at: expiresAt.toISOString()
    };

    displayBus.setStaffMessage({ payload, ttlMs });

    const deviceInfo = getAdminDeviceInfo(req);
    await auditService.log(prisma, {
      event_type: 'display_message_push',
      category: 'status',
      summary: `推播顯示屏通知：${cleanText}`,
      after_json: { text: cleanText, expires_at: payload.expires_at },
      staff_name: req.user?.name || '門市人員',
      staff_id: req.user?.id || null,
      device_id: deviceInfo.device_id,
      device_label: deviceInfo.device_label
    });

    return res.json({ ok: true, message: payload });
  } catch (err) {
    console.error('[displayMessage] postDisplayMessage error:', err.message);
    return res.status(500).json({ error: '推播顯示屏通知失敗' });
  }
}

export async function deleteDisplayMessage(req, res) {
  try {
    displayBus.clearStaffMessage();

    const deviceInfo = getAdminDeviceInfo(req);
    await auditService.log(prisma, {
      event_type: 'display_message_clear',
      category: 'status',
      summary: '收回顯示屏通知',
      staff_name: req.user?.name || '門市人員',
      staff_id: req.user?.id || null,
      device_id: deviceInfo.device_id,
      device_label: deviceInfo.device_label
    });

    return res.json({ ok: true });
  } catch (err) {
    console.error('[displayMessage] deleteDisplayMessage error:', err.message);
    return res.status(500).json({ error: '收回顯示屏通知失敗' });
  }
}
