import React, { useMemo } from 'react';
import StepIndicator from '../../../components/customer/StepIndicator';
import { Card, Divider } from '../../../components/customer/Card';
import Stepper from '../../../components/customer/Stepper';
import Button from '../../../components/customer/Button';
import EmptyState from '../../../components/customer/EmptyState';
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
import { validateCouponPax } from '../../../utils/customer/couponPaxValidation';

export default function StepPeopleAddons({
  date,
  mode,
  bookingSessions = [],
  pax,
  onChangePax,
  promo = null,
  onChangePromo = null,
  units,
  onChangeUnits,
  globalSettings,
  dayPricing,
  hasPricing = true,
  globalLoading = false,
  globalError = null,
  onReloadPricing,
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
  const discountTexts = useMemo(() => (hasPricing ? boardDiscountTexts(discountConfig) : null), [hasPricing, discountConfig]);

  const configsMap = useMemo(() => {
    const map = {};
    equipmentConfigs.forEach((c) => {
      const eqId = c.equipment_id || c.id;
      if (eqId) map[eqId] = c;
    });
    return map;
  }, [equipmentConfigs]);

  const isBoardVisible = (eq) => {
    const eqId = eq.equipment_id || eq.id;
    if (eqId === 'bring_own') return false;
    return eq.visibility_status !== 'HIDDEN';
  };

  const sortedEquipmentConfigs = useMemo(() => {
    return [...equipmentConfigs]
      .filter(isBoardVisible)
      .sort((a, b) => {
        const aId = a.equipment_id || a.id;
        const bId = b.equipment_id || b.id;
        if (aId === 'bring_own') return 1;
        if (bId === 'bring_own') return -1;
        return (a.sort_order ?? 0) - (b.sort_order ?? 0);
      });
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

  const getCandidateWindow = (eq, currentUnits = units) => {
    const eqId = eq.equipment_id || eq.id;
    const isBringOwn = eqId === 'bring_own';
    const minH = Math.min(eq.min_contiguous_hours || 2, H);

    if (allowExceedPax || isBringOwn) {
      return { canAdd: true, from: 0, to: H, reason: null };
    }

    // Check usage across all slots 0..H
    const slotUsage = (k) => currentUnits.filter(u => u.equipment_id !== 'bring_own' && u.from <= k && k < u.to).length;

    // Find all slots where slotUsage < pax
    const freeSlots = [];
    for (let k = 0; k < H; k++) {
      if (slotUsage(k) < pax) freeSlots.push(k);
    }

    if (freeSlots.length === 0) {
      return { canAdd: false, reason: '每個時段都已經有板子了' };
    }

    // Build contiguous free intervals
    const freeIntervals = [];
    let curStart = freeSlots[0];
    let prev = freeSlots[0];
    for (let i = 1; i < freeSlots.length; i++) {
      if (freeSlots[i] === prev + 1) {
        prev = freeSlots[i];
      } else {
        freeIntervals.push({ from: curStart, to: prev + 1 });
        curStart = freeSlots[i];
        prev = freeSlots[i];
      }
    }
    freeIntervals.push({ from: curStart, to: prev + 1 });

    // Look for first free interval with length >= minH
    const validInterval = freeIntervals.find(inv => inv.to - inv.from >= minH);
    if (validInterval) {
      return { canAdd: true, from: validInterval.from, to: validInterval.to, reason: null };
    }

    // If first interval is shorter than minH, can we extend from its start?
    const firstInv = freeIntervals[0];
    const targetEnd = firstInv.from + minH;
    if (targetEnd <= H && Array.from({ length: minH }, (_, i) => firstInv.from + i).every(k => slotUsage(k) < pax)) {
      return { canAdd: true, from: firstInv.from, to: targetEnd, reason: null };
    }

    // No free interval can satisfy minH
    return { canAdd: false, reason: '剩下的時間不到 2 小時' };
  };

  // Handle Pax change with board auto-trimming based on concurrent slots
  const handlePaxChange = (newPax) => {
    if (newPax > maxPax) {
      toast.show(`這段時間最多還能預約 ${maxPax} 位`, { type: 'info' });
      return;
    }
    onChangePax(newPax);

    // Auto-cancel coupon if pax requirement is not met (Round 18 Item 2)
    if (promo && onChangePromo) {
      const check = validateCouponPax(promo, newPax);
      if (check.cancelled) {
        onChangePromo(null);
        toast.show(check.message, { type: 'info' });
      }
    }

    if (!allowExceedPax) {
      let adjustedUnits = [...units];
      let needsAdjustment = false;
      for (let k = 0; k < H; k++) {
        while (adjustedUnits.filter(u => u.equipment_id !== 'bring_own' && u.from <= k && k < u.to).length > newPax) {
          needsAdjustment = true;
          const revIdx = [...adjustedUnits].reverse().findIndex(u => u.equipment_id !== 'bring_own' && u.from <= k && k < u.to);
          if (revIdx === -1) break;
          const targetIdx = adjustedUnits.length - 1 - revIdx;
          adjustedUnits.splice(targetIdx, 1);
        }
      }
      if (needsAdjustment) {
        onChangeUnits(adjustedUnits);
        toast.show(`人數改成 ${newPax} 位，智能板也同步調整`, { type: 'info' });
      }
    }
  };

  // Add a unit of equipment
  const handleAddBoard = (eq) => {
    const eqId = eq.equipment_id || eq.id;
    const isBringOwn = eqId === 'bring_own';
    const candWin = getCandidateWindow(eq);
    if (!candWin.canAdd) {
      toast.show(candWin.reason || '無法加租', { type: 'info' });
      return;
    }

    const candidate = {
      uid: Math.random().toString(36).substring(2, 9),
      equipment_id: eqId,
      from: candWin.from,
      to: candWin.to,
    };

    if (!isBringOwn) {
      const check = canPlace(units, candidate, availBySession, hourStartTimes);
      if (!check.ok) {
        toast.show(`${shortBoardName(eq.name)} ${check.hour} 已經租完了`, { type: 'error' });
        return;
      }
    }

    onChangeUnits([...units, candidate]);
  };

  // Remove the LAST unit of equipment
  const handleRemoveBoard = (eqId) => {
    const revIdx = [...units].reverse().findIndex((u) => u.equipment_id === eqId);
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

  const handleUnitTimeCommit = (uid, newFrom, newTo) => {
    const target = units.find((u) => u.uid === uid);
    if (!target) return;
    const eqId = target.equipment_id;
    if (eqId === 'bring_own') return;
    const cfg = configsMap[eqId];

    const candidate = { ...target, from: newFrom, to: newTo };
    const check = canPlace(
      units.filter((u) => u.uid !== uid),
      candidate,
      availBySession,
      hourStartTimes
    );
    if (!check.ok) {
      toast.show(`${shortBoardName(cfg?.name || '')} ${check.hour} 已經租完了`, { type: 'error' });
      onChangeUnits(
        units.map((u) => (u.uid === uid ? { ...u, from: target.from, to: target.to } : u))
      );
    }
  };

  // Calculate pricing
  const hourly = dayPricing?.hourly;
  const cap = dayPricing?.cap;
  const allowUnlimited = dayPricing?.allowUnlimited ?? true;

  const seatCalc = useMemo(() => {
    if (!dayPricing) return { raw: 0, total: 0, capSaving: 0, isCapped: false };
    return seatPrice({
      pax,
      hours: H,
      hourly,
      cap,
      allowUnlimited,
      mode,
    });
  }, [dayPricing, pax, H, hourly, cap, allowUnlimited, mode]);

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
  const dateFormatted = formatDateShort(date);
  const summaryTimeText = mode === 'unlimited' ? `${timeDesc} · 不限時` : timeDesc;

  return (
    <>
      {/* 1. Step Indicator */}
      <StepIndicator currentStep="人數" />

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

      {globalError && !hasPricing ? (
        <EmptyState
          title="暫時抓不到價格"
          description="請檢查網路後重新整理"
          action={<Button size="sm" onClick={onReloadPricing}>重新整理</Button>}
        />
      ) : (
        <>
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
      {sortedEquipmentConfigs.length > 0 && (
        <Card gap={12}>
          <div>
            <div className="text-[15px] font-bold">智能拼豆板（選租）</div>
            <div className="sg-small">
              {allowExceedPax
                ? '只有需要的人租就好，可以分段租不同尺寸'
                : `只有需要的人租就好，同一時間最多 ${pax} 台；可以分段租不同尺寸`}
            </div>
          </div>

          <div className="grid gap-3">
            {sortedEquipmentConfigs.map((eq, idx) => {
              const eqId = eq.equipment_id || eq.id;
              const isMaintenance = eq.visibility_status === 'MAINTENANCE';
              const maintenanceNote = eq.status_note
                ? eq.status_note.replace(/^[\p{Extended_Pictographic}️\s]+/u, '')
                : '維護中，暫停借用';
              const eqUnits = units.filter((u) => u.equipment_id === eqId);
              const count = eqUnits.length;
              const isBringOwn = eqId === 'bring_own';

              // Stock remaining
              let stockRemaining = 99;
              if (!isBringOwn && availBySession[eqId]) {
                const hoursAvail = hourStartTimes.map(
                  (t) => availBySession[eqId][t] ?? 0
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

              const candWin = getCandidateWindow(eq);
              const canAdd = !isMaintenance && candWin.canAdd && (isBringOwn || stockRemaining > 0);
              const disableReason = !candWin.canAdd ? candWin.reason : (stockRemaining <= 0 ? '已租完' : '');

              return (
                <div key={eqId} className="grid gap-2">
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
                            {disableReason && (
                              <span className="text-sg-muted ml-1.5 font-bold"> · {disableReason}</span>
                            )}
                          </>
                        )}
                      </div>
                    </div>

                    <Stepper
                      value={count}
                      min={0}
                      max={99}
                      disabledMinus={count <= 0}
                      disabledPlus={!canAdd}
                      onMinus={() => handleRemoveBoard(eqId)}
                      onPlus={() => handleAddBoard(eq)}
                      label={displayName}
                    />
                  </div>

                  {/* BoardTimeBoxes for this board */}
                  {eqUnits.map((u, uIdx) => {
                    const otherUnits = units.filter((o) => o.uid !== u.uid && o.equipment_id !== 'bring_own');
                    const blockedSlots = [];
                    for (let k = 0; k < H; k++) {
                      if (!allowExceedPax && otherUnits.filter((o) => o.from <= k && k < o.to).length >= pax) {
                        blockedSlots.push(k);
                      }
                    }
                    let boundStart = 0;
                    let boundEnd = H;
                    for (const b of blockedSlots) {
                      if (b < u.from) boundStart = Math.max(boundStart, b + 1);
                      if (b >= u.to) boundEnd = Math.min(boundEnd, b);
                    }

                    return (
                      <BoardTimeBox
                        key={u.uid}
                        unit={u}
                        config={eq}
                        boardIndex={uIdx + 1}
                        totalHours={H}
                        boundStart={boundStart}
                        boundEnd={boundEnd}
                        blockedSlots={blockedSlots}
                        boundaryTimes={[...bookingSessions.map((s) => s.start_time), bookingSessions[H - 1]?.end_time]}
                        bookingSessions={bookingSessions}
                        onChange={(newFrom, newTo) => handleUnitTimeChange(u.uid, newFrom, newTo)}
                        onCommit={(newFrom, newTo) => handleUnitTimeCommit(u.uid, newFrom, newTo)}
                      />
                    );
                  })}
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
        </>
      )}

      {/* Bottom bar */}
      <div className="sticky bottom-0 z-40 -mx-4 -mb-5 mt-auto">
        <BottomActionBar
          summary={actionSummary}
          price={hasPricing && dayPricing ? totalPrice : null}
          actionLabel="下一步"
          disabled={!hasPricing || !dayPricing}
          onAction={onNext}
          hasTabBarBelow={false}
        />
      </div>
    </>
  );
}
