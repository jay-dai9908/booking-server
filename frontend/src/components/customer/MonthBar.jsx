import React from 'react';
import { Calendar, ChevronLeft, ChevronRight } from 'lucide-react';
import { formatMonthTitle } from '../../utils/customer/format.js';

export default function MonthBar({
  monthTitle: monthTitleProp = '',
  calendarMonth = '',
  selectedDate = '',
  isExpanded = false,
  onToggleExpand,
  onPrevMonth,
  onNextMonth,
  onChangeCalendarMonth,
  canPrevMonth: canPrevMonthProp,
  canNextMonth: canNextMonthProp,
  className = '',
}) {
  const currentMonthStr = calendarMonth instanceof Date
    ? `${calendarMonth.getFullYear()}-${String(calendarMonth.getMonth() + 1).padStart(2, '0')}`
    : calendarMonth
    ? String(calendarMonth).substring(0, 7)
    : (selectedDate ? String(selectedDate).substring(0, 7) : '');
  const monthTitle = monthTitleProp || (currentMonthStr ? formatMonthTitle(currentMonthStr) : '');

  const handlePrev = () => {
    if (onPrevMonth) {
      onPrevMonth();
    } else if (onChangeCalendarMonth && currentMonthStr) {
      const [y, m] = currentMonthStr.split('-').map(Number);
      const d = new Date(y, m - 2, 1);
      const newMonth = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      onChangeCalendarMonth(newMonth);
    }
  };

  const handleNext = () => {
    if (onNextMonth) {
      onNextMonth();
    } else if (onChangeCalendarMonth && currentMonthStr) {
      const [y, m] = currentMonthStr.split('-').map(Number);
      const d = new Date(y, m, 1);
      const newMonth = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      onChangeCalendarMonth(newMonth);
    }
  };

  const canPrev = canPrevMonthProp ?? true;
  const canNext = canNextMonthProp ?? true;

  return (
    <div className={`flex items-center justify-between -mb-1 select-none ${className}`}>
      <div className="flex items-center gap-1">
        {isExpanded && (
          <button
            type="button"
            disabled={!canPrev}
            onClick={handlePrev}
            aria-label="上個月"
            className="w-11 h-11 grid place-items-center rounded-full text-sg-ink disabled:text-sg-full disabled:cursor-not-allowed hover:bg-sg-brown-soft/40 transition active:scale-[0.98]"
          >
            <ChevronLeft className="w-[18px] h-[18px]" strokeWidth={2} />
          </button>
        )}
        <h2 className="font-num font-extrabold text-[15px] text-sg-ink">
          {monthTitle}
        </h2>
        {isExpanded && (
          <button
            type="button"
            disabled={!canNext}
            onClick={handleNext}
            aria-label="下個月"
            className="w-11 h-11 grid place-items-center rounded-full text-sg-ink disabled:text-sg-full disabled:cursor-not-allowed hover:bg-sg-brown-soft/40 transition active:scale-[0.98]"
          >
            <ChevronRight className="w-[18px] h-[18px]" strokeWidth={2} />
          </button>
        )}
      </div>

      <button
        type="button"
        onClick={onToggleExpand}
        className="relative inline-flex items-center gap-1 rounded-full bg-sg-brown-soft px-[10px] py-1 text-[12px] font-bold text-sg-brown before:absolute before:inset-[-9px_-4px] before:content-[''] hover:opacity-90 active:scale-[0.98] transition"
      >
        <Calendar className="w-[14px] h-[14px]" strokeWidth={2} />
        <span>{isExpanded ? '收起' : '整月'}</span>
      </button>
    </div>
  );
}
