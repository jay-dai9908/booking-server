import React, { useState, useEffect } from 'react';
import {
  format,
  addDays,
  startOfMonth,
  endOfMonth,
  startOfWeek,
  endOfWeek,
  isSameMonth,
  isSameDay,
  addMonths,
  subMonths,
  isBefore,
  startOfDay,
  getDay
} from 'date-fns';
import {
  Plus,
  Trash2,
  CheckCircle2,
  XCircle,
  Calendar as CalendarIcon,
  ChevronLeft,
  ChevronRight,
  Sparkles,
  RotateCcw,
  Sliders,
  Bell,
  CreditCard,
  MessageSquare,
  AlertTriangle
} from 'lucide-react';
import api from '../../api/axios';
import HourRangeScrollPicker from '../../components/HourRangeScrollPicker';
import ConfirmPanel from '../../components/admin/ConfirmPanel';
import SelfServiceInfoCard from '../../components/customer/SelfServiceInfoCard';
import { ironText as buildIronText } from '../../../../shared/selfService.js';

export default function SessionsPage() {
  const [toastMsg, setToastMsg] = useState(null);
  const showToast = (msg) => {
    setToastMsg(msg);
    setTimeout(() => setToastMsg(null), 3000);
  };
  const [deleteSessionTargetId, setDeleteSessionTargetId] = useState(null);
  const [showDeleteAllConfirm, setShowDeleteAllConfirm] = useState(false);

  const [currentMonth, setCurrentMonth] = useState(startOfMonth(new Date()));
  const [selectedDates, setSelectedDates] = useState([format(new Date(), 'yyyy-MM-dd')]);
  const [listDate, setListDate] = useState(format(new Date(), 'yyyy-MM-dd'));
  const [monthSessionsMap, setMonthSessionsMap] = useState({});

  const [startTime, setStartTime] = useState('10:00');
  const [endTime, setEndTime] = useState('21:00');
  const [businessHours, setBusinessHours] = useState({
    weekday: { start: '10:00', end: '21:00' },
    saturday: { start: '09:00', end: '21:00' },
    sunday: { start: '09:00', end: '21:00' }
  });
  const [maxCapacity, setMaxCapacity] = useState(16);
  const [seatCount, setSeatCount] = useState(16);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [sessions, setSessions] = useState([]);
  const [isLoading, setIsLoading] = useState(false);
  const [allowUnlimited, setAllowUnlimited] = useState(true);

  // Pricing States
  const [globalWeekdayHourly, setGlobalWeekdayHourly] = useState('');
  const [globalWeekdayUnlimited, setGlobalWeekdayUnlimited] = useState('');
  const [globalWeekendHourly, setGlobalWeekendHourly] = useState('');
  const [globalWeekendUnlimited, setGlobalWeekendUnlimited] = useState('');
  
  // Customer Display Settings States
  const [showPriceCards, setShowPriceCards] = useState(true);
  const [priceNoticeText, setPriceNoticeText] = useState('');
  const [showAnnouncement, setShowAnnouncement] = useState(true);
  const [announcementText, setAnnouncementText] = useState('');
  const [showLineButton, setShowLineButton] = useState(true);
  const [lineButtonUrl, setLineButtonUrl] = useState('');
  const [isSavingDisplay, setIsSavingDisplay] = useState(false);

  const [dailyHourly, setDailyHourly] = useState('');
  const [dailyUnlimited, setDailyUnlimited] = useState('');

  const [batchMode, setBatchMode] = useState('selected'); // 'selected' | 'range'
  const [batchStartDate, setBatchStartDate] = useState(format(new Date(), 'yyyy-MM-dd'));
  const [batchEndDate, setBatchEndDate] = useState(format(new Date(), 'yyyy-MM-dd'));
  const [batchHourly, setBatchHourly] = useState('');
  const [batchUnlimited, setBatchUnlimited] = useState('');
  const [batchSetSelfService, setBatchSetSelfService] = useState(false);
  const [batchSelfAllowEquipment, setBatchSelfAllowEquipment] = useState(false);
  const [batchIronMode, setBatchIronMode] = useState('today');
  const [batchIronDate, setBatchIronDate] = useState('');
  const [isBatching, setIsBatching] = useState(false);

  // Daily Self-Service States (for listDate)
  const [isSelfService, setIsSelfService] = useState(false);
  const [selfAllowHourly, setSelfAllowHourly] = useState(false);
  const [selfAllowEquipment, setSelfAllowEquipment] = useState(false);
  const [ironMode, setIronMode] = useState('today');
  const [ironDate, setIronDate] = useState('');
  const [savingDailySelf, setSavingDailySelf] = useState(false);
  const [dailySelfError, setDailySelfError] = useState('');

  // Shared Kiosk/Self-Service Settings
  const [kioskSettings, setKioskSettings] = useState({
    prepay_deadline_hour: 12,
    early_minutes: 30,
    after_close_minutes: 60,
    max_unpaid_self_bookings: 2
  });
  const [savingKioskSettings, setSavingKioskSettings] = useState(false);
  const [anySelfEquipmentEnabled, setAnySelfEquipmentEnabled] = useState(false);

  useEffect(() => {
    fetchGlobalSetting();
    fetchKioskSettings();
    fetchEquipmentSelfStatus();
  }, []);

  useEffect(() => {
    fetchSessions(listDate);
    fetchDailySetting(listDate);
    fetchSeatCount(listDate);
  }, [listDate]);

  useEffect(() => {
    fetchMonthSessions(currentMonth);
  }, [currentMonth]);

  const fetchSeatCount = async (date = listDate) => {
    try {
      const url = date ? `/seat-layouts/active?date=${date}` : '/seat-layouts/active';
      const layoutRes = await api.get(url);
      const activeCount = layoutRes.data?.capacity ?? (layoutRes.data?.seats || []).filter(s => s.is_active)?.length ?? 16;
      setSeatCount(activeCount);
    } catch (lErr) {
      setSeatCount(16);
    }
  };

  const fetchGlobalSetting = async () => {
    try {
      const res = await api.get('/daily-settings/global');
      setGlobalWeekdayHourly(res.data.weekday_hourly_price || '');
      setGlobalWeekdayUnlimited(res.data.weekday_unlimited_price || '');
      setGlobalWeekendHourly(res.data.weekend_hourly_price || '');
      setGlobalWeekendUnlimited(res.data.weekend_unlimited_price || '');
      setShowPriceCards(res.data.show_price_cards !== false);
      setPriceNoticeText(res.data.price_notice_text ?? '費用皆含基礎傳統拼豆板與豆子無限使用．預約現場保留 15 分鐘．離場前請預留 10 分鐘壓平作品');
      setShowAnnouncement(res.data.show_announcement !== false);
      setAnnouncementText(res.data.announcement_text ?? '歡迎來到拾光製所！線上預約享即時選位，智能拼豆板租借滿時數再享買送折抵優惠');
      if (res.data?.business_hours_json) {
        setBusinessHours({
          weekday: {
            start: res.data.business_hours_json.weekday?.start || '10:00',
            end: res.data.business_hours_json.weekday?.end || '21:00'
          },
          saturday: {
            start: res.data.business_hours_json.saturday?.start || '09:00',
            end: res.data.business_hours_json.saturday?.end || '21:00'
          },
          sunday: {
            start: res.data.business_hours_json.sunday?.start || '09:00',
            end: res.data.business_hours_json.sunday?.end || '21:00'
          }
        });
        if (res.data.business_hours_json.weekday?.start) {
          setStartTime(res.data.business_hours_json.weekday.start);
        }
        if (res.data.business_hours_json.weekday?.end) {
          setEndTime(res.data.business_hours_json.weekday.end);
        }
      }
      setMaxCapacity(res.data?.default_session_capacity ?? 16);
      fetchSeatCount(listDate);
    } catch (err) {
      console.error('Error fetching global setting:', err);
    }
  };

  const handleUpdateDisplaySettings = async (e) => {
    if (e) e.preventDefault();
    setIsSavingDisplay(true);
    try {
      await api.put('/daily-settings/global', {
        show_price_cards: showPriceCards,
        price_notice_text: priceNoticeText,
        show_announcement: showAnnouncement,
        announcement_text: announcementText,
        show_line_button: showLineButton,
        line_button_url: lineButtonUrl
      });
      try {
        localStorage.removeItem('shiguang_booking_global_settings_cache');
      } catch (e) {}
      showToast('顧客端首頁顯示設定已成功更新！');
    } catch (err) {
      console.error(err);
      showToast('更新顯示設定失敗');
    } finally {
      setIsSavingDisplay(false);
    }
  };

  const fetchDailySetting = async (date) => {
    try {
      const res = await api.get(`/daily-settings?date=${date}`);
      setAllowUnlimited(res.data.allow_unlimited);
      setDailyHourly(res.data.hourly_price || '');
      setDailyUnlimited(res.data.unlimited_price || '');
      setIsSelfService(Boolean(res.data.is_self_service));
      setSelfAllowHourly(Boolean(res.data.self_allow_hourly));
      setSelfAllowEquipment(Boolean(res.data.self_allow_equipment));
      setIronMode(res.data.iron_mode || 'today');
      setIronDate(res.data.iron_date ? String(res.data.iron_date).slice(0, 10) : '');
      setDailySelfError('');
    } catch (err) {
      console.error('Error fetching daily setting:', err);
    }
  };

  const fetchKioskSettings = async () => {
    try {
      const res = await api.get('/kiosk/settings');
      if (res.data) {
        setKioskSettings({
          prepay_deadline_hour: res.data.prepay_deadline_hour ?? 12,
          early_minutes: res.data.early_minutes ?? 30,
          after_close_minutes: res.data.after_close_minutes ?? 60,
          max_unpaid_self_bookings: res.data.max_unpaid_self_bookings ?? 2
        });
      }
    } catch (err) {
      console.error('Error fetching kiosk settings:', err);
    }
  };

  const fetchEquipmentSelfStatus = async () => {
    try {
      const res = await api.get('/equipment/admin');
      const list = res.data?.configs || (Array.isArray(res.data) ? res.data : []);
      setAnySelfEquipmentEnabled(list.some(c => Boolean(c.self_enabled) && c.visibility_status !== 'HIDDEN'));
    } catch (err) {
      console.error('Error fetching equipment status:', err);
    }
  };

  const handleSaveDailySelfService = async (e) => {
    if (e) e.preventDefault();
    setSavingDailySelf(true);
    setDailySelfError('');
    try {
      await api.put('/daily-settings', {
        date: listDate,
        allow_unlimited: isSelfService ? true : allowUnlimited,
        hourly_price: dailyHourly || null,
        unlimited_price: dailyUnlimited || null,
        is_self_service: isSelfService,
        self_allow_hourly: selfAllowHourly,
        self_allow_equipment: selfAllowEquipment,
        iron_mode: ironMode,
        iron_date: ironMode === 'date' ? ironDate : null
      });
      if (isSelfService) setAllowUnlimited(true);
      showToast(`已儲存 ${listDate} 的半自助日設定`);
      fetchDailySetting(listDate);
    } catch (err) {
      const msg = err.response?.data?.error || '儲存半自助日設定失敗';
      setDailySelfError(msg);
      showToast(msg);
      fetchDailySetting(listDate);
    } finally {
      setSavingDailySelf(false);
    }
  };

  const handleSaveKioskSettings = async (e) => {
    e.preventDefault();
    setSavingKioskSettings(true);
    try {
      const res = await api.put('/kiosk/settings', {
        prepay_deadline_hour: parseInt(kioskSettings.prepay_deadline_hour, 10),
        early_minutes: parseInt(kioskSettings.early_minutes, 10),
        after_close_minutes: parseInt(kioskSettings.after_close_minutes, 10),
        max_unpaid_self_bookings: parseInt(kioskSettings.max_unpaid_self_bookings, 10)
      });
      if (res.data?.setting) {
        setKioskSettings(res.data.setting);
      }
      showToast('已儲存半自助日共用設定');
    } catch (err) {
      showToast(err.response?.data?.error || '儲存共用設定失敗');
    } finally {
      setSavingKioskSettings(false);
    }
  };

  const fetchMonthSessions = async (monthDate = currentMonth) => {
    try {
      const mStart = format(startOfWeek(startOfMonth(monthDate)), 'yyyy-MM-dd');
      const mEnd = format(endOfWeek(endOfMonth(monthDate)), 'yyyy-MM-dd');
      const res = await api.get(`/sessions?start_date=${mStart}&end_date=${mEnd}`);
      const map = {};
      (res.data || []).forEach(s => {
        const dStr = format(new Date(s.session_date), 'yyyy-MM-dd');
        map[dStr] = (map[dStr] || 0) + 1;
      });
      setMonthSessionsMap(map);
    } catch (err) {
      console.error('Error fetching month sessions:', err);
    }
  };

  const handleToggleUnlimited = async () => {
    const newValue = !allowUnlimited;
    setAllowUnlimited(newValue);
    try {
      await api.put('/daily-settings', { date: listDate, allow_unlimited: newValue });
    } catch (err) {
      console.error('Error updating daily setting:', err);
      setAllowUnlimited(!newValue);
      showToast('更新設定失敗');
    }
  };

  const handleUpdateGlobalPrice = async (e) => {
    e.preventDefault();
    try {
      await api.put('/daily-settings/global', { 
        weekday_hourly_price: globalWeekdayHourly || null, 
        weekday_unlimited_price: globalWeekdayUnlimited || null,
        weekend_hourly_price: globalWeekendHourly || null,
        weekend_unlimited_price: globalWeekendUnlimited || null
      });
      try {
        localStorage.removeItem('shiguang_booking_global_settings_cache');
      } catch (e) {}
      showToast('全店預設價格更新成功！');
    } catch (err) {
      showToast('更新失敗');
    }
  };

  const handleUpdateDailyPrice = async (e) => {
    e.preventDefault();
    try {
      await api.put('/daily-settings', { 
        date: listDate,
        hourly_price: dailyHourly || null,
        unlimited_price: dailyUnlimited || null
      });
      showToast('單日覆蓋價格更新成功！');
    } catch (err) {
      showToast('更新失敗');
    }
  };

  const handleBatchUpdatePrices = async (e) => {
    e.preventDefault();
    setIsBatching(true);
    try {
      const payload = {
        hourly_price: batchHourly || null,
        unlimited_price: batchUnlimited || null
      };

      if (batchSetSelfService) {
        payload.is_self_service = true;
        payload.self_allow_equipment = batchSelfAllowEquipment;
        payload.iron_mode = batchIronMode;
        payload.iron_date = batchIronMode === 'date' ? batchIronDate : null;
      }

      if (batchMode === 'selected') {
        if (selectedDates.length === 0) {
          showToast('請先在上方月曆勾選日期');
          setIsBatching(false);
          return;
        }
        payload.dates = selectedDates;
      } else {
        payload.start_date = batchStartDate;
        payload.end_date = batchEndDate;
      }

      const res = await api.post('/daily-settings/batch', payload);
      showToast(`批次修改成功！${res.data?.message || ''}`);
      fetchDailySetting(listDate);
    } catch (err) {
      showToast(err.response?.data?.error || '批次修改失敗');
    } finally {
      setIsBatching(false);
    }
  };

  const fetchSessions = async (date = listDate) => {
    setIsLoading(true);
    try {
      const res = await api.get(`/sessions?date=${date}`);
      setSessions(res.data);
    } catch (err) {
      console.error(err);
    } finally {
      setIsLoading(false);
    }
  };

  const handleCreateSession = async (e) => {
    e.preventDefault();
    if (selectedDates.length === 0) {
      showToast('請先在月曆上勾選至少一個欲新增時段的日期');
      return;
    }
    setIsSubmitting(true);
    try {
      const sortedDates = [...selectedDates].sort();
      await api.post('/sessions', {
        session_dates: sortedDates,
        start_time: startTime,
        end_time: endTime,
        max_capacity: parseInt(maxCapacity, 10)
      });
      showToast(`時段新增成功！已為 ${sortedDates.length} 天新增 ${startTime} ~ ${endTime} 時段`);
      fetchSessions(listDate);
      fetchMonthSessions(currentMonth);
    } catch (err) {
      showToast(err.response?.data?.error || '新增失敗');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDeleteSession = (id) => {
    setDeleteSessionTargetId(id);
  };

  const handleConfirmDeleteSession = async () => {
    if (!deleteSessionTargetId) return;
    try {
      await api.delete(`/sessions/${deleteSessionTargetId}`);
      showToast('時段已刪除');
      fetchSessions(listDate);
      fetchMonthSessions(currentMonth);
    } catch (err) {
      showToast(err.response?.data?.error || '刪除失敗');
    } finally {
      setDeleteSessionTargetId(null);
    }
  };

  const handleDeleteAllForDate = () => {
    if (sessions.length === 0) return;
    setShowDeleteAllConfirm(true);
  };

  const handleConfirmDeleteAllForDate = async () => {
    try {
      const res = await api.delete(`/sessions/date/${listDate}`);
      showToast(`成功刪除 ${res.data.deletedCount} 個時段。${res.data.keptCount > 0 ? ` (保留了 ${res.data.keptCount} 個已被預約的時段)` : ''}`);
      fetchSessions(listDate);
      fetchMonthSessions(currentMonth);
    } catch (err) {
      showToast(err.response?.data?.error || '刪除失敗');
    } finally {
      setShowDeleteAllConfirm(false);
    }
  };

  // Calendar dates computation
  const monthStart = startOfMonth(currentMonth);
  const monthEnd = endOfMonth(monthStart);
  const calendarStartDate = startOfWeek(monthStart);
  const calendarEndDate = endOfWeek(monthEnd);

  const calendarDays = [];
  let dayCursor = calendarStartDate;
  while (dayCursor <= calendarEndDate) {
    calendarDays.push(dayCursor);
    dayCursor = addDays(dayCursor, 1);
  }

  // Quick batch selection helpers for currentMonth
  const getAvailableMonthDays = () => {
    const today = startOfDay(new Date());
    const days = [];
    let d = monthStart;
    while (d <= monthEnd) {
      if (!isBefore(startOfDay(d), today)) {
        days.push(d);
      }
      d = addDays(d, 1);
    }
    return days;
  };

  const handleSelectWeekdays = () => {
    const valid = getAvailableMonthDays()
      .filter(d => {
        const day = getDay(d);
        return day >= 2 && day <= 5;
      })
      .map(d => format(d, 'yyyy-MM-dd'));
    setSelectedDates(valid);
    if (valid.length > 0) setListDate(valid[0]);
  };

  const handleSelectMonToFri = () => {
    const valid = getAvailableMonthDays()
      .filter(d => {
        const day = getDay(d);
        return day >= 1 && day <= 5;
      })
      .map(d => format(d, 'yyyy-MM-dd'));
    setSelectedDates(valid);
    if (valid.length > 0) setListDate(valid[0]);
  };

  const handleSelectUnscheduledDays = () => {
    const valid = getAvailableMonthDays()
      .map(d => format(d, 'yyyy-MM-dd'))
      .filter(dateStr => !monthSessionsMap[dateStr]);
    setSelectedDates(valid);
    if (valid.length > 0) setListDate(valid[0]);
  };

  const handleSelectWeekends = () => {
    const valid = getAvailableMonthDays()
      .filter(d => {
        const day = getDay(d);
        return day === 0 || day === 6;
      })
      .map(d => format(d, 'yyyy-MM-dd'));
    setSelectedDates(valid);
    if (valid.length > 0) setListDate(valid[0]);
  };

  const handleSelectAllMonth = () => {
    const valid = getAvailableMonthDays().map(d => format(d, 'yyyy-MM-dd'));
    setSelectedDates(valid);
    if (valid.length > 0) setListDate(valid[0]);
  };

  const handleClearSelected = () => {
    setSelectedDates([]);
  };

  const handleDateCellClick = (date) => {
    const dateStr = format(date, 'yyyy-MM-dd');
    const isPast = isBefore(startOfDay(date), startOfDay(new Date()));
    
    // Always view this date's sessions on the right side
    setListDate(dateStr);

    // If not in the past, toggle multi-select
    if (!isPast) {
      setSelectedDates(prev => {
        if (prev.includes(dateStr)) {
          return prev.filter(d => d !== dateStr);
        } else {
          return [...prev, dateStr].sort();
        }
      });
    }
  };

  return (
    <div className="space-y-6 animate-fade-in">
      {/* Toast Notification */}
      {toastMsg && (
        <div className="fixed top-4 right-4 z-50 bg-sg-ink text-white px-4 py-2.5 rounded-2xl shadow-lg text-[13px] font-bold animate-fade-in">
          {toastMsg}
        </div>
      )}

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-8">
        {/* Left Column: Interactive Multi-Select Calendar & Session Creation Form */}
        <div className="xl:col-span-1">
          <div className="bg-white p-5 sm:p-6 rounded-2xl shadow-sm border border-gray-200 sticky top-8 space-y-5">
            <div className="flex items-center justify-between pb-3 border-b border-gray-100">
              <h2 className="text-lg font-bold text-gray-900 flex items-center gap-2">
                <Plus className="w-5 h-5 text-[#8B5B43]" />
                新增時段 (多日批次)
              </h2>
              <span className="text-xs bg-[#FAF4EB] text-[#8B5B43] border border-[#E8DEC8] px-2.5 py-1 rounded-full font-bold">
                已選 {selectedDates.length} 天
              </span>
            </div>

            <form onSubmit={handleCreateSession} className="space-y-5">
              {/* Interactive Calendar Section */}
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <label className="text-sm font-semibold text-gray-700 flex items-center gap-1.5">
                    <CalendarIcon className="w-4 h-4 text-[#8B5B43]" />
                    點擊月曆選取日期 (可複選)
                  </label>
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => setCurrentMonth(subMonths(currentMonth, 1))}
                      className="p-1 text-gray-500 hover:text-gray-900 hover:bg-gray-100 rounded-lg transition-colors"
                      title="上個月"
                    >
                      <ChevronLeft className="w-4 h-4" />
                    </button>
                    <span className="text-xs font-bold text-gray-800 tracking-wide px-1">
                      {format(currentMonth, 'yyyy年 MM月')}
                    </span>
                    <button
                      type="button"
                      onClick={() => setCurrentMonth(addMonths(currentMonth, 1))}
                      className="p-1 text-gray-500 hover:text-gray-900 hover:bg-gray-100 rounded-lg transition-colors"
                      title="下個月"
                    >
                      <ChevronRight className="w-4 h-4" />
                    </button>
                  </div>
                </div>

                {/* Quick Selection Capsules for Staff */}
                <div className="flex items-center gap-1.5 flex-wrap">
                  <button
                    type="button"
                    onClick={handleSelectWeekdays}
                    className="px-2 py-0.5 text-[12px] font-medium bg-[#FAF7F2] text-[#6E5D4F] border border-[#E8DEC8] hover:bg-[#8B5B43] hover:text-white rounded-full transition-all"
                  >
                    平日 (二~五)
                  </button>
                  <button
                    type="button"
                    onClick={handleSelectMonToFri}
                    className="px-2 py-0.5 text-[12px] font-medium bg-[#FAF7F2] text-[#6E5D4F] border border-[#E8DEC8] hover:bg-[#8B5B43] hover:text-white rounded-full transition-all"
                  >
                    週一~五
                  </button>
                  <button
                    type="button"
                    onClick={handleSelectWeekends}
                    className="px-2 py-0.5 text-[12px] font-medium bg-[#FAF7F2] text-[#6E5D4F] border border-[#E8DEC8] hover:bg-[#8B5B43] hover:text-white rounded-full transition-all"
                  >
                    週末 (六~日)
                  </button>
                  <button
                    type="button"
                    onClick={handleSelectUnscheduledDays}
                    className="px-2 py-0.5 text-[12px] font-bold bg-amber-50 text-amber-800 border border-amber-200 hover:bg-amber-600 hover:text-white rounded-full transition-all"
                    title="一鍵選取本月尚未排班的未來日期"
                  >
                    選取未排班日
                  </button>
                  <button
                    type="button"
                    onClick={handleSelectAllMonth}
                    className="px-2 py-0.5 text-[12px] font-medium bg-[#FAF7F2] text-[#6E5D4F] border border-[#E8DEC8] hover:bg-[#8B5B43] hover:text-white rounded-full transition-all"
                  >
                    全選本月
                  </button>
                  <button
                    type="button"
                    onClick={handleClearSelected}
                    className="px-2 py-0.5 text-[12px] font-medium bg-gray-50 text-gray-500 border border-gray-200 hover:bg-red-50 hover:text-red-600 hover:border-red-200 rounded-full transition-all flex items-center gap-0.5"
                  >
                    <RotateCcw className="w-3 h-3" /> 清空
                  </button>
                </div>

                {/* Calendar Grid Container */}
                <div className="bg-[#FAF7F2]/60 border border-[#E8DEC8] rounded-2xl p-2.5 select-none">
                  <div className="grid grid-cols-7 gap-1 text-center mb-1">
                    {['日', '一', '二', '三', '四', '五', '六'].map((dayName, idx) => (
                      <div 
                        key={dayName} 
                        className={`text-[12px] font-bold py-0.5 ${idx === 0 || idx === 6 ? 'text-[#8B5B43]' : 'text-gray-400'}`}
                      >
                        {dayName}
                      </div>
                    ))}
                  </div>

                  <div className="grid grid-cols-7 gap-1">
                    {calendarDays.map((date, i) => {
                      const dateStr = format(date, 'yyyy-MM-dd');
                      const isSelected = selectedDates.includes(dateStr);
                      const isCurrentMonth = isSameMonth(date, currentMonth);
                      const isPast = isBefore(startOfDay(date), startOfDay(new Date()));
                      const isViewingList = dateStr === listDate;
                      const sessionCount = monthSessionsMap[dateStr] || 0;

                      return (
                        <div key={i} className="flex justify-center items-center">
                          <button
                            type="button"
                            onClick={() => handleDateCellClick(date)}
                            className={`relative w-8 h-8 sm:w-9 sm:h-9 rounded-xl text-xs font-semibold transition-all duration-150 flex flex-col items-center justify-center ${
                              !isCurrentMonth
                                ? 'text-gray-300 opacity-40 hover:opacity-80'
                                : isPast
                                ? 'text-gray-400 bg-gray-50/60 hover:bg-gray-100'
                                : isSelected
                                ? 'bg-sg-brown text-white shadow-sm font-bold scale-[1.03]'
                                : 'text-gray-700 hover:bg-amber-50 hover:text-amber-900'
                            } ${
                              isViewingList ? 'ring-2 ring-amber-500 ring-offset-1' : ''
                            }`}
                            title={`${dateStr}${sessionCount > 0 ? ` (已建立 ${sessionCount} 個時段)` : ''}${isViewingList ? ' [右側時段列表檢視中]' : ''}`}
                          >
                            <span className="leading-none">{format(date, 'd')}</span>
                            {sessionCount > 0 && (
                              <span 
                                className={`w-1.5 h-1.5 rounded-full mt-0.5 ${
                                  isSelected ? 'bg-emerald-300' : 'bg-emerald-500'
                                }`} 
                              />
                            )}
                          </button>
                        </div>
                      );
                    })}
                  </div>
                </div>

                {/* Calendar Legend Note */}
                <div className="flex items-center justify-between text-[12px] text-gray-500 px-1">
                  <div className="flex items-center gap-3">
                    <span className="flex items-center gap-1">
                      <span className="w-2 h-2 rounded-full bg-emerald-500 inline-block" />
                      已有時段
                    </span>
                    <span className="flex items-center gap-1">
                      <span className="w-2.5 h-2.5 rounded bg-sg-brown inline-block" />
                      已勾選
                    </span>
                    <span className="flex items-center gap-1">
                      <span className="w-2.5 h-2.5 rounded border-2 border-amber-500 inline-block" />
                      右側檢視中
                    </span>
                  </div>
                </div>
              </div>

              {/* Quick Time-Range Presets + Hour Range Drum/Scroll Picker */}
              <div className="space-y-2">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-1.5">
                  <span className="text-xs font-semibold text-gray-500">快速時段預設：</span>
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <button
                      type="button"
                      data-testid="preset-weekday-btn"
                      onClick={() => { setStartTime(businessHours.weekday.start); setEndTime(businessHours.weekday.end); }}
                      className={`px-2.5 py-1 text-[12px] font-bold rounded-xl border transition-all ${
                        startTime === businessHours.weekday.start && endTime === businessHours.weekday.end
                          ? 'bg-sg-brown text-white border-sg-brown'
                          : 'bg-white text-sg-ink border-sg-line hover:border-sg-brown'
                      }`}
                    >
                      平日 {businessHours.weekday.start} 到 {businessHours.weekday.end}
                    </button>
                    <button
                      type="button"
                      data-testid="preset-saturday-btn"
                      onClick={() => { setStartTime(businessHours.saturday.start); setEndTime(businessHours.saturday.end); }}
                      className={`px-2.5 py-1 text-[12px] font-bold rounded-xl border transition-all ${
                        startTime === businessHours.saturday.start && endTime === businessHours.saturday.end
                          ? 'bg-sg-brown text-white border-sg-brown'
                          : 'bg-white text-sg-ink border-sg-line hover:border-sg-brown'
                      }`}
                    >
                      週六 {businessHours.saturday.start} 到 {businessHours.saturday.end}
                    </button>
                    <button
                      type="button"
                      data-testid="preset-sunday-btn"
                      onClick={() => { setStartTime(businessHours.sunday.start); setEndTime(businessHours.sunday.end); }}
                      className={`px-2.5 py-1 text-[12px] font-bold rounded-xl border transition-all ${
                        startTime === businessHours.sunday.start && endTime === businessHours.sunday.end
                          ? 'bg-sg-brown text-white border-sg-brown'
                          : 'bg-white text-sg-ink border-sg-line hover:border-sg-brown'
                      }`}
                    >
                      週日 {businessHours.sunday.start} 到 {businessHours.sunday.end}
                    </button>
                  </div>
                </div>
                <HourRangeScrollPicker
                  startTime={startTime}
                  setStartTime={setStartTime}
                  endTime={endTime}
                  setEndTime={setEndTime}
                />
              </div>

              {/* Max Capacity Input */}
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label className="block text-sm font-semibold text-gray-700">
                    可預約人數
                  </label>
                  <span className="text-xs text-gray-400">
                    目前座位數：{seatCount} 個
                  </span>
                </div>
                <input
                  type="number"
                  min="1"
                  data-testid="session-capacity-input"
                  value={maxCapacity}
                  onChange={(e) => setMaxCapacity(e.target.value)}
                  className="w-full px-4 py-2.5 bg-white border border-gray-200 rounded-xl text-sm font-bold text-gray-800 focus:outline-none focus:ring-2 focus:ring-sg-brown"
                  placeholder="請輸入可預約人數"
                />
                {parseInt(maxCapacity, 10) > seatCount && (
                  <p className="mt-1.5 text-xs text-amber-600 font-medium flex items-center gap-1" data-testid="capacity-exceed-warning">
                    <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" />
                    <span>可預約人數比座位多 {parseInt(maxCapacity, 10) - seatCount} 位，可能會有人沒位子坐</span>
                  </p>
                )}
              </div>

              {/* Submit Button */}
              <button
                type="submit"
                disabled={isSubmitting || selectedDates.length === 0}
                className="w-full bg-sg-brown hover:bg-sg-brown-hover text-white font-medium py-3 rounded-xl transition-all shadow-sm disabled:opacity-50 mt-2 flex justify-center items-center gap-2"
              >
                {isSubmitting ? (
                  <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                ) : (
                  <>
                    <Plus className="w-4 h-4" />
                    確認新增 ({selectedDates.length} 天)
                  </>
                )}
              </button>

              {selectedDates.length === 0 && (
                <p className="text-center text-xs text-red-500 font-medium">
                  請在月曆上勾選至少一個欲新增時段的日期
                </p>
              )}
            </form>
          </div>
        </div>

        {/* Right Column: Sessions List for listDate */}
        <div className="xl:col-span-2 space-y-4">
          <div className="flex flex-col md:flex-row md:items-center justify-between bg-white p-4 rounded-2xl shadow-sm border border-gray-200 gap-4">
            <div className="flex items-center gap-3">
              <h2 className="font-bold text-gray-900 text-base">
                時段列表
              </h2>
              <span className="text-xs bg-[#FAF4EB] text-[#8B5B43] border border-[#E8DEC8] px-2.5 py-1 rounded-full font-bold">
                {listDate}
              </span>
            </div>
            
            <div className="flex items-center gap-3 flex-wrap">
              <label className="flex items-center cursor-pointer">
                <div className="relative">
                  <input type="checkbox" className="sr-only" checked={allowUnlimited} onChange={handleToggleUnlimited} disabled={isLoading} />
                  <div className={`block w-10 h-6 rounded-full transition-colors ${allowUnlimited ? 'bg-sg-brown' : 'bg-gray-300'}`}></div>
                  <div className={`dot absolute left-1 top-1 bg-white w-4 h-4 rounded-full transition-transform ${allowUnlimited ? 'transform translate-x-4' : ''}`}></div>
                </div>
                <div className="ml-2.5 text-xs font-semibold text-gray-700">開放不限時</div>
              </label>

              <div className="h-5 w-px bg-gray-200 hidden sm:block"></div>

              <input
                type="date"
                value={listDate}
                onChange={(e) => setListDate(e.target.value)}
                className="px-3 py-1.5 border border-gray-200 rounded-xl focus:ring-2 focus:ring-gray-900 focus:outline-none text-xs font-medium text-gray-700 bg-gray-50"
              />

              <button
                onClick={handleDeleteAllForDate}
                disabled={sessions.length === 0}
                className={`p-2 rounded-xl border transition-colors flex items-center justify-center ${
                  sessions.length === 0 
                    ? 'bg-gray-50 border-gray-100 text-gray-300 cursor-not-allowed' 
                    : 'bg-white border-red-200 text-red-500 hover:bg-red-50 hover:border-red-300 shadow-2xs'
                }`}
                title="刪除當日所有未被預約時段"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
          </div>

          <div className="bg-white rounded-2xl shadow-sm border border-gray-200 overflow-hidden">
            {isLoading ? (
              <div className="p-10 flex justify-center">
                <div className="w-8 h-8 border-4 border-gray-200 border-t-gray-800 rounded-full animate-spin" />
              </div>
            ) : sessions.length === 0 ? (
              <div className="text-center py-16 text-gray-400">
                {listDate} 尚無任何時段，可透過左側月曆勾選並快速新增
              </div>
            ) : (
              <>
                {/* Desktop Table (>= 768px) */}
                <div className="hidden md:block overflow-x-auto">
                  <table className="w-full text-left whitespace-nowrap">
                    <thead>
                      <tr className="bg-gray-50 text-gray-500 text-sm border-b border-gray-200">
                        <th className="px-6 py-4 font-medium">時段</th>
                        <th className="px-6 py-4 font-medium">可預約</th>
                        <th className="px-6 py-4 font-medium">剩餘</th>
                        <th className="px-6 py-4 font-medium">狀態</th>
                        <th className="px-6 py-4 font-medium text-right">操作</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {sessions.map(s => {
                        const isFull = s.remaining_capacity === 0;
                        return (
                          <tr key={s.id} className="hover:bg-gray-50 transition-colors group">
                            <td className="px-6 py-4 font-semibold text-gray-800">{s.start_time} - {s.end_time}</td>
                            <td className="px-6 py-4 text-gray-500">{s.max_capacity} 人</td>
                            <td className="px-6 py-4">
                              <span className={`font-bold ${isFull ? 'text-gray-300' : 'text-gray-900'}`}>
                                {s.remaining_capacity}
                              </span>
                            </td>
                            <td className="px-6 py-4">
                              {isFull ? (
                                <span className="inline-flex items-center gap-1.5 text-gray-400 text-sm">
                                  <XCircle className="w-4 h-4"/>已額滿
                                </span>
                              ) : (
                                <span className="inline-flex items-center gap-1.5 text-gray-900 text-sm font-medium">
                                  <CheckCircle2 className="w-4 h-4 text-emerald-600"/>開放中
                                </span>
                              )}
                            </td>
                            <td className="px-6 py-4 text-right">
                              <button 
                                onClick={() => handleDeleteSession(s.id)}
                                className="text-gray-400 hover:text-red-500 hover:bg-red-50 p-2 rounded-lg transition-colors"
                                title="刪除時段"
                              >
                                <Trash2 className="w-5 h-5" />
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>

                {/* Mobile Card List (< 768px) */}
                <div className="md:hidden divide-y divide-gray-100">
                  {sessions.map(s => {
                    const isFull = s.remaining_capacity === 0;
                    return (
                      <div key={s.id} className="p-4 flex items-center justify-between gap-3">
                        <div className="space-y-1">
                          <div className="flex items-center gap-2">
                            <span className="font-bold text-gray-900 text-sm">
                              {s.start_time} - {s.end_time}
                            </span>
                            {isFull ? (
                              <span className="inline-flex items-center gap-1 text-gray-400 text-xs">
                                <XCircle className="w-3.5 h-3.5" /> 已額滿
                              </span>
                            ) : (
                              <span className="inline-flex items-center gap-1 text-emerald-600 text-xs font-bold">
                                <CheckCircle2 className="w-3.5 h-3.5" /> 開放中
                              </span>
                            )}
                          </div>
                          <div className="text-xs text-gray-500">
                            剩餘 <strong className={`font-bold ${isFull ? 'text-gray-400' : 'text-gray-900'}`}>{s.remaining_capacity}</strong> / 可預約 {s.max_capacity} 人
                          </div>
                        </div>

                        <button
                          type="button"
                          onClick={() => handleDeleteSession(s.id)}
                          className="text-gray-400 hover:text-red-500 hover:bg-red-50 p-2.5 rounded-xl transition-colors shrink-0"
                          title="刪除時段"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    );
                  })}
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Bottom Grid: Price Settings & Overrides */}
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-8 mt-8">
        {/* Global Prices */}
        <div className="bg-white p-6 rounded-2xl shadow-sm border border-gray-200">
          <h2 className="text-lg font-bold text-gray-900 mb-6 flex items-center gap-2">
            預設全店價格
          </h2>
          <form onSubmit={handleUpdateGlobalPrice} className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-semibold text-gray-700 mb-1.5">平日/時</label>
                <input type="number" value={globalWeekdayHourly} onChange={e => setGlobalWeekdayHourly(e.target.value)} placeholder="100" className="w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl focus:ring-2 focus:ring-gray-900 focus:outline-none transition-all text-sm"/>
              </div>
              <div>
                <label className="block text-sm font-semibold text-gray-700 mb-1.5">平日/上限</label>
                <input type="number" value={globalWeekdayUnlimited} onChange={e => setGlobalWeekdayUnlimited(e.target.value)} placeholder="550" className="w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl focus:ring-2 focus:ring-gray-900 focus:outline-none transition-all text-sm"/>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-semibold text-gray-700 mb-1.5">假日/時</label>
                <input type="number" value={globalWeekendHourly} onChange={e => setGlobalWeekendHourly(e.target.value)} placeholder="150" className="w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl focus:ring-2 focus:ring-gray-900 focus:outline-none transition-all text-sm"/>
              </div>
              <div>
                <label className="block text-sm font-semibold text-gray-700 mb-1.5">假日/上限</label>
                <input type="number" value={globalWeekendUnlimited} onChange={e => setGlobalWeekendUnlimited(e.target.value)} placeholder="800" className="w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl focus:ring-2 focus:ring-gray-900 focus:outline-none transition-all text-sm"/>
              </div>
            </div>
            <button type="submit" className="w-full bg-sg-brown hover:bg-sg-brown-hover text-white font-medium py-3 rounded-xl transition-all shadow-sm">儲存全店預設</button>
          </form>
        </div>

        {/* Daily Prices Overrides */}
        <div className="bg-white p-6 rounded-2xl shadow-sm border border-gray-200">
          <h2 className="text-lg font-bold text-gray-900 mb-6 flex items-center gap-2">
            {format(new Date(listDate), 'yyyy-MM-dd')} 單日覆蓋設定
          </h2>
          <form onSubmit={handleUpdateDailyPrice} className="space-y-4">
            <div>
              <label className="block text-sm font-semibold text-gray-700 mb-1.5">每小時價格 (留空使用預設)</label>
              <input type="number" value={dailyHourly} onChange={e => setDailyHourly(e.target.value)} placeholder="留空使用預設" className="w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl focus:ring-2 focus:ring-gray-900 focus:outline-none transition-all text-sm"/>
            </div>
            <div>
              <label className="block text-sm font-semibold text-gray-700 mb-1.5">不限時價格 (留空使用預設)</label>
              <input type="number" value={dailyUnlimited} onChange={e => setDailyUnlimited(e.target.value)} placeholder="留空使用預設" className="w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl focus:ring-2 focus:ring-gray-900 focus:outline-none transition-all text-sm"/>
            </div>
            <button type="submit" className="w-full bg-sg-brown hover:bg-sg-brown-hover text-white font-medium py-3 rounded-xl transition-all shadow-sm">儲存單日覆蓋</button>
          </form>
        </div>

        {/* Batch Prices Overrides */}
        <div className="bg-white p-6 rounded-2xl shadow-sm border border-gray-200">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-bold text-gray-900 flex items-center gap-2">
              <Sparkles className="w-5 h-5 text-amber-600" />
              批次修改價格覆蓋
            </h2>
          </div>

          {/* Mode Switcher */}
          <div className="flex items-center gap-1.5 bg-gray-100 p-1 rounded-xl mb-4 text-xs font-semibold">
            <button
              type="button"
              onClick={() => setBatchMode('selected')}
              className={`flex-1 py-1.5 px-2 rounded-lg transition-all ${
                batchMode === 'selected'
                  ? 'bg-white text-gray-900 shadow-2xs font-bold'
                  : 'text-gray-500 hover:text-gray-800'
              }`}
            >
              套用月曆已選 ({selectedDates.length} 天)
            </button>
            <button
              type="button"
              onClick={() => setBatchMode('range')}
              className={`flex-1 py-1.5 px-2 rounded-lg transition-all ${
                batchMode === 'range'
                  ? 'bg-white text-gray-900 shadow-2xs font-bold'
                  : 'text-gray-500 hover:text-gray-800'
              }`}
            >
              自訂起訖日期
            </button>
          </div>

          <form onSubmit={handleBatchUpdatePrices} className="space-y-4">
            {batchMode === 'selected' ? (
              <div className="bg-amber-50/70 border border-amber-200/80 rounded-xl p-3 text-xs text-amber-900">
                <span className="font-bold">將套用至上方月曆勾選的日期：</span>
                {selectedDates.length > 0 ? (
                  <div className="mt-1.5 flex flex-wrap gap-1 max-h-24 overflow-y-auto">
                    {selectedDates.map(d => (
                      <span key={d} className="bg-white border border-amber-200/90 px-1.5 py-0.5 rounded text-[12px] font-mono font-medium shadow-2xs">
                        {d}
                      </span>
                    ))}
                  </div>
                ) : (
                  <p className="mt-1 text-red-500 font-medium">尚未在月曆上勾選任何日期，請先至上方月曆勾選日期</p>
                )}
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-semibold text-gray-700 mb-1.5">開始日期</label>
                  <input
                    type="date"
                    required
                    value={batchStartDate}
                    onChange={e => {
                      setBatchStartDate(e.target.value);
                      if (e.target.value > batchEndDate) setBatchEndDate(e.target.value);
                    }}
                    className="w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl focus:ring-2 focus:ring-gray-900 focus:outline-none transition-all text-sm"
                  />
                </div>
                <div>
                  <label className="block text-sm font-semibold text-gray-700 mb-1.5">結束日期</label>
                  <input
                    type="date"
                    required
                    min={batchStartDate}
                    value={batchEndDate}
                    onChange={e => setBatchEndDate(e.target.value)}
                    className="w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl focus:ring-2 focus:ring-gray-900 focus:outline-none transition-all text-sm"
                  />
                </div>
              </div>
            )}

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-semibold text-gray-700 mb-1.5">每小時價格</label>
                <input
                  type="number"
                  value={batchHourly}
                  onChange={e => setBatchHourly(e.target.value)}
                  placeholder="留空清除覆蓋"
                  className="w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl focus:ring-2 focus:ring-gray-900 focus:outline-none transition-all text-sm"
                />
              </div>
              <div>
                <label className="block text-sm font-semibold text-gray-700 mb-1.5">不限時價格</label>
                <input
                  type="number"
                  value={batchUnlimited}
                  onChange={e => setBatchUnlimited(e.target.value)}
                  placeholder="留空清除覆蓋"
                  className="w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl focus:ring-2 focus:ring-gray-900 focus:outline-none transition-all text-sm"
                />
              </div>
            </div>

            <div className="rounded-xl border border-amber-200/80 bg-amber-50/50 p-3 space-y-2.5">
              <label className="flex items-center gap-2 cursor-pointer text-sm font-bold text-gray-800">
                <input
                  type="checkbox"
                  checked={batchSetSelfService}
                  onChange={(e) => setBatchSetSelfService(e.target.checked)}
                  className="w-4 h-4 accent-[#8B5B43]"
                />
                <span>把這些日期設成半自助日</span>
              </label>
              {batchSetSelfService && (
                <div className="space-y-2.5 pl-6 text-xs">
                  <label className="flex items-center gap-2 cursor-pointer font-semibold text-gray-700">
                    <input
                      type="checkbox"
                      checked={batchSelfAllowEquipment}
                      onChange={(e) => setBatchSelfAllowEquipment(e.target.checked)}
                      className="w-4 h-4 accent-[#8B5B43]"
                    />
                    <span>開放加租智能板</span>
                  </label>
                  <div className="space-y-1.5">
                    <div className="font-semibold text-gray-700">熨燙時間</div>
                    <div className="flex flex-wrap gap-1.5">
                      {[
                        { id: 'today', label: '當日下午' },
                        { id: 'next', label: '隔日' },
                        { id: 'date', label: '指定日期' }
                      ].map(opt => (
                        <button
                          key={opt.id}
                          type="button"
                          onClick={() => setBatchIronMode(opt.id)}
                          className={`px-2.5 py-1 rounded-lg border font-bold ${
                            batchIronMode === opt.id
                              ? 'bg-[#8B5B43] text-white border-[#8B5B43]'
                              : 'bg-white text-gray-700 border-gray-200'
                          }`}
                        >
                          {opt.label}
                        </button>
                      ))}
                    </div>
                    {batchIronMode === 'date' && (
                      <input
                        type="date"
                        value={batchIronDate}
                        onChange={(e) => setBatchIronDate(e.target.value)}
                        className="mt-1 px-3 py-1.5 bg-white border border-gray-200 rounded-lg text-xs"
                      />
                    )}
                  </div>
                </div>
              )}
            </div>

            <button
              type="submit"
              disabled={isBatching || (batchMode === 'selected' && selectedDates.length === 0)}
              className="w-full bg-sg-brown hover:bg-sg-brown-hover text-white font-medium py-3 rounded-xl transition-all shadow-sm disabled:opacity-50"
            >
              {isBatching ? (
                <div className="w-5 h-5 mx-auto border-2 border-white/30 border-t-white rounded-full animate-spin" />
              ) : (
                batchMode === 'selected' ? `批次儲存覆蓋 (${selectedDates.length} 天)` : '批次儲存覆蓋'
              )}
            </button>
          </form>
        </div>
      </div>

      {/* Self-Service Settings Grid (Single Day + Global Kiosk Rules) */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-8 mt-8">
        {/* Daily Self-Service Card */}
        <form onSubmit={handleSaveDailySelfService} className="bg-white p-6 rounded-2xl shadow-sm border border-gray-200 space-y-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="text-lg font-bold text-gray-900">
                {listDate} 半自助日設定
              </h2>
              <p className="text-xs text-gray-500 mt-0.5">
                顧客要先付款，當天憑門口報到機進場
              </p>
            </div>
            <label className="flex items-center gap-2 cursor-pointer shrink-0">
              <div className="relative">
                <input
                  type="checkbox"
                  data-testid="daily-self-service-toggle"
                  className="sr-only"
                  checked={isSelfService}
                  onChange={(e) => {
                    setIsSelfService(e.target.checked);
                    setDailySelfError('');
                  }}
                />
                <div className={`block w-11 h-6 rounded-full transition-colors ${isSelfService ? 'bg-[#8B5B43]' : 'bg-gray-300'}`} />
                <div className={`dot absolute left-1 top-1 bg-white w-4 h-4 rounded-full transition-transform ${isSelfService ? 'translate-x-5' : ''}`} />
              </div>
              <span className="text-sm font-bold text-gray-800">半自助日</span>
            </label>
          </div>

          {dailySelfError && (
            <div className="bg-red-50 border border-red-200 text-red-700 text-xs font-medium rounded-xl px-3 py-2">
              {dailySelfError}
            </div>
          )}

          {isSelfService ? (
            <div className="space-y-4 pt-2 border-t border-gray-100">
              {/* Plans */}
              <div className="space-y-2 text-sm">
                <div className="font-semibold text-gray-700">開放方案</div>
                <div className="flex flex-wrap items-center gap-4">
                  <label className="flex items-center gap-2 text-gray-800 font-medium">
                    <input type="checkbox" checked readOnly className="w-4 h-4 accent-[#8B5B43]" />
                    <span>不限時（沿用上方價格）</span>
                  </label>
                  <label className="flex items-center gap-2 cursor-pointer text-gray-800 font-medium">
                    <input
                      type="checkbox"
                      data-testid="daily-self-allow-hourly-toggle"
                      checked={selfAllowHourly}
                      onChange={(e) => setSelfAllowHourly(e.target.checked)}
                      className="w-4 h-4 accent-[#8B5B43]"
                    />
                    <span>一般計時</span>
                    <span className="text-xs text-gray-400">前期先不開放</span>
                  </label>
                </div>
              </div>

              {/* Equipment toggle */}
              <div className="space-y-2 text-sm">
                <div className="flex items-center justify-between gap-2">
                  <div>
                    <div className="font-semibold text-gray-700">開放加租智能板</div>
                    <div className="text-xs text-gray-400">價格和數量在「智能板庫存管理」設定。</div>
                  </div>
                  <label className="flex items-center gap-2 cursor-pointer shrink-0">
                    <input
                      type="checkbox"
                      data-testid="daily-self-allow-equipment-toggle"
                      checked={selfAllowEquipment}
                      onChange={(e) => setSelfAllowEquipment(e.target.checked)}
                      className="w-4 h-4 accent-[#8B5B43]"
                    />
                    <span className="text-xs font-bold text-gray-700">{selfAllowEquipment ? '已開放' : '未開放'}</span>
                  </label>
                </div>
                {selfAllowEquipment && !anySelfEquipmentEnabled && (
                  <div className="bg-amber-50 border border-amber-200 text-amber-800 text-xs rounded-xl px-3 py-2 flex items-center justify-between gap-2">
                    <span>目前沒有任何一款智能板在半自助日開放租借，顧客端仍看不到板子。</span>
                    <a href="/admin/equipment" className="font-bold text-[#8B5B43] underline shrink-0">
                      前往智能板庫存管理 →
                    </a>
                  </div>
                )}
              </div>

              {/* Iron mode */}
              <div className="space-y-2 text-sm">
                <div className="font-semibold text-gray-700">熨燙時間</div>
                <div className="flex flex-wrap gap-2">
                  {[
                    { id: 'today', label: '當日下午' },
                    { id: 'next', label: '隔日' },
                    { id: 'date', label: '指定日期' }
                  ].map(opt => (
                    <button
                      key={opt.id}
                      type="button"
                      data-testid={`iron-mode-${opt.id}`}
                      onClick={() => setIronMode(opt.id)}
                      className={`px-3 py-1.5 rounded-xl border text-xs font-bold transition ${
                        ironMode === opt.id
                          ? 'bg-[#8B5B43] text-white border-[#8B5B43]'
                          : 'bg-gray-50 text-gray-700 border-gray-200 hover:bg-gray-100'
                      }`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
                {ironMode === 'date' && (
                  <input
                    type="date"
                    min={listDate}
                    value={ironDate}
                    onChange={(e) => setIronDate(e.target.value)}
                    className="mt-1 px-3 py-2 bg-gray-50 border border-gray-200 rounded-xl text-sm"
                  />
                )}
              </div>

              {/* Preview InfoCard */}
              <div className="space-y-1.5">
                <div className="text-xs font-semibold text-gray-500">預覽：顧客在預約頁會看到的說明卡</div>
                <div className="max-w-sm">
                  <SelfServiceInfoCard
                    ironText={buildIronText({ iron_mode: ironMode, iron_date: ironDate, date: listDate })}
                    earlyMinutes={kioskSettings.early_minutes}
                    deadlineHour={kioskSettings.prepay_deadline_hour}
                    showPaymentLine
                  />
                </div>
              </div>
            </div>
          ) : (
            <div className="text-xs text-gray-500 bg-gray-50 border border-gray-100 rounded-xl p-3">
              一般營業日：照原本價格和不限時開關運作，顧客現場報到、離場結帳。
            </div>
          )}

          <button
            type="submit"
            disabled={savingDailySelf}
            data-testid="save-daily-self-service-btn"
            className="w-full bg-sg-brown hover:bg-sg-brown-hover text-white font-medium py-3 rounded-xl transition-all shadow-sm disabled:opacity-50"
          >
            {savingDailySelf ? '儲存中...' : `儲存 ${listDate} 半自助日設定`}
          </button>
        </form>

        {/* Shared Kiosk / Self-Service Settings */}
        <form onSubmit={handleSaveKioskSettings} className="bg-white p-6 rounded-2xl shadow-sm border border-gray-200 space-y-4 flex flex-col justify-between">
          <div className="space-y-4">
            <div>
              <h2 className="text-lg font-bold text-gray-900">半自助日共用設定</h2>
              <p className="text-xs text-gray-500 mt-0.5">全店共用，不分日期</p>
            </div>

            <div className="space-y-3 text-sm">
              <div className="flex items-center justify-between gap-3 bg-gray-50 p-3 rounded-xl border border-gray-100">
                <span className="font-semibold text-gray-700">付款期限：前一日</span>
                <div className="flex items-center gap-1.5">
                  <input
                    type="number"
                    min="0"
                    max="23"
                    value={kioskSettings.prepay_deadline_hour}
                    onChange={(e) => setKioskSettings(prev => ({ ...prev, prepay_deadline_hour: e.target.value }))}
                    className="w-20 px-3 py-1.5 bg-white border border-gray-200 rounded-lg font-bold text-right"
                  />
                  <span className="text-gray-600 font-bold">:00</span>
                </div>
              </div>

              <div className="flex items-center justify-between gap-3 bg-gray-50 p-3 rounded-xl border border-gray-100">
                <span className="font-semibold text-gray-700">最早提前進場</span>
                <div className="flex items-center gap-1.5">
                  <input
                    type="number"
                    min="0"
                    max="120"
                    value={kioskSettings.early_minutes}
                    onChange={(e) => setKioskSettings(prev => ({ ...prev, early_minutes: e.target.value }))}
                    className="w-20 px-3 py-1.5 bg-white border border-gray-200 rounded-lg font-bold text-right"
                  />
                  <span className="text-gray-600">分鐘進場</span>
                </div>
              </div>

              <div className="flex items-center justify-between gap-3 bg-gray-50 p-3 rounded-xl border border-gray-100">
                <span className="font-semibold text-gray-700">打烊後仍可進門</span>
                <div className="flex items-center gap-1.5">
                  <input
                    type="number"
                    min="0"
                    max="240"
                    value={kioskSettings.after_close_minutes}
                    onChange={(e) => setKioskSettings(prev => ({ ...prev, after_close_minutes: e.target.value }))}
                    className="w-20 px-3 py-1.5 bg-white border border-gray-200 rounded-lg font-bold text-right"
                  />
                  <span className="text-gray-600">分鐘內</span>
                </div>
              </div>

              <div className="flex items-center justify-between gap-3 bg-gray-50 p-3 rounded-xl border border-gray-100">
                <span className="font-semibold text-gray-700">同一位會員最多同時待付款預約</span>
                <div className="flex items-center gap-1.5">
                  <input
                    type="number"
                    min="1"
                    max="10"
                    value={kioskSettings.max_unpaid_self_bookings}
                    onChange={(e) => setKioskSettings(prev => ({ ...prev, max_unpaid_self_bookings: e.target.value }))}
                    className="w-20 px-3 py-1.5 bg-white border border-gray-200 rounded-lg font-bold text-right"
                  />
                  <span className="text-gray-600">筆</span>
                </div>
              </div>
            </div>
          </div>

          <button
            type="submit"
            disabled={savingKioskSettings}
            data-testid="save-kiosk-settings-btn"
            className="w-full bg-sg-brown hover:bg-sg-brown-hover text-white font-medium py-3 rounded-xl transition-all shadow-sm disabled:opacity-50"
          >
            {savingKioskSettings ? '儲存中...' : '儲存半自助日共用設定'}
          </button>
        </form>
      </div>

      {/* Shortcut Banner to Dedicated System Settings Page */}
      <div className="bg-[#FAF7F2] p-5 sm:p-6 rounded-2xl shadow-xs border border-[#E8DEC8] mt-8 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div className="flex items-start gap-3">
          <div className="p-2.5 rounded-xl bg-white border border-[#E8DEC8] text-[#8B5B43] shrink-0">
            <Sliders className="w-5 h-5" />
          </div>
          <div>
            <h2 className="text-base font-bold text-[#3E332B]">
              顧客端首頁顯示、LINE 每次登入驗證與空位預覽開關已整合至「系統全域設定」
            </h2>
            <p className="text-xs text-[#6D5D52] mt-0.5 leading-relaxed">
              欲調整頂部公告欄、入場價格說明卡、官方 LINE 按鈕、空位預覽頁 (`/preview`) 維護開關或「每次使用皆須從 LINE 登入」，請前往系統全域設定頁面。
            </p>
          </div>
        </div>
        <a
          href="/admin/settings"
          className="px-5 py-2.5 bg-[#8B5B43] hover:bg-[#724a35] text-white font-bold rounded-xl text-xs sm:text-sm shadow-xs transition-all text-center shrink-0"
        >
          前往系統全域設定 →
        </a>
      </div>

      {/* Delete Single Session Confirmation */}
      <ConfirmPanel
        isOpen={Boolean(deleteSessionTargetId)}
        onClose={() => setDeleteSessionTargetId(null)}
        onConfirm={handleConfirmDeleteSession}
        title="刪除時段"
        message="確定要刪除此時段嗎？"
        confirmText="刪除"
        danger
      />

      {/* Delete All Sessions Confirmation */}
      <ConfirmPanel
        isOpen={showDeleteAllConfirm}
        onClose={() => setShowDeleteAllConfirm(false)}
        onConfirm={handleConfirmDeleteAllForDate}
        title="刪除當日所有時段"
        message={`確定要刪除 ${listDate} 的所有未被預約時段嗎？已有預約的時段會自動保留。`}
        confirmText="確認刪除"
        danger
      />
    </div>
  );
}
