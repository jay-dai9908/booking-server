import React, { useState, useEffect, useRef } from 'react';
import { format } from 'date-fns';
import {
  Search,
  X,
  QrCode,
  CalendarClock,
  Ticket,
  ShoppingBag,
  CheckCircle2,
  CreditCard,
  PackageCheck,
  Sparkles,
  ExternalLink
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import api from '../api/axios';
import ReservationDetailsModal, { getReservationStatusUI } from './ReservationDetailsModal';
import { formatBookingRef } from './CustomerReservationDetailsModal';

export default function QuickPosLookupModal({ isOpen, onClose, onDataChanged }) {
  const navigate = useNavigate();
  const inputRef = useRef(null);

  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState({ reservations: [], passes: [], shop_orders: [] });
  const [toastMsg, setToastMsg] = useState(null);
  const [selectedReservationDetail, setSelectedReservationDetail] = useState(null);
  const [processingId, setProcessingId] = useState(null);

  useEffect(() => {
    if (isOpen) {
      setTimeout(() => {
        inputRef.current?.focus();
      }, 80);
    } else {
      setQuery('');
      setResults({ reservations: [], passes: [], shop_orders: [] });
      setSelectedReservationDetail(null);
    }
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const trimmed = query.trim();
    if (!trimmed) {
      setResults({ reservations: [], passes: [], shop_orders: [] });
      return;
    }

    const timer = setTimeout(() => {
      runLookup(trimmed);
    }, 220);

    return () => clearTimeout(timer);
  }, [query, isOpen]);

  if (!isOpen) return null;

  const showToast = (msg, isError = false) => {
    setToastMsg({ text: msg, isError });
    setTimeout(() => setToastMsg(null), 3200);
  };

  const runLookup = async (qText = query.trim()) => {
    if (!qText) return;
    setLoading(true);
    try {
      const res = await api.get(`/reservations/admin/quick-lookup?q=${encodeURIComponent(qText)}`);
      setResults({
        reservations: res.data?.reservations || [],
        passes: res.data?.passes || [],
        shop_orders: res.data?.shop_orders || []
      });
    } catch (err) {
      console.error('Quick lookup error:', err);
    } finally {
      setLoading(false);
    }
  };

  // 1-Click Check-in for Reservation
  const handleQuickCheckIn = async (bookingRef) => {
    setProcessingId(`checkin-${bookingRef}`);
    try {
      await api.patch(`/reservations/${bookingRef}/attendance`, { attendance: 'checked_in' });
      showToast('✅ 已完成預約報到！');
      await runLookup();
      if (onDataChanged) onDataChanged();
    } catch (err) {
      showToast(err.response?.data?.error || '報到失敗', true);
    } finally {
      setProcessingId(null);
    }
  };

  // Open full ReservationDetailsModal (with POS Checkout)
  const handleOpenReservationModal = async (bookingRef) => {
    try {
      const res = await api.get(`/reservations/admin/${bookingRef}/details`);
      setSelectedReservationDetail(res.data);
    } catch (err) {
      showToast('無法載入訂單詳細資訊', true);
    }
  };

  // 1-Click Redeem Pass
  const handleQuickRedeemPass = async (pass) => {
    if (!window.confirm(`確定要核銷「${pass.user?.name || ''}」的【${pass.plan_name_snapshot}】(#${pass.pass_code}) 嗎？`)) {
      return;
    }
    setProcessingId(`pass-${pass.id}`);
    try {
      const res = await api.post('/passes/admin/redeem', {
        pass_code: pass.pass_code,
        deduct_amount: 1,
        note: '櫃檯萬用查詢台快速核銷'
      });
      showToast(res.data?.message || '🎟️ 卡券核銷成功！');
      await runLookup();
      if (onDataChanged) onDataChanged();
    } catch (err) {
      showToast(err.response?.data?.error || '卡券核銷失敗', true);
    } finally {
      setProcessingId(null);
    }
  };

  // 1-Click Mark Shop Order Picked Up
  const handleQuickPickupShopOrder = async (order) => {
    if (
      !window.confirm(
        `確定顧客「${order.user?.name || ''}」已完成現場取貨 (#${order.order_ref}) 嗎？\n${
          order.balance_amount > 0 ? `⚠️ 請確認現場已收取尾款 NT$ ${order.balance_amount}！\n` : ''
        }取貨完成後若含有套裝贈品卡將自動發放至會員帳號！`
      )
    ) {
      return;
    }
    setProcessingId(`shop-${order.id}`);
    try {
      await api.patch(`/shop/admin/orders/${order.id}`, {
        order_status: 'picked_up'
      });
      showToast('📦 已標記取貨完成！');
      await runLookup();
      if (onDataChanged) onDataChanged();
    } catch (err) {
      showToast(err.response?.data?.error || '更新取貨狀態失敗', true);
    } finally {
      setProcessingId(null);
    }
  };

  const totalMatches =
    results.reservations.length + results.passes.length + results.shop_orders.length;

  return (
    <>
      <div
        className="fixed inset-0 z-[105] bg-black/60 backdrop-blur-xs flex items-start justify-center p-3 sm:p-6 overflow-y-auto"
        onClick={onClose}
      >
        <div
          className="bg-white rounded-3xl w-full max-w-3xl shadow-2xl border border-[#E8DEC8] overflow-hidden my-4 sm:my-8 flex flex-col max-h-[88vh]"
          onClick={e => e.stopPropagation()}
        >
          {/* Header */}
          <div className="p-4 sm:p-5 bg-[#2C241E] text-white flex items-center justify-between gap-3">
            <div className="flex items-center gap-2.5">
              <div className="p-2 rounded-xl bg-[#8B5B43] text-white">
                <QrCode className="w-5 h-5" />
              </div>
              <div>
                <h2 className="font-black text-base sm:text-lg">
                  🔍 櫃檯萬用掃碼 ／ 單號快速查詢台
                </h2>
                <p className="text-[11px] sm:text-xs text-[#D5CFC9]">
                  支援掃描條碼或輸入：電話、姓名、預約單號 (BK-...)、卡券條碼 (PS-...)、商城預購單 (PO-...)、末五碼
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="p-2 rounded-full bg-white/10 hover:bg-white/20 text-white transition"
            >
              <X className="w-5 h-5" />
            </button>
          </div>

          {/* Search Bar */}
          <div className="p-4 bg-[#FAF7F2] border-b border-[#E8DEC8]">
            <form
              onSubmit={e => {
                e.preventDefault();
                runLookup();
              }}
              className="relative flex items-center gap-2"
            >
              <div className="relative flex-1">
                <Search className="w-5 h-5 text-[#8B5B43] absolute left-3.5 top-1/2 -translate-y-1/2" />
                <input
                  ref={inputRef}
                  type="text"
                  value={query}
                  onChange={e => setQuery(e.target.value)}
                  placeholder="請直接刷入條碼，或輸入客人電話 / 姓名 / 單號 (BK- / PS- / PO-)..."
                  className="w-full pl-11 pr-9 py-3 bg-white border-2 border-[#8B5B43] rounded-2xl text-sm font-bold text-[#2C241E] outline-none shadow-xs"
                />
                {query && (
                  <button
                    type="button"
                    onClick={() => setQuery('')}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 text-sm font-bold"
                  >
                    ✕
                  </button>
                )}
              </div>
              <button
                type="submit"
                className="px-5 py-3 bg-[#8B5B43] hover:bg-[#724a35] text-white rounded-2xl text-sm font-black shadow-xs transition shrink-0"
              >
                查詢
              </button>
            </form>

            {toastMsg && (
              <div
                className={`mt-3 px-4 py-2.5 rounded-xl text-xs font-bold flex items-center gap-2 ${
                  toastMsg.isError
                    ? 'bg-rose-50 text-rose-700 border border-rose-200'
                    : 'bg-emerald-50 text-emerald-800 border border-emerald-200'
                }`}
              >
                <span>{toastMsg.text}</span>
              </div>
            )}
          </div>

          {/* Results Body */}
          <div className="p-4 sm:p-5 overflow-y-auto flex-1 space-y-6 bg-white">
            {!query.trim() ? (
              <div className="py-12 text-center space-y-3 text-[#8C8279]">
                <div className="w-14 h-14 rounded-2xl bg-[#FAF7F2] border border-[#E8DEC8] flex items-center justify-center mx-auto text-2xl">
                  📠
                </div>
                <p className="text-sm font-bold text-[#3E332B]">
                  請刷入顧客手機條碼，或輸入電話／姓名／單號
                </p>
                <div className="flex flex-wrap justify-center gap-2 text-xs max-w-lg mx-auto pt-1">
                  <span className="px-3 py-1 rounded-full bg-[#FAF7F2] border border-[#E8DEC8]">
                    📅 預約單一鍵報到 & POS 結帳
                  </span>
                  <span className="px-3 py-1 rounded-full bg-[#FAF7F2] border border-[#E8DEC8]">
                    🎟️ 代燙卡 / 月卡一鍵扣次核銷
                  </span>
                  <span className="px-3 py-1 rounded-full bg-[#FAF7F2] border border-[#E8DEC8]">
                    🛍️ 221色預購單一鍵完成取貨
                  </span>
                </div>
              </div>
            ) : loading ? (
              <div className="py-14 text-center text-sm text-[#8C8279] font-bold">
                搜尋中...
              </div>
            ) : totalMatches === 0 ? (
              <div className="py-14 text-center text-sm text-[#8C8279] font-bold">
                查無與「{query}」相符的預約單、卡券或預購訂單
              </div>
            ) : (
              <>
                {/* 1. Reservations Section */}
                {results.reservations.length > 0 && (
                  <div className="space-y-2.5">
                    <h3 className="text-xs font-black text-[#8B5B43] uppercase tracking-wider flex items-center gap-1.5">
                      <CalendarClock className="w-4 h-4" />
                      <span>手作預約訂單 ({results.reservations.length})</span>
                    </h3>
                    <div className="space-y-2">
                      {results.reservations.map(r => {
                        const statusUI = getReservationStatusUI(r);
                        const isCancelled = r.status === 'cancelled';
                        const isCheckedIn = r.attendance === 'checked_in';
                        return (
                          <div
                            key={r.booking_ref}
                            className="p-3.5 rounded-2xl border border-[#E8DEC8] bg-[#FAF7F2]/60 hover:bg-[#FAF7F2] flex flex-col sm:flex-row sm:items-center justify-between gap-3 transition"
                          >
                            <div className="space-y-1">
                              <div className="flex items-center flex-wrap gap-2">
                                <span className="font-bold text-sm text-[#2C241E]">
                                  {format(new Date(r.session_date), 'yyyy/MM/dd')} ({r.start_time}~{r.end_time})
                                </span>
                                <span className="font-mono text-xs font-bold text-[#8B5B43] bg-white px-2 py-0.5 rounded border border-[#E8DEC8]">
                                  #{formatBookingRef(r.booking_ref)}
                                </span>
                                <span
                                  className={`px-2 py-0.5 rounded-md text-xs font-bold ${statusUI.bgClass} ${statusUI.colorClass}`}
                                >
                                  {statusUI.text}
                                </span>
                                {!isCancelled && (
                                  <span
                                    className={`px-2 py-0.5 rounded-md text-xs font-bold ${
                                      r.is_paid
                                        ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                                        : 'bg-amber-50 text-amber-700 border border-amber-200'
                                    }`}
                                  >
                                    {r.is_paid ? `💰 已結帳 $${r.total_amount}` : `💳 待結帳 $${r.total_amount ?? 0}`}
                                  </span>
                                )}
                              </div>
                              <div className="text-xs text-[#6D5D52] flex items-center flex-wrap gap-2">
                                <strong className="text-[#2C241E]">{r.user?.name || '未設定'}</strong>
                                <span>({r.user?.phone || '無電話'})</span>
                                <span>· {r.pax} 人</span>
                                {r.assigned_seats?.length > 0 && (
                                  <span className="font-mono text-[#8B5B43]">
                                    座位: {r.assigned_seats.join(', ')}
                                  </span>
                                )}
                              </div>
                              {(r.customer_note || r.admin_note) && (
                                <div className="flex flex-wrap gap-1.5 pt-0.5">
                                  {r.customer_note && (
                                    <span className="text-[11px] font-bold bg-indigo-50 text-indigo-700 px-2 py-0.5 rounded border border-indigo-200">
                                      💬 顧客備註：{r.customer_note}
                                    </span>
                                  )}
                                  {r.admin_note && (
                                    <span className="text-[11px] font-bold bg-amber-50 text-amber-800 px-2 py-0.5 rounded border border-amber-200">
                                      📌 內部備註：{r.admin_note}
                                    </span>
                                  )}
                                </div>
                              )}
                            </div>

                            <div className="flex items-center gap-2 shrink-0">
                              {!isCancelled && !isCheckedIn && (
                                <button
                                  type="button"
                                  disabled={processingId === `checkin-${r.booking_ref}`}
                                  onClick={() => handleQuickCheckIn(r.booking_ref)}
                                  className="px-3.5 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white rounded-xl text-xs font-bold flex items-center gap-1 shadow-2xs transition"
                                >
                                  <CheckCircle2 className="w-3.5 h-3.5" />
                                  <span>一鍵報到</span>
                                </button>
                              )}
                              <button
                                type="button"
                                onClick={() => handleOpenReservationModal(r.booking_ref)}
                                className="px-3.5 py-2 bg-[#2C241E] hover:bg-[#3E332B] text-white rounded-xl text-xs font-bold flex items-center gap-1 shadow-2xs transition"
                              >
                                <CreditCard className="w-3.5 h-3.5" />
                                <span>{r.is_paid ? '訂單詳情' : '結帳 / 詳情'}</span>
                              </button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}

                {/* 2. Member Passes Section */}
                {results.passes.length > 0 && (
                  <div className="space-y-2.5">
                    <h3 className="text-xs font-black text-emerald-800 uppercase tracking-wider flex items-center gap-1.5">
                      <Ticket className="w-4 h-4" />
                      <span>會員代燙卡 ／ 月卡 ({results.passes.length})</span>
                    </h3>
                    <div className="space-y-2">
                      {results.passes.map(pass => {
                        const isActive = pass.status === 'ACTIVE';
                        return (
                          <div
                            key={pass.id}
                            className="p-3.5 rounded-2xl border border-emerald-200 bg-emerald-50/40 flex flex-col sm:flex-row sm:items-center justify-between gap-3"
                          >
                            <div className="space-y-1">
                              <div className="flex items-center flex-wrap gap-2">
                                <span className="font-bold text-sm text-[#2C241E]">
                                  {pass.plan_name_snapshot}
                                </span>
                                <span className="font-mono text-xs font-bold text-emerald-800 bg-white px-2 py-0.5 rounded border border-emerald-200">
                                  #{pass.pass_code}
                                </span>
                                <span
                                  className={`px-2 py-0.5 rounded-full text-[11px] font-bold ${
                                    isActive
                                      ? 'bg-emerald-100 text-emerald-800'
                                      : 'bg-gray-200 text-gray-600'
                                  }`}
                                >
                                  {isActive ? '✅ 可使用' : pass.status === 'EXHAUSTED' ? '已用畢' : '已過期'}
                                </span>
                              </div>
                              <div className="text-xs text-[#6D5D52] flex items-center flex-wrap gap-2">
                                <strong className="text-[#2C241E]">{pass.user?.name || '會員'}</strong>
                                <span>({pass.user?.phone || '無電話'})</span>
                                <span className="font-bold text-emerald-800">
                                  剩餘額度：
                                  {pass.remaining_quota !== null
                                    ? `${pass.remaining_quota} / ${pass.total_quota} 次`
                                    : '不限次暢玩'}
                                </span>
                              </div>
                            </div>

                            {isActive && (
                              <button
                                type="button"
                                disabled={processingId === `pass-${pass.id}`}
                                onClick={() => handleQuickRedeemPass(pass)}
                                className="px-4 py-2 bg-emerald-700 hover:bg-emerald-800 disabled:opacity-50 text-white rounded-xl text-xs font-bold flex items-center gap-1.5 shadow-2xs transition shrink-0"
                              >
                                <Sparkles className="w-3.5 h-3.5" />
                                <span>⚡ 扣除 1 次 / 立即核銷</span>
                              </button>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}

                {/* 3. Shop Preorders Section */}
                {results.shop_orders.length > 0 && (
                  <div className="space-y-2.5">
                    <h3 className="text-xs font-black text-[#8B5B43] uppercase tracking-wider flex items-center gap-1.5">
                      <ShoppingBag className="w-4 h-4" />
                      <span>商城預購訂單 ({results.shop_orders.length})</span>
                    </h3>
                    <div className="space-y-2">
                      {results.shop_orders.map(order => {
                        const isPickedUp = order.order_status === 'picked_up';
                        const isCancelled = order.order_status === 'cancelled';
                        return (
                          <div
                            key={order.id}
                            className="p-3.5 rounded-2xl border border-[#E8DEC8] bg-[#FAF7F2]/60 flex flex-col sm:flex-row sm:items-center justify-between gap-3"
                          >
                            <div className="space-y-1">
                              <div className="flex items-center flex-wrap gap-2">
                                <span className="font-mono font-black text-sm text-[#2C241E]">
                                  #{order.order_ref}
                                </span>
                                <span className="font-bold text-xs text-[#2C241E]">
                                  {order.user?.name} ({order.user?.phone})
                                </span>
                                <span
                                  className={`px-2 py-0.5 rounded-full text-[11px] font-bold ${
                                    isPickedUp
                                      ? 'bg-emerald-100 text-emerald-800'
                                      : isCancelled
                                        ? 'bg-gray-200 text-gray-500'
                                        : order.order_status === 'arrived'
                                          ? 'bg-rose-100 text-rose-800'
                                          : 'bg-amber-100 text-amber-800'
                                  }`}
                                >
                                  {isPickedUp
                                    ? '✅ 已取貨'
                                    : isCancelled
                                      ? '已取消'
                                      : order.order_status === 'arrived'
                                        ? '📢 已到貨待取'
                                        : '📦 預購備貨中'}
                                </span>
                              </div>
                              <div className="text-xs text-[#6D5D52]">
                                {order.items?.map(i => `${i.product_name_snapshot}×${i.quantity}`).join('、')}
                              </div>
                              <div className="text-xs flex items-center flex-wrap gap-3">
                                <span>總額: NT$ {order.total_amount}</span>
                                <span className="text-emerald-700 font-bold">已收: NT$ {order.paid_amount}</span>
                                {order.balance_amount > 0 && (
                                  <span className="text-rose-700 font-black">
                                    待收尾款: NT$ {order.balance_amount}
                                  </span>
                                )}
                              </div>
                            </div>

                            <div className="flex items-center gap-2 shrink-0">
                              {!isPickedUp && !isCancelled && (
                                <button
                                  type="button"
                                  disabled={processingId === `shop-${order.id}`}
                                  onClick={() => handleQuickPickupShopOrder(order)}
                                  className="px-3.5 py-2 bg-[#8B5B43] hover:bg-[#724a35] disabled:opacity-50 text-white rounded-xl text-xs font-bold flex items-center gap-1 shadow-2xs transition"
                                >
                                  <PackageCheck className="w-3.5 h-3.5" />
                                  <span>取貨完成</span>
                                </button>
                              )}
                              <button
                                type="button"
                                onClick={() => {
                                  onClose();
                                  navigate('/admin/shop');
                                }}
                                className="px-3 py-2 bg-white border border-[#E8DEC8] hover:bg-[#FAF7F2] text-[#3E332B] rounded-xl text-xs font-bold flex items-center gap-1 transition"
                              >
                                <ExternalLink className="w-3.5 h-3.5" />
                                <span>商城管理</span>
                              </button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </div>

      {/* Nested Reservation Details / POS Checkout Modal */}
      {selectedReservationDetail && (
        <ReservationDetailsModal
          reservation={selectedReservationDetail}
          onClose={() => setSelectedReservationDetail(null)}
          onUpdate={updates => {
            if (updates) {
              setSelectedReservationDetail(prev => (prev ? { ...prev, ...updates } : prev));
            } else {
              setSelectedReservationDetail(null);
            }
            runLookup();
            if (onDataChanged) onDataChanged();
          }}
        />
      )}
    </>
  );
}
