/**
 * 從帳單明細 person.entry 解析結帳時數調整器的顯示資料（純函式）。
 * 不在前端重算入場費，一律以伺服器／computeBill 產生的 p.entry.hours 為主。
 */
export function getPersonHoursData(p = {}, { booking = {}, draftPersons = [] } = {}) {
  let bookedMins = p?.entry?.booked_minutes ?? booking?.booked_minutes;
  if (!bookedMins && booking?.start_time && booking?.end_time) {
    const [sh, sm] = booking.start_time.split(':').map(Number);
    const [eh, em] = booking.end_time.split(':').map(Number);
    bookedMins = (eh * 60 + em) - (sh * 60 + sm);
    if (bookedMins <= 0) bookedMins += 24 * 60;
  }
  const bookedHours = Math.max(1, Math.round((bookedMins || 60) / 60));

  const billHours = Number(p?.entry?.hours);
  const autoHours = (Number.isFinite(billHours) && billHours > 0) ? billHours : bookedHours;
  const defaultIntHours = Math.max(1, Math.floor(autoHours));
  const defaultOvertimeChip = Math.max(0, Math.round((autoHours - defaultIntHours) * 10) / 10);

  const pDraft = (draftPersons || []).find(dp => dp.person_no === p.person_no);
  const hasOverride = Boolean(pDraft && pDraft.hours_override != null);

  let intHours = defaultIntHours;
  let overtimeChip = defaultOvertimeChip;
  if (hasOverride) {
    intHours = pDraft.int_hours != null ? pDraft.int_hours : Math.floor(pDraft.hours_override);
    overtimeChip = pDraft.overtime_chip != null
      ? pDraft.overtime_chip
      : Math.round((pDraft.hours_override - intHours) * 10) / 10;
  }

  const totalHours = hasOverride ? pDraft.hours_override : (intHours + overtimeChip);
  return {
    bookedHours,
    defaultIntHours,
    defaultOvertimeChip,
    intHours,
    overtimeChip,
    hasOverride,
    totalHours,
    actualMinutes: p?.entry?.actual_minutes ?? null,
    pausedMinutes: p?.entry?.paused_minutes ?? 0
  };
}
