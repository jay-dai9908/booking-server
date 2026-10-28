import React, { useState, useEffect } from 'react';
import {
  ChevronLeft,
  ChevronRight,
  CalendarClock,
  History,
  Search,
  RefreshCw,
  ShoppingBag,
  Ticket,
  QrCode,
  Sparkles,
  Clock,
  Copy,
  Check,
  MessageCircle,
  ExternalLink,
  Gift,
  ShieldCheck
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import api from '../../api/axios';
import { format } from 'date-fns';
import CustomerReservationDetailsModal, { getReservationStatusUI, formatBookingRef } from '../../components/CustomerReservationDetailsModal';
import EquipmentAddonModal from '../../components/EquipmentAddonModal';
import BarcodeModal from '../../components/BarcodeModal';

export default function HistoryPage() {
  const navigate = useNavigate();

  // 3 Primary Tabs: 'reservations' | 'shop' | 'passes'
  const [mainTab, setMainTab] = useState('reservations');

  // Reservation state
  const [reservations, setReservations] = useState([]);
  const [loading, setLoading] = useState(true);
  const [activeReservationTab, setActiveReservationTab] = useState('upcoming'); // 'upcoming' or 'past'
  const [selectedReservation, setSelectedReservation] = useState(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [addonReservation, setAddonReservation] = useState(null);
  const [noticeModal, setNoticeModal] = useState(null);

  // Preorders state
  const [preorders, setPreorders] = useState([]);
  const [loadingOrders, setLoadingOrders] = useState(false);
  const [remittanceInputs, setRemittanceInputs] = useState({}); // { [orderId]: string }
  const [remittanceSuccess, setRemittanceSuccess] = useState({});

  // Passes state
  const [passes, setPasses] = useState([]);
  const [loadingPasses, setLoadingPasses] = useState(false);

  // Barcode / QR modal state
  const [barcodeModalData, setBarcodeModalData] = useState(null);
  const [copiedAccount, setCopiedAccount] = useState({});

  useEffect(() => {
    fetchReservations();
  }, []);

  useEffect(() => {
    if (mainTab === 'shop' && preorders.length === 0) {
      fetchPreorders();
    } else if (mainTab === 'passes' && passes.length === 0) {
      fetchPasses();
    }
  }, [mainTab]);

  const fetchReservations = async () => {
    try {
      setLoading(true);
      const res = await api.get('/reservations/my');
      setReservations(Object.values(res.data));
    } catch (err) {
      console.error('Failed to fetch reservations', err);
    } finally {
      setLoading(false);
    }
  };

  const fetchPreorders = async () => {
    try {
      setLoadingOrders(true);
      const res = await api.get('/shop/my-orders');
      setPreorders(Array.isArray(res.data) ? res.data : []);
    } catch (err) {
      console.error('Failed to fetch preorders', err);
    } finally {
      setLoadingOrders(false);
    }
  };

  const fetchPasses = async () => {
    try {
      setLoadingPasses(true);
      const res = await api.get('/passes/my');
      setPasses(Array.isArray(res.data) ? res.data : []);
    } catch (err) {
      console.error('Failed to fetch passes', err);
    } finally {
      setLoadingPasses(false);
    }
  };

  const handleRemittanceSubmit = async (orderId) => {
    const val = (remittanceInputs[orderId] || '').trim();
    if (!val) return;
    try {
      await api.patch(`/shop/orders/${orderId}/remittance`, { remittance_last5: val });
      setRemittanceSuccess(prev => ({ ...prev, [orderId]: true }));
      fetchPreorders();
    } catch (err) {
      alert('回報末五碼失敗：' + (err.response?.data?.error || err.message));
    }
  };

  const isPast = (dateStr, timeStr) => {
    if (!timeStr) return true;
    const [hours, minutes] = timeStr.split(':');
    const d = new Date(dateStr);
    d.setHours(parseInt(hours, 10), parseInt(minutes, 10), 0, 0);
    return d < new Date();
  };

  // Format and split reservations
  const formattedReservations = reservations.map(r => ({
    ...r,
    start_time: r.start_time || r.session?.start_time,
    end_time: r.end_time || r.session?.end_time,
    session_date: r.session_date || r.session?.session_date
  }));

  const upcomingReservations = formattedReservations.filter(r => !isPast(r.session_date, r.start_time));
  const pastReservations = formattedReservations.filter(r => isPast(r.session_date, r.start_time));

  const baseList = activeReservationTab === 'upcoming' ? upcomingReservations : pastReservations;

  const displayReservations = baseList.filter(r => {
    if (!searchTerm.trim()) return true;
    const term = searchTerm.toLowerCase().trim();
    const shortRef = formatBookingRef(r.booking_ref).toLowerCase();
    const fullRef = (r.booking_ref || '').toLowerCase();
    const dateStr = format(new Date(r.session_date), 'yyyy/MM/dd yyyy-MM-dd').toLowerCase();
    const nameStr = (r.user?.name || '').toLowerCase();
    return shortRef.includes(term) || fullRef.includes(term) || dateStr.includes(term) || nameStr.includes(term);
  });

  return (
    <div className="min-h-screen bg-[#F7F4F0] flex flex-col text-[#3E332B] pb-16">
      {/* Header */}
      <header className="sticky top-0 z-30 bg-[#F7F4F0]/95 backdrop-blur-md border-b border-[#EBE5DF]">
        <div className="flex items-center justify-between px-4 h-16 max-w-3xl mx-auto w-full relative">
          <button 
            onClick={() => navigate('/booking')} 
            className="flex items-center text-[#8C8279] hover:text-[#3E332B] font-medium transition-colors z-10"
          >
            <ChevronLeft className="w-5 h-5 mr-1" />返回預約
          </button>
          <h1 className="text-base sm:text-lg font-bold text-[#3E332B] absolute inset-0 flex items-center justify-center pointer-events-none">
            我的紀錄與到店條碼
          </h1>
          <button
            onClick={() => {
              if (mainTab === 'reservations') fetchReservations();
              if (mainTab === 'shop') fetchPreorders();
              if (mainTab === 'passes') fetchPasses();
            }}
            className="p-2 text-[#8B5B43] hover:bg-[#FAF7F2] rounded-xl transition shrink-0 z-10"
            title="重新整理"
          >
            <RefreshCw className="w-4 h-4" />
          </button>
        </div>
      </header>

      {/* Primary 3 Navigation Tabs */}
      <div className="px-4 pt-4 max-w-3xl mx-auto w-full">
        <div className="grid grid-cols-3 bg-[#EBE5DF] p-1 rounded-2xl gap-1 text-xs sm:text-sm font-bold text-center">
          <button
            type="button"
            onClick={() => setMainTab('reservations')}
            className={`py-2.5 rounded-xl transition flex items-center justify-center gap-1.5 ${
              mainTab === 'reservations'
                ? 'bg-white text-[#8B5B43] shadow-xs'
                : 'text-[#8C8279] hover:text-[#3E332B]'
            }`}
          >
            <CalendarClock className="w-4 h-4" />
            <span>手作預約</span>
          </button>

          <button
            type="button"
            onClick={() => setMainTab('shop')}
            className={`py-2.5 rounded-xl transition flex items-center justify-center gap-1.5 ${
              mainTab === 'shop'
                ? 'bg-white text-[#8B5B43] shadow-xs'
                : 'text-[#8C8279] hover:text-[#3E332B]'
            }`}
          >
            <ShoppingBag className="w-4 h-4" />
            <span>商品預購</span>
          </button>

          <button
            type="button"
            onClick={() => setMainTab('passes')}
            className={`py-2.5 rounded-xl transition flex items-center justify-center gap-1.5 ${
              mainTab === 'passes'
                ? 'bg-white text-[#8B5B43] shadow-xs'
                : 'text-[#8C8279] hover:text-[#3E332B]'
            }`}
          >
            <Ticket className="w-4 h-4" />
            <span>我的卡券</span>
          </button>
        </div>
      </div>

      {/* ========================================================= */}
      {/* TAB 1: RESERVATIONS */}
      {/* ========================================================= */}
      {mainTab === 'reservations' && (
        <div className="flex-1 flex flex-col">
          {/* Subtabs: Upcoming vs Past */}
          <div className="px-4 pt-3 pb-2 max-w-3xl mx-auto w-full">
            <div className="flex bg-[#F0EBE5] p-1 rounded-xl text-xs font-bold">
              <button
                onClick={() => setActiveReservationTab('upcoming')}
                className={`flex-1 py-1.5 rounded-lg transition ${
                  activeReservationTab === 'upcoming'
                    ? 'bg-white text-[#8B5B43] shadow-2xs'
                    : 'text-[#8C8279]'
                }`}
              >
                即將到來 ({upcomingReservations.length})
              </button>
              <button
                onClick={() => setActiveReservationTab('past')}
                className={`flex-1 py-1.5 rounded-lg transition ${
                  activeReservationTab === 'past'
                    ? 'bg-white text-[#8B5B43] shadow-2xs'
                    : 'text-[#8C8279]'
                }`}
              >
                歷史紀錄 ({pastReservations.length})
              </button>
            </div>
          </div>

          {/* Search Bar */}
          <div className="px-4 pb-3 max-w-3xl mx-auto w-full">
            <div className="relative">
              <Search className="w-4 h-4 text-gray-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                placeholder="🔍 篩選預約單號 (BK-XXXX)、日期..."
                className="w-full pl-9 pr-8 py-2 bg-white border border-[#E5DFD7] rounded-xl text-xs text-[#2C241E] outline-none shadow-2xs"
              />
              {searchTerm && (
                <button
                  onClick={() => setSearchTerm('')}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 text-xs"
                >
                  ✕
                </button>
              )}
            </div>
          </div>

          {/* Reservation List */}
          <main className="flex-1 px-4 pb-8 max-w-3xl mx-auto w-full">
            {loading ? (
              <div className="flex justify-center items-center py-20">
                <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-[#8B5B43]"></div>
              </div>
            ) : displayReservations.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16 text-center px-4 space-y-4">
                <div className="w-14 h-14 bg-[#F4EFE6] rounded-2xl flex items-center justify-center text-2xl">
                  📅
                </div>
                <p className="text-xs sm:text-sm text-[#8C8279] font-medium whitespace-pre-line">
                  {searchTerm ? '查無符合條件的預約紀錄' : '目前尚無此分類之預約紀錄'}
                </p>
                <button
                  onClick={() => navigate('/booking')}
                  className="px-6 py-2.5 bg-[#8B5B43] hover:bg-[#724a35] text-white rounded-full font-bold text-xs shadow-xs transition"
                >
                  前往線上預約
                </button>
              </div>
            ) : (
              <div className="space-y-4">
                {displayReservations.sort((a, b) => new Date(b.session_date) - new Date(a.session_date)).map((r, i) => {
                  const statusUI = getReservationStatusUI(r);
                  const now = new Date();
                  const isCancelled = r.status === 'cancelled';
                  const sessionCount = r.session_count || (r.sessions ? r.sessions.length : 1);

                  const [endH, endM] = (r.end_time || '00:00').split(':').map(Number);
                  const bookingEndTime = new Date(r.session_date);
                  bookingEndTime.setHours(endH, endM, 0, 0);

                  const [startH, startM] = (r.start_time || '00:00').split(':').map(Number);
                  const bookingStartTime = new Date(r.session_date);
                  bookingStartTime.setHours(startH, startM, 0, 0);

                  const isExpired = now >= bookingEndTime;
                  const effectiveStart = new Date(Math.max(now.getTime(), bookingStartTime.getTime()));
                  const remainingMinutes = (bookingEndTime.getTime() - effectiveStart.getTime()) / (60 * 1000);

                  const totalBoards = (r.equipments || []).reduce((sum, e) => sum + e.quantity, 0);
                  const remainingPax = Math.max(0, r.pax - totalBoards);

                  let equipmentLabel = '未加購 (全員使用免費一般板)';
                  if (r.equipments && r.equipments.length > 0) {
                    const parts = r.equipments.map(e => `${e.equipment_name_snapshot} ×${e.quantity}`);
                    equipmentLabel = `${parts.join('、')} (${r.equipments[0].rental_hours}hr)${remainingPax > 0 ? ` ｜ 尚有 ${remainingPax} 人可追加` : ''}`;
                  }

                  const timeRangeStr = r.time_blocks 
                    ? r.time_blocks.map(b => `${b.start_time} - ${b.end_time}`).join(', ')
                    : `${r.start_time} - ${r.end_time}`;

                  return (
                    <div 
                      key={i}
                      onClick={() => setSelectedReservation(r)}
                      className="group flex flex-col bg-white p-5 rounded-2xl border border-transparent hover:border-[#EBE5DF] shadow-xs hover:shadow-md transition cursor-pointer space-y-3"
                    >
                      <div className="flex justify-between items-start gap-2">
                        <div>
                          <div className="flex items-center gap-2 mb-1 flex-wrap">
                            <span className="font-bold text-[#3E332B] text-base sm:text-lg">
                              {format(new Date(r.session_date), 'yyyy/MM/dd')}
                            </span>
                            <span className="font-mono text-xs font-bold text-[#8B5B43] bg-[#F4EFE6] px-2 py-0.5 rounded-md border border-[#E8DEC8]">
                              #{formatBookingRef(r.booking_ref)}
                            </span>
                          </div>
                          <span className="text-xs font-semibold text-[#8C8279] bg-[#F4EFE6] px-2 py-0.5 rounded-md inline-block">
                            {timeRangeStr}
                          </span>
                        </div>
                        <div className="flex flex-col items-end gap-1.5 shrink-0">
                          <span className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-bold ${statusUI.bgClass} ${statusUI.colorClass}`}>
                            {statusUI.icon} {statusUI.text}
                          </span>

                          {/* Barcode Modal Button */}
                          {!isCancelled && (
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                setBarcodeModalData({
                                  code: r.booking_ref,
                                  title: '門市預約報到掃碼憑證',
                                  subtitle: '到店請出示此條碼給門市櫃檯人員掃描核銷',
                                  details: [
                                    { label: '預約單號', value: formatBookingRef(r.booking_ref) },
                                    { label: '預約日期', value: format(new Date(r.session_date), 'yyyy/MM/dd') },
                                    { label: '預約時段', value: timeRangeStr },
                                    { label: '預約人數', value: `${r.pax} 位` }
                                  ]
                                });
                              }}
                              className="px-2.5 py-1 bg-[#1A1512] hover:bg-[#3E332B] text-white rounded-lg text-[11px] font-bold flex items-center gap-1 transition shadow-2xs"
                            >
                              <QrCode className="w-3.5 h-3.5" />
                              <span>到店條碼</span>
                            </button>
                          )}
                        </div>
                      </div>

                      {/* Pegboard Info Bar */}
                      <div className="bg-[#FAF7F2] rounded-xl p-3 border border-[#E8DEC8]/60 flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-xs">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <span className="font-bold text-[#4A3F35] shrink-0">⚙️ 智能拼豆板：</span>
                          <span className={`px-2 py-0.5 rounded-md font-bold ${totalBoards > 0 ? 'bg-[#EDE6DD] text-[#4A3F35]' : 'text-[#8C8279]'}`}>
                            {equipmentLabel}
                          </span>
                        </div>

                        {!isCancelled && !isExpired && (
                          <div className="self-end sm:self-auto shrink-0">
                            {remainingMinutes >= 120 && sessionCount >= 2 && (
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setAddonReservation(r);
                                }}
                                className="bg-[#8B5B43] hover:bg-[#724a35] text-white text-xs px-3 py-1 rounded-full font-bold shadow-2xs transition flex items-center gap-1"
                              >
                                {totalBoards > 0 ? '✏️ 追加/修改智能板' : '➕ 補預約智能板'}
                              </button>
                            )}
                          </div>
                        )}
                      </div>

                      <div className="flex items-center justify-between border-t border-[#F4EFE6] pt-2.5 mt-1 text-xs">
                        <div className="flex items-center gap-2">
                          <span className="font-bold text-[#8C8279]">{r.pax} 人</span>
                          {r.is_unlimited && (
                            <span className="text-[10px] font-bold text-[#A67C52] bg-[#F4EFE6] px-2 py-0.5 rounded-full border border-[#D5CFC9]">
                              ✨ 不限時
                            </span>
                          )}
                          {r.total_amount != null && (
                            <span className="font-bold text-[#3E332B] ml-2">
                              總額 NT$ {r.total_amount}
                            </span>
                          )}
                        </div>
                        <ChevronRight className="w-4 h-4 text-[#8C8279] opacity-70 group-hover:opacity-100 group-hover:text-[#8B5B43] transition transform group-hover:translate-x-1" />
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </main>
        </div>
      )}

      {/* ========================================================= */}
      {/* TAB 2: PREORDER SHOP ORDERS */}
      {/* ========================================================= */}
      {mainTab === 'shop' && (
        <main className="flex-1 px-4 py-4 max-w-3xl mx-auto w-full space-y-4">
          {loadingOrders ? (
            <div className="flex justify-center items-center py-20">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-[#8B5B43]"></div>
            </div>
          ) : preorders.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-center px-4 space-y-4">
              <div className="w-14 h-14 bg-[#F4EFE6] rounded-2xl flex items-center justify-center text-3xl">
                🛍️
              </div>
              <p className="text-xs sm:text-sm text-[#8C8279] font-medium">
                您尚未在拾光製所預購任何商品或套裝喔！
              </p>
              <button
                type="button"
                onClick={() => navigate('/shop')}
                className="px-6 py-2.5 bg-[#8B5B43] hover:bg-[#724a35] text-white rounded-full font-bold text-xs shadow-xs transition"
              >
                前往 221 色套裝預購商城
              </button>
            </div>
          ) : (
            <div className="space-y-4">
              {preorders.map((order) => {
                const isPaidDeposit = order.payment_status === 'deposit_verified' || order.payment_status === 'fully_paid';
                const isReported = order.payment_status === 'reported_pending_verify';

                return (
                  <div
                    key={order.id}
                    className="bg-white rounded-2xl p-5 border border-[#E8DEC8] shadow-xs space-y-4"
                  >
                    {/* Header: Ref & Status */}
                    <div className="flex justify-between items-start gap-2">
                      <div>
                        <div className="flex items-center gap-2 mb-1 flex-wrap">
                          <span className="font-mono font-black text-[#3E332B] text-base">
                            #{order.order_ref}
                          </span>
                          <span className="text-[11px] text-[#8C8279]">
                            {format(new Date(order.created_at), 'yyyy/MM/dd HH:mm')}
                          </span>
                        </div>
                        <span className="text-xs text-[#6D5D52] font-bold">
                          {order.delivery_method === 'shipping' ? '🚚 宅配寄送' : '🏪 門市自取'}
                          {order.estimated_arrival && ` · ${order.estimated_arrival}`}
                        </span>
                      </div>

                      {/* Status Badges */}
                      <div className="flex flex-col items-end gap-1">
                        <span
                          className={`px-2.5 py-1 rounded-full text-[11px] font-bold ${
                            order.order_status === 'arrived'
                              ? 'bg-rose-100 text-rose-800'
                              : order.order_status === 'picked_up'
                              ? 'bg-emerald-100 text-emerald-800'
                              : 'bg-amber-100 text-amber-800'
                          }`}
                        >
                          {order.order_status === 'arrived'
                            ? '📢 商品已到貨可取件'
                            : order.order_status === 'picked_up'
                            ? '✅ 已取貨完成'
                            : '📦 備貨／預購登記中'}
                        </span>

                        <span
                          className={`px-2 py-0.5 rounded-md text-[10px] font-bold ${
                            isPaidDeposit
                              ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                              : isReported
                              ? 'bg-blue-50 text-blue-700 border border-blue-200'
                              : 'bg-amber-50 text-amber-700 border border-amber-200'
                          }`}
                        >
                          {order.payment_status === 'fully_paid'
                            ? '已全額結清'
                            : order.payment_status === 'deposit_verified'
                            ? '已收訂金 (尾款取貨付)'
                            : isReported
                            ? '已回報末五碼 (待對帳)'
                            : '待繳納訂金'}
                        </span>
                      </div>
                    </div>

                    {/* Items List */}
                    <div className="bg-[#FAF7F2] p-3.5 rounded-xl border border-[#E8DEC8]/60 space-y-2 text-xs">
                      {order.items?.map((item) => (
                        <div key={item.id} className="flex justify-between items-center py-0.5">
                          <span className="font-bold text-[#3E332B]">
                            {item.product_name_snapshot}
                            <span className="text-[#8C8279] font-normal ml-2">x {item.quantity}</span>
                          </span>
                          <span className="font-mono font-bold text-[#8B5B43]">
                            NT$ {item.subtotal?.toLocaleString()}
                          </span>
                        </div>
                      ))}

                      <div className="pt-2 border-t border-[#E8DEC8] flex justify-between items-baseline font-bold">
                        <span className="text-[#6D5D52]">總金額 / 應付訂金</span>
                        <div className="text-right">
                          <span className="font-mono text-sm text-[#3E332B] mr-2">
                            總額 NT$ {order.total_amount?.toLocaleString()}
                          </span>
                          <span className="text-emerald-800 text-xs">
                            (訂金 NT$ {order.deposit_required?.toLocaleString()})
                          </span>
                        </div>
                      </div>

                      {order.balance_amount > 0 && (
                        <div className="flex justify-between text-xs text-[#8B5B43] font-bold">
                          <span>門市取貨待付尾款</span>
                          <span>NT$ {order.balance_amount?.toLocaleString()}</span>
                        </div>
                      )}
                    </div>

                    {/* CTBC One-Time Account Details if Assigned */}
                    {order.payment_method_code === 'ctbc_pool' && order.assigned_pool_account && (
                      <div className="bg-emerald-50/70 p-3.5 rounded-xl border border-emerald-200 space-y-2 text-xs">
                        <div className="flex items-center justify-between">
                          <span className="font-bold text-emerald-900">
                            🏦 專屬中信一次性收款帳號：
                          </span>
                          <button
                            type="button"
                            onClick={() => {
                              navigator.clipboard?.writeText(order.assigned_pool_account);
                              setCopiedAccount(prev => ({ ...prev, [order.id]: true }));
                              setTimeout(() => setCopiedAccount(prev => ({ ...prev, [order.id]: false })), 2000);
                            }}
                            className="px-2.5 py-1 bg-emerald-700 hover:bg-emerald-800 text-white rounded text-[11px] font-bold flex items-center gap-1 transition"
                          >
                            {copiedAccount[order.id] ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                            <span>{copiedAccount[order.id] ? '已複製' : '複製帳號'}</span>
                          </button>
                        </div>
                        <div className="font-mono font-black text-sm text-emerald-800">
                          {order.assigned_pool_account}
                        </div>
                      </div>
                    )}

                    {/* Remittance Last 5 Digits Input if not verified */}
                    {!isPaidDeposit && (
                      <div className="p-3 bg-white rounded-xl border border-[#E8DEC8] flex items-center gap-2 text-xs">
                        <span className="font-bold text-[#6D5D52] shrink-0">匯款末五碼：</span>
                        <input
                          type="text"
                          maxLength="5"
                          value={remittanceInputs[order.id] !== undefined ? remittanceInputs[order.id] : (order.remittance_last5 || '')}
                          onChange={e => {
                            const val = e.target.value.replace(/\D/g, '');
                            setRemittanceInputs(prev => ({ ...prev, [order.id]: val }));
                          }}
                          placeholder="例如 58291"
                          className="flex-1 px-2.5 py-1 border border-[#E8DEC8] rounded-lg text-xs font-mono font-bold outline-none"
                        />
                        <button
                          type="button"
                          onClick={() => handleRemittanceSubmit(order.id)}
                          className="px-3 py-1 bg-[#8B5B43] hover:bg-[#724a35] text-white rounded-lg text-xs font-bold transition shrink-0"
                        >
                          {remittanceSuccess[order.id] ? '✅ 已更新' : (order.remittance_last5 ? '修改末五碼' : '回報末五碼')}
                        </button>
                      </div>
                    )}

                    {/* Customer Wish Note Display */}
                    {order.wish_note && (
                      <div className="text-xs text-[#6D5D52]">
                        <strong className="text-[#8B5B43]">🎁 您的許願款式：</strong> {order.wish_note}
                      </div>
                    )}

                    {/* STRICT REQUIREMENT: Wish Reply Warm Dialog Box (No LINE pushed, shown directly in order!) */}
                    {order.wish_reply && (
                      <div className="bg-[#FAF7F2] p-4 rounded-2xl border-l-4 border-[#8B5B43] space-y-1.5 shadow-2xs">
                        <span className="text-xs font-black text-[#8B5B43] flex items-center gap-1.5">
                          <Sparkles className="w-4 h-4" />
                          <span>店家許願回覆：</span>
                        </span>
                        <p className="text-xs text-[#3E332B] font-bold leading-relaxed pl-5">
                          {order.wish_reply}
                        </p>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </main>
      )}

      {/* ========================================================= */}
      {/* TAB 3: MEMBER PASSES & CARDS */}
      {/* ========================================================= */}
      {mainTab === 'passes' && (
        <main className="flex-1 px-4 py-4 max-w-3xl mx-auto w-full space-y-4">
          {loadingPasses ? (
            <div className="flex justify-center items-center py-20">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-[#8B5B43]"></div>
            </div>
          ) : passes.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-center px-4 space-y-4">
              <div className="w-14 h-14 bg-[#F4EFE6] rounded-2xl flex items-center justify-center text-3xl">
                🎟️
              </div>
              <p className="text-xs sm:text-sm text-[#8C8279] font-medium">
                您目前尚未持有任何會員集次卡、月卡或代燙卡。
              </p>
              <p className="text-xs text-[#A8A19A]">
                💡 預購「221 色拼豆全配套裝」到店取貨即可免費獲得「中板內免費代燙 5 件集次卡」！
              </p>
              <button
                type="button"
                onClick={() => navigate('/shop')}
                className="px-6 py-2.5 bg-[#8B5B43] hover:bg-[#724a35] text-white rounded-full font-bold text-xs shadow-xs transition"
              >
                探索 221 色套裝預購
              </button>
            </div>
          ) : (
            <div className="space-y-4">
              {passes.map((pass) => {
                const isExhausted = pass.status === 'EXHAUSTED';
                const isExpired = pass.status === 'EXPIRED';
                const isActive = pass.status === 'ACTIVE';

                return (
                  <div
                    key={pass.id}
                    className="bg-white rounded-2xl p-5 border border-[#E8DEC8] shadow-xs space-y-4 relative overflow-hidden"
                  >
                    {/* Top Type Tag */}
                    <div className="flex justify-between items-start gap-2">
                      <div>
                        <div className="flex items-center gap-2 mb-1 flex-wrap">
                          <h3 className="font-extrabold text-base text-[#3E332B]">
                            {pass.plan_name_snapshot}
                          </h3>
                        </div>
                        <span className="font-mono text-xs text-[#8B5B43] bg-[#FAF7F2] px-2 py-0.5 rounded border border-[#E8DEC8]">
                          #{pass.pass_code}
                        </span>
                      </div>

                      <div className="flex flex-col items-end gap-1.5 shrink-0">
                        <span
                          className={`px-2.5 py-1 rounded-full text-xs font-bold ${
                            isActive
                              ? 'bg-emerald-100 text-emerald-800'
                              : isExhausted
                              ? 'bg-slate-100 text-slate-600'
                              : 'bg-rose-100 text-rose-800'
                          }`}
                        >
                          {isActive ? '✅ 可使用' : isExhausted ? '已用畢' : '已過期'}
                        </span>

                        {/* Barcode Modal Button for this Pass */}
                        {isActive && (
                          <button
                            type="button"
                            onClick={() => {
                              setBarcodeModalData({
                                code: pass.pass_code,
                                title: pass.plan_name_snapshot,
                                subtitle: '到店請出示此條碼給門市櫃檯人員掃描核銷',
                                details: [
                                  { label: '卡券名稱', value: pass.plan_name_snapshot },
                                  { label: '專屬條碼', value: pass.pass_code },
                                  {
                                    label: '剩餘次數/額度',
                                    value: pass.remaining_quota !== null ? `${pass.remaining_quota} 次` : '不限次暢玩',
                                    color: 'text-emerald-700 font-extrabold'
                                  },
                                  {
                                    label: '平假日限制',
                                    value: pass.day_restriction === 'WEEKDAY_ONLY' ? '僅限平日' : pass.day_restriction === 'WEEKEND_ONLY' ? '僅限假日' : '平假日皆可'
                                  },
                                  {
                                    label: '有效期限',
                                    value: pass.expires_at ? format(new Date(pass.expires_at), 'yyyy/MM/dd') : '永久有效'
                                  }
                                ]
                              });
                            }}
                            className="px-3 py-1 bg-[#1A1512] hover:bg-[#3E332B] text-white rounded-lg text-xs font-bold flex items-center gap-1.5 transition shadow-2xs"
                          >
                            <QrCode className="w-3.5 h-3.5" />
                            <span>到店掃碼</span>
                          </button>
                        )}
                      </div>
                    </div>

                    {/* Quota Progress Bar if Punch Card */}
                    {pass.total_quota !== null && (
                      <div className="bg-[#FAF7F2] p-3.5 rounded-xl border border-[#E8DEC8]/60 space-y-2">
                        <div className="flex justify-between text-xs font-bold">
                          <span className="text-[#6D5D52]">剩餘使用次數</span>
                          <span className="font-mono text-emerald-800 text-sm">
                            {pass.remaining_quota} / {pass.total_quota} 次
                          </span>
                        </div>
                        <div className="w-full bg-[#E5DFD7] h-2 rounded-full overflow-hidden">
                          <div
                            className="bg-[#8B5B43] h-full rounded-full transition-all duration-300"
                            style={{
                              width: `${Math.max(0, Math.min(100, (pass.remaining_quota / pass.total_quota) * 100))}%`
                            }}
                          />
                        </div>
                      </div>
                    )}

                    {/* Expiration & Rules */}
                    <div className="flex items-center justify-between text-xs text-[#8C8279] pt-1">
                      <span>
                        {pass.expires_at
                          ? `有效期限至：${format(new Date(pass.expires_at), 'yyyy/MM/dd')}`
                          : '無有效期限限制'}
                      </span>
                      <span>
                        {pass.day_restriction === 'WEEKDAY_ONLY'
                          ? '僅限平日'
                          : pass.day_restriction === 'WEEKEND_ONLY'
                          ? '僅限假日'
                          : '平假日皆可'}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </main>
      )}

      {/* ========================================================= */}
      {/* MODALS */}
      {/* ========================================================= */}
      {/* 1. Barcode / QR Code Modal */}
      {barcodeModalData && (
        <BarcodeModal
          isOpen={!!barcodeModalData}
          onClose={() => setBarcodeModalData(null)}
          code={barcodeModalData.code}
          title={barcodeModalData.title}
          subtitle={barcodeModalData.subtitle}
          details={barcodeModalData.details}
        />
      )}

      {/* 2. Notice Alert Modal */}
      {noticeModal && (
        <div className="fixed inset-0 z-[130] flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={() => setNoticeModal(null)} />
          <div className="bg-white rounded-[24px] shadow-xl w-full max-w-sm overflow-hidden relative z-10 p-6 text-center space-y-4 animate-in zoom-in-95 duration-200">
            <div className="w-12 h-12 bg-amber-100 text-amber-800 rounded-full flex items-center justify-center mx-auto text-2xl">
              ⚠️
            </div>
            <h3 className="text-lg font-bold text-[#3E332B]">{noticeModal.title}</h3>
            <p className="text-sm text-[#7A7067] leading-relaxed">{noticeModal.message}</p>
            <div className="flex items-center gap-2 pt-2">
              <button
                onClick={() => setNoticeModal(null)}
                className="flex-1 py-2.5 bg-gray-100 hover:bg-gray-200 text-gray-700 rounded-full font-bold text-sm transition-colors"
              >
                我知道了
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 3. Equipment Retroactive Add-on Modal */}
      {addonReservation && (
        <EquipmentAddonModal
          reservation={addonReservation}
          isOpen={!!addonReservation}
          onClose={() => setAddonReservation(null)}
          onSuccess={() => {
            fetchReservations();
          }}
        />
      )}

      {/* 4. Reservation Detail Modal */}
      {selectedReservation && (
        <CustomerReservationDetailsModal 
          reservation={selectedReservation} 
          onClose={() => setSelectedReservation(null)} 
          onUpdate={fetchReservations}
          onOpenEquipmentAddon={() => {
            const target = selectedReservation;
            setSelectedReservation(null);
            setAddonReservation(target);
          }}
        />
      )}
    </div>
  );
}
