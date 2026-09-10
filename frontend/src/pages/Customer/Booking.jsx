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
  const [isUnlimited, setIsUnlimited] = useState(false);
  const [showUnlimitedWarningModal, setShowUnlimitedWarningModal] = useState(false);
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

  const [allowUnlimited, setAllowUnlimited] = useState(true);

  useEffect(() => {
    fetchSessions(selectedDate);
    fetchDailySetting(selectedDate);
    setSelectedSessions([]);
    setIsUnlimited(false);
  }, [selectedDate]);

  const fetchDailySetting = async (date) => {
    try {
      const formattedDate = format(date, 'yyyy-MM-dd');
      const res = await api.get(`/daily-settings?date=${formattedDate}`);
      setAllowUnlimited(res.data.allow_unlimited);
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

  const handleUnlimitedClick = () => {
    if (isUnlimited) {
      setIsUnlimited(false);
      return;
    }

    const hasFullSessions = sessions.some(s => s.remaining_capacity === 0);
    if (hasFullSessions) {
      setShowUnlimitedWarningModal(true);
    } else {
      setIsUnlimited(true);
    }
  };

  const handleBooking = async () => {
    if (selectedSessions.length === 0) return;
    
    // Sort selected sessions by start time to display nicely
    const sortedSessions = [...selectedSessions].sort((a, b) => a.start_time.localeCompare(b.start_time));
    const timeRangeStr = `${sortedSessions[0].start_time} - ${sortedSessions[sortedSessions.length - 1].end_time}`;
    
    if (window.confirm(`確定要預約 ${format(selectedDate, 'yyyy-MM-dd')} \n時段：${timeRangeStr} \n人數：${pax} 人嗎？`)) {
      try {
        await api.post('/reservations', {
          session_ids: sortedSessions.map(s => s.id),
          pax: parseInt(pax),
          isUnlimited
        });
        alert('預約成功！');
        fetchSessions(selectedDate); // Refresh capacities
        setSelectedSessions([]);
      } catch (err) {
        if (err.response?.status === 409 && err.response?.data?.error?.includes('拆散')) {
          setSplitBookingData({
            session_ids: sortedSessions.map(s => s.id),
            pax: parseInt(pax),
            isUnlimited
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
    <div className="min-h-screen bg-wood-bg text-wood-textMain pb-24 font-sans transition-colors duration-300">
      {/* Header */}
      <header className="sticky top-0 z-40 bg-wood-bg/80 backdrop-blur-md border-b border-wood-border px-4 py-4 mb-6">
        <div className="max-w-3xl mx-auto flex justify-between items-center">
          <h1 className="text-xl font-bold tracking-wide">拾光製所 拼豆時段預約系統</h1>
          <div className="flex items-center gap-4">
            <button 
              onClick={() => setShowHistoryModal(true)}
              className="text-sm text-wood-primary hover:text-wood-primaryHover font-medium transition-colors hover:underline underline-offset-4"
            >
              預約紀錄
            </button>
            <button 
              onClick={() => { api.post('/auth/logout').then(() => window.location.href = '/') }}
              className="text-sm text-wood-textMuted hover:text-wood-textMain transition-colors"
            >
              登出
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-4 space-y-6">
        {/* Date Selector */}
        <section className="bg-wood-card p-6 rounded-2xl shadow-warm">
          <div className="flex justify-between items-center mb-6">
            <h2 className="text-lg font-bold">1. 選擇日期</h2>
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
            <div className="flex items-center gap-3 flex-wrap">
              <h2 className="text-lg font-bold">2. 選擇時段 (可複選)</h2>
              {sessions.length > 0 && allowUnlimited && (
                <div className="flex flex-col sm:flex-row sm:items-center gap-2">
                  <button
                    onClick={handleUnlimitedClick}
                    className={`text-xs px-4 py-2 rounded-lg transition-all font-bold flex items-center gap-1 ${
                      isUnlimited 
                        ? 'bg-wood-primary text-white shadow-md' 
                        : 'bg-wood-sage text-wood-sageText hover:brightness-95'
                    }`}
                  >
                    {isUnlimited ? '✓ 已開啟不限時' : '開啟不限時'}
                  </button>
                  <span className="text-xs text-wood-sageText font-medium">
                    (請根據實際預計來店時間進行勾選時段)
                  </span>
                </div>
              )}
            </div>
            {selectedSessions.length > 0 && (
              <span className="text-sm bg-wood-bg text-wood-primary px-3 py-1 rounded-full font-bold">
                已選 {selectedSessions.length} 小時
              </span>
            )}
          </div>
          
          {loading ? (
            <div className="text-center text-wood-textMuted py-8">載入中...</div>
          ) : sessions.length === 0 ? (
            <div className="text-center text-wood-textMuted py-8">此日期目前無開放時段</div>
          ) : (
            <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
              {sessions.map(session => {
                const isFull = session.remaining_capacity === 0;
                const isSelected = !!selectedSessions.find(s => s.id === session.id);
                
                return (
                  <button
                    key={session.id}
                    disabled={isFull}
                    onClick={() => toggleSession(session)}
                    className={`p-4 rounded-xl border flex flex-col items-center transition-all duration-200 ${
                      isFull 
                        ? 'bg-wood-bg/50 border-wood-border text-wood-border cursor-not-allowed opacity-70' 
                        : isSelected
                          ? 'border-wood-primary bg-wood-primary text-white shadow-md transform scale-105'
                          : 'bg-wood-card border-wood-border text-wood-textMain hover:border-wood-primary hover:text-wood-primary hover:bg-[#F9F6F0]'
                    }`}
                  >
                    <span className={`font-bold mb-1 text-lg ${isSelected ? 'text-white' : ''}`}>
                      {session.start_time}
                    </span>
                    <span className={`text-xs font-medium ${isFull ? 'text-red-400/70' : isSelected ? 'text-white/90' : 'text-wood-sageText'}`}>
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
          <section className="bg-wood-card p-6 rounded-2xl shadow-warm animate-fade-in-up">
            <h2 className="text-lg font-bold mb-4">3. 確認預約人數</h2>
            <div className="flex flex-col sm:flex-row gap-4 items-end">
              <div className="w-full sm:w-1/3">
                <label className="block text-sm text-wood-textMuted mb-2">
                  預約人數 <span className="opacity-70">(最多 {maxAvailablePax} 人)</span>
                </label>
                <select 
                  value={pax}
                  onChange={(e) => setPax(parseInt(e.target.value))}
                  className="w-full px-4 py-3 border border-wood-border rounded-xl focus:ring-2 focus:ring-wood-primary/50 outline-none bg-wood-bg/50 text-wood-textMain font-medium transition-colors"
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
        <div className="fixed bottom-0 left-0 right-0 p-4 bg-wood-bg/90 backdrop-blur-md border-t border-wood-border z-50">
          <div className="max-w-3xl mx-auto flex items-center justify-between">
            <div className="text-sm">
              <div className="font-bold">
                已選擇 {selectedSessions.length} 個時段
              </div>
              <div className="text-wood-textMuted font-medium">
                人數: {pax} 人
              </div>
            </div>
            <button
              onClick={handleBooking}
              className="bg-wood-primary hover:bg-wood-primaryHover text-white px-8 py-3 rounded-xl font-bold shadow-warm transition-all duration-200 transform hover:-translate-y-1"
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

      {/* Customer History Modal */}
      {showHistoryModal && (
        <CustomerHistoryModal onClose={() => setShowHistoryModal(false)} />
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
                    setIsUnlimited(true);
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
