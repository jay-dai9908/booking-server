import React, { useState, useMemo, useEffect, useRef } from 'react';
import { AnnouncementBar, SaveBanner, NoticeBox } from '../../../components/customer/Banners';
import StepIndicator from '../../../components/customer/StepIndicator';
import MonthBar from '../../../components/customer/MonthBar';
import DateStrip from '../../../components/customer/DateStrip';
import MonthCalendar from '../../../components/customer/MonthCalendar';
import PlanCards from '../../../components/customer/PlanCards';
import SlotGrid, { SlotCell } from '../../../components/customer/SlotGrid';
import HourChips from '../../../components/customer/HourChips';
import Pill from '../../../components/customer/Pill';
import Skeleton from '../../../components/customer/Skeleton';
import EmptyState from '../../../components/customer/EmptyState';
import BottomActionBar from '../../../components/customer/BottomActionBar';
import BottomTabBar from '../../../components/customer/BottomTabBar';
import PriceInfoSheet from '../../../components/customer/sheets/PriceInfoSheet';
import { useToast } from '../../../components/customer/Toast';
import {
  parseYMD,
  unlimitedThresholdHours,
  seatPrice,
  DAY_PRICE_LABEL,
} from '../../../utils/customer/pricing';
import {
  isSessionPast,
  slotState,
  meterBeads,
  dayState,
} from '../../../utils/customer/availability';
import { tapSlot, buildUnlimitedOptions } from '../../../utils/customer/selection';
import { formatDateShort, formatMoney, formatTimeRange } from '../../../utils/customer/format';

