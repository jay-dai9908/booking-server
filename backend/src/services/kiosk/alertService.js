import prisma from '../../prismaClient.js';
import { dateOnly, toTaipeiDateString } from '../../../../shared/time.js';
import { sendLinePushMessage } from '../../utils/lineMessaging.js';
import { ensureKioskSetting } from '../selfService/prepayService.js';

/**
 * 格式化台北時間為 HH:mm
 */
export function formatTaipeiTime(date) {
  return new Intl.DateTimeFormat('zh-TW', {
    timeZone: 'Asia/Taipei',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).format(date);
}

/**
 * 發送推播訊息給所有指定的報到機警報收件人 (User.id)
 */
export async function sendKioskAlertMessage(db = prisma, textMessage) {
  try {
    const kioskSetting = await ensureKioskSetting(db);
    const alertUserIds = Array.isArray(kioskSetting.alert_user_ids)
      ? kioskSetting.alert_user_ids
      : [];

    if (alertUserIds.length === 0) {
      return { sent: 0, total: 0 };
    }

    const users = await db.user.findMany({
      where: { id: { in: alertUserIds } },
      select: { id: true, name: true, line_user_id: true }
    });

    let sent = 0;
    for (const u of users) {
      if (!u.line_user_id || u.line_user_id.startsWith('manual_')) {
        continue;
      }
      try {
        await sendLinePushMessage(u.line_user_id, {
          type: 'text',
          text: textMessage
        });
        sent++;
      } catch (err) {
        console.warn(`[kioskAlert] Failed to push to user #${u.id} (${u.name}):`, err.message);
      }
    }

    return { sent, total: users.length };
  } catch (err) {
    console.error('[kioskAlert] sendKioskAlertMessage error:', err);
    return { sent: 0, error: err.message };
  }
}

/**
 * 檢查目前台北時間是否在半自助日之營業時段內（最早開門前 30 分鐘 ~ 最晚打烊後 60 分鐘）
 */
export async function isWithinSelfServiceBusinessHours(db = prisma, now = new Date()) {
  const todayStr = toTaipeiDateString(now);
  const todayDateObj = dateOnly(todayStr);

  const [dailySetting, sessions] = await Promise.all([
    db.dailySetting.findUnique({
      where: { date: todayDateObj },
      select: { is_self_service: true }
    }),
    db.session.findMany({
      where: { session_date: todayDateObj },
      select: { start_time: true, end_time: true }
    })
  ]);

  if (!dailySetting || !dailySetting.is_self_service || sessions.length === 0) {
    return false;
  }

  // 計算現在台北時間自 00:00 起的分鐘數
  const taipeiTimeStr = formatTaipeiTime(now);
  const [currH, currM] = taipeiTimeStr.split(':').map(Number);
  const currMinutes = currH * 60 + currM;

  let minOpenMinutes = 24 * 60;
  let maxCloseMinutes = 0;

  for (const s of sessions) {
    if (s.start_time) {
      const [sh, sm] = s.start_time.split(':').map(Number);
      minOpenMinutes = Math.min(minOpenMinutes, sh * 60 + sm);
    }
    if (s.end_time) {
      const [eh, em] = s.end_time.split(':').map(Number);
      maxCloseMinutes = Math.max(maxCloseMinutes, eh * 60 + em);
    }
  }

  const kioskSetting = await ensureKioskSetting(db);
  const afterCloseMinutes = kioskSetting?.after_close_minutes ?? 60;
  const effectiveOpen = minOpenMinutes - 60;
  const effectiveClose = maxCloseMinutes + afterCloseMinutes;

  return currMinutes >= effectiveOpen && currMinutes <= effectiveClose;
}

/**
 * 報到機離線定期巡檢（cronJobs 呼叫）
 */
export async function checkKioskOfflineAlerts(db = prisma, now = new Date()) {
  const inHours = await isWithinSelfServiceBusinessHours(db, now);
  if (!inHours) {
    return { checked: false, reason: 'NOT_SELF_SERVICE_OR_OUTSIDE_HOURS' };
  }

  const device = await db.kioskDevice.findFirst({
    where: { is_active: true }
  });

  if (!device) {
    return { checked: true, offline: false, message: 'NO_ACTIVE_DEVICE' };
  }

  const lastSeenMs = device.last_seen_at ? new Date(device.last_seen_at).getTime() : 0;
  const diffMs = now.getTime() - lastSeenMs;
  const isOffline = diffMs > 10 * 60 * 1000;

  if (isOffline) {
    if (!device.offline_alerted_at) {
      const lastSeenStr = device.last_seen_at ? formatTaipeiTime(new Date(device.last_seen_at)) : '未知';
      const msg = `門口報到機離線超過 10 分鐘，顧客目前只能用備用開門密碼進門。最後一次連線：${lastSeenStr}`;
      await sendKioskAlertMessage(db, msg);
      await db.kioskDevice.update({
        where: { id: device.id },
        data: { offline_alerted_at: now }
      });
      return { checked: true, alerted: true, offline: true };
    }
    return { checked: true, alerted: false, offline: true, reason: 'ALERT_THROTTLED' };
  }

  // 機台在線上：若之前有發過離線警報，發送恢復通知並重置
  if (device.offline_alerted_at) {
    const recoveryMsg = '門口報到機已恢復連線';
    await sendKioskAlertMessage(db, recoveryMsg);
    await db.kioskDevice.update({
      where: { id: device.id },
      data: { offline_alerted_at: null }
    });
    return { checked: true, recovered: true, offline: false };
  }

  return { checked: true, offline: false };
}

/**
 * 備用密碼開門通知
 */
export async function notifyBackupCodeUsed(db = prisma, now = new Date(), atSec = null) {
  const eventDate = atSec ? new Date(atSec * 1000) : now;
  const timeStr = formatTaipeiTime(eventDate);
  const msg = `備用開門密碼在 ${timeStr} 被使用，請到後台換一組新的`;
  return sendKioskAlertMessage(db, msg);
}
