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
      const m = String(now.getMonth() + 1).padStart(2, '0');
      const d = String(now.getDate()).padStart(2, '0');
      const w = WEEKDAY_NAMES[now.getDay()];
      const hh = String(now.getHours()).padStart(2, '0');
      const mm = String(now.getMinutes()).padStart(2, '0');
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
