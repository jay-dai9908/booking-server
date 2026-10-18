import React, { useState, useEffect, useMemo } from 'react';
import { format, addDays, startOfMonth, endOfMonth, startOfWeek, endOfWeek, isSameMonth, isSameDay, addMonths, subMonths, isBefore, startOfDay, getDay } from 'date-fns';
import { RefreshCw, Copy, Check, CalendarPlus } from 'lucide-react';
import api from '../../api/axios';
import { useNavigate } from 'react-router-dom';
import { calculateEquipmentChargeableHours } from '../../utils/equipmentPricing.js';
import { formatBookingRef, getGoogleCalendarUrl } from '../../components/CustomerReservationDetailsModal';

const GLOBAL_SETTINGS_CACHE_KEY = 'shiguang_booking_global_settings_cache';

const getInitialGlobalSettings = () => {
  try {
    const raw = localStorage.getItem(GLOBAL_SETTINGS_CACHE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        return {
          pricing: {
            weekday_hourly: Number(parsed.weekday_hourly) || 150,
            weekday_unlimited: Number(parsed.weekday_unlimited) || 750,
            weekend_hourly: Number(parsed.weekend_hourly) || 180,
            weekend_unlimited: Number(parsed.weekend_unlimited) || 1100
          },
          showPriceCards: parsed.showPriceCards !== false,
          priceNoticeText: parsed.priceNoticeText ?? '費用皆含基礎傳統拼豆板與豆子無限使用．預約現場保留 15 分鐘．離場前請預留 10 分鐘壓平作品',
          showAnnouncement: parsed.showAnnouncement !== false,
          announcementText: parsed.announcementText ?? '✨ 歡迎來到拾光製所！線上預約享即時選位，智能拼豆板租借滿時數再享買送折抵優惠',
          showLineButton: parsed.showLineButton !== false,
          lineButtonUrl: parsed.lineButtonUrl || 'https://lin.ee/vsZhRW5',
          isLoaded: true
        };
      }
    }
  } catch (e) {
    // ignore
  }

  return {
    pricing: {
      weekday_hourly: 150,
      weekday_unlimited: 750,
      weekend_hourly: 180,
      weekend_unlimited: 1100
    },
    showPriceCards: true,
    priceNoticeText: '費用皆含基礎傳統拼豆板與豆子無限使用．預約現場保留 15 分鐘．離場前請預留 10 分鐘壓平作品',
    showAnnouncement: true,
    announcementText: '✨ 歡迎來到拾光製所！線上預約享即時選位，智能拼豆板租借滿時數再享買送折抵優惠',
    showLineButton: true,
    lineButtonUrl: 'https://lin.ee/vsZhRW5',
    isLoaded: false
  };
};

