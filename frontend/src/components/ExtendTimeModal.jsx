import React, { useState, useEffect } from 'react';
import { XCircle, CheckCircle, Clock } from 'lucide-react';
import api from '../api/axios';

const ExtendTimeModal = ({ isOpen, onClose, reservation, onSuccess }) => {
  const [sessions, setSessions] = useState([]);
  const [isLoading, setIsLoading] = useState(false);
  const [selectedSessions, setSelectedSessions] = useState([]);
  const [extendMode, setExtendMode] = useState('keep_seat'); // 'keep_seat', 'system_allocate', 'force_wait'
  const [forceSplit, setForceSplit] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (isOpen && reservation) {
      fetchSessions();
      setExtendMode('keep_seat');
      setSelectedSessions([]);
      setError('');
    }
  }, [isOpen, reservation]);

  const fetchSessions = async () => {
    setIsLoading(true);
    try {
      // Find the session date
      const sessionDate = reservation.session_date || reservation.session?.session_date;
      // Find the end time of the current booking
      let endTime = reservation.end_time || reservation.session?.end_time;
      if (reservation.blocks && reservation.blocks.length > 0) {
        endTime = reservation.blocks[reservation.blocks.length - 1].end_time;
      }
      
      const res = await api.get(`/sessions?date=${sessionDate}`);
      
      // Filter out sessions that are BEFORE or EQUAL to the current end time
      // Simple string comparison works for "HH:mm" formats like "13:00" > "12:00"
      const availableSessions = res.data.filter(s => s.start_time >= endTime);
      setSessions(availableSessions);
    } catch (err) {
      console.error('Failed to fetch sessions', err);
    } finally {
      setIsLoading(false);
    }
  };

  const toggleSession = (session) => {
    let newSelected;
    const isSelected = selectedSessions.some(s => s.id === session.id);
    if (isSelected) {
      newSelected = selectedSessions.filter(s => s.id !== session.id);
    } else {
      newSelected = [...selectedSessions, session];
    }
    
    // Auto-sort by start time
    newSelected.sort((a, b) => a.start_time.localeCompare(b.start_time));
    setSelectedSessions(newSelected);
  };

  // Calculate the minimum remaining capacity among the selected sessions
  const getMinRemainingCapacity = () => {
    if (selectedSessions.length === 0) return 999;
    return Math.min(...selectedSessions.map(s => s.remaining_capacity));
  };

  const minCapacity = getMinRemainingCapacity();
  const pax = reservation?.pax || 1;
  const isCapacitySufficient = minCapacity >= pax;

  // Auto-switch mode if capacity is insufficient
  useEffect(() => {
    if (selectedSessions.length > 0) {
      if (!isCapacitySufficient && extendMode !== 'force_wait') {
        setExtendMode('force_wait');
      } else if (isCapacitySufficient && extendMode === 'force_wait') {
        setExtendMode('keep_seat');
      }
    }
  }, [selectedSessions, isCapacitySufficient]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (selectedSessions.length === 0) {
      setError('請至少選擇一個加時時段');
      return;
    }

    setIsSubmitting(true);
    setError('');

    try {
      await api.post(`/reservations/admin/${reservation.booking_ref}/extend`, {
        session_ids: selectedSessions.map(s => s.id),
        extendMode,
        forceSplit
      });
      
      onSuccess();
      onClose();
    } catch (err) {
      setError(err.response?.data?.error || '加時失敗，請稍後再試');
    } finally {
      setIsSubmitting(false);
    }
  };

  if (!isOpen || !reservation) return null;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-gray-900/40 backdrop-blur-sm" onClick={onClose} />
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-2xl overflow-hidden relative z-10 animate-in zoom-in-95 duration-200 flex flex-col max-h-[90vh]">
        
        {/* Header */}
        <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between flex-shrink-0">
          <div className="flex items-center gap-2">
            <div className="p-2 bg-indigo-50 text-indigo-600 rounded-lg">
              <Clock className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-xl font-bold text-gray-800">現場加時</h2>
              <p className="text-sm text-gray-500 font-medium mt-0.5">
                {reservation.user?.name} · {pax} 人
              </p>
            </div>
          </div>
          <button onClick={onClose} className="p-2 text-gray-400 hover:text-gray-600 rounded-full hover:bg-gray-100 transition-colors">
            <XCircle className="w-6 h-6" />
          </button>
        </div>

        {/* Content */}
        <div className="p-6 overflow-y-auto">
          {error && (
            <div className="mb-6 p-4 bg-red-50 text-red-600 rounded-xl text-sm border border-red-100 flex items-center gap-2">
              <XCircle className="w-5 h-5 flex-shrink-0" />
              {error}
            </div>
          )}

          {/* Session Selection */}
          <div className="mb-8">
            <div className="flex justify-between items-center mb-3">
              <label className="block text-sm font-bold text-gray-700">選擇後續時段</label>
              {selectedSessions.length > 0 && (
                <span className="text-xs bg-indigo-50 text-indigo-600 px-2.5 py-1 rounded-md font-bold">
                  已選 {selectedSessions.length} 小時
                </span>
              )}
            </div>
            
            {isLoading ? (
              <div className="text-gray-400 py-4 text-center text-sm">載入時段中...</div>
            ) : sessions.length === 0 ? (
              <div className="text-gray-500 text-sm p-4 bg-gray-50 rounded-xl text-center border border-gray-100">
                本日已無後續時段可供加時。
              </div>
            ) : (
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                {sessions.map(session => {
                  const isSelected = selectedSessions.some(s => s.id === session.id);
                  const isFull = session.remaining_capacity < pax;
                  
                  return (
                    <div 
                      key={session.id}
                      onClick={() => toggleSession(session)}
                      className={`
                        relative p-3 rounded-xl border-2 cursor-pointer transition-all duration-200
                        ${isSelected 
                          ? 'border-indigo-600 bg-indigo-50/50 shadow-sm' 
                          : 'border-gray-100 bg-white hover:border-indigo-300 hover:bg-gray-50'}
                      `}
                    >
                      {isSelected && (
                        <div className="absolute -top-2 -right-2 bg-indigo-600 rounded-full p-0.5 shadow-sm">
                          <CheckCircle className="w-4 h-4 text-white" />
                        </div>
                      )}
                      <div className="text-sm font-bold text-gray-800 text-center mb-1">
                        {session.start_time} - {session.end_time}
                      </div>
                      <div className={`text-xs text-center font-medium ${isFull ? 'text-red-500' : 'text-emerald-600'}`}>
                        剩餘 {session.remaining_capacity} 位
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Extension Options */}
          {selectedSessions.length > 0 && (
            <div className="space-y-4 animate-in slide-in-from-top-4 duration-300">
              <label className="block text-sm font-bold text-gray-700 mb-2">座位安排方式</label>
              
              {!isCapacitySufficient && (
                <div className="p-3 bg-red-50 border border-red-100 rounded-lg text-sm text-red-600 font-medium mb-2 flex items-start gap-2">
                  <span className="mt-0.5">⚠️</span>
                  <p>所選時段剩餘容量不足！為避免惡意擠掉其他已預約客人，您只能選擇將此客人的加時時段放入外加等待區。</p>
                </div>
              )}

              <div className="space-y-3">
                {/* Mode A: Keep Seat */}
                <label className={`flex items-start gap-3 p-4 rounded-xl border-2 cursor-pointer transition-colors ${extendMode === 'keep_seat' ? 'border-indigo-600 bg-indigo-50/50' : 'border-gray-200 bg-white'} ${!isCapacitySufficient ? 'opacity-50 cursor-not-allowed bg-gray-50' : 'hover:border-indigo-300'}`}>
                  <input
                    type="radio"
                    name="extendMode"
                    value="keep_seat"
                    checked={extendMode === 'keep_seat'}
                    onChange={() => { if(isCapacitySufficient) setExtendMode('keep_seat') }}
                    disabled={!isCapacitySufficient}
                    className="mt-1 w-4 h-4 text-indigo-600 border-gray-300 focus:ring-indigo-500"
                  />
                  <div className="flex flex-col">
                    <span className="text-sm font-bold text-gray-900">保留原位 (推薦)</span>
                    <span className="text-xs text-gray-500 mt-1 leading-relaxed">強制保留目前的座位。如果下一小時該位子有人訂，系統會自動將對方移到別桌。</span>
                  </div>
                </label>

                {/* Mode B: System Allocate */}
                <div className={`rounded-xl border-2 transition-colors ${extendMode === 'system_allocate' ? 'border-indigo-600 bg-indigo-50/50' : 'border-gray-200 bg-white'} ${!isCapacitySufficient ? 'opacity-50 cursor-not-allowed bg-gray-50' : ''}`}>
                  <label className={`flex items-start gap-3 p-4 cursor-pointer ${!isCapacitySufficient ? 'cursor-not-allowed' : ''}`}>
                    <input
                      type="radio"
                      name="extendMode"
                      value="system_allocate"
                      checked={extendMode === 'system_allocate'}
                      onChange={() => { if(isCapacitySufficient) setExtendMode('system_allocate') }}
                      disabled={!isCapacitySufficient}
                      className="mt-1 w-4 h-4 text-indigo-600 border-gray-300 focus:ring-indigo-500"
                    />
                    <div className="flex flex-col">
                      <span className="text-sm font-bold text-gray-900">交由系統排位</span>
                      <span className="text-xs text-gray-500 mt-1 leading-relaxed">不強制保留原座位，由系統在所選時段中自動尋找有空的桌子。</span>
                    </div>
                  </label>
                  
                  {/* Force Split Checkbox (Only visible if mode B is selected) */}
                  {extendMode === 'system_allocate' && (
                    <div className="px-4 pb-4 pt-1 ml-7">
                      <label className="flex items-center gap-2 cursor-pointer p-2 -ml-2 rounded-lg hover:bg-white/60 transition-colors">
                        <input
                          type="checkbox"
                          checked={forceSplit}
                          onChange={(e) => setForceSplit(e.target.checked)}
                          className="w-4 h-4 text-indigo-600 border-gray-300 rounded focus:ring-indigo-500"
                        />
                        <span className="text-sm font-bold text-gray-700">同意拆桌</span>
                        <span className="text-xs text-gray-500 ml-1">(若找不到大桌，優先拆散)</span>
                      </label>
                    </div>
                  )}
                </div>

                {/* Mode C: Force Wait */}
                <label className={`flex items-start gap-3 p-4 rounded-xl border-2 cursor-pointer transition-colors ${extendMode === 'force_wait' ? 'border-orange-500 bg-orange-50' : 'border-gray-200 bg-white hover:border-orange-300'}`}>
                  <input
                    type="radio"
                    name="extendMode"
                    value="force_wait"
                    checked={extendMode === 'force_wait'}
                    onChange={() => setExtendMode('force_wait')}
                    className="mt-1 w-4 h-4 text-orange-600 border-gray-300 focus:ring-orange-500"
                  />
                  <div className="flex flex-col">
                    <span className="text-sm font-bold text-gray-900">放入外加等待區</span>
                    <span className="text-xs text-gray-500 mt-1 leading-relaxed">完全略過容量檢查，不扣除實體座位額度，直接配發 WAIT 虛擬座位。</span>
                  </div>
                </label>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-gray-100 bg-gray-50 flex justify-end gap-3 flex-shrink-0">
          <button 
            type="button" 
            onClick={onClose}
            className="px-5 py-2.5 text-sm font-bold text-gray-600 hover:text-gray-900 hover:bg-gray-100 rounded-xl transition-colors"
          >
            取消
          </button>
          <button 
            onClick={handleSubmit}
            disabled={isSubmitting || selectedSessions.length === 0}
            className={`
              px-6 py-2.5 text-sm font-bold rounded-xl transition-all shadow-sm
              ${isSubmitting || selectedSessions.length === 0
                ? 'bg-indigo-400 text-white opacity-70 cursor-not-allowed' 
                : 'bg-indigo-600 text-white hover:bg-indigo-700 hover:shadow-md active:scale-[0.98]'
              }
            `}
          >
            {isSubmitting ? '處理中...' : '確認加時'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default ExtendTimeModal;
