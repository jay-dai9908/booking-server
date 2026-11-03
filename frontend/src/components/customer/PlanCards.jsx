import React from 'react';
import { Check, Info } from 'lucide-react';
import Button from './Button.jsx';
import Skeleton from './Skeleton.jsx';
import { useToast } from './Toast.jsx';
import { formatMoney, formatDateShort } from '../../utils/customer/format.js';
import { DAY_PRICE_LABEL } from '../../utils/customer/pricing.js';

export default function PlanCards({
  mode = 'timed', // 'timed' | 'unlimited'
  onSelectMode,
  onChangeMode,
  hourlyPrice,
  unlimitedPrice,
  allowUnlimited = true,
  dateStr = '',
  dayPricing,
  onOpenPriceInfo,
  onShowToast,
  className = '',
}) {
  const toast = useToast();
  const selectMode = onSelectMode || onChangeMode || (() => {});
  const isTimed = mode === 'timed';
  const isUnlimited = mode === 'unlimited';

  const dateLabel = dateStr ? formatDateShort(dateStr) : '';
  const priceType = dayPricing?.dayType || 'weekday';
  const priceTypeLabel = DAY_PRICE_LABEL[priceType] || '平日價';
  const isWeekendOrSpecial = priceType === 'weekend' || priceType === 'special';

  const handleUnlimitedClick = () => {
    if (!allowUnlimited) {
      if (onShowToast) {
        onShowToast('這天不開放當日不限時暢玩');
      } else if (toast?.show) {
        toast.show('這天不開放當日不限時暢玩', { type: 'info' });
      }
      return;
    }
    selectMode('unlimited');
  };

  return (
    <div className={`grid gap-2 w-full ${className}`}>
      <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="計費方式">
        {/* 計時卡 */}
        <button
          type="button"
          role="radio"
          aria-checked={isTimed}
          onClick={() => selectMode('timed')}
          className={`relative grid rounded-[16px] border-[1.5px] bg-sg-paper pt-[10px] px-3 pb-[11px] text-left transition select-none ${
            isTimed
              ? 'border-2 border-sg-brown bg-sg-selected shadow-sg-pop p-[calc(10px-0.5px)_calc(12px-0.5px)_calc(11px-0.5px)]'
              : 'border-sg-line hover:border-sg-brown/50'
          }`}
        >
          {isTimed && (
            <span
              className="absolute top-[9px] right-[9px] h-[18px] w-[18px] rounded-full bg-sg-brown text-white grid place-items-center"
              aria-hidden="true"
            >
              <Check className="w-3 h-3" strokeWidth={3} />
            </span>
          )}
          <span className="text-[12.5px] font-bold pr-[22px] whitespace-nowrap text-sg-ink">
            計時
          </span>
          <span
            className={`font-num font-extrabold text-[26px] leading-[1.15] mt-1 ${
              isTimed ? 'text-sg-brown' : 'text-sg-ink'
            }`}
          >
            {hourlyPrice != null ? formatMoney(hourlyPrice) : <Skeleton className="h-7 w-20 inline-block my-1 rounded" />}
          </span>
          <span className="text-[11.5px] text-sg-muted">
            每小時
          </span>
          <span className="text-[12px] text-sg-muted mt-1 pt-1 border-t border-dashed border-sg-line">
            玩幾小時算幾小時
          </span>
        </button>

        {/* 當日不限時暢玩卡 */}
        <button
          type="button"
          role="radio"
          aria-checked={isUnlimited}
          aria-disabled={!allowUnlimited ? 'true' : undefined}
          onClick={handleUnlimitedClick}
          className={`relative grid rounded-[16px] border-[1.5px] bg-sg-paper pt-[10px] px-3 pb-[11px] text-left transition select-none ${
            !allowUnlimited
              ? 'border-dashed border-sg-line cursor-not-allowed opacity-80'
              : isUnlimited
              ? 'border-2 border-sg-brown bg-sg-selected shadow-sg-pop p-[calc(10px-0.5px)_calc(12px-0.5px)_calc(11px-0.5px)]'
              : 'border-sg-line hover:border-sg-brown/50'
          }`}
        >
          {isUnlimited && allowUnlimited && (
            <span
              className="absolute top-[9px] right-[9px] h-[18px] w-[18px] rounded-full bg-sg-brown text-white grid place-items-center"
              aria-hidden="true"
            >
              <Check className="w-3 h-3" strokeWidth={3} />
            </span>
          )}
          <span className="text-[12.5px] font-bold pr-[22px] whitespace-nowrap text-sg-ink">
            當日不限時暢玩
          </span>
          <span
            className={`font-num font-extrabold text-[26px] leading-[1.15] mt-1 ${
              !allowUnlimited
                ? 'text-sg-full'
                : isUnlimited
                ? 'text-sg-brown'
                : 'text-sg-ink'
            }`}
          >
            {!allowUnlimited ? '—' : unlimitedPrice != null ? formatMoney(unlimitedPrice) : <Skeleton className="h-7 w-20 inline-block my-1 rounded" />}
          </span>
          <span className="text-[11.5px] text-sg-muted">
            每人
          </span>
          <span className="text-[12px] text-sg-muted mt-1 pt-1 border-t border-dashed border-sg-line">
            {!allowUnlimited ? '這天不開放' : '中途可離場'}
          </span>
        </button>
      </div>

      {/* 卡片下方一行 */}
      <div className="flex justify-between items-center text-[12px] leading-[1.5] px-1 select-none">
        <span
          className={
            isWeekendOrSpecial
              ? 'font-bold text-sg-peach-ink'
              : 'text-sg-muted'
          }
        >
          {dateLabel} · {priceTypeLabel}
        </span>
        <Button
          variant="text"
          icon={<Info className="w-[15px] h-[15px]" strokeWidth={2} />}
          onClick={onOpenPriceInfo}
        >
          價格說明
        </Button>
      </div>
    </div>
  );
}
