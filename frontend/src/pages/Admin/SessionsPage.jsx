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
  MessageSquare
} from 'lucide-react';
import api from '../../api/axios';
import HourRangeScrollPicker from '../../components/HourRangeScrollPicker';

export default function SessionsPage() {
  const [currentMonth, setCurrentMonth] = useState(startOfMonth(new Date()));
  const [selectedDates, setSelectedDates] = useState([format(new Date(), 'yyyy-MM-dd')]);
  const [listDate, setListDate] = useState(format(new Date(), 'yyyy-MM-dd'));
  const [monthSessionsMap, setMonthSessionsMap] = useState({});

  const [startTime, setStartTime] = useState('13:00');
  const [endTime, setEndTime] = useState('21:00');
  const [maxCapacity, setMaxCapacity] = useState(10);
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
  const [isBatching, setIsBatching] = useState(false);

  useEffect(() => {
    fetchGlobalSetting();
  }, []);

  useEffect(() => {
    fetchSessions(listDate);
    fetchDailySetting(listDate);
  }, [listDate]);

  useEffect(() => {
    fetchMonthSessions(currentMonth);
  }, [currentMonth]);

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
      setAnnouncementText(res.data.announcement_text ?? '✨ 歡迎來到拾光製所！線上預約享即時選位，智能拼豆板租借滿時數再享買送折抵優惠');
      setShowLineButton(res.data.show_line_button !== false);
      setLineButtonUrl(res.data.line_button_url || 'https://lin.ee/vsZhRW5');
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
      alert('顧客端首頁顯示設定已成功更新！');
    } catch (err) {
      console.error(err);
      alert('更新顯示設定失敗');
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
    } catch (err) {
      console.error('Error fetching daily setting:', err);
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
      alert('更新設定失敗');
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
      alert('全店預設價格更新成功！');
    } catch (err) {
      alert('更新失敗');
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
      alert('單日覆蓋價格更新成功！');
    } catch (err) {
      alert('更新失敗');
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

      if (batchMode === 'selected') {
        if (selectedDates.length === 0) {
          alert('請先在上方月曆勾選日期');
          setIsBatching(false);
          return;
        }
        payload.dates = selectedDates;
      } else {
        payload.start_date = batchStartDate;
        payload.end_date = batchEndDate;
      }

      const res = await api.post('/daily-settings/batch', payload);
      alert(`批次修改成功！${res.data?.message || ''}`);
      fetchDailySetting(listDate);
    } catch (err) {
      alert(err.response?.data?.error || '批次修改失敗');
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
      alert('請先在月曆上勾選至少一個欲新增時段的日期');
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
      alert(`時段新增成功！已為 ${sortedDates.length} 天新增 ${startTime} ~ ${endTime} 時段`);
      fetchSessions(listDate);
      fetchMonthSessions(currentMonth);
    } catch (err) {
      alert(err.response?.data?.error || '新增失敗');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDeleteSession = async (id) => {
    if (window.confirm('確定要刪除此時段嗎？')) {
      try {
        await api.delete(`/sessions/${id}`);
        fetchSessions(listDate);
        fetchMonthSessions(currentMonth);
      } catch (err) {
        alert(err.response?.data?.error || '刪除失敗');
      }
    }
  };

  const handleDeleteAllForDate = async () => {
    if (sessions.length === 0) return;
    if (window.confirm(`確定要刪除 ${listDate} 的「所有未被預約」的時段嗎？\n(已有預約的時段會自動保留)`)) {
      try {
        const res = await api.delete(`/sessions/date/${listDate}`);
        alert(`成功刪除 ${res.data.deletedCount} 個時段。${res.data.keptCount > 0 ? `\n(保留了 ${res.data.keptCount} 個已被預約的時段)` : ''}`);
        fetchSessions(listDate);
        fetchMonthSessions(currentMonth);
      } catch (err) {
        alert(err.response?.data?.error || '刪除失敗');
      }
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
    <div className="p-4 md:p-8 space-y-8 animate-fade-in">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 tracking-tight">營業時段設定</h1>
          <p className="text-gray-500 mt-1 text-sm">支援月曆多選批次排班、整點磁吸滾輪快速設定與價格覆蓋。</p>
        </div>
      </div>

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
                    className="px-2 py-0.5 text-[11px] font-medium bg-[#FAF7F2] text-[#6E5D4F] border border-[#E8DEC8] hover:bg-[#8B5B43] hover:text-white rounded-full transition-all"
                  >
                    📅 平日 (二~五)
                  </button>
                  <button
                    type="button"
                    onClick={handleSelectMonToFri}
                    className="px-2 py-0.5 text-[11px] font-medium bg-[#FAF7F2] text-[#6E5D4F] border border-[#E8DEC8] hover:bg-[#8B5B43] hover:text-white rounded-full transition-all"
                  >
                    📅 週一~五
                  </button>
                  <button
                    type="button"
                    onClick={handleSelectWeekends}
                    className="px-2 py-0.5 text-[11px] font-medium bg-[#FAF7F2] text-[#6E5D4F] border border-[#E8DEC8] hover:bg-[#8B5B43] hover:text-white rounded-full transition-all"
                  >
                    🌟 週末 (六~日)
                  </button>
                  <button
                    type="button"
                    onClick={handleSelectUnscheduledDays}
                    className="px-2 py-0.5 text-[11px] font-bold bg-amber-50 text-amber-800 border border-amber-200 hover:bg-amber-600 hover:text-white rounded-full transition-all"
                    title="一鍵選取本月尚未排班的未來日期"
                  >
                    🔍 選取未排班日
                  </button>
                  <button
                    type="button"
                    onClick={handleSelectAllMonth}
                    className="px-2 py-0.5 text-[11px] font-medium bg-[#FAF7F2] text-[#6E5D4F] border border-[#E8DEC8] hover:bg-[#8B5B43] hover:text-white rounded-full transition-all"
                  >
                    🗓️ 全選本月
                  </button>
                  <button
                    type="button"
                    onClick={handleClearSelected}
                    className="px-2 py-0.5 text-[11px] font-medium bg-gray-50 text-gray-500 border border-gray-200 hover:bg-red-50 hover:text-red-600 hover:border-red-200 rounded-full transition-all flex items-center gap-0.5"
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
                        className={`text-[11px] font-bold py-0.5 ${idx === 0 || idx === 6 ? 'text-[#8B5B43]' : 'text-gray-400'}`}
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
                                ? 'bg-gray-900 text-white shadow-sm font-bold scale-[1.03]'
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
                <div className="flex items-center justify-between text-[11px] text-gray-500 px-1">
                  <div className="flex items-center gap-3">
                    <span className="flex items-center gap-1">
                      <span className="w-2 h-2 rounded-full bg-emerald-500 inline-block" />
                      已有時段
                    </span>
                    <span className="flex items-center gap-1">
                      <span className="w-2.5 h-2.5 rounded bg-gray-900 inline-block" />
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
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-gray-500">快速時段預設：</span>
                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => { setStartTime('13:00'); setEndTime('21:00'); }}
                      className={`px-2 py-0.5 text-[11px] font-bold rounded-full border transition-all ${
                        startTime === '13:00' && endTime === '21:00'
                          ? 'bg-[#8B5B43] text-white border-[#8B5B43]'
                          : 'bg-[#FAF7F2] text-[#6E5D4F] border-[#E8DEC8] hover:bg-[#8B5B43] hover:text-white'
                      }`}
                    >
                      ⚡ 平日 13:00-21:00
                    </button>
                    <button
                      type="button"
                      onClick={() => { setStartTime('10:00'); setEndTime('21:00'); }}
                      className={`px-2 py-0.5 text-[11px] font-bold rounded-full border transition-all ${
                        startTime === '10:00' && endTime === '21:00'
                          ? 'bg-[#8B5B43] text-white border-[#8B5B43]'
                          : 'bg-[#FAF7F2] text-[#6E5D4F] border-[#E8DEC8] hover:bg-[#8B5B43] hover:text-white'
                      }`}
                    >
                      ⚡ 假日 10:00-21:00
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
                <label className="block text-sm font-semibold text-gray-700 mb-1.5">
                  每時段容納人數 (預設 10 人)
                </label>
                <input
                  type="number"
                  min="1"
                  required
                  value={maxCapacity}
                  onChange={(e) => setMaxCapacity(e.target.value)}
                  className="w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl focus:ring-2 focus:ring-gray-900 focus:outline-none transition-all text-sm font-bold text-gray-800"
                />
              </div>

              {/* Submit Button */}
              <button
                type="submit"
                disabled={isSubmitting || selectedDates.length === 0}
                className="w-full bg-gray-900 hover:bg-gray-800 text-white font-medium py-3 rounded-xl transition-all shadow-sm disabled:opacity-50 mt-2 flex justify-center items-center gap-2"
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
                  <div className={`block w-10 h-6 rounded-full transition-colors ${allowUnlimited ? 'bg-purple-500' : 'bg-gray-300'}`}></div>
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
            <div className="overflow-x-auto">
              {isLoading ? (
                <div className="p-10 flex justify-center">
                  <div className="w-8 h-8 border-4 border-gray-200 border-t-gray-800 rounded-full animate-spin" />
                </div>
              ) : (
                <table className="w-full text-left whitespace-nowrap">
                  <thead>
                    <tr className="bg-gray-50 text-gray-500 text-sm border-b border-gray-200">
                      <th className="px-6 py-4 font-medium">時段</th>
                      <th className="px-6 py-4 font-medium">總座位</th>
                      <th className="px-6 py-4 font-medium">剩餘座位</th>
                      <th className="px-6 py-4 font-medium">狀態</th>
                      <th className="px-6 py-4 font-medium text-right">操作</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {sessions.length === 0 ? (
                      <tr>
                        <td colSpan="5" className="text-center py-16 text-gray-400">
                          {listDate} 尚無任何時段，可透過左側月曆勾選並快速新增
                        </td>
                      </tr>
                    ) : (
                      sessions.map(s => {
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
                      })
                    )}
                  </tbody>
                </table>
              )}
            </div>
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
            <button type="submit" className="w-full bg-gray-900 hover:bg-gray-800 text-white font-medium py-3 rounded-xl transition-all shadow-sm">儲存全店預設</button>
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
            <button type="submit" className="w-full bg-gray-900 hover:bg-gray-800 text-white font-medium py-3 rounded-xl transition-all shadow-sm">儲存單日覆蓋</button>
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
              ✨ 套用月曆已選 ({selectedDates.length} 天)
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
              📅 自訂起訖日期
            </button>
          </div>

          <form onSubmit={handleBatchUpdatePrices} className="space-y-4">
            {batchMode === 'selected' ? (
              <div className="bg-amber-50/70 border border-amber-200/80 rounded-xl p-3 text-xs text-amber-900">
                <span className="font-bold">將套用至上方月曆勾選的日期：</span>
                {selectedDates.length > 0 ? (
                  <div className="mt-1.5 flex flex-wrap gap-1 max-h-24 overflow-y-auto">
                    {selectedDates.map(d => (
                      <span key={d} className="bg-white border border-amber-200/90 px-1.5 py-0.5 rounded text-[11px] font-mono font-medium shadow-2xs">
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

            <button
              type="submit"
              disabled={isBatching || (batchMode === 'selected' && selectedDates.length === 0)}
              className="w-full bg-gray-900 hover:bg-gray-800 text-white font-medium py-3 rounded-xl transition-all shadow-sm disabled:opacity-50"
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
          ⚙️ 前往系統全域設定 →
        </a>
      </div>
    </div>
  );
}