export default function StepSelectTime({
  date,
  onChangeDate,
  mode,
  onChangeMode,
  sel,
  onChangeSel,
  arrival,
  onChangeArrival,
  leave,
  onChangeLeave,
  pax = 1,
  globalSettings,
  dayPricing,
  sessions = [],
  sessionsLoading = false,
  sessionsByDate = {},
  equipmentConfigs = [],
  onNext,
  userRole = 'customer',
}) {
  const toast = useToast();
  const [isMonthExpanded, setIsMonthExpanded] = useState(false);
  const [calendarMonth, setCalendarMonth] = useState(() => (date ? parseYMD(date) : new Date()));
  const [isPriceInfoOpen, setIsPriceInfoOpen] = useState(false);
  const dateStripRef = useRef(null);

  // Sync calendar month when date changes
  useEffect(() => {
    if (date) {
      setCalendarMonth(parseYMD(date));
    }
  }, [date]);

  // Pricing values
  const hourly = dayPricing?.hourly ?? 100;
  const cap = dayPricing?.cap ?? 550;
  const allowUnlimited = dayPricing?.allowUnlimited ?? true;
  const dayType = dayPricing?.dayType ?? 'weekday';
  const N = useMemo(() => unlimitedThresholdHours({ hourly, cap }), [hourly, cap]);

  // If selected date does not allow unlimited mode, fallback to timed
  useEffect(() => {
    if (!allowUnlimited && mode === 'unlimited') {
      onChangeMode('timed');
      toast.show('這天不開放當日不限時暢玩，已改成計時', { type: 'info' });
    }
  }, [allowUnlimited, mode, onChangeMode, toast]);

  // Today string
  const todayStr = useMemo(() => {
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    const d = String(now.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }, []);

  const isSelectedDateToday = date === todayStr;

  // Sorted sessions for selected date
  const sortedSessions = useMemo(() => {
    return [...sessions].sort((a, b) => a.start_time.localeCompare(b.start_time));
  }, [sessions]);

  const hasSessions = sortedSessions.length > 0;

  // Usable and linked helpers for selection
  const usable = (idx) => {
    if (idx < 0 || idx >= sortedSessions.length) return false;
    const s = sortedSessions[idx];
    const state = slotState(date, s, new Date());
    return state !== 'full' && state !== 'past';
  };

  const linked = (idx) => {
    if (idx < 0 || idx >= sortedSessions.length - 1) return false;
    return sortedSessions[idx].end_time === sortedSessions[idx + 1].start_time;
  };

  const isPast = (idx) => {
    if (idx < 0 || idx >= sortedSessions.length) return true;
    return isSessionPast(date, sortedSessions[idx], new Date());
  };

  // Options for unlimited mode
  const unlimitedOptions = useMemo(() => {
    if (!hasSessions || !allowUnlimited) return { arrivals: [], leavesFor: () => [] };
    return buildUnlimitedOptions(sortedSessions, { N, usable, linked, isPast });
  }, [sortedSessions, N, hasSessions, allowUnlimited]);

  // Default selection for unlimited if not set or invalid
  useEffect(() => {
    if (mode !== 'unlimited' || !allowUnlimited || !unlimitedOptions.arrivals.length) return;

    // Check if arrival is valid
    const validArrivals = unlimitedOptions.arrivals.filter((a) => a.enabled);
    if (!validArrivals.length) return;

    let curArrival = arrival;
    if (curArrival == null || !validArrivals.some((a) => a.index === curArrival)) {
      curArrival = validArrivals[0].index;
      onChangeArrival(curArrival);
    }

    // Check leave
    const leaves = unlimitedOptions.leavesFor(curArrival);
    const validLeaves = leaves.filter((l) => l.enabled);
    if (validLeaves.length > 0) {
      if (leave == null || !validLeaves.some((l) => l.endIndex === leave)) {
        // default to latest valid leave
        const defaultLeave = validLeaves[validLeaves.length - 1].endIndex;
        onChangeLeave(defaultLeave);
      }
    }
  }, [mode, allowUnlimited, unlimitedOptions, arrival, leave, onChangeArrival, onChangeLeave]);

  // Slot click handler for timed mode
  const handleSlotClick = (idx) => {
    const s = sortedSessions[idx];
    const state = slotState(date, s, new Date());
    if (state === 'full') {
      toast.show('這個時段已額滿', { type: 'info' });
      return;
    }
    if (state === 'past') {
      toast.show('這個時段已經開始了', { type: 'info' });
      return;
    }

    const res = tapSlot(sel, idx, { usable, linked });
    onChangeSel(res.sel);
  };

  // Switch mode handler
  const handleModeChange = (newMode) => {
    if (newMode === 'unlimited' && !allowUnlimited) {
      toast.show('這天不開放當日不限時暢玩', { type: 'info' });
      return;
    }
    if (newMode === mode) return;

    if (newMode === 'unlimited') {
      // Transition from timed -> unlimited: arrival from sel.start
      if (sel) {
        const candidateArrival = sel.start;
        const validArrivals = unlimitedOptions.arrivals.filter((a) => a.enabled);
        if (validArrivals.some((a) => a.index === candidateArrival)) {
          onChangeArrival(candidateArrival);
          const leaves = unlimitedOptions.leavesFor(candidateArrival).filter((l) => l.enabled);
          if (leaves.length) onChangeLeave(leaves[leaves.length - 1].endIndex);
        }
      }
    } else {
      // Transition from unlimited -> timed: sel from arrival to leave - 1
      if (arrival != null && leave != null && leave > arrival) {
        onChangeSel({ start: arrival, end: leave - 1 });
      }
    }
    onChangeMode(newMode);
  };

  // Calculate pricing & bottom action bar values
  const timedHours = sel ? sel.end - sel.start + 1 : 0;
  const seatCalc = useMemo(() => {
    if (mode === 'timed') {
      return seatPrice({
        pax,
        hours: timedHours,
        hourly,
        cap,
        allowUnlimited,
        mode: 'timed',
      });
    } else {
      return seatPrice({
        pax,
        hours: leave != null && arrival != null ? leave - arrival : 0,
        hourly,
        cap,
        allowUnlimited,
        mode: 'unlimited',
      });
    }
  }, [mode, pax, timedHours, hourly, cap, allowUnlimited, arrival, leave]);

  // Bottom action bar summary and prices
  let canProceed = false;
  let actionSummary = '';
  let strikePrice = null;
  let finalPrice = 0;

  if (mode === 'timed' && sel) {
    canProceed = true;
    const startStr = sortedSessions[sel.start]?.start_time || '';
    const endStr = sortedSessions[sel.end]?.end_time || '';
    const paxPart = pax > 1 ? ` · ${pax} 位` : '';
    actionSummary = `${startStr} 到 ${endStr} · ${timedHours} 小時${paxPart}`;
    finalPrice = seatCalc.total;
    if (seatCalc.isCapped && seatCalc.capSaving > 0) {
      strikePrice = seatCalc.raw;
    }
  } else if (mode === 'unlimited' && arrival != null && leave != null) {
    canProceed = true;
    const startStr = sortedSessions[arrival]?.start_time || '';
    const endStr = sortedSessions[leave - 1]?.end_time || '';
    const paxPart = pax > 1 ? ` · ${pax} 位` : '';
    actionSummary = `${startStr} 到 ${endStr} · 不限時${paxPart}`;
    finalPrice = seatCalc.total;
  }

  // Selected date status
  const currentDayState = useMemo(() => {
    return dayState(date, sortedSessions, new Date());
  }, [date, sortedSessions]);

  const isClosed = currentDayState === 'closed';

  // Subtitle explanation text for unlimited mode
  const unlimitedRuleLine1 = useMemo(() => {
    const dayPrefix = isSelectedDateToday ? '今天' : '這天';
    const typeLabel = dayType === 'special' ? '' : dayType === 'weekend' ? '假日' : '平日';
    return `${dayPrefix}${typeLabel}每小時 NT$${hourly}，玩滿 ${N} 小時才會超過不限時價 NT$${cap}`;
  }, [isSelectedDateToday, dayType, hourly, N, cap]);

  // Unlimited availability pill status
  const unlimitedPillStatus = useMemo(() => {
    if (arrival == null || leave == null || leave <= arrival) return null;
    const selectedSess = sortedSessions.slice(arrival, leave);
    if (!selectedSess.length) return null;
    const allGood = selectedSess.every((s) => s.remaining_capacity / s.max_capacity >= 0.5);
    const startStr = selectedSess[0].start_time;
    const endStr = selectedSess[selectedSess.length - 1].end_time;
    return {
      variant: allGood ? 'ok' : 'low',
      text: allGood ? `${startStr} 到 ${endStr} 都有空位` : `${startStr} 到 ${endStr} 名額不多`,
    };
  }, [arrival, leave, sortedSessions]);

  return (
    <>
      {/* 1. Announcement bar */}
      {globalSettings?.show_announcement && globalSettings?.announcement_text && (
        <AnnouncementBar text={globalSettings.announcement_text} />
      )}

      {/* 2. Step Indicator */}
      <StepIndicator currentStep="時段" />

      {/* 3. Month & Date Selection */}
      <MonthBar
        selectedDate={date}
        isExpanded={isMonthExpanded}
        onToggleExpand={() => setIsMonthExpanded((prev) => !prev)}
        calendarMonth={calendarMonth}
        onChangeCalendarMonth={setCalendarMonth}
      />

      {isMonthExpanded ? (
        <MonthCalendar
          selectedDate={date}
          currentMonth={calendarMonth}
          sessionsByDate={sessionsByDate}
          onSelectDate={(newDate) => {
            onChangeDate(newDate);
            setIsMonthExpanded(false);
          }}
        />
      ) : (
        <DateStrip
          ref={dateStripRef}
          selectedDate={date}
          sessionsByDate={sessionsByDate}
          onSelectDate={onChangeDate}
        />
      )}

      {/* 4. Plan Selection or Closed state */}
      {isClosed ? (
        <EmptyState
          title="這天沒有開放"
          description="可以選有色條的其他日子"
        />
      ) : (
        <>
          <PlanCards
            mode={mode}
            onChangeMode={handleModeChange}
            hourlyPrice={hourly}
            unlimitedPrice={cap}
            allowUnlimited={allowUnlimited}
            dateStr={date}
            dayPricing={dayPricing}
            onOpenPriceInfo={() => setIsPriceInfoOpen(true)}
          />

          {/* 5. Timed Mode content */}
          {mode === 'timed' && (
            <div className="grid gap-2">
              <div className="sg-small -mb-1">
                每一格是 1 小時，可以連續選多格
              </div>

              {sessionsLoading ? (
                <div className="grid grid-cols-3 gap-2">
                  {Array.from({ length: 9 }).map((_, i) => (
                    <Skeleton key={i} className="min-h-[76px]" />
                  ))}
                </div>
              ) : hasSessions ? (
                <SlotGrid>
                  {sortedSessions.map((s, idx) => {
                    const state = slotState(date, s, new Date());
                    const isSelected = !!sel && idx >= sel.start && idx <= sel.end;
                    const beads = meterBeads(s.remaining_capacity, s.max_capacity);
                    return (
                      <SlotCell
                        key={s.session_id || s.id || s.start_time}
                        session={s}
                        startTime={s.start_time}
                        endTime={s.end_time}
                        remaining={s.remaining_capacity}
                        maxCapacity={s.max_capacity}
                        state={state}
                        beads={beads}
                        isSelected={isSelected}
                        onClick={() => handleSlotClick(idx)}
                      />
                    );
                  })}
                </SlotGrid>
              ) : (
                <EmptyState
                  title="這天沒有時段"
                  description="請選擇其他開放的日期"
                />
              )}

              {seatCalc.isCapped && seatCalc.capSaving > 0 && (
                <SaveBanner
                  message={`已達當日不限時暢玩價：每人最高只收 NT$${cap}`}
                />
              )}
            </div>
          )}

          {/* 6. Unlimited Mode content */}
          {mode === 'unlimited' && (
            <div className="grid gap-3">
              <NoticeBox>
                <span><b>當日不限時暢玩封頂價格，</b>中途可離場，我們會為您保留座位。</span>
              </NoticeBox>

              {unlimitedOptions.arrivals.length === 0 ? (
                <EmptyState
                  title={`這天剩下的時間不夠玩滿 ${N} 小時`}
                  description="可以改用計時，玩幾小時算幾小時"
                  actionLabel="改用計時"
                  onAction={() => handleModeChange('timed')}
                />
              ) : (
                <>
                  <div className="grid gap-[6px]">
                    <div className="text-[14px] font-bold">預計幾點到？</div>
                    <HourChips
                      options={unlimitedOptions.arrivals.map((a) => ({
                        time: a.time,
                        value: a.index,
                        disabled: !a.enabled,
                      }))}
                      selectedValue={arrival}
                      onSelect={(val) => {
                        onChangeArrival(val);
                        // Adjust leave if necessary
                        const leaves = unlimitedOptions.leavesFor(val).filter((l) => l.enabled);
                        if (leaves.length && (!leave || !leaves.some((l) => l.endIndex === leave))) {
                          onChangeLeave(leaves[leaves.length - 1].endIndex);
                        }
                      }}
                    />
                  </div>

                  {arrival != null && (
                    <div className="grid gap-[6px]">
                      <div className="text-[14px] font-bold">預計幾點離開？</div>
                      <HourChips
                        options={unlimitedOptions.leavesFor(arrival).map((l) => ({
                          time: l.isClosing ? `玩到打烊 ${l.time}` : l.time,
                          value: l.endIndex,
                          disabled: !l.enabled,
                          isWide: l.isClosing,
                        }))}
                        selectedValue={leave}
                        onSelect={onChangeLeave}
                      />
                      <div className="sg-small mt-1">
                        <div>{unlimitedRuleLine1}</div>
                        <div>未滿 {N} 小時請選「計時」。</div>
                      </div>
                    </div>
                  )}

                  {unlimitedPillStatus && (
                    <div className="flex justify-center mt-1">
                      <Pill variant={unlimitedPillStatus.variant}>
                        {unlimitedPillStatus.text}
                      </Pill>
                    </div>
                  )}
                </>
              )}
            </div>
          )}
        </>
      )}

      {/* Bottom bar & Bottom tabs */}
      {(canProceed || userRole === 'customer') && (
        <div className="sticky bottom-0 z-40">
          {canProceed && (
            <BottomActionBar
              summary={actionSummary}
              price={finalPrice}
              strikePrice={strikePrice}
              actionLabel="下一步"
              onAction={onNext}
              hasTabBarBelow={userRole === 'customer'}
            />
          )}
          {userRole === 'customer' && (
            <BottomTabBar
              shopEnabled={globalSettings?.shop_enabled !== false && globalSettings?.show_shop_button !== false}
            />
          )}
        </div>
      )}

      {/* Price Info Sheet */}
      <PriceInfoSheet
        isOpen={isPriceInfoOpen}
        onClose={() => setIsPriceInfoOpen(false)}
        globalSettings={globalSettings}
        dayPricing={dayPricing}
        dateStr={date}
        equipmentConfigs={equipmentConfigs}
      />
    </>
  );
}
