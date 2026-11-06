import React, { useState, useEffect, useRef, useMemo } from 'react';
import {
  Users,
  Clock,
  Sparkles,
  AlertTriangle,
  Play,
  Pause,
  RotateCcw,
  CheckCircle2,
  X,
  Plus,
  MoreVertical,
  ChevronRight,
  ChevronDown,
  Info,
  Calendar,
  Layers,
  ArrowRightLeft,
  Ticket
} from 'lucide-react';
import api from '../../api/axios';
import { useLiveFloor } from '../../hooks/admin/useLiveFloor';
import { useServerClock } from '../../hooks/admin/useServerClock';
import SegmentedTabs from '../../components/admin/SegmentedTabs';
import StatusPill from '../../components/admin/StatusPill';
import ResponsivePanel from '../../components/admin/ResponsivePanel';
import ReasonChips from '../../components/admin/ReasonChips';
import MoneyInput from '../../components/admin/MoneyInput';
import ConfirmPanel from '../../components/admin/ConfirmPanel';
import Button from '../../components/customer/Button';

// Floor components
import FloorPlan from '../../components/admin/floor/FloorPlan';
import MiniMap from '../../components/admin/floor/MiniMap';
import TableCard from '../../components/admin/floor/TableCard';
import TimelineGrid from '../../components/admin/floor/TimelineGrid';

// Modals
import CheckoutWorkbench from '../../components/admin/checkout/CheckoutWorkbench';
import ReservationDetailsModal from '../../components/ReservationDetailsModal';
import ForceAddModal from '../../components/ForceAddModal';
import EquipmentAddonModal from '../../components/EquipmentAddonModal';
import ExtendTimeModal from '../../components/ExtendTimeModal';
import SendLineMessageModal from '../../components/SendLineMessageModal';

import { swapBoundaryOptions, formatTimerHMM, blocksBy1030, formatTimeHHmm } from '@shared/time.js';
import { calculateBoardTotal } from '@shared/boardPricing.js';
import { displayBoardName } from '@shared/billing.js';

