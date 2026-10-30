import React, { useState, useEffect, useMemo } from 'react';
import { format } from 'date-fns';
import { Search, Plus, XCircle, CheckCircle2, Cpu, Minus, CreditCard } from 'lucide-react';
import api from '../../api/axios';
import ReservationDetailsModal, { getReservationStatusUI } from '../../components/ReservationDetailsModal';
import { calculateEquipmentChargeableHours } from '../../utils/equipmentPricing.js';

export default function ReservationsPage() {
  const [reservations, setReservations] = useState([]);
  const [selectedReservation, setSelectedReservation] = useState(null);
  const [isLoading, setIsLoading] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('all'); // 'all' | 'pending_checkin' | 'checked_in' | 'unpaid' | 'cancelled'
  const [checkingInRef, setCheckingInRef] = useState(null);
  
  // Pagination & Month filter
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [totalRecords, setTotalRecords] = useState(0);
  const [currentMonth, setCurrentMonth] = useState(format(new Date(), 'yyyy-MM'));

  // Manual Booking State
  const [showManualBooking, setShowManualBooking] = useState(false);
  const [manualDate, setManualDate] = useState(format(new Date(), 'yyyy-MM-dd'));
  const [manualSessions, setManualSessions] = useState([]);
  const [manualSelectedSessions, setManualSelectedSessions] = useState([]);
  const [manualName, setManualName] = useState('');
  const [manualPhone, setManualPhone] = useState('');
  const [manualPax, setManualPax] = useState(1);
  const [manualForceSplit, setManualForceSplit] = useState(true);
  const [manualEquipments, setManualEquipments] = useState({});
  const [equipmentConfigs, setEquipmentConfigs] = useState([]);
  const [isManualLoading, setIsManualLoading] = useState(false);
  const [equipmentDiscount, setEquipmentDiscount] = useState({
    enabled: true,
    buy_hours: 3,
    free_hours: 1,
    stackable: true,
    tier2_enabled: false,
    tier2_buy_hours: 8,
    tier2_free_hours: 4
  });

  useEffect(() => {
    if (showManualBooking) {
      api.get('/equipment/admin/configs')
        .then(res => {
          const list = res.data?.configs || (Array.isArray(res.data) ? res.data : []);
          setEquipmentConfigs(list);
          if (res.data) {
            setEquipmentDiscount({
              enabled: res.data.equipment_discount_enabled !== false,
              buy_hours: res.data.equipment_discount_buy_hours ?? 3,
              free_hours: res.data.equipment_discount_free_hours ?? 1,
              stackable: res.data.equipment_discount_stackable !== false,
              tier2_enabled: !!res.data.equipment_discount2_enabled,
              tier2_buy_hours: res.data.equipment_discount2_buy_hours ?? 8,
              tier2_free_hours: res.data.equipment_discount2_free_hours ?? 4
            });
          }
        })
        .catch(err => console.error('Failed to load configs:', err));
    }
  }, [showManualBooking]);

  useEffect(() => {
    const delayDebounceFn = setTimeout(() => {
      fetchReservations();
    }, 300);
    return () => clearTimeout(delayDebounceFn);
  }, [page, currentMonth, searchQuery]);

  useEffect(() => {
    if (showManualBooking) {
      fetchManualSessions();
    }
  }, [manualDate, showManualBooking]);

  const fetchReservations = async () => {
    setIsLoading(true);
    try {
      const res = await api.get(`/reservations/admin?page=${page}&limit=20&search=${encodeURIComponent(searchQuery)}&month=${currentMonth}`);
      setReservations(res.data?.data || (Array.isArray(res.data) ? res.data : []));
      setTotalPages(res.data?.totalPages || 1);
      setTotalRecords(res.data?.total || (Array.isArray(res.data) ? res.data.length : 0));
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
    
    const equipmentsPayload = Object.entries(manualEquipments)
      .filter(([_, qty]) => qty > 0)
      .map(([equipment_id, quantity]) => ({
        equipment_id,
        quantity,
        rental_hours: sortedSessions.length
      }));

    try {
      await api.post('/reservations/admin', {
        name: manualName,
        phone: manualPhone,
        session_ids: sortedSessions.map(s => s.id),
        pax: manualPax,
        forceSplit: manualForceSplit,
        isWalkIn: true,
        equipments: equipmentsPayload
      });
      alert('手動預約建立成功！');
      setShowManualBooking(false);
      setManualName('');
      setManualPhone('');
      setManualSelectedSessions([]);
      setManualForceSplit(true);
      setManualEquipments({});
      fetchReservations();
    } catch (err) {
      alert(err.response?.data?.error || '手動預約失敗');
    }
  };

  // getReservationStatusUI is now imported from ReservationDetailsModal

  const handleDirectCheckIn = async (e, bookingRef) => {
    e.stopPropagation();
    setCheckingInRef(bookingRef);
    try {
      await api.patch(`/reservations/${bookingRef}/attendance`, { attendance: 'checked_in' });
      fetchReservations();
    } catch (err) {
      alert('報到更新失敗');
    } finally {
      setCheckingInRef(null);
    }
  };

  const filterCounts = useMemo(() => {
    const counts = {
      all: reservations.length,
      pending_checkin: 0,
      checked_in: 0,
      unpaid: 0,
      cancelled: 0
    };
    for (const r of reservations) {
      if (r.status === 'cancelled') {
        counts.cancelled++;
      } else {
        if (r.attendance === 'checked_in') counts.checked_in++;
        else counts.pending_checkin++;
        if (!r.is_paid) counts.unpaid++;
      }
    }
    return counts;
  }, [reservations]);

  const filteredReservations = useMemo(() => {
    return reservations.filter(r => {
      if (statusFilter === 'all') return true;
      if (statusFilter === 'cancelled') return r.status === 'cancelled';
      if (r.status === 'cancelled') return false;
      if (statusFilter === 'pending_checkin') return r.attendance !== 'checked_in';
      if (statusFilter === 'checked_in') return r.attendance === 'checked_in';
      if (statusFilter === 'unpaid') return !r.is_paid;
      return true;
    });
  }, [reservations, statusFilter]);

  return (
    <>
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
              placeholder="搜尋訂單編號或姓名..."
              value={searchQuery}
              onChange={(e) => {
                setSearchQuery(e.target.value);
                setPage(1);
              }}
              className="pl-10 pr-4 py-2 border-none bg-gray-100 rounded-xl text-sm focus:ring-2 focus:ring-indigo-500 w-full md:w-64 transition-shadow"
            />
          </div>
          <input
            type="month"
            value={currentMonth}
            onChange={(e) => {
              setCurrentMonth(e.target.value);
              setPage(1);
            }}
            className="px-4 py-2 border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-indigo-500 bg-white"
          />
          <button 
            onClick={() => setShowManualBooking(true)}
            className="bg-gray-900 hover:bg-gray-800 text-white px-4 py-2 flex items-center justify-center gap-2 rounded-xl text-sm font-medium transition-colors shadow-sm whitespace-nowrap"
          >
            <Plus className="w-4 h-4"/> 新增手動預約
          </button>
        </div>
      </div>

      {/* Quick Status Filter Pills */}
      <div className="flex items-center gap-1.5 overflow-x-auto pb-1 text-xs font-bold">
        {[
          { key: 'all', label: `本頁全部 (${filterCounts.all})` },
          { key: 'pending_checkin', label: `⏳ 待報到 (${filterCounts.pending_checkin})` },
          { key: 'checked_in', label: `🟢 已報到 (${filterCounts.checked_in})` },
          { key: 'unpaid', label: `💳 待結帳 (${filterCounts.unpaid})` },
          { key: 'cancelled', label: `❌ 已取消 (${filterCounts.cancelled})` }
        ].map(tab => (
          <button
            key={tab.key}
            type="button"
            onClick={() => setStatusFilter(tab.key)}
            className={`px-3 py-1.5 rounded-xl whitespace-nowrap transition ${
              statusFilter === tab.key
                ? 'bg-gray-900 text-white shadow-xs'
                : 'bg-white text-gray-600 border border-gray-200 hover:bg-gray-50'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div className="bg-white rounded-2xl shadow-sm border border-gray-200 overflow-hidden">
        <div className="overflow-x-auto">
          {isLoading ? (
            <div className="p-12 text-center text-gray-400">載入中...</div>
          ) : !filteredReservations || filteredReservations.length === 0 ? (
            <div className="p-12 text-center text-gray-400 font-medium">此月份尚無預約紀錄或找不到符合的篩選結果</div>
          ) : (
            <table className="w-full text-left whitespace-nowrap">
              <thead>
                <tr className="bg-gray-50 text-gray-500 text-sm border-b border-gray-200">
                  <th className="px-6 py-4 font-medium">預約日期 / 時段</th>
                  <th className="px-6 py-4 font-medium">顧客資料</th>
                  <th className="px-6 py-4 font-medium text-center">人數</th>
                  <th className="px-6 py-4 font-medium">狀態</th>
                  <th className="px-6 py-4 font-medium text-right">建立時間</th>
                  <th className="px-6 py-4 font-medium text-right">快捷操作</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {filteredReservations.map(r => {
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
                          <span className="text-sm text-gray-500">
                            {r.time_blocks 
                              ? r.time_blocks.map(b => `${b.start_time} - ${b.end_time}`).join(', ')
                              : `${r.start_time} - ${r.end_time}`} 
                            ({r.session_count}小時)
                          </span>
                        </div>
                      </td>
                      <td className="px-6 py-4">
                        <div className="flex flex-col gap-0.5">
                          <span className={`font-medium ${isCancelled ? 'text-gray-400' : 'text-gray-800'}`}>{r.user?.name || '未設定'}</span>
                          <span className="text-sm text-gray-500">{r.user?.phone || '未提供'}</span>
                          {(r.customer_note || r.admin_note) && (
                            <div className="flex flex-wrap gap-1 mt-1 max-w-[240px]">
                              {r.customer_note && (
                                <span
                                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-bold bg-indigo-50 text-indigo-700 border border-indigo-200 truncate max-w-full"
                                  title={`顧客備註：${r.customer_note}`}
                                >
                                  💬 {r.customer_note}
                                </span>
                              )}
                              {r.admin_note && (
                                <span
                                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-bold bg-amber-50 text-amber-800 border border-amber-200 truncate max-w-full"
                                  title={`內部備註：${r.admin_note}`}
                                >
                                  📌 {r.admin_note}
                                </span>
                              )}
                            </div>
                          )}
                        </div>
                      </td>
                      <td className="px-6 py-4 text-center">
                        <div className="flex flex-col items-center gap-1">
                          <span className={`inline-flex justify-center items-center w-8 h-8 rounded-lg ${isCancelled ? 'bg-gray-100 text-gray-400' : 'bg-gray-100 text-gray-900 font-bold'}`}>
                            {r.pax}
                          </span>
                          {r.is_unlimited && (
                            <span className="text-[10px] font-bold text-purple-700 bg-purple-100 px-1.5 py-0.5 rounded">
                              不限時
                            </span>
                          )}
                          {r.equipments && r.equipments.length > 0 && (
                            <span 
                              className="text-[10px] font-bold text-amber-800 bg-amber-100 px-1.5 py-0.5 rounded flex items-center gap-0.5" 
                              title={`智能板: ${r.equipments.map(e => `${e.equipment_name_snapshot}×${e.quantity}`).join('、')}`}
                            >
                              ⚙️ ×{r.equipments.reduce((sum, e) => sum + e.quantity, 0)}
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="px-6 py-4">
                        <div className="flex items-center flex-wrap gap-1.5">
                          <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-sm font-medium ${statusUI.bgClass} ${statusUI.colorClass}`}>
                            {statusUI.icon} {statusUI.text}
                          </span>
                          {r.status !== 'cancelled' && (
                            r.is_paid ? (
                              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-xs font-bold bg-emerald-50 text-emerald-700 border border-emerald-200">
                                💰 已結帳 {r.total_amount != null ? `$${r.total_amount}` : ''}
                              </span>
                            ) : (
                              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-xs font-bold bg-amber-50 text-amber-700 border border-amber-200">
                                💳 待結帳 {r.total_amount != null ? `$${r.total_amount}` : ''}
                              </span>
                            )
                          )}
                        </div>
                        {r.attendance === 'checked_in' && r.checked_in_at && (
                          <div className="mt-1 text-[11px] font-medium text-blue-600 flex items-center gap-0.5">
                            <span>🕒 報到 {format(new Date(r.checked_in_at), 'HH:mm')}</span>
                          </div>
                        )}
                        {r.status === 'cancelled' && r.cancelled_at && (
                          <div className="mt-1 text-[11px] text-gray-500 flex flex-col gap-0.5">
                            <span>{format(new Date(r.cancelled_at), 'MM/dd HH:mm')}</span>
                            <span>({r.cancelled_by === 'admin' ? '管理員取消' : '顧客自行取消'})</span>
                          </div>
                        )}
                      </td>
                      <td className="px-6 py-4 text-right text-sm text-gray-400">
                        {format(new Date(r.created_at), 'MM/dd HH:mm')}
                      </td>
                      <td className="px-6 py-4 text-right">
                        <div className="flex items-center justify-end gap-1.5">
                          {!isCancelled && r.attendance !== 'checked_in' && (
                            <button
                              type="button"
                              disabled={checkingInRef === r.booking_ref}
                              onClick={(e) => handleDirectCheckIn(e, r.booking_ref)}
                              className="px-2.5 py-1.5 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white rounded-lg text-xs font-bold flex items-center gap-1 shadow-2xs transition"
                            >
                              <CheckCircle2 className="w-3.5 h-3.5" />
                              <span>報到</span>
                            </button>
                          )}
                          {!isCancelled && !r.is_paid && (
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                setSelectedReservation(r);
                              }}
                              className="px-2.5 py-1.5 bg-amber-600 hover:bg-amber-700 text-white rounded-lg text-xs font-bold flex items-center gap-1 shadow-2xs transition"
                            >
                              <CreditCard className="w-3.5 h-3.5" />
                              <span>結帳</span>
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
        
        {/* Pagination UI */}
        {totalPages > 1 && (
          <div className="p-4 border-t border-gray-100 flex items-center justify-between bg-white">
            <p className="text-sm text-gray-500">
              共 {totalRecords} 筆資料
            </p>
            <div className="flex items-center gap-2">
              <button 
                onClick={() => setPage(p => Math.max(1, p - 1))}
                disabled={page === 1}
                className="px-3 py-1 text-sm bg-gray-50 border rounded hover:bg-gray-100 disabled:opacity-50"
              >
                上一頁
              </button>
              <span className="text-sm font-medium text-gray-600">
                {page} / {totalPages}
              </span>
              <button 
                onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                disabled={page === totalPages}
                className="px-3 py-1 text-sm bg-gray-50 border rounded hover:bg-gray-100 disabled:opacity-50"
              >
                下一頁
              </button>
            </div>
          </div>
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
                  <label className="block text-sm font-medium text-gray-700 mb-2">聯絡電話 <span className="text-gray-400 font-normal">(選填)</span></label>
                  <input type="tel" value={manualPhone} onChange={e => setManualPhone(e.target.value)} placeholder="例：0912345678"
                    className="w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl focus:ring-2 focus:ring-gray-900 outline-none" />
                </div>
              </div>

              <div className="mb-6">
                <label className="block text-sm font-medium text-gray-700 mb-2">預約日期</label>
                <input type="date" required value={manualDate} onChange={e => setManualDate(e.target.value)}
                  className="w-full md:w-1/2 px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl focus:ring-2 focus:ring-gray-900 outline-none" />
              </div>

              {/* Force Split */}
              <div className="mb-6">
                <label className="flex items-center gap-3 p-3 bg-gray-50 border border-gray-200 rounded-xl cursor-pointer hover:bg-gray-100 transition-colors w-full md:w-1/2">
                  <input
                    type="checkbox"
                    checked={manualForceSplit}
                    onChange={(e) => setManualForceSplit(e.target.checked)}
                    className="w-5 h-5 text-gray-900 rounded border-gray-300 focus:ring-gray-900"
                  />
                  <div className="flex flex-col">
                    <span className="text-sm font-bold text-gray-800">同意拆桌 <span className="ml-1 text-xs text-gray-600 bg-gray-200 px-1.5 py-0.5 rounded">預設推薦</span></span>
                    <span className="text-xs text-gray-500 mt-0.5">系統空間不足時，優先拆散以騰出大桌</span>
                  </div>
                </label>
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

              {manualSelectedSessions.length > 0 && equipmentConfigs.length > 0 && (
                <div className="mb-6 pt-4 border-t border-gray-100 animate-in fade-in slide-in-from-bottom-2">
                  <div className="flex items-center justify-between mb-2">
                    <label className="text-sm font-medium text-gray-700 flex items-center gap-1.5">
                      <Cpu className="w-4 h-4 text-gray-800" />
                      加租智能拼豆板 <span className="text-gray-400 font-normal">(選填)</span>
                    </label>
                    {(() => {
                      const totalHours = manualSelectedSessions.length;
                      const chargeableHours = calculateEquipmentChargeableHours(totalHours, equipmentDiscount);
                      const totalFee = equipmentConfigs.reduce((sum, c) => {
                        const qty = manualEquipments[c.id] || 0;
                        const singlePrice = (c.daily_cap && c.daily_cap > 0) ? Math.min(c.hourly_rate * chargeableHours, c.daily_cap) : (c.hourly_rate * chargeableHours);
                        return sum + singlePrice * qty;
                      }, 0);
                      const discountText = (() => {
                        if (chargeableHours >= totalHours) return '';
                        if (equipmentDiscount.tier2_enabled && totalHours >= equipmentDiscount.tier2_buy_hours) {
                          return `(享二階買${equipmentDiscount.tier2_buy_hours}送${equipmentDiscount.tier2_free_hours})`;
                        }
                        return `(享買${equipmentDiscount.buy_hours}送${equipmentDiscount.free_hours})`;
                      })();
                      return totalFee > 0 ? (
                        <span className="text-xs bg-amber-50 text-amber-800 border border-amber-200 px-2 py-0.5 rounded-md font-bold">
                          加購小計 +NT$ {totalFee} {discountText}
                        </span>
                      ) : null;
                    })()}
                  </div>
                  <div className="space-y-2 bg-gray-50/70 p-3 rounded-2xl border border-gray-200">
                    {equipmentConfigs.map(c => {
                      const qty = manualEquipments[c.id] || 0;
                      const isBringOwn = c.id === 'bring_own';
                      const totalHours = manualSelectedSessions.length;
                      const chargeableHours = calculateEquipmentChargeableHours(totalHours, equipmentDiscount);
                      const singlePrice = (c.daily_cap && c.daily_cap > 0) ? Math.min(c.hourly_rate * chargeableHours, c.daily_cap) : (c.hourly_rate * chargeableHours);

                      return (
                        <div key={c.id} className="flex items-center justify-between bg-white px-3 py-2 rounded-xl border border-gray-100 shadow-2xs">
                          <div>
                            <div className="flex items-center gap-1.5">
                              <span className="text-sm font-bold text-gray-800">{c.name}</span>
                              <span className="text-xs text-gray-600 font-semibold bg-gray-100 px-1.5 py-0.5 rounded">NT${c.hourly_rate}/時</span>
                            </div>
                            <div className="text-[11px] text-gray-400 mt-0.5">
                              {isBringOwn ? '自備設備充電場地費' : (c.daily_cap && c.daily_cap > 0 ? `單台上限 NT$${c.daily_cap} ｜ 時數計 NT$${singlePrice}` : `依時數計 NT$${singlePrice} (無上限)`)}
                            </div>
                          </div>
                          <div className="flex items-center gap-2">
                            <button
                              type="button"
                              disabled={qty <= 0}
                              onClick={() => setManualEquipments(prev => ({ ...prev, [c.id]: Math.max(0, qty - 1) }))}
                              className="w-7 h-7 rounded-lg bg-gray-100 hover:bg-gray-200 disabled:opacity-30 disabled:cursor-not-allowed flex items-center justify-center font-bold text-gray-700 transition-colors"
                            >
                              <Minus className="w-3.5 h-3.5" />
                            </button>
                            <span className="w-6 text-center font-bold text-sm text-gray-800">{qty}</span>
                            <button
                              type="button"
                              onClick={() => setManualEquipments(prev => ({ ...prev, [c.id]: qty + 1 }))}
                              className="w-7 h-7 rounded-lg bg-gray-900 hover:bg-gray-800 text-white flex items-center justify-center font-bold transition-colors"
                            >
                              <Plus className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
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
      <ReservationDetailsModal 
        reservation={selectedReservation} 
        onClose={() => setSelectedReservation(null)} 
        onUpdate={(updates) => {
          if (updates) {
            setSelectedReservation(prev => ({ ...prev, ...updates }));
          } else {
            setSelectedReservation(null);
          }
          fetchReservations();
        }} 
      />

      <style dangerouslySetInnerHTML={{__html: `
        .animate-in { animation: animateIn 0.4s ease-out forwards; }
        @keyframes animateIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
      `}} />
    </>
  );
}
