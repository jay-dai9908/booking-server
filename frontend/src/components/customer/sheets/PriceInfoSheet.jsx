import React, { useState, useEffect } from 'react';
import BottomSheet from '../BottomSheet';
import Button from '../Button';
import Skeleton from '../Skeleton';
import EmptyState from '../EmptyState';
import api from '../../../api/axios';
import { boardDiscountTexts } from '../../../utils/customer/discountText';
import { buildDiscountConfig, shortBoardName } from '../../../utils/customer/pricing';
import { formatMoney, formatDateShort } from '../../../utils/customer/format';

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
  error = null,
  onReload,
}) {
  const [internalConfigs, setInternalConfigs] = useState([]);

  useEffect(() => {
    if (!isOpen || (equipmentConfigs && equipmentConfigs.length > 0)) return;
    api.get(`/equipment/availability${dateStr ? `?date=${dateStr}` : ''}`)
      .then((res) => {
        setInternalConfigs(res.data?.equipments || []);
      })
      .catch(() => {});
  }, [isOpen, equipmentConfigs, dateStr]);

  const effectiveConfigs = (equipmentConfigs && equipmentConfigs.length > 0) ? equipmentConfigs : internalConfigs;

  const g = globalSettings || {};
  const weekdayHourly = g.weekday_hourly_price;
  const weekdayCap = g.weekday_unlimited_price;
  const weekendHourly = g.weekend_hourly_price;
  const weekendCap = g.weekend_unlimited_price;
  const hasPricing = weekdayHourly != null;

  const discountCfg = buildDiscountConfig(g);
  const discountTexts = hasPricing ? boardDiscountTexts(discountCfg) : null;

  // Active boards (excluding bring_own)
  const isBoardActive = (b) => {
    const id = b.id || b.equipment_id;
    if (id === 'bring_own') return false;
    if (b.visibility_status) return b.visibility_status === 'ACTIVE';
    return b.is_active !== false && b.status !== 'HIDDEN';
  };

  const activeBoards = (effectiveConfigs || [])
    .filter(isBoardActive)
    .map((b) => `${shortBoardName(b.name)} ${formatMoney(b.hourly_rate)}`)
    .join('、');

  let smartBoardNode = null;
  if (!hasPricing) {
    smartBoardNode = <Skeleton className="h-4 w-4/5 rounded inline-block" />;
  } else {
    let line = activeBoards ? `智能拼豆板：${activeBoards} / 小時` : '智能拼豆板可現場選租';
    if (discountTexts && discountTexts.deals) {
      line += `，${discountTexts.deals}`;
    }
    smartBoardNode = line;
  }

  const isSpecial = dayPricing?.dayType === 'special';
  const specialTitle = dateStr ? `${formatDateShort(dateStr)}特別價` : (dayPricing?.specialLabel || '特別價');

  return (
    <BottomSheet isOpen={isOpen} onClose={onClose} title="價格說明">
      <div className="grid gap-[10px] min-w-0">
        {error && !hasPricing ? (
          <EmptyState
            title="暫時抓不到價格"
            description="請檢查網路後重新整理"
            action={onReload ? <Button size="sm" onClick={onReload}>重新整理</Button> : undefined}
          />
        ) : (
          <>
            {isSpecial && (
              <div className="grid gap-[2px] rounded-[12px] bg-sg-brown-soft p-[10px]">
                <div className="text-[13px] font-bold text-sg-brown">
                  {specialTitle}
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

            {!hasPricing ? (
              <div className="grid grid-cols-2 gap-2">
                <Skeleton className="h-[84px] rounded-[12px]" />
                <Skeleton className="h-[84px] rounded-[12px]" />
              </div>
            ) : (
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
            )}

            <ul className="list-disc pl-[1.1em] grid gap-1 text-[12.5px] text-sg-muted">
              <li>每位都附傳統拼豆板、豆子無限使用</li>
              <li>計時玩到封頂金額，會自動改收封頂價</li>
              <li>{smartBoardNode}</li>
              <li>座位保留 15 分鐘，離場前請留 10 分鐘壓平作品</li>
            </ul>
          </>
        )}

        <Button variant="secondary" size="sm" onClick={onClose} className="w-full mt-1">
          知道了
        </Button>
      </div>
    </BottomSheet>
  );
}
