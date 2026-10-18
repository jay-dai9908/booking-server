import React, { useState } from 'react';
import { format } from 'date-fns';
import { X, CheckCircle2, XCircle, Calendar, Users, Phone, Cpu, Copy, Check, CalendarPlus, AlertTriangle } from 'lucide-react';
import api from '../api/axios';

export const formatBookingRef = (ref) => {
  if (!ref) return '';
  if (ref.length <= 12) return ref;
  return `BK-${ref.slice(0, 4).toUpperCase()}-${ref.slice(-4).toUpperCase()}`;
};

export const getGoogleCalendarUrl = (res) => {
  try {
    const rawDate = res.session_date || res.session?.session_date;
    if (!rawDate) return null;
    const dateStr = format(new Date(rawDate), 'yyyy-MM-dd');
    let startT = res.start_time || res.session?.start_time || '13:00';
    let endT = res.end_time || res.session?.end_time || '14:00';
    if (res.time_blocks && res.time_blocks.length > 0) {
      startT = res.time_blocks[0].start_time;
      endT = res.time_blocks[res.time_blocks.length - 1].end_time;
    }
    const [sH, sM] = startT.split(':').map(Number);
    const [eH, eM] = endT.split(':').map(Number);
    
    const startObj = new Date(rawDate);
    startObj.setHours(sH, sM, 0, 0);
    const endObj = new Date(rawDate);
    endObj.setHours(eH, eM, 0, 0);

    const toGCalISO = (d) => d.toISOString().replace(/-|:|\.\d+/g, '');
    const startUTC = toGCalISO(startObj);
    const endUTC = toGCalISO(endObj);

    const shortRef = formatBookingRef(res.booking_ref);
    const text = encodeURIComponent('拾光製所 拼豆預約');
    const details = encodeURIComponent(
      `預約編號：${shortRef}\n人數：${res.pax}人\n預估總額：NT$ ${res.total_amount || 0}\n\n期待您的到來！預約現場保留 15 分鐘。`
    );
    const location = encodeURIComponent('拾光製所');
    return `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${text}&dates=${startUTC}/${endUTC}&details=${details}&location=${location}&openExternalBrowser=1`;
  } catch (e) {
    return null;
  }
};

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

