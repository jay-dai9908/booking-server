import React, { useState, useEffect } from 'react';
import { format, addDays, startOfMonth, endOfMonth, startOfWeek, endOfWeek, isSameMonth, isSameDay, addMonths, subMonths, isBefore, startOfDay } from 'date-fns';
import api from '../../api/axios';
import { useNavigate } from 'react-router-dom';

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

  // Smart Pegboard (Equipment) state
  const [equipmentConfigs, setEquipmentConfigs] = useState([]);
  const [equipmentSelections, setEquipmentSelections] = useState({}); // { [id]: qty }
  const [rentalHours, setRentalHours] = useState(2);
  const [enableSmartBoard, setEnableSmartBoard] = useState(false);
  const [allowExceedPax, setAllowExceedPax] = useState(false);

  // Calculate contiguous sessions
  const sortedSelectedSessions = [...selectedSessions].sort((a, b) => a.start_time.localeCompare(b.start_time));
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
    fetchSessions(selectedDate);
    fetchDailySetting(selectedDate);
    setSelectedSessions([]);
    setIsUnlimited(false);
    setEquipmentSelections({});
    setEnableSmartBoard(false);
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
        setEquipmentConfigs(res.data.equipments || []);
        setAllowExceedPax(!!res.data.allow_exceed_pax);
      } catch (err) {
        console.error('Failed to fetch equipment availability:', err);
      }
    };
    fetchEquipmentAvailability();
  }, [selectedDate, selectedSessions]);

  // Adjust rentalHours when maxContiguous changes
  useEffect(() => {
    if (maxContiguous >= 2) {
      setRentalHours(prev => Math.min(Math.max(2, prev), maxContiguous));
    } else {
      setRentalHours(2);
      if (enableSmartBoard) {
        setEnableSmartBoard(false);
        setEquipmentSelections({});
      }
    }
  }, [maxContiguous]);

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
      setAlertModalData({ type: 'error', title: '錯誤', message: '無法取得時段資料' });
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

  const applyUnlimitedMacro = (startSession, currentSelected) => {
    if (!startSession) return currentSelected;
    
    const startIndex = sessions.findIndex(s => s.id === startSession.id);
    if (startIndex === -1) return currentSelected;

    let newSelected = [...currentSelected];
    if (!newSelected.find(s => s.id === startSession.id)) {
      newSelected.push(startSession);
    }

    let count = 1;
    let currentIndex = startIndex + 1;
    
    while (count < 6 && currentIndex < sessions.length) {
      const nextSession = sessions[currentIndex];
      if (nextSession.remaining_capacity > 0 && !isSessionPast(nextSession)) {
        if (!newSelected.find(s => s.id === nextSession.id)) {
          newSelected.push(nextSession);
        }
        count++;
        currentIndex++;
      } else {
        // Stop if we hit a full or past session to maintain contiguity
        break;
      }
    }
    return newSelected;
  };

  const enableUnlimitedMode = () => {
    setIsUnlimited(true);
    setSelectedSessions(prev => {
      if (prev.length > 0) {
        const sortedSelected = [...prev].sort((a, b) => a.start_time.localeCompare(b.start_time));
        return applyUnlimitedMacro(sortedSelected[0], []);
      }
      return prev;
    });
  };

  const toggleSession = (session) => {
    if (session.remaining_capacity === 0 || isSessionPast(session)) return;
    
    setSelectedSessions(prev => {
      const isSelected = prev.find(s => s.id === session.id);
      
      if (isSelected) {
        return prev.filter(s => s.id !== session.id);
      } else {
        if (isUnlimited && prev.length === 0) {
          return applyUnlimitedMacro(session, []);
        }
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

  let totalEquipmentFee = 0;
  const breakdownParts = [];
  visibleConfigs.forEach(c => {
    const qty = equipmentSelections[c.id] || 0;
    if (qty > 0) {
      const singlePrice = Math.min(c.hourly_rate * rentalHours, c.daily_cap);
      totalEquipmentFee += singlePrice * qty;
      breakdownParts.push(`${c.name}×${qty}`);
    }
  });

  const handleBooking = () => {
    if (selectedSessions.length === 0) return;
    
    // Sort selected sessions by start time to display nicely
    const sortedSessions = [...selectedSessions].sort((a, b) => a.start_time.localeCompare(b.start_time));
    const timeRangeStr = `${sortedSessions[0].start_time} - ${sortedSessions[sortedSessions.length - 1].end_time}`;
    
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

    setConfirmModalData({
      date: format(selectedDate, 'yyyy-MM-dd'),
      timeRange: timeRangeStr,
      pax: pax,
      sortedSessions,
      isUnlimited,
      equipments: activeEquipments,
      totalEquipmentFee,
      equipmentBreakdown: breakdownParts.length > 0 
        ? `${breakdownParts.join(' + ')}，共 ${totalBoards} 台 × ${rentalHours} 小時`
        : null
    });
  };

  const executeBooking = async () => {
    const data = confirmModalData;
    setConfirmModalData(null);
    try {
      await api.post('/reservations', {
        session_ids: data.sortedSessions.map(s => s.id),
        pax: parseInt(data.pax),
        isUnlimited: data.isUnlimited,
        equipments: data.equipments
      });
      setAlertModalData({ type: 'success', title: '預約成功！', message: '期待在拾光製所為您服務。' });
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
      await api.post('/reservations', {
        ...splitBookingData,
        forceSplit: true
      });
      setAlertModalData({ type: 'success', title: '預約成功！', message: '期待在拾光製所為您服務。' });
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
      {/* Header */}
      <header className="sticky top-0 z-40 bg-wood-bg/80 backdrop-blur-md border-b border-wood-border px-4 py-4 mb-6">
        <div className="max-w-3xl mx-auto flex justify-between items-center">
          <div className="flex items-center gap-3">
            <img src="/logo.png" alt="拾光製所 Logo" className="w-8 h-8 object-cover rounded-full" />
            <h1 className="text-xl font-bold tracking-wide">拾光製所 拼豆時段預約系統</h1>
          </div>
          <div className="flex items-center gap-2 sm:gap-3 shrink-0">
            <button 
              onClick={() => navigate('/history')}
              className="whitespace-nowrap text-sm font-semibold text-[#4A3F35] bg-[#EDE6DD] hover:bg-[#DECFC1] px-4 py-1.5 rounded-full transition-all duration-200 ease-in-out"
            >
              預約紀錄
            </button>
            <button 
              onClick={() => { api.post('/auth/logout').then(() => window.location.href = '/') }}
              className="whitespace-nowrap text-sm font-medium text-[#8C8279] bg-transparent hover:bg-[#F4EFE6] hover:text-[#4A3F35] px-3 py-1.5 rounded-full transition-all duration-200 ease-in-out"
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
                <div key={i} className="flex justify-center items-center aspect-square">
                  <button
                    disabled={isPast}
                    onClick={() => setSelectedDate(date)}
                    className={`w-8 h-8 sm:w-10 sm:h-10 rounded-full text-sm font-medium transition-all duration-200 flex items-center justify-center ${
                      !isCurrentMonth ? 'text-wood-border bg-transparent' : 
                      isPast ? 'text-wood-border cursor-not-allowed' :
                      isSelected ? 'bg-wood-primary text-white shadow-md transform scale-105' :
                      'text-wood-textMain hover:bg-[#F0EBE1] hover:text-wood-primary'
                    }`}
                  >
                    {format(date, 'd')}
                  </button>
                </div>
              );
            })}
          </div>
        </section>

        {/* Time Selector */}
        <section className="bg-wood-card p-6 rounded-2xl shadow-warm">
          <div className="flex flex-col gap-4 mb-6">
            <div className="flex justify-between items-center">
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
                  className="flex flex-row items-center justify-between sm:justify-start sm:gap-6 bg-[#F9F7F3] rounded-2xl px-4 py-3 cursor-pointer select-none transition-all duration-300 hover:bg-[#F3EFE9]"
                >
                  <div className="flex items-center gap-2">
                    <span className="text-[18px] leading-none text-[#4A3F35]">✨</span>
                    <span className="text-[15px] font-bold text-[#4A3F35]">
                      開啟不限時
                    </span>
                  </div>
                  
                  {/* Toggle Switch */}
                  <div className={`relative w-[44px] h-[24px] rounded-full transition-colors duration-300 shrink-0 ${isUnlimited ? 'bg-[#8B5B43]' : 'bg-[#D5CFC9]'}`}>
                    <div className={`absolute top-[2px] left-[2px] bg-white w-[20px] h-[20px] rounded-full shadow-sm transition-transform duration-300 ${isUnlimited ? 'translate-x-[20px]' : 'translate-x-0'}`}></div>
                  </div>
                </div>
                <span className="text-xs text-wood-textMuted font-medium px-2">
                  * 請根據實際預計來店時間進行勾選
                </span>
              </div>
            )}
          </div>
          
          {loading ? (
            <div className="text-center text-wood-textMuted py-8">載入中...</div>
          ) : sessions.length === 0 ? (
            <div className="text-center text-wood-textMuted py-8">此日期目前無開放時段</div>
          ) : (
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
                    <span className={`font-bold mb-1 text-[15px] sm:text-base whitespace-nowrap ${isSelected ? 'text-white' : ''}`}>
                      {session.start_time}~{session.end_time}
                    </span>
                    <span className={`text-xs font-medium ${isPast ? 'text-[#A8A19A]' : isFull ? 'text-red-400/70' : isSelected ? 'text-white/90' : 'text-wood-sageText'}`}>
                      {isPast ? '已逾時' : isFull ? '已額滿' : `剩餘 ${session.remaining_capacity} 人`}
                    </span>
                  </button>
                )
              })}
            </div>
          )}
        </section>

        {/* Pax and Equipment */}
        {selectedSessions.length > 0 && maxAvailablePax > 0 && (
          <section className="bg-wood-card p-6 rounded-2xl shadow-warm animate-fade-in-up space-y-6">
            <div>
              <h2 className="text-lg font-bold mb-4">3. 確認預約人數與智能拼豆板加購</h2>
              <div className="flex flex-col sm:flex-row gap-4 items-end">
                <div className="w-full sm:w-1/3">
                  <label className="block text-sm text-wood-textMuted mb-3">
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
                </div>
              </div>
            </div>

            {/* Smart Pegboard Section (Only rendered if there are visible configs) */}
            {visibleConfigs.length > 0 && (
              <div className="pt-4 border-t border-[#E8DEC8]/80 space-y-4">
                {/* Free baseline benefit banner */}
                <div className="bg-[#FAF7F2] border border-[#E8DEC8] rounded-xl p-3.5 flex items-start gap-2.5 text-xs text-[#6B5A4E] leading-relaxed">
                  <span className="text-base shrink-0">💡</span>
                  <div>每位入場皆免費提供「一般傳統拼豆板」與 221 色豆子；同行者中僅需使用「智能引導拼豆板」的人員依實際需要台數加購即可（不必全員加購）。</div>
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
                        setEnableSmartBoard(!enableSmartBoard);
                        if (enableSmartBoard) {
                          setEquipmentSelections({});
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
                          <div className="text-[11px] sm:text-xs text-[#7A7067] bg-white/70 border border-[#E8DEC8] px-3 py-2 rounded-xl flex items-center flex-wrap gap-2">
                            <span className="font-bold text-[#8B5B43]">✨ 即時庫存狀況：</span>
                            {visibleConfigs.filter(c => c.id !== 'bring_own').map(c => (
                              <span key={c.id} className="bg-[#FAF7F2] px-2 py-0.5 rounded border border-[#E5DFD7]">
                                {c.name} : <strong className={c.available_qty === 0 ? 'text-red-500' : 'text-[#3E332B]'}>{c.available_qty}</strong> / {c.total_stock} 個可用
                              </span>
                            ))}
                          </div>
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
                                    <span className="font-bold text-[15px] text-[#3E332B]">📚 {c.name}</span>
                                    <span className="text-xs bg-[#F4EFE6] text-[#8B5B43] font-bold px-2 py-0.5 rounded">
                                      NT$ {c.hourly_rate} /時
                                    </span>
                                    <span className="text-xs text-[#8C8279]">
                                      (單台日上限 NT${c.daily_cap})
                                    </span>
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
                                  <span className="text-xs text-[#8C8279]">
                                    (上限 NT${bringOwnConfig.daily_cap})
                                  </span>
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
                              <div className="flex items-center gap-2">
                                <span className="font-bold text-sm text-[#3E332B]">🕒 使用時數 (至少 2 小時)</span>
                                <span className="text-[11px] font-bold text-[#8B5B43] bg-[#F4EFE6] px-2 py-0.5 rounded">
                                  最少 2 小時
                                </span>
                              </div>
                              <span className="text-xs text-[#8C8279]">
                                上限為本次預約最長連續時數 ({maxContiguous} 小時)
                              </span>
                            </div>

                            <div className="flex items-center bg-[#F9F7F3] border border-[#D5CFC9] rounded-lg p-1 self-end sm:self-auto">
                              <button
                                type="button"
                                disabled={rentalHours <= 2}
                                onClick={() => setRentalHours(h => Math.max(2, h - 1))}
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
                                onClick={() => setRentalHours(h => Math.min(maxContiguous, h + 1))}
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
                              <span className="font-bold text-sm text-[#4A3F35] block mb-0.5">
                                拼豆板加購金額小計： + NT$ {totalEquipmentFee}
                              </span>
                              <span>
                                {breakdownParts.join(' + ')}，共 {totalBoards} 台 × {rentalHours} 小時
                                {totalBoards < pax ? `；另 ${pax - totalBoards} 位使用免費一般板` : ''}
                              </span>
                            </div>
                            <span className="text-xs font-bold text-[#8B5B43] bg-white border border-[#E8DEC8] px-3 py-1 rounded-full shrink-0 self-end sm:self-auto">
                              獨立單日封頂已套用
                            </span>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
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
              <div className="text-wood-textMuted font-medium flex items-center gap-2">
                <span>人數: {pax} 人</span>
                {totalBoards > 0 && enableSmartBoard && (
                  <span className="text-wood-primary font-bold">
                    | 智能板: {totalBoards} 台 (+NT${totalEquipmentFee})
                  </span>
                )}
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