export default function SeatingPage() {
  // Navigation & Tabs
  const [activeTab, setActiveTab] = useState(() => {
    const saved = localStorage.getItem('shiguang_seating_tab');
    if (saved) return saved;
    return typeof window !== 'undefined' && window.innerWidth >= 768 ? 'floor' : 'list';
  });

  const handleTabChange = (tab) => {
    setActiveTab(tab);
    localStorage.setItem('shiguang_seating_tab', tab);
  };

  // Filter chips: 'all' | 'alert' | 'pending' | 'empty'
  const [filterMode, setFilterMode] = useState('all');

  // Live data polling
  const { data: floorData, loading, error, refresh } = useLiveFloor(null, 8000);
  const { getServerNow } = useServerClock(floorData?.server_now);
  const [, setClockTick] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => {
      setClockTick(t => t + 1);
    }, 60000);
    return () => clearInterval(timer);
  }, []);

  // Modals & Panels
  const [checkoutBookingRef, setCheckoutBookingRef] = useState(null);
  const [detailsReservation, setDetailsReservation] = useState(null);
  const [showForceAdd, setShowForceAdd] = useState(false);
  const [forceAddInitialSessionId, setForceAddInitialSessionId] = useState(null);
  const [extendReservation, setExtendReservation] = useState(null);
  const [addonReservation, setAddonReservation] = useState(null);
  const [lineMsgReservation, setLineMsgReservation] = useState(null);

  // Seating-specific interactive sheets
  const [checkInTarget, setCheckInTarget] = useState(null); // booking
  const [timerTarget, setTimerTarget] = useState(null); // booking
  const [seatActionTarget, setSeatActionTarget] = useState(null); // seat object + booking
  const [boardSwapTarget, setBoardSwapTarget] = useState(null); // { booking, unit_group, board }
  const [selectedSwapSize, setSelectedSwapSize] = useState(null);
  const [selectedBoundary, setSelectedBoundary] = useState(null);
  const [swapSubmitting, setSwapSubmitting] = useState(false);
  const [swapError, setSwapError] = useState(null);
  const [selectedTableDetails, setSelectedTableDetails] = useState(null); // table object

  // CheckIn sheet states
  const [checkInSelectedSeats, setCheckInSelectedSeats] = useState([]);
  const [checkInStartTimer, setCheckInStartTimer] = useState(true);
  const [checkInBoardAssign, setCheckInBoardAssign] = useState({}); // { [unitGroup]: seatCode }
  const [checkInSubmitting, setCheckInSubmitting] = useState(false);
  const [checkInError, setCheckInError] = useState(null);

  // Timer sheet pause menu states
  const [pausePersonTarget, setPausePersonTarget] = useState(null);
  const [pauseReason, setPauseReason] = useState('外出用餐');

  // Toast message
  const [toastMessage, setToastMessage] = useState(null);
  const showToast = (msg) => {
    setToastMessage(msg);
    setTimeout(() => setToastMessage(null), 3500);
  };

  // Collapsed state for completed bookings
  const [isCompletedExpanded, setIsCompletedExpanded] = useState(false);

  const layout = floorData?.layout || {};
  const bookings = floorData?.bookings || [];
  const alerts = floorData?.alerts || [];
  const boardUsage = floorData?.board_usage || [];
  const sessions = floorData?.sessions || [];

  // Group bookings by attendance
  const checkedInBookings = bookings.filter(b => b.attendance === 'checked_in');
  const pendingBookings = bookings.filter(b => b.attendance === 'pending' || !b.attendance);
  const completedBookings = bookings.filter(b => b.attendance === 'completed');

  // In-use pax & empty count
  const inUsePax = checkedInBookings.reduce((sum, b) => sum + (b.pax || 0), 0);
  const pendingPax = pendingBookings.reduce((sum, b) => sum + (b.pax || 0), 0);
  const activeSeats = (layout.seats || []).filter(s => s.is_active);
  const emptySeatCount = Math.max(0, activeSeats.length - inUsePax);

  // Seat state map for FloorPlan and SeatTiles
  const seatStatesMap = useMemo(() => {
    const map = {};
    for (const s of activeSeats) {
      map[s.code] = { state: 'empty', isPaid: false, timerText: '空位', paxName: null, boards: [] };
    }

    // Populate checked-in bookings
    for (const b of checkedInBookings) {
      const isPaid = b.billing?.status === 'paid';
      const bSeats = b.assigned_seats || [];
      bSeats.forEach((seatCode, idx) => {
        const person = (b.persons || [])[idx];
        let timerText = '計時中';
        let state = 'in_use';

        if (person) {
          const isPaused = Boolean(person.paused_at && !person.timer_ended_at);
          if (isPaused) {
            state = 'paused';
            timerText = '已暫停';
          } else {
            const rawElapsed = person.actual_minutes || 0;
            timerText = formatTimerHMM(rawElapsed);
          }
        }

        const personBoards = (b.boards || []).filter(bd => bd.person_no === (idx + 1));
        const boardLabels = personBoards.map(bd => {
          const segs = bd.segments || [];
          return segs.map(s => displayBoardName(s.name)).join('→');
        });

        map[seatCode] = {
          state,
          isPaid,
          timerText,
          paxName: b.name,
          bookingRef: b.booking_ref,
          booking: b,
          boards: boardLabels,
          personNo: idx + 1
        };
      });
    }

    // Populate pending bookings
    for (const b of pendingBookings) {
      const bSeats = b.assigned_seats || [];
      const startTimeStr = b.start_at ? new Date(b.start_at).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', hour12: false }) : '';
      bSeats.forEach((seatCode) => {
        if (map[seatCode]) {
          map[seatCode] = {
            state: 'reserved',
            isPaid: false,
            timerText: `${startTimeStr} 到`,
            paxName: b.name,
            bookingRef: b.booking_ref,
            booking: b,
            boards: []
          };
        }
      });
    }

    return map;
  }, [activeSeats, checkedInBookings, pendingBookings]);

  // Open Check In Sheet
  const handleOpenCheckIn = (booking) => {
    setCheckInTarget(booking);
    setCheckInSelectedSeats(booking.assigned_seats || []);
    setCheckInStartTimer(true);
    setCheckInError(null);

    // Initial board assignment
    const initialAssign = {};
    const bds = booking.boards || [];
    bds.forEach((bd, idx) => {
      const assignedSeat = booking.assigned_seats?.[idx] || booking.assigned_seats?.[0] || '';
      initialAssign[bd.unit_group] = assignedSeat;
    });
    setCheckInBoardAssign(initialAssign);
  };

  // Submit Check In
  const handleSubmitCheckIn = async (deferSeating = false) => {
    if (!checkInTarget) return;
    try {
      setCheckInSubmitting(true);
      setCheckInError(null);

      const boardAssignments = Object.entries(checkInBoardAssign).map(([uGroup, sCode]) => {
        const pIdx = checkInSelectedSeats.indexOf(sCode);
        return {
          unit_group: uGroup,
          person_no: pIdx >= 0 ? pIdx + 1 : 1
        };
      });

      const res = await api.post(`/floor/${checkInTarget.booking_ref}/check-in`, {
        seats: deferSeating ? [] : checkInSelectedSeats,
        board_assignments: boardAssignments,
        start_timer: deferSeating ? false : checkInStartTimer,
        defer_seating: deferSeating
      });

      setCheckInTarget(null);
      refresh();
      showToast(deferSeating ? '已報到，稍後再帶位' : '已入座，開始計時');

      if (res.data?.displaced_reservations?.length) {
        const displacedNames = res.data.displaced_reservations.map(d => `${d.name} (${d.new_seats?.join('、')})`).join('、');
        showToast(`已自動改排其他預約：${displacedNames}`);
      }
    } catch (err) {
      console.error(err);
      if (err.response?.status === 409) {
        setCheckInError(err.response?.data?.error || '座位已被鎖定，請選其他座位');
      } else {
        setCheckInError(err.response?.data?.error || '報到帶位失敗');
      }
    } finally {
      setCheckInSubmitting(false);
    }
  };

  // Timer controls (pause, resume, pause all, resume all)
  const handleTimerAction = async (bookingRef, personNo, action, reason = null) => {
    try {
      await api.post(`/floor/${bookingRef}/timer`, {
        person_no: personNo,
        action,
        reason
      });
      refresh();
      setPausePersonTarget(null);
    } catch (err) {
      alert(err.response?.data?.error || '計時操作失敗');
    }
  };

  // Move seat action
  const handleMoveSeat = async (bookingRef, personNo, targetSeat) => {
    try {
      await api.post(`/floor/${bookingRef}/move-seat`, {
        person_no: personNo,
        target_seat_code: targetSeat
      });
      refresh();
      setSeatActionTarget(null);
      showToast(`已換至座位 ${targetSeat}`);
    } catch (err) {
      alert(err.response?.data?.error || '換座位失敗');
    }
  };

  // Seat click handler from floor plan or table card
  const handleSeatClick = (seat) => {
    const seatInfo = seatStatesMap[seat.code];
    if (!seatInfo) return;

    if (seatInfo.booking) {
      setSeatActionTarget({
        seat,
        seatInfo,
        booking: seatInfo.booking
      });
    } else {
      // Empty seat -> Option to add walk-in
      setSeatActionTarget({
        seat,
        seatInfo,
        booking: null
      });
    }
  };

  // Arrival status helper
  const getArrivalStatus = (startAt) => {
    if (!startAt) return null;
    const nowMs = getServerNow().getTime();
    const startMs = new Date(startAt).getTime();
    const diffMins = Math.round((startMs - nowMs) / 60000);

    if (diffMins > 0) {
      return {
        label: `${diffMins} 分後到`,
        pillClass: 'bg-sg-paper text-sg-ink border border-sg-line'
      };
    } else {
      const lateMins = Math.abs(diffMins);
      if (lateMins <= 15) {
        return {
          label: `遲到 ${lateMins} 分`,
          pillClass: 'bg-sg-honey-soft text-sg-honey font-bold'
        };
      } else {
        const retainTime = new Date(startMs + 15 * 60000).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', hour12: false });
        return {
          label: `保留到 ${retainTime}`,
          pillClass: 'bg-sg-danger-soft text-sg-danger font-bold'
        };
      }
    }
  };

  // Group timer status helper
  const getGroupTimerPill = (b) => {
    const persons = b.persons || [];
    let isAnyOvertime = false;
    let maxOvertime = 0;
    let isAllPaused = persons.length > 0;
    let isAnyLowTime = false;

    for (const p of persons) {
      if (p.timer_started_at && !p.timer_ended_at) {
        if (!p.paused_at) isAllPaused = false;
        const booked = (b.session_count || 1) * 60;
        const act = p.actual_minutes || 0;
        if (act > booked) {
          isAnyOvertime = true;
          maxOvertime = Math.max(maxOvertime, act - booked);
        } else if (booked - act <= 20) {
          isAnyLowTime = true;
        }
      }
    }

    if (isAnyOvertime) {
      return { label: `超時 ${maxOvertime} 分`, pillClass: 'bg-sg-danger-soft text-sg-danger font-bold' };
    }
    if (isAllPaused) {
      return { label: '已暫停', pillClass: 'bg-sg-paper text-sg-muted font-bold' };
    }
    if (isAnyLowTime) {
      return { label: '還有 20 分', pillClass: 'bg-sg-honey-soft text-sg-honey font-bold' };
    }
    return { label: '計時中', pillClass: 'bg-sg-sage-soft text-sg-sage-ink font-bold' };
  };

  return (
    <div className="space-y-4 max-w-7xl mx-auto pb-12">
      {/* Toast */}
      {toastMessage && (
        <div className="fixed top-4 right-4 z-50 bg-sg-ink text-white px-4 py-2.5 rounded-2xl shadow-lg text-[13px] font-bold flex items-center gap-2 animate-fade-in">
          <Sparkles className="w-4 h-4 text-sg-peach" />
          <span>{toastMessage}</span>
        </div>
      )}

      {/* Top Header & Summary */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 bg-white p-4 rounded-3xl border border-sg-line shadow-xs">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-[18px] font-bold text-sg-ink">今日帶位</h1>
            <span className="text-[13px] text-sg-muted">
              {getServerNow().toLocaleDateString('zh-TW', { month: 'numeric', day: 'numeric', weekday: 'short' })}
            </span>
          </div>
          <div className="text-[13px] text-sg-muted mt-0.5">
            使用中 <span className="font-bold text-sg-ink font-num">{inUsePax}</span> 位 · 待入座 <span className="font-bold text-sg-ink font-num">{pendingPax}</span> 位 · 空位 <span className="font-bold text-sg-ink font-num">{emptySeatCount}</span> 個
          </div>
        </div>

        <div className="flex items-center gap-2">
          <SegmentedTabs
            tabs={[
              { id: 'list', label: '名單' },
              { id: 'floor', label: '平面圖' },
              { id: 'timeline', label: '時間軸' }
            ]}
            activeTab={activeTab}
            onChange={handleTabChange}
          />
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setShowForceAdd(true)}
          >
            <Plus className="w-4 h-4 mr-1 text-sg-brown" />
            現場加人
          </Button>
        </div>
      </div>

      {/* Filter Chips Bar */}
      <div className="flex items-center gap-2 overflow-x-auto pb-1">
        {[
          { key: 'all', label: '全部' },
          { key: 'alert', label: `需要注意 ${alerts.length ? alerts.length : ''}` },
          { key: 'pending', label: `待入座 ${pendingBookings.length}` },
          { key: 'empty', label: `空位 ${emptySeatCount}` }
        ].map(chip => (
          <button
            key={chip.key}
            type="button"
            onClick={() => setFilterMode(chip.key)}
            className={`px-3 py-1.5 rounded-2xl text-[12px] font-bold whitespace-nowrap transition border ${
              filterMode === chip.key
                ? 'bg-sg-brown text-white border-sg-brown'
                : 'bg-white text-sg-ink border-sg-line hover:border-sg-muted'
            }`}
          >
            {chip.label}
          </button>
        ))}
      </div>

      {/* TAB 1: LIST VIEW (名單) */}
      {activeTab === 'list' && (
        <div className="space-y-6">
          {/* Section: 待入座 */}
          <div className="space-y-3">
            <h2 className="text-[14px] font-bold text-sg-ink flex items-center justify-between">
              <span>待入座 ({pendingBookings.length})</span>
            </h2>

            {pendingBookings.length === 0 ? (
              <div className="p-8 text-center bg-white rounded-3xl border border-sg-line text-[13px] text-sg-muted">
                目前沒有待入座的顧客
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                {pendingBookings.map((b, idx) => {
                  const arrival = getArrivalStatus(b.start_at);
                  const isFirst = idx === 0;

                  return (
                    <div
                      key={b.booking_ref}
                      className="bg-white rounded-3xl border border-sg-line p-4 shadow-xs flex flex-col justify-between space-y-3"
                    >
                      <div>
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            <span className="font-bold text-[15px] text-sg-ink">{b.name}</span>
                            <span className="text-[13px] text-sg-muted">· {b.pax} 位</span>
                          </div>
                          {arrival && (
                            <span className={`text-[11px] px-2 py-0.5 rounded-lg ${arrival.pillClass}`}>
                              {arrival.label}
                            </span>
                          )}
                        </div>

                        <div className="text-[12px] text-sg-muted mt-1">
                          {b.time_range} · 預定 {b.assigned_seats?.join('、') || '未排座'}
                          {b.boards?.length > 0 && ` · 智能板 ×${b.boards.length}`}
                        </div>
                      </div>

                      <div className="flex items-center justify-between pt-2 border-t border-sg-line">
                        <Button
                          variant={isFirst ? 'primary' : 'secondary'}
                          size="sm"
                          onClick={() => handleOpenCheckIn(b)}
                        >
                          報到並帶位
                        </Button>

                        <div className="flex items-center gap-1">
                          <button
                            type="button"
                            onClick={() => setDetailsReservation({ booking_ref: b.booking_ref })}
                            className="p-1.5 rounded-xl hover:bg-sg-paper text-sg-muted hover:text-sg-ink"
                            title="訂單詳情"
                          >
                            <Info className="w-4 h-4" />
                          </button>
                          <button
                            type="button"
                            onClick={() => setLineMsgReservation(b)}
                            className="p-1.5 rounded-xl hover:bg-sg-paper text-sg-muted hover:text-sg-ink"
                            title="傳 LINE 訊息"
                          >
                            <MoreVertical className="w-4 h-4" />
                          </button>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Section: 使用中 */}
          <div className="space-y-3">
            <h2 className="text-[14px] font-bold text-sg-ink flex items-center justify-between">
              <span>使用中 ({checkedInBookings.length})</span>
            </h2>

            {checkedInBookings.length === 0 ? (
              <div className="p-8 text-center bg-white rounded-3xl border border-sg-line text-[13px] text-sg-muted">
                目前沒有正在使用中的顧客
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                {checkedInBookings.map((b) => {
                  const timerPill = getGroupTimerPill(b);
                  const isPaid = b.billing?.status === 'paid';

                  return (
                    <div
                      key={b.booking_ref}
                      onClick={() => setTimerTarget(b)}
                      className="bg-white rounded-3xl border border-sg-line p-4 shadow-xs flex flex-col justify-between space-y-3 cursor-pointer hover:border-sg-brown transition"
                    >
                      <div>
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            <span className="font-bold text-[15px] text-sg-ink">{b.name}</span>
                            <span className="text-[13px] text-sg-muted">· {b.pax} 位</span>
                          </div>
                          <div className="flex items-center gap-1.5">
                            <span className={`text-[11px] px-2 py-0.5 rounded-lg ${timerPill.pillClass}`}>
                              {timerPill.label}
                            </span>
                            <StatusPill status={b.billing?.status || 'unpaid'} />
                          </div>
                        </div>

                        <div className="text-[12px] text-sg-muted mt-1">
                          座位 {b.assigned_seats?.join('、') || '未帶位'} · 預約到 {b.end_at ? new Date(b.end_at).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', hour12: false }) : ''}
                        </div>
                      </div>

                      <div className="flex items-center justify-between pt-2 border-t border-sg-line" onClick={(e) => e.stopPropagation()}>
                        <span className="text-[11px] text-sg-brown font-bold">
                          點擊查看計時明細
                        </span>

                        <div className="flex items-center gap-2">
                          <Button
                            variant="primary"
                            size="sm"
                            onClick={() => setCheckoutBookingRef(b.booking_ref)}
                          >
                            結帳
                          </Button>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Section: 已離場 (Accordion) */}
          <div className="border border-sg-line rounded-3xl bg-white overflow-hidden shadow-xs">
            <button
              type="button"
              onClick={() => setIsCompletedExpanded(!isCompletedExpanded)}
              className="w-full px-5 py-3.5 flex items-center justify-between bg-sg-paper/40 hover:bg-sg-paper/60 text-left transition"
            >
              <span className="font-bold text-[14px] text-sg-ink">
                已離場 {completedBookings.length} 組
              </span>
              <ChevronDown className={`w-4 h-4 text-sg-muted transition-transform ${isCompletedExpanded ? 'rotate-180' : ''}`} />
            </button>

            {isCompletedExpanded && (
              <div className="p-4 divide-y divide-sg-line">
                {completedBookings.length === 0 ? (
                  <div className="py-4 text-center text-sg-muted text-[13px]">尚無已離場紀錄</div>
                ) : (
                  completedBookings.map((b) => (
                    <div key={b.booking_ref} className="py-2.5 flex items-center justify-between text-[13px]">
                      <div>
                        <span className="font-bold text-sg-ink mr-2">{b.name}</span>
                        <span className="text-sg-muted">{b.time_range} · {b.pax} 位</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <StatusPill status={b.billing?.status || 'unpaid'} />
                        {b.billing?.status !== 'paid' && (
                          <Button
                            variant="secondary"
                            size="sm"
                            onClick={() => setCheckoutBookingRef(b.booking_ref)}
                          >
                            結帳
                          </Button>
                        )}
                      </div>
                    </div>
                  ))
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* TAB 2: FLOOR PLAN VIEW (平面圖) */}
      {activeTab === 'floor' && (
        <div className="space-y-4">
          {/* Desktop/Tablet: Side by side */}
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-start">
            {/* Left: Floor canvas */}
            <div className="lg:col-span-8 bg-white p-4 rounded-3xl border border-sg-line shadow-xs space-y-3">
              <div className="flex items-center justify-between pb-2 border-b border-sg-line">
                <div className="text-[13px] font-bold text-sg-ink">全店座位平面圖</div>
                <div className="flex items-center gap-3 text-[11px] text-sg-muted">
                  <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded bg-sg-sage" />計時中</span>
                  <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded bg-sg-honey" />快到時</span>
                  <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded bg-sg-danger" />超時</span>
                  <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded bg-white border border-sg-brown" />待入座</span>
                  <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded bg-white border border-sg-line" />空位</span>
                </div>
              </div>

              <div className="overflow-x-auto flex justify-center py-2">
                <FloorPlan
                  layout={layout}
                  seatStates={seatStatesMap}
                  onSeatClick={handleSeatClick}
                  scale={0.8}
                />
              </div>

              {/* Mobile Table Cards List below canvas for small screens */}
              <div className="lg:hidden space-y-4 pt-4 border-t border-sg-line">
                {(layout.tables || []).map((t) => {
                  const tableSeats = (layout.seats || []).filter(s => s.table_id === t.id);
                  const zone = (layout.zones || []).find(z => z.id === t.zone_id);

                  return (
                    <TableCard
                      key={t.id}
                      table={t}
                      zoneName={zone?.name}
                      seats={tableSeats}
                      seatStates={seatStatesMap}
                      onSeatClick={handleSeatClick}
                    />
                  );
                })}
              </div>
            </div>

            {/* Right: Sidebar Overview or Table Details */}
            <div className="lg:col-span-4 space-y-4">
              {selectedTableDetails ? (
                <div className="bg-white p-4 rounded-3xl border border-sg-line shadow-xs space-y-4">
                  <div className="flex items-center justify-between">
                    <h3 className="text-[16px] font-bold text-sg-ink">{selectedTableDetails.label} 明細</h3>
                    <button
                      type="button"
                      onClick={() => setSelectedTableDetails(null)}
                      className="text-[12px] text-sg-brown hover:underline font-bold"
                    >
                      回到總覽
                    </button>
                  </div>

                  <div className="space-y-2">
                    {(layout.seats || [])
                      .filter(s => s.table_id === selectedTableDetails.id)
                      .map((s) => {
                        const st = seatStatesMap[s.code] || {};
                        return (
                          <div key={s.code} className="p-3 rounded-2xl bg-sg-paper/40 border border-sg-line flex items-center justify-between text-[13px]">
                            <div>
                              <span className="font-bold text-sg-ink mr-2">{s.code}</span>
                              <span className="text-sg-muted">{st.paxName || '空位'}</span>
                            </div>
                            <span className="font-bold text-[12px]">{st.timerText}</span>
                          </div>
                        );
                      })}
                  </div>
                </div>
              ) : (
                <>
                  {/* Alerts Card */}
                  {alerts.length > 0 && (
                    <div className="bg-sg-honey-soft/50 p-4 rounded-3xl border border-sg-honey/40 space-y-3">
                      <div className="flex items-center gap-2 text-sg-honey font-bold text-[14px]">
                        <AlertTriangle className="w-4 h-4" />
                        <span>需要注意 ({alerts.length})</span>
                      </div>
                      <div className="space-y-2">
                        {alerts.map((al, idx) => (
                          <div
                            key={idx}
                            onClick={() => {
                              const b = bookings.find(bk => bk.booking_ref === al.booking_ref);
                              if (b) setTimerTarget(b);
                            }}
                            className="p-2.5 rounded-2xl bg-white border border-sg-line cursor-pointer hover:border-sg-brown text-[12px] space-y-0.5"
                          >
                            <div className="font-bold text-sg-ink">{al.title}</div>
                            <div className="text-sg-muted">{al.subtitle}</div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Smart Board Usage */}
                  <div className="bg-white p-4 rounded-3xl border border-sg-line shadow-xs space-y-2">
                    <h3 className="text-[13px] font-bold text-sg-ink">智能板即時租借</h3>
                    <div className="grid grid-cols-3 gap-2 text-center">
                      {boardUsage.map((bu) => (
                        <div key={bu.equipment_id} className="p-2 rounded-xl bg-sg-paper/40 border border-sg-line">
                          <span className="text-[11px] text-sg-muted block">{displayBoardName(bu.name)}</span>
                          <span className="font-bold text-[14px] text-sg-ink font-num">
                            {bu.in_use} / {bu.total}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Pending Check-in Quick List */}
                  <div className="bg-white p-4 rounded-3xl border border-sg-line shadow-xs space-y-3">
                    <h3 className="text-[13px] font-bold text-sg-ink">待入座顧客 ({pendingBookings.length})</h3>
                    <div className="space-y-2 max-h-[300px] overflow-y-auto">
                      {pendingBookings.map((b) => (
                        <div key={b.booking_ref} className="p-2.5 rounded-2xl bg-sg-paper/40 border border-sg-line flex items-center justify-between text-[12px]">
                          <div>
                            <div className="font-bold text-sg-ink">{b.name} · {b.pax} 位</div>
                            <div className="text-sg-muted text-[11px]">{b.time_range}</div>
                          </div>
                          <Button
                            variant="secondary"
                            size="sm"
                            onClick={() => handleOpenCheckIn(b)}
                          >
                            帶位
                          </Button>
                        </div>
                      ))}
                    </div>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* TAB 3: TIMELINE VIEW (時間軸) */}
      {activeTab === 'timeline' && (
        <div className="space-y-3">
          <div className="text-[12px] text-sg-muted">
            點擊空白處可快速現場加人；點擊預約方塊可查看計時或帶位。
          </div>
          <TimelineGrid
            seats={layout.seats || []}
            bookings={bookings}
            sessions={sessions}
            onBookingClick={(b) => {
              if (b.attendance === 'checked_in') setTimerTarget(b);
              else handleOpenCheckIn(b);
            }}
            onEmptySlotClick={(seatCode, session) => {
              setForceAddInitialSessionId(session?.id);
              setShowForceAdd(true);
            }}
          />
        </div>
      )}

      {/* Check In Sheet (Section 6.3) */}
      <ResponsivePanel
        isOpen={Boolean(checkInTarget)}
        onClose={() => setCheckInTarget(null)}
        title="報到並帶位"
        subtitle={`${checkInTarget?.name} · ${checkInTarget?.pax} 位 · ${checkInTarget?.time_range}`}
        footer={
          <div className="space-y-2">
            {checkInError && (
              <div className="p-2.5 rounded-xl bg-sg-danger-soft text-sg-danger text-[12px] font-bold">
                {checkInError}
              </div>
            )}
            <div className="flex items-center justify-between">
              <button
                type="button"
                onClick={() => handleSubmitCheckIn(true)}
                className="text-[13px] text-sg-brown font-bold hover:underline"
              >
                只報到，稍後再帶位
              </button>
              <Button
                variant="primary"
                size="md"
                onClick={() => handleSubmitCheckIn(false)}
                loading={checkInSubmitting}
                disabled={checkInSelectedSeats.length === 0}
              >
                {checkInStartTimer ? '入座並開始計時' : '入座'}
              </Button>
            </div>
          </div>
        }
      >
        <div className="space-y-4 py-2">
          {/* Allocator suggestion box */}
          <div className="p-3 rounded-2xl bg-sg-brown-soft text-[12px] text-sg-brown border border-sg-brown/20 space-y-1">
            <span className="font-bold block">系統建議座位：{checkInTarget?.assigned_seats?.join('、') || '自動指派'}</span>
            <span className="text-[11px] opacity-90">已避開冷氣出風口並優先安排同側或相鄰座位。</span>
          </div>

          {/* Seat selection */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <span className="text-[13px] font-bold text-sg-ink">
                選擇入座座位（已選 {checkInSelectedSeats.length} / {checkInTarget?.pax || 1} 位）
              </span>
              {checkInSelectedSeats.length > 0 && (
                <button
                  type="button"
                  onClick={() => setCheckInSelectedSeats([])}
                  className="text-[11px] text-sg-brown hover:underline"
                >
                  清除重選
                </button>
              )}
            </div>

            <div className="grid grid-cols-4 sm:grid-cols-6 gap-2">
              {activeSeats.map((s) => {
                const isSelected = checkInSelectedSeats.includes(s.code);
                const isOccupied = seatStatesMap[s.code]?.state === 'in_use';

                return (
                  <button
                    key={s.code}
                    type="button"
                    disabled={isOccupied}
                    onClick={() => {
                      if (isSelected) {
                        setCheckInSelectedSeats(checkInSelectedSeats.filter(c => c !== s.code));
                      } else {
                        if (checkInSelectedSeats.length < (checkInTarget?.pax || 1)) {
                          setCheckInSelectedSeats([...checkInSelectedSeats, s.code]);
                        }
                      }
                    }}
                    className={`p-2.5 rounded-xl border text-center transition ${
                      isOccupied
                        ? 'bg-sg-paper text-sg-muted border-sg-line cursor-not-allowed opacity-50'
                        : isSelected
                        ? 'bg-sg-brown text-white border-sg-brown font-bold'
                        : 'bg-white text-sg-ink border-sg-line hover:border-sg-brown'
                    }`}
                  >
                    <span className="block text-[13px] font-num">{s.code}</span>
                    <span className="block text-[10px] opacity-80">{isOccupied ? '有人' : isSelected ? '已選' : '空位'}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Smart Board assignment */}
          {(checkInTarget?.boards || []).length > 0 && (
            <div className="space-y-2 pt-2 border-t border-sg-line">
              <span className="text-[13px] font-bold text-sg-ink block">智能板分配給哪一位</span>
              {checkInTarget.boards.map((bd, bIdx) => (
                <div key={bd.unit_group || bIdx} className="flex items-center justify-between p-2.5 rounded-xl bg-sg-paper/40 border border-sg-line text-[12px]">
                  <span className="font-bold text-sg-ink">
                    智能板 #{bIdx + 1}
                  </span>
                  <div className="flex items-center gap-1.5">
                    {checkInSelectedSeats.map((sCode) => (
                      <button
                        key={sCode}
                        type="button"
                        onClick={() => setCheckInBoardAssign(prev => ({ ...prev, [bd.unit_group]: sCode }))}
                        className={`px-2.5 py-1 rounded-lg font-bold border transition ${
                          checkInBoardAssign[bd.unit_group] === sCode
                            ? 'bg-sg-brown text-white border-sg-brown'
                            : 'bg-white text-sg-ink border-sg-line'
                        }`}
                      >
                        {sCode}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Start timer toggle */}
          <div className="pt-2 border-t border-sg-line flex items-center justify-between">
            <span className="text-[13px] font-bold text-sg-ink">入座後立即開始計時</span>
            <input
              type="checkbox"
              checked={checkInStartTimer}
              onChange={(e) => setCheckInStartTimer(e.target.checked)}
              className="w-5 h-5 rounded text-sg-brown focus:ring-sg-brown cursor-pointer"
            />
          </div>
        </div>
      </ResponsivePanel>

      {/* Timer Sheet (Section 6.8) */}
      <ResponsivePanel
        isOpen={Boolean(timerTarget)}
        onClose={() => setTimerTarget(null)}
        title={`${timerTarget?.name} · ${timerTarget?.pax} 位計時面板`}
        footer={
          <div className="flex items-center justify-between">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                // Pause / resume all
                const isAllPaused = (timerTarget?.persons || []).every(p => p.paused_at && !p.timer_ended_at);
                handleTimerAction(timerTarget.booking_ref, 1, isAllPaused ? 'resume_all' : 'pause_all');
              }}
            >
              {(timerTarget?.persons || []).every(p => p.paused_at && !p.timer_ended_at) ? '全組繼續' : '全組暫停'}
            </Button>
            <Button
              variant="primary"
              size="md"
              onClick={() => {
                const bRef = timerTarget.booking_ref;
                setTimerTarget(null);
                setCheckoutBookingRef(bRef);
              }}
            >
              進入結帳
            </Button>
          </div>
        }
      >
        <div className="space-y-4 py-2">
          {/* Info KV */}
          <div className="grid grid-cols-2 gap-2 p-3 rounded-2xl bg-sg-paper/40 border border-sg-line text-[12px]">
            <div>
              <span className="text-sg-muted block">預約時數</span>
              <span className="font-bold text-sg-ink">{timerTarget?.session_count || 1} 小時</span>
            </div>
            <div>
              <span className="text-sg-muted block">入座座位</span>
              <span className="font-bold text-sg-ink">{timerTarget?.assigned_seats?.join('、') || '未分配'}</span>
            </div>
          </div>

          {/* Per-person timer list */}
          <div className="space-y-2">
            <span className="text-[13px] font-bold text-sg-ink block">每位計時</span>
            {(timerTarget?.persons || []).map((p) => {
              const isPaused = Boolean(p.paused_at && !p.timer_ended_at);

              return (
                <div
                  key={p.person_no}
                  className="p-3 rounded-2xl border border-sg-line bg-white flex items-center justify-between"
                >
                  <div>
                    <div className="font-bold text-[14px] text-sg-ink">
                      第 {p.person_no} 位 ({p.seat_code || '未帶位'})
                    </div>
                    <div className="text-[12px] text-sg-muted">
                      {isPaused ? `已暫停 · ${p.pause_reason || '暫停'}` : `計時中 · 已計 ${formatTimerHMM(p.actual_minutes || 0)}`}
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
                    {isPaused ? (
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => handleTimerAction(timerTarget.booking_ref, p.person_no, 'resume')}
                      >
                        <Play className="w-3.5 h-3.5 mr-1" />
                        繼續
                      </Button>
                    ) : (
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => setPausePersonTarget(p)}
                      >
                        <Pause className="w-3.5 h-3.5 mr-1" />
                        暫停
                      </Button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          <p className="text-[11px] text-sg-muted">
            暫停的時間不計費。結帳時每位的時數會自動帶入，店員可以再修改。
          </p>
        </div>
      </ResponsivePanel>

      {/* Pause Reason Sheet */}
      <ConfirmPanel
        isOpen={Boolean(pausePersonTarget)}
        onClose={() => setPausePersonTarget(null)}
        onConfirm={() => {
          if (timerTarget && pausePersonTarget) {
            handleTimerAction(timerTarget.booking_ref, pausePersonTarget.person_no, 'pause', pauseReason);
          }
        }}
        title={`暫停第 ${pausePersonTarget?.person_no} 位計時`}
        message="請選擇暫停原因（暫停期間將不計入場費用）："
      >
        <ReasonChips
          presets={['外出用餐', '休息片刻', '等待朋友', '其他']}
          value={pauseReason}
          onChange={setPauseReason}
        />
      </ConfirmPanel>

      {/* Seat Action Panel (Section 6.6) */}
      <ResponsivePanel
        isOpen={Boolean(seatActionTarget)}
        onClose={() => setSeatActionTarget(null)}
        title={seatActionTarget?.seat ? `座位 ${seatActionTarget.seat.code}` : '座位操作'}
        subtitle={seatActionTarget?.booking ? `${seatActionTarget.booking.name} · ${seatActionTarget.seatInfo?.timerText}` : '空位中'}
        footer={
          seatActionTarget?.booking ? (
            <div className="flex items-center justify-between">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  setDetailsReservation({ booking_ref: seatActionTarget.booking.booking_ref });
                  setSeatActionTarget(null);
                }}
              >
                訂單詳情
              </Button>
              <Button
                variant="primary"
                size="md"
                onClick={() => {
                  const bRef = seatActionTarget.booking.booking_ref;
                  setSeatActionTarget(null);
                  setCheckoutBookingRef(bRef);
                }}
              >
                結帳
              </Button>
            </div>
          ) : (
            <div className="flex justify-end">
              <Button
                variant="primary"
                size="md"
                onClick={() => {
                  setSeatActionTarget(null);
                  setShowForceAdd(true);
                }}
              >
                現場加人（坐這裡）
              </Button>
            </div>
          )
        }
      >
        {seatActionTarget?.booking ? (
          <div className="space-y-3 py-2">
            <div className="grid grid-cols-2 gap-2 text-[12px]">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  const b = seatActionTarget.booking;
                  const pNo = seatActionTarget.seatInfo?.personNo || 1;
                  const isPaused = seatActionTarget.seatInfo?.state === 'paused';
                  handleTimerAction(b.booking_ref, pNo, isPaused ? 'resume' : 'pause');
                  setSeatActionTarget(null);
                }}
              >
                {seatActionTarget.seatInfo?.state === 'paused' ? '繼續計時' : '暫停計時'}
              </Button>

              {/* Board swap button */}
              {(() => {
                const b = seatActionTarget.booking;
                const pNo = seatActionTarget.seatInfo?.personNo || 1;
                const personBoard = (b.boards || []).find(bd => bd.person_no === pNo) || (b.boards || [])[0];
                if (personBoard) {
                  return (
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => {
                        setBoardSwapTarget({
                          booking: b,
                          board: personBoard,
                          personNo: pNo,
                          seatCode: seatActionTarget.seat?.code
                        });
                        setSelectedSwapSize(null);
                        setSelectedBoundary(null);
                        setSwapError(null);
                        setSeatActionTarget(null);
                      }}
                    >
                      <RotateCcw className="w-3.5 h-3.5 mr-1" />
                      換板
                    </Button>
                  );
                }
                return (
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => {
                      setAddonReservation(seatActionTarget.booking);
                      setSeatActionTarget(null);
                    }}
                  >
                    <Plus className="w-3.5 h-3.5 mr-1" />
                    加租智能板
                  </Button>
                );
              })()}

              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  setExtendReservation(seatActionTarget.booking);
                  setSeatActionTarget(null);
                }}
              >
                加時
              </Button>

              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  setDetailsReservation({ booking_ref: seatActionTarget.booking.booking_ref });
                  setSeatActionTarget(null);
                }}
              >
                訂單詳情
              </Button>
            </div>

            <div className="pt-2 border-t border-sg-line text-[12px] text-sg-muted">
              長按座位可直接拖曳換位。
            </div>
          </div>
        ) : (
          <div className="py-4 text-center text-sg-muted text-[13px]">
            此座位目前為空位，可直接安排現場客人入座。
          </div>
        )}
      </ResponsivePanel>

      {/* Board Swap Sheet (Section 6.9) */}
      {boardSwapTarget && (() => {
        const b = boardSwapTarget.booking;
        const currentBoard = (b.boards || []).find(bd => bd.person_no === boardSwapTarget.personNo) || (b.boards || [])[0];
        const lastSeg = currentBoard?.segments ? currentBoard.segments[currentBoard.segments.length - 1] : null;
        const currentEqId = lastSeg?.equipment_id;
        const currentEqName = lastSeg?.name || '智能板';

        const segStartMs = lastSeg?.start_at
          ? new Date(lastSeg.start_at).getTime()
          : (b.start_at ? new Date(b.start_at).getTime() : Date.now());
        const nowMs = getServerNow().getTime();
        const usedMins = Math.max(0, Math.floor((nowMs - segStartMs) / 60000));
        const usedText = `${Math.floor(usedMins / 60)} 小時 ${usedMins % 60} 分`;

        const { options: boundaryOptions, suggested: suggestedBoundary } = swapBoundaryOptions(segStartMs, nowMs);
        const activeBoundary = selectedBoundary !== null ? selectedBoundary : suggestedBoundary;

        const bookingEndMs = b.end_at ? new Date(b.end_at).getTime() : (segStartMs + 4 * 3600000);
        const seg1Hours = Math.max(0, (activeBoundary - segStartMs) / 3600000);
        const seg2Hours = Math.max(0, (bookingEndMs - activeBoundary) / 3600000);

        const targetOption = boardUsage.find(item => item.equipment_id === selectedSwapSize);

        // Price preview calculation
        let segsCalc = [];
        if (selectedSwapSize === 'return') {
          segsCalc = [
            { hours: seg1Hours, rate: lastSeg?.hourly_rate || 90 }
          ];
        } else if (targetOption) {
          segsCalc = [
            { hours: seg1Hours, rate: lastSeg?.hourly_rate || 90 },
            { hours: seg2Hours, rate: targetOption.hourly_rate || 120 }
          ];
        }
        const calcRes = segsCalc.length > 0 ? calculateBoardTotal(segsCalc) : null;

        const handleConfirmSwap = async () => {
          if (!selectedSwapSize) return;
          try {
            setSwapSubmitting(true);
            setSwapError(null);
            const unitGroup = currentBoard?.unit_group;
            if (!unitGroup) throw new Error('找不到此板子代號');

            if (selectedSwapSize === 'return') {
              await api.post(`/floor/${b.booking_ref}/boards/${unitGroup}/return`, {
                at: new Date(activeBoundary).toISOString()
              });
              showToast('歸還智能板成功');
            } else {
              await api.post(`/floor/${b.booking_ref}/boards/${unitGroup}/swap`, {
                to_equipment_id: selectedSwapSize,
                boundary_at: new Date(activeBoundary).toISOString()
              });
              showToast('換板成功');
            }
            setBoardSwapTarget(null);
            refresh();
          } catch (err) {
            console.error('swap board error:', err);
            setSwapError(err.response?.data?.error || err.response?.data?.message || err.message || '換板失敗');
          } finally {
            setSwapSubmitting(false);
          }
        };

        return (
          <ResponsivePanel
            isOpen={Boolean(boardSwapTarget)}
            onClose={() => setBoardSwapTarget(null)}
            title="換板"
            subtitle={`${boardSwapTarget.seatCode} 第 ${boardSwapTarget.personNo} 位 · 目前 ${currentEqName}，${formatTimeHHmm(segStartMs)} 起已用 ${usedText}`}
            footer={
              <div className="flex items-center justify-between">
                <Button
                  variant="secondary"
                  size="md"
                  onClick={() => setBoardSwapTarget(null)}
                  disabled={swapSubmitting}
                >
                  取消
                </Button>
                <Button
                  variant={selectedSwapSize === 'return' ? 'danger' : 'primary'}
                  size="md"
                  onClick={handleConfirmSwap}
                  disabled={!selectedSwapSize || swapSubmitting}
                >
                  {swapSubmitting ? '處理中...' : (selectedSwapSize === 'return' ? '確認歸還' : '確認換板')}
                </Button>
              </div>
            }
          >
            <div className="space-y-4 py-2">
              {swapError && (
                <div className="p-3 bg-red-50 text-red-700 text-xs rounded-xl flex items-center gap-2 border border-red-200">
                  <AlertTriangle className="w-4 h-4 shrink-0" />
                  <span>{swapError}</span>
                </div>
              )}

              {/* 換成選項 */}
              <div>
                <span className="text-[13px] font-bold text-sg-ink block mb-2">換成</span>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  {boardUsage.map(item => {
                    const isCurrent = item.equipment_id === currentEqId;
                    const stockLeft = Math.max(0, item.total - item.in_use);
                    const isOutOfStock = stockLeft <= 0;
                    const isSelected = selectedSwapSize === item.equipment_id;

                    return (
                      <button
                        key={item.equipment_id}
                        type="button"
                        disabled={isCurrent || isOutOfStock}
                        onClick={() => setSelectedSwapSize(item.equipment_id)}
                        className={`p-3 rounded-2xl border text-left transition relative ${
                          isSelected
                            ? 'border-sg-brown bg-sg-paper/60 ring-2 ring-sg-brown'
                            : isCurrent || isOutOfStock
                            ? 'border-sg-line bg-gray-50 opacity-50 cursor-not-allowed'
                            : 'border-sg-line bg-white hover:border-sg-brown/50'
                        }`}
                      >
                        <div className="font-bold text-[14px] text-sg-ink">
                          {item.name} {item.status_note ? `(${item.status_note})` : ''}
                          {isCurrent && <span className="ml-1 text-[11px] text-sg-muted font-normal">(目前尺寸)</span>}
                        </div>
                        <div className="text-[12px] text-sg-muted mt-0.5">
                          NT${item.hourly_rate || 120} / 小時 · {isOutOfStock ? '剩 0 台' : `剩 ${stockLeft} 台`}
                        </div>
                      </button>
                    );
                  })}

                  {/* 不用了，歸還 */}
                  <button
                    type="button"
                    onClick={() => setSelectedSwapSize('return')}
                    className={`p-3 rounded-2xl border text-left transition relative ${
                      selectedSwapSize === 'return'
                        ? 'border-sg-danger bg-red-50 ring-2 ring-sg-danger'
                        : 'border-sg-line bg-white hover:border-sg-danger/50'
                    }`}
                  >
                    <div className="font-bold text-[14px] text-sg-danger">
                      不用了，歸還
                    </div>
                    <div className="text-[12px] text-sg-muted mt-0.5">
                      提前結束租借，庫存將自歸還時間點釋出
                    </div>
                  </button>
                </div>
              </div>

              {/* 換板時間 */}
              <div>
                <span className="text-[13px] font-bold text-sg-ink block mb-1">換板時間</span>
                <div className="flex items-center gap-2 mb-1.5">
                  {boundaryOptions.map(opt => {
                    const isSelected = activeBoundary === opt;
                    const isSuggested = opt === suggestedBoundary;
                    return (
                      <button
                        key={opt}
                        type="button"
                        onClick={() => setSelectedBoundary(opt)}
                        className={`px-3 py-1.5 rounded-xl text-[13px] font-bold border transition ${
                          isSelected
                            ? 'bg-sg-brown text-white border-sg-brown'
                            : 'bg-white text-sg-ink border-sg-line hover:border-sg-brown/40'
                        }`}
                      >
                        {formatTimeHHmm(opt)}
                        {isSuggested && <span className="ml-1 text-[10px] opacity-80">(建議)</span>}
                      </button>
                    );
                  })}
                </div>
                <p className="text-[11px] text-sg-muted">
                  現在 {formatTimeHHmm(nowMs)}，以半小時取整（超過 10 分鐘才算下一個半小時）：{formatTimeHHmm(activeBoundary)} 前算{currentEqName}，之後算新尺寸。
                </p>
              </div>

              {/* 金額試算框 */}
              {calcRes && (
                <div className="p-3.5 rounded-2xl bg-sg-paper/40 border border-sg-line text-[12px] space-y-1.5">
                  <div className="flex justify-between">
                    <span>{currentEqName} {formatTimeHHmm(segStartMs)} 到 {formatTimeHHmm(activeBoundary)} · {seg1Hours} 小時</span>
                    <span className="font-bold">NT${Math.round(seg1Hours * (lastSeg?.hourly_rate || 90))}</span>
                  </div>

                  {selectedSwapSize !== 'return' && targetOption && (
                    <div className="flex justify-between">
                      <span>{targetOption.name} {formatTimeHHmm(activeBoundary)} 到 {formatTimeHHmm(bookingEndMs)} · {seg2Hours} 小時</span>
                      <span className="font-bold">NT${Math.round(seg2Hours * (targetOption.hourly_rate || 120))}</span>
                    </div>
                  )}

                  {calcRes.discount > 0 && (
                    <div className="flex justify-between text-sg-green font-medium">
                      <span>合計 {calcRes.hours} 小時買送折抵</span>
                      <span>−NT${calcRes.discount}</span>
                    </div>
                  )}

                  <div className="pt-2 border-t border-sg-line flex justify-between items-center text-[13px]">
                    <span className="font-bold text-sg-ink">這台合計</span>
                    <span className="font-num text-[16px] font-bold text-sg-ink">NT${calcRes.total}</span>
                  </div>
                </div>
              )}
            </div>
          </ResponsivePanel>
        );
      })()}

      {/* Checkout Workbench */}
      {checkoutBookingRef && (
        <CheckoutWorkbench
          isOpen={Boolean(checkoutBookingRef)}
          onClose={() => setCheckoutBookingRef(null)}
          bookingRef={checkoutBookingRef}
          onPaymentSuccess={() => {
            refresh();
          }}
        />
      )}

      {/* Reservation Details Modal */}
      {detailsReservation && (
        <ReservationDetailsModal
          reservation={detailsReservation}
          onClose={() => setDetailsReservation(null)}
          onUpdate={() => refresh()}
        />
      )}

      {/* Force Add Modal (現場加人) */}
      {showForceAdd && (
        <ForceAddModal
          isOpen={showForceAdd}
          onClose={() => setShowForceAdd(false)}
          selectedSessionId={forceAddInitialSessionId}
          sessions={sessions}
          onSuccess={() => {
            setShowForceAdd(false);
            refresh();
            showToast('現場加人成功');
          }}
        />
      )}

      {/* ExtendTime Modal */}
      {extendReservation && (
        <ExtendTimeModal
          isOpen={Boolean(extendReservation)}
          onClose={() => setExtendReservation(null)}
          reservation={extendReservation}
          onSuccess={() => {
            setExtendReservation(null);
            refresh();
            showToast('加時成功');
          }}
        />
      )}

      {/* LINE message modal */}
      {lineMsgReservation && (
        <SendLineMessageModal
          isOpen={Boolean(lineMsgReservation)}
          onClose={() => setLineMsgReservation(null)}
          reservation={lineMsgReservation}
          onSuccess={() => {
            setLineMsgReservation(null);
            showToast('LINE 訊息發送成功');
          }}
        />
      )}
    </div>
  );
}
