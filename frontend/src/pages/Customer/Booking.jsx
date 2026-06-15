import React, { useState, useEffect } from 'react';
import { format, addDays, startOfMonth, endOfMonth, startOfWeek, endOfWeek, isSameMonth, isSameDay, addMonths, subMonths, isBefore, startOfDay } from 'date-fns';
import api from '../../api/axios';

function Booking() {
  const [selectedDate, setSelectedDate] = useState(new Date());
  const [sessions, setSessions] = useState([]);
  const [selectedSessions, setSelectedSessions] = useState([]); // Array of selected sessions
  const [pax, setPax] = useState(1);
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
    setSelectedSessions([]);
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

  const toggleSession = (session) => {
    if (session.remaining_capacity === 0) return;
    
    setSelectedSessions(prev => {
      const isSelected = prev.find(s => s.id === session.id);
      let newSelected;
      if (isSelected) {
        newSelected = prev.filter(s => s.id !== session.id);
      } else {
        newSelected = [...prev, session];
      }
      return newSelected;
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

  const handleBooking = async () => {
    if (selectedSessions.length === 0) return;
    
    // Sort selected sessions by start time to display nicely
    const sortedSessions = [...selectedSessions].sort((a, b) => a.start_time.localeCompare(b.start_time));
    const timeRangeStr = `${sortedSessions[0].start_time} - ${sortedSessions[sortedSessions.length - 1].end_time}`;
    
    if (window.confirm(`確定要預約 ${format(selectedDate, 'yyyy-MM-dd')} \n時段：${timeRangeStr} \n人數：${pax} 人嗎？`)) {
      try {
        await api.post('/reservations', {
          session_ids: sortedSessions.map(s => s.id),
          pax: parseInt(pax)
        });
        alert('預約成功！');
        fetchSessions(selectedDate); // Refresh capacities
        setSelectedSessions([]);
      } catch (err) {
        alert(err.response?.data?.error || '預約失敗，可能人數已滿或時段已被預約');
        fetchSessions(selectedDate);
      }
    }
  };

  return (
    <div className="min-h-screen bg-gray-50 pb-12">
      {/* Header */}
      <header className="bg-white shadow-sm px-4 py-4 mb-6">
        <div className="max-w-3xl mx-auto flex justify-between items-center">
          <h1 className="text-xl font-bold text-gray-800">藝術家的貓 拼豆時段預約系統</h1>
          <button 
            onClick={() => { api.post('/auth/logout').then(() => window.location.href = '/') }}
            className="text-sm text-gray-500 hover:text-gray-800"
          >
            登出
          </button>
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-4 space-y-6">
        {/* Date Selector */}
        <section className="bg-white p-6 rounded-2xl shadow-sm border border-gray-100">
          <div className="flex justify-between items-center mb-4">
            <h2 className="text-lg font-bold text-gray-800">1. 選擇日期</h2>
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
            <h2 className="text-lg font-bold text-gray-800">2. 選擇時段 (可複選)</h2>
            {selectedSessions.length > 0 && (
              <span className="text-sm bg-gray-100 text-gray-800 px-3 py-1 rounded-full font-medium">
                已選 {selectedSessions.length} 小時
              </span>
            )}
          </div>
          
          {loading ? (
            <div className="text-center text-gray-500 py-8">載入中...</div>
          ) : sessions.length === 0 ? (
            <div className="text-center text-gray-500 py-8">此日期目前無開放時段</div>
          ) : (
            <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
              {sessions.map(session => {
                const isFull = session.remaining_capacity === 0;
                const isSelected = !!selectedSessions.find(s => s.id === session.id);
                
                return (
                  <button
                    key={session.id}
                    disabled={isFull}
                    onClick={() => toggleSession(session)}
                    className={`p-4 rounded-xl border flex flex-col items-center transition-all ${
                      isFull 
                        ? 'bg-gray-100 border-gray-200 text-gray-400 cursor-not-allowed opacity-60' 
                        : isSelected
                          ? 'border-gray-900 bg-gray-900 text-white shadow-md transform scale-[1.02]'
                          : 'border-gray-200 hover:border-gray-300 text-gray-700 hover:bg-gray-50'
                    }`}
                  >
                    <span className={`font-bold mb-1 ${isSelected ? 'text-white' : 'text-gray-800'}`}>
                      {session.start_time}
                    </span>
                    <span className={`text-xs ${isFull ? 'text-red-500' : isSelected ? 'text-gray-300' : 'text-gray-500'}`}>
                      {isFull ? '已額滿' : `剩餘 ${session.remaining_capacity} 人`}
                    </span>
                  </button>
                )
              })}
            </div>
          )}
        </section>

        {/* Pax and Submit */}
        {selectedSessions.length > 0 && maxAvailablePax > 0 && (
          <section className="bg-white p-6 rounded-2xl shadow-sm border border-gray-200 ring-1 ring-gray-900 ring-opacity-5 animate-fade-in-up">
            <h2 className="text-lg font-bold text-gray-800 mb-4">3. 確認預約人數</h2>
            <div className="flex flex-col sm:flex-row gap-4 items-end">
              <div className="w-full sm:w-1/3">
                <label className="block text-sm text-gray-600 mb-2">
                  預約人數 <span className="text-gray-400">(最多 {maxAvailablePax} 人)</span>
                </label>
                <select 
                  value={pax}
                  onChange={(e) => setPax(parseInt(e.target.value))}
                  className="w-full px-4 py-3 border border-gray-300 rounded-xl focus:ring-2 focus:ring-gray-900 outline-none bg-white"
                >
                  {Array.from({ length: maxAvailablePax }).map((_, i) => (
                    <option key={i + 1} value={i + 1}>{i + 1} 人</option>
                  ))}
                </select>
              </div>
              <button 
                onClick={handleBooking}
                className="w-full sm:w-2/3 bg-gray-900 hover:bg-gray-800 text-white font-bold py-3 px-6 rounded-xl transition-colors shadow-lg shadow-gray-900/20"
              >
                確認送出預約
              </button>
            </div>
          </section>
        )}
      </main>

      <style dangerouslySetInnerHTML={{__html: `
        .custom-scrollbar::-webkit-scrollbar { height: 6px; }
        .custom-scrollbar::-webkit-scrollbar-track { background: transparent; }
        .custom-scrollbar::-webkit-scrollbar-thumb { background-color: #e5e7eb; border-radius: 20px; }
        .animate-fade-in-up { animation: fadeInUp 0.3s ease-out forwards; }
        @keyframes fadeInUp { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
      `}} />
    </div>
  );
}

export default Booking;
