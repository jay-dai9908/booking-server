import React, { useRef, useEffect, useMemo } from 'react';
import { weekdayChar } from '../../utils/customer/format.js';
import { dayState } from '../../utils/customer/availability.js';

const STATE_COLORS = {
  ok: 'bg-sg-sage',
  low: 'bg-sg-honey',
  full: 'bg-sg-full',
  closed: 'bg-transparent',
};

const STATE_NAMES = {
  ok: '空位充足',
  low: '快滿了',
  full: '已額滿',
  closed: '沒有開放',
};

const DateStrip = React.forwardRef(function DateStrip({
  dates: datesProp, // array of { dateStr: 'YYYY-MM-DD', state: 'ok'|'low'|'full'|'closed' }
  selectedDate = '',
  onSelectDate,
  onVisibleMonthChange,
  sessionsByDate,
  className = '',
}, ref) {
  const containerRef = useRef(null);
  React.useImperativeHandle(ref, () => containerRef.current);

  const dates = useMemo(() => {
    if (datesProp && datesProp.length > 0) return datesProp;
    if (!sessionsByDate) return [];
    const keys = Object.keys(sessionsByDate).sort();
    if (keys.length === 0) return [];
    const today = new Date();
    const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    const startStr = keys[0] < todayStr ? todayStr : keys[0];
    const lastStr = keys[keys.length - 1];

    const result = [];
    const [sy, sm, sd] = startStr.split('-').map(Number);
    const [ey, em, ed] = lastStr.split('-').map(Number);
    let cur = new Date(sy, sm - 1, sd);
    const end = new Date(ey, em - 1, ed);
    let count = 0;
    while (cur <= end && count < 90) {
      const y = cur.getFullYear();
      const m = String(cur.getMonth() + 1).padStart(2, '0');
      const d = String(cur.getDate()).padStart(2, '0');
      const dStr = `${y}-${m}-${d}`;
      const daySessions = sessionsByDate[dStr] || [];
      const state = dayState(dStr, daySessions);
      result.push({ dateStr: dStr, state });
      cur.setDate(cur.getDate() + 1);
      count++;
    }
    return result;
  }, [datesProp, sessionsByDate]);

  // Scroll selected date into view smoothly
  useEffect(() => {
    if (!containerRef.current || !selectedDate) return;
    const cleanDate = String(selectedDate).split('T')[0];
    const index = dates.findIndex((d) => d.dateStr === cleanDate);
    if (index !== -1) {
      // 50 = 44px item width + 6px gap
      const left = Math.max(0, index * 50 - 16);
      containerRef.current.scrollTo({ left, behavior: 'smooth' });
    }
  }, [selectedDate, dates]);

  const handleScroll = () => {
    if (!containerRef.current || !onVisibleMonthChange || dates.length === 0) return;
    const scrollLeft = containerRef.current.scrollLeft;
    const index = Math.min(dates.length - 1, Math.max(0, Math.round(scrollLeft / 50)));
    if (dates[index]) {
      onVisibleMonthChange(dates[index].dateStr);
    }
  };

  return (
    <div
      ref={containerRef}
      onScroll={handleScroll}
      className={`flex gap-[6px] overflow-x-auto overscroll-x-contain snap-x snap-mandatory -mr-4 pr-4 min-h-[58px] flex-none [scrollbar-width:none] [&::-webkit-scrollbar]:hidden [mask-image:linear-gradient(90deg,#000_82%,transparent)] [-webkit-mask-image:linear-gradient(90deg,#000_82%,transparent)] ${className}`}
    >
      {dates.map((item) => {
        const cleanItemDate = String(item.dateStr).split('T')[0];
        const cleanSelectedDate = String(selectedDate).split('T')[0];
        const isSelected = cleanItemDate === cleanSelectedDate;
        const [y, m, d] = cleanItemDate.split('-').map(Number);
        const dayNum = d;
        const wk = weekdayChar(cleanItemDate);
        const isClosed = item.state === 'closed';
        const isFull = item.state === 'full';

        let btnBg = 'bg-sg-paper border-sg-line';
        let wkColor = 'text-sg-muted';
        let dayColor = 'text-sg-ink';
        let barColor = STATE_COLORS[item.state] || 'bg-transparent';

        if (isSelected) {
          btnBg = 'bg-sg-brown border-sg-brown';
          wkColor = 'text-white/85';
          dayColor = 'text-white';
          barColor = 'bg-white';
        } else if (isClosed || isFull) {
          wkColor = 'text-sg-full';
          dayColor = 'text-sg-full';
        }

        const stateName = STATE_NAMES[item.state] || '';
        const ariaLabel = `${m} 月 ${d} 日 週${wk}，${stateName}`;

        return (
          <button
            key={item.dateStr}
            type="button"
            disabled={isClosed}
            aria-disabled={isClosed ? 'true' : undefined}
            aria-pressed={isSelected}
            aria-label={ariaLabel}
            onClick={() => !isClosed && onSelectDate(item.dateStr)}
            className={`flex-none w-[44px] min-h-[56px] snap-start rounded-[12px] border ${btnBg} grid content-center justify-items-center gap-[2px] pt-[6px] pb-[5px] select-none transition-colors duration-150 ${
              isClosed ? 'cursor-not-allowed opacity-60' : 'cursor-pointer active:scale-[0.97]'
            }`}
          >
            <span className={`text-[11px] leading-[1.2] ${wkColor}`}>
              {wk}
            </span>
            <span className={`font-num font-extrabold text-[16px] leading-[1.1] ${dayColor}`}>
              {dayNum}
            </span>
            <span
              className={`w-[22px] h-[4px] rounded-[2px] ${barColor}`}
              aria-hidden="true"
            />
          </button>
        );
      })}
    </div>
  );
});

export default DateStrip;
