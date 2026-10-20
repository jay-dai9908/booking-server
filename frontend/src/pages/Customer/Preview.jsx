import React, { useState, useEffect } from 'react';
import { format, addDays, startOfMonth, endOfMonth, startOfWeek, endOfWeek, isSameMonth, isSameDay, addMonths, subMonths, isBefore, startOfDay } from 'date-fns';
import api from '../../api/axios';

const GLOBAL_SETTINGS_CACHE_KEY = 'shiguang_booking_global_settings_cache';

function Preview() {
  const [selectedDate, setSelectedDate] = useState(new Date());
  const [sessions, setSessions] = useState([]);
  const [loading, setLoading] = useState(false);
  const [currentMonth, setCurrentMonth] = useState(startOfMonth(new Date()));
  const [monthOpenDatesSet, setMonthOpenDatesSet] = useState(new Set());

  // Global settings state
  const [globalPricing, setGlobalPricing] = useState({
    weekday_hourly: 150,
    weekday_unlimited: 750,
    weekend_hourly: 180,
    weekend_unlimited: 1100
  });
  const [showPriceCards, setShowPriceCards] = useState(true);
  const [priceNoticeText, setPriceNoticeText] = useState('費用皆含基礎傳統拼豆板與豆子無限使用．預約現場保留 15 分鐘．離場前請預留 10 分鐘壓平作品');
  const [showAnnouncement, setShowAnnouncement] = useState(true);
  const [announcementText, setAnnouncementText] = useState('✨ 歡迎來到拾光製所！線上預約享即時選位，智能拼豆板租借滿時數再享買送折抵優惠');
  const [showAnnouncementModal, setShowAnnouncementModal] = useState(false);
  const [lineButtonUrl, setLineButtonUrl] = useState('https://lin.ee/vsZhRW5');

  // Load cached settings immediately
  useEffect(() => {
    try {
      const raw = localStorage.getItem(GLOBAL_SETTINGS_CACHE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
          setGlobalPricing({
            weekday_hourly: Number(parsed.weekday_hourly) || 150,
            weekday_unlimited: Number(parsed.weekday_unlimited) || 750,
            weekend_hourly: Number(parsed.weekend_hourly) || 180,
            weekend_unlimited: Number(parsed.weekend_unlimited) || 1100
          });
          setShowPriceCards(parsed.showPriceCards !== false);
          setPriceNoticeText(parsed.priceNoticeText ?? '費用皆含基礎傳統拼豆板與豆子無限使用．預約現場保留 15 分鐘．離場前請預留 10 分鐘壓平作品');
          setShowAnnouncement(parsed.showAnnouncement !== false);
          setAnnouncementText(parsed.announcementText ?? '✨ 歡迎來到拾光製所！線上預約享即時選位，智能拼豆板租借滿時數再享買送折抵優惠');
          setLineButtonUrl(parsed.lineButtonUrl || 'https://lin.ee/vsZhRW5');
        }
      }
    } catch (e) {
      // ignore
    }

    const fetchGlobal = async () => {
      try {
        const res = await api.get('/global-settings');
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
          const lineUrl = res.data.line_button_url || 'https://lin.ee/vsZhRW5';

          setGlobalPricing(pricing);
          setShowPriceCards(cardsVisible);
          setPriceNoticeText(notice);
          setShowAnnouncement(announceVisible);
          setAnnouncementText(announce);
          setLineButtonUrl(lineUrl);
        }
      } catch (err) {
        console.error('Failed to fetch global settings in preview:', err);
      }
    };
    fetchGlobal();
  }, []);

  // Fetch month sessions to display green dots for open dates
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
      console.error('Failed to fetch month sessions for preview calendar:', err);
    }
  };

  useEffect(() => {
    fetchMonthSessions(currentMonth);
  }, [currentMonth]);

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

  useEffect(() => {
    fetchSessions(selectedDate);
  }, [selectedDate]);

  const fetchSessions = async (date) => {
    setLoading(true);
    try {
      const formattedDate = format(date, 'yyyy-MM-dd');
      const res = await api.get(`/sessions?date=${formattedDate}`);
      setSessions(res.data);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  const isSessionPast = (session) => {
    if (!isSameDay(selectedDate, new Date())) return false;
    const now = new Date();
    const [hours, minutes] = session.start_time.split(':').map(Number);
    const sessionTime = new Date();
    sessionTime.setHours(hours, minutes, 0, 0);
    return now >= sessionTime;
  };

  return (
    <div className="min-h-screen bg-wood-bg text-wood-textMain pb-32 font-sans transition-colors duration-300">
      {/* Top Announcement Banner */}
      {showAnnouncement && (
        <div 
          onClick={() => setShowAnnouncementModal(true)}
          className="bg-[#F4EFE6] border-b border-[#E8DEC8] px-4 py-2.5 text-xs text-[#8B5B43] flex items-center justify-between cursor-pointer hover:bg-[#EFE9DE] transition-colors"
        >
          <div className="max-w-3xl mx-auto flex items-center gap-2 overflow-hidden w-full">
            <span className="shrink-0 text-base">📢</span>
            <span className="truncate font-medium">{announcementText}</span>
            <span className="shrink-0 text-[11px] underline opacity-80 ml-auto">查看公告</span>
          </div>
        </div>
      )}

      {/* Header */}
      <header className="sticky top-0 z-40 bg-wood-bg/90 backdrop-blur-md border-b border-wood-border px-4 py-4 mb-6">
        <div className="max-w-3xl mx-auto flex justify-center items-center gap-3">
          <img src="/logo.png" alt="拾光製所 Logo" className="w-8 h-8 object-cover rounded-full" />
          <h1 className="text-xl font-bold tracking-wide">拾光製所 預約時段預覽</h1>
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-4 space-y-6">
        {/* Pricing Cards */}
        {showPriceCards && (
          <section className="bg-wood-card p-5 rounded-2xl shadow-warm border border-wood-border">
            <h3 className="text-sm font-bold text-wood-textMain mb-3 flex items-center gap-1.5">
              <span>💳</span> 拾光收費標準速覽
            </h3>
            <div className="grid grid-cols-2 gap-3 mb-3">
              <div className="bg-[#FAF7F2] p-3 rounded-xl border border-[#E8DEC8]">
                <div className="text-xs font-bold text-wood-textMuted mb-1">平日收費 (週一至週五)</div>
                <div className="text-sm font-black text-wood-primary">
                  NT$ {globalPricing.weekday_hourly} / 小時
                </div>
                <div className="text-[11px] text-[#8C8279] mt-0.5 font-medium">
                  暢玩封頂 NT$ {globalPricing.weekday_unlimited} / 人
                </div>
              </div>
              <div className="bg-[#FAF7F2] p-3 rounded-xl border border-[#E8DEC8]">
                <div className="text-xs font-bold text-wood-textMuted mb-1">假日收費 (週末及國定假日)</div>
                <div className="text-sm font-black text-wood-primary">
                  NT$ {globalPricing.weekend_hourly} / 小時
                </div>
                <div className="text-[11px] text-[#8C8279] mt-0.5 font-medium">
                  暢玩封頂 NT$ {globalPricing.weekend_unlimited} / 人
                </div>
              </div>
            </div>
            {priceNoticeText && (
              <p className="text-[11px] text-wood-textMuted leading-relaxed">
                ℹ️ {priceNoticeText}
              </p>
            )}
          </section>
        )}

        {/* Date Selector */}
        <section className="bg-wood-card p-6 rounded-2xl shadow-warm border border-wood-border">
          <div className="flex justify-between items-center mb-6">
            <h2 className="text-lg font-bold">1. 查看預約日期</h2>
            <div className="flex items-center gap-2">
              <button 
                type="button"
                onClick={() => setCurrentMonth(subMonths(currentMonth, 1))} 
                className="p-2 text-wood-textMuted hover:text-wood-primary hover:bg-wood-bg/50 rounded-full transition-all"
              >
                &lt;
              </button>
              <span className="font-bold tracking-wide">{format(currentMonth, 'yyyy年 MM月')}</span>
              <button 
                type="button"
                onClick={() => setCurrentMonth(addMonths(currentMonth, 1))} 
                className="p-2 text-wood-textMuted hover:text-wood-primary hover:bg-wood-bg/50 rounded-full transition-all"
              >
                &gt;
              </button>
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
              const dateKey = format(date, 'yyyy-MM-dd');
              const hasOpenSessions = monthOpenDatesSet.has(dateKey);
              
              return (
                <button
                  key={i}
                  disabled={isPast}
                  onClick={() => setSelectedDate(date)}
                  className={`aspect-square rounded-2xl text-sm font-medium transition-all duration-200 flex flex-col items-center justify-center relative ${
                    !isCurrentMonth ? 'text-wood-border bg-transparent opacity-40' : 
                    isPast ? 'text-wood-border cursor-not-allowed opacity-50' :
                    isSelected ? 'bg-wood-primary text-white shadow-md transform scale-105 font-bold' :
                    'text-wood-textMain hover:bg-[#F0EBE1] hover:text-wood-primary'
                  }`}
                >
                  <span>{format(date, 'd')}</span>
                  {hasOpenSessions && !isPast && (
                    <span className={`w-1.5 h-1.5 rounded-full mt-0.5 ${isSelected ? 'bg-white' : 'bg-emerald-500'}`} />
                  )}
                </button>
              );
            })}
          </div>
        </section>

        {/* Time Selector */}
        <section className="bg-wood-card p-6 rounded-2xl shadow-warm border border-wood-border">
          <div className="flex justify-between items-center mb-6">
            <h2 className="text-lg font-bold">2. 目前開放時段狀況 (預覽)</h2>
          </div>
          
          {loading ? (
            <div className="text-center text-wood-textMuted py-8">載入時段資料中...</div>
          ) : sessions.length === 0 ? (
            <div className="text-center text-wood-textMuted py-8">此日期目前無開放時段</div>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
              {sessions.map(session => {
                const isPast = isSessionPast(session);
                const isFull = session.remaining_capacity === 0;
                
                return (
                  <div
                    key={session.id}
                    className={`h-full py-3.5 px-3 rounded-xl border flex flex-col justify-center items-center transition-all duration-200 ${
                      isPast
                        ? 'bg-gray-100/60 border-gray-200 text-gray-400 opacity-60'
                        : isFull 
                        ? 'bg-wood-bg/50 border-wood-border text-wood-border opacity-70' 
                        : 'bg-wood-card border-wood-border text-wood-textMain hover:border-wood-primary hover:text-wood-primary hover:bg-[#F9F6F0]'
                    }`}
                  >
                    <span className="font-bold mb-1 text-[15px] sm:text-base whitespace-nowrap">
                      {session.start_time} - {session.end_time}
                    </span>
                    <span className={`text-xs font-medium ${
                      isPast ? 'text-gray-400' :
                      isFull ? 'text-red-400/80 font-bold' : 
                      'text-emerald-600 font-semibold'
                    }`}>
                      {isPast ? '已逾時' : isFull ? '已額滿' : `剩餘 ${session.remaining_capacity} 人`}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      </main>

      {/* Sticky Redirect Footer */}
      <div className="fixed bottom-0 left-0 right-0 p-4 bg-wood-bg/95 backdrop-blur-md border-t border-wood-border z-50 shadow-lg">
        <div className="max-w-3xl mx-auto">
          <a
            href={lineButtonUrl}
            className="w-full flex items-center justify-center gap-2 bg-[#06C755] hover:bg-[#05b34c] text-white font-bold py-3.5 px-4 rounded-2xl transition-all duration-200 shadow-md transform hover:-translate-y-0.5"
          >
            <svg className="w-6 h-6" viewBox="0 0 24 24" fill="currentColor">
              <path d="M23.928 10.38c0-4.323-4.288-7.85-9.56-7.85-5.275 0-9.562 3.527-9.562 7.85 0 3.864 3.398 7.155 8.1 7.766.316.04.757.124.863.432.096.277.062.705.03 1.002-.032.316-.202 1.258-.246 1.48-.052.264-.246.43-.166.496.082.066.623-.332.964-.53 1.205-.705 4.502-2.82 6.136-4.505 1.57-1.63 2.44-3.415 2.44-5.14z"/>
            </svg>
            前往 LINE 登入預約
          </a>
          <p className="text-center text-xs text-wood-textMuted mt-2 font-medium">跳轉至 LINE 官方帳號登入，預約享即時選位與會員專屬優惠</p>
        </div>
      </div>

      {/* Announcement Modal */}
      {showAnnouncementModal && (
        <div className="fixed inset-0 z-[130] flex items-center justify-center p-4">
          <div 
            className="absolute inset-0 bg-black/40 backdrop-blur-[4px] animate-fade-in" 
            onClick={() => setShowAnnouncementModal(false)} 
          />
          <div className="bg-white rounded-[24px] shadow-2xl w-full max-w-sm overflow-hidden relative z-10 animate-zoom-in p-6 text-center">
            <div className="w-12 h-12 rounded-full bg-amber-50 text-[#8B5B43] flex items-center justify-center mx-auto mb-3 text-xl">
              📢
            </div>
            <h3 className="text-lg font-bold text-[#3E332B] mb-3">店家最新公告</h3>
            <p className="text-sm text-[#6D5D52] leading-relaxed mb-6 whitespace-pre-wrap text-left bg-[#FAF7F2] p-4 rounded-xl border border-[#E8DEC8]">
              {announcementText}
            </p>
            <button
              type="button"
              onClick={() => setShowAnnouncementModal(false)}
              className="w-full py-2.5 bg-[#8B5B43] hover:bg-[#724a35] text-white font-bold rounded-xl text-sm transition-colors shadow-sm"
            >
              我知道了
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default Preview;
