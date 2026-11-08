import React, { useState, useEffect } from 'react';
import { Search } from 'lucide-react';
import BrandLogo from '../customer/BrandLogo.jsx';

export default function AdminAppBar({
  title = '拾光製所',
  pageTitle: propPageTitle = null,
  subtitle = null,
  onLogoClick = null,
  onSearchClick = null,
  actions = null,
  className = ''
}) {
  const [nowText, setNowText] = useState('');

  const displayPageTitle = propPageTitle || (title !== '拾光製所' ? title : '');

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

  const subtitleText = displayPageTitle
    ? (nowText ? `${displayPageTitle} · ${nowText}` : displayPageTitle)
    : (subtitle || nowText);

  return (
    <header className={`min-h-[56px] h-[56px] px-4 bg-white border-b border-sg-line flex items-center justify-between z-30 select-none flex-shrink-0 ${className}`}>
      {/* Mobile view (< md): Logo + 2 lines */}
      <div className="flex md:hidden items-center gap-2.5 min-w-0">
        <button
          type="button"
          onClick={onLogoClick}
          aria-label="更多選單"
          className="shrink-0 -ml-1 h-10 w-10 grid place-items-center rounded-full hover:bg-sg-paper transition active:scale-95"
        >
          <BrandLogo size="mark" className="shrink-0" />
        </button>

        <div className="grid leading-tight min-w-0">
          <span className="font-display text-[18px] leading-[1.25] font-bold text-sg-ink truncate">
            拾光製所
          </span>
          <span className="text-[12px] font-medium text-sg-muted leading-[1.25] truncate">
            {subtitleText}
          </span>
        </div>
      </div>

      {/* Tablet/Desktop view (>= md): Only single line with pageTitle and time */}
      <div className="hidden md:flex items-center gap-3 min-w-0">
        <h1 className="text-[17px] font-bold text-sg-ink truncate leading-tight">
          {displayPageTitle}
          {nowText && <span className="text-sg-muted font-normal text-[14px] ml-2">· {nowText}</span>}
        </h1>
        {subtitle && (
          <span className="text-[13px] text-sg-muted font-normal truncate">
            {subtitle}
          </span>
        )}
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
