import React, { useMemo } from 'react';
import StepIndicator from '../../../components/customer/StepIndicator';
import { Card, Divider } from '../../../components/customer/Card';
import Stepper from '../../../components/customer/Stepper';
import Button from '../../../components/customer/Button';
import { BoardTimeBox } from '../../../components/customer/RangeSlider';
import { SoftBox } from '../../../components/customer/Banners';
import BottomActionBar from '../../../components/customer/BottomActionBar';
import { useToast } from '../../../components/customer/Toast';
import {
  formatDateShort,
  formatMoney,
  weekdayChar,
} from '../../../utils/customer/format';
import {
  seatPrice,
  shortBoardName,
  equipmentUnitPrice,
  groupUnits,
  buildDiscountConfig,
} from '../../../utils/customer/pricing';
import { boardDiscountTexts } from '../../../utils/customer/discountText';
import { canPlace } from '../../../utils/customer/availability';

export default function StepPeopleAddons({
  date,
  mode,
  bookingSessions = [],
  pax,
  onChangePax,
  units,
  onChangeUnits,
  globalSettings,
  dayPricing,
  equipmentConfigs = [],
  availBySession = {},
  onBack,
  onNext,
}) {
  const toast = useToast();

  const H = bookingSessions.length;
  const hourStartTimes = useMemo(() => bookingSessions.map((s) => s.start_time), [bookingSessions]);
  const boundaryTime = (k) => (k < H ? bookingSessions[k].start_time : bookingSessions[H - 1].end_time);

  // Maximum people allowed = minimum remaining capacity among selected sessions
  const maxPax = useMemo(() => {
    if (!bookingSessions.length) return 1;
    const mins = bookingSessions.map((s) => s.remaining_capacity ?? 99);
    return Math.max(1, Math.min(...mins));
  }, [bookingSessions]);

  const allowExceedPax = !!globalSettings?.allow_exceed_pax;
  const showLiveStock = globalSettings?.show_equipment_live_stock !== false;
  const discountConfig = useMemo(() => buildDiscountConfig(globalSettings || {}), [globalSettings]);
  const discountTexts = useMemo(() => boardDiscountTexts(discountConfig), [discountConfig]);

  const configsMap = useMemo(() => {
    const map = {};
    equipmentConfigs.forEach((c) => {
      map[c.equipment_id] = c;
    });
    return map;
  }, [equipmentConfigs]);

  // Current count per board type
  const currentQtys = useMemo(() => {
    const map = {};
    units.forEach((u) => {
      map[u.equipment_id] = (map[u.equipment_id] || 0) + 1;
    });
    return map;
  }, [units]);

  // Non-bring-own total
  const nonBringOwnTotal = useMemo(() => {
    return units.filter((u) => u.equipment_id !== 'bring_own').length;
  }, [units]);

  // Handle Pax change with board auto-trimming
  const handlePaxChange = (newPax) => {
    if (newPax > maxPax) {
      toast.show(`這段時間最多還能預約 ${maxPax} 位`, { type: 'info' });
      return;
    }
    onChangePax(newPax);

    // If newPax is less than current non-bring-own board count, trim boards from the end
    if (!allowExceedPax && nonBringOwnTotal > newPax) {
      const allowedCount = newPax;
      let keptCount = 0;
      const trimmed = [];
      // Keep bring_own, and keep up to allowedCount non-bring_own
      for (const u of units) {
        if (u.equipment_id === 'bring_own') {
          trimmed.push(u);
        } else if (keptCount < allowedCount) {
          trimmed.push(u);
          keptCount++;
        }
      }
      onChangeUnits(trimmed);
      toast.show(`人數改成 ${newPax} 位，智能板也調整成 ${allowedCount} 台`, { type: 'info' });
    }
  };

  // Add a unit of equipment
  const handleAddBoard = (eq) => {
    const isBringOwn = eq.equipment_id === 'bring_own';
    if (!allowExceedPax && !isBringOwn && nonBringOwnTotal >= pax) {
      toast.show(`只有需要的人租就好，最多 ${pax} 台`, { type: 'info' });
      return;
    }

    const minH = Math.min(eq.min_contiguous_hours || 2, H);
    const candidate = {
      uid: Math.random().toString(36).substring(2, 9),
      equipment_id: eq.equipment_id,
      from: 0,
      to: H,
    };

    const check = canPlace(units, candidate, availBySession, hourStartTimes);
    if (!check.ok) {
      toast.show(`${shortBoardName(eq.name)} ${check.hour} 已經租完了`, { type: 'error' });
      return;
    }

    onChangeUnits([...units, candidate]);
  };

  // Remove the LAST unit of equipment
  const handleRemoveBoard = (equipment_id) => {
    const revIdx = [...units].reverse().findIndex((u) => u.equipment_id === equipment_id);
    if (revIdx === -1) return;
    const targetIdx = units.length - 1 - revIdx;
    onChangeUnits(units.filter((_, i) => i !== targetIdx));
  };

  // Update slider times for a specific unit
  const handleUnitTimeChange = (uid, newFrom, newTo) => {
    onChangeUnits(
      units.map((u) => (u.uid === uid ? { ...u, from: newFrom, to: newTo } : u))
    );
  };

  // Calculate pricing
  const hourly = dayPricing?.hourly ?? 100;
  const cap = dayPricing?.cap ?? 550;
  const allowUnlimited = dayPricing?.allowUnlimited ?? true;

  const seatCalc = useMemo(() => {
    return seatPrice({
      pax,
      hours: H,
      hourly,
      cap,
      allowUnlimited,
      mode,
    });
  }, [pax, H, hourly, cap, allowUnlimited, mode]);

  const groups = useMemo(() => {
    return groupUnits(units, boundaryTime);
  }, [units, boundaryTime]);

  const equipmentTotal = useMemo(() => {
    let sum = 0;
    for (const group of groups) {
      const cfg = configsMap[group.equipment_id];
      if (!cfg) continue;
      const p = equipmentUnitPrice(cfg, group.hours, discountConfig);
      sum += p.price * group.qty;
    }
    return sum;
  }, [groups, configsMap, discountConfig]);

  const totalPrice = seatCalc.total + equipmentTotal;

  // Bottom action bar summary text
  const timeDesc = `${bookingSessions[0]?.start_time || ''} 到 ${bookingSessions[H - 1]?.end_time || ''}`;
  const hoursDesc = mode === 'unlimited' ? '不限時' : `${H} 小時`;

  const boardSummary = useMemo(() => {
    if (units.length === 0) return '';
    if (units.length <= 2) {
      return units
        .map((u) => {
          const cfg = configsMap[u.equipment_id];
          const name = cfg ? shortBoardName(cfg.name) : '智能板';
          const dur = u.to - u.from;
          return `${name} ${dur} 小時`;
        })
        .join('、');
    }
    return `智能板 ${units.length} 台`;
  }, [units, configsMap]);

  const actionSummary = `${pax} 位 · ${hoursDesc}${boardSummary ? ` · ${boardSummary}` : ''}`;

  // Date and time summary row string
  const dateFormatted = `${formatDateShort(date)} ${weekdayChar(date)}`;
  const summaryTimeText = mode === 'unlimited' ? `${timeDesc} · 不限時` : timeDesc;

  return (
    <>
      {/* 1. Step Indicator */}
      <StepIndicator currentStep={3} />

      {/* 2. Selected Summary Row */}
      <div className="flex items-center justify-between rounded-[12px] bg-sg-brown-soft px-3 py-2 text-[13px]">
        <div>
          <b>{dateFormatted}</b>
          <span className="font-num ml-2">{summaryTimeText}</span>
        </div>
        <Button variant="text" size="sm" onClick={onBack}>
          修改
        </Button>
      </div>

      {/* 3. People Card */}
      <Card>
        <div className="flex items-center justify-between">
          <div>
            <div className="text-[15px] font-bold">人數</div>
            <div className="sg-small">每位都附傳統拼豆板和豆子無限使用</div>
          </div>
          <Stepper
            value={pax}
            min={1}
            max={maxPax}
            emphasis
            onMinus={() => handlePaxChange(Math.max(1, pax - 1))}
            onPlus={() => handlePaxChange(pax + 1)}
            label="人數"
          />
        </div>
      </Card>

      {/* 4. Smart Board Card */}
      {equipmentConfigs.some((eq) => eq.is_active && eq.status !== 'HIDDEN') && (
        <Card gap={12}>
          <div>
            <div className="text-[15px] font-bold">智能拼豆板（選租）</div>
            <div className="sg-small">
              {allowExceedPax ? '只有需要的人租就好' : `只有需要的人租就好，最多 ${pax} 台`}
            </div>
          </div>

          <div className="grid gap-3">
            {equipmentConfigs
              .filter((eq) => eq.is_active && eq.status !== 'HIDDEN')
              .map((eq, idx) => {
                const isMaintenance = eq.status === 'MAINTENANCE';
                const maintenanceNote = eq.status_note
                  ? eq.status_note.replace(/^[\p{Extended_Pictographic}️\s]+/u, '')
                  : '維護中，暫停借用';
                const eqUnits = units.filter((u) => u.equipment_id === eq.equipment_id);
                const count = eqUnits.length;
                const isBringOwn = eq.equipment_id === 'bring_own';

                // Stock remaining
                let stockRemaining = 99;
                if (!isBringOwn && availBySession[eq.equipment_id]) {
                  const hoursAvail = hourStartTimes.map(
                    (t) => availBySession[eq.equipment_id][t] ?? 0
                  );
                  stockRemaining = Math.max(0, Math.min(...hoursAvail) - count);
                }

                let stockText = '';
                if (!isBringOwn && showLiveStock) {
                  stockText = stockRemaining <= 0 ? ' · 已租完' : ` · 剩 ${stockRemaining} 台`;
                }

                const nameParts = eq.name.match(/^(.*?)(?:\s*[（(]([^）)]+)[）)])?$/);
                const displayName = nameParts ? nameParts[1].trim() : eq.name;
                const sizePart = nameParts && nameParts[2] ? nameParts[2].trim() : '';

                const canAdd =
                  !isMaintenance &&
                  (allowExceedPax || isBringOwn || nonBringOwnTotal < pax) &&
                  (isBringOwn || stockRemaining > 0);

                return (
                  <div key={eq.equipment_id} className="grid gap-2">
                    {idx > 0 && <Divider className="mb-1" />}
                    <div className="flex items-center justify-between">
                      <div>
                        <div className="text-[14px]">
                          <span className="font-bold">{displayName}</span>
                          {sizePart && (
                            <span className="font-num sg-small ml-1.5">{sizePart}</span>
                          )}
                        </div>
                        <div className="sg-small">
                          {isMaintenance ? (
                            <span className="text-sg-full">{maintenanceNote}</span>
                          ) : (
                            <>
                              <span>{formatMoney(eq.hourly_rate)} / 小時</span>
                              {stockText && (
                                <span className={stockRemaining > 0 && stockRemaining <= 2 ? 'text-sg-honey-ink font-bold' : ''}>
                                  {stockText}
                                </span>
                              )}
                            </>
                          )}
                        </div>
                      </div>

                      <Stepper
                        value={count}
                        min={0}
                        max={isBringOwn ? 99 : allowExceedPax ? 99 : pax}
                        disabledMinus={count <= 0}
                        disabledPlus={!canAdd}
                        onMinus={() => handleRemoveBoard(eq.equipment_id)}
                        onPlus={() => handleAddBoard(eq)}
                        label={displayName}
                      />
                    </div>

                    {/* BoardTimeBoxes for this board */}
                    {eqUnits.map((u, uIdx) => (
                      <BoardTimeBox
                        key={u.uid}
                        label={`第 ${uIdx + 1} 台使用時間`}
                        from={u.from}
                        to={u.to}
                        minHours={Math.min(eq.min_contiguous_hours || 2, H)}
                        bookingSessions={bookingSessions}
                        onChange={(newFrom, newTo) => handleUnitTimeChange(u.uid, newFrom, newTo)}
                      />
                    ))}
                  </div>
                );
              })}
          </div>

          {discountTexts && (
            <SoftBox className="mt-1">
              {discountTexts.rule}
            </SoftBox>
          )}
        </Card>
      )}

      {/* Bottom bar */}
      <div className="sticky bottom-0 z-40">
        <BottomActionBar
          summary={actionSummary}
          price={totalPrice}
          actionLabel="下一步"
          onAction={onNext}
          hasTabBarBelow={false}
        />
      </div>
    </>
  );
}
