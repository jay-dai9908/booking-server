import { toTaipeiDateString } from '../../../../shared/time.js';
import { sessionStartAt } from './taipeiTime.js';

export function resolveReservationWindow(r) {
  const rawDate = r?.session_date || r?.session?.session_date || '';
  const dateStr = toTaipeiDateString(rawDate) || String(rawDate).slice(0, 10);
  const startTime = r?.start_time || r?.session?.start_time || '00:00';
  const endTime = r?.end_time || r?.session?.end_time || '23:59';

  const startDt = sessionStartAt(dateStr, startTime);
  let endDt;
  if (endTime === '24:00') {
    endDt = new Date(sessionStartAt(dateStr, '00:00').getTime() + 86400000);
  } else {
    endDt = sessionStartAt(dateStr, endTime);
    if (endTime <= startTime) {
      endDt = new Date(endDt.getTime() + 86400000);
    }
  }
  return { dateStr, startDt, endDt };
}

export function reservationStatusPill(r, now = new Date()) {
  if (!r || r.status === 'cancelled') {
    return { variant: 'full', text: '已取消' };
  }

  const { dateStr, startDt, endDt } = resolveReservationWindow(r);
  const nowMs = now.getTime();
  const hasStarted = nowMs >= startDt.getTime();
  const hasEnded = nowMs >= endDt.getTime();
  const isCheckedIn = r.attendance === 'checked_in' || r.attendance === 'completed';
  const isSelfService = Boolean(r.is_self_service || r.prepay);

  if (r.attendance === 'completed' || (isCheckedIn && hasEnded)) {
    return { variant: 'full', text: '已完成' };
  }
  if (isCheckedIn && !hasEnded) {
    return { variant: 'ok', text: '已報到' };
  }

  if (isSelfService) {
    if (r.attendance === 'no_show' || hasEnded) {
      return { variant: 'full', text: '已結束' };
    }
    if (hasStarted) {
      return { variant: 'ok', text: '進行中' };
    }
  } else {
    if (r.attendance === 'no_show') {
      return { variant: 'full', text: '預約未到' };
    }
    if (hasStarted) {
      return { variant: 'low', text: '已過開始時間' };
    }
  }

  const todayStr = toTaipeiDateString(now);
  const todayMid = new Date(`${todayStr}T00:00:00Z`).getTime();
  const resMid = new Date(`${dateStr}T00:00:00Z`).getTime();
  const diffDays = Math.round((resMid - todayMid) / 86400000);

  if (diffDays === 0) {
    return { variant: 'brand', text: '已預約 · 今天' };
  }
  if (diffDays === 1) {
    return { variant: 'brand', text: '已預約 · 明天' };
  }
  return { variant: 'brand', text: `已預約 · 還有 ${diffDays} 天` };
}
