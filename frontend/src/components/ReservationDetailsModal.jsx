import React from 'react';
import { useNavigate } from 'react-router-dom';
import { format } from 'date-fns';
import { X, CheckCircle2, XCircle, Trash2, Pencil, Check } from 'lucide-react';
import api from '../api/axios';
import ExtendTimeModal from './ExtendTimeModal';

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

export default function ReservationDetailsModal({ reservation, onClose, onUpdate, readOnly = false }) {
  const navigate = useNavigate();
  const [showExtendModal, setShowExtendModal] = React.useState(false);
  const [isEditingAmount, setIsEditingAmount] = React.useState(false);
  const [editAmountValue, setEditAmountValue] = React.useState('');

  if (!reservation) return null;

  const handleUpdateAttendance = async (attendance) => {
    try {
      await api.patch(`/reservations/${reservation.booking_ref}/attendance`, { attendance });
      if (onUpdate) onUpdate({ attendance });
    } catch (err) {
      console.error(err);
      alert('更新狀態失敗');
    }
  };

  const handleUpdatePayment = async (is_paid) => {
    try {
      await api.patch(`/reservations/admin/${reservation.booking_ref}/payment`, { is_paid });
      if (onUpdate) onUpdate({ is_paid });
    } catch (err) {
      console.error(err);
      alert('更新付費狀態失敗');
    }
  };

  const handleSaveAmount = async () => {
    if (!editAmountValue || isNaN(parseInt(editAmountValue))) {
      alert('請輸入有效的金額');
      return;
    }
    try {
      await api.patch(`/reservations/admin/${reservation.booking_ref}/amount`, { 
        total_amount: parseInt(editAmountValue) 
      });
      setIsEditingAmount(false);
      if (onUpdate) onUpdate({ total_amount: parseInt(editAmountValue), is_amount_manual: true });
    } catch (err) {
      console.error(err);
      alert('更新結帳金額失敗');
    }
  };

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

  const handleDeleteRecord = async () => {
    if (window.confirm('確定要永久刪除此筆訂單紀錄嗎？此操作無法復原。')) {
      try {
        await api.delete(`/reservations/${reservation.booking_ref}/record`);
        if (onUpdate) onUpdate();
        onClose();
      } catch (err) {
        alert(err.response?.data?.error || '刪除失敗');
      }
    }
  };

  return (
    <div className="fixed inset-0 z-[110] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-gray-900/40 backdrop-blur-sm" onClick={onClose} />
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-2xl overflow-hidden relative z-10 animate-in zoom-in-95 duration-200 flex flex-col max-h-[90vh]">
        <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between bg-gray-50/50">
          <h2 className="text-xl font-bold text-gray-800 flex items-center gap-2">
            訂單詳細資訊
          </h2>
          <button onClick={onClose} className="p-2 text-gray-400 hover:text-gray-600 rounded-full hover:bg-gray-200 transition-colors">
            <X className="w-5 h-5" />
          </button>
        </div>
        
        <div className="p-6 overflow-y-auto flex-1">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-8">
            <div className="space-y-4">
              <div>
                <h3 className="text-sm font-medium text-gray-500 mb-1">訂單編號</h3>
                <p className="text-sm text-gray-800 font-mono">{reservation.booking_ref}</p>
              </div>
              <div>
                <div className="flex items-center gap-3 mb-1">
                  <h3 className="text-sm font-medium text-gray-500">顧客姓名</h3>
                  {!readOnly && reservation.user_id && (
                    <button 
                      onClick={() => {
                        onClose();
                        navigate(`/admin/members?userId=${reservation.user_id}`);
                      }}
                      className="text-xs text-blue-600 hover:text-blue-700 bg-blue-50 hover:bg-blue-100 px-2 py-0.5 rounded-md font-medium transition-colors"
                    >
                      會員資料
                    </button>
                  )}
                </div>
                <p className="text-lg font-bold text-gray-900">{reservation.user?.name || '未設定'}</p>
              </div>
              <div>
                <h3 className="text-sm font-medium text-gray-500 mb-1">聯絡電話</h3>
                <p className="text-lg font-bold text-gray-900">{reservation.user?.phone || '未提供'}</p>
              </div>
            </div>
            
            <div className="space-y-4">
              <div>
                <div className="flex items-center gap-3 mb-1">
                  <h3 className="text-sm font-medium text-gray-500">預約時間</h3>
                  {!readOnly && reservation.status === 'confirmed' && (
                    <button 
                      onClick={() => setShowExtendModal(true)}
                      className="text-xs bg-indigo-50 text-indigo-600 px-2 py-0.5 rounded-md hover:bg-indigo-100 transition-colors font-medium flex items-center gap-1"
                    >
                      <span className="text-[10px]">➕</span> 現場加時
                    </button>
                  )}
                </div>
                <div className="text-lg font-bold text-gray-900">
                  {format(new Date(reservation.session_date || reservation.session?.session_date), 'yyyy/MM/dd')}
                  <div className="text-gray-500 text-sm font-normal mt-1 space-y-1">
                    {reservation.time_blocks ? (
                      reservation.time_blocks.map((b, i) => (
                        <div key={i}>{b.start_time} - {b.end_time}</div>
                      ))
                    ) : (
                      <div>
                        {reservation.start_time || reservation.session?.start_time} - {reservation.end_time || reservation.session?.end_time}
                      </div>
                    )}
                    <div className="text-gray-400 mt-1">
                      共 {reservation.session_count || 1} 小時
                    </div>
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
                  {reservation.is_walk_in && (
                    <span className="inline-flex items-center gap-1 text-xs font-bold text-orange-700 bg-orange-100 px-2 py-0.5 rounded-md">
                      🚶 現場預約
                    </span>
                  )}
                </div>
              </div>
              {reservation.total_amount != null && (
                <div>
                  <h3 className="text-sm font-medium text-gray-500 mb-1">結帳金額</h3>
                  <div className="flex items-center gap-2">
                    {isEditingAmount ? (
                      <div className="flex items-center gap-1">
                        <span className="text-lg font-bold text-gray-900">NT$</span>
                        <input 
                          type="number" 
                          className="w-24 px-2 py-1 border border-gray-300 rounded text-lg font-bold text-gray-900 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                          value={editAmountValue}
                          onChange={(e) => setEditAmountValue(e.target.value)}
                          autoFocus
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') handleSaveAmount();
                            if (e.key === 'Escape') setIsEditingAmount(false);
                          }}
                        />
                        <button onClick={handleSaveAmount} className="p-1 text-green-600 hover:bg-green-50 rounded">
                          <Check className="w-5 h-5" />
                        </button>
                        <button onClick={() => setIsEditingAmount(false)} className="p-1 text-gray-400 hover:bg-gray-100 rounded">
                          <X className="w-5 h-5" />
                        </button>
                      </div>
                    ) : (
                      <>
                        <p className="text-lg font-bold text-gray-900">NT$ {reservation.total_amount}</p>
                        {!readOnly && (
                          <button 
                            onClick={() => {
                              setEditAmountValue(reservation.total_amount.toString());
                              setIsEditingAmount(true);
                            }}
                            className="p-1 text-gray-400 hover:text-indigo-600 hover:bg-indigo-50 rounded transition-colors"
                            title="編輯結帳金額"
                          >
                            <Pencil className="w-4 h-4" />
                          </button>
                        )}
                      </>
                    )}

                    {!isEditingAmount && (
                      reservation.is_paid ? (
                        <span className="inline-flex items-center gap-1 text-xs font-bold text-yellow-700 bg-yellow-100 px-2 py-0.5 rounded-md border border-yellow-200">
                          💰 已結清
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-xs font-bold text-gray-500 bg-gray-100 px-2 py-0.5 rounded-md border border-gray-200">
                          ⏳ 未付款
                        </span>
                      )
                    )}
                  </div>
                </div>
              )}
              <div>
                <h3 className="text-sm font-medium text-gray-500 mb-1">當前狀態</h3>
                <div className="mt-1">
                  {(() => {
                    const rFormatted = {
                      ...reservation,
                      start_time: reservation.start_time || reservation.session?.start_time,
                      session_date: reservation.session_date || reservation.session?.session_date
                    };
                    const statusUI = getReservationStatusUI(rFormatted);
                    return (
                      <div className="flex items-center">
                        <span className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg font-medium ${statusUI.bgClass} ${statusUI.colorClass}`}>
                          {statusUI.icon} {statusUI.text}
                        </span>
                        {reservation.status === 'cancelled' && reservation.cancelled_at && (
                          <span className="ml-3 text-sm text-gray-500">
                            取消於 {format(new Date(reservation.cancelled_at), 'MM/dd HH:mm')} 
                            ({reservation.cancelled_by === 'admin' ? '管理員取消' : '顧客自行取消'})
                          </span>
                        )}
                        {reservation.is_force_split && (
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
          {(!readOnly || reservation.status !== 'cancelled') && (
            <div className="pt-6 border-t border-gray-100">
              <h3 className="text-sm font-medium text-gray-500 mb-3">訂單操作</h3>
              {reservation.status === 'cancelled' ? (
                <div className="flex items-center justify-between">
                  <p className="text-gray-500 text-sm">此訂單已取消。</p>
                  {!readOnly && (
                    <button 
                      onClick={handleDeleteRecord}
                      className="px-4 py-2 bg-red-50 text-red-600 hover:bg-red-100 rounded-xl font-medium transition-colors flex items-center gap-2 text-sm border border-red-100"
                    >
                      <Trash2 className="w-4 h-4" />
                      刪除紀錄
                    </button>
                  )}
                </div>
              ) : (
                <div className="flex flex-wrap gap-3">
                  {!readOnly && (
                    <>
                      <button 
                        onClick={() => handleUpdateAttendance('checked_in')}
                        disabled={reservation.attendance === 'checked_in'}
                        className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-300 text-white rounded-xl font-medium transition-colors flex items-center gap-2"
                      >
                        <CheckCircle2 className="w-4 h-4" />
                        完成報到
                      </button>
                      <button 
                        onClick={() => handleUpdateAttendance('no_show')}
                        disabled={reservation.attendance === 'no_show'}
                        className="px-4 py-2 bg-gray-600 hover:bg-gray-700 disabled:bg-gray-300 text-white rounded-xl font-medium transition-colors flex items-center gap-2"
                      >
                        <XCircle className="w-4 h-4" />
                        標記未到
                      </button>
                      <button 
                        onClick={() => handleUpdateAttendance(null)}
                        disabled={!reservation.attendance}
                        className="px-4 py-2 bg-white border border-gray-200 hover:bg-gray-50 disabled:bg-gray-50 disabled:text-gray-400 text-gray-700 rounded-xl font-medium transition-colors"
                      >
                        清除報到標記
                      </button>
                      <button 
                        onClick={() => handleUpdatePayment(!reservation.is_paid)}
                        className={`px-4 py-2 border rounded-xl font-medium transition-colors flex items-center gap-2 ${
                          reservation.is_paid 
                            ? 'bg-yellow-100 border-yellow-300 text-yellow-800 hover:bg-yellow-200' 
                            : 'bg-white border-yellow-300 text-yellow-600 hover:bg-yellow-50'
                        }`}
                      >
                        <span>💰</span>
                        {reservation.is_paid ? '取消付費標記' : '標記為已付費'}
                      </button>
                    </>
                  )}
                  
                  <div className="flex-1"></div>
                  
                  <button 
                    onClick={handleCancelReservation}
                    className="px-4 py-2 text-red-600 bg-red-50 hover:bg-red-100 rounded-xl font-medium transition-colors"
                  >
                    取消預約
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
      
      <ExtendTimeModal 
        isOpen={showExtendModal}
        onClose={() => setShowExtendModal(false)}
        reservation={reservation}
        onSuccess={() => {
          if (onUpdate) onUpdate();
        }}
      />
    </div>
  );
}
