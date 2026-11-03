import React from 'react';
import Button from './Button';
import { formatMoney, formatMoneyBig } from '../../utils/customer/format';

/**
 * BottomActionBar (Section 3.4)
 * Sticky bottom summary bar with action button.
 */
export default function BottomActionBar({
  summary,
  price,
  strikePrice = null,
  actionLabel = '下一步',
  onAction,
  disabled = false,
  loading = false,
  hasTabBarBelow = false,
  className = '',
}) {
  const pbClass = hasTabBarBelow
    ? 'pb-[10px]'
    : 'pb-[max(14px,env(safe-area-inset-bottom))]';

  return (
    <div
      role="region"
      aria-label="結帳與金額列"
      className={`flex items-center gap-[10px] bg-sg-paper border-t border-sg-line px-4 pt-[10px] ${pbClass} ${className}`}
    >
      <div className="flex-1 min-w-0">
        {summary && (
          <div className="sg-small whitespace-nowrap overflow-hidden text-ellipsis">
            {summary}
          </div>
        )}
        <div className="font-num font-extrabold text-[22px] leading-[1.1] text-sg-brown tabular-nums flex items-baseline">
          {strikePrice != null && strikePrice > price && (
            <span className="font-num font-semibold text-[14px] text-sg-muted line-through mr-1">
              {formatMoney(strikePrice)}
            </span>
          )}
          <span>{formatMoneyBig(price)}</span>
        </div>
      </div>

      <Button
        variant="primary"
        size="sm"
        loading={loading}
        disabled={disabled}
        onClick={onAction}
        className="min-h-[44px] px-[22px] min-w-[104px] shrink-0"
      >
        {actionLabel}
      </Button>
    </div>
  );
}
