import React, { useState, useEffect, useMemo } from 'react';
import { format } from 'date-fns';
import { Search, CheckCircle2, CreditCard } from 'lucide-react';
import api from '../api/axios';
import { getReservationStatusUI } from './ReservationDetailsModal';

export default function DailyReservationsList({ date, onOpenDetails, refreshTrigger = 0, onQuickCheckIn }) {
  const [reservations, setReservations] = useState([]);
  const [isLoading, setIsLoading] = useState(false);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [totalRecords, setTotalRecords] = useState(0);
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('all'); // 'all' | 'pending_checkin' | 'checked_in' | 'unpaid' | 'cancelled'
  const [checkingInRef, setCheckingInRef] = useState(null);

  // Reset page to 1 when date or search changes
  useEffect(() => {
    setPage(1);
  }, [date, searchQuery]);

  useEffect(() => {
    const delayDebounceFn = setTimeout(() => {
      if (date) {
        fetchReservations();
      }
    }, 300);
    return () => clearTimeout(delayDebounceFn);
  }, [date, page, searchQuery, refreshTrigger]);

  const fetchReservations = async () => {
    setIsLoading(true);
    try {
      const res = await api.get(`/reservations/admin?page=${page}&limit=50&date=${date}&sort=start_time_asc&search=${encodeURIComponent(searchQuery)}`);
      setReservations(res.data?.data || (Array.isArray(res.data) ? res.data : []));
      setTotalPages(res.data?.totalPages || 1);
      setTotalRecords(res.data?.total || (Array.isArray(res.data) ? res.data.length : 0));
    } catch (err) {
      console.error(err);
    } finally {
      setIsLoading(false);
    }
  };

  const handleDirectCheckIn = async (e, bookingRef) => {
    e.stopPropagation();
    setCheckingInRef(bookingRef);
    try {
      if (onQuickCheckIn) {
        await onQuickCheckIn(bookingRef);
      } else {
        await api.patch(`/reservations/${bookingRef}/attendance`, { attendance: 'checked_in' });
      }
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
    <div className="mt-8 pt-8 border-t-2 border-gray-200">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between mb-3 gap-4">
        <div className="flex items-center gap-4">
          <h2 className="text-xl font-bold text-gray-800 whitespace-nowrap">當日所有訂單列表</h2>
        </div>

        <div className="flex items-center gap-3 w-full sm:w-auto">
          <div className="relative flex-1 sm:w-64">
            <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
              <Search className="h-4 w-4 text-gray-400" />
            </div>
            <input
              type="text"
              placeholder="搜尋姓名、電話或備註..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-10 pr-4 py-2 border border-gray-200 bg-white rounded-xl text-sm focus:ring-2 focus:ring-indigo-500 w-full transition-shadow"
            />
          </div>
          <span className="text-sm font-medium text-gray-500 bg-gray-100 px-3 py-2 rounded-xl whitespace-nowrap">
            {format(new Date(date), 'yyyy/MM/dd')}
          </span>
        </div>
      </div>

      {/* Quick Status Filter Pills */}
      <div className="flex items-center gap-1.5 overflow-x-auto pb-3 text-xs font-bold">
        {[
          { key: 'all', label: `全部 (${filterCounts.all})` },
          { key: 'pending_checkin', label: `⏳ 待報到 (${filterCounts.pending_checkin})` },
          { key: 'checked_in', label: `🟢 已報到/在場 (${filterCounts.checked_in})` },
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
            <div className="p-12 text-center text-gray-400 font-medium">此篩選條件下尚無預約紀錄</div>
          ) : (
            <table className="w-full text-left whitespace-nowrap">
              <thead>
                <tr className="bg-gray-50 text-gray-500 text-sm border-b border-gray-200">
                  <th className="px-6 py-4 font-medium">預約時段</th>
                  <th className="px-6 py-4 font-medium">顧客資料</th>
                  <th className="px-6 py-4 font-medium text-center">人數</th>
                  <th className="px-6 py-4 font-medium">狀態</th>
                  <th className="px-6 py-4 font-medium text-right">預約時間點</th>
                  <th className="px-6 py-4 font-medium text-right">快捷操作</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {filteredReservations.map(r => {
                  const isCancelled = r.status === 'cancelled';
                  const statusUI = getReservationStatusUI(r);
                  return (
                    <tr key={r.booking_ref} 
                        onClick={() => onOpenDetails && onOpenDetails(r.booking_ref)}
                        className={`hover:bg-gray-50 transition-colors cursor-pointer ${isCancelled ? 'bg-gray-50/50' : ''}`}>
                      <td className="px-6 py-4">
                        <div className="flex flex-col">
                          <span className={`font-semibold ${isCancelled ? 'text-gray-400 line-through' : 'text-gray-800'}`}>
                            {r.time_blocks 
                              ? r.time_blocks.map(b => `${b.start_time} - ${b.end_time}`).join(', ')
                              : `${r.start_time} - ${r.end_time}`} 
                          </span>
                          <span className="text-sm text-gray-500">
                            共 {r.session_count} 小時
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
                      <td className="px-6 py-4 text-right text-sm text-gray-500 font-medium">
                        {r.created_at ? format(new Date(r.created_at), 'MM/dd HH:mm') : '-'}
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
                                if (onOpenDetails) onOpenDetails(r.booking_ref);
                              }}
                              className="px-2.5 py-1.5 bg-amber-600 hover:bg-amber-700 text-white rounded-lg text-xs font-bold flex items-center gap-1 shadow-2xs transition"
                            >
                              <CreditCard className="w-3.5 h-3.5" />
                              <span>結帳</span>
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              if (onOpenDetails) onOpenDetails(r.booking_ref);
                            }}
                            className="px-2.5 py-1.5 bg-gray-100 hover:bg-gray-200 text-gray-700 rounded-lg text-xs font-bold transition"
                          >
                            詳情
                          </button>
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
  );
}
