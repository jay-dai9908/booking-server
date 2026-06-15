import React, { useState, useEffect } from 'react';
import { format } from 'date-fns';
import { Plus, Search, CheckCircle2, XCircle, Trash2, X } from 'lucide-react';
import api from '../../api/axios';

export default function ReservationsPage() {
  const [reservations, setReservations] = useState([]);
  const [selectedReservation, setSelectedReservation] = useState(null);
  const [isLoading, setIsLoading] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');

  // Manual Booking State
  const [showManualBooking, setShowManualBooking] = useState(false);
  const [manualDate, setManualDate] = useState(format(new Date(), 'yyyy-MM-dd'));
  const [manualSessions, setManualSessions] = useState([]);
  const [manualSelectedSessions, setManualSelectedSessions] = useState([]);
  const [manualName, setManualName] = useState('');
  const [manualPhone, setManualPhone] = useState('');
  const [manualPax, setManualPax] = useState(1);
  const [isManualLoading, setIsManualLoading] = useState(false);

  useEffect(() => {
    fetchReservations();
  }, []);

  useEffect(() => {
    if (showManualBooking) {
      fetchManualSessions();
    }
  }, [manualDate, showManualBooking]);

  const fetchReservations = async () => {
    setIsLoading(true);
    try {
      const res = await api.get('/reservations/admin');
      setReservations(res.data);
    } catch (err) {
      console.error(err);
    } finally {
      setIsLoading(false);
    }
  };

  const fetchManualSessions = async () => {
    setIsManualLoading(true);
    try {
      const res = await api.get(`/sessions?date=${manualDate}`);
      setManualSessions(res.data);
      setManualSelectedSessions([]); // reset when date changes
    } catch (err) {
      console.error(err);
    } finally {
      setIsManualLoading(false);
    }
  };

  const handleUpdateAttendance = async (booking_ref, attendance) => {
    try {
      await api.patch(`/reservations/${booking_ref}/attendance`, { attendance });
      // Update local state for reservations
      setReservations(prev => prev.map(r => 
        r.booking_ref === booking_ref ? { ...r, attendance } : r
      ));
      // Update selected reservation if open
      if (selectedReservation && selectedReservation.booking_ref === booking_ref) {
        setSelectedReservation(prev => ({ ...prev, attendance }));
      }
    } catch (err) {
      console.error(err);
      alert('更新狀態失敗');
    }
  };

  const handleCancelReservation = async (id) => {
    try {
      await api.delete(`/reservations/${id}`);
      fetchReservations();
    } catch (err) {
      alert(err.response?.data?.error || '取消失敗');
    }
  };

  const handleDeleteReservationRecord = async (id) => {
    if (window.confirm('確定要永久刪除此筆訂單紀錄嗎？此操作無法復原。')) {
      try {
        await api.delete(`/reservations/${id}/record`);
        fetchReservations();
        setSelectedReservation(null);
      } catch (err) {
        alert(err.response?.data?.error || '刪除失敗');
      }
    }
  };

  const toggleManualSession = (session) => {
    if (session.remaining_capacity === 0) return;
    setManualSelectedSessions(prev => {
      const isSelected = prev.find(s => s.id === session.id);
      if (isSelected) {
        return prev.filter(s => s.id !== session.id);
      } else {
        return [...prev, session];
      }
    });
  };

  const manualMaxPax = manualSelectedSessions.length > 0 
    ? Math.min(...manualSelectedSessions.map(s => s.remaining_capacity))
    : 0;

  useEffect(() => {
    if (manualSelectedSessions.length > 0 && manualPax > manualMaxPax) {
      setManualPax(manualMaxPax > 0 ? manualMaxPax : 1);
    }
  }, [manualSelectedSessions, manualMaxPax, manualPax]);

  const handleManualSubmit = async (e) => {
    e.preventDefault();
    if (manualSelectedSessions.length === 0) {
      alert('請至少選擇一個時段');
      return;
    }
    const sortedSessions = [...manualSelectedSessions].sort((a, b) => a.start_time.localeCompare(b.start_time));
    
    try {
      await api.post('/reservations/admin', {
        name: manualName,
        phone: manualPhone,
        session_ids: sortedSessions.map(s => s.id),
        pax: manualPax
      });
      alert('手動預約建立成功！');
      setShowManualBooking(false);
      setManualName('');
      setManualPhone('');
      setManualSelectedSessions([]);
      fetchReservations();
    } catch (err) {
      alert(err.response?.data?.error || '手動預約失敗');
    }
  };

  const getReservationStatusUI = (r) => {
    if (r.status === 'cancelled') {
      return { text: '已取消', icon: <XCircle className="w-4 h-4"/>, colorClass: 'text-gray-400', bgClass: 'bg-gray-100' };
    }
    if (r.attendance === 'checked_in') {
      return { text: '已報到', icon: <CheckCircle2 className="w-4 h-4"/>, colorClass: 'text-blue-600', bgClass: 'bg-blue-50' };
    }
    if (r.attendance === 'no_show') {
      return { text: '預約未到', icon: <XCircle className="w-4 h-4"/>, colorClass: 'text-red-500', bgClass: 'bg-red-50' };
    }

    const now = new Date();
    const [hours, minutes] = r.start_time.split(':').map(Number);
    const sessionDate = new Date(r.session_date);
    sessionDate.setHours(hours, minutes, 0, 0);
    sessionDate.setMinutes(sessionDate.getMinutes() + 15);

    if (now > sessionDate) {
      return { text: '預約未到', icon: <XCircle className="w-4 h-4"/>, colorClass: 'text-red-500', bgClass: 'bg-red-50' };
    }

    return { text: '預約成功', icon: <CheckCircle2 className="w-4 h-4"/>, colorClass: 'text-green-600', bgClass: 'bg-green-50' };
  };

  return (
    <div className="p-4 md:p-8 space-y-8 animate-fade-in">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 tracking-tight">預約訂單總覽</h1>
          <p className="text-gray-500 mt-1 text-sm">查看所有顧客的預約明細與狀態。</p>
        </div>
        <div className="flex items-center gap-3">
          <div className="relative">
            <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
              <Search className="h-4 w-4 text-gray-400" />
            </div>
            <input
              type="text"
              placeholder="搜尋姓名或電話..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-10 pr-4 py-2 bg-white border border-gray-200 rounded-xl focus:ring-2 focus:ring-gray-900 focus:outline-none text-sm transition-shadow w-full md:w-64"
            />
          </div>
          <button 
            onClick={() => setShowManualBooking(true)}
            className="bg-gray-900 hover:bg-gray-800 text-white px-4 py-2 flex items-center justify-center gap-2 rounded-xl text-sm font-medium transition-colors shadow-sm whitespace-nowrap"
          >
            <Plus className="w-4 h-4"/> 新增手動預約
          </button>
        </div>
      </div>

      <div className="bg-white rounded-2xl shadow-sm border border-gray-200 overflow-hidden">
        <div className="overflow-x-auto">
          {isLoading ? (
            <div className="p-10 flex justify-center"><div className="w-8 h-8 border-4 border-gray-200 border-t-gray-800 rounded-full animate-spin" /></div>
          ) : (
            <table className="w-full text-left whitespace-nowrap">
              <thead>
                <tr className="bg-gray-50 text-gray-500 text-sm border-b border-gray-200">
                  <th className="px-6 py-4 font-medium">預約日期 / 時段</th>
                  <th className="px-6 py-4 font-medium">顧客資料</th>
                  <th className="px-6 py-4 font-medium text-center">人數</th>
                  <th className="px-6 py-4 font-medium">狀態</th>
                  <th className="px-6 py-4 font-medium text-right">建立時間</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {reservations.filter(r => {
                  if (!searchQuery) return true;
                  const q = searchQuery.toLowerCase();
                  return r.user.name.toLowerCase().includes(q) || r.user.phone.toLowerCase().includes(q);
                }).length === 0 ? (
                  <tr><td colSpan="5" className="text-center py-16 text-gray-400">{searchQuery ? '找不到符合條件的預約' : '目前尚無預約紀錄'}</td></tr>
                ) : (
                  reservations.filter(r => {
                    if (!searchQuery) return true;
                    const q = searchQuery.toLowerCase();
                    return r.user.name.toLowerCase().includes(q) || r.user.phone.toLowerCase().includes(q);
                  }).map(r => {
                    const isCancelled = r.status === 'cancelled';
                    const statusUI = getReservationStatusUI(r);
                    return (
                      <tr key={r.booking_ref} 
                          onClick={() => setSelectedReservation(r)}
                          className={`hover:bg-gray-50 transition-colors cursor-pointer ${isCancelled ? 'bg-gray-50/50' : ''}`}>
                        <td className="px-6 py-4">
                          <div className="flex flex-col">
                            <span className={`font-semibold ${isCancelled ? 'text-gray-400 line-through' : 'text-gray-800'}`}>
                              {format(new Date(r.session_date), 'yyyy/MM/dd')}
                            </span>
                            <span className="text-sm text-gray-500">{r.start_time} - {r.end_time} ({r.session_count}小時)</span>
                          </div>
                        </td>
                        <td className="px-6 py-4">
                          <div className="flex flex-col">
                            <span className={`font-medium ${isCancelled ? 'text-gray-400' : 'text-gray-800'}`}>{r.user.name}</span>
                            <span className="text-sm text-gray-500">{r.user.phone}</span>
                          </div>
                        </td>
                        <td className="px-6 py-4 text-center">
                          <span className={`inline-flex justify-center items-center w-8 h-8 rounded-lg ${isCancelled ? 'bg-gray-100 text-gray-400' : 'bg-gray-100 text-gray-900 font-bold'}`}>
                            {r.pax}
                          </span>
                        </td>
                        <td className="px-6 py-4">
                          <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-sm font-medium ${statusUI.bgClass} ${statusUI.colorClass}`}>
                            {statusUI.icon} {statusUI.text}
                          </span>
                        </td>
                        <td className="px-6 py-4 text-right text-sm text-gray-400">
                          {format(new Date(r.created_at), 'MM/dd HH:mm')}
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

      {/* Manual Booking Modal */}
      {showManualBooking && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-gray-900/40 backdrop-blur-sm" onClick={() => setShowManualBooking(false)} />
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-2xl overflow-hidden relative z-10 animate-in zoom-in-95 duration-200">
            <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between">
              <h2 className="text-xl font-bold text-gray-800">新增手動預約</h2>
              <button onClick={() => setShowManualBooking(false)} className="p-2 text-gray-400 hover:text-gray-600 rounded-full hover:bg-gray-100 transition-colors">
                <XCircle className="w-6 h-6" />
              </button>
            </div>
            
            <form onSubmit={handleManualSubmit} className="p-6 overflow-y-auto max-h-[70vh]">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-6">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">顧客姓名</label>
                  <input type="text" required value={manualName} onChange={e => setManualName(e.target.value)} placeholder="例：王小明"
                    className="w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl focus:ring-2 focus:ring-gray-900 outline-none" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">聯絡電話</label>
                  <input type="tel" required value={manualPhone} onChange={e => setManualPhone(e.target.value)} placeholder="例：0912345678"
                    className="w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl focus:ring-2 focus:ring-gray-900 outline-none" />
                </div>
              </div>

              <div className="mb-6">
                <label className="block text-sm font-medium text-gray-700 mb-2">預約日期</label>
                <input type="date" required value={manualDate} onChange={e => setManualDate(e.target.value)}
                  className="w-full md:w-1/2 px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl focus:ring-2 focus:ring-gray-900 outline-none" />
              </div>

              <div className="mb-6">
                <div className="flex justify-between items-center mb-2">
                  <label className="block text-sm font-medium text-gray-700">選擇時段 (可複選)</label>
                  {manualSelectedSessions.length > 0 && (
                    <span className="text-xs bg-gray-100 text-gray-600 px-2 py-1 rounded-md">已選 {manualSelectedSessions.length} 小時</span>
                  )}
                </div>
                
                {isManualLoading ? (
                  <div className="text-gray-400 py-4 text-center text-sm">載入中...</div>
                ) : manualSessions.length === 0 ? (
                  <div className="text-gray-400 py-4 text-center text-sm bg-gray-50 rounded-xl border border-gray-100">該日期無開放時段</div>
                ) : (
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                    {manualSessions.map(session => {
                      const isFull = session.remaining_capacity === 0;
                      const isSelected = !!manualSelectedSessions.find(s => s.id === session.id);
                      return (
                        <button
                          key={session.id} type="button" disabled={isFull} onClick={() => toggleManualSession(session)}
                          className={`p-3 rounded-xl border flex flex-col items-center transition-all ${
                            isFull ? 'bg-gray-50 border-gray-100 text-gray-400 opacity-60 cursor-not-allowed' 
                                   : isSelected ? 'border-gray-900 bg-gray-900 text-white shadow-md' 
                                                : 'border-gray-200 text-gray-700 hover:border-gray-400 hover:bg-gray-50'
                          }`}
                        >
                          <span className="font-bold text-sm">{session.start_time}</span>
                          <span className="text-xs opacity-80">{isFull ? '已滿' : `剩 ${session.remaining_capacity} 人`}</span>
                        </button>
                      )
                    })}
                  </div>
                )}
              </div>

              {manualSelectedSessions.length > 0 && manualMaxPax > 0 && (
                <div className="mb-6 animate-in fade-in slide-in-from-bottom-2">
                  <label className="block text-sm font-medium text-gray-700 mb-2">預約人數 (最多 {manualMaxPax} 人)</label>
                  <select 
                    value={manualPax} onChange={(e) => setManualPax(parseInt(e.target.value))}
                    className="w-full md:w-1/2 px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl focus:ring-2 focus:ring-gray-900 outline-none"
                  >
                    {Array.from({ length: manualMaxPax }).map((_, i) => (
                      <option key={i + 1} value={i + 1}>{i + 1} 人</option>
                    ))}
                  </select>
                </div>
              )}

              <div className="pt-4 border-t border-gray-100 flex justify-end gap-3">
                <button type="button" onClick={() => setShowManualBooking(false)} className="px-5 py-2.5 text-gray-600 hover:bg-gray-100 rounded-xl font-medium transition-colors">取消</button>
                <button type="submit" disabled={manualSelectedSessions.length === 0} className="px-6 py-2.5 bg-gray-900 hover:bg-gray-800 disabled:opacity-50 text-white rounded-xl font-bold transition-colors">確認預約</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Reservation Details Modal */}
      {selectedReservation && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-gray-900/40 backdrop-blur-sm" onClick={() => setSelectedReservation(null)} />
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-2xl overflow-hidden relative z-10 animate-in zoom-in-95 duration-200 flex flex-col max-h-[90vh]">
            <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between bg-gray-50/50">
              <h2 className="text-xl font-bold text-gray-800 flex items-center gap-2">
                訂單詳細資訊
              </h2>
              <button onClick={() => setSelectedReservation(null)} className="p-2 text-gray-400 hover:text-gray-600 rounded-full hover:bg-gray-200 transition-colors">
                <X className="w-5 h-5" />
              </button>
            </div>
            
            <div className="p-6 overflow-y-auto flex-1">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-8">
                <div className="space-y-4">
                  <div>
                    <h3 className="text-sm font-medium text-gray-500 mb-1">訂單編號</h3>
                    <p className="text-sm text-gray-800 font-mono">{selectedReservation.booking_ref}</p>
                  </div>
                  <div>
                    <h3 className="text-sm font-medium text-gray-500 mb-1">顧客姓名</h3>
                    <p className="text-lg font-bold text-gray-900">{selectedReservation.user.name || '未設定'}</p>
                  </div>
                  <div>
                    <h3 className="text-sm font-medium text-gray-500 mb-1">聯絡電話</h3>
                    <p className="text-lg font-bold text-gray-900">{selectedReservation.user.phone || '未提供'}</p>
                  </div>
                </div>
                
                <div className="space-y-4">
                  <div>
                    <h3 className="text-sm font-medium text-gray-500 mb-1">預約時間</h3>
                    <p className="text-lg font-bold text-gray-900">
                      {format(new Date(selectedReservation.session_date), 'yyyy/MM/dd')}
                      <span className="text-gray-500 text-sm ml-2 font-normal">
                        {selectedReservation.start_time} - {selectedReservation.end_time} ({selectedReservation.session_count}小時)
                      </span>
                    </p>
                  </div>
                  <div>
                    <h3 className="text-sm font-medium text-gray-500 mb-1">人數</h3>
                    <p className="text-lg font-bold text-gray-900">{selectedReservation.pax} 人</p>
                  </div>
                  <div>
                    <h3 className="text-sm font-medium text-gray-500 mb-1">當前狀態</h3>
                    <div className="mt-1">
                      {(() => {
                        const statusUI = getReservationStatusUI(selectedReservation);
                        return (
                          <div className="flex items-center">
                            <span className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg font-medium ${statusUI.bgClass} ${statusUI.colorClass}`}>
                              {statusUI.icon} {statusUI.text}
                            </span>
                            {selectedReservation.is_force_split && (
                              <span className="ml-2 inline-flex items-center px-2 py-1 bg-amber-50 text-amber-600 border border-amber-200 rounded-md text-xs font-bold tracking-wide">
                                顧客同意拆桌
                              </span>
                            )}
                          </div>
                        );
                      })()}
                    </div>
                  </div>
                </div>
              </div>

              {/* Actions */}
              <div className="pt-6 border-t border-gray-100">
                <h3 className="text-sm font-medium text-gray-500 mb-3">訂單操作</h3>
                {selectedReservation.status === 'cancelled' ? (
                  <div className="flex items-center justify-between">
                    <p className="text-gray-500 text-sm">此訂單已取消。</p>
                    <button 
                      onClick={() => handleDeleteReservationRecord(selectedReservation.booking_ref)}
                      className="px-4 py-2 bg-red-50 text-red-600 hover:bg-red-100 rounded-xl font-medium transition-colors flex items-center gap-2 text-sm border border-red-100"
                    >
                      <Trash2 className="w-4 h-4" />
                      刪除紀錄
                    </button>
                  </div>
                ) : (
                  <div className="flex flex-wrap gap-3">
                    <button 
                      onClick={() => handleUpdateAttendance(selectedReservation.booking_ref, 'checked_in')}
                      disabled={selectedReservation.attendance === 'checked_in'}
                      className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-300 text-white rounded-xl font-medium transition-colors flex items-center gap-2"
                    >
                      <CheckCircle2 className="w-4 h-4" />
                      完成報到
                    </button>
                    <button 
                      onClick={() => handleUpdateAttendance(selectedReservation.booking_ref, 'no_show')}
                      disabled={selectedReservation.attendance === 'no_show'}
                      className="px-4 py-2 bg-gray-600 hover:bg-gray-700 disabled:bg-gray-300 text-white rounded-xl font-medium transition-colors flex items-center gap-2"
                    >
                      <XCircle className="w-4 h-4" />
                      標記未到
                    </button>
                    <button 
                      onClick={() => handleUpdateAttendance(selectedReservation.booking_ref, null)}
                      disabled={!selectedReservation.attendance}
                      className="px-4 py-2 bg-white border border-gray-200 hover:bg-gray-50 disabled:bg-gray-50 disabled:text-gray-400 text-gray-700 rounded-xl font-medium transition-colors"
                    >
                      清除報到標記
                    </button>
                    
                    <div className="flex-1"></div>
                    
                    <button 
                      onClick={() => {
                        if(window.confirm('確定要取消此預約嗎？此操作無法復原。')) {
                          handleCancelReservation(selectedReservation.booking_ref);
                          setSelectedReservation(null);
                        }
                      }}
                      className="px-4 py-2 text-red-600 bg-red-50 hover:bg-red-100 rounded-xl font-medium transition-colors"
                    >
                      取消預約
                    </button>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      <style dangerouslySetInnerHTML={{__html: `
        .animate-in { animation: animateIn 0.4s ease-out forwards; }
        @keyframes animateIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
      `}} />
    </div>
  );
}
