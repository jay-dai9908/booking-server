import React, { useState, useEffect } from 'react';
import { format, addDays, startOfMonth, endOfMonth, startOfWeek, endOfWeek, isSameMonth, isSameDay, addMonths, subMonths, isBefore, startOfDay } from 'date-fns';
import api from '../../api/axios';

function Preview() {
  const [selectedDate, setSelectedDate] = useState(new Date());
  const [sessions, setSessions] = useState([]);
  const [loading, setLoading] = useState(false);
  const [currentMonth, setCurrentMonth] = useState(startOfMonth(new Date()));

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
      alert('無法取得時段資料');
    } finally {
      setLoading(false);
    }
  };

  const lineOaUrl = import.meta.env.VITE_LINE_OA_URL || 'https://lin.ee/vsZhRW5';

  return (
    <div className="min-h-screen bg-wood-bg text-wood-textMain pb-24 font-sans transition-colors duration-300">
      {/* Header */}
      <header className="sticky top-0 z-40 bg-wood-bg/80 backdrop-blur-md border-b border-wood-border px-4 py-4 mb-6">
        <div className="max-w-3xl mx-auto flex justify-center items-center gap-3">
          <img src="/logo.png" alt="拾光製所 Logo" className="w-8 h-8 object-cover rounded-full" />
          <h1 className="text-xl font-bold tracking-wide">拾光製所 預約時段預覽</h1>
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-4 space-y-6">
        {/* Date Selector */}
        <section className="bg-wood-card p-6 rounded-2xl shadow-warm">
          <div className="flex justify-between items-center mb-6">
            <h2 className="text-lg font-bold">1. 查看日期</h2>
            <div className="flex items-center gap-2">
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
              
              return (
                <button
                  key={i}
                  disabled={isPast}
                  onClick={() => setSelectedDate(date)}
                  className={`aspect-square rounded-full text-sm font-medium transition-all duration-200 flex items-center justify-center ${
                    !isCurrentMonth ? 'text-wood-border bg-transparent' : 
                    isPast ? 'text-wood-border cursor-not-allowed' :
                    isSelected ? 'bg-wood-primary text-white shadow-md transform scale-105' :
                    'text-wood-textMain hover:bg-[#F0EBE1] hover:text-wood-primary'
                  }`}
                >
                  {format(date, 'd')}
                </button>
              );
            })}
          </div>
        </section>

        {/* Time Selector */}
        <section className="bg-wood-card p-6 rounded-2xl shadow-warm">
          <div className="flex justify-between items-center mb-6">
            <h2 className="text-lg font-bold">2. 目前可預約時段 (預覽)</h2>
          </div>
          
          {loading ? (
            <div className="text-center text-wood-textMuted py-8">載入中...</div>
          ) : sessions.length === 0 ? (
            <div className="text-center text-wood-textMuted py-8">此日期目前無開放時段</div>
          ) : (
            <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
              {sessions.map(session => {
                const isFull = session.remaining_capacity === 0;
                
                return (
                  <div
                    key={session.id}
                    className={`py-3 px-2 rounded-xl border flex flex-col items-center transition-all duration-200 ${
                      isFull 
                        ? 'bg-wood-bg/50 border-wood-border text-wood-border opacity-70' 
                        : 'bg-wood-card border-wood-border text-wood-textMain hover:border-wood-primary hover:text-wood-primary hover:bg-[#F9F6F0]'
                    }`}
                  >
                    <span className="font-bold mb-1 text-[15px] sm:text-base whitespace-nowrap">
                      {session.start_time}~{session.end_time}
                    </span>
                    <span className={`text-xs font-medium ${isFull ? 'text-red-400/70' : 'text-wood-sageText'}`}>
                      {isFull ? '已額滿' : `剩餘 ${session.remaining_capacity} 人`}
                    </span>
                  </div>
                )
              })}
            </div>
          )}
        </section>
      </main>

      {/* Sticky Redirect Footer */}
      <div className="fixed bottom-0 left-0 right-0 p-4 bg-wood-bg/90 backdrop-blur-md border-t border-wood-border z-50">
        <div className="max-w-3xl mx-auto">
          <a
            href={lineOaUrl}
            className="w-full flex items-center justify-center gap-2 bg-wood-primary hover:bg-wood-primaryHover text-white font-bold py-4 px-4 rounded-2xl transition-all duration-200 shadow-warm transform hover:-translate-y-1"
          >
            <svg className="w-6 h-6" viewBox="0 0 24 24" fill="currentColor">
               <path d="M23.928 10.38c0-4.323-4.288-7.85-9.56-7.85-5.275 0-9.562 3.527-9.562 7.85 0 3.864 3.398 7.155 8.1 7.766.316.04.757.124.863.432.096.277.062.705.03 1.002-.032.316-.202 1.258-.246 1.48-.052.264-.246.43-.166.496.082.066.623-.332.964-.53 1.205-.705 4.502-2.82 6.136-4.505 1.57-1.63 2.44-3.415 2.44-5.14z"/>
            </svg>
            前往 LINE 進行預約
          </a>
          <p className="text-center text-xs text-wood-textMuted mt-3 font-medium">跳轉至 LINE 官方帳號，預約更快速流暢</p>
        </div>
      </div>
    </div>
  );
}

export default Preview;
