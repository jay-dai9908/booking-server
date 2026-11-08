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
  Ticket,
  Search,
  MessageSquare,
  Lock,
  UserX
} from 'lucide-react';
import api from '../../api/axios';
import { useLiveFloor } from '../../hooks/admin/useLiveFloor';
import { useServerClock } from '../../hooks/admin/useServerClock';
import SegmentedTabs from '../../components/admin/SegmentedTabs';
import StatusPill from '../../components/admin/StatusPill';
import ResponsivePanel from '../../components/admin/ResponsivePanel';
import ReasonChips from '../../components/admin/ReasonChips';
import ConfirmPanel from '../../components/admin/ConfirmPanel';
import Button from '../../components/customer/Button';
import DateStrip from '../../components/customer/DateStrip';

// Floor components
import FloorPlan from '../../components/admin/floor/FloorPlan';
import MiniMap from '../../components/admin/floor/MiniMap';
import TableCard from '../../components/admin/floor/TableCard';
import TimelineGrid from '../../components/admin/floor/TimelineGrid';
import CheckInPanel from '../../components/admin/floor/CheckInPanel';

// Modals
import CheckoutWorkbench from '../../components/admin/checkout/CheckoutWorkbench';
import ReservationDetailsModal from '../../components/ReservationDetailsModal';
import ForceAddModal from '../../components/ForceAddModal';
import EquipmentAddonModal from '../../components/EquipmentAddonModal';
import ExtendTimeModal from '../../components/ExtendTimeModal';
import SendLineMessageModal from '../../components/SendLineMessageModal';

