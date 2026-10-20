/**
 * Universal Calendar Helper for 《拾光製所》
 * Supports Google Calendar (with &openExternalBrowser=1) and Apple/Outlook (.ics RFC 5545 with VALARM)
 * Strict Constraint: Customer-facing copy NEVER includes seat or split table terminology.
 */

export const safeExtractBookingTimes = (booking = {}) => {
  let firstStart = '10:00';
  let lastEnd = '12:00';

  const rawSessions = booking.sessions || booking.selectedSessions || [];

  if (Array.isArray(rawSessions) && rawSessions.length > 0) {
    const starts = [];
    const ends = [];

    rawSessions.forEach(s => {
      if (typeof s === 'object' && s !== null) {
        if (s.start_time) starts.push(s.start_time);
        if (s.end_time) ends.push(s.end_time);
        if (s.time) {
          const parts = s.time.split(/[-~]/).map(p => p.trim());
          if (parts[0]) starts.push(parts[0]);
          if (parts[1]) ends.push(parts[1]);
        }
      } else if (typeof s === 'string') {
        const parts = s.split(/[-~]/).map(p => p.trim());
        if (parts[0]) starts.push(parts[0]);
        if (parts[1]) ends.push(parts[1]);
      }
    });

    if (starts.length > 0) {
      starts.sort();
      firstStart = starts[0];
    }
    if (ends.length > 0) {
      ends.sort();
      lastEnd = ends[ends.length - 1];
    }
  } else if (booking.timeRange && typeof booking.timeRange === 'string') {
    // Matches e.g. "10:00 - 11:00, 14:00 - 15:00" or "10:00 - 12:00"
    const times = booking.timeRange.match(/\b\d{1,2}:\d{2}\b/g);
    if (times && times.length >= 2) {
      firstStart = times[0];
      lastEnd = times[times.length - 1];
    } else if (times && times.length === 1) {
      firstStart = times[0];
      const [h, m] = times[0].split(':').map(Number);
      lastEnd = `${String(h + 1).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    }
  }

  // Normalize HH:mm to 2-digit hour
  const normTime = (t) => {
    if (!t) return '00:00';
    const [h, m] = t.split(':');
    return `${String(parseInt(h, 10)).padStart(2, '0')}:${String(parseInt(m || '0', 10)).padStart(2, '0')}`;
  };

  return {
    startTime: normTime(firstStart),
    endTime: normTime(lastEnd),
    displayTimeRange: `${normTime(firstStart)} - ${normTime(lastEnd)}`
  };
};

export const safeExtractDate = (booking = {}) => {
  const rawDate = booking.sessionDate || booking.session_date || booking.date;
  if (!rawDate) {
    const today = new Date();
    const y = today.getFullYear();
    const m = String(today.getMonth() + 1).padStart(2, '0');
    const d = String(today.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  if (rawDate instanceof Date) {
    const y = rawDate.getFullYear();
    const m = String(rawDate.getMonth() + 1).padStart(2, '0');
    const d = String(rawDate.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  if (typeof rawDate === 'string') {
    return rawDate.split('T')[0];
  }

  return String(rawDate);
};

export const getGoogleCalendarUrl = (booking = {}) => {
  const dateStr = safeExtractDate(booking).replace(/-/g, ''); // YYYYMMDD
  const { startTime, endTime } = safeExtractBookingTimes(booking);

  const startClean = startTime.replace(':', '') + '00';
  const endClean = endTime.replace(':', '') + '00';
  const dates = `${dateStr}T${startClean}/${dateStr}T${endClean}`;

  const title = `拾光製所 手作預約體驗`;
  const pax = booking.pax || 1;
  const bookingRef = booking.booking_ref || '';
  const location = `拾光製所`;

  const details = [
    `【拾光製所 手作預約確認】`,
    bookingRef ? `預約編號：${bookingRef}` : '',
    `體驗人數：${pax} 人`,
    `預約時段：${startTime} - ${endTime}`,
    `門市地點：${location}`,
    ``,
    `★ 注意事項：`,
    `• 費用皆含基礎傳統拼豆板與豆子無限使用。`,
    `• 預約現場名額保留 15 分鐘，請準時蒞臨。`,
    `• 離場前請預留約 10 分鐘，由店員協助壓平熨燙作品。`
  ].filter(Boolean).join('\n');

  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: title,
    dates: dates,
    details: details,
    location: location,
    ctz: 'Asia/Taipei',
    openExternalBrowser: '1'
  });

  return `https://calendar.google.com/calendar/render?${params.toString()}`;
};

export const generateIcsContent = (booking = {}) => {
  const dateStr = safeExtractDate(booking).replace(/-/g, '');
  const { startTime, endTime } = safeExtractBookingTimes(booking);

  const startClean = startTime.replace(':', '') + '00';
  const endClean = endTime.replace(':', '') + '00';
  const dtStart = `${dateStr}T${startClean}`;
  const dtEnd = `${dateStr}T${endClean}`;

  const now = new Date();
  const nowUtc = now.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
  const uid = `booking-${booking.booking_ref || Date.now()}@gathering-light.com`;

  const pax = booking.pax || 1;
  const bookingRef = booking.booking_ref || '';
  const summary = `拾光製所 手作預約體驗`;
  const location = `拾光製所`;

  const descLines = [
    `【拾光製所 手作預約確認】`,
    bookingRef ? `預約編號：${bookingRef}` : '',
    `體驗人數：${pax} 人`,
    `預約時段：${startTime} - ${endTime}`,
    `門市地點：${location}`,
    `注意事項：費用含傳統拼豆板與豆子無限使用，現場保留 15 分鐘，離場前請預留 10 分鐘熨燙。`
  ].filter(Boolean);
  const description = descLines.join('\\n');

  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Gathering Light//Handmade Booking System//ZH',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${nowUtc}`,
    `DTSTART;TZID=Asia/Taipei:${dtStart}`,
    `DTEND;TZID=Asia/Taipei:${dtEnd}`,
    `SUMMARY:${summary}`,
    `DESCRIPTION:${description}`,
    `LOCATION:${location}`,
    'STATUS:CONFIRMED',
    'BEGIN:VALARM',
    'TRIGGER:-PT60M',
    'ACTION:DISPLAY',
    'DESCRIPTION:拾光製所手作體驗提醒：預約將於 1 小時後開始！',
    'END:VALARM',
    'END:VEVENT',
    'END:VCALENDAR'
  ].join('\r\n');
};

export const downloadIcsFile = (booking = {}) => {
  const icsContent = generateIcsContent(booking);
  const blob = new Blob([icsContent], { type: 'text/calendar;charset=utf-8' });
  const filename = `拾光製所手作預約_${booking.booking_ref || safeExtractDate(booking)}.ics`;

  if (window.navigator && window.navigator.msSaveOrOpenBlob) {
    window.navigator.msSaveOrOpenBlob(blob, filename);
    return;
  }

  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, 200);
};
