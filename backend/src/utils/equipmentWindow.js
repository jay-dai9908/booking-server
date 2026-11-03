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
