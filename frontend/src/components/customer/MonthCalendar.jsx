import React, { useMemo } from 'react';
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
  selectedDate = '',
  onSelectDate,
  className = '',
}) {
  const parsedCurrent = currentMonth ? currentMonth.split('-').map(Number) : null;
  const year = yearProp ?? (parsedCurrent ? parsedCurrent[0] : new Date().getFullYear());
  const month = monthProp ?? (parsedCurrent ? parsedCurrent[1] : new Date().getMonth() + 1);

  const dayStateMap = useMemo(() => {
    if (dayStateMapProp) return dayStateMapProp;
    if (!sessionsByDate) return {};
    const map = {};
    for (const [k, v] of Object.entries(sessionsByDate)) {
      map[k] = dayState(v);
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
    <div
      className={`grid grid-cols-7 gap-x-[2px] gap-y-1 rounded-[14px] border border-sg-line bg-sg-paper px-2 py-[10px] text-center select-none ${className}`}
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
        const state = dayStateMap[dateStr] || 'closed';
        const isSelected = dateStr === selectedDate;
        const isPastOrClosed = state === 'past' || state === 'closed';

        let numColor = 'text-sg-ink';
        let barClass = STATE_BARS[state] || '';
        let btnBg = 'bg-transparent hover:bg-sg-brown-soft/30';

        if (isSelected) {
          btnBg = 'bg-sg-brown';
          numColor = 'text-white';
          barClass = 'bg-white';
        } else if (isPastOrClosed || state === 'full') {
          numColor = 'text-sg-full';
        }

        const isDisabled = isPastOrClosed;

        return (
          <button
            key={dateStr}
            type="button"
            disabled={isDisabled}
            aria-disabled={isDisabled ? 'true' : undefined}
            aria-pressed={isSelected}
            onClick={() => {
              if (!isDisabled) {
                onSelectDate(dateStr);
              }
            }}
            className={`grid justify-items-center content-center gap-[2px] min-h-[44px] rounded-[8px] transition-colors ${btnBg} ${
              isDisabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer active:scale-[0.96]'
            }`}
          >
            <span className={`font-num font-bold text-[13px] leading-[1.2] ${numColor}`}>
              {d}
            </span>
            <span
              className={`w-[12px] h-[3px] rounded-[2px] ${barClass ? barClass : 'bg-transparent'}`}
              aria-hidden="true"
            />
          </button>
        );
      })}
    </div>
  );
}
