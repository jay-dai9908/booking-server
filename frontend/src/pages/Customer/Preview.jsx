import React, { useState, useEffect, useMemo, useRef } from 'react';
import { Grid, Sparkles } from 'lucide-react';
import CustomerLayout from '../../components/customer/CustomerLayout';
import AppBar from '../../components/customer/AppBar';
import Pill from '../../components/customer/Pill';
import Button from '../../components/customer/Button';
import { Card } from '../../components/customer/Card';
import MonthBar from '../../components/customer/MonthBar';
import DateStrip from '../../components/customer/DateStrip';
import MonthCalendar from '../../components/customer/MonthCalendar';
import PriceCard from '../../components/customer/PriceCard';
import SlotGrid, { SlotCell } from '../../components/customer/SlotGrid';
import Skeleton from '../../components/customer/Skeleton';
import EmptyState from '../../components/customer/EmptyState';
import { AnnouncementBar } from '../../components/customer/Banners';
import PriceInfoSheet from '../../components/customer/sheets/PriceInfoSheet';
import GuestLineLoginButton from '../../components/customer/GuestLineLoginButton';
import { useGlobalSettings } from '../../hooks/customer/useGlobalSettings';
import { useDayPricing } from '../../hooks/customer/useDayPricing';
import { useSessions, useSessionRange, BOOKING_LOOKAHEAD_DAYS } from '../../hooks/customer/useSessions';
import { slotState, meterBeads, dayState } from '../../utils/customer/availability';
import { parseYMD, buildDiscountConfig } from '../../utils/customer/pricing';
import { boardDiscountTexts } from '../../utils/customer/discountText';
import { formatMoney } from '../../utils/customer/format';
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
  const [equipmentConfigs, setEquipmentConfigs] = useState([]);
  const [equipmentsLoaded, setEquipmentsLoaded] = useState(false);

  const dateSectionRef = useRef(null);
  const monthBarRef = useRef(null);

  const {
    settings: globalSettings,
    loading: globalLoading,
    error: globalError,
    reload: reloadGlobalSettings,
    hasPricing,
  } = useGlobalSettings();

  const { dayPricing: todayPricing } = useDayPricing(todayStr, globalSettings);
  const { dayPricing: selectedDayPricing } = useDayPricing(date, globalSettings);
  const { sessions, loading: sessionsLoading } = useSessions(date, { autoRefresh: true });
  const { sessionsByDate } = useSessionRange(todayStr, lookaheadEndStr);

  useEffect(() => {
    api.get(`/equipment/availability?date=${date}`)
      .then((res) => {
        setEquipmentConfigs(res.data?.equipments || []);
        setEquipmentsLoaded(true);
      })
      .catch(() => {
        setEquipmentsLoaded(true);
      });
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

  // Discount config & text
  const discountConfig = useMemo(() => buildDiscountConfig(globalSettings || {}), [globalSettings]);
  const discountTexts = useMemo(() => (hasPricing ? boardDiscountTexts(discountConfig) : null), [hasPricing, discountConfig]);

  // Min hourly rate for smart boards
  const minBoardRate = useMemo(() => {
    const active = equipmentConfigs.filter((e) => e.visibility_status === 'ACTIVE' && e.id !== 'bring_own');
    if (!active.length) return null;
    return Math.min(...active.map((e) => e.hourly_rate));
  }, [equipmentConfigs]);

  const smartBoardSubtext = useMemo(() => {
    if (!hasPricing) {
      return <Skeleton className="h-4 w-32 rounded inline-block" />;
    }
    if (discountTexts) {
      return discountTexts.home;
    }
    if (minBoardRate != null) {
      return `每小時 ${formatMoney(minBoardRate)} 起`;
    }
    if (!equipmentsLoaded) {
      return <Skeleton className="h-4 w-28 rounded inline-block" />;
    }
    return null;
  }, [hasPricing, discountTexts, minBoardRate, equipmentsLoaded]);

  const handleScrollToDateSection = () => {
    const targetEl = monthBarRef.current || dateSectionRef.current;
    if (targetEl) {
      const headerEl = document.querySelector('header');
      const headerHeight = headerEl ? headerEl.offsetHeight : 53;
      const elementTop = targetEl.getBoundingClientRect().top;
      const targetScrollY = elementTop + window.pageYOffset - headerHeight;
      window.scrollTo({
        top: Math.max(0, Math.round(targetScrollY)),
        behavior: 'smooth',
      });
    }
  };

  return (
    <CustomerLayout
      header={
        <AppBar
          variant="brandTwoLine"
          subtitle="拼豆時段預覽"
          right={<Pill variant="full">未登入</Pill>}
        />
      }
    >
      <div className="flex flex-col min-h-[calc(100dvh-53px)]">
        <div className="grid grid-cols-[minmax(0,1fr)] gap-3 flex-1 px-4 pt-3 pb-8">
          {!isPreviewEnabled ? (
            <EmptyState
              title="時段預覽暫停開放"
              description={previewDisabledText}
            />
          ) : (
            <>
              {/* 1. 公告 */}
              {globalSettings?.show_announcement && globalSettings?.announcement_text && (
                <AnnouncementBar text={globalSettings.announcement_text} />
              )}

              {/* 2. 價格卡：今天、平日或假日、計時價、不限時價、「看假日價格」 */}
              {globalError && !hasPricing ? (
                <EmptyState
                  title="暫時抓不到價格"
                  description="請檢查網路後重新整理"
                  action={<Button size="sm" onClick={reloadGlobalSettings}>重新整理</Button>}
                />
              ) : !hasPricing || !todayPricing ? (
                <Skeleton className="h-[150px] w-full" />
              ) : (
                <PriceCard
                  variant="full"
                  selectedDate={todayStr}
                  dayPricing={todayPricing}
                  globalSettings={globalSettings}
                  onOpenPriceInfo={() => setIsPriceInfoOpen(true)}
                />
              )}

              {/* 3. 特色卡片：「不限板，不限量…」「智能拼豆板可加租」 */}
              <Card gap={12}>
                <div className="flex items-center gap-2">
                  <Grid className="w-[18px] h-[18px] text-sg-brown shrink-0" />
                  <div className="text-[14px] font-bold text-sg-ink">
                    不限板，不限量，時間內任你拼
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <Sparkles className="w-[18px] h-[18px] text-sg-brown shrink-0" />
                  <div>
                    <div className="text-[14px] font-bold text-sg-ink">
                      智能拼豆板可加租
                    </div>
                    {smartBoardSubtext && (
                      <div className="sg-small">
                        {smartBoardSubtext}
                      </div>
                    )}
                  </div>
                </div>
              </Card>

              {/* 4. 主按鈕「加入官方 LINE 預約」，下面是說明文字 */}
              <div className="pt-1">
                <GuestLineLoginButton
                  page="preview"
                  globalSettings={globalSettings}
                  returnPath="/booking"
                />
              </div>

              {/* 5. 次要按鈕「先看看空位」 */}
              <Button
                variant="secondary"
                size="sm"
                onClick={handleScrollToDateSection}
                className="w-full"
                data-testid="preview-scroll-to-slots-button"
              >
                先看看空位
              </Button>

              {/* 日期列和時段格（放在下方） */}
              <div
                ref={dateSectionRef}
                className="pt-2 flex flex-col gap-3 min-w-0 min-h-[calc(100dvh-53px)] scroll-mt-16"
                data-testid="preview-date-section"
              >
                <div ref={monthBarRef}>
                  <MonthBar
                    selectedDate={date}
                    isExpanded={isMonthExpanded}
                    onToggleExpand={() => setIsMonthExpanded((prev) => !prev)}
                    calendarMonth={calendarMonth}
                    onChangeCalendarMonth={setCalendarMonth}
                  />
                </div>

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

                {/* Compact PriceCard: only show when selected date is not today */}
                {date !== todayStr && (
                  globalError && !hasPricing ? null : !hasPricing || !selectedDayPricing ? (
                    <Skeleton className="h-[96px] w-full rounded-[18px]" />
                  ) : (
                    <PriceCard
                      variant="compact"
                      selectedDate={date}
                      dayPricing={selectedDayPricing}
                      globalSettings={globalSettings}
                      onOpenPriceInfo={() => setIsPriceInfoOpen(true)}
                    />
                  )
                )}

                {/* SlotGrid (readOnly) */}
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
              </div>
            </>
          )}
        </div>
      </div>

      <PriceInfoSheet
        isOpen={isPriceInfoOpen}
        onClose={() => setIsPriceInfoOpen(false)}
        globalSettings={globalSettings}
        dayPricing={selectedDayPricing}
        dateStr={date}
        equipmentConfigs={equipmentConfigs}
        error={globalError}
        onReload={reloadGlobalSettings}
      />
    </CustomerLayout>
  );
}
