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
    <div className="min-h-screen bg-gray-50 pb-24">
      {/* Header */}
      <header className="bg-white shadow-sm px-4 py-4 mb-6">
        <div className="max-w-3xl mx-auto flex justify-center items-center">
          <h1 className="text-xl font-bold text-gray-800">拾光製所 預約時段預覽</h1>
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-4 space-y-6">
        {/* Date Selector */}
        <section className="bg-white p-6 rounded-2xl shadow-sm border border-gray-100">
          <div className="flex justify-between items-center mb-4">
            <h2 className="text-lg font-bold text-gray-800">查看日期</h2>
            <div className="flex items-center gap-2">
              <button onClick={() => setCurrentMonth(subMonths(currentMonth, 1))} className="p-2 text-gray-500 hover:bg-gray-100 rounded-lg transition-colors">&lt;</button>
              <span className="font-bold text-gray-800 tracking-wide">{format(currentMonth, 'yyyy年 MM月')}</span>
              <button onClick={() => setCurrentMonth(addMonths(currentMonth, 1))} className="p-2 text-gray-500 hover:bg-gray-100 rounded-lg transition-colors">&gt;</button>
            </div>
          </div>

          <div className="grid grid-cols-7 gap-1 text-center mb-2">
            {['日', '一', '二', '三', '四', '五', '六'].map(dayName => (
              <div key={dayName} className="text-xs font-bold text-gray-400 py-2">{dayName}</div>
            ))}
          </div>
          
          <div className="grid grid-cols-7 gap-1">
            {calendarDays.map((date, i) => {
              const isSelected = isSameDay(date, selectedDate);
              const isCurrentMonth = isSameMonth(date, currentMonth);
              const isPast = isBefore(startOfDay(date), startOfDay(new Date()));
              
              return (
                <button
                  key={i}
                  disabled={isPast}
                  onClick={() => setSelectedDate(date)}
                  className={`py-3 rounded-xl text-sm font-medium transition-all flex items-center justify-center ${
                    !isCurrentMonth ? 'text-gray-300 opacity-50 bg-transparent' : 
                    isPast ? 'text-gray-300 bg-gray-50 cursor-not-allowed opacity-60' :
                    isSelected ? 'bg-gray-900 text-white shadow-md transform scale-[1.05]' :
                    'text-gray-700 hover:bg-gray-50 hover:border-gray-200 border border-transparent'
                  }`}
                >
                  {format(date, 'd')}
                </button>
              );
            })}
          </div>
        </section>

        {/* Time Selector */}
        <section className="bg-white p-6 rounded-2xl shadow-sm border border-gray-100">
          <div className="flex justify-between items-center mb-4">
            <h2 className="text-lg font-bold text-gray-800">目前可預約時段 (預覽)</h2>
          </div>
          
          {loading ? (
            <div className="text-center text-gray-500 py-8">載入中...</div>
          ) : sessions.length === 0 ? (
            <div className="text-center text-gray-500 py-8">此日期目前無開放時段</div>
          ) : (
            <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
              {sessions.map(session => {
                const isFull = session.remaining_capacity === 0;
                
                return (
                  <div
                    key={session.id}
                    className={`p-4 rounded-xl border flex flex-col items-center transition-all ${
                      isFull 
                        ? 'bg-gray-100 border-gray-200 text-gray-400 opacity-60' 
                        : 'bg-white border-emerald-200 text-gray-700'
                    }`}
                  >
                    <span className="font-bold mb-1 text-gray-800">
                      {session.start_time}
                    </span>
                    <span className={`text-xs ${isFull ? 'text-red-500 font-bold' : 'text-emerald-600 font-bold'}`}>
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
      <div className="fixed bottom-0 left-0 right-0 p-4 bg-white border-t shadow-[0_-4px_15px_-3px_rgba(0,0,0,0.1)] z-50">
        <div className="max-w-3xl mx-auto">
          <a
            href={lineOaUrl}
            className="w-full flex items-center justify-center gap-2 bg-[#06C755] hover:bg-[#05b34c] text-white font-bold py-4 px-4 rounded-2xl transition-all shadow-lg transform hover:-translate-y-0.5"
          >
            <svg className="w-6 h-6" viewBox="0 0 24 24" fill="currentColor">
               <path d="M23.928 10.38c0-4.323-4.288-7.85-9.56-7.85-5.275 0-9.562 3.527-9.562 7.85 0 3.864 3.398 7.155 8.1 7.766.316.04.757.124.863.432.096.277.062.705.03 1.002-.032.316-.202 1.258-.246 1.48-.052.264-.246.43-.166.496.082.066.623-.332.964-.53 1.205-.705 4.502-2.82 6.136-4.505 1.57-1.63 2.44-3.415 2.44-5.14z"/>
            </svg>
            前往 LINE 進行預約
          </a>
          <p className="text-center text-xs text-gray-400 mt-3 font-medium">跳轉至 LINE 官方帳號，預約更快速流暢</p>
        </div>
      </div>
    </div>
  );
}

export default Preview;
