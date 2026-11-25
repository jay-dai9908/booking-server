import React, { useMemo, useState } from 'react';
import { dayState } from '../../utils/customer/availability.js';

const STATE_BARS = {
  ok: 'bg-sg-sage',
  low: 'bg-sg-honey',
  full: 'bg-sg-full',
};

const WEEKDAY_HEADERS = ['日', '一', '二', '三', '四', '五', '六'];

export default function MonthCalendar({
  year: yearProp,
  month: monthProp, // 1-12
  currentMonth, // 'YYYY-MM'
  dayStateMap: dayStateMapProp,
  sessionsByDate,
  selfServiceDates = {},
  dayInfoByDate = {},
  selectedDate = '',
  onSelectDate,
  allowPast = false,
  allowClosed = false,
  className = '',
}) {
  const [inspectedClosed, setInspectedClosed] = useState(null);
  const parsedCurrent = currentMonth instanceof Date
    ? [currentMonth.getFullYear(), currentMonth.getMonth() + 1]
    : currentMonth ? String(currentMonth).split('-').map(Number) : null;
  const year = yearProp ?? (parsedCurrent ? parsedCurrent[0] : new Date().getFullYear());
  const month = monthProp ?? (parsedCurrent ? parsedCurrent[1] : new Date().getMonth() + 1);

  const dayStateMap = useMemo(() => {
    if (dayStateMapProp) return dayStateMapProp;
    if (!sessionsByDate) return {};
    const map = {};
    for (const [k, v] of Object.entries(sessionsByDate)) {
      map[k] = dayState(k, v);
    }
    return map;
  }, [dayStateMapProp, sessionsByDate]);

  const firstDayOfWeek = new Date(year, month - 1, 1).getDay(); // 0 is Sunday
  const daysInMonth = new Date(year, month, 0).getDate();

  const cells = [];
  // Empty leading cells
  for (let i = 0; i < firstDayOfWeek; i++) {
    cells.push(null);
  }
  for (let d = 1; d <= daysInMonth; d++) {
    cells.push(d);
  }

  return (
    <div className={className}>
      <div
        style={{ gridTemplateColumns: 'repeat(7, minmax(0, 1fr))' }}
        className="grid grid-cols-7 gap-x-[2px] gap-y-1 rounded-[14px] border border-sg-line bg-sg-paper px-2 py-[10px] text-center select-none min-w-0"
      >
        {WEEKDAY_HEADERS.map((h, i) => (
          <span key={i} className="text-[12px] text-sg-muted font-bold py-1">
            {h}
          </span>
        ))}

        {cells.map((d, index) => {
          if (!d) {
            return <div key={`empty-${index}`} className="min-h-[44px]" aria-hidden="true" />;
          }

          const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
          const info = dayInfoByDate?.[dateStr];
          const isManualClosed = info?.day_type === 'closed' && (info?.day_type_source === 'manual' || Boolean(info?.closed_note));
          const state = isManualClosed ? 'closed' : (dayStateMap[dateStr] || 'closed');
          const isSelfService = !isManualClosed && Boolean(selfServiceDates?.[dateStr]);
          const isSelected = dateStr === selectedDate;
          const isPast = state === 'past';
          const isDisabled = (!allowPast && isPast) || (!allowClosed && state === 'closed');
          const isMuted = isPast || state === 'closed' || state === 'full';

          let numColor = 'text-sg-ink';
          let barClass = STATE_BARS[state] || '';
          let btnBg = 'bg-transparent hover:bg-sg-brown-soft/30';

          if (isSelected) {
            btnBg = 'bg-sg-brown';
            numColor = 'text-white';
            barClass = 'bg-white';
          } else if (isDisabled || state === 'full') {
            numColor = 'text-sg-full';
          } else if (isMuted) {
            numColor = 'text-sg-muted';
          }

          return (
            <button
              key={dateStr}
              type="button"
              data-testid={`customer-calendar-day-${dateStr}`}
              disabled={isDisabled && !isManualClosed}
              aria-disabled={isDisabled ? 'true' : undefined}
              aria-pressed={isSelected}
              onClick={() => {
                if (isManualClosed && !allowClosed) {
                  setInspectedClosed({
                    date: dateStr,
                    note: info?.closed_note || '這天臨時公休'
                  });
                  return;
                }
                if (!isDisabled) {
                  setInspectedClosed(null);
                  onSelectDate(dateStr);
                }
              }}
              className={`grid justify-items-center content-center gap-[2px] min-h-[44px] min-w-0 rounded-[8px] transition-colors ${btnBg} ${
                isDisabled ? 'cursor-not-allowed opacity-55' : 'cursor-pointer active:scale-[0.96]'
              }`}
            >
              <span className={`font-num font-bold text-[13px] leading-[1.2] ${numColor}`}>
                {d}
              </span>
              <span
                className={`w-[12px] h-[3px] rounded-[2px] ${barClass ? barClass : 'bg-transparent'}`}
                aria-hidden="true"
              />
              {isManualClosed && (
                <span className="text-[8.5px] leading-none font-bold whitespace-nowrap px-0.5 rounded text-rose-700 bg-rose-100">
                  公休
                </span>
              )}
              {isSelfService && (
                <span
                  className={`text-[8.5px] leading-none font-bold whitespace-nowrap px-0.5 rounded ${
                    isSelected
                      ? 'text-white/95'
                      : 'text-sg-honey-ink bg-sg-honey-soft'
                  }`}
                >
                  半自助
                </span>
              )}
            </button>
          );
        })}
      </div>

      {inspectedClosed && (
        <div
          role="alert"
          data-testid="closed-date-notice"
          className="mt-2 flex items-center justify-between gap-2 rounded-[12px] border border-rose-200 bg-rose-50 px-3 py-2 text-[13px] text-rose-800"
        >
          <span>
            <strong className="font-bold">{inspectedClosed.date} 公休：</strong>
            {inspectedClosed.note}
          </span>
          <button
            type="button"
            onClick={() => setInspectedClosed(null)}
            className="text-xs font-bold text-rose-700 hover:underline shrink-0"
          >
            關閉
          </button>
        </div>
      )}
    </div>
  );
}