export default function CustomerReservationDetailsModal({ reservation, onClose, onUpdate, onOpenEquipmentAddon }) {
  const [copied, setCopied] = useState(false);
  const [showCancelConfirm, setShowCancelConfirm] = useState(false);
  const [isCancelling, setIsCancelling] = useState(false);
  const [cancelError, setCancelError] = useState('');

  if (!reservation) return null;

  const handleCopyRef = () => {
    const textToCopy = formatBookingRef(reservation.booking_ref);
    navigator.clipboard?.writeText(textToCopy);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const executeCancelReservation = async () => {
    setIsCancelling(true);
    setCancelError('');
    try {
      await api.delete(`/reservations/${reservation.booking_ref}`);
      if (onUpdate) onUpdate();
      setShowCancelConfirm(false);
      onClose();
    } catch (err) {
      setCancelError(err.response?.data?.error || '取消失敗，請稍後再試或洽店員');
    } finally {
      setIsCancelling(false);
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

  const shortRef = formatBookingRef(reservation.booking_ref);
  const gcalUrl = getGoogleCalendarUrl(reservation);

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
            {/* Booking Ref */}
            <div className="border-b border-dashed border-[#E5DFD7] pb-5 flex items-center justify-between">
              <div>
                <h3 className="text-sm font-medium text-[#7A7067] mb-1.5">專屬預約編號</h3>
                <p className="text-base font-mono font-bold text-[#8B5B43]">{shortRef}</p>
                <p className="text-[11px] font-mono text-gray-400 mt-0.5">{reservation.booking_ref}</p>
              </div>
              <button
                onClick={handleCopyRef}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-white border border-[#E5DFD7] hover:border-[#8B5B43] rounded-xl text-xs font-bold text-[#6D5D52] hover:text-[#8B5B43] shadow-sm transition-all"
              >
                {copied ? (
                  <>
                    <Check className="w-3.5 h-3.5 text-emerald-600" />
                    <span className="text-emerald-600">已複製</span>
                  </>
                ) : (
                  <>
                    <Copy className="w-3.5 h-3.5" />
                    <span>複製編號</span>
                  </>
                )}
              </button>
            </div>
            
            {/* Date and Pax */}
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


            {/* Contact Info */}
            <div className="border-b border-dashed border-[#E5DFD7] pb-5">
              <h3 className="text-sm font-medium text-[#7A7067] mb-1.5 flex items-center gap-1.5"><Phone className="w-4 h-4" /> 聯絡人資訊</h3>
              <div className="flex items-center gap-3">
                <p className="text-base font-bold text-[#2C241E]">{reservation.user?.name || '未提供'}</p>
                <p className="text-base font-medium text-[#7A7067]">{reservation.user?.phone || '未提供'}</p>
              </div>
            </div>

            {/* Equipment Info */}
            <div className="border-b border-dashed border-[#E5DFD7] pb-5">
              <div className="flex items-center justify-between mb-2">
                <h3 className="text-sm font-medium text-[#7A7067] flex items-center gap-1.5">
                  <Cpu className="w-4 h-4" /> 智能拼豆板設備
                </h3>
                {reservation.status !== 'cancelled' && !isPast && onOpenEquipmentAddon && (
                  <button
                    onClick={onOpenEquipmentAddon}
                    className="text-xs font-bold text-[#8B5B43] bg-[#F4EFE6] hover:bg-[#EBE5DF] px-3 py-1 rounded-full transition-colors"
                  >
                    {reservation.equipments && reservation.equipments.length > 0 ? '✏️ 追加/修改' : '➕ 補預約智能板'}
                  </button>
                )}
              </div>
              {reservation.equipments && reservation.equipments.length > 0 ? (
                <div className="space-y-1.5">
                  {reservation.equipments.map((eq, i) => (
                    <div key={i} className="flex items-center justify-between text-sm bg-white p-2.5 rounded-xl border border-[#E5DFD7]">
                      <span className="font-bold text-[#2C241E]">{eq.equipment_name_snapshot} × {eq.quantity} 台</span>
                      <span className="text-xs font-bold text-[#8B5B43]">
                        {eq.rental_hours} 小時 ｜ NT$ {eq.subtotal_price}
                      </span>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-[#8C8279]">未加購智能拼豆板（全員使用免費傳統板）</p>
              )}
            </div>

            {/* Total Amount */}
            {reservation.total_amount != null && (
              <div className="border-b border-dashed border-[#E5DFD7] pb-5 flex items-center justify-between">
                <h3 className="text-sm font-medium text-[#7A7067]">預計結帳總額</h3>
                <span className="text-lg font-bold text-[#8B5B43]">NT$ {reservation.total_amount}</span>
              </div>
            )}

            {/* Status */}
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

          {/* Action Buttons */}
          <div className="mt-6 flex flex-col sm:flex-row items-center justify-between gap-3">
            {reservation.status !== 'cancelled' && !isPast && gcalUrl ? (
              <a
                href={gcalUrl}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => {
                  if (typeof navigator !== 'undefined' && /Line/i.test(navigator.userAgent)) {
                    e.preventDefault();
                    window.location.href = gcalUrl;
                  }
                }}
                className="w-full sm:w-auto inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-full font-bold text-xs sm:text-sm bg-[#FAF7F2] border border-[#D5CFC9] text-[#6D5D52] hover:bg-[#F4EFE6] hover:text-[#8B5B43] transition-colors"
              >
                <CalendarPlus className="w-4 h-4 text-[#8B5B43]" />
                加入 Google 行事曆
              </a>
            ) : <div />}

            {reservation.status !== 'cancelled' && (
              <button 
                onClick={() => setShowCancelConfirm(true)}
                disabled={isPast}
                className={`w-full sm:w-auto px-6 py-2.5 rounded-full font-bold text-xs sm:text-sm transition-colors ${
                  isPast 
                    ? 'bg-[#F0EBE6] text-[#A8A19A] cursor-not-allowed border border-transparent' 
                    : 'border border-[#8B5B43] text-[#8B5B43] hover:bg-[#F9F7F3] bg-transparent'
                }`}
              >
                {isPast ? '已過期無法取消' : '取消此預約'}
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Two-step Cancellation Confirmation Modal */}
      {showCancelConfirm && (
        <div className="fixed inset-0 z-[120] flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={() => !isCancelling && setShowCancelConfirm(false)} />
          <div className="bg-white rounded-[24px] shadow-2xl w-full max-w-md overflow-hidden relative z-10 p-6 animate-in zoom-in-95 duration-200">
            <div className="w-12 h-12 rounded-full bg-red-50 text-[#B35D4F] flex items-center justify-center mx-auto mb-4">
              <AlertTriangle className="w-6 h-6" />
            </div>
            <h3 className="text-lg font-bold text-center text-[#2C241E] mb-2">
              確認要取消此筆預約嗎？
            </h3>
            <p className="text-xs sm:text-sm text-[#7A7067] leading-relaxed text-center mb-6">
              取消後系統將立即釋出該時段的手作座位與智能拼豆板庫存。若您之後仍想前往，歡迎隨時重新預約。
            </p>

            {cancelError && (
              <div className="p-3 bg-red-50 text-red-600 rounded-xl text-xs mb-4 font-medium text-center">
                {cancelError}
              </div>
            )}

            <div className="flex items-center gap-3">
              <button
                type="button"
                disabled={isCancelling}
                onClick={() => setShowCancelConfirm(false)}
                className="flex-1 py-3 px-4 rounded-xl font-bold text-sm bg-gray-100 text-gray-700 hover:bg-gray-200 transition-colors"
              >
                保留預約
              </button>
              <button
                type="button"
                disabled={isCancelling}
                onClick={executeCancelReservation}
                className="flex-1 py-3 px-4 rounded-xl font-bold text-sm bg-[#B35D4F] text-white hover:bg-[#9B4D40] transition-colors shadow-sm disabled:opacity-60 flex items-center justify-center gap-2"
              >
                {isCancelling ? '取消中...' : '確認取消'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
