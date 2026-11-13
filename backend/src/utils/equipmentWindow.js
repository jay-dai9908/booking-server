import { dateOnly } from '../../../shared/time.js';

// sortedSessions：這筆預約的時段，依 start_time 排序
// item：前端送來的一筆 { equipment_id, quantity, rental_hours, start_time? }
export function resolveEquipmentWindow(sortedSessions, item, minHours) {
  const totalHours = sortedSessions.length;
  // 時數規則與現有程式完全相同
  const rentalHours = totalHours < minHours
    ? totalHours
    : Math.max(minHours, Math.min(totalHours, parseInt(item.rental_hours, 10) || totalHours));

  let startIdx = 0;                                       // 沒帶 start_time → 從預約開始算（舊行為）
  if (item.start_time != null && item.start_time !== '') {
    startIdx = sortedSessions.findIndex((s) => s.start_time === String(item.start_time));
    if (startIdx === -1) {
      throw new Error('EQUIPMENT_WINDOW_INVALID:智能拼豆板的使用時間不在預約時段內，請重新選擇。');
    }
  }
  if (startIdx + rentalHours > totalHours) {
    throw new Error('EQUIPMENT_WINDOW_INVALID:智能拼豆板的使用時間超出預約時段，請重新選擇。');
  }
  const windowSessions = sortedSessions.slice(startIdx, startIdx + rentalHours);
  return {
    rentalHours,
    windowSessions,
    coveredSessions: windowSessions.map((s) => `${s.start_time}-${s.end_time}`),   // 與現有格式相同
  };
}

/**
 * 將 BookingEquipment.covered_sessions（可能是 ["14:00-15:00", ...] 或舊格式 session ID 字串）
 * 解析並排序成對應日期的 Session 資料列陣列（依 start_time 遞增）。
 */
export async function resolveCoveredSessions(tx, sessionDate, list) {
  if (!Array.isArray(list) || list.length === 0) return [];

  let candidateSessions = [];
  if (sessionDate) {
    const dObj = typeof sessionDate === 'string'
      ? dateOnly(sessionDate.slice(0, 10))
      : dateOnly(sessionDate);
    candidateSessions = await tx.session.findMany({
      where: { session_date: dObj },
      orderBy: { start_time: 'asc' }
    });
  }

  const numericIds = list
    .filter((item) => typeof item === 'number' || (typeof item === 'string' && /^\d+$/.test(item.trim())))
    .map((item) => Number(item))
    .filter((n) => Number.isFinite(n) && n > 0);

  const existingIds = new Set(candidateSessions.map((s) => s.id));
  const missingIds = numericIds.filter((id) => !existingIds.has(id));
  if (missingIds.length > 0) {
    const extraSessions = await tx.session.findMany({
      where: { id: { in: missingIds } },
      orderBy: { start_time: 'asc' }
    });
    candidateSessions = [...candidateSessions, ...extraSessions];
  }

  const matchedMap = new Map();
  for (const raw of list) {
    if (raw == null) continue;
    const str = String(raw).trim();
    if (!str) continue;

    let match = null;
    if (/^\d+$/.test(str)) {
      const idNum = Number(str);
      match = candidateSessions.find((s) => s.id === idNum);
    } else if (str.includes('-')) {
      const [st, et] = str.split('-').map((x) => x.trim());
      match = candidateSessions.find((s) => `${s.start_time}-${s.end_time}` === str || (s.start_time === st && (!et || s.end_time === et)))
        || candidateSessions.find((s) => s.start_time === st);
    } else if (str.includes(':')) {
      match = candidateSessions.find((s) => s.start_time === str);
    }

    if (match && !matchedMap.has(match.id)) {
      matchedMap.set(match.id, match);
    }
  }

  return Array.from(matchedMap.values()).sort((a, b) => a.start_time.localeCompare(b.start_time));
}

export function formatCoveredSessions(sessions) {
  return (sessions || []).map((s) => `${s.start_time}-${s.end_time}`);
}

