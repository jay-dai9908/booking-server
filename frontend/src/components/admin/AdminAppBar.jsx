import React, { useState, useEffect } from 'react';
import { Search } from 'lucide-react';
import { toTaipeiDateString } from '@shared/time';

const WEEKDAY_NAMES = ['日', '一', '二', '三', '四', '五', '六'];

export default function AdminAppBar({
  title = '拾光製所',
  subtitle = null,
  onSearchClick = null,
  actions = null,
  className = ''
}) {
  const [nowText, setNowText] = useState('');

  useEffect(() => {
    const updateTime = () => {
      const now = new Date();
      const parts = new Intl.DateTimeFormat('zh-TW', {
        timeZone: 'Asia/Taipei',
        month: '2-digit',
        day: '2-digit',
        weekday: 'short',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false
      }).formatToParts(now);

      const m = parts.find(p => p.type === 'month')?.value || '';
      const d = parts.find(p => p.type === 'day')?.value || '';
      const rawW = parts.find(p => p.type === 'weekday')?.value || '';
      const w = rawW.replace('週', '').replace('星期', '');
      const hh = parts.find(p => p.type === 'hour')?.value || '00';
      const mm = parts.find(p => p.type === 'minute')?.value || '00';
      setNowText(`${m}/${d}(${w}) ${hh}:${mm}`);
    };
    updateTime();
    const timer = setInterval(updateTime, 10000);
    return () => clearInterval(timer);
  }, []);

  return (
    <header className={`min-h-[56px] h-[56px] px-4 bg-white border-b border-sg-line flex items-center justify-between z-30 select-none flex-shrink-0 ${className}`}>
      <div className="flex items-center gap-3 min-w-0">
        <div className="min-w-0">
          <div className="flex items-baseline gap-2">
            <h1 className="text-[17px] font-bold text-sg-ink truncate leading-tight">{title}</h1>
            {subtitle && <span className="text-[12px] text-sg-muted truncate">{subtitle}</span>}
          </div>
          <div className="text-[11px] text-sg-muted font-medium leading-none mt-0.5">
            {nowText}
          </div>
        </div>
      </div>

      <div className="flex items-center gap-2">
        {onSearchClick && (
          <button
            type="button"
            onClick={onSearchClick}
            className="w-10 h-10 flex items-center justify-center rounded-full text-sg-muted hover:text-sg-ink hover:bg-sg-paper transition active:scale-95"
            aria-label="快速查詢"
          >
            <Search className="w-5 h-5" />
          </button>
        )}
        {actions}
      </div>
    </header>
  );
}
