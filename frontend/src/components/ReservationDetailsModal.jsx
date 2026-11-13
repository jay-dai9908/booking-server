import React, { Suspense, lazy, useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  X,
  CheckCircle2,
  XCircle,
  Trash2,
  Pencil,
  Check,
  Cpu,
  MessageCircle,
  Clock,
  Plus,
  CreditCard,
  MoreVertical
} from 'lucide-react';
import api from '../api/axios';
import ConfirmPanel from './admin/ConfirmPanel';
import ReasonChips from './admin/ReasonChips';
import StatusPill from './admin/StatusPill';
import ErrorBoundary from './common/ErrorBoundary';
import { formatBookingRef } from '../utils/admin/floorSelectors';
import { safeFormatDate, formatDateTime } from '../utils/format';
import { printJobOnThisDevice, isPrintGloballyEnabled } from '../utils/sunmiPrinter';

const ExtendTimeModal = lazy(() => import('./ExtendTimeModal'));
const EquipmentAddonModal = lazy(() => import('./EquipmentAddonModal'));
const CheckoutWorkbench = lazy(() => import('./admin/checkout/CheckoutWorkbench'));
const SendLineMessageModal = lazy(() => import('./SendLineMessageModal'));

export const getReservationStatusUI = (r) => {
  if (!r) return { text: '—', icon: null, colorClass: 'text-gray-400', bgClass: 'bg-gray-100' };
  if (r.status === 'cancelled') {
    return { text: '已取消', icon: <XCircle className="w-4 h-4"/>, colorClass: 'text-gray-400', bgClass: 'bg-gray-100' };
  }
  if (r.attendance === 'checked_in') {
    return { text: '已報到', icon: <CheckCircle2 className="w-4 h-4"/>, colorClass: 'text-sg-brown', bgClass: 'bg-sg-brown-soft' };
  }
  if (r.attendance === 'no_show') {
    return { text: '預約未到', icon: <XCircle className="w-4 h-4"/>, colorClass: 'text-red-500', bgClass: 'bg-red-50' };
  }

  const now = new Date();
  const dStr = typeof r.session_date === 'string' ? r.session_date.slice(0, 10) : '';
  let sessionDate = null;
  if (dStr && r.start_time) {
    sessionDate = new Date(`${dStr}T${r.start_time}:00+08:00`);
  } else if (r.session_date) {
    sessionDate = new Date(r.session_date);
  }

  if (sessionDate && !isNaN(sessionDate.getTime())) {
    const retainDate = new Date(sessionDate.getTime() + 15 * 60000);
    if (now > retainDate) {
      return { text: '預約未到', icon: <XCircle className="w-4 h-4"/>, colorClass: 'text-red-500', bgClass: 'bg-red-50' };
    }
  }

  return { text: '預約成功', icon: <CheckCircle2 className="w-4 h-4"/>, colorClass: 'text-green-600', bgClass: 'bg-green-50' };
};

