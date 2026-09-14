import React from 'react';
import { format } from 'date-fns';
import { X, CheckCircle2, XCircle, Calendar, Users, Phone } from 'lucide-react';
import api from '../api/axios';

export const getReservationStatusUI = (r) => {
  if (r.status === 'cancelled') {
    return { text: '已取消', icon: <XCircle className="w-4 h-4"/>, colorClass: 'text-[#8C8279]', bgClass: 'bg-[#EBE5DF]' };
  }
  if (r.attendance === 'checked_in') {
    return { text: '已報到', icon: <CheckCircle2 className="w-4 h-4"/>, colorClass: 'text-[#5A6B4E]', bgClass: 'bg-[#DDE3D5]' };
  }
  if (r.attendance === 'no_show') {
    return { text: '預約未到', icon: <XCircle className="w-4 h-4"/>, colorClass: 'text-[#B35D4F]', bgClass: 'bg-[#FDF3F1]' };
  }

  const now = new Date();
  const startTimeStr = r.start_time || r.session?.start_time || '00:00';
  const [hours, minutes] = startTimeStr.split(':').map(Number);
  const sessionDate = new Date(r.session_date || r.session?.session_date);
  sessionDate.setHours(hours, minutes, 0, 0);
  sessionDate.setMinutes(sessionDate.getMinutes() + 15);

  if (now > sessionDate) {
    return { text: '預約未到', icon: <XCircle className="w-4 h-4"/>, colorClass: 'text-[#B35D4F]', bgClass: 'bg-[#FDF3F1]' };
  }

  return { text: '預約成功', icon: <CheckCircle2 className="w-4 h-4"/>, colorClass: 'text-[#8B5B43]', bgClass: 'bg-[#F4EFE6]' };
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

  const sessionDateTime = new Date(reservation.session_date || reservation.session?.session_date);
  const [startHour, startMin] = (reservation.start_time || reservation.session?.start_time || '00:00').split(':').map(Number);
  sessionDateTime.setHours(startHour, startMin, 0, 0);
  const isPast = new Date() >= sessionDateTime;

  const truncateUUID = (uuid) => {
    if (!uuid) return '';
    return `${uuid.substring(0, 4)}...${uuid.substring(uuid.length - 4)}`;
  };

  return (
    <div className="fixed inset-0 z-[110] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-gray-900/40 backdrop-blur-sm" onClick={onClose} />
      <div className="bg-white rounded-[24px] shadow-[0_20px_40px_rgba(139,91,67,0.1)] w-full max-w-lg overflow-hidden relative z-10 animate-in zoom-in-95 duration-200 flex flex-col max-h-[90vh]">
        <div className="px-6 py-5 border-b border-[#EBE5DF] flex items-center justify-between">
          <h2 className="text-xl font-bold text-[#2C241E]">
            預約詳細資訊
          </h2>
          <button onClick={onClose} className="p-2 text-[#8C8279] hover:text-[#2C241E] rounded-full hover:bg-[#F9F7F3] transition-colors">
            <X className="w-5 h-5" />
          </button>
        </div>
        
        <div className="p-6 overflow-y-auto flex-1">
          <div className="bg-[#F9F7F3] rounded-[16px] p-5 sm:p-6 space-y-5">
            <div className="border-b border-dashed border-[#E5DFD7] pb-5">
              <h3 className="text-sm font-medium text-[#7A7067] mb-1.5">預約編號</h3>
              <p className="text-sm font-mono font-medium text-[#2C241E]">{truncateUUID(reservation.booking_ref)}</p>
            </div>
            
            <div className="border-b border-dashed border-[#E5DFD7] pb-5 grid grid-cols-2 gap-4">
              <div>
                <h3 className="text-sm font-medium text-[#7A7067] mb-1.5 flex items-center gap-1.5"><Calendar className="w-4 h-4" /> 預約時間</h3>
                <div className="text-[17px] font-bold text-[#2C241E]">
                  {format(new Date(reservation.session_date || reservation.session?.session_date), 'yyyy/MM/dd')}
                  <div className="text-[#7A7067] text-sm font-medium mt-1 space-y-1">
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
                <h3 className="text-sm font-medium text-[#7A7067] mb-1.5 flex items-center gap-1.5"><Users className="w-4 h-4" /> 人數</h3>
                <div className="flex items-center gap-2">
                  <p className="text-[17px] font-bold text-[#2C241E]">{reservation.pax} 人</p>
                  {reservation.is_unlimited && (
                    <span className="inline-flex items-center gap-1 text-xs font-bold text-[#A67C52] bg-[#F4EFE6] px-2 py-0.5 rounded-full border border-[#D5CFC9]">
                      ✨ 不限時
                    </span>
                  )}
                </div>
              </div>
            </div>

            <div className="border-b border-dashed border-[#E5DFD7] pb-5">
              <h3 className="text-sm font-medium text-[#7A7067] mb-1.5 flex items-center gap-1.5"><Phone className="w-4 h-4" /> 聯絡人資訊</h3>
              <div className="flex items-center gap-3">
                <p className="text-base font-bold text-[#2C241E]">{reservation.user?.name || '未提供'}</p>
                <p className="text-base font-medium text-[#7A7067]">{reservation.user?.phone || '未提供'}</p>
              </div>
            </div>

            <div>
              <h3 className="text-sm font-medium text-[#7A7067] mb-2">當前狀態</h3>
              <div className="flex items-center flex-wrap gap-2">
                <span className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full font-medium text-sm ${statusUI.bgClass} ${statusUI.colorClass}`}>
                  {statusUI.icon} {statusUI.text}
                </span>
                {reservation.status === 'cancelled' && reservation.cancelled_at && (
                  <span className="text-sm text-[#8C8279]">
                    取消於 {format(new Date(reservation.cancelled_at), 'MM/dd HH:mm')} 
                    ({reservation.cancelled_by === 'admin' ? '店家取消' : '自行取消'})
                  </span>
                )}
                {reservation.is_force_split && (
                  <span className="inline-flex items-center px-2 py-1 bg-[#F4EFE6] text-[#A67C52] border border-[#D5CFC9] rounded-md text-xs font-bold tracking-wide">
                    同意拆桌
                  </span>
                )}
              </div>
            </div>
          </div>

          {/* Actions */}
          {reservation.status !== 'cancelled' && (
            <div className="mt-6 flex justify-end">
              <button 
                onClick={handleCancelReservation}
                disabled={isPast}
                className={`px-6 py-2.5 rounded-full font-medium transition-colors ${
                  isPast 
                    ? 'bg-[#F0EBE6] text-[#A8A19A] cursor-not-allowed border border-transparent' 
                    : 'border border-[#8B5B43] text-[#8B5B43] hover:bg-[#F9F7F3] bg-transparent'
                }`}
              >
                {isPast ? '已過期無法取消' : '取消此預約'}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
