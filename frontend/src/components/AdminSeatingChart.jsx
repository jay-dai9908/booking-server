import React, { useState, useEffect, useRef } from 'react';
import { format } from 'date-fns';
import { RefreshCw, Search } from 'lucide-react';
import api from '../api/axios';
import DailyReservationsList from './DailyReservationsList';

const SEATS = {
  A: ['A1-1', 'A1-2', 'A1-3', 'A1-4', 'A2-1', 'A2-2', 'A2-3', 'A2-4'],
  B: ['B1-1', 'B1-2', 'B1-3', 'B1-4', 'B2-1', 'B2-2', 'B2-3', 'B2-4']
};

export default function AdminSeatingChart({ onOpenDetails, onCheckIn }) {
  const [selectedDate, setSelectedDate] = useState(format(new Date(), 'yyyy-MM-dd'));
  const [sessions, setSessions] = useState([]);
  const [selectedSessionId, setSelectedSessionId] = useState(null);
  const [seatingData, setSeatingData] = useState([]); // array of reservations for the session
  const [isLoading, setIsLoading] = useState(false);
  
  // Swap logic state
  const [selectedSeat, setSelectedSeat] = useState(null); // { seat: 'A1-1', reservation: {...} }
  const [hoveredReservationId, setHoveredReservationId] = useState(null);
  const [showSwapModal, setShowSwapModal] = useState(false);
  const [targetSwapSeat, setTargetSwapSeat] = useState(null); // string e.g., 'B1-1'
  
  const pollingRef = useRef(null);

  useEffect(() => {
    fetchSessions();
  }, [selectedDate]);

  useEffect(() => {
    if (selectedSessionId) {
      fetchSeatingData();
    } else {
      setSeatingData([]);
    }
  }, [selectedSessionId]);

  // Polling logic
  useEffect(() => {
    // Only poll if a session is selected and no seat is currently selected (user is actively interacting)
    if (selectedSessionId && !selectedSeat) {
      pollingRef.current = setInterval(() => {
        fetchSeatingData(false); // background fetch, don't show loading spinner
      }, 5 * 60 * 1000); // 5 minutes
    }

    return () => {
      if (pollingRef.current) clearInterval(pollingRef.current);
    };
  }, [selectedSessionId, selectedSeat]);

  const fetchSessions = async () => {
    try {
      const res = await api.get(`/sessions?date=${selectedDate}`);
      setSessions(res.data);
      if (res.data.length > 0) {
        setSelectedSessionId(res.data[0].id);
      } else {
        setSelectedSessionId(null);
      }
    } catch (err) {
      console.error(err);
    }
  };

  const fetchSeatingData = async (showLoading = true) => {
    if (showLoading) setIsLoading(true);
    try {
      const res = await api.get(`/reservations/admin/sessions/${selectedSessionId}/seats`);
      setSeatingData(res.data.reservations);
    } catch (err) {
      console.error(err);
    } finally {
      if (showLoading) setIsLoading(false);
    }
  };

  // Helper to find who occupies a seat
  const getOccupant = (seatId) => {
    for (const r of seatingData) {
      if (r.assigned_seats && r.assigned_seats.includes(seatId)) {
        return r;
      }
    }
    return null;
  };

  const getWaitSeats = () => {
    const seats = new Set(['WAIT-1', 'WAIT-2', 'WAIT-3', 'WAIT-4', 'WAIT-5', 'WAIT-6', 'WAIT-7', 'WAIT-8']);
    seatingData.forEach(r => {
      r.assigned_seats?.forEach(s => {
        if (s.startsWith('WAIT-')) {
          seats.add(s);
        }
      });
    });
    return Array.from(seats).sort((a, b) => {
      const numA = parseInt(a.split('-')[1]) || 0;
      const numB = parseInt(b.split('-')[1]) || 0;
      return numA - numB;
    });
  };

  const handleSeatClick = (seatId) => {
    const occupant = getOccupant(seatId);
    if (occupant && onOpenDetails) {
      onOpenDetails(occupant.booking_ref);
    }
  };

  const handleDragStart = (e, seatId, occupant) => {
    if (occupant) {
      setSelectedSeat({ seat: seatId, reservation: occupant });
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', seatId);
    }
  };

  const handleDragOver = (e, seatId) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  };

  const handleDrop = (e, seatId) => {
    e.preventDefault();
    if (selectedSeat && selectedSeat.seat !== seatId) {
      setTargetSwapSeat(seatId);
      setShowSwapModal(true);
    }
  };

  const confirmSwap = async () => {
    if (!selectedSeat || !targetSwapSeat) return;

    try {
      const targetOccupant = getOccupant(targetSwapSeat);
      let res;

      if (targetOccupant) {
        if (targetOccupant.booking_ref === selectedSeat.reservation.booking_ref) {
          // Swap within the SAME group
          let newSeats = [...selectedSeat.reservation.assigned_seats];
          const idx1 = newSeats.indexOf(selectedSeat.seat);
          const idx2 = newSeats.indexOf(targetSwapSeat);
          if (idx1 !== -1 && idx2 !== -1) {
            const temp = newSeats[idx1];
            newSeats[idx1] = newSeats[idx2];
            newSeats[idx2] = temp;
          }
          res = await api.put('/reservations/admin/move-seat', {
            id: selectedSeat.reservation.id,
            assigned_seats: newSeats
          });
        } else {
          // Swap with another occupied seat (DIFFERENT group)
          const sourceNewSeats = selectedSeat.reservation.assigned_seats.map(s => 
            s === selectedSeat.seat ? targetSwapSeat : s
          );
          const targetNewSeats = targetOccupant.assigned_seats.map(s => 
            s === targetSwapSeat ? selectedSeat.seat : s
          );

          res = await api.put('/reservations/admin/swap-seats', {
            source_booking_ref: selectedSeat.reservation.booking_ref,
            source_assigned_seats: sourceNewSeats,
            target_booking_ref: targetOccupant.booking_ref,
            target_assigned_seats: targetNewSeats
          });
        }
      } else {
        // Move to empty seat
        const newSeats = selectedSeat.reservation.assigned_seats.map(s => 
          s === selectedSeat.seat ? targetSwapSeat : s
        );

        res = await api.put('/reservations/admin/move-seat', {
          id: selectedSeat.reservation.id,
          assigned_seats: newSeats
        });
      }

      if (res && res.data && res.data.displacedCount > 0) {
        alert(`換位成功！系統已自動為 ${res.data.displacedCount} 組產生跨時段衝突的客人重新安排座位。`);
      }

      setSelectedSeat(null);
      setTargetSwapSeat(null);
      setShowSwapModal(false);
      fetchSeatingData();
    } catch (err) {
      alert(err.response?.data?.error || '換位失敗');
      setShowSwapModal(false);
    }
  };

  const renderSeat = (seatId) => {
    const occupant = getOccupant(seatId);
    const isOccupied = !!occupant;
    const isCheckedIn = isOccupied && occupant.attendance === 'checked_in';
    const isSelected = selectedSeat?.seat === seatId;
    const isHoveredGroup = hoveredReservationId && occupant?.id === hoveredReservationId;
    
    const currentSession = sessions.find(s => s.id === selectedSessionId);
    const isLastHour = isOccupied && currentSession && occupant.booking_end_time === currentSession.end_time;
    
    let baseClass = "h-16 flex items-center justify-center rounded-xl cursor-pointer transition-all duration-200 border-2 ";
    
    if (isOccupied) {
      if (isCheckedIn) {
        baseClass += "bg-emerald-50 border-emerald-300 text-emerald-800 shadow-sm ";
      } else {
        baseClass += "bg-indigo-50 border-indigo-200 text-indigo-700 shadow-sm ";
      }

      if (isSelected) {
        baseClass += "ring-4 ring-indigo-500 border-indigo-500 shadow-md transform -translate-y-1 ";
      } else if (isHoveredGroup) {
        baseClass += "ring-4 ring-yellow-400 border-yellow-400 ";
      } else {
        baseClass += isCheckedIn ? "hover:bg-emerald-100 " : "hover:bg-indigo-100 ";
      }
    } else {
      baseClass += "bg-gray-50 border-dashed border-gray-300 text-gray-400 ";
      if (selectedSeat) {
        baseClass += "hover:bg-green-50 hover:border-green-400 hover:text-green-600 ";
      } else {
        baseClass += "hover:bg-gray-100 ";
      }
    }

    return (
      <div 
        key={seatId} 
        className={baseClass}
        onClick={() => handleSeatClick(seatId)}
        onMouseEnter={() => isOccupied && setHoveredReservationId(occupant.id)}
        onMouseLeave={() => setHoveredReservationId(null)}
        draggable={isOccupied}
        onDragStart={(e) => handleDragStart(e, seatId, occupant)}
        onDragOver={(e) => handleDragOver(e, seatId)}
        onDrop={(e) => handleDrop(e, seatId)}
      >
        <div className="text-center">
          <div className="text-xs font-semibold mb-1 opacity-50 pointer-events-none">{seatId}</div>
          {isOccupied ? (
            <div className="flex flex-col items-center pointer-events-none">
              <div className="text-sm font-bold truncate px-1 max-w-[80px]">
                {occupant.user?.name}
              </div>
              {occupant.booking_end_time && (
                <div className={`text-[10px] -mt-0.5 font-bold ${isLastHour ? 'text-red-500' : 'opacity-80'}`}>
                  ~{occupant.booking_end_time}
                </div>
              )}
            </div>
          ) : (
            <div className="text-sm font-medium pointer-events-none">空位</div>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="p-6">
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center mb-8 gap-4">
        <div>
          <h2 className="text-2xl font-bold text-gray-800">帶位圖管理</h2>
          <p className="text-gray-500 mt-1">視覺化管理座位配置，點擊已佔用座位可進行換位。</p>
        </div>
        <div className="flex items-center gap-3 bg-white p-2 rounded-xl shadow-sm border">
          <input
            type="date"
            value={selectedDate}
            onChange={(e) => setSelectedDate(e.target.value)}
            className="border-none focus:ring-0 text-sm font-medium text-gray-700"
          />
          <div className="h-6 w-px bg-gray-200"></div>
          <select 
            value={selectedSessionId || ''}
            onChange={(e) => setSelectedSessionId(Number(e.target.value))}
            className="border-none focus:ring-0 text-sm font-medium text-gray-700 bg-transparent pr-8"
          >
            {sessions.map(s => (
              <option key={s.id} value={s.id}>{s.start_time} - {s.end_time}</option>
            ))}
            {sessions.length === 0 && <option value="">無開放時段</option>}
          </select>
          <button 
            onClick={() => fetchSeatingData()}
            className="p-2 hover:bg-gray-100 rounded-lg transition-colors text-gray-500 hover:text-indigo-600"
            title="立即更新"
          >
            <RefreshCw className={`w-4 h-4 ${isLoading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {/* Main Seating Area */}
      {selectedSessionId ? (
        <div className="space-y-8">
          <div className="bg-white p-8 rounded-2xl shadow-sm border">
          <div className="max-w-4xl mx-auto flex flex-col gap-12">
            
            {/* Action Bar (shows when a seat is selected) */}
            {selectedSeat && (
              <div className="bg-indigo-50 border border-indigo-200 text-indigo-700 px-6 py-4 rounded-xl flex flex-col sm:flex-row items-center justify-between gap-4 animate-fade-in">
                <div className="flex items-center gap-3">
                  <span className="bg-indigo-600 text-white w-6 h-6 rounded-full flex items-center justify-center font-bold text-sm">1</span>
                  <span className="font-medium">已選取 <b>{selectedSeat.reservation.user?.name}</b> 的座位 <b>{selectedSeat.seat}</b></span>
                </div>
                
                <div className="flex items-center gap-3">
                  {onCheckIn && (
                    selectedSeat.reservation.attendance === 'checked_in' ? (
                      <button 
                        disabled
                        className="bg-green-100 text-green-700 border border-green-200 px-3 py-1.5 rounded-lg text-sm font-medium shadow-sm flex items-center gap-1.5"
                      >
                        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                        </svg>
                        已報到
                      </button>
                    ) : (
                      <button 
                        onClick={() => {
                          onCheckIn(selectedSeat.reservation.booking_ref);
                          setSelectedSeat(prev => ({
                            ...prev,
                            reservation: { ...prev.reservation, attendance: 'checked_in' }
                          }));
                          setTimeout(() => fetchSeatingData(false), 500);
                        }}
                        className="bg-blue-600 text-white px-3 py-1.5 rounded-lg text-sm font-medium hover:bg-blue-700 transition-colors shadow-sm"
                      >
                        完成報到
                      </button>
                    )
                  )}
                  {onOpenDetails && (
                    <button 
                      onClick={() => onOpenDetails(selectedSeat.reservation.booking_ref)}
                      className="bg-white text-indigo-700 border border-indigo-200 px-3 py-1.5 rounded-lg text-sm font-medium hover:bg-indigo-50 transition-colors shadow-sm"
                    >
                      訂單詳情
                    </button>
                  )}
                  
                  <div className="h-6 w-px bg-indigo-200 mx-1"></div>
                  
                  <span className="bg-indigo-200 text-indigo-800 w-6 h-6 rounded-full flex items-center justify-center font-bold text-sm">2</span>
                  <span className="font-medium animate-pulse">請點選空位換桌...</span>
                  <button 
                    onClick={() => setSelectedSeat(null)}
                    className="ml-2 text-sm underline hover:text-indigo-800"
                  >
                    取消
                  </button>
                </div>
              </div>
            )}

            {/* A-Type Tables (Long horizontal tables) */}
            <div>
              <div className="text-lg font-bold text-gray-700 mb-4 flex items-center gap-2">
                <div className="w-2 h-6 bg-blue-500 rounded-full"></div>
                A 區長桌 (適合散客併桌)
              </div>
              <div className="flex flex-col gap-6">
                {/* Table A1 */}
                <div className="relative">
                  <div className="absolute inset-0 bg-amber-100 rounded-xl transform translate-y-8 -z-10 h-16 shadow-inner"></div>
                  <div className="grid grid-cols-4 gap-4 px-4">
                    {['A1-1', 'A1-2', 'A1-3', 'A1-4'].map(renderSeat)}
                  </div>
                  <div className="text-center text-amber-800/50 font-bold mt-4 text-sm uppercase tracking-widest">Table A1</div>
                </div>
                {/* Table A2 */}
                <div className="relative">
                  <div className="absolute inset-0 bg-amber-100 rounded-xl transform translate-y-8 -z-10 h-16 shadow-inner"></div>
                  <div className="grid grid-cols-4 gap-4 px-4">
                    {['A2-1', 'A2-2', 'A2-3', 'A2-4'].map(renderSeat)}
                  </div>
                  <div className="text-center text-amber-800/50 font-bold mt-4 text-sm uppercase tracking-widest">Table A2</div>
                </div>
              </div>
            </div>

            {/* B-Type Tables (Square tables, facing each other) */}
            <div>
              <div className="text-lg font-bold text-gray-700 mb-4 flex items-center gap-2">
                <div className="w-2 h-6 bg-emerald-500 rounded-full"></div>
                B 區對面桌 (適合 4 人包桌或 2 組雙人)
              </div>
              <div className="flex gap-8 justify-center">
                {/* Table B1 */}
                <div className="relative p-6 bg-emerald-50 rounded-2xl border border-emerald-100">
                  <div className="absolute inset-x-12 inset-y-16 bg-amber-100 rounded-lg -z-10 shadow-inner flex items-center justify-center">
                     <span className="text-amber-800/30 font-bold text-sm tracking-widest -rotate-90 md:rotate-0">B1</span>
                  </div>
                  <div className="grid grid-cols-2 gap-x-16 gap-y-6">
                    {['B1-1', 'B1-3'].map(renderSeat)}
                    {['B1-2', 'B1-4'].map(renderSeat)}
                  </div>
                </div>
                {/* Table B2 */}
                <div className="relative p-6 bg-emerald-50 rounded-2xl border border-emerald-100">
                  <div className="absolute inset-x-12 inset-y-16 bg-amber-100 rounded-lg -z-10 shadow-inner flex items-center justify-center">
                     <span className="text-amber-800/30 font-bold text-sm tracking-widest -rotate-90 md:rotate-0">B2</span>
                  </div>
                  <div className="grid grid-cols-2 gap-x-16 gap-y-6">
                    {['B2-1', 'B2-3'].map(renderSeat)}
                    {['B2-2', 'B2-4'].map(renderSeat)}
                  </div>
                </div>
              </div>
            </div>

            {/* Virtual Waiting Area (Overbooked / Extra) */}
            <div className="mt-4 pt-8 border-t-2 border-dashed border-gray-200">
              <div className="text-lg font-bold text-gray-600 mb-4 flex items-center gap-2">
                <div className="w-2 h-6 bg-gray-400 rounded-full"></div>
                ➕ 虛擬等候 / 外加區 (可手動拖曳至此暫放)
              </div>
              <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-4 bg-gray-50 p-6 rounded-2xl border border-gray-100">
                {getWaitSeats().map(renderSeat)}
              </div>
            </div>

          </div>
        </div>
        
        {/* Daily Reservations List Section */}
        <DailyReservationsList date={selectedDate} onOpenDetails={onOpenDetails} />
        
        </div>
      ) : (
        <div className="bg-white p-16 rounded-2xl shadow-sm border border-gray-200 flex flex-col items-center justify-center text-gray-400">
          <svg className="w-16 h-16 mb-4 text-gray-300" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
          </svg>
          <p className="text-lg font-medium">此日期尚未設定營業時段</p>
          <p className="text-sm mt-1">請先前往「營業時段設定」新增時段，或切換至其他日期。</p>
        </div>
      )}

      {/* Swap Confirmation Modal */}
      {showSwapModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm">
          <div className="bg-white rounded-2xl w-full max-w-sm overflow-hidden shadow-2xl">
            <div className="p-6 border-b border-gray-100">
              <h3 className="text-xl font-bold text-gray-800">{getOccupant(targetSwapSeat) ? '確認互換座位' : '確認換位'}</h3>
            </div>
            <div className="p-6">
              <p className="text-gray-600 mb-4 text-center">
                確定要將 <strong className="text-indigo-600">{selectedSeat?.reservation?.user?.name}</strong> 的座位
                {getOccupant(targetSwapSeat) && <span> 與 <strong className="text-emerald-600">{getOccupant(targetSwapSeat).user?.name}</strong> 互換</span>}
              </p>
              <div className="flex items-center justify-center gap-4 text-lg font-bold">
                <span className="bg-gray-100 px-4 py-2 rounded-lg text-gray-500 line-through">{selectedSeat?.seat}</span>
                <span className="text-gray-400">➡️</span>
                <span className="bg-green-100 text-green-700 px-4 py-2 rounded-lg">{targetSwapSeat}</span>
              </div>
            </div>
            <div className="p-4 bg-gray-50 flex gap-3">
              <button
                onClick={() => {
                  setShowSwapModal(false);
                  setTargetSwapSeat(null);
                }}
                className="flex-1 py-2 px-4 bg-white border hover:bg-gray-50 text-gray-700 rounded-xl font-medium transition-colors"
              >
                取消
              </button>
              <button
                onClick={confirmSwap}
                className="flex-1 py-2 px-4 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl font-bold transition-colors shadow-lg shadow-indigo-600/30"
              >
                確認移動
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