export default function ReservationDetailsModal({ bookingRef, reservation: reservationProp, onClose, onUpdate, readOnly = false }) {
  const navigate = useNavigate();
  const ref = bookingRef || (typeof reservationProp === 'string' ? reservationProp : reservationProp?.booking_ref);
  const [reservation, setReservation] = useState(
    reservationProp && typeof reservationProp === 'object' && reservationProp.session_date ? reservationProp : null
  );
  const [loading, setLoading] = useState(!reservation && Boolean(ref));
  const [loadError, setLoadError] = useState(null);

  const [showExtendModal, setShowExtendModal] = useState(false);
  const [isEditingAmount, setIsEditingAmount] = useState(false);
  const [editAmountValue, setEditAmountValue] = useState('');
  const [showEquipmentModal, setShowEquipmentModal] = useState(false);
  const [showCheckoutModal, setShowCheckoutModal] = useState(false);
  const [showLineModal, setShowLineModal] = useState(false);
  const [showMoreMenu, setShowMoreMenu] = useState(false);
  const [showMarkUnpaidModal, setShowMarkUnpaidModal] = useState(false);
  const [unpaidReason, setUnpaidReason] = useState('收錯訂單');
  const [unpaidLoading, setUnpaidLoading] = useState(false);
  const [payments, setPayments] = useState([]);
  const [voidPaymentTarget, setVoidPaymentTarget] = useState(null);
  const [voidReason, setVoidReason] = useState('收錯付款方式');
  const [voidLoading, setVoidLoading] = useState(false);
  const [activePaymentMenuId, setActivePaymentMenuId] = useState(null);
  const [adminNoteInput, setAdminNoteInput] = useState(reservation?.admin_note || '');
  const [isSavingAdminNote, setIsSavingAdminNote] = useState(false);
  const [toastMsg, setToastMsg] = useState(null);
  const [confirmAction, setConfirmAction] = useState(null);
  const [forceCancelInput, setForceCancelInput] = useState('');

  const showToast = (text, isError = false) => {
    setToastMsg({ text, isError });
    setTimeout(() => setToastMsg(null), 3000);
  };

  const fetchBillingPayments = useCallback(() => {
    if (!ref) return;
    api
      .get(`/billing/${ref}`)
      .then(res => {
        setPayments(res.data?.payments || []);
      })
      .catch(err => {
        console.error('[ReservationDetailsModal] Error loading billing payments:', err);
        setPayments([]);
      });
  }, [ref]);

  const handleMarkUnpaid = async () => {
    if (!unpaidReason || !unpaidReason.trim()) return;
    try {
      setUnpaidLoading(true);
      await api.post(`/billing/${reservation.booking_ref}/mark-unpaid`, {
        reason: unpaidReason.trim()
      });
      setShowMarkUnpaidModal(false);
      setReservation(prev => ({
        ...prev,
        is_paid: false,
        billing_status: 'unpaid'
      }));
      showToast('已標記未結帳');
      window.dispatchEvent(new CustomEvent('admin-data-updated'));
      if (onUpdate) {
        onUpdate({ is_paid: false, billing_status: 'unpaid' });
      }
      fetchDetails();
      fetchBillingPayments();
    } catch (err) {
      console.error('[handleMarkUnpaid] Error:', err);
      showToast(err.response?.data?.error || err.response?.data?.message || '標記未結帳失敗', true);
    } finally {
      setUnpaidLoading(false);
    }
  };

  const handleReprintPayment = async (pay) => {
    try {
      const res = await api.post('/print/jobs', {
        type: 'receipt',
        payment_id: pay.id,
        booking_ref: reservation?.booking_ref || ref,
        is_reprint: true
      });
      if (res.data?.job) {
        await printJobOnThisDevice(res.data.job);
      }
      showToast('補印收據已送出');
    } catch (err) {
      showToast(err.response?.data?.error || err.response?.data?.message || '補印失敗', true);
    }
  };

  const handleConfirmVoid = async () => {
    if (!voidPaymentTarget) return;
    try {
      setVoidLoading(true);
      await api.post(`/billing/payments/${voidPaymentTarget.id}/void`, {
        reason: voidReason
      });
      showToast(`已作廢收款 ${voidPaymentTarget.payment_no}`);
      setVoidPaymentTarget(null);
      fetchBillingPayments();
      fetchDetails();
      if (onUpdate) onUpdate();
      window.dispatchEvent(new CustomEvent('admin-data-updated'));
    } catch (err) {
      showToast(err.response?.data?.error || err.response?.data?.message || '作廢失敗', true);
    } finally {
      setVoidLoading(false);
    }
  };

  const getKindBadge = (pay) => {
    if (pay.method === 'pass' || pay.pass_json || pay.kind === 'pass') {
      return { label: '卡券', bg: 'bg-purple-50 text-purple-700 border-purple-200' };
    }
    if (pay.kind === 'refund') {
      return { label: '退款', bg: 'bg-rose-50 text-rose-700 border-rose-200' };
    }
    if (pay.kind === 'supplement') {
      return { label: '補收', bg: 'bg-sky-50 text-sky-700 border-sky-200' };
    }
    if (pay.kind === 'waive') {
      return { label: '免收', bg: 'bg-gray-100 text-gray-700 border-gray-200' };
    }
    return { label: '收款', bg: 'bg-emerald-50 text-emerald-700 border-emerald-200' };
  };

  const getMethodName = (m) => {
    const map = {
      cash: '現金',
      line_pay: 'LINE Pay',
      linepay: 'LINE Pay',
      transfer: '銀行轉帳',
      pass: '卡券',
      jkopay: '街口支付',
      card: '信用卡',
      other: '其他',
      none: '無'
    };
    return map[m] || m || '現金';
  };

  const onUpdateRef = useRef(onUpdate);
  useEffect(() => {
    onUpdateRef.current = onUpdate;
  });

  const fetchDetails = useCallback(() => {
    if (!ref) return;
    setLoading(true);
    setLoadError(null);
    api
      .get(`/reservations/admin/${ref}/details`)
      .then(res => {
        if (res.data) {
          setReservation(res.data);
          setAdminNoteInput(res.data.admin_note || '');
        }
      })
      .catch(err => {
        console.error('[ReservationDetailsModal] Error loading details:', err);
        setLoadError(err.response?.data?.error || err.response?.data?.message || '讀取預約資料失敗');
      })
      .finally(() => {
        setLoading(false);
      });
  }, [ref]);

  useEffect(() => {
    if (!ref) {
      setReservation(null);
      setPayments([]);
      setLoading(false);
      return;
    }
    fetchDetails();
    fetchBillingPayments();
  }, [ref, fetchDetails, fetchBillingPayments]);

  useEffect(() => {
    if (reservation?.admin_note !== undefined) {
      setAdminNoteInput(reservation.admin_note || '');
    }
  }, [reservation?.admin_note]);

  if (!ref && !reservation) return null;


  const handleSaveAdminNote = async () => {
    setIsSavingAdminNote(true);
    try {
      const res = await api.patch(`/reservations/${reservation.booking_ref}/notes`, {
        admin_note: adminNoteInput.trim() || null
      });
      if (onUpdate) {
        onUpdate({ admin_note: res.data?.admin_note ?? (adminNoteInput.trim() || null) });
      }
      window.dispatchEvent(new CustomEvent('admin-data-updated'));
      showToast('內部備註已儲存');
    } catch (err) {
      console.error(err);
      showToast('儲存內部備註失敗', true);
    } finally {
      setIsSavingAdminNote(false);
    }
  };

  const handleUpdateAttendance = async (attendance) => {
    try {
      const res = await api.patch(`/reservations/${reservation.booking_ref}/attendance`, { attendance });
      if (onUpdate) onUpdate({ 
        attendance,
        checked_in_at: res.data?.checked_in_at 
      });
      window.dispatchEvent(new CustomEvent('admin-data-updated'));
    } catch (err) {
      console.error(err);
      showToast('更新狀態失敗', true);
    }
  };

  const handleUpdatePayment = async (is_paid) => {
    try {
      await api.patch(`/reservations/admin/${reservation.booking_ref}/payment`, { is_paid });
      if (onUpdate) onUpdate({ is_paid });
      window.dispatchEvent(new CustomEvent('admin-data-updated'));
    } catch (err) {
      console.error(err);
      showToast('更新付費狀態失敗', true);
    }
  };

  const handleSaveAmount = async () => {
    if (!editAmountValue || isNaN(parseInt(editAmountValue))) {
      showToast('請輸入有效的金額', true);
      return;
    }
    try {
      const amount = parseInt(editAmountValue);
      await api.patch(`/reservations/admin/${reservation.booking_ref}/amount`, { 
        total_amount: amount 
      });
      
      // Auto-mark as paid when manually editing amount
      await api.patch(`/reservations/admin/${reservation.booking_ref}/payment`, { is_paid: true });
      
      setIsEditingAmount(false);
      if (onUpdate) {
        onUpdate({ 
          total_amount: amount, 
          is_amount_manual: true,
          is_paid: true 
        });
      }
      showToast('結帳金額已更新');
    } catch (err) {
      console.error(err);
      showToast('更新結帳金額失敗', true);
    }
  };

  const handleCancelReservation = () => {
    if (reservation.is_paid) {
      setForceCancelInput('');
      setConfirmAction({
        title: '注意：此預約已完成付款結帳',
        message: '若取消預約，當日結帳營收將產生異動。請在下方輸入「確認取消」以完成強制取消：',
        danger: true,
        type: 'force_cancel_paid',
        onConfirm: async () => {
          if (forceCancelInput.trim() !== '確認取消') {
            showToast('輸入不符，已中止取消操作。', true);
            return;
          }
          try {
            await api.delete(`/reservations/${reservation.booking_ref}`, {
              data: { confirmPaidCancel: true }
            });
            if (onUpdate) onUpdate();
            onClose();
          } catch (err) {
            showToast(err.response?.data?.error || '取消失敗', true);
          }
        }
      });
    } else {
      setConfirmAction({
        title: '取消預約',
        message: '確定要取消此預約嗎？',
        danger: true,
        onConfirm: async () => {
          try {
            await api.delete(`/reservations/${reservation.booking_ref}`, {
              data: { confirmPaidCancel: false }
            });
            if (onUpdate) onUpdate();
            onClose();
          } catch (err) {
            showToast(err.response?.data?.error || '取消失敗', true);
          }
        }
      });
    }
  };

  const handleDeleteRecord = () => {
    setConfirmAction({
      title: '刪除訂單紀錄',
      message: '確定要永久刪除此筆訂單紀錄嗎？此操作無法復原。',
      danger: true,
      onConfirm: async () => {
        try {
          await api.delete(`/reservations/${reservation.booking_ref}/record`);
          if (onUpdate) onUpdate();
          onClose();
        } catch (err) {
          showToast(err.response?.data?.error || '刪除失敗', true);
        }
      }
    });
  };

  return (
    <div className="fixed inset-0 z-[110] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-gray-900/40 backdrop-blur-sm" onClick={onClose} />
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-2xl overflow-hidden relative z-10 animate-in zoom-in-95 duration-200 flex flex-col max-h-[90vh]">
        <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between bg-gray-50/50">
          <h2 className="text-xl font-bold text-gray-800 flex items-center gap-2">
            訂單詳細資訊
          </h2>
          <div className="flex items-center gap-2">
            {!readOnly && (
              <div className="relative">
                <button
                  type="button"
                  data-testid="reservation-more-btn"
                  onClick={() => setShowMoreMenu(prev => !prev)}
                  className="p-2 text-gray-400 hover:text-gray-600 rounded-full hover:bg-gray-200 transition-colors"
                  title="更多操作"
                  aria-label="更多操作"
                >
                  <MoreVertical className="w-5 h-5" />
                </button>
                {showMoreMenu && (
                  <div
                    className="absolute right-0 top-full mt-1 w-36 bg-white border border-gray-200 rounded-2xl shadow-xl z-30 py-1 text-sm animate-in fade-in"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <button
                      type="button"
                      data-testid="reservation-mark-unpaid-btn"
                      onClick={() => {
                        setShowMoreMenu(false);
                        setUnpaidReason('收錯訂單');
                        setShowMarkUnpaidModal(true);
                      }}
                      className="w-full text-left px-3 py-2 hover:bg-gray-50 text-red-600 font-bold"
                    >
                      標記未結帳
                    </button>
                  </div>
                )}
              </div>
            )}
            <button onClick={onClose} className="p-2 text-gray-400 hover:text-gray-600 rounded-full hover:bg-gray-200 transition-colors">
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>
        
        <ErrorBoundary>
          {loading && !reservation ? (
            <div className="p-12 flex flex-col items-center justify-center space-y-3">
              <div className="w-8 h-8 border-2 border-sg-brown border-t-transparent rounded-full animate-spin" />
              <span className="text-[13px] text-sg-muted">載入訂單資料中...</span>
            </div>
          ) : loadError && !reservation ? (
            <div className="p-12 flex flex-col items-center justify-center space-y-3 text-center">
              <p className="text-[14px] text-sg-danger font-bold">{loadError}</p>
              <button
                type="button"
                onClick={fetchDetails}
                className="px-4 py-2 rounded-xl bg-sg-brown text-white text-[13px] font-bold"
              >
                重試
              </button>
            </div>
          ) : (
            <div className="p-6 overflow-y-auto flex-1">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-8">
                <div className="space-y-4">
                  <div>
                    <h3 className="text-sm font-medium text-gray-500 mb-1">訂單編號</h3>
                    <p className="text-sm text-gray-800 font-mono font-bold">{formatBookingRef(reservation.booking_ref)}</p>
                  </div>
                  <div>
                    <div className="flex items-center gap-2 mb-1">
                      <h3 className="text-sm font-medium text-gray-500">顧客姓名</h3>
                      {!readOnly && reservation.user_id && (
                        <button 
                          onClick={() => {
                            onClose();
                            navigate(`/admin/members?userId=${reservation.user_id}`);
                          }}
                          className="text-xs text-sg-brown hover:text-sg-brown-hover bg-sg-brown-soft hover:bg-sg-line px-2 py-0.5 rounded-md font-bold transition-colors"
                        >
                          會員資料
                        </button>
                      )}
                      {!readOnly && reservation.user && !reservation.user.line_user_id?.startsWith('manual_') && (
                        <button 
                          type="button"
                          onClick={() => setShowLineModal(true)}
                          className="inline-flex items-center gap-1 text-xs font-bold text-white bg-[#06C755] hover:bg-[#05b34c] px-2 py-0.5 rounded-md transition-all shadow-xs"
                          title="發送 LINE 提醒至顧客手機"
                        >
                          <MessageCircle className="w-3.5 h-3.5 fill-current" />
                          發送 LINE 提醒
                        </button>
                      )}
                    </div>
                    <p className="text-lg font-bold text-gray-900">{reservation.user?.name || '未設定'}</p>
                  </div>
                  <div>
                    <h3 className="text-sm font-medium text-gray-500 mb-1">聯絡電話</h3>
                    <p className="text-lg font-bold text-gray-900">{reservation.user?.phone || '未提供'}</p>
                  </div>
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
                          <div className="flex items-center flex-wrap gap-2">
                            <span className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg font-medium ${statusUI.bgClass} ${statusUI.colorClass}`}>
                              {statusUI.icon} {statusUI.text}
                            </span>
                            <StatusPill data-testid="reservation-status-pill" status={reservation.billing_status || (reservation.is_paid ? 'paid' : 'unpaid')} />
                            {reservation.attendance === 'checked_in' && (
                              <span className="inline-flex items-center gap-1 text-xs sm:text-sm font-bold text-sg-brown bg-sg-brown-soft px-2.5 py-1 rounded-lg border border-sg-line">
                                <Clock className="w-3.5 h-3.5" />
                                報到時間：{reservation.checked_in_at ? formatDateTime(reservation.checked_in_at, 'MM/dd HH:mm') : '已完成'}
                              </span>
                            )}
                            {reservation.status === 'cancelled' && reservation.cancelled_at && (
                              <span className="text-xs sm:text-sm text-gray-500">
                                取消於 {formatDateTime(reservation.cancelled_at, 'MM/dd HH:mm')} 
                                ({reservation.cancelled_by === 'admin' ? '管理員取消' : '顧客自行取消'})
                              </span>
                            )}
                            {reservation.is_force_split && (
                              <span className="inline-flex items-center px-2 py-1 bg-amber-50 text-amber-600 border border-amber-200 rounded-md text-xs font-bold tracking-wide">
                                顧客同意拆桌
                              </span>
                            )}
                          </div>
                        );
                      })()}
                    </div>
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
                          <Plus className="w-3 h-3" />
                          現場加時
                        </button>
                      )}
                    </div>
                    <div className="text-lg font-bold text-gray-900">
                      {safeFormatDate(reservation.session_date || reservation.session?.session_date, 'yyyy/MM/dd')}
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
                    <span className="inline-flex items-center gap-1 text-xs font-bold text-sg-brown bg-sg-brown-soft border border-sg-line px-2 py-0.5 rounded-md">
                      不限時
                    </span>
                  )}
                  {reservation.is_walk_in && (
                    <span className="inline-flex items-center gap-1 text-xs font-bold text-orange-700 bg-orange-100 px-2 py-0.5 rounded-md">
                      現場預約
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
                          已結清 {reservation.payment_method === 'line_pay' ? '(LINE Pay)' : reservation.payment_method === 'transfer' ? '(轉帳)' : '(現金)'}
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-xs font-bold text-gray-500 bg-gray-100 px-2 py-0.5 rounded-md border border-gray-200">
                          未付款
                        </span>
                      )
                    )}
                  </div>
                  {(reservation.promo_code || reservation.discount_amount > 0 || reservation.addons_amount > 0) && (
                    <div className="mt-1.5 flex flex-wrap gap-1.5 text-xs">
                      {reservation.addons_amount > 0 && (
                        <span className="px-2 py-0.5 rounded bg-pink-50 text-pink-700 border border-pink-200 font-bold">
                          吊飾/加購 +${reservation.addons_amount}
                        </span>
                      )}
                      {reservation.discount_amount > 0 && (
                        <span className="px-2 py-0.5 rounded bg-rose-50 text-rose-700 border border-rose-200 font-bold">
                          優惠折抵 ({reservation.promo_code || '手動'}) -${reservation.discount_amount}
                        </span>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* Customer Note & Admin Internal Note Section */}
          <div className="mb-6 grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="bg-indigo-50/60 border border-indigo-200 rounded-2xl p-4">
              <h3 className="text-xs font-bold text-indigo-800 mb-1.5 flex items-center gap-1.5">
                顧客預約備註
              </h3>
              {reservation.customer_note ? (
                <p className="text-sm font-bold text-indigo-950 whitespace-pre-wrap break-words">
                  {reservation.customer_note}
                </p>
              ) : (
                <p className="text-xs text-gray-400">顧客未填寫備註</p>
              )}
            </div>

            <div className="bg-amber-50/70 border border-amber-200 rounded-2xl p-4">
              <div className="flex items-center justify-between mb-1.5">
                <h3 className="text-xs font-bold text-amber-900 flex items-center gap-1.5">
                  店家當日內部備註（僅店員可見）
                </h3>
                {!readOnly && (
                  <button
                    type="button"
                    disabled={isSavingAdminNote}
                    onClick={handleSaveAdminNote}
                    className="text-xs bg-amber-600 hover:bg-amber-700 disabled:opacity-50 text-white px-2.5 py-1 rounded-lg font-bold transition-colors"
                  >
                    {isSavingAdminNote ? '儲存中...' : '儲存備註'}
                  </button>
                )}
              </div>
              {readOnly ? (
                <p className="text-sm text-amber-950">{reservation.admin_note || '無內部備註'}</p>
              ) : (
                <input
                  type="text"
                  value={adminNoteInput}
                  onChange={(e) => setAdminNoteInput(e.target.value)}
                  placeholder="輸入當日交接備註（如：寄放作品、指定靠窗、已電話確認...）"
                  className="w-full px-3 py-1.5 text-xs sm:text-sm bg-white border border-amber-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-amber-500 text-gray-800"
                />
              )}
            </div>
          </div>

          {/* Smart Pegboard Section (Full width across the modal) */}
          <div className="mb-8 bg-[#FAF7F2] border border-[#E8DEC8] rounded-2xl p-4">
            <div className="flex items-center justify-between mb-2.5">
              <h3 className="text-sm font-bold text-[#8B5B43] flex items-center gap-1.5 whitespace-nowrap">
                智能拼豆板租賃明細
              </h3>
              {!readOnly && reservation.status !== 'cancelled' && (
                <button
                  type="button"
                  onClick={() => setShowEquipmentModal(true)}
                  className="text-xs bg-[#8B5B43] hover:bg-[#724a35] text-white px-3 py-1.5 rounded-lg transition-colors font-medium flex items-center gap-1 shadow-xs whitespace-nowrap"
                >
                  {reservation.equipments && reservation.equipments.length > 0 ? (
                    <>調整智能板</>
                  ) : (
                    <>加購/補登智能板</>
                  )}
                </button>
              )}
            </div>

            {reservation.equipments && reservation.equipments.length > 0 ? (
              <div className="space-y-2">
                {reservation.equipments.map((eq, i) => {
                  let timeSpan = '';
                  let hours = eq.rental_hours || 0;
                  if (Array.isArray(eq.covered_sessions) && eq.covered_sessions.length > 0) {
                    const first = eq.covered_sessions[0];
                    const last = eq.covered_sessions[eq.covered_sessions.length - 1];
                    const st = first.includes('-') ? first.split('-')[0] : first;
                    const et = last.includes('-') ? last.split('-')[1] : last;
                    timeSpan = `${st} 到 ${et}`;
                    hours = eq.covered_sessions.length;
                  }
                  let discountNote = '';
                  if (hours >= 4) {
                    const freeH = Math.floor(hours / 4);
                    const chargeable = hours - freeH;
                    discountNote = `（買三送一，以 ${chargeable} 小時計）`;
                  }
                  return (
                    <div key={i} className="flex items-center justify-between bg-white px-3.5 py-2.5 rounded-xl border border-[#E8DEC8] text-sm">
                      <span className="font-bold text-gray-800">
                        {eq.equipment_name_snapshot} × {eq.quantity} 台
                        {timeSpan && <span className="font-normal text-gray-600 ml-2">· {timeSpan} · {hours} 小時</span>}
                      </span>
                      <span className="text-xs font-bold text-[#8B5B43]">
                        加購小計: NT$ {eq.subtotal_price} {discountNote && <span className="font-normal text-gray-500">{discountNote}</span>}
                      </span>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="flex items-center justify-between bg-white/80 px-3.5 py-2.5 rounded-xl border border-dashed border-[#DED7CE] text-xs sm:text-sm text-gray-600">
                <span>此訂單尚未租賃智能拼豆板（全員使用免費基本拼豆板）</span>
                {!readOnly && reservation.status !== 'cancelled' && (
                  <button
                    type="button"
                    onClick={() => setShowEquipmentModal(true)}
                    className="text-[#8B5B43] hover:underline font-bold text-xs sm:text-sm flex items-center gap-0.5 whitespace-nowrap ml-2"
                  >
                    點此加租 &rarr;
                  </button>
                )}
              </div>
            )}
          </div>

          {/* 收款紀錄區塊 (Round 15 Item 1) */}
          <div className="mb-8 bg-white border border-gray-200 rounded-2xl p-4 shadow-2xs">
            <h3 className="text-sm font-bold text-gray-800 mb-3 flex items-center justify-between">
              <span>收款紀錄</span>
              {payments.length > 0 && (
                <span className="text-xs text-gray-400 font-normal">共 {payments.length} 筆</span>
              )}
            </h3>
            {payments.length === 0 ? (
              <p className="text-xs sm:text-sm text-gray-400 py-3 text-center">還沒有收款</p>
            ) : (
              <div className="divide-y divide-gray-100">
                {payments.map((p) => {
                  const isVoided = p.status === 'voided';
                  const kindBadge = getKindBadge(p);
                  const timeStr = p.created_at
                    ? new Date(p.created_at).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Taipei' })
                    : '—';
                  const personStr = (p.person_nos && p.person_nos.length > 0)
                    ? `第 ${p.person_nos.join('、')} 位`
                    : '整單';
                  const amtStr = p.kind === 'refund'
                    ? `-NT$${Number(p.amount || 0).toLocaleString('en-US')}`
                    : `NT$${Number(p.amount || 0).toLocaleString('en-US')}`;

                  return (
                    <div
                      key={p.id}
                      className={`py-2.5 flex items-center justify-between text-xs sm:text-sm transition-colors ${
                        isVoided ? 'opacity-50 line-through text-gray-400' : 'text-gray-800'
                      }`}
                    >
                      <div className="flex items-center gap-2 sm:gap-3 flex-wrap">
                        <span className="font-mono text-gray-500">{timeStr}</span>
                        <span className="font-medium text-gray-600">{personStr}</span>
                        <span className={`px-2 py-0.5 rounded-md border text-[11px] font-bold ${kindBadge.bg}`}>
                          {kindBadge.label}
                        </span>
                        <span className="text-gray-600">{getMethodName(p.method)}</span>
                        <span className="font-bold font-num">{amtStr}</span>
                        {isVoided && (
                          <span className="text-[10px] text-rose-500 font-bold no-underline">
                            (已作廢)
                          </span>
                        )}
                      </div>

                      {!readOnly && (
                        <div className="relative shrink-0 ml-2">
                          <button
                            type="button"
                            onClick={() => setActivePaymentMenuId(activePaymentMenuId === p.id ? null : p.id)}
                            className="p-1.5 text-gray-400 hover:text-gray-600 rounded-lg hover:bg-gray-100 transition-colors"
                            title="更多操作"
                          >
                            <MoreVertical className="w-4 h-4" />
                          </button>
                          {activePaymentMenuId === p.id && (
                            <div
                              className="absolute right-0 top-full mt-1 w-28 bg-white border border-gray-200 rounded-xl shadow-lg z-30 py-1 text-xs"
                              onClick={(e) => e.stopPropagation()}
                            >
                              {isPrintGloballyEnabled() && (
                                <button
                                  type="button"
                                  onClick={() => {
                                    setActivePaymentMenuId(null);
                                    handleReprintPayment(p);
                                  }}
                                  className="w-full text-left px-3 py-1.5 hover:bg-gray-50 text-gray-700 font-medium"
                                >
                                  補印
                                </button>
                              )}
                              {!isVoided && (
                                <button
                                  type="button"
                                  onClick={() => {
                                    setActivePaymentMenuId(null);
                                    setVoidPaymentTarget(p);
                                    setVoidReason('收錯付款方式');
                                  }}
                                  className="w-full text-left px-3 py-1.5 hover:bg-gray-50 text-red-600 font-bold"
                                >
                                  作廢
                                </button>
                              )}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {toastMsg && (
            <div className={`mb-4 p-3 rounded-xl text-xs font-bold border ${
              toastMsg.isError ? 'bg-rose-50 text-rose-800 border-rose-200' : 'bg-emerald-50 text-emerald-800 border-emerald-200'
            }`}>
              {toastMsg.text}
            </div>
          )}

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
                        className="px-4 py-2 bg-sg-brown hover:bg-sg-brown-hover disabled:opacity-50 text-white rounded-xl font-bold transition-colors flex items-center gap-2"
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
                        type="button"
                        onClick={() => setShowCheckoutModal(true)}
                        className={`px-4 py-2 rounded-xl font-bold transition-all flex items-center gap-2 shadow-sm ${
                          reservation.is_paid 
                            ? 'bg-emerald-50 border border-emerald-300 text-emerald-800 hover:bg-emerald-100' 
                            : 'bg-sg-brown hover:bg-sg-brown-hover text-white'
                        }`}
                      >
                        <CreditCard className="w-4 h-4" />
                        {reservation.is_paid 
                          ? (isPrintGloballyEnabled() ? '結帳明細 / 補印收據' : '結帳明細') 
                          : (isPrintGloballyEnabled() ? '前往結帳 (拆帳 / POS印單)' : '前往結帳 (拆帳)')}
                      </button>
                      {reservation.is_paid && (
                        <button 
                          type="button"
                          onClick={() => {
                            setUnpaidReason('收錯訂單');
                            setShowMarkUnpaidModal(true);
                          }}
                          className="px-3 py-2 bg-white border border-gray-200 text-gray-500 hover:bg-gray-50 rounded-xl text-xs font-medium transition-colors"
                        >
                          標記未結帳
                        </button>
                      )}
                      <button 
                        type="button"
                        onClick={() => setShowEquipmentModal(true)}
                        className="px-4 py-2 bg-amber-50 hover:bg-amber-100 border border-amber-300 text-amber-900 rounded-xl font-medium transition-colors flex items-center gap-1.5"
                      >
                        <Cpu className="w-4 h-4 text-amber-800" />
                        {reservation.equipments && reservation.equipments.length > 0 ? '調整智能板' : '加購智能板'}
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
      )}
    </ErrorBoundary>
  </div>


      
      <Suspense fallback={null}>
        {showExtendModal && (
          <ExtendTimeModal 
            isOpen={showExtendModal}
            onClose={() => setShowExtendModal(false)}
            reservation={reservation}
            onSuccess={async () => {
              try {
                const res = await api.get(`/reservations/admin/${reservation.booking_ref}/details`);
                if (onUpdate) onUpdate(res.data);
              } catch (err) {
                if (onUpdate) onUpdate();
              }
            }}
          />
        )}

        {showEquipmentModal && (
          <EquipmentAddonModal 
            isOpen={showEquipmentModal}
            onClose={() => setShowEquipmentModal(false)}
            reservation={reservation}
            isAdmin={true}
            onSuccess={async (updatedData) => {
              try {
                const res = await api.get(`/reservations/admin/${reservation.booking_ref}/details`);
                if (onUpdate) onUpdate(res.data);
              } catch (e) {
                if (updatedData && onUpdate) {
                  onUpdate({
                    equipments: updatedData.equipments,
                    total_amount: updatedData.total_amount
                  });
                } else if (onUpdate) {
                  onUpdate();
                }
              }
            }}
          />
        )}
        {showCheckoutModal && (
          <CheckoutWorkbench
            isOpen={showCheckoutModal}
            onClose={() => setShowCheckoutModal(false)}
            bookingRef={reservation.booking_ref}
            onPaymentSuccess={async () => {
              try {
                const res = await api.get(`/reservations/admin/${reservation.booking_ref}/details`);
                if (onUpdate) onUpdate(res.data);
              } catch (e) {
                if (onUpdate) onUpdate();
              }
            }}
          />
        )}
        {showLineModal && (
          <SendLineMessageModal
            isOpen={showLineModal}
            onClose={() => setShowLineModal(false)}
            user={reservation.user}
            reservation={reservation}
          />
        )}
      </Suspense>

      {confirmAction && (
        <ConfirmPanel
          isOpen={!!confirmAction}
          title={confirmAction.title}
          message={confirmAction.message}
          danger={confirmAction.danger}
          onClose={() => setConfirmAction(null)}
          onConfirm={async () => {
            const act = confirmAction.onConfirm;
            setConfirmAction(null);
            if (act) await act();
          }}
        >
          {confirmAction.type === 'force_cancel_paid' && (
            <input
              type="text"
              autoFocus
              value={forceCancelInput}
              onChange={(e) => setForceCancelInput(e.target.value)}
              placeholder="請輸入「確認取消」"
              className="w-full px-3 py-2 border border-rose-300 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-rose-500 font-bold"
            />
          )}
        </ConfirmPanel>
      )}

      {/* Mark Unpaid Modal */}
      <ConfirmPanel
        isOpen={showMarkUnpaidModal}
        onClose={() => setShowMarkUnpaidModal(false)}
        onConfirm={handleMarkUnpaid}
        title="標記未結帳？"
        message="將作廢此預約的所有收款紀錄並重設為未結帳狀態，此動作將記入帳務異動紀錄。"
        danger={true}
        loading={unpaidLoading}
        disabled={!unpaidReason?.trim()}
      >
        <ReasonChips
          presets={['收錯訂單']}
          value={unpaidReason}
          onChange={setUnpaidReason}
          label="原因"
          required={true}
        />
      </ConfirmPanel>

      {/* Void Payment Modal */}
      {voidPaymentTarget && (
        <ConfirmPanel
          isOpen={Boolean(voidPaymentTarget)}
          onClose={() => setVoidPaymentTarget(null)}
          onConfirm={handleConfirmVoid}
          title="作廢這筆收款？"
          message={`確定要作廢 ${voidPaymentTarget?.payment_no}（NT$${voidPaymentTarget?.amount}）？作廢會記到帳務異動紀錄，資料不會刪除。`}
          danger={true}
          loading={voidLoading}
        >
          <ReasonChips
            presets={['收錯付款方式', '收錯金額', '客人改用其他方式', '其他']}
            value={voidReason}
            onChange={setVoidReason}
          />
        </ConfirmPanel>
      )}
    </div>
  );
}
