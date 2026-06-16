import React, { useState, useEffect } from 'react';
import { format, addDays, startOfMonth, endOfMonth, startOfWeek, endOfWeek, isSameMonth, isSameDay, addMonths, subMonths, isBefore, startOfDay } from 'date-fns';
import api from '../../api/axios';
import CustomerHistoryModal from '../../components/CustomerHistoryModal';

function Booking() {
  const [selectedDate, setSelectedDate] = useState(new Date());
  const [sessions, setSessions] = useState([]);
  const [selectedSessions, setSelectedSessions] = useState([]); // Array of selected sessions
  const [pax, setPax] = useState(1);
  const [loading, setLoading] = useState(false);
  const [showSplitModal, setShowSplitModal] = useState(false);
  const [splitBookingData, setSplitBookingData] = useState(null);
  const [showHistoryModal, setShowHistoryModal] = useState(false);
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
        if (err.response?.status === 409 && err.response?.data?.error?.includes('拆散')) {
          setSplitBookingData({
            session_ids: sortedSessions.map(s => s.id),
            pax: parseInt(pax)
          });
          setShowSplitModal(true);
        } else {
          alert(err.response?.data?.error || '預約失敗，可能人數已滿或時段已被預約');
          fetchSessions(selectedDate);
        }
      }
    }
  };

  const confirmSplitBooking = async () => {
    if (!splitBookingData) return;
    try {
      await api.post('/reservations', {
        ...splitBookingData,
        forceSplit: true
      });
      alert('預約成功！');
      fetchSessions(selectedDate);
      setSelectedSessions([]);
      setShowSplitModal(false);
      setSplitBookingData(null);
    } catch (err) {
      alert(err.response?.data?.error || '預約失敗');
      setShowSplitModal(false);
      setSplitBookingData(null);
      fetchSessions(selectedDate);
    }
  };

  return (
    <div className="min-h-screen bg-gray-50 pb-12">
      {/* Header */}
      <header className="bg-white shadow-sm px-4 py-4 mb-6">
        <div className="max-w-3xl mx-auto flex justify-between items-center">
          <h1 className="text-xl font-bold text-gray-800">藝術家的貓 拼豆時段預約系統</h1>
          <div className="flex items-center gap-4">
            <button 
              onClick={() => setShowHistoryModal(true)}
              className="text-sm text-indigo-600 hover:text-indigo-800 font-medium"
            >
              預約紀錄
            </button>
            <button 
              onClick={() => { api.post('/auth/logout').then(() => window.location.href = '/') }}
              className="text-sm text-gray-500 hover:text-gray-800"
            >
              登出
            </button>
          </div>
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
            <div className="flex items-center gap-3">
              <h2 className="text-lg font-bold text-gray-800">2. 選擇時段 (可複選)</h2>
              {sessions.length > 0 && (
                <button
                  onClick={() => {
                    const availableSessions = sessions.filter(s => s.remaining_capacity > 0);
                    if (selectedSessions.length === availableSessions.length && availableSessions.length > 0) {
                      setSelectedSessions([]);
                    } else {
                      setSelectedSessions(availableSessions);
                    }
                  }}
                  className="text-xs px-3 py-1 bg-emerald-50 text-emerald-700 border border-emerald-200 rounded hover:bg-emerald-100 transition-colors font-medium"
                >
                  {selectedSessions.length === sessions.filter(s => s.remaining_capacity > 0).length && sessions.filter(s => s.remaining_capacity > 0).length > 0
                    ? '取消全選'
                    : '不限時 (全選)'}
                </button>
              )}
            </div>
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
            </div>
          </section>
        )}
      </main>

      {/* Booking Footer Action */}
      {selectedSessions.length > 0 && (
        <div className="fixed bottom-0 left-0 right-0 p-4 bg-white border-t shadow-[0_-4px_6px_-1px_rgba(0,0,0,0.1)]">
          <div className="max-w-3xl mx-auto flex items-center justify-between">
            <div className="text-sm">
              <div className="font-bold text-gray-800">
                已選擇 {selectedSessions.length} 個時段
              </div>
              <div className="text-gray-500">
                人數: {pax} 人
              </div>
            </div>
            <button
              onClick={handleBooking}
              className="bg-indigo-600 text-white px-8 py-3 rounded-full font-bold shadow-lg hover:bg-indigo-700 hover:-translate-y-0.5 transition-all"
            >
              送出預約
            </button>
          </div>
        </div>
      )}

      {/* Split/Waitlist Confirmation Modal */}
      {showSplitModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm">
          <div className="bg-white rounded-2xl w-full max-w-md overflow-hidden shadow-2xl">
            <div className="bg-amber-100 p-6 flex flex-col items-center">
              <div className="bg-amber-200 p-3 rounded-full mb-4">
                <span className="text-3xl">⚠️</span>
              </div>
              <h3 className="text-xl font-bold text-amber-900 text-center">
                連續座位不足
              </h3>
            </div>
            <div className="p-6">
              <p className="text-gray-700 text-center mb-6">
                您選擇的時段已無法安排連續的相鄰座位，<br/>
                <span className="font-bold text-red-500">同行者將會被拆散入座。</span><br/><br/>
                請問是否仍要確認預約？
              </p>
              <div className="flex gap-3">
                <button
                  onClick={() => {
                    setShowSplitModal(false);
                    setSplitBookingData(null);
                  }}
                  className="flex-1 py-3 px-4 bg-gray-100 hover:bg-gray-200 text-gray-700 rounded-xl font-medium transition-colors"
                >
                  取消預約
                </button>
                <button
                  onClick={confirmSplitBooking}
                  className="flex-1 py-3 px-4 bg-amber-500 hover:bg-amber-600 text-white rounded-xl font-bold transition-colors shadow-lg shadow-amber-500/30"
                >
                  確認拆桌
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Customer History Modal */}
      {showHistoryModal && (
        <CustomerHistoryModal onClose={() => setShowHistoryModal(false)} />
      )}

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