function Booking() {
  const navigate = useNavigate();
  const [selectedDate, setSelectedDate] = useState(new Date());
  const [sessions, setSessions] = useState([]);
  const [selectedSessions, setSelectedSessions] = useState([]); // Array of selected sessions
  const [pax, setPax] = useState(1);
  const [loading, setLoading] = useState(false);
  const [showSplitModal, setShowSplitModal] = useState(false);
  const [splitBookingData, setSplitBookingData] = useState(null);
  const [isUnlimited, setIsUnlimited] = useState(false);
  const [showUnlimitedWarningModal, setShowUnlimitedWarningModal] = useState(false);
  const [confirmModalData, setConfirmModalData] = useState(null);
  const [alertModalData, setAlertModalData] = useState(null);
  const [ticketModalData, setTicketModalData] = useState(null);
  const [copiedTicketRef, setCopiedTicketRef] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [currentMonth, setCurrentMonth] = useState(startOfMonth(new Date()));

  // Global & Daily Pricing states (initialized from cache/DB defaults to eliminate flicker)
  const initialSettings = useMemo(() => getInitialGlobalSettings(), []);
  const [globalPricing, setGlobalPricing] = useState(initialSettings.pricing);
  const [showPriceCards, setShowPriceCards] = useState(initialSettings.showPriceCards);
  const [priceNoticeText, setPriceNoticeText] = useState(initialSettings.priceNoticeText);
  const [showAnnouncement, setShowAnnouncement] = useState(initialSettings.showAnnouncement);
  const [announcementText, setAnnouncementText] = useState(initialSettings.announcementText);
  const [showAnnouncementModal, setShowAnnouncementModal] = useState(false);
  const [showLineButton, setShowLineButton] = useState(initialSettings.showLineButton);
  const [lineButtonUrl, setLineButtonUrl] = useState(initialSettings.lineButtonUrl);
  const [isGlobalLoaded, setIsGlobalLoaded] = useState(initialSettings.isLoaded);
  const [dailyPricing, setDailyPricing] = useState({
    hourly: null,
    unlimited: null
  });
  const [userInfo, setUserInfo] = useState(null);
  const [monthOpenDatesSet, setMonthOpenDatesSet] = useState(new Set());

  // Generate calendar dates for the current month view
  const monthStart = startOfMonth(currentMonth);
  const monthEnd = endOfMonth(monthStart);
  const startDate = startOfWeek(monthStart);
  const endDate = endOfWeek(monthEnd);

  const calendarDays = [];
  let day = startDate;
  while (day <= endDate) {
    calendarDays.push(day);
    day = addDays(day, 1);
  }

  const [allowUnlimited, setAllowUnlimited] = useState(true);

  // Smart Pegboard (Equipment) state
  const [equipmentConfigs, setEquipmentConfigs] = useState([]);
  const [equipmentSelections, setEquipmentSelections] = useState({}); // { [id]: qty }
  const [rentalHours, setRentalHours] = useState(2);
  const [hasManuallyAdjustedRentalHours, setHasManuallyAdjustedRentalHours] = useState(false);
  const [enableSmartBoard, setEnableSmartBoard] = useState(false);
  const [allowExceedPax, setAllowExceedPax] = useState(false);
  const [showLiveStock, setShowLiveStock] = useState(true);
  const [equipmentDiscount, setEquipmentDiscount] = useState({
    enabled: true,
    buy_hours: 3,
    free_hours: 1,
    stackable: true,
    tier2_enabled: false,
    tier2_buy_hours: 8,
    tier2_free_hours: 4
  });

  // Calculate pricing based on selectedDate
  const isWeekend = [0, 6].includes(getDay(selectedDate));
  const effectiveHourlyPrice = (dailyPricing.hourly !== null && dailyPricing.hourly !== undefined && dailyPricing.hourly !== '')
    ? Number(dailyPricing.hourly)
    : (isWeekend ? Number(globalPricing.weekend_hourly || 180) : Number(globalPricing.weekday_hourly || 150));

  const effectiveUnlimitedPrice = (dailyPricing.unlimited !== null && dailyPricing.unlimited !== undefined && dailyPricing.unlimited !== '')
    ? Number(dailyPricing.unlimited)
    : (isWeekend ? Number(globalPricing.weekend_unlimited || 1100) : Number(globalPricing.weekday_unlimited || 750));

  // Calculate contiguous sessions
  const sortedSelectedSessions = useMemo(() => {
    return [...selectedSessions].sort((a, b) => a.start_time.localeCompare(b.start_time));
  }, [selectedSessions]);

  const mergedSelectedTimeBlocks = useMemo(() => {
    if (sortedSelectedSessions.length === 0) return [];
    const blocks = [];
    let currentBlock = null;
    for (const session of sortedSelectedSessions) {
      if (!currentBlock) {
        currentBlock = {
          start_time: session.start_time,
          end_time: session.end_time,
          sessions: [session]
        };
      } else {
        if (session.start_time === currentBlock.end_time) {
          currentBlock.end_time = session.end_time;
          currentBlock.sessions.push(session);
        } else {
          blocks.push(currentBlock);
          currentBlock = {
            start_time: session.start_time,
            end_time: session.end_time,
            sessions: [session]
          };
        }
      }
    }
    if (currentBlock) {
      blocks.push(currentBlock);
    }
    return blocks;
  }, [sortedSelectedSessions]);

  let maxContiguous = 0;
  let currentContiguous = 0;
  for (let i = 0; i < sortedSelectedSessions.length; i++) {
    if (i === 0) {
      currentContiguous = 1;
    } else {
      if (sortedSelectedSessions[i].start_time === sortedSelectedSessions[i - 1].end_time) {
        currentContiguous += 1;
      } else {
        currentContiguous = 1;
      }
    }
    if (currentContiguous > maxContiguous) {
      maxContiguous = currentContiguous;
    }
  }

  useEffect(() => {
    const fetchGlobal = async () => {
      try {
        const res = await api.get('/daily-settings/global');
        if (res.data) {
          const pricing = {
            weekday_hourly: Number(res.data.weekday_hourly_price) || 150,
            weekday_unlimited: Number(res.data.weekday_unlimited_price) || 750,
            weekend_hourly: Number(res.data.weekend_hourly_price) || 180,
            weekend_unlimited: Number(res.data.weekend_unlimited_price) || 1100
          };
          const cardsVisible = res.data.show_price_cards !== false;
          const notice = res.data.price_notice_text ?? '費用皆含基礎傳統拼豆板與豆子無限使用．預約現場保留 15 分鐘．離場前請預留 10 分鐘壓平作品';
          const announceVisible = res.data.show_announcement !== false;
          const announce = res.data.announcement_text ?? '✨ 歡迎來到拾光製所！線上預約享即時選位，智能拼豆板租借滿時數再享買送折抵優惠';
          const lineVisible = res.data.show_line_button !== false;
          const lineUrl = res.data.line_button_url || 'https://lin.ee/vsZhRW5';

          setGlobalPricing(pricing);
          setShowPriceCards(cardsVisible);
          setPriceNoticeText(notice);
          setShowAnnouncement(announceVisible);
          setAnnouncementText(announce);
          setShowLineButton(lineVisible);
          setLineButtonUrl(lineUrl);
          setIsGlobalLoaded(true);

          try {
            localStorage.setItem(GLOBAL_SETTINGS_CACHE_KEY, JSON.stringify({
              weekday_hourly: pricing.weekday_hourly,
              weekday_unlimited: pricing.weekday_unlimited,
              weekend_hourly: pricing.weekend_hourly,
              weekend_unlimited: pricing.weekend_unlimited,
              showPriceCards: cardsVisible,
              priceNoticeText: notice,
              showAnnouncement: announceVisible,
              announcementText: announce,
              showLineButton: lineVisible,
              lineButtonUrl: lineUrl
            }));
          } catch (e) {
            // ignore
          }
        }
      } catch (err) {
        console.error('Failed to fetch global pricing:', err);
      }
    };
    const fetchUser = async () => {
      try {
        const res = await api.get('/auth/me');
        if (res.data) setUserInfo(res.data);
      } catch (err) {
        // Guest or not logged in
      }
    };
    fetchGlobal();
    fetchUser();
  }, []);

  const fetchMonthSessions = async (monthDate = currentMonth) => {
    try {
      const mStart = format(startOfWeek(startOfMonth(monthDate)), 'yyyy-MM-dd');
      const mEnd = format(endOfWeek(endOfMonth(monthDate)), 'yyyy-MM-dd');
      const res = await api.get(`/sessions?start_date=${mStart}&end_date=${mEnd}`);
      if (Array.isArray(res.data)) {
        const set = new Set();
        res.data.forEach(s => {
          if (s.session_date) {
            set.add(format(new Date(s.session_date), 'yyyy-MM-dd'));
          }
        });
        setMonthOpenDatesSet(set);
      }
    } catch (err) {
      console.error('Failed to fetch month sessions for calendar:', err);
    }
  };

  useEffect(() => {
    fetchMonthSessions(currentMonth);
  }, [currentMonth]);

  useEffect(() => {
    fetchSessions(selectedDate);
    fetchDailySetting(selectedDate);
    setSelectedSessions([]);
    setIsUnlimited(false);
    setEquipmentSelections({});
    setEnableSmartBoard(false);
    setHasManuallyAdjustedRentalHours(false);
  }, [selectedDate]);

  useEffect(() => {
    const fetchEquipmentAvailability = async () => {
      if (selectedSessions.length === 0) {
        setEquipmentConfigs([]);
        return;
      }
      try {
        const formattedDate = format(selectedDate, 'yyyy-MM-dd');
        const sessionStarts = sortedSelectedSessions.map(s => s.start_time).join(',');
        const res = await api.get(`/equipment/availability?date=${formattedDate}&sessions=${sessionStarts}`);
        setEquipmentConfigs(res.data.equipments || (Array.isArray(res.data) ? res.data : []));
        setAllowExceedPax(!!res.data.allow_exceed_pax);
        setShowLiveStock(res.data.show_equipment_live_stock !== false);
        setEquipmentDiscount({
          enabled: res.data.equipment_discount_enabled !== false,
          buy_hours: res.data.equipment_discount_buy_hours ?? 3,
          free_hours: res.data.equipment_discount_free_hours ?? 1,
          stackable: res.data.equipment_discount_stackable !== false,
          tier2_enabled: !!res.data.equipment_discount2_enabled,
          tier2_buy_hours: res.data.equipment_discount2_buy_hours ?? 8,
          tier2_free_hours: res.data.equipment_discount2_free_hours ?? 4
        });
      } catch (err) {
        console.error('Failed to fetch equipment availability:', err);
      }
    };
    fetchEquipmentAvailability();
  }, [selectedDate, selectedSessions]);

  // Adjust rentalHours when maxContiguous changes (defaults to full duration unless manually adjusted)
  useEffect(() => {
    if (maxContiguous >= 2) {
      if (!hasManuallyAdjustedRentalHours) {
        setRentalHours(maxContiguous);
      } else {
        setRentalHours(prev => Math.min(Math.max(2, prev), maxContiguous));
      }
    } else {
      setRentalHours(2);
      setHasManuallyAdjustedRentalHours(false);
      if (enableSmartBoard) {
        setEnableSmartBoard(false);
        setEquipmentSelections({});
      }
    }
  }, [maxContiguous, hasManuallyAdjustedRentalHours]);

  const fetchDailySetting = async (date) => {
    try {
      const formattedDate = format(date, 'yyyy-MM-dd');
      const res = await api.get(`/daily-settings?date=${formattedDate}`);
      setAllowUnlimited(res.data.allow_unlimited);
      setDailyPricing({
        hourly: res.data.hourly_price,
        unlimited: res.data.unlimited_price
      });
    } catch (err) {
      console.error('Error fetching daily setting:', err);
    }
  };

  const fetchSessions = async (date) => {
    setLoading(true);
    try {
      const formattedDate = format(date, 'yyyy-MM-dd');
      const res = await api.get(`/sessions?date=${formattedDate}`);
      setSessions(res.data);
    } catch (err) {
      console.error(err);
      setAlertModalData({ type: 'error', title: '錯誤', message: '無法取得時段資料' });
    } finally {
      setLoading(false);
    }
  };

  const handleForceSync = async () => {
    setIsSyncing(true);
    await Promise.all([
      fetchSessions(selectedDate),
      fetchDailySetting(selectedDate)
    ]);
    setTimeout(() => setIsSyncing(false), 500);
  };

  const isSessionPast = (session) => {
    if (!isSameDay(selectedDate, new Date())) return false;
    const now = new Date();
    const [hours, minutes] = session.start_time.split(':').map(Number);
    const sessionTime = new Date();
    sessionTime.setHours(hours, minutes, 0, 0);
    return now >= sessionTime;
  };

  const applyUnlimitedMacro = (startSession) => {
    if (!startSession) return [];
    
    const startIndex = sessions.findIndex(s => s.id === startSession.id);
    if (startIndex === -1) return [];

    const newSelected = [];
    for (let i = startIndex; i < sessions.length; i++) {
      const s = sessions[i];
      if (s.remaining_capacity > 0 && !isSessionPast(s)) {
        newSelected.push(s);
      }
    }
    return newSelected;
  };

  const enableUnlimitedMode = () => {
    setIsUnlimited(true);
    setSelectedSessions(prev => {
      if (prev.length > 0) {
        // If sessions are already selected, use the earliest selected session as arrival time
        const sortedSelected = [...prev].sort((a, b) => a.start_time.localeCompare(b.start_time));
        return applyUnlimitedMacro(sortedSelected[0]);
      }
      // If no session selected yet, keep empty and let the customer click their expected arrival time
      return [];
    });
  };

  const toggleSession = (session) => {
    if (session.remaining_capacity === 0 || isSessionPast(session)) return;
    
    if (isUnlimited) {
      setSelectedSessions(prev => {
        // If nothing is selected yet, clicking this session selects it and all subsequent sessions to end of day
        if (prev.length === 0) {
          return applyUnlimitedMacro(session);
        }

        const isAlreadySelected = !!prev.find(s => s.id === session.id);
        if (isAlreadySelected) {
          // Allow customer to uncheck sessions (e.g. leaving earlier than closing, or adjusting times)
          return prev.filter(s => s.id !== session.id);
        } else {
          // If customer clicks an unselected session earlier than current start, extend from new arrival time
          const sorted = [...prev].sort((a, b) => a.start_time.localeCompare(b.start_time));
          const currentStart = sorted[0];
          if (currentStart && session.start_time < currentStart.start_time) {
            return applyUnlimitedMacro(session);
          }
          return [...prev, session];
        }
      });
      return;
    }

    setSelectedSessions(prev => {
      const isSelected = prev.find(s => s.id === session.id);
      
      if (isSelected) {
        return prev.filter(s => s.id !== session.id);
      } else {
        return [...prev, session];
      }
    });
  };

  // Calculate max available pax based on all selected sessions
  const maxAvailablePax = selectedSessions.length > 0 
    ? Math.min(...selectedSessions.map(s => s.remaining_capacity))
    : 0;

  // Ensure selected pax doesn't exceed the new max capacity
  useEffect(() => {
    if (selectedSessions.length > 0 && pax > maxAvailablePax) {
      setPax(maxAvailablePax > 0 ? maxAvailablePax : 1);
    }
  }, [selectedSessions, maxAvailablePax, pax]);

  const handleUnlimitedClick = () => {
    if (isUnlimited) {
      setIsUnlimited(false);
      return;
    }

    const hasFullSessions = sessions.some(s => s.remaining_capacity === 0);
    if (hasFullSessions) {
      setShowUnlimitedWarningModal(true);
    } else {
      enableUnlimitedMode();
    }
  };

  const visibleConfigs = equipmentConfigs.filter(c => c.visibility_status !== 'HIDDEN');
  const totalBoards = visibleConfigs.reduce((sum, c) => sum + (equipmentSelections[c.id] || 0), 0);

  // If pax drops and !allowExceedPax, clamp selections
  useEffect(() => {
    if (!allowExceedPax && totalBoards > pax) {
      let excess = totalBoards - pax;
      const newSel = { ...equipmentSelections };
      for (const c of [...visibleConfigs].reverse()) {
        const currentQty = newSel[c.id] || 0;
        if (currentQty > 0) {
          const deduction = Math.min(excess, currentQty);
          newSel[c.id] = currentQty - deduction;
          excess -= deduction;
          if (excess <= 0) break;
        }
      }
      setEquipmentSelections(newSel);
    }
  }, [pax, totalBoards, allowExceedPax]);

  const chargeableRentalHours = calculateEquipmentChargeableHours(
    rentalHours,
    equipmentDiscount
  );

  let totalEquipmentFee = 0;
  let totalOriginalEquipmentFee = 0;
  const breakdownParts = [];
  visibleConfigs.forEach(c => {
    const qty = equipmentSelections[c.id] || 0;
    if (qty > 0) {
      const singlePrice = (c.daily_cap && c.daily_cap > 0)
        ? Math.min(c.hourly_rate * chargeableRentalHours, c.daily_cap)
        : (c.hourly_rate * chargeableRentalHours);
      const originalSinglePrice = (c.daily_cap && c.daily_cap > 0)
        ? Math.min(c.hourly_rate * rentalHours, c.daily_cap)
        : (c.hourly_rate * rentalHours);

      totalEquipmentFee += singlePrice * qty;
      totalOriginalEquipmentFee += originalSinglePrice * qty;
      breakdownParts.push(`${c.name}×${qty}`);
    }
  });

  const discountHoursPerBoard = Math.max(0, rentalHours - chargeableRentalHours);
  const totalDiscountHours = totalBoards * discountHoursPerBoard;
  const totalSavedFee = Math.max(0, totalOriginalEquipmentFee - totalEquipmentFee);

  // Seating and Grand Total Pricing calculations
  const rawSeatingFee = pax * effectiveHourlyPrice * selectedSessions.length;
  const isCapped = allowUnlimited && (isUnlimited || (effectiveUnlimitedPrice > 0 && rawSeatingFee >= pax * effectiveUnlimitedPrice));
  const cappedSeatingFee = isCapped
    ? Math.min(rawSeatingFee, pax * effectiveUnlimitedPrice)
    : rawSeatingFee;
  const seatingPassDiscount = Math.max(0, rawSeatingFee - cappedSeatingFee);
  const estimatedGrandTotal = cappedSeatingFee + (enableSmartBoard ? totalEquipmentFee : 0);

  const handleBooking = () => {
    if (selectedSessions.length === 0) return;
    
    const timeRangeStr = mergedSelectedTimeBlocks.map(b => `${b.start_time} - ${b.end_time}`).join(', ');
    
    const activeEquipments = [];
    if (enableSmartBoard && maxContiguous >= 2) {
      visibleConfigs.forEach(c => {
        const qty = equipmentSelections[c.id] || 0;
        if (qty > 0) {
          activeEquipments.push({
            equipment_id: c.id,
            name: c.name,
            quantity: qty,
            rental_hours: rentalHours
          });
        }
      });
    }

    const promoDesc = equipmentDiscount.tier2_enabled
      ? `買${equipmentDiscount.buy_hours}送${equipmentDiscount.free_hours} / 買${equipmentDiscount.tier2_buy_hours}送${equipmentDiscount.tier2_free_hours}（金額擇優）`
      : `買${equipmentDiscount.buy_hours}送${equipmentDiscount.free_hours}`;

    const discountSummary = (equipmentDiscount.enabled && discountHoursPerBoard > 0)
      ? `（享「${promoDesc}」：每台折抵 ${discountHoursPerBoard} 小時，${totalBoards} 台共折抵 ${totalDiscountHours} 小時）`
      : '';

    const effectiveIsUnlimited = isUnlimited || isCapped;

    setConfirmModalData({
      date: format(selectedDate, 'yyyy-MM-dd'),
      timeRange: timeRangeStr,
      pax: pax,
      sortedSessions,
      isUnlimited: effectiveIsUnlimited,
      equipments: activeEquipments,
      totalEquipmentFee,
      estimatedGrandTotal,
      equipmentBreakdown: breakdownParts.length > 0 
        ? `${breakdownParts.join(' + ')}，共 ${totalBoards} 台 × ${rentalHours} 小時${discountSummary}`
        : null
    });
  };

  const executeBooking = async () => {
    const data = confirmModalData;
    setConfirmModalData(null);
    try {
      const res = await api.post('/reservations', {
        session_ids: data.sortedSessions.map(s => s.id),
        pax: parseInt(data.pax),
        isUnlimited: data.isUnlimited,
        equipments: data.equipments
      });
      
      const reservationData = res.data?.reservation || {};
      const newRef = reservationData.booking_ref || '';
      const assignedSeats = reservationData.assigned_seats || [];
      const finalAmount = reservationData.total_amount != null ? reservationData.total_amount : estimatedGrandTotal;

      setTicketModalData({
        booking_ref: newRef,
        date: data.date,
        timeRange: data.timeRange,
        pax: data.pax,
        assigned_seats: assignedSeats,
        isUnlimited: data.isUnlimited,
        equipments: data.equipments,
        total_amount: finalAmount
      });

      fetchSessions(selectedDate); // Refresh capacities
      setSelectedSessions([]);
      setEquipmentSelections({});
      setEnableSmartBoard(false);
    } catch (err) {
      if (err.response?.status === 409 && err.response?.data?.error?.includes('拆散')) {
        setSplitBookingData({
          session_ids: data.sortedSessions.map(s => s.id),
          pax: parseInt(data.pax),
          isUnlimited: data.isUnlimited,
          equipments: data.equipments
        });
        setShowSplitModal(true);
      } else {
        setAlertModalData({ type: 'error', title: '預約失敗', message: err.response?.data?.error || '可能人數已滿或時段已被預約' });
        fetchSessions(selectedDate);
      }
    }
  };

  const confirmSplitBooking = async () => {
    if (!splitBookingData) return;
    try {
      const res = await api.post('/reservations', {
        ...splitBookingData,
        forceSplit: true
      });

      const reservationData = res.data?.reservation || {};
      const newRef = reservationData.booking_ref || '';
      const assignedSeats = reservationData.assigned_seats || [];
      const finalAmount = reservationData.total_amount != null ? reservationData.total_amount : estimatedGrandTotal;

      const timeRange = mergedSelectedTimeBlocks.length > 0
        ? mergedSelectedTimeBlocks.map(b => `${b.start_time} - ${b.end_time}`).join(', ')
        : '';

      setTicketModalData({
        booking_ref: newRef,
        date: format(selectedDate, 'yyyy-MM-dd'),
        timeRange: timeRange,
        pax: splitBookingData.pax,
        assigned_seats: assignedSeats,
        isUnlimited: splitBookingData.isUnlimited,
        equipments: splitBookingData.equipments,
        total_amount: finalAmount
      });

      fetchSessions(selectedDate);
      setSelectedSessions([]);
      setEquipmentSelections({});
      setEnableSmartBoard(false);
      setShowSplitModal(false);
      setSplitBookingData(null);
    } catch (err) {
      setAlertModalData({ type: 'error', title: '預約失敗', message: err.response?.data?.error || '預約失敗' });
      setShowSplitModal(false);
      setSplitBookingData(null);
      fetchSessions(selectedDate);
    }
  };

  return (
    <div className="min-h-screen bg-wood-bg text-wood-textMain pb-24 font-sans transition-colors duration-300">
      {/* Top Announcement Banner */}
      {showAnnouncement && (
        <div 
          onClick={() => setShowAnnouncementModal(true)}
          className="bg-[#FAF4EB] hover:bg-[#F3E9DA] active:bg-[#EFE3D2] border-b border-[#E8DEC8] px-3 sm:px-4 py-2 text-xs text-[#8B5B43] font-medium transition-colors cursor-pointer select-none"
          title="點擊查看完整公告"
        >
          <div className="max-w-3xl mx-auto flex items-center justify-between gap-1.5 sm:gap-2">
            <div className="flex items-center gap-1.5 min-w-0 flex-1">
              <span className="shrink-0 font-bold flex items-center gap-1 text-[#6D432E]">
                <span>🔔</span>
                <span>系統公告：</span>
              </span>
              <span className="truncate text-left text-[#7A5038]">
                {announcementText || '✨ 歡迎來到拾光製所！線上預約享即時選位，智能拼豆板租借滿時數再享買送折抵優惠'}
              </span>
            </div>
            <span className="shrink-0 text-[11px] font-bold text-[#8B5B43] bg-[#F0E4D3] hover:bg-[#E5D7C2] px-2 py-0.5 rounded-full flex items-center gap-0.5 transition-colors">
              <span>詳情</span>
              <span className="text-[12px]">›</span>
            </span>
          </div>
        </div>
      )}

      {/* Header */}
      <header className="sticky top-0 z-40 bg-wood-bg/95 backdrop-blur-md border-b border-wood-border px-3 sm:px-4 py-3 mb-6 shadow-xs">
        <div className="max-w-3xl mx-auto flex justify-between items-center gap-2 sm:gap-4">
          <div className="flex items-center gap-2 sm:gap-3 min-w-0">
            <img 
              src="/logo.png" 
              alt="拾光製所 Logo" 
              className="w-9 h-9 sm:w-10 sm:h-10 object-cover rounded-full shrink-0 shadow-2xs border border-[#E8DEC8]" 
            />
            <div className="min-w-0 flex flex-col justify-center">
              <h1 className="text-sm sm:text-lg font-bold tracking-tight text-[#2C241E] whitespace-nowrap leading-tight">
                拾光製所
              </h1>
              <span className="text-[10px] sm:text-xs text-[#8C8279] font-medium whitespace-nowrap leading-tight block">
                拼豆時段預約系統
              </span>
            </div>
          </div>
          <div className="flex items-center gap-1.5 sm:gap-2.5 shrink-0">
            {userInfo?.name && (
              <span className="hidden md:inline-flex items-center gap-1 text-xs font-bold text-[#8B5B43] bg-[#F4EFE6] border border-[#E8DEC8] px-2.5 py-1 rounded-full">
                👤 {userInfo.name}
              </span>
            )}
            {showLineButton && (
              <a 
                href={lineButtonUrl || import.meta.env.VITE_LINE_OA_URL || 'https://lin.ee/vsZhRW5'} 
                target="_blank" 
                rel="noopener noreferrer"
                className="text-xs font-bold text-[#06C755] bg-emerald-50 hover:bg-emerald-100 border border-emerald-200 px-2 sm:px-3 py-1.5 rounded-full transition-colors flex items-center gap-1 shrink-0 shadow-2xs"
              >
                💬 官方 LINE
              </a>
            )}
            <button 
              onClick={() => navigate('/history')}
              className="whitespace-nowrap text-xs font-semibold text-[#4A3F35] bg-[#EDE6DD] hover:bg-[#DECFC1] px-2.5 sm:px-3.5 py-1.5 rounded-full transition-all duration-200 ease-in-out shrink-0 shadow-2xs"
            >
              預約紀錄
            </button>
            <button 
              onClick={() => { api.post('/auth/logout').then(() => window.location.href = '/') }}
              className="whitespace-nowrap text-xs font-medium text-[#8C8279] bg-transparent hover:bg-[#F4EFE6] hover:text-[#4A3F35] px-2 py-1.5 rounded-full transition-all duration-200 ease-in-out shrink-0"
            >
              登出
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-4 space-y-6">
        {/* Rates Quickview Dual Cards */}
        {showPriceCards && (
          <div className="space-y-2">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
              <div className="bg-wood-card p-4 rounded-2xl border border-wood-border shadow-warm">
                <div className="flex items-center justify-between mb-1.5">
                  <span className="font-bold text-sm text-[#3E332B] flex items-center gap-1.5">
                    ☕ 平日入場 (週一~週五)
                  </span>
                  <span className="text-xs bg-[#F4EFE6] text-[#8B5B43] font-bold px-2 py-0.5 rounded-full">
                    平日特惠
                  </span>
                </div>
                <p className="font-semibold text-sm text-[#8B5B43]">
                  每小時 NT$ {globalPricing.weekday_hourly} ｜ 不限時暢玩封頂 NT$ {globalPricing.weekday_unlimited} / 人
                </p>
              </div>

              <div className="bg-wood-card p-4 rounded-2xl border border-wood-border shadow-warm">
                <div className="flex items-center justify-between mb-1.5">
                  <span className="font-bold text-sm text-[#3E332B] flex items-center gap-1.5">
                    🌟 假日入場 (週六/週日)
                  </span>
                  <span className="text-xs bg-[#EDE6DD] text-[#4A3F35] font-bold px-2 py-0.5 rounded-full">
                    週末假日
                  </span>
                </div>
                <p className="font-semibold text-sm text-[#8B5B43]">
                  每小時 NT$ {globalPricing.weekend_hourly} ｜ 不限時暢玩封頂 NT$ {globalPricing.weekend_unlimited} / 人
                </p>
              </div>
            </div>
            <div className="text-[11px] text-[#8C8279] px-1 flex items-center gap-1.5">
              <span>💡</span>
              <span>{priceNoticeText || '費用皆含基礎傳統拼豆板與豆子無限使用．預約現場保留 15 分鐘．離場前請預留 10 分鐘壓平作品'}</span>
            </div>
          </div>
        )}

        {/* Date Selector */}
        <section className="bg-wood-card p-6 rounded-2xl shadow-warm">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-6">
            <div className="flex items-center gap-2.5">
              <h2 className="text-lg font-bold">1. 選擇日期</h2>
              <span className="text-xs font-bold text-[#8B5B43] bg-[#F4EFE6] px-2.5 py-1 rounded-full border border-[#E8DEC8]">
                已選：{format(selectedDate, 'yyyy-MM-dd')} ({isWeekend ? '假日' : '平日'})
              </span>
            </div>
            <div className="flex items-center gap-2 self-end sm:self-auto">
              <button onClick={() => setCurrentMonth(subMonths(currentMonth, 1))} className="p-2 text-wood-textMuted hover:text-wood-primary hover:bg-wood-bg/50 rounded-full transition-all">&lt;</button>
              <span className="font-bold tracking-wide">{format(currentMonth, 'yyyy年 MM月')}</span>
              <button onClick={() => setCurrentMonth(addMonths(currentMonth, 1))} className="p-2 text-wood-textMuted hover:text-wood-primary hover:bg-wood-bg/50 rounded-full transition-all">&gt;</button>
            </div>
          </div>

          <div className="grid grid-cols-7 gap-2 text-center mb-4">
            {['日', '一', '二', '三', '四', '五', '六'].map(dayName => (
              <div key={dayName} className="text-xs font-bold text-wood-textMuted py-1">{dayName}</div>
            ))}
          </div>
          
          <div className="grid grid-cols-7 gap-2">
            {calendarDays.map((date, i) => {
              const isSelected = isSameDay(date, selectedDate);
              const isCurrentMonth = isSameMonth(date, currentMonth);
              const isPast = isBefore(startOfDay(date), startOfDay(new Date()));
              const isToday = isSameDay(date, new Date());
              const dateStr = format(date, 'yyyy-MM-dd');
              const hasSessions = monthOpenDatesSet.has(dateStr);
              const isOpen = !isPast && isCurrentMonth && hasSessions;
              
              return (
                <div key={i} className="flex justify-center items-center aspect-square">
                  <button
                    disabled={isPast}
                    onClick={() => setSelectedDate(date)}
                    className={`w-9 h-9 sm:w-11 sm:h-11 rounded-full text-sm font-medium transition-all duration-200 flex flex-col items-center justify-center relative ${
                      !isCurrentMonth ? 'text-wood-border bg-transparent' : 
                      isPast ? 'text-wood-border cursor-not-allowed' :
                      isSelected ? 'bg-wood-primary text-white shadow-md transform scale-105' :
                      'text-wood-textMain hover:bg-[#F0EBE1] hover:text-wood-primary'
                    }`}
                  >
                    <span className="leading-none">{format(date, 'd')}</span>
                    {isToday ? (
                      <span className="flex items-center gap-0.5 mt-0.5">
                        <span className={`text-[8px] font-bold leading-none ${isSelected ? 'text-white/90' : 'text-[#8B5B43]'}`}>
                          今天
                        </span>
                        {isOpen && (
                          <span className={`w-1.5 h-1.5 rounded-full ${isSelected ? 'bg-white' : 'bg-emerald-500'}`} />
                        )}
                      </span>
                    ) : (
                      isOpen && (
                        <span className={`w-1.5 h-1.5 rounded-full ${isSelected ? 'bg-white' : 'bg-emerald-500'} mt-1`} />
                      )
                    )}
                  </button>
                </div>
              );
            })}
          </div>

          {!loading && sessions.length === 0 && (
            <div className="mt-4 p-3.5 bg-red-50 border border-red-200 rounded-xl flex items-center gap-2.5 text-xs text-red-800">
              <span className="text-base shrink-0">⚠️</span>
              <span>
                注意：您目前選取的日期 ({format(selectedDate, 'yyyy-MM-dd')}) 店家標記為「暫不開放預約 (或公休)」，請選擇其他開放日期。
              </span>
            </div>
          )}
        </section>

        {/* Time Selector */}
        <section className="bg-wood-card p-6 rounded-2xl shadow-warm">
          <div className="flex flex-col gap-4 mb-6">
            <div className="flex justify-between items-center gap-2">
              <h2 className="text-lg font-bold">2. 選擇時段 (可複選)</h2>
              {selectedSessions.length > 0 && (
                <span className="text-sm bg-wood-bg text-wood-primary px-3 py-1.5 rounded-full font-bold">
                  已選 {selectedSessions.length} 小時
                </span>
              )}
            </div>
            {sessions.length > 0 && allowUnlimited && (
              <div className="flex flex-col gap-2">
                <div 
                  onClick={handleUnlimitedClick}
                  className={`flex flex-row items-center justify-between bg-[#F9F7F3] border rounded-2xl px-4 py-3 cursor-pointer select-none transition-all duration-300 ${
                    isUnlimited ? 'border-[#8B5B43] bg-[#FAF4EB]' : 'border-transparent hover:bg-[#F3EFE9]'
                  }`}
                >
                  <div className="flex items-center gap-2.5">
                    <span className="text-[20px] leading-none">✨</span>
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="text-[15px] font-bold text-[#4A3F35]">
                          {isUnlimited ? '✨ 不限時暢玩模式已開啟！' : '開啟不限時暢玩'}
                        </span>
                      </div>
                      <div className="text-xs text-[#7A7067] font-medium mt-0.5">
                        {isUnlimited 
                          ? `享當日單人封頂上限 NT$ ${effectiveUnlimitedPrice}/人（原每小時 NT$ ${effectiveHourlyPrice}）`
                          : `玩滿時數享最高封頂 NT$ ${effectiveUnlimitedPrice}/人`}
                      </div>
                    </div>
                  </div>
                  
                  {/* Toggle Switch */}
                  <div className={`relative w-[44px] h-[24px] rounded-full transition-colors duration-300 shrink-0 ${isUnlimited ? 'bg-[#8B5B43]' : 'bg-[#D5CFC9]'}`}>
                    <div className={`absolute top-[2px] left-[2px] bg-white w-[20px] h-[20px] rounded-full shadow-sm transition-transform duration-300 ${isUnlimited ? 'translate-x-[20px]' : 'translate-x-0'}`}></div>
                  </div>
                </div>
                <span className="text-xs text-wood-textMuted font-medium px-2">
                  {isUnlimited
                    ? selectedSessions.length === 0
                      ? '👉 請點選您的「預計到店時段」，系統將為您自動勾選後續所有時段！'
                      : `* 已自 ${[...selectedSessions].sort((a, b) => a.start_time.localeCompare(b.start_time))[0]?.start_time} 自動勾選（可點擊任一時段微調提早離場或更改到店）`
                    : '* 請根據實際預計來店時間進行勾選（滿時數系統將自動套用封頂優惠）'}
                </span>
              </div>
            )}
          </div>
          
          {loading ? (
            <div className="text-center text-wood-textMuted py-8">載入中...</div>
          ) : sessions.length === 0 ? (
            <div className="text-center text-wood-textMuted py-8">此日期目前無開放時段</div>
          ) : (
            <div>
              <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
                {sessions.map(session => {
                  const isPast = isSessionPast(session);
                  const isFull = session.remaining_capacity === 0;
                  const isDisabled = isPast || isFull;
                  const isSelected = !!selectedSessions.find(s => s.id === session.id);
                  
                  return (
                    <button
                      key={session.id}
                      disabled={isDisabled}
                      onClick={() => toggleSession(session)}
                      className={`h-full py-3 px-2 rounded-xl border flex flex-col justify-center items-center transition-all duration-200 focus:outline-none focus:border-wood-primary ${
                        isPast
                          ? 'bg-[#F0EBE6] border-transparent text-[#A8A19A] cursor-not-allowed opacity-70'
                          : isFull 
                            ? 'bg-wood-bg/50 border-wood-border text-wood-border cursor-not-allowed opacity-70' 
                            : isSelected
                              ? 'border-wood-primary bg-wood-primary text-white shadow-md transform scale-105'
                              : 'bg-wood-card border-wood-border text-wood-textMain hover:border-wood-primary hover:text-wood-primary hover:bg-[#F9F6F0]'
                      }`}
                    >
                      <div className="flex items-center justify-center gap-1 font-bold mb-1 text-[15px] sm:text-base whitespace-nowrap">
                        <span>{session.start_time}~{session.end_time}</span>
                        {isSelected && <span className="text-xs font-black">✓</span>}
                      </div>
                      <div className={`text-xs font-medium ${isPast ? 'text-[#A8A19A]' : isFull ? 'text-red-400/70' : isSelected ? 'text-white/90' : 'text-wood-sageText'}`}>
                        {isPast ? '已逾時' : isFull ? '已額滿' : `剩餘 ${session.remaining_capacity} 人`}
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </section>

        {/* Pax and Equipment */}
        {selectedSessions.length > 0 && maxAvailablePax > 0 && (
          <section className="bg-wood-card p-6 rounded-2xl shadow-warm animate-fade-in-up space-y-6">
            <div>
              <h2 className="text-lg font-bold mb-4">3. 確認預約人數與智能拼豆板加購</h2>
              <div className="flex flex-col gap-4">
                <div className="w-full">
                  <label className="block text-sm text-wood-textMuted mb-2">
                    預約人數 <span className="opacity-70">(最多 {maxAvailablePax} 人)</span>
                  </label>
                  <div className="flex items-center justify-between bg-[#F9F7F3] border border-[#D5CFC9] rounded-xl p-2 w-full max-w-[200px]">
                    <button
                      onClick={() => setPax(Math.max(1, pax - 1))}
                      disabled={pax <= 1}
                      className="w-9 h-9 flex items-center justify-center rounded-lg border border-[#D5CFC9] text-[#8B5B43] bg-white transition-all duration-200 hover:bg-[#F0EBE1] disabled:opacity-30 disabled:border-gray-300 disabled:text-gray-400 disabled:cursor-not-allowed disabled:hover:bg-white"
                    >
                      <svg className="w-5 h-5 font-bold" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M20 12H4"></path></svg>
                    </button>
                    <div className="w-16 text-center text-[17px] font-bold text-[#3E332B] flex items-center justify-center">
                      {pax} 人
                    </div>
                    <button
                      onClick={() => setPax(Math.min(maxAvailablePax, pax + 1))}
                      disabled={pax >= maxAvailablePax}
                      className="w-9 h-9 flex items-center justify-center rounded-lg border border-[#D5CFC9] text-[#8B5B43] bg-white transition-all duration-200 hover:bg-[#F0EBE1] disabled:opacity-30 disabled:border-gray-300 disabled:text-gray-400 disabled:cursor-not-allowed disabled:hover:bg-white"
                    >
                      <svg className="w-5 h-5 font-bold" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M12 4v16m8-8H4"></path></svg>
                    </button>
                  </div>

                  {/* Quick Pax Pills */}
                  <div className="mt-3 flex items-center gap-1.5 flex-wrap">
                    <span className="text-xs text-[#8C8279] font-bold">常用：</span>
                    {[1, 2, 3, 4, 6, 8].map(num => {
                      const isDisabled = num > maxAvailablePax;
                      const isActive = pax === num;
                      return (
                        <button
                          key={num}
                          type="button"
                          disabled={isDisabled}
                          onClick={() => setPax(num)}
                          className={`text-xs px-3 py-1 rounded-full font-bold transition-all ${
                            isActive
                              ? 'bg-[#8B5B43] text-white shadow-2xs'
                              : isDisabled
                                ? 'bg-gray-100 text-gray-300 cursor-not-allowed border border-gray-200'
                                : 'bg-[#FAF7F2] text-[#6D5D52] hover:bg-[#F0EBE1] border border-[#D5CFC9]'
                          }`}
                        >
                          {num}位
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>
            </div>

            {/* Smart Pegboard Section (Only rendered if there are visible configs) */}
            {visibleConfigs.length > 0 && (
              <div className="pt-4 border-t border-[#E8DEC8]/80 space-y-4">
                {/* Free baseline benefit banner */}
                <div className="bg-[#FAF7F2] border border-[#E8DEC8] rounded-xl p-3.5 flex items-start gap-2.5 text-xs text-[#6B5A4E] leading-relaxed">
                  <span className="text-base shrink-0">💡</span>
                  <div>每位入場皆免費提供「一般傳統拼豆板」；同行者中僅需使用「智能拼豆板」的人員依實際需要裝置數加購即可（不必全員加購）。</div>
                </div>

                {/* State: Less than 2 contiguous hours */}
                {maxContiguous < 2 ? (
                  <div className="border-2 border-dashed border-amber-300/80 bg-amber-50/50 rounded-2xl p-4 sm:p-5 relative transition-all">
                    <div className="flex items-center justify-between mb-2">
                      <span className="font-bold text-sm text-[#4A3F35] flex items-center gap-1.5">
                        <span>⚙️</span> 智能拼豆板租賃 (Smart Pegboard)
                      </span>
                      <span className="text-xs font-bold text-amber-800 bg-amber-100 border border-amber-200 px-2.5 py-1 rounded-full">
                        🔒 需連續 2 時段
                      </span>
                    </div>
                    <div className="text-xs text-amber-900 bg-amber-100/70 p-3 rounded-xl border border-amber-200/60 leading-relaxed font-medium">
                      ⚠️ 時段條件未滿足：加購/租用智能拼豆板需至少預約「連續 2 個時段 (2 小時)」。目前所選最長連續時段為 {maxContiguous} 個，暫無法勾選加購。
                    </div>
                  </div>
                ) : (
                  /* State: 2 or more contiguous hours available */
                  <div className="border border-[#E8DEC8] bg-[#FAF8F5] rounded-2xl p-4 sm:p-5 space-y-4">
                    <div 
                      onClick={() => {
                        const next = !enableSmartBoard;
                        setEnableSmartBoard(next);
                        if (!next) {
                          setEquipmentSelections({});
                          setHasManuallyAdjustedRentalHours(false);
                        } else {
                          if (!hasManuallyAdjustedRentalHours) {
                            setRentalHours(maxContiguous);
                          }
                        }
                      }}
                      className="flex items-center justify-between cursor-pointer select-none"
                    >
                      <div className="flex items-center gap-2">
                        <span className="text-lg">⚙️</span>
                        <span className="text-[15px] font-bold text-[#4A3F35]">
                          加購/租用智能拼豆板 (Smart Pegboard)
                        </span>
                      </div>
                      <div className={`relative w-[44px] h-[24px] rounded-full transition-colors duration-300 shrink-0 ${enableSmartBoard ? 'bg-[#8B5B43]' : 'bg-[#D5CFC9]'}`}>
                        <div className={`absolute top-[2px] left-[2px] bg-white w-[20px] h-[20px] rounded-full shadow-sm transition-transform duration-300 ${enableSmartBoard ? 'translate-x-[20px]' : 'translate-x-0'}`}></div>
                      </div>
                    </div>

                    {enableSmartBoard && (
                      <div className="pt-3 border-t border-[#E8DEC8]/60 space-y-4">
                        {/* Quota & Live Stock Info */}
                        <div className="space-y-2">
                          <div className="bg-[#EDE6DD] text-[#4A3F35] px-3.5 py-2 rounded-xl text-xs sm:text-sm font-bold flex items-center gap-2">
                            <span>👥</span>
                            <span>
                              本單預約 {pax} 人：目前已選購 {totalBoards} 台智能板
                              （{allowExceedPax ? '可依需求多選' : `尚可為同行者加選 ${Math.max(0, pax - totalBoards)} 台，其餘人員使用免費傳統板`}）
                            </span>
                          </div>
                          
                          {/* Live stock pills */}
                          {showLiveStock && (
                            <div className="text-[11px] sm:text-xs text-[#7A7067] bg-white/70 border border-[#E8DEC8] px-3 py-2 rounded-xl flex items-center flex-wrap gap-2">
                              <span className="font-bold text-[#8B5B43]">✨ 即時庫存狀況：</span>
                              {visibleConfigs.filter(c => c.id !== 'bring_own').map(c => (
                                <span key={c.id} className="bg-[#FAF7F2] px-2 py-0.5 rounded border border-[#E5DFD7]">
                                  {c.name} : <strong className={c.available_qty === 0 ? 'text-red-500' : 'text-[#3E332B]'}>{c.available_qty}</strong> / {c.total_stock} 個可用
                                </span>
                              ))}
                            </div>
                          )}

                          {/* Promotional Banner */}
                          {equipmentDiscount.enabled && (
                            <div className="bg-[#FAF4EB] border border-[#E8DEC8] px-3.5 py-2.5 rounded-xl text-xs sm:text-sm font-bold flex flex-col sm:flex-row sm:items-center justify-between gap-2 shadow-2xs">
                              <div className="flex items-center gap-2 text-[#8B5B43]">
                                <span className="text-base">🎁</span>
                                <div>
                                  <span>
                                    智能拼豆板時間優惠：<strong>買 {equipmentDiscount.buy_hours} 送 {equipmentDiscount.free_hours}</strong>
                                    {equipmentDiscount.tier2_enabled && (
                                      <span> ｜ <strong>買 {equipmentDiscount.tier2_buy_hours} 送 {equipmentDiscount.tier2_free_hours}</strong></span>
                                    )}
                                  </span>
                                  <span className="text-xs text-[#7A7067] font-normal ml-1 hidden sm:inline">
                                    {equipmentDiscount.tier2_enabled 
                                      ? '（每台獨立計算，系統自動依時數金額擇優計價）'
                                      : `（每台獨立計算：租滿 ${equipmentDiscount.buy_hours} 小時享 ${equipmentDiscount.free_hours} 小時免費）`}
                                  </span>
                                </div>
                              </div>
                              {totalBoards > 0 && discountHoursPerBoard > 0 ? (
                                <span className="bg-[#8B5B43] text-white text-[11px] px-2.5 py-1 rounded-full font-bold shrink-0 self-start sm:self-auto">
                                  每台折抵 {discountHoursPerBoard}hr（{totalBoards} 台共折抵 {totalDiscountHours} 小時，省 NT${totalSavedFee}）
                                </span>
                              ) : discountHoursPerBoard > 0 ? (
                                <span className="bg-[#8B5B43] text-white text-[11px] px-2 py-0.5 rounded-full font-bold shrink-0 self-start sm:self-auto">
                                  每台享折抵 {discountHoursPerBoard} 小時
                                </span>
                              ) : (
                                <span className="text-amber-800 bg-amber-50 border border-amber-200 text-[11px] px-2 py-0.5 rounded-full font-bold shrink-0 self-start sm:self-auto">
                                  {equipmentDiscount.tier2_enabled
                                    ? `租滿享買 ${equipmentDiscount.buy_hours} 送 ${equipmentDiscount.free_hours} 或買 ${equipmentDiscount.tier2_buy_hours} 送 ${equipmentDiscount.tier2_free_hours} 最優計價`
                                    : `租滿 ${equipmentDiscount.buy_hours} 小時享 ${equipmentDiscount.free_hours} 小時免費`}
                                </span>
                              )}
                            </div>
                          )}
                        </div>

                        {/* Equipment Rental Items (S, M, L) */}
                        <div className="space-y-3">
                          {visibleConfigs.filter(c => c.id !== 'bring_own').map(c => {
                            const qty = equipmentSelections[c.id] || 0;
                            const isMaintenance = c.visibility_status === 'MAINTENANCE';
                            const isOutOfStock = !isMaintenance && c.available_qty <= 0;
                            const maxAllowedForThis = allowExceedPax 
                              ? (c.available_qty || 0)
                              : Math.min(c.available_qty || 0, qty + Math.max(0, pax - totalBoards));

                            return (
                              <div 
                                key={c.id}
                                className={`p-3.5 rounded-xl border flex flex-col sm:flex-row sm:items-center justify-between gap-3 transition-all ${
                                  isMaintenance 
                                    ? 'bg-[#F2EFE9] border-[#DED7CE] opacity-75' 
                                    : qty > 0 
                                      ? 'bg-white border-[#8B5B43] shadow-sm' 
                                      : 'bg-white/80 border-[#E5DFD7]'
                                }`}
                              >
                                <div>
                                  <div className="flex items-center gap-2 flex-wrap">
                                    <span className="font-bold text-[15px] text-[#3E332B]">🧩 {c.name}</span>
                                    <span className="text-xs bg-[#F4EFE6] text-[#8B5B43] font-bold px-2 py-0.5 rounded">
                                      NT$ {c.hourly_rate} /時
                                    </span>
                                    {c.daily_cap && c.daily_cap > 0 && (
                                      <span className="text-xs text-[#8C8279]">
                                        (單台日上限 NT${c.daily_cap})
                                      </span>
                                    )}
                                  </div>
                                  {isMaintenance && (
                                    <div className="text-xs text-amber-700 font-bold mt-1">
                                      🔧 {c.status_note || '設備維護中，暫停借用'}
                                    </div>
                                  )}
                                </div>

                                {/* Counter */}
                                <div className="flex items-center gap-2 shrink-0 self-end sm:self-auto">
                                  <span className="text-xs text-[#8C8279]">
                                    {isMaintenance ? '暫停借用' : isOutOfStock ? '時段已滿' : `庫存剩 ${c.available_qty}`}
                                  </span>
                                  <div className="flex items-center bg-[#F9F7F3] border border-[#D5CFC9] rounded-lg p-1">
                                    <button
                                      type="button"
                                      disabled={isMaintenance || qty <= 0}
                                      onClick={() => setEquipmentSelections(prev => ({ ...prev, [c.id]: Math.max(0, qty - 1) }))}
                                      className="w-7 h-7 flex items-center justify-center rounded bg-white text-[#8B5B43] font-bold disabled:opacity-30 disabled:cursor-not-allowed hover:bg-[#F0EBE1] transition-colors"
                                    >
                                      -
                                    </button>
                                    <span className="w-10 text-center font-bold text-sm text-[#3E332B]">
                                      {qty} 台
                                    </span>
                                    <button
                                      type="button"
                                      disabled={isMaintenance || isOutOfStock || qty >= maxAllowedForThis}
                                      onClick={() => setEquipmentSelections(prev => ({ ...prev, [c.id]: qty + 1 }))}
                                      className="w-7 h-7 flex items-center justify-center rounded bg-white text-[#8B5B43] font-bold disabled:opacity-30 disabled:cursor-not-allowed hover:bg-[#F0EBE1] transition-colors"
                                    >
                                      +
                                    </button>
                                  </div>
                                </div>
                              </div>
                            );
                          })}
                        </div>

                        {/* Bring Own Smart Pegboard Option */}
                        {visibleConfigs.some(c => c.id === 'bring_own') && (() => {
                          const bringOwnConfig = visibleConfigs.find(c => c.id === 'bring_own');
                          const qty = equipmentSelections['bring_own'] || 0;
                          const isMaintenance = bringOwnConfig.visibility_status === 'MAINTENANCE';
                          const maxAllowed = allowExceedPax ? 99 : (qty + Math.max(0, pax - totalBoards));

                          return (
                            <div className={`p-4 rounded-xl border flex flex-col sm:flex-row sm:items-center justify-between gap-3 ${
                              qty > 0 ? 'bg-white border-[#8B5B43] shadow-sm' : 'bg-white/60 border-[#E5DFD7]'
                            }`}>
                              <div className="max-w-md">
                                <div className="flex items-center gap-2 mb-1">
                                  <span className="font-bold text-[15px] text-[#3E332B]">✨ 自帶智能拼豆板 (Bring Own)</span>
                                  <span className="text-xs bg-[#F4EFE6] text-[#8B5B43] font-bold px-2 py-0.5 rounded">
                                    NT$ {bringOwnConfig.hourly_rate} /時
                                  </span>
                                  {bringOwnConfig.daily_cap && bringOwnConfig.daily_cap > 0 && (
                                    <span className="text-xs text-[#8C8279]">
                                      (上限 NT${bringOwnConfig.daily_cap})
                                    </span>
                                  )}
                                </div>
                                <p className="text-xs text-[#8C8279] leading-relaxed">
                                  同行者中若有自備智能拼豆板至店內使用，請選擇實際自備台數（每台每小時 NT$ 50，單台當日收費上限 NT$ 400）。
                                </p>
                              </div>
                              
                              <div className="flex items-center gap-2 shrink-0 self-end sm:self-auto">
                                <div className="flex items-center bg-[#F9F7F3] border border-[#D5CFC9] rounded-lg p-1">
                                  <button
                                    type="button"
                                    disabled={isMaintenance || qty <= 0}
                                    onClick={() => setEquipmentSelections(prev => ({ ...prev, bring_own: Math.max(0, qty - 1) }))}
                                    className="w-7 h-7 flex items-center justify-center rounded bg-white text-[#8B5B43] font-bold disabled:opacity-30 disabled:cursor-not-allowed hover:bg-[#F0EBE1] transition-colors"
                                  >
                                    -
                                  </button>
                                  <span className="w-10 text-center font-bold text-sm text-[#3E332B]">
                                    {qty} 台
                                  </span>
                                  <button
                                    type="button"
                                    disabled={isMaintenance || qty >= maxAllowed}
                                    onClick={() => setEquipmentSelections(prev => ({ ...prev, bring_own: qty + 1 }))}
                                    className="w-7 h-7 flex items-center justify-center rounded bg-white text-[#8B5B43] font-bold disabled:opacity-30 disabled:cursor-not-allowed hover:bg-[#F0EBE1] transition-colors"
                                  >
                                    +
                                  </button>
                                </div>
                              </div>
                            </div>
                          );
                        })()}

                        {/* Rental Hours Selector */}
                        {totalBoards > 0 && (
                          <div className="bg-white/80 border border-[#E5DFD7] rounded-xl p-3.5 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                            <div>
                              <div className="flex items-center gap-2 flex-wrap">
                                <span className="font-bold text-sm text-[#3E332B]">🕒 使用時數 (至少 2 小時)</span>
                                <span className="text-[11px] font-bold text-[#8B5B43] bg-[#F4EFE6] px-2 py-0.5 rounded">
                                  最少 2 小時
                                </span>
                                {equipmentDiscount.enabled && discountHoursPerBoard > 0 && (
                                  <span className="text-[11px] font-bold text-emerald-800 bg-emerald-50 border border-emerald-200 px-2 py-0.5 rounded">
                                    享買{customerBuyHours}送{equipmentDiscount.free_hours}：每台實計 {chargeableRentalHours} 小時（各免收 {discountHoursPerBoard} 小時）
                                  </span>
                                )}
                              </div>
                              <span className="text-xs text-[#8C8279]">
                                上限為本次預約最長連續時數 ({maxContiguous} 小時)
                              </span>
                            </div>

                            <div className="flex items-center bg-[#F9F7F3] border border-[#D5CFC9] rounded-lg p-1 self-end sm:self-auto">
                              <button
                                type="button"
                                disabled={rentalHours <= 2}
                                onClick={() => {
                                  setHasManuallyAdjustedRentalHours(true);
                                  setRentalHours(h => Math.max(2, h - 1));
                                }}
                                className="w-7 h-7 flex items-center justify-center rounded bg-white text-[#8B5B43] font-bold disabled:opacity-30 disabled:cursor-not-allowed hover:bg-[#F0EBE1] transition-colors"
                              >
                                -
                              </button>
                              <span className="w-16 text-center font-bold text-sm text-[#3E332B]">
                                {rentalHours} 小時
                              </span>
                              <button
                                type="button"
                                disabled={rentalHours >= maxContiguous}
                                onClick={() => {
                                  setHasManuallyAdjustedRentalHours(true);
                                  setRentalHours(h => Math.min(maxContiguous, h + 1));
                                }}
                                className="w-7 h-7 flex items-center justify-center rounded bg-white text-[#8B5B43] font-bold disabled:opacity-30 disabled:cursor-not-allowed hover:bg-[#F0EBE1] transition-colors"
                              >
                                +
                              </button>
                            </div>
                          </div>
                        )}

                        {/* Subtotal Display */}
                        {totalBoards > 0 && (
                          <div className="bg-[#FAF7F2] border border-[#E8DEC8] rounded-xl p-3.5 flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                            <div className="text-xs text-[#6B5A4E]">
                              <div className="flex items-center gap-2 flex-wrap mb-0.5">
                                <span className="font-bold text-sm text-[#4A3F35]">
                                  拼豆板加購金額小計： + NT$ {totalEquipmentFee}
                                </span>
                                {equipmentDiscount.enabled && discountHoursPerBoard > 0 && (
                                  <span className="text-[11px] font-bold text-emerald-800 bg-emerald-50 border border-emerald-200 px-2 py-0.5 rounded-full">
                                    已套用買{customerBuyHours}送{equipmentDiscount.free_hours}（每台折抵 {discountHoursPerBoard}hr，{totalBoards} 台共省 NT${totalSavedFee}）
                                  </span>
                                )}
                              </div>
                              <span>
                                {breakdownParts.join(' + ')}，共 {totalBoards} 台 × {rentalHours} 小時
                                {equipmentDiscount.enabled && discountHoursPerBoard > 0 ? `（每台計費 ${chargeableRentalHours} 小時，各折抵 ${discountHoursPerBoard} 小時；${totalBoards} 台合計折抵 ${totalDiscountHours} 小時）` : ''}
                                {totalBoards < pax ? `；另 ${pax - totalBoards} 位使用免費一般板` : ''}
                              </span>
                            </div>
                            {visibleConfigs.some(c => (equipmentSelections[c.id] || 0) > 0 && c.daily_cap && c.daily_cap > 0 && (c.hourly_rate * chargeableRentalHours >= c.daily_cap)) && (
                              <span className="text-xs font-bold text-[#8B5B43] bg-white border border-[#E8DEC8] px-3 py-1 rounded-full shrink-0 self-end sm:self-auto">
                                獨立單日封頂已套用
                              </span>
                            )}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* Smart Pricing & Breakdown Card */}
            <div className="bg-[#FDFCFA] border border-[#E8DEC8] rounded-2xl p-5 shadow-xs space-y-4">
              <div className="flex items-center justify-between border-b border-[#E8DEC8]/70 pb-3">
                <span className="font-bold text-base text-[#3E332B] flex items-center gap-2">
                  <span>✨</span> 預約明細與智慧計價
                </span>
              </div>

              {/* Selected Sessions Chips */}
              <div className="flex items-center gap-1.5 flex-wrap">
                <span className="text-xs font-bold text-[#7A7067]">已選時段：</span>
                {mergedSelectedTimeBlocks.map((b, idx) => (
                  <span
                    key={`${b.start_time}-${b.end_time}-${idx}`}
                    onClick={() => {
                      const idsToRemove = new Set(b.sessions.map(s => s.id));
                      setSelectedSessions(prev => prev.filter(s => !idsToRemove.has(s.id)));
                    }}
                    className="group cursor-pointer inline-flex items-center gap-1.5 bg-[#F4EFE6] hover:bg-red-50 text-[#8B5B43] hover:text-red-600 text-xs font-bold px-2.5 py-1 rounded-lg border border-[#E5DFD7] transition-colors"
                    title="點擊取消此時段"
                  >
                    <span>{b.start_time} ~ {b.end_time} {b.sessions.length > 1 ? `(共 ${b.sessions.length} 小時)` : '(1 小時)'}</span>
                    <span className="text-[10px] opacity-60 group-hover:opacity-100">✕</span>
                  </span>
                ))}
              </div>

              {/* Price Details */}
              <div className="space-y-2 text-xs sm:text-sm text-[#6D5D52] pt-1">
                <div className="flex justify-between items-center">
                  <span>預約入場費用 ({pax}人 × {selectedSessions.length}小時)：</span>
                  <span className="font-semibold text-[#3E332B]">NT$ {rawSeatingFee}</span>
                </div>

                {seatingPassDiscount > 0 && (
                  <div className="p-3 bg-emerald-50/80 border border-emerald-200 rounded-xl flex items-center justify-between text-emerald-900">
                    <div className="flex items-center gap-1.5">
                      <span className="text-base">🎉</span>
                      <div>
                        <div className="font-bold">暢玩封頂優惠已生效！</div>
                        <div className="text-[11px] text-emerald-700">單人入場費已自動折抵至最高封頂上限 NT$ {effectiveUnlimitedPrice}</div>
                      </div>
                    </div>
                    <span className="font-bold text-emerald-700 text-sm sm:text-base">- NT$ {seatingPassDiscount}</span>
                  </div>
                )}

                {enableSmartBoard && totalBoards > 0 && (
                  <div className="flex justify-between items-center border-t border-dashed border-[#E5DFD7] pt-2">
                    <div>
                      <span className="font-bold text-[#8B5B43]">智能拼豆板加購小計 ({totalBoards}台 × {rentalHours}hr)：</span>
                      {equipmentDiscount.enabled && discountHoursPerBoard > 0 && (
                        <span className="block text-[11px] text-emerald-700 font-medium">
                          享時數優惠{equipmentDiscount.tier2_enabled ? '擇優計價' : `（買${equipmentDiscount.buy_hours}送${equipmentDiscount.free_hours}）`}，每台實計 {chargeableRentalHours}hr（共省 NT${totalSavedFee}）
                        </span>
                      )}
                    </div>
                    <span className="font-bold text-[#8B5B43] text-sm">+ NT$ {totalEquipmentFee}</span>
                  </div>
                )}

                <div className="border-t border-[#E8DEC8] pt-3 flex justify-between items-baseline">
                  <span className="font-bold text-sm sm:text-base text-[#3E332B]">預估應付總金額：</span>
                  <div className="text-right">
                    <span className="text-xl sm:text-2xl font-black text-[#8B5B43]">NT$ {estimatedGrandTotal}</span>
                    <span className="block text-[10px] text-[#A8A19A]">現場報到核對後付款</span>
                  </div>
                </div>
              </div>
            </div>
          </section>
        )}
      </main>

      {/* Booking Footer Action */}
      {selectedSessions.length > 0 && (
        <div className="fixed bottom-0 left-0 right-0 p-4 bg-wood-bg/95 backdrop-blur-md border-t border-wood-border z-50 shadow-lg">
          <div className="max-w-3xl mx-auto flex items-center justify-between gap-4">
            <div>
              <div className="font-bold flex items-baseline gap-1.5">
                <span className="text-xs sm:text-sm text-[#4A3F35]">預估應付總額:</span>
                <span className="text-lg sm:text-2xl font-black text-wood-primary">
                  NT$ {estimatedGrandTotal}
                </span>
                <span className="text-[11px] text-wood-textMuted font-normal hidden sm:inline">(現場付款)</span>
              </div>
              <div className="text-wood-textMuted font-medium flex items-center gap-2 text-xs">
                <span>{pax} 人 ｜ {selectedSessions.length} 小時</span>
                {totalBoards > 0 && enableSmartBoard && (
                  <span className="text-wood-primary font-bold">
                    ｜ 智能板 {totalBoards} 台
                  </span>
                )}
              </div>
            </div>
            <button
              onClick={handleBooking}
              className="bg-wood-primary hover:bg-wood-primaryHover text-white px-7 sm:px-9 py-3 rounded-xl font-bold shadow-warm transition-all duration-200 transform hover:-translate-y-0.5 shrink-0"
            >
              送出預約
            </button>
          </div>
        </div>
      )}

      {/* Split/Waitlist Confirmation Modal */}
      {showSplitModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-wood-textMain/40 backdrop-blur-sm">
          <div className="bg-wood-card rounded-2xl w-full max-w-md overflow-hidden shadow-warm">
            <div className="bg-wood-bg p-6 flex flex-col items-center border-b border-wood-border">
              <div className="bg-[#F0EBE1] p-3 rounded-full mb-4">
                <span className="text-3xl">⚠️</span>
              </div>
              <h3 className="text-xl font-bold text-wood-textMain text-center">
                連續座位不足
              </h3>
            </div>
            <div className="p-6">
              <p className="text-wood-textMuted text-center mb-6">
                您選擇的時段已無法安排連續的相鄰座位，<br/>
                <span className="font-bold text-wood-primaryHover">同行者將會被拆散入座。</span><br/><br/>
                請問是否仍要確認預約？
              </p>
              <div className="flex gap-3">
                <button
                  onClick={() => {
                    setShowSplitModal(false);
                    setSplitBookingData(null);
                  }}
                  className="flex-1 py-3 px-4 bg-wood-bg hover:bg-[#F0EBE1] text-wood-textMuted hover:text-wood-textMain rounded-xl font-medium transition-colors"
                >
                  取消預約
                </button>
                <button
                  onClick={confirmSplitBooking}
                  className="flex-1 py-3 px-4 bg-wood-primary hover:bg-wood-primaryHover text-white rounded-xl font-bold transition-colors shadow-warm"
                >
                  確認拆桌
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Unlimited Warning Modal */}
      {showUnlimitedWarningModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-wood-textMain/40 backdrop-blur-sm animate-fade-in">
          <div className="bg-wood-card rounded-2xl w-full max-w-md overflow-hidden shadow-warm">
            <div className="bg-wood-bg p-6 flex flex-col items-center border-b border-wood-border">
              <div className="bg-[#F0EBE1] p-3 rounded-full mb-4">
                <span className="text-3xl">⚠️</span>
              </div>
              <h3 className="text-xl font-bold text-wood-textMain text-center">
                不限時預約提醒
              </h3>
            </div>
            <div className="p-6">
              <p className="text-wood-textMuted text-center mb-6 leading-relaxed">
                目前部分時段人數已滿，不限時預約僅提供系統上所顯示剩餘可預約的時段。<br/><br/>
                <span className="font-bold text-wood-primaryHover">預約已滿的時段店內無多餘位置，請勿在店內逗留</span><br/><br/>
                請問是否同意並確定開啟？
              </p>
              <div className="flex gap-3">
                <button
                  onClick={() => setShowUnlimitedWarningModal(false)}
                  className="flex-1 py-3 px-4 bg-wood-bg hover:bg-[#F0EBE1] text-wood-textMuted hover:text-wood-textMain rounded-xl font-medium transition-colors"
                >
                  我不同意
                </button>
                <button
                  onClick={() => {
                    enableUnlimitedMode();
                    setShowUnlimitedWarningModal(false);
                  }}
                  className="flex-1 py-3 px-4 bg-wood-primary hover:bg-wood-primaryHover text-white rounded-xl font-bold transition-colors shadow-warm"
                >
                  同意開啟
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Confirm Booking Modal */}
      {confirmModalData && (
        <div className="fixed inset-0 z-[120] flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/40 backdrop-blur-[4px]" onClick={() => setConfirmModalData(null)} />
          <div className="bg-white rounded-[24px] shadow-[0_16px_32px_rgba(139,91,67,0.12)] w-full max-w-sm overflow-hidden relative z-10 animate-zoom-in">
            <div className="p-6">
              <h2 className="text-[18px] font-semibold text-[#3E332B] text-center mb-5">確認預約資訊</h2>
              <div className="bg-[#F9F7F3] rounded-[12px] p-4 space-y-3 mb-6 text-[15px]">
                <div className="flex items-center text-[#3E332B]">
                  <span className="w-16 font-medium text-[#8C8279]">📅 日期</span>
                  <span className="font-bold">{confirmModalData.date}</span>
                </div>
                <div className="flex items-center text-[#3E332B]">
                  <span className="w-16 font-medium text-[#8C8279]">🕒 時段</span>
                  <span className="font-bold">{confirmModalData.timeRange}</span>
                </div>
                <div className="flex items-center text-[#3E332B]">
                  <span className="w-16 font-medium text-[#8C8279]">👥 人數</span>
                  <span className="font-bold">{confirmModalData.pax} 人</span>
                </div>
                {confirmModalData.equipments && confirmModalData.equipments.length > 0 && (
                  <div className="flex items-start text-[#3E332B] border-t border-dashed border-[#E5DFD7] pt-2">
                    <span className="w-16 font-medium text-[#8C8279] shrink-0">⚙️ 設備</span>
                    <div>
                      <span className="font-bold block text-sm">{confirmModalData.equipmentBreakdown}</span>
                      <span className="text-xs text-[#8B5B43] font-bold">加購小計: +NT$ {confirmModalData.totalEquipmentFee}</span>
                    </div>
                  </div>
                )}
                <div className="flex items-center justify-between text-[#3E332B] border-t border-dashed border-[#E5DFD7] pt-2">
                  <span className="font-medium text-[#8C8279]">💰 預估總額</span>
                  <span className="font-bold text-[#8B5B43] text-lg">NT$ {confirmModalData.estimatedGrandTotal || estimatedGrandTotal}</span>
                </div>
              </div>
              
              <div className="flex items-center justify-center gap-3">
                <button 
                  onClick={() => setConfirmModalData(null)}
                  className="flex-1 py-3 bg-transparent text-[#8C8279] font-medium hover:bg-[#F9F7F3] rounded-[12px] transition-colors"
                >
                  取消
                </button>
                <button 
                  onClick={executeBooking}
                  className="flex-1 py-3 bg-[#8B5B43] hover:bg-[#724a35] text-white font-bold rounded-[12px] shadow-sm transition-colors"
                >
                  確定預約
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Success/Error Alert Modal */}
      {alertModalData && (
        <div className="fixed inset-0 z-[130] flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/40 backdrop-blur-[4px]" onClick={() => {
            const isSuccess = alertModalData.type === 'success';
            setAlertModalData(null);
            if (isSuccess) navigate('/history');
          }} />
          <div className="bg-white rounded-[24px] shadow-[0_16px_32px_rgba(139,91,67,0.12)] w-full max-w-sm overflow-hidden relative z-10 animate-zoom-in text-center p-8">
            <div className={`mx-auto w-14 h-14 rounded-full flex items-center justify-center mb-4 ${alertModalData.type === 'success' ? 'bg-[#A5B69C]/20 text-[#A5B69C]' : 'bg-[#FDF3F1] text-[#B35D4F]'}`}>
              {alertModalData.type === 'success' ? (
                <svg className="w-8 h-8" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
                </svg>
              ) : (
                <svg className="w-8 h-8" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M6 18L18 6M6 6l12 12" />
                </svg>
              )}
            </div>
            <h2 className="text-[20px] font-bold text-[#3E332B] mb-2">{alertModalData.title}</h2>
            {alertModalData.message && (
              <p className="text-[#8C8279] text-[15px] mb-6 font-medium">{alertModalData.message}</p>
            )}
            <button 
              onClick={() => {
                const isSuccess = alertModalData.type === 'success';
                setAlertModalData(null);
                if (isSuccess) navigate('/history');
              }}
              className="w-full py-3 bg-[#8B5B43] hover:bg-[#724a35] text-white font-bold rounded-[12px] shadow-sm transition-colors"
            >
              {alertModalData.type === 'success' ? '查看預約紀錄' : '好的'}
            </button>
          </div>
        </div>
      )}

      {/* Reservation Voucher / Confirmation Ticket Modal */}
      {ticketModalData && (() => {
        const shortRef = formatBookingRef(ticketModalData.booking_ref);
        const [startT, endT] = ticketModalData.timeRange.split(' - ');
        const gcalUrl = getGoogleCalendarUrl({
          session_date: ticketModalData.date,
          start_time: startT,
          end_time: endT,
          booking_ref: ticketModalData.booking_ref,
          pax: ticketModalData.pax,
          assigned_seats: ticketModalData.assigned_seats,
          total_amount: ticketModalData.total_amount
        });

        return (
          <div className="fixed inset-0 z-[140] flex items-center justify-center p-4">
            <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" />
            <div className="bg-white rounded-[28px] shadow-2xl w-full max-w-md overflow-hidden relative z-10 p-6 sm:p-7 text-center animate-zoom-in">
              <div className="w-14 h-14 rounded-full bg-emerald-50 text-emerald-600 flex items-center justify-center mx-auto mb-3">
                <Check className="w-8 h-8 stroke-[2.5]" />
              </div>
              <p className="text-xs font-bold text-emerald-700 uppercase tracking-widest mb-1">RESERVATION CONFIRMED</p>
              <h2 className="text-2xl font-black text-[#2C241E] mb-4">手作預約成功！</h2>

              {/* Short Ref Box */}
              <div className="bg-[#FAF7F2] border border-[#E8DEC8] rounded-2xl p-4 mb-5 flex items-center justify-between">
                <div className="text-left">
                  <div className="text-[11px] font-bold text-[#8C8279]">專屬預約編號</div>
                  <div className="text-lg font-mono font-black text-[#8B5B43]">{shortRef}</div>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    navigator.clipboard?.writeText(shortRef);
                    setCopiedTicketRef(true);
                    setTimeout(() => setCopiedTicketRef(false), 2000);
                  }}
                  className="px-3 py-1.5 bg-white border border-[#D5CFC9] hover:border-[#8B5B43] rounded-xl text-xs font-bold text-[#6D5D52] hover:text-[#8B5B43] transition-colors flex items-center gap-1 shadow-2xs"
                >
                  {copiedTicketRef ? (
                    <>
                      <Check className="w-3.5 h-3.5 text-emerald-600" />
                      <span className="text-emerald-600">已複製</span>
                    </>
                  ) : (
                    <>
                      <Copy className="w-3.5 h-3.5" />
                      <span>複製編號</span>
                    </>
                  )}
                </button>
              </div>

              {/* Details Summary */}
              <div className="bg-[#FDFCFA] border border-[#EBE5DF] rounded-2xl p-4 text-xs sm:text-sm text-left space-y-2 mb-6">
                <div className="flex justify-between items-center">
                  <span className="text-[#8C8279]">📅 預約日期：</span>
                  <span className="font-bold text-[#2C241E]">{ticketModalData.date}</span>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-[#8C8279]">🕒 預約時段：</span>
                  <span className="font-bold text-[#2C241E]">{ticketModalData.timeRange}</span>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-[#8C8279]">👥 預約人數：</span>
                  <span className="font-bold text-[#2C241E]">{ticketModalData.pax} 人</span>
                </div>
                <div className="flex justify-between items-baseline border-t border-dashed border-[#E5DFD7] pt-2">
                  <span className="text-[#8C8279]">💰 預估結帳總額：</span>
                  <span className="font-bold text-base text-[#8B5B43]">NT$ {ticketModalData.total_amount}</span>
                </div>
              </div>

              {/* Dual Action Buttons */}
              <div className="space-y-2.5">
                {gcalUrl && (
                  <a
                    href={gcalUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="w-full py-3 px-4 rounded-xl font-bold text-xs sm:text-sm bg-[#FAF7F2] border border-[#D5CFC9] text-[#6D5D52] hover:bg-[#F4EFE6] hover:text-[#8B5B43] transition-colors flex items-center justify-center gap-2"
                  >
                    <CalendarPlus className="w-4 h-4 text-[#8B5B43]" />
                    加入 Google 行事曆
                  </a>
                )}
                <button
                  type="button"
                  onClick={() => {
                    setTicketModalData(null);
                    navigate('/history');
                  }}
                  className="w-full py-3 px-4 rounded-xl font-bold text-xs sm:text-sm bg-[#8B5B43] hover:bg-[#724a35] text-white transition-colors shadow-sm"
                >
                  ✓ 查看我的預約紀錄
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* Announcement Modal */}
      {showAnnouncementModal && (
        <div className="fixed inset-0 z-[130] flex items-center justify-center p-4">
          <div 
            className="absolute inset-0 bg-black/40 backdrop-blur-[4px] animate-fade-in" 
            onClick={() => setShowAnnouncementModal(false)} 
          />
          <div className="bg-white rounded-[24px] shadow-[0_16px_32px_rgba(139,91,67,0.15)] border border-[#E8DEC8] w-full max-w-md overflow-hidden relative z-10 animate-zoom-in p-6">
            <div className="flex items-center justify-between pb-3 border-b border-[#F0EBE1] mb-4">
              <div className="flex items-center gap-2">
                <span className="text-xl">🔔</span>
                <h3 className="text-base sm:text-lg font-bold text-[#3E332B]">系統公告</h3>
              </div>
              <button
                type="button"
                onClick={() => setShowAnnouncementModal(false)}
                className="w-8 h-8 flex items-center justify-center rounded-full text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors text-base"
                aria-label="關閉"
              >
                ✕
              </button>
            </div>
            
            <div className="bg-[#FAF7F2] border border-[#E8DEC8]/80 rounded-2xl p-4 sm:p-5 text-sm sm:text-base text-[#5C4D42] leading-relaxed whitespace-pre-wrap break-words max-h-[60vh] overflow-y-auto">
              {announcementText || '✨ 歡迎來到拾光製所！線上預約享即時選位，智能拼豆板租借滿時數再享買送折抵優惠'}
            </div>

            <div className="mt-5">
              <button
                type="button"
                onClick={() => setShowAnnouncementModal(false)}
                className="w-full py-3 bg-[#8B5B43] hover:bg-[#724a35] text-white font-bold rounded-xl shadow-sm transition-colors text-sm sm:text-base"
              >
                我知道了
              </button>
            </div>
          </div>
        </div>
      )}

      <style dangerouslySetInnerHTML={{__html: `
        .custom-scrollbar::-webkit-scrollbar { height: 6px; }
        .custom-scrollbar::-webkit-scrollbar-track { background: transparent; }
        .custom-scrollbar::-webkit-scrollbar-thumb { background-color: #e5e7eb; border-radius: 20px; }
        .animate-fade-in-up { animation: fadeInUp 0.3s ease-out forwards; }
        @keyframes fadeInUp { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
        .animate-zoom-in { animation: zoomIn 0.2s ease-out forwards; }
        @keyframes zoomIn { from { opacity: 0; transform: scale(0.95); } to { opacity: 1; transform: scale(1); } }
      `}} />
    </div>
  );
}

export default Booking;