import { swapBoundaryOptions, formatTimerHMM, formatTimeHHmm } from '@shared/time.js';
import { calculateBoardTotal } from '@shared/boardPricing.js';
import { displayBoardName } from '@shared/billing.js';
import {
  bookingTimeRange,
  bookingDurationText,
  personElapsedMinutes,
  formatElapsedText,
  personTimerState,
  formatOverdueText,
  groupTimerPill,
  formatBookingRef,
  isBookingCompleted
} from '../../utils/admin/floorSelectors';

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

  // Date selection state
  const todayStr = useMemo(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }, []);
  const [selectedDate, setSelectedDate] = useState(todayStr);
  const [showDatePicker, setShowDatePicker] = useState(false);

  // Time slot filter for floor plan: 'now' | '10:00' | '11:00' ...
  const [selectedSlot, setSelectedSlot] = useState('now');

  // Search input state
  const [searchQuery, setSearchQuery] = useState('');

  // Filter chips: 'all' | 'alert' | 'pending' | 'empty'
  const [filterMode, setFilterMode] = useState('all');

  // Live data polling
  const { data: floorData, loading, error, refresh, setData: setFloorData } = useLiveFloor(selectedDate, 8000);
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
  const [detailsBookingRef, setDetailsBookingRef] = useState(null);
  const [showForceAdd, setShowForceAdd] = useState(false);
  const [forceAddInitialSessionId, setForceAddInitialSessionId] = useState(null);
  const [extendReservation, setExtendReservation] = useState(null);
  const [addonReservation, setAddonReservation] = useState(null);
  const [lineMsgReservation, setLineMsgReservation] = useState(null);
  const [cardMenuBookingRef, setCardMenuBookingRef] = useState(null);
  const [cancelReservationTarget, setCancelReservationTarget] = useState(null);

  const handleCancelReservation = async () => {
    if (!cancelReservationTarget) return;
    try {
      await api.delete(`/reservations/${cancelReservationTarget.booking_ref}`);
      showToast('已取消預約');
      setCancelReservationTarget(null);
      refresh();
    } catch (err) {
      console.error('Failed to cancel reservation', err);
      showToast(err.response?.data?.error || '取消預約失敗');
    }
  };

  // Seating-specific interactive sheets
  const [checkInTarget, setCheckInTarget] = useState(null); // booking
  const [timerTarget, setTimerTarget] = useState(null); // booking

  // Keep timerTarget in sync with live floor data
  useEffect(() => {
    if (timerTarget && floorData?.bookings) {
      const updated = floorData.bookings.find(b => b.booking_ref === timerTarget.booking_ref);
      if (updated) {
        setTimerTarget(updated);
      }
    }
  }, [floorData]);
  const [seatActionTarget, setSeatActionTarget] = useState(null); // seat object + booking
  const [moveSeatModalTarget, setMoveSeatModalTarget] = useState(null); // { booking, fromSeat, personNo }
  const [swapConfirmTarget, setSwapConfirmTarget] = useState(null); // { bookingRef, fromSeat, toSeat, occupantName }

  // Board swap states
  const [boardSwapTarget, setBoardSwapTarget] = useState(null); // { booking, unit_group, board }
  const [selectedSwapSize, setSelectedSwapSize] = useState(null);
  const [selectedBoundary, setSelectedBoundary] = useState(null);
  const [swapSubmitting, setSwapSubmitting] = useState(false);
  const [swapError, setSwapError] = useState(null);

  const [selectedTableDetails, setSelectedTableDetails] = useState(null); // table object
  const [activeMobileTableId, setActiveMobileTableId] = useState(null);
  const [flashingTableId, setFlashingTableId] = useState(null);
  const mobileStickyHeaderRef = useRef(null);

  const handleMiniMapTableClick = (table) => {
    setActiveMobileTableId(table.id);
    const el = document.getElementById(`table-card-${table.id}`);
    if (el) {
      const rect = el.getBoundingClientRect();
      const offset = mobileStickyHeaderRef.current ? mobileStickyHeaderRef.current.offsetHeight + 8 : 160;
      const targetY = window.pageYOffset + rect.top - offset;
      window.scrollTo({ top: targetY, behavior: 'smooth' });
      setFlashingTableId(table.id);
      setTimeout(() => {
        setFlashingTableId((curr) => (curr === table.id ? null : curr));
      }, 1200);
    }
  };

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
  const completedBookings = bookings.filter(b => isBookingCompleted(b));
  const checkedInBookings = bookings.filter(b => b.attendance === 'checked_in' && !isBookingCompleted(b));
  const pendingBookings = bookings.filter(b => (b.attendance === 'pending' || !b.attendance) && !isBookingCompleted(b));

  // In-use pax & empty count
  const inUsePax = checkedInBookings.reduce((sum, b) => sum + (b.pax || 0), 0);
  const pendingPax = pendingBookings.reduce((sum, b) => sum + (b.pax || 0), 0);
  const activeSeats = (layout.seats || []).filter(s => s.is_active);
  const emptySeatCount = Math.max(0, activeSeats.length - inUsePax);

  // Compute next available WAIT-n code
  const nextEmptyWaitSeat = useMemo(() => {
    const allAssigned = bookings.flatMap(b => b.assigned_seats || []);
    let i = 1;
    while (allAssigned.includes(`WAIT-${i}`)) {
      i++;
    }
    return `WAIT-${i}`;
  }, [bookings]);

  // Compute occupied wait seats & wait slots
  const { waitSlots, waitPax } = useMemo(() => {
    const waitSeatMap = {};
    let totalWaitPax = 0;
    for (const b of bookings) {
      const seats = b.assigned_seats || [];
      const hasWait = seats.some(s => s && s.startsWith('WAIT-'));
      if (hasWait) totalWaitPax += (b.pax || 0);

      seats.forEach((seatCode, idx) => {
        if (seatCode && seatCode.startsWith('WAIT-')) {
          const person = (b.persons || [])[idx];
          waitSeatMap[seatCode] = {
            booking: b,
            person,
            personNo: idx + 1
          };
        }
      });
    }

    const occupiedNums = Object.keys(waitSeatMap)
      .map(k => parseInt(k.replace('WAIT-', ''), 10))
      .filter(n => !isNaN(n));
    const maxWaitNum = occupiedNums.length > 0 ? Math.max(...occupiedNums) : 0;
    const totalWaitSlots = Math.max(2, maxWaitNum + 2);

    const slots = [];
    for (let i = 1; i <= totalWaitSlots; i++) {
      const code = `WAIT-${i}`;
      const occ = waitSeatMap[code];
      slots.push({
        code,
        label: `等待 ${i}`,
        occupied: Boolean(occ),
        booking: occ?.booking,
        person: occ?.person,
        personNo: occ?.personNo
      });
    }

    return { waitSlots: slots, waitPax: totalWaitPax };
  }, [bookings]);

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
        if (!seatCode || seatCode.startsWith('WAIT-')) return;
        const person = (b.persons || [])[idx];
        let timerText = '計時中';
        let state = 'in_use';

        if (person) {
          const tm = person.timer || person;
          const isPaused = Boolean(tm.paused_at && !tm.timer_ended_at);
          if (isPaused) {
            state = 'paused';
            timerText = '已暫停';
          } else {
            const rawElapsed = personElapsedMinutes(person, getServerNow());
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
      const startTimeStr = b.start_at ? new Date(b.start_at).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Taipei' }) : '';
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
  }, [activeSeats, checkedInBookings, pendingBookings, getServerNow]);

  // Group tables by zone
  const zoneGroupedTables = useMemo(() => {
    const zones = [...(layout.zones || [])].sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
    const allTables = layout.tables || [];
    const allSeats = layout.seats || [];

    const groups = [];

    for (const zone of zones) {
      const zoneTables = allTables
        .filter(t => t.zone_id === zone.id)
        .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));

      if (zoneTables.length === 0) continue;

      const zoneSeats = allSeats.filter(s => s.zone_id === zone.id && s.is_active);
      const totalSeats = zoneSeats.length;
      const inUseSeats = zoneSeats.filter(s => {
        const state = seatStatesMap[s.code]?.state;
        return state === 'in_use' || state === 'paused';
      }).length;

      const prefix = (zone.sort_order != null && !zone.name.startsWith(String(zone.sort_order + 1)))
        ? `${zone.sort_order + 1} `
        : '';
      const zoneTitle = `${prefix}${zone.name}`;

      groups.push({
        zone,
        zoneTitle,
        totalSeats,
        inUseSeats,
        tables: zoneTables
      });
    }

    const unzonedTables = allTables
      .filter(t => !t.zone_id || !zones.some(z => z.id === t.zone_id))
      .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));

    if (unzonedTables.length > 0) {
      const unzonedSeats = allSeats.filter(s => unzonedTables.some(t => t.id === s.table_id) && s.is_active);
      groups.push({
        zone: null,
        zoneTitle: '其他區域',
        totalSeats: unzonedSeats.length,
        inUseSeats: unzonedSeats.filter(s => {
          const state = seatStatesMap[s.code]?.state;
          return state === 'in_use' || state === 'paused';
        }).length,
        tables: unzonedTables
      });
    }

    return groups;
  }, [layout.zones, layout.tables, layout.seats, seatStatesMap]);

  // Scroll spy for MiniMap
  useEffect(() => {
    if (activeTab !== 'floor') return;
    const handleScroll = () => {
      if (window.innerWidth >= 1024) return;
      const tables = layout.tables || [];
      const stickyOffset = mobileStickyHeaderRef.current ? mobileStickyHeaderRef.current.offsetHeight + 16 : 180;
      for (const t of tables) {
        const el = document.getElementById(`table-card-${t.id}`);
        if (el) {
          const rect = el.getBoundingClientRect();
          if (rect.bottom > stickyOffset) {
            setActiveMobileTableId(t.id);
            break;
          }
        }
      }
    };

    window.addEventListener('scroll', handleScroll, { passive: true });
    return () => window.removeEventListener('scroll', handleScroll);
  }, [activeTab, layout.tables]);

  // Available slots for Slot Selector chips
  const slotChips = useMemo(() => {
    const chips = ['現在'];
    const times = new Set();
    for (const s of sessions) {
      if (s.start_time) times.add(s.start_time.slice(0, 5));
    }
    if (times.size === 0) {
      for (let h = 10; h <= 20; h++) {
        times.add(`${String(h).padStart(2, '0')}:00`);
      }
    }
    const sorted = [...times].sort();
    return [...chips, ...sorted];
  }, [sessions]);

  // Filtered bookings based on search query
  const filterBySearch = (list) => {
    if (!searchQuery.trim()) return list;
    const q = searchQuery.trim().toLowerCase();
    return list.filter(b => {
      const matchName = b.name && b.name.toLowerCase().includes(q);
      const matchPhone = b.phone && b.phone.includes(q);
      const matchRef = b.booking_ref && b.booking_ref.toLowerCase().includes(q);
      const matchNotes = (b.customer_note && b.customer_note.toLowerCase().includes(q)) ||
                         (b.admin_note && b.admin_note.toLowerCase().includes(q)) ||
                         (b.notes && b.notes.toLowerCase().includes(q));
      return matchName || matchPhone || matchRef || matchNotes;
    });
  };

  const searchedPending = useMemo(() => filterBySearch(pendingBookings), [pendingBookings, searchQuery]);
  const searchedCheckedIn = useMemo(() => filterBySearch(checkedInBookings), [checkedInBookings, searchQuery]);
  const searchedCompleted = useMemo(() => filterBySearch(completedBookings), [completedBookings, searchQuery]);

  // Timer controls
  const handleTimerAction = async (bookingRef, personNos, action, reason = null) => {
    try {
      await api.post(`/floor/${bookingRef}/timer`, {
        action,
        person_nos: personNos === 'all' ? 'all' : (Array.isArray(personNos) ? personNos : [Number(personNos)]),
        reason
      });
      await refresh();
      setPausePersonTarget(null);
      showToast('計時更新成功');
    } catch (err) {
      showToast(err.response?.data?.error || '計時操作失敗');
    }
  };

  // Move seat action
  const handleMoveSeat = async (bookingRef, fromSeat, toSeat, mode = 'move') => {
    try {
      await api.post(`/floor/${bookingRef}/move-seat`, {
        from_seat: fromSeat,
        to_seat: toSeat,
        mode
      });
      refresh();
      setSeatActionTarget(null);
      setMoveSeatModalTarget(null);
      setSwapConfirmTarget(null);
      showToast(`已換至座位 ${toSeat}`);
    } catch (err) {
      showToast(err.response?.data?.error || '換座位失敗');
    }
  };

  // Mark no-show
  const handleMarkNoShow = async (bookingRef) => {
    try {
      await api.patch(`/reservations/${bookingRef}/attendance`, { attendance: 'no_show' });
      showToast('已標記為未到');
      refresh();
    } catch (err) {
      showToast(err.response?.data?.error || '標記未到失敗');
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
      setSeatActionTarget({
        seat,
        seatInfo,
        booking: null
      });
    }
  };

  // Arrival status helper using formatOverdueText
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
      const overdue = formatOverdueText(lateMins);
      if (!overdue) {
        return {
          label: '準時到',
          pillClass: 'bg-sg-paper text-sg-ink border border-sg-line'
        };
      }
      return {
        label: overdue.text,
        pillClass: overdue.severity === 'danger'
          ? 'bg-sg-danger-soft text-sg-danger font-bold'
          : 'bg-sg-honey-soft text-sg-honey font-bold'
      };
    }
  };

  return (
    <div className="space-y-4 max-w-7xl mx-auto pb-12">
      {/* Toast Notification */}
      {toastMessage && (
        <div className="fixed top-4 right-4 z-50 bg-sg-ink text-white px-4 py-2.5 rounded-2xl shadow-lg text-[13px] font-bold flex items-center gap-2 animate-fade-in">
          <Sparkles className="w-4 h-4 text-sg-peach" />
          <span>{toastMessage}</span>
        </div>
      )}

      {/* Date Switcher Bar */}
      <div className="flex items-center justify-between bg-white px-4 py-2.5 rounded-3xl border border-sg-line shadow-xs">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setShowDatePicker(!showDatePicker)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-2xl bg-sg-paper/60 border border-sg-line hover:border-sg-brown text-[12px] font-bold text-sg-ink transition"
          >
            <Calendar className="w-3.5 h-3.5 text-sg-brown" />
            <span>{selectedDate}</span>
            <ChevronDown className={`w-3.5 h-3.5 text-sg-muted transition-transform ${showDatePicker ? 'rotate-180' : ''}`} />
          </button>
          {selectedDate !== todayStr && (
            <button
              type="button"
              onClick={() => {
                setSelectedDate(todayStr);
                setShowDatePicker(false);
              }}
              className="text-[11px] px-2.5 py-1 rounded-xl bg-sg-honey-soft text-sg-honey font-bold hover:underline"
            >
              回到今天
            </button>
          )}
        </div>

        <div className="text-[12px] text-sg-muted font-medium hidden sm:block">
          使用中 <span className="font-bold text-sg-ink font-num">{inUsePax}</span> 位 · 待入座 <span className="font-bold text-sg-ink font-num">{pendingPax}</span> 位 · 空位 <span className="font-bold text-sg-ink font-num">{emptySeatCount}</span> 個
        </div>
      </div>

      {/* DatePicker Dropdown / Strip */}
      {showDatePicker && (
        <div className="bg-white p-4 rounded-3xl border border-sg-line shadow-sm space-y-3 animate-fade-in">
          <div className="flex items-center justify-between">
            <span className="text-[13px] font-bold text-sg-ink">選擇帶位日期</span>
            <input
              type="date"
              value={selectedDate}
              onChange={(e) => {
                if (e.target.value) {
                  setSelectedDate(e.target.value);
                  setShowDatePicker(false);
                }
              }}
              className="px-3 py-1 text-[12px] border border-sg-line rounded-xl focus:border-sg-brown focus:outline-none"
            />
          </div>
          <DateStrip
            selectedDate={selectedDate}
            onSelectDate={(d) => {
              setSelectedDate(d);
              setShowDatePicker(false);
            }}
            sessionsByDate={{ [selectedDate]: sessions }}
          />
        </div>
      )}

      {/* Desktop Top Header & Summary */}
      <div className="hidden lg:flex items-center justify-between gap-3 bg-white p-4 rounded-3xl border border-sg-line shadow-xs">
        <div>
          <div className="text-[13px] text-sg-muted">
            全店使用中 <span className="font-bold text-sg-ink font-num">{inUsePax}</span> 位 · 待入座 <span className="font-bold text-sg-ink font-num">{pendingPax}</span> 位 · 空位 <span className="font-bold text-sg-ink font-num">{emptySeatCount}</span> 個
            {waitPax > 0 && <span className="ml-2 font-bold text-sg-brown font-num">· 等待區 {waitPax} 位</span>}
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

      {/* Desktop Filter Chips Bar */}
      <div className="hidden lg:flex items-center gap-2 overflow-x-auto pb-1">
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

      {/* Mobile Sticky Header (Tabs + Filter Chips + MiniMap when on floor tab) */}
      <div
        ref={mobileStickyHeaderRef}
        className="lg:hidden sticky top-0 z-20 bg-sg-bg/95 backdrop-blur-md pt-2 pb-2 space-y-2 border-b border-sg-line/50 shadow-xs"
      >
        <div className="flex items-center justify-between gap-2">
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
            <Plus className="w-4 h-4 mr-0.5 text-sg-brown" />
            加人
          </Button>
        </div>

        <div className="flex items-center gap-1.5 overflow-x-auto pb-0.5 no-scrollbar">
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
              className={`px-3 py-1 rounded-2xl text-[12px] font-bold whitespace-nowrap transition border ${
                filterMode === chip.key
                  ? 'bg-sg-brown text-white border-sg-brown'
                  : 'bg-white text-sg-ink border-sg-line'
              }`}
            >
              {chip.label}
            </button>
          ))}
        </div>

        {activeTab === 'floor' && (
          <div className="pt-1">
            <MiniMap
              layout={layout}
              seatStates={seatStatesMap}
              activeTableId={activeMobileTableId}
              onTableClick={handleMiniMapTableClick}
              waitingPaxCount={waitPax}
              waitPax={waitPax}
            />
          </div>
        )}
      </div>

      {/* TAB 1: LIST VIEW (名單) */}
      {activeTab === 'list' && (
        <div className="space-y-4">
          {/* Mobile Board Usage Summary (Spec 3.4) */}
          {boardUsage.length > 0 && (
            <div className="lg:hidden bg-sg-paper/80 border border-sg-line px-3.5 py-2 rounded-2xl flex items-center justify-between text-[12px] gap-2">
              <span className="text-sg-muted font-bold whitespace-nowrap shrink-0">智能板租借</span>
              <span className="font-bold text-sg-ink text-right break-words min-w-0">
                {boardUsage.map(bu => `${displayBoardName(bu.name)} ${bu.in_use}/${bu.total}`).join(' · ')}
              </span>
            </div>
          )}

          {/* Search Box (Spec 3.4) */}
          <div className="relative">
            <Search className="absolute left-3.5 top-2.5 w-4 h-4 text-sg-muted" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="搜尋姓名、電話、單號或備註..."
              className="w-full pl-9 pr-4 py-2 rounded-2xl border border-sg-line text-[13px] bg-white focus:outline-none focus:border-sg-brown shadow-2xs"
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => setSearchQuery('')}
                className="absolute right-3 top-2.5 text-sg-muted hover:text-sg-ink"
              >
                <X className="w-4 h-4" />
              </button>
            )}
          </div>

          {/* Section: 待入座 */}
          <div className="space-y-3">
            <h2 className="text-[14px] font-bold text-sg-ink flex items-center justify-between">
              <span>待入座 ({searchedPending.length})</span>
            </h2>

            {searchedPending.length === 0 ? (
              <div className="p-8 text-center bg-white rounded-3xl border border-sg-line text-[13px] text-sg-muted">
                {searchQuery ? '沒有符合搜尋條件的待入座顧客' : '目前沒有待入座的顧客'}
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                {searchedPending.map((b, idx) => {
                  const arrival = getArrivalStatus(b.start_at);
                  const isFirst = idx === 0;
                  const timeRangeStr = bookingTimeRange(b.start_at, b.end_at);
                  const seatsList = b.assigned_seats || [];
                  const isWaitOnly = seatsList.length > 0 && seatsList.every(s => s && s.startsWith('WAIT-'));
                  const seatText = seatsList.length > 0
                    ? (isWaitOnly ? '等待區' : seatsList.join('、'))
                    : '未排座';
                  const boardCount = (b.boards || []).length;
                  const boardText = boardCount > 0
                    ? ` · ${(b.boards || []).map(bd => (bd.segments?.[0]?.name ? displayBoardName(bd.segments[0].name) : '智能板')).join('、')} ×${boardCount}`
                    : '';

                  return (
                    <div
                      key={b.booking_ref}
                      data-booking-ref={b.booking_ref}
                      className="bg-white rounded-3xl border border-sg-line p-4 shadow-xs flex flex-col justify-between space-y-3"
                    >
                      <div>
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            <span className="font-bold text-[15px] text-sg-ink">{b.name}</span>
                            <span className="text-[13px] text-sg-muted">· {b.pax} 位</span>
                            {isWaitOnly && (
                              <span className="text-[11px] px-1.5 py-0.5 rounded bg-sg-brown-soft text-sg-brown font-bold">
                                等待區
                              </span>
                            )}
                          </div>
                          {arrival && (
                            <span className={`text-[11px] px-2 py-0.5 rounded-lg ${arrival.pillClass}`}>
                              {arrival.label}
                            </span>
                          )}
                        </div>

                        <div className="text-[12px] text-sg-muted mt-1 leading-relaxed">
                          {timeRangeStr} · 預定 {seatText}{boardText}
                        </div>

                        {/* Notes preview (Spec 3.4) */}
                        {b.customer_note && (
                          <div className="mt-2 flex items-center gap-1.5 text-[11px] text-sg-brown bg-sg-paper/80 px-2 py-1 rounded-xl truncate">
                            <MessageSquare className="w-3.5 h-3.5 flex-shrink-0" />
                            <span className="truncate">{b.customer_note}</span>
                          </div>
                        )}
                        {b.admin_note && (
                          <div className="mt-1 flex items-center gap-1.5 text-[11px] text-amber-900 bg-amber-50 px-2 py-1 rounded-xl truncate">
                            <Lock className="w-3.5 h-3.5 flex-shrink-0" />
                            <span className="truncate">{b.admin_note}</span>
                          </div>
                        )}
                      </div>

                      <div className="flex items-center justify-between pt-2 border-t border-sg-line">
                        <Button
                          variant={isFirst ? 'primary' : 'secondary'}
                          size="sm"
                          onClick={() => setCheckInTarget(b)}
                        >
                          報到並帶位
                        </Button>

                        <div className="relative">
                          <button
                            type="button"
                            onClick={() => setCardMenuBookingRef(cardMenuBookingRef === b.booking_ref ? null : b.booking_ref)}
                            className="p-1.5 rounded-xl hover:bg-sg-paper text-sg-muted hover:text-sg-ink"
                            title="更多操作"
                            aria-label="更多操作"
                          >
                            <MoreVertical className="w-4 h-4" />
                          </button>

                          {cardMenuBookingRef === b.booking_ref && (
                            <div className="absolute right-0 bottom-full mb-1 sm:bottom-auto sm:top-full sm:mt-1 w-36 bg-white border border-sg-line rounded-2xl shadow-lg z-30 py-1 text-[13px] animate-fade-in">
                              <button
                                type="button"
                                onClick={() => {
                                  setCardMenuBookingRef(null);
                                  setDetailsBookingRef(b.booking_ref);
                                }}
                                className="w-full text-left px-3 py-1.5 hover:bg-sg-paper text-sg-ink font-medium"
                              >
                                訂單詳情
                              </button>
                              <button
                                type="button"
                                onClick={() => {
                                  setCardMenuBookingRef(null);
                                  setLineMsgReservation(b);
                                }}
                                className="w-full text-left px-3 py-1.5 hover:bg-sg-paper text-sg-ink font-medium"
                              >
                                傳 LINE 訊息
                              </button>
                              <button
                                type="button"
                                onClick={() => {
                                  setCardMenuBookingRef(null);
                                  setExtendReservation(b);
                                }}
                                className="w-full text-left px-3 py-1.5 hover:bg-sg-paper text-sg-ink font-medium"
                              >
                                加時
                              </button>
                              <button
                                type="button"
                                onClick={() => {
                                  setCardMenuBookingRef(null);
                                  handleMarkNoShow(b.booking_ref);
                                }}
                                className="w-full text-left px-3 py-1.5 hover:bg-sg-paper text-sg-ink font-medium"
                              >
                                標記未到
                              </button>
                              <button
                                type="button"
                                onClick={() => {
                                  setCardMenuBookingRef(null);
                                  setCancelReservationTarget(b);
                                }}
                                className="w-full text-left px-3 py-1.5 hover:bg-sg-danger-soft text-sg-danger font-medium"
                              >
                                取消預約
                              </button>
                            </div>
                          )}
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
              <span>使用中 ({searchedCheckedIn.length})</span>
            </h2>

            {searchedCheckedIn.length === 0 ? (
              <div className="p-8 text-center bg-white rounded-3xl border border-sg-line text-[13px] text-sg-muted">
                {searchQuery ? '沒有符合搜尋條件的使用中顧客' : '目前沒有正在使用中的顧客'}
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                {searchedCheckedIn.map((b) => {
                  const timerPill = groupTimerPill(b, getServerNow());
                  const seatsList = b.assigned_seats || [];
                  const isWaitOnly = seatsList.length > 0 && seatsList.every(s => s && s.startsWith('WAIT-'));
                  const seatText = seatsList.length > 0
                    ? (isWaitOnly ? '等待區' : seatsList.join('、'))
                    : '未帶位';
                  const timeRangeStr = bookingTimeRange(b.start_at, b.end_at);

                  return (
                    <div
                      key={b.booking_ref}
                      data-booking-ref={b.booking_ref}
                      onClick={() => setTimerTarget(b)}
                      className="bg-white rounded-3xl border border-sg-line p-4 shadow-xs flex flex-col justify-between space-y-3 cursor-pointer hover:border-sg-brown transition"
                    >
                      <div>
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            <span className="font-bold text-[15px] text-sg-ink">{b.name}</span>
                            <span className="text-[13px] text-sg-muted">· {b.pax} 位</span>
                            {isWaitOnly && (
                              <span className="text-[11px] px-1.5 py-0.5 rounded bg-sg-brown-soft text-sg-brown font-bold">
                                等待區
                              </span>
                            )}
                          </div>
                          <div className="flex items-center gap-1.5">
                            <span className={`text-[11px] px-2 py-0.5 rounded-lg ${timerPill.pillClass}`}>
                              {timerPill.label}
                            </span>
                            <StatusPill status={b.billing?.status || 'unpaid'} />
                          </div>
                        </div>

                        {/* Unseated Warning Banner (Spec 3.2) */}
                        {b.needs_seating && (
                          <div className="mt-2 p-2.5 rounded-2xl bg-amber-50 border border-amber-200 text-amber-900 text-[12px] flex items-center justify-between">
                            <span className="font-bold">這組還沒帶位，沒有計時紀錄</span>
                            <Button
                              variant="primary"
                              size="sm"
                              onClick={(e) => {
                                e.stopPropagation();
                                setCheckInTarget(b);
                              }}
                            >
                              帶位並開始計時
                            </Button>
                          </div>
                        )}

                        <div className="text-[12px] text-sg-muted mt-1 leading-relaxed">
                          座位 {seatText} · {timeRangeStr}
                        </div>

                        {/* Notes preview (Spec 3.4) */}
                        {b.customer_note && (
                          <div className="mt-2 flex items-center gap-1.5 text-[11px] text-sg-brown bg-sg-paper/80 px-2 py-1 rounded-xl truncate">
                            <MessageSquare className="w-3.5 h-3.5 flex-shrink-0" />
                            <span className="truncate">{b.customer_note}</span>
                          </div>
                        )}
                        {b.admin_note && (
                          <div className="mt-1 flex items-center gap-1.5 text-[11px] text-amber-900 bg-amber-50 px-2 py-1 rounded-xl truncate">
                            <Lock className="w-3.5 h-3.5 flex-shrink-0" />
                            <span className="truncate">{b.admin_note}</span>
                          </div>
                        )}
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
                已離場 {searchedCompleted.length} 組
              </span>
              <ChevronDown className={`w-4 h-4 text-sg-muted transition-transform ${isCompletedExpanded ? 'rotate-180' : ''}`} />
            </button>

            {isCompletedExpanded && (
              <div className="p-4 divide-y divide-sg-line">
                {searchedCompleted.length === 0 ? (
                  <div className="py-4 text-center text-sg-muted text-[13px]">尚無已離場紀錄</div>
                ) : (
                  searchedCompleted.map((b) => (
                    <div key={b.booking_ref} className="py-2.5 flex items-center justify-between text-[13px]">
                      <div>
                        <span className="font-bold text-sg-ink mr-2">{b.name}</span>
                        <span className="text-sg-muted">{bookingTimeRange(b.start_at, b.end_at)} · {b.pax} 位</span>
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
          {/* Slot Selector Chips (Spec 3.4) */}
          <div className="flex items-center gap-1.5 overflow-x-auto pb-1 no-scrollbar -mx-1 px-1">
            <span className="text-[12px] font-bold text-sg-muted shrink-0 mr-1">時段：</span>
            {slotChips.map(slot => (
              <button
                key={slot}
                type="button"
                onClick={() => setSelectedSlot(slot)}
                className={`px-3 py-1 rounded-2xl text-[12px] font-bold whitespace-nowrap transition border ${
                  selectedSlot === slot
                    ? 'bg-sg-brown text-white border-sg-brown'
                    : 'bg-white text-sg-ink border-sg-line hover:border-sg-brown/50'
                }`}
              >
                {slot}
              </button>
            ))}
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-start">
            {/* Left: Floor canvas (Desktop / Tablet) */}
            <div className="hidden lg:block lg:col-span-8 bg-white p-4 rounded-3xl border border-sg-line shadow-xs space-y-4">
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
                  fitContainer={true}
                />
              </div>

              {/* Waiting Area Section (Desktop) */}
              <div id="waiting-area-section" className="bg-sg-paper/40 rounded-2xl border border-sg-line p-3.5 space-y-2.5">
                <div className="flex items-center justify-between">
                  <div className="font-bold text-[13px] text-sg-ink">
                    等待區 · {waitPax} 位 · 不佔座位
                  </div>
                  <span className="text-[11px] text-sg-muted">點選入座等待中的客人</span>
                </div>
                <div className="grid grid-cols-4 sm:grid-cols-6 gap-2">
                  {waitSlots.map((ws) => {
                    if (ws.occupied && ws.booking) {
                      const tm = ws.person?.timer || ws.person;
                      const isPaused = tm ? Boolean(tm.paused_at && !tm.timer_ended_at) : false;
                      const elapsedText = ws.person ? formatElapsedText(ws.person, getServerNow()) : '';
                      return (
                        <div
                          key={ws.code}
                          onClick={() => setCheckInTarget(ws.booking)}
                          className="p-2.5 rounded-xl border border-sg-brown bg-white cursor-pointer hover:border-sg-brown shadow-2xs transition text-left flex flex-col justify-between min-h-[64px]"
                        >
                          <div className="flex items-center justify-between">
                            <span className="text-[11px] font-bold text-sg-ink">{ws.label}</span>
                            <span className="text-[9px] px-1 py-0.5 rounded bg-sg-brown text-white font-bold">帶位</span>
                          </div>
                          <div>
                            <div className="text-[12px] font-bold text-sg-ink truncate">{ws.booking.name}</div>
                            <div className="text-[10px] text-sg-muted truncate">
                              {isPaused ? '已暫停' : elapsedText || '等待中'}
                            </div>
                          </div>
                        </div>
                      );
                    }
                    return (
                      <div
                        key={ws.code}
                        className="p-2.5 rounded-xl border border-dashed border-sg-line bg-gray-50/50 text-left flex flex-col justify-between min-h-[64px]"
                      >
                        <span className="text-[11px] font-medium text-sg-muted">{ws.label}</span>
                        <span className="text-[10px] text-sg-muted">空置</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>

            {/* Mobile Table Cards List */}
            <div className="lg:hidden space-y-5">
              {zoneGroupedTables.map((group) => (
                <div key={group.zone?.id || 'unzoned'} className="space-y-3">
                  <div className="bg-sg-paper/90 border border-sg-line px-3.5 py-2 rounded-2xl flex items-center justify-between text-[13px] font-bold text-sg-ink">
                    <div className="flex items-center gap-2">
                      <span>{group.zoneTitle}</span>
                      {group.zone?.note && (
                        <span className="text-[12px] text-sg-muted font-normal">{group.zone.note}</span>
                      )}
                    </div>
                    <div className="text-[12px] text-sg-muted">
                      使用中 <span className="font-bold text-sg-ink font-num">{group.inUseSeats}</span> / <span className="font-num">{group.totalSeats}</span> 位
                    </div>
                  </div>

                  <div className="space-y-3">
                    {group.tables.map((t) => {
                      const tableSeats = (layout.seats || []).filter(s => s.table_id === t.id);
                      return (
                        <TableCard
                          key={t.id}
                          table={t}
                          zoneName={group.zone?.name}
                          seats={tableSeats}
                          seatStates={seatStatesMap}
                          onSeatClick={handleSeatClick}
                          className={flashingTableId === t.id ? 'sg-flash-peach' : ''}
                        />
                      );
                    })}
                  </div>
                </div>
              ))}

              {/* Waiting Area Section (Mobile) */}
              <div id="waiting-area-section" className="bg-white rounded-3xl border border-sg-line p-4 shadow-xs space-y-3">
                <div className="flex items-center justify-between">
                  <div className="font-bold text-[14px] text-sg-ink">
                    等待區 · {waitPax} 位 · 不佔座位
                  </div>
                  <span className="text-[12px] text-sg-muted">點選入座等待中的客人</span>
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                  {waitSlots.map((ws) => {
                    if (ws.occupied && ws.booking) {
                      const tm = ws.person?.timer || ws.person;
                      const isPaused = tm ? Boolean(tm.paused_at && !tm.timer_ended_at) : false;
                      const elapsedText = ws.person ? formatElapsedText(ws.person, getServerNow()) : '';
                      return (
                        <div
                          key={ws.code}
                          onClick={() => setCheckInTarget(ws.booking)}
                          className="p-3 rounded-2xl border border-sg-brown bg-sg-paper/40 cursor-pointer hover:border-sg-brown transition text-left flex flex-col justify-between min-h-[72px]"
                        >
                          <div className="flex items-center justify-between">
                            <span className="text-[12px] font-bold text-sg-ink">{ws.label}</span>
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-sg-brown text-white font-bold">帶位</span>
                          </div>
                          <div>
                            <div className="text-[13px] font-bold text-sg-ink truncate">{ws.booking.name}</div>
                            <div className="text-[11px] text-sg-muted truncate">
                              {isPaused ? '已暫停' : elapsedText || '等待中'}
                            </div>
                          </div>
                        </div>
                      );
                    }
                    return (
                      <div
                        key={ws.code}
                        className="p-3 rounded-2xl border border-dashed border-sg-line bg-gray-50/50 text-left flex flex-col justify-between min-h-[72px]"
                      >
                        <span className="text-[12px] font-medium text-sg-muted">{ws.label}</span>
                        <span className="text-[11px] text-sg-muted">空置</span>
                      </div>
                    );
                  })}
                </div>
              </div>

              <div style={{ minHeight: 'calc(100vh - 280px)' }} />
            </div>

            {/* Right: Sidebar Overview or Table Details (Desktop) */}
            <div className="hidden lg:block lg:col-span-4 space-y-4">
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
                            <div className="font-bold text-sg-ink">{al.title || al.text}</div>
                            <div className="text-sg-muted">{al.subtitle || al.hint}</div>
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
                            <div className="text-sg-muted text-[11px]">{bookingTimeRange(b.start_at, b.end_at)}</div>
                          </div>
                          <Button
                            variant="secondary"
                            size="sm"
                            onClick={() => setCheckInTarget(b)}
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
              else setCheckInTarget(b);
            }}
            onEmptySlotClick={(seatCode, session) => {
              setForceAddInitialSessionId(session?.id);
              setShowForceAdd(true);
            }}
          />
        </div>
      )}

      {/* Shared CheckInPanel (Spec 3.2) */}
      <CheckInPanel
        isOpen={Boolean(checkInTarget)}
        onClose={() => setCheckInTarget(null)}
        target={checkInTarget}
        activeSeats={activeSeats}
        seatStatesMap={seatStatesMap}
        layout={floorData?.layout}
        onSuccess={(data, deferSeating) => {
          refresh();
          showToast(deferSeating ? '已報到，稍後再帶位' : '已入座，開始計時');
          if (data?.displaced_reservations?.length) {
            const displacedNames = data.displaced_reservations
              .map(d => `${d.name} (${d.new_seats?.join('、')})`)
              .join('、');
            showToast(`已自動改排其他預約：${displacedNames}`);
          }
        }}
      />

      {/* Timer Sheet (Spec 3.1, 3.2, 3.5) */}
      <ResponsivePanel
        isOpen={Boolean(timerTarget)}
        onClose={() => setTimerTarget(null)}
        title={`${timerTarget?.name} · ${timerTarget?.pax} 位`}
        footer={
          (() => {
            const activePersons = (timerTarget?.persons || []).filter(p => {
              const tm = p.timer || p;
              return Boolean((tm.timer_started_at || tm.billing_start_at) && !tm.timer_ended_at);
            });
            const isAnyRunning = activePersons.some(p => !(p.timer?.paused_at || p.paused_at));
            const isAllPaused = activePersons.length > 0 && activePersons.every(p => Boolean(p.timer?.paused_at || p.paused_at));
            const hasActive = activePersons.length > 0;

            return (
              <div className="flex items-center justify-between">
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={!hasActive}
                  onClick={() => {
                    handleTimerAction(
                      timerTarget.booking_ref,
                      'all',
                      isAllPaused ? 'resume' : 'pause',
                      isAllPaused ? null : '全組暫停'
                    );
                  }}
                >
                  {isAllPaused ? '全組繼續' : '全組暫停'}
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
                  結帳
                </Button>
              </div>
            );
          })()
        }
      >
        <div className="space-y-4 py-2">
          {/* Unseated Warning Banner (Spec 3.2) */}
          {timerTarget?.needs_seating && (
            <div className="p-3.5 rounded-2xl bg-amber-50 border border-amber-200 text-amber-900 text-[12px] flex items-center justify-between">
              <div>
                <div className="font-bold">這組還沒帶位，沒有計時紀錄</div>
                <div className="text-[11px] text-amber-700">請先為顧客安排座位以開始計時</div>
              </div>
              <Button
                variant="primary"
                size="sm"
                onClick={() => {
                  const b = timerTarget;
                  setTimerTarget(null);
                  setCheckInTarget(b);
                }}
              >
                帶位並開始計時
              </Button>
            </div>
          )}

          {/* Info KV */}
          <div className="grid grid-cols-2 gap-2 p-3 rounded-2xl bg-sg-paper/40 border border-sg-line text-[12px]">
            <div>
              <span className="text-sg-muted block">預約時段</span>
              <span className="font-bold text-sg-ink">
                {bookingDurationText(timerTarget)}
              </span>
            </div>
            <div>
              <span className="text-sg-muted block">入座座位</span>
              <span className="font-bold text-sg-ink">
                {timerTarget?.assigned_seats?.length > 0
                  ? (timerTarget.assigned_seats.every(s => s && s.startsWith('WAIT-')) ? '等待區' : timerTarget.assigned_seats.join('、'))
                  : '未分配'}
              </span>
            </div>
          </div>

          {/* Notes preview in timer sheet */}
          {timerTarget?.customer_note && (
            <div className="p-2.5 rounded-xl bg-sg-paper text-sg-brown text-[12px] flex items-start gap-2">
              <MessageSquare className="w-4 h-4 flex-shrink-0 mt-0.5" />
              <div>
                <span className="font-bold block text-[11px]">顧客備註</span>
                <span>{timerTarget.customer_note}</span>
              </div>
            </div>
          )}
          {timerTarget?.admin_note && (
            <div className="p-2.5 rounded-xl bg-amber-50 text-amber-900 text-[12px] flex items-start gap-2">
              <Lock className="w-4 h-4 flex-shrink-0 mt-0.5" />
              <div>
                <span className="font-bold block text-[11px]">內部備註</span>
                <span>{timerTarget.admin_note}</span>
              </div>
            </div>
          )}

          {/* Per-person timer list (Spec 3.1, 3.5) */}
          <div className="space-y-2">
            <span className="text-[13px] font-bold text-sg-ink block">每位計時</span>
            {(timerTarget?.persons || []).map((p) => {
              const tm = p.timer || p;
              const isPaused = Boolean(tm.paused_at && !tm.timer_ended_at);
              const isEnded = Boolean(tm.timer_ended_at);
              const elapsedMins = personElapsedMinutes(p, getServerNow());
              const seatLabel = p.seat_code
                ? (p.seat_code.startsWith('WAIT-') ? '等待區' : p.seat_code)
                : '未帶位';

              return (
                <div
                  key={p.person_no}
                  className="p-3 rounded-2xl border border-sg-line bg-white flex items-center justify-between"
                >
                  <div>
                    <div className="font-bold text-[14px] text-sg-ink">
                      第 {p.person_no} 位 ({seatLabel})
                    </div>
                    <div className="text-[12px] text-sg-muted">
                      {isEnded
                        ? `已離場 · 合計 ${formatTimerHMM(elapsedMins)}`
                        : isPaused
                        ? `已暫停 · ${tm.pause_reason || '外出用餐'}`
                        : `計時中 · 已計 ${formatTimerHMM(elapsedMins)}`}
                    </div>
                  </div>

                  <div className="flex items-center gap-1.5">
                    {!isEnded && (
                      <>
                        {isPaused ? (
                          <Button
                            variant="secondary"
                            size="sm"
                            onClick={() => handleTimerAction(timerTarget.booking_ref, [p.person_no], 'resume')}
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
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => {
                            setMoveSeatModalTarget({
                              booking: timerTarget,
                              fromSeat: p.seat_code,
                              personNo: p.person_no
                            });
                          }}
                        >
                          <ArrowRightLeft className="w-3.5 h-3.5 mr-1" />
                          換位
                        </Button>
                      </>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          <p className="text-[12px] text-sg-muted">
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
            handleTimerAction(timerTarget.booking_ref, [pausePersonTarget.person_no], 'pause', pauseReason);
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

      {/* Move Seat Modal (Spec 3.1 f, 3.3.4) */}
      <ResponsivePanel
        isOpen={Boolean(moveSeatModalTarget)}
        onClose={() => setMoveSeatModalTarget(null)}
        title="更換座位"
        subtitle={`${moveSeatModalTarget?.booking?.name} · 第 ${moveSeatModalTarget?.personNo} 位 (原座位 ${moveSeatModalTarget?.fromSeat || '無'})`}
      >
        <div className="space-y-4 py-2">
          {/* Waiting area shortcut */}
          <div className="p-3 rounded-2xl bg-sg-paper/60 border border-sg-line flex items-center justify-between">
            <div>
              <span className="font-bold text-[13px] text-sg-ink block">移至等待區</span>
              <span className="text-[11px] text-sg-muted">不佔座位，暫放候位（指派至 {nextEmptyWaitSeat}）</span>
            </div>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                if (moveSeatModalTarget) {
                  handleMoveSeat(
                    moveSeatModalTarget.booking.booking_ref,
                    moveSeatModalTarget.fromSeat,
                    nextEmptyWaitSeat,
                    'move'
                  );
                }
              }}
            >
              移到等待區
            </Button>
          </div>

          <div>
            <span className="text-[13px] font-bold text-sg-ink block mb-2">選擇目標實體座位</span>
            <div className="grid grid-cols-4 sm:grid-cols-6 gap-2">
              {activeSeats.map(s => {
                const isCurrent = s.code === moveSeatModalTarget?.fromSeat;
                const occupant = seatStatesMap[s.code]?.booking;
                const isOccupied = seatStatesMap[s.code]?.state === 'in_use';

                return (
                  <button
                    key={s.code}
                    type="button"
                    disabled={isCurrent}
                    onClick={() => {
                      if (!moveSeatModalTarget) return;
                      if (isOccupied && occupant) {
                        setSwapConfirmTarget({
                          bookingRef: moveSeatModalTarget.booking.booking_ref,
                          fromSeat: moveSeatModalTarget.fromSeat,
                          toSeat: s.code,
                          occupantName: occupant.name
                        });
                      } else {
                        handleMoveSeat(
                          moveSeatModalTarget.booking.booking_ref,
                          moveSeatModalTarget.fromSeat,
                          s.code,
                          'move'
                        );
                      }
                    }}
                    className={`p-2.5 rounded-xl border text-center transition ${
                      isCurrent
                        ? 'bg-gray-100 text-gray-400 border-sg-line cursor-not-allowed'
                        : isOccupied
                        ? 'bg-amber-50/60 border-amber-300 text-amber-900 hover:bg-amber-100'
                        : 'bg-white text-sg-ink border-sg-line hover:border-sg-brown'
                    }`}
                  >
                    <span className="block text-[13px] font-bold font-num">{s.code}</span>
                    <span className="block text-[10px] opacity-80">
                      {isCurrent ? '原位' : isOccupied ? '對調' : '空位'}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      </ResponsivePanel>

      {/* Swap Confirmation Modal */}
      <ConfirmPanel
        isOpen={Boolean(swapConfirmTarget)}
        onClose={() => setSwapConfirmTarget(null)}
        onConfirm={() => {
          if (swapConfirmTarget) {
            handleMoveSeat(
              swapConfirmTarget.bookingRef,
              swapConfirmTarget.fromSeat,
              swapConfirmTarget.toSeat,
              'swap'
            );
          }
        }}
        title="確認對調座位"
        message={`目標座位 ${swapConfirmTarget?.toSeat} 目前由「${swapConfirmTarget?.occupantName}」使用中。確定要進行互換對調嗎？`}
      />

      {/* Seat Action Panel (Spec 3.1, 3.3.4) */}
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
                  setDetailsBookingRef(seatActionTarget.booking.booking_ref);
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
                  handleTimerAction(b.booking_ref, [pNo], isPaused ? 'resume' : 'pause');
                  setSeatActionTarget(null);
                }}
              >
                {seatActionTarget.seatInfo?.state === 'paused' ? '繼續計時' : '暫停計時'}
              </Button>

              {/* Move Seat button */}
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  setMoveSeatModalTarget({
                    booking: seatActionTarget.booking,
                    fromSeat: seatActionTarget.seat?.code,
                    personNo: seatActionTarget.seatInfo?.personNo || 1
                  });
                  setSeatActionTarget(null);
                }}
              >
                <ArrowRightLeft className="w-3.5 h-3.5 mr-1" />
                換座位
              </Button>

              {/* Move to waiting area */}
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  const b = seatActionTarget.booking;
                  const fromSeat = seatActionTarget.seat?.code;
                  handleMoveSeat(b.booking_ref, fromSeat, nextEmptyWaitSeat, 'move');
                }}
              >
                移到等待區
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
                  setDetailsBookingRef(seatActionTarget.booking.booking_ref);
                  setSeatActionTarget(null);
                }}
              >
                訂單詳情
              </Button>
            </div>
          </div>
        ) : (
          <div className="py-4 text-center text-sg-muted text-[13px]">
            此座位目前為空位，可直接安排現場客人入座。
          </div>
        )}
      </ResponsivePanel>

      {/* Board Swap Sheet */}
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
          onPaymentSuccess={(data) => {
            const bRef = data?.booking_ref || checkoutBookingRef;
            const statusCode = data?.status?.code || data?.status?.status || (typeof data?.status === 'string' ? data.status : 'paid');
            if (bRef) {
              setFloorData?.(prev => {
                if (!prev?.bookings) return prev;
                return {
                  ...prev,
                  bookings: prev.bookings.map(b =>
                    b.booking_ref === bRef
                      ? { ...b, billing: { ...(b.billing || {}), status: statusCode } }
                      : b
                  )
                };
              });
            }
            refresh();
          }}
        />
      )}

      {/* Reservation Details Modal */}
      {detailsBookingRef && (
        <ReservationDetailsModal
          bookingRef={detailsBookingRef}
          onClose={() => setDetailsBookingRef(null)}
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
          onSuccess={(createdBooking, isWait) => {
            setShowForceAdd(false);
            refresh();
            if (createdBooking) {
              setCheckInTarget(createdBooking);
            } else {
              showToast(isWait ? '已放入等待區' : '現場加人成功');
            }
          }}
        />
      )}

      {/* Cancel Reservation Confirmation */}
      <ConfirmPanel
        isOpen={Boolean(cancelReservationTarget)}
        onClose={() => setCancelReservationTarget(null)}
        onConfirm={handleCancelReservation}
        title="取消預約"
        message={`確定要取消「${cancelReservationTarget?.name || '客人'}」的預約（${cancelReservationTarget?.booking_ref}）嗎？`}
      />

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
