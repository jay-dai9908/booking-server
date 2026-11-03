import React, { useState, useEffect, useMemo } from 'react';
import CustomerLayout from '../../components/customer/CustomerLayout';
import AppBar from '../../components/customer/AppBar';
import Pill from '../../components/customer/Pill';
import Button from '../../components/customer/Button';
import MonthBar from '../../components/customer/MonthBar';
import DateStrip from '../../components/customer/DateStrip';
import MonthCalendar from '../../components/customer/MonthCalendar';
import PriceCard from '../../components/customer/PriceCard';
import SlotGrid, { SlotCell } from '../../components/customer/SlotGrid';
import Skeleton from '../../components/customer/Skeleton';
import EmptyState from '../../components/customer/EmptyState';
import { InfoBanner } from '../../components/customer/Banners';
import PriceInfoSheet from '../../components/customer/sheets/PriceInfoSheet';
import { initiateLineOAuth } from '../../utils/lineAuth';
import { useGlobalSettings } from '../../hooks/customer/useGlobalSettings';
import { useDayPricing } from '../../hooks/customer/useDayPricing';
import { useSessions, useSessionRange, BOOKING_LOOKAHEAD_DAYS } from '../../hooks/customer/useSessions';
import { slotState, meterBeads, dayState } from '../../utils/customer/availability';
import { parseYMD } from '../../utils/customer/pricing';
import api from '../../api/axios';

function getTodayString() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function getEndDateString(daysAhead) {
  const target = new Date();
  target.setDate(target.getDate() + daysAhead);
  const y = target.getFullYear();
  const m = String(target.getMonth() + 1).padStart(2, '0');
  const d = String(target.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export default function Preview() {
  const todayStr = useMemo(() => getTodayString(), []);
  const lookaheadEndStr = useMemo(() => getEndDateString(BOOKING_LOOKAHEAD_DAYS - 1), []);

  const [date, setDate] = useState(todayStr);
  const [isMonthExpanded, setIsMonthExpanded] = useState(false);
  const [calendarMonth, setCalendarMonth] = useState(() => parseYMD(todayStr));
  const [isPriceInfoOpen, setIsPriceInfoOpen] = useState(false);

  const {
    settings: globalSettings,
    loading: globalLoading,
    error: globalError,
    reload: reloadGlobalSettings,
    hasPricing,
  } = useGlobalSettings();
  const { dayPricing } = useDayPricing(date, globalSettings);
  const { sessions, loading: sessionsLoading } = useSessions(date, { autoRefresh: true });
  const { sessionsByDate } = useSessionRange(todayStr, lookaheadEndStr);

  const [equipmentConfigs, setEquipmentConfigs] = useState([]);

  useEffect(() => {
    api.get(`/equipment/availability?date=${date}`)
      .then((res) => {
        setEquipmentConfigs(res.data?.equipments || []);
      })
      .catch(() => {});
  }, [date]);

  const isPreviewEnabled = globalSettings?.enable_preview_page !== false;
  const previewDisabledText = globalSettings?.preview_disabled_text || '時段預覽暫停開放';

  const sortedSessions = useMemo(() => {
    return [...sessions].sort((a, b) => a.start_time.localeCompare(b.start_time));
  }, [sessions]);

  const currentDayState = useMemo(() => {
    return dayState(date, sortedSessions, new Date());
  }, [date, sortedSessions]);

  const isClosed = currentDayState === 'closed';

  const handleLogin = () => {
    initiateLineOAuth({ returnPath: '/booking' });
  };

  return (
    <CustomerLayout
      header={
        <AppBar
          variant="brandTwoLine"
          title="拾光製所"
          right={<Pill variant="full">未登入</Pill>}
        />
      }
      bottom={
        <div className="bg-sg-paper border-t border-sg-line px-4 pt-3 pb-[max(18px,env(safe-area-inset-bottom))]">
          <Button
            variant="line"
            size="md"
            onClick={handleLogin}
            className="w-full"
          >
            使用 LINE 登入預約
          </Button>
        </div>
      }
    >
      <div className="flex flex-col min-h-[calc(100dvh-53px)]">
        <div className="grid gap-3 flex-1 pb-4">
          {!isPreviewEnabled ? (
            <EmptyState
              title="時段預覽暫停開放"
              description={previewDisabledText}
            />
          ) : (
            <>
              {/* 1. Info Banner */}
              <InfoBanner message="先看看空位，登入後就能直接選時段" />

              {/* 2. MonthBar + DateStrip / MonthCalendar */}
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
                    setDate(newDate);
                    setIsMonthExpanded(false);
                  }}
                />
              ) : (
                <DateStrip
                  selectedDate={date}
                  sessionsByDate={sessionsByDate}
                  onSelectDate={setDate}
                />
              )}

              {/* 3. Compact PriceCard */}
              {globalError && !hasPricing ? (
                <EmptyState
                  title="暫時抓不到價格"
                  description="請檢查網路後重新整理"
                  action={<Button size="sm" onClick={reloadGlobalSettings}>重新整理</Button>}
                />
              ) : !hasPricing || !dayPricing ? (
                <Skeleton className="h-[96px] w-full rounded-[18px]" />
              ) : (
                <PriceCard
                  variant="compact"
                  selectedDate={date}
                  dayPricing={dayPricing}
                  globalSettings={globalSettings}
                  onOpenPriceInfo={() => setIsPriceInfoOpen(true)}
                />
              )}

              {/* 4. SlotGrid (readOnly) */}
              {isClosed ? (
                <EmptyState
                  title="這天沒有開放"
                  description="可以選有色條的其他日子"
                />
              ) : sessionsLoading ? (
                <div className="grid grid-cols-3 gap-2">
                  {Array.from({ length: 9 }).map((_, i) => (
                    <Skeleton key={i} className="min-h-[76px]" />
                  ))}
                </div>
              ) : sortedSessions.length > 0 ? (
                <SlotGrid>
                  {sortedSessions.map((s) => {
                    const state = slotState(date, s, new Date());
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
                        isSelected={false}
                        readOnly={true}
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
            </>
          )}
        </div>
      </div>

      <PriceInfoSheet
        isOpen={isPriceInfoOpen}
        onClose={() => setIsPriceInfoOpen(false)}
        globalSettings={globalSettings}
        dayPricing={dayPricing}
        dateStr={date}
        equipmentConfigs={equipmentConfigs}
        error={globalError}
        onReload={reloadGlobalSettings}
      />
    </CustomerLayout>
  );
}
