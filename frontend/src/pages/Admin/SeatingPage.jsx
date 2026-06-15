import React, { useState, useEffect } from 'react';
import { format } from 'date-fns';
import { CheckCircle2, XCircle, Trash2, X } from 'lucide-react';
import api from '../../api/axios';
import AdminSeatingChart from '../../components/AdminSeatingChart';

export default function SeatingPage() {
  const [reservations, setReservations] = useState([]);
  const [selectedReservation, setSelectedReservation] = useState(null);

  useEffect(() => {
    fetchReservations();
  }, []);

  const fetchReservations = async () => {
    try {
      const res = await api.get('/reservations/admin');
      setReservations(res.data);
    } catch (err) {
      console.error(err);
    }
  };

  const handleUpdateAttendance = async (booking_ref, attendance) => {
    try {
      await api.patch(`/reservations/${booking_ref}/attendance`, { attendance });
      setReservations(prev => prev.map(r => 
        r.booking_ref === booking_ref ? { ...r, attendance } : r
      ));
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
    <>
      <div className="h-full relative">
        <AdminSeatingChart 
        onOpenDetails={(booking_ref) => {
          const res = reservations.find(r => r.booking_ref === booking_ref);
          if (res) setSelectedReservation(res);
        }}
        onCheckIn={(booking_ref) => handleUpdateAttendance(booking_ref, 'checked_in')}
      />

      </div>

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
    </>
  );
}
