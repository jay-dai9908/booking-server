import React from 'react';
import { format } from 'date-fns';
import { X, CheckCircle2, XCircle } from 'lucide-react';
import api from '../api/axios';

export const getReservationStatusUI = (r) => {
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

export default function CustomerReservationDetailsModal({ reservation, onClose, onUpdate }) {
  if (!reservation) return null;

  const handleCancelReservation = async () => {
    if (window.confirm('確定要取消此預約嗎？此操作無法復原。')) {
      try {
        await api.delete(`/reservations/${reservation.booking_ref}`);
        if (onUpdate) onUpdate();
        onClose();
      } catch (err) {
        alert(err.response?.data?.error || '取消失敗');
      }
    }
  };

  const statusUI = getReservationStatusUI({
    ...reservation,
    start_time: reservation.start_time || reservation.session?.start_time,
    session_date: reservation.session_date || reservation.session?.session_date
  });

  return (
    <div className="fixed inset-0 z-[110] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-gray-900/40 backdrop-blur-sm" onClick={onClose} />
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg overflow-hidden relative z-10 animate-in zoom-in-95 duration-200 flex flex-col max-h-[90vh]">
        <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between bg-gray-50/50">
          <h2 className="text-xl font-bold text-gray-800">
            預約詳細資訊
          </h2>
          <button onClick={onClose} className="p-2 text-gray-400 hover:text-gray-600 rounded-full hover:bg-gray-200 transition-colors">
            <X className="w-5 h-5" />
          </button>
        </div>
        
        <div className="p-6 overflow-y-auto flex-1">
          <div className="space-y-6 mb-8">
            <div>
              <h3 className="text-sm font-medium text-gray-500 mb-1">預約編號</h3>
              <p className="text-sm text-gray-800 font-mono">{reservation.booking_ref}</p>
            </div>
            
            <div className="grid grid-cols-2 gap-4">
              <div>
                <h3 className="text-sm font-medium text-gray-500 mb-1">預約時間</h3>
                <div className="text-lg font-bold text-gray-900">
                  {format(new Date(reservation.session_date || reservation.session?.session_date), 'yyyy/MM/dd')}
                  <div className="text-gray-500 text-sm font-normal mt-1 space-y-1">
                    {reservation.time_blocks ? (
                      reservation.time_blocks.map((b, i) => (
                        <div key={i}>{b.start_time} - {b.end_time}</div>
                      ))
                    ) : (
                      <div>{reservation.start_time || reservation.session?.start_time} - {reservation.end_time || reservation.session?.end_time}</div>
                    )}
                  </div>
                </div>
              </div>
              <div>
                <h3 className="text-sm font-medium text-gray-500 mb-1">人數</h3>
                <div className="flex items-center gap-2">
                  <p className="text-lg font-bold text-gray-900">{reservation.pax} 人</p>
                  {reservation.is_unlimited && (
                    <span className="inline-flex items-center gap-1 text-xs font-bold text-purple-700 bg-purple-100 px-2 py-0.5 rounded-md">
                      ✨ 不限時
                    </span>
                  )}
                </div>
              </div>
            </div>

            <div>
              <h3 className="text-sm font-medium text-gray-500 mb-1">聯絡人資訊</h3>
              <p className="text-md font-bold text-gray-900">{reservation.user?.name || '未提供'}</p>
              <p className="text-md text-gray-600">{reservation.user?.phone || '未提供'}</p>
            </div>

            <div>
              <h3 className="text-sm font-medium text-gray-500 mb-1">當前狀態</h3>
              <div className="mt-1 flex items-center">
                <span className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg font-medium ${statusUI.bgClass} ${statusUI.colorClass}`}>
                  {statusUI.icon} {statusUI.text}
                </span>
                {reservation.is_force_split && (
                  <span className="ml-2 inline-flex items-center px-2 py-1 bg-amber-50 text-amber-600 border border-amber-200 rounded-md text-xs font-bold tracking-wide">
                    同意拆桌
                  </span>
                )}
              </div>
            </div>
          </div>

          {/* Actions */}
          {reservation.status !== 'cancelled' && (
            <div className="pt-6 border-t border-gray-100 flex justify-end">
              <button 
                onClick={handleCancelReservation}
                className="px-6 py-2.5 text-red-600 bg-red-50 hover:bg-red-100 rounded-xl font-medium transition-colors"
              >
                取消此預約
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
