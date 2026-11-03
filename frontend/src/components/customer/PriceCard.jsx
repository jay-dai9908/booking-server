import React, { useState } from 'react';
import { Clock, Sparkles, ChevronRight, Info } from 'lucide-react';
import Button from './Button.jsx';
import { formatMoney, formatDateShort } from '../../utils/customer/format.js';
import { DAY_TYPE_LABEL } from '../../utils/customer/pricing.js';

export default function PriceCard({
  variant = 'full', // 'full' | 'compact'
  todayStr = '',
  todayPricing,
  globalSettings,
  selectedDateStr = '',
  selectedDayPricing,
  onOpenPriceInfo,
  className = '',
}) {
  const [viewOverride, setViewOverride] = useState(null); // 'weekend' | 'weekday' | null

  if (variant === 'compact') {
    const isWeekend = selectedDayPricing?.isWeekend;
    const isSpecial = selectedDayPricing?.dayType === 'special';
    const dayLabel = selectedDateStr ? formatDateShort(selectedDateStr) : '';
    const typeLabel = DAY_TYPE_LABEL[selectedDayPricing?.dayType || 'weekday'] || '平日';

    const hourly = selectedDayPricing?.hourly ?? globalSettings?.weekday_hourly_price ?? 100;
    const unlimited = selectedDayPricing?.cap ?? globalSettings?.weekday_unlimited_price ?? 550;
    const allowUnlimited = selectedDayPricing?.allowUnlimited !== false;

    return (
      <div
        className={`grid overflow-hidden rounded-[18px] border border-sg-line bg-sg-paper shadow-sg-card ${className}`}
      >
        <div
          className={`flex items-center justify-between gap-2 px-[14px] py-[9px] ${
            isWeekend || isSpecial ? 'bg-sg-peach-soft' : 'bg-sg-brown-soft'
          }`}
        >
          <span
            className={`text-[12.5px] font-bold ${
              isWeekend || isSpecial ? 'text-sg-peach-ink' : 'text-sg-brown'
            }`}
          >
            {dayLabel} · {typeLabel}
          </span>
          {onOpenPriceInfo && (
            <button
              type="button"
              onClick={onOpenPriceInfo}
              aria-label="價格說明"
              className="-mr-2 h-11 w-11 grid place-items-center rounded-full text-sg-muted hover:text-sg-ink transition active:scale-[0.98]"
            >
              <Info className="w-4 h-4" strokeWidth={2} />
            </button>
          )}
        </div>

        <div className="grid grid-cols-2">
          {/* 計時 */}
          <div className="grid gap-px px-[14px] py-3">
            <span className="flex items-center gap-1 text-[12px] font-bold text-sg-muted whitespace-nowrap">
              <Clock className="w-[14px] h-[14px]" strokeWidth={2} />
              計時
            </span>
            <span className="font-num font-extrabold text-[26px] leading-[1.15] text-sg-brown mt-[2px]">
              {formatMoney(hourly)}
            </span>
            <span className="text-[12px] text-sg-muted">每小時</span>
          </div>

          {/* 當日不限時暢玩 */}
          <div className="grid gap-px px-[14px] py-3 border-l border-sg-line">
            <span className="flex items-center gap-1 text-[12px] font-bold text-sg-muted whitespace-nowrap">
              <Sparkles className="w-[14px] h-[14px]" strokeWidth={2} />
              當日不限時暢玩
            </span>
            <span
              className={`font-num font-extrabold text-[26px] leading-[1.15] mt-[2px] ${
                !allowUnlimited ? 'text-sg-full' : 'text-sg-brown'
              }`}
            >
              {!allowUnlimited ? '—' : formatMoney(unlimited)}
            </span>
            <span className="text-[12px] text-sg-muted">
              {!allowUnlimited ? '這天不開放' : '每人，中途可離場'}
            </span>
          </div>
        </div>
      </div>
    );
  }

  // variant === 'full' (Home page)
  const isTodayWeekend = todayPricing?.isWeekend;
  const isTodaySpecial = todayPricing?.dayType === 'special';
  const todayLabel = todayStr ? formatDateShort(todayStr) : '';
  const todayType = DAY_TYPE_LABEL[todayPricing?.dayType || 'weekday'] || '平日';

  let titleText = `今天 ${todayLabel} · ${todayType}`;
  let toggleText = isTodayWeekend ? '看平日價格' : '看假日價格';
  let isPinkHeader = isTodayWeekend || isTodaySpecial;

  let hourly = todayPricing?.hourly ?? globalSettings?.weekday_hourly_price ?? 100;
  let unlimited = todayPricing?.cap ?? globalSettings?.weekday_unlimited_price ?? 550;
  let allowUnlimited = todayPricing?.allowUnlimited !== false;

  if (viewOverride === 'weekend') {
    titleText = '假日（六、日）';
    toggleText = '看今天價格';
    isPinkHeader = true;
    hourly = globalSettings?.weekend_hourly_price ?? 150;
    unlimited = globalSettings?.weekend_unlimited_price ?? 800;
    allowUnlimited = true;
  } else if (viewOverride === 'weekday') {
    titleText = '平日（一到五）';
    toggleText = '看今天價格';
    isPinkHeader = false;
    hourly = globalSettings?.weekday_hourly_price ?? 100;
    unlimited = globalSettings?.weekday_unlimited_price ?? 550;
    allowUnlimited = true;
  }

  const handleToggle = () => {
    if (viewOverride !== null) {
      setViewOverride(null);
    } else if (isTodayWeekend) {
      setViewOverride('weekday');
    } else {
      setViewOverride('weekend');
    }
  };

  return (
    <div
      className={`grid overflow-hidden rounded-[18px] border border-sg-line bg-sg-paper shadow-sg-card ${className}`}
    >
      <div
        className={`flex items-center justify-between gap-2 px-[14px] py-[9px] ${
          isPinkHeader ? 'bg-sg-peach-soft' : 'bg-sg-brown-soft'
        }`}
      >
        <span
          className={`text-[12.5px] font-bold ${
            isPinkHeader ? 'text-sg-peach-ink' : 'text-sg-brown'
          }`}
        >
          {titleText}
        </span>
        <Button
          variant="text"
          onClick={handleToggle}
          className="text-[12px] h-8 -mr-1"
        >
          <span>{toggleText}</span>
          <ChevronRight className="w-[14px] h-[14px] -ml-1" strokeWidth={2} />
        </Button>
      </div>

      <div className="grid grid-cols-2">
        {/* 計時 */}
        <div className="grid gap-px px-[14px] py-3">
          <span className="flex items-center gap-1 text-[12px] font-bold text-sg-muted whitespace-nowrap">
            <Clock className="w-[14px] h-[14px]" strokeWidth={2} />
            計時
          </span>
          <span className="font-num font-extrabold text-[26px] leading-[1.15] text-sg-brown mt-[2px]">
            {formatMoney(hourly)}
          </span>
          <span className="text-[12px] text-sg-muted">每小時</span>
        </div>

        {/* 當日不限時暢玩 */}
        <div className="grid gap-px px-[14px] py-3 border-l border-sg-line">
          <span className="flex items-center gap-1 text-[12px] font-bold text-sg-muted whitespace-nowrap">
            <Sparkles className="w-[14px] h-[14px]" strokeWidth={2} />
            當日不限時暢玩
          </span>
          <span
            className={`font-num font-extrabold text-[26px] leading-[1.15] mt-[2px] ${
              !allowUnlimited ? 'text-sg-full' : 'text-sg-brown'
            }`}
          >
            {!allowUnlimited ? '—' : formatMoney(unlimited)}
          </span>
          <span className="text-[12px] text-sg-muted">
            {!allowUnlimited ? '這天不開放' : '每人，中途可離場'}
          </span>
        </div>
      </div>

      <div className="text-[12px] text-sg-muted px-[14px] pt-2 pb-[10px] border-t border-dashed border-sg-line">
        每位都附傳統拼豆板、豆子無限使用
      </div>
    </div>
  );
}
