import React from 'react';
import BottomSheet from '../BottomSheet';
import Button from '../Button';
import { boardDiscountTexts } from '../../../utils/customer/discountText';
import { buildDiscountConfig, getDayPricing } from '../../../utils/customer/pricing';
import { formatMoney } from '../../../utils/customer/format';

/**
 * PriceInfoSheet (Section 6.11)
 * Explains pricing rules, hourly vs cap, and smart board rental.
 */
export default function PriceInfoSheet({
  isOpen,
  onClose,
  globalSettings,
  dayPricing = null,
  dateStr = '',
  equipmentConfigs = [],
}) {
  const g = globalSettings || {};
  const weekdayHourly = g.weekday_hourly_price ?? 100;
  const weekdayCap = g.weekday_unlimited_price ?? 550;
  const weekendHourly = g.weekend_hourly_price ?? 150;
  const weekendCap = g.weekend_unlimited_price ?? 800;

  const discountCfg = buildDiscountConfig(g);
  const discountTexts = boardDiscountTexts(discountCfg);

  // Active boards (excluding bring_own)
  const activeBoards = (equipmentConfigs || [])
    .filter((b) => b.is_active && b.equipment_id !== 'bring_own')
    .map((b) => `${b.name} ${formatMoney(b.hourly_rate)}`)
    .join('、');

  let smartBoardLine = activeBoards ? `智能拼豆板：${activeBoards} / 小時` : '智能拼豆板可現場選租';
  if (discountTexts && discountTexts.deal) {
    smartBoardLine += `，${discountTexts.deal}`;
  }

  const isSpecial = dayPricing?.dayType === 'special';

  return (
    <BottomSheet isOpen={isOpen} onClose={onClose} title="價格說明">
      <div className="grid gap-[10px]">
        {isSpecial && (
          <div className="grid gap-[2px] rounded-[12px] bg-sg-brown-soft p-[10px]">
            <div className="text-[13px] font-bold text-sg-brown">
              {dayPricing.specialLabel || '特別價'}
            </div>
            <div className="flex items-baseline">
              <span className="font-num font-extrabold text-[18px] text-sg-brown">
                {formatMoney(dayPricing.hourly)}
              </span>
              <span className="text-[12px] font-bold text-sg-brown"> / 小時</span>
            </div>
            <div className="sg-small">
              不限時封頂 {formatMoney(dayPricing.cap)} / 人
            </div>
          </div>
        )}

        <div className="grid grid-cols-2 gap-2">
          {/* Weekday */}
          <div className="grid gap-[2px] rounded-[12px] bg-sg-bg p-[10px]">
            <div className="text-[13px] font-bold">平日（一到五）</div>
            <div className="flex items-baseline">
              <span className="font-num font-extrabold text-[18px] text-sg-brown">
                {formatMoney(weekdayHourly)}
              </span>
              <span className="text-[12px] font-bold"> / 小時</span>
            </div>
            <div className="sg-small">
              不限時封頂 {formatMoney(weekdayCap)} / 人
            </div>
          </div>

          {/* Weekend */}
          <div className="grid gap-[2px] rounded-[12px] bg-sg-peach-soft p-[10px]">
            <div className="text-[13px] font-bold text-sg-peach-ink">假日（六、日）</div>
            <div className="flex items-baseline">
              <span className="font-num font-extrabold text-[18px] text-sg-brown">
                {formatMoney(weekendHourly)}
              </span>
              <span className="text-[12px] font-bold"> / 小時</span>
            </div>
            <div className="sg-small">
              不限時封頂 {formatMoney(weekendCap)} / 人
            </div>
          </div>
        </div>

        <ul className="list-disc pl-[1.1em] grid gap-1 text-[12.5px] text-sg-muted">
          <li>每位都附傳統拼豆板、豆子無限使用</li>
          <li>計時玩到封頂金額，會自動改收封頂價</li>
          <li>{smartBoardLine}</li>
          <li>座位保留 15 分鐘，離場前請留 10 分鐘壓平作品</li>
        </ul>

        <Button variant="secondary" size="sm" onClick={onClose} className="w-full mt-1">
          知道了
        </Button>
      </div>
    </BottomSheet>
  );
}
