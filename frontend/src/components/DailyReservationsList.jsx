import React, { useState, useEffect } from 'react';
import { format } from 'date-fns';
import api from '../api/axios';
import { getReservationStatusUI } from './ReservationDetailsModal';

export default function DailyReservationsList({ date, onOpenDetails }) {
  const [reservations, setReservations] = useState([]);
  const [isLoading, setIsLoading] = useState(false);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [totalRecords, setTotalRecords] = useState(0);

  // Reset page to 1 when date changes
  useEffect(() => {
    setPage(1);
  }, [date]);

  useEffect(() => {
    if (date) {
      fetchReservations();
    }
  }, [date, page]);

  const fetchReservations = async () => {
    setIsLoading(true);
    try {
      const res = await api.get(`/reservations/admin?page=${page}&limit=20&date=${date}&sort=start_time_asc`);
      setReservations(res.data?.data || (Array.isArray(res.data) ? res.data : []));
      setTotalPages(res.data?.totalPages || 1);
      setTotalRecords(res.data?.total || (Array.isArray(res.data) ? res.data.length : 0));
    } catch (err) {
      console.error(err);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="mt-8 pt-8 border-t-2 border-gray-200">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-xl font-bold text-gray-800">當日所有訂單列表</h2>
        <span className="text-sm font-medium text-gray-500 bg-gray-100 px-3 py-1 rounded-full">
          {format(new Date(date), 'yyyy/MM/dd')}
        </span>
      </div>
      
      <div className="bg-white rounded-2xl shadow-sm border border-gray-200 overflow-hidden">
        <div className="overflow-x-auto">
          {isLoading ? (
            <div className="p-12 text-center text-gray-400">載入中...</div>
          ) : !reservations || reservations.length === 0 ? (
            <div className="p-12 text-center text-gray-400 font-medium">此日期尚無任何預約紀錄</div>
          ) : (
            <table className="w-full text-left whitespace-nowrap">
              <thead>
                <tr className="bg-gray-50 text-gray-500 text-sm border-b border-gray-200">
                  <th className="px-6 py-4 font-medium">預約時間</th>
                  <th className="px-6 py-4 font-medium">顧客資料</th>
                  <th className="px-6 py-4 font-medium text-center">人數</th>
                  <th className="px-6 py-4 font-medium">狀態</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {reservations.map(r => {
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
                        <div className="flex flex-col">
                          <span className={`font-medium ${isCancelled ? 'text-gray-400' : 'text-gray-800'}`}>{r.user.name}</span>
                          <span className="text-sm text-gray-500">{r.user.phone}</span>
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
                        </div>
                      </td>
                      <td className="px-6 py-4">
                        <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-sm font-medium ${statusUI.bgClass} ${statusUI.colorClass}`}>
                          {statusUI.icon} {statusUI.text}
                        </span>
                        {r.status === 'cancelled' && r.cancelled_at && (
                          <div className="mt-1 text-[11px] text-gray-500 flex flex-col gap-0.5">
                            <span>{format(new Date(r.cancelled_at), 'MM/dd HH:mm')}</span>
                            <span>({r.cancelled_by === 'admin' ? '管理員取消' : '顧客自行取消'})</span>
                          </div>
                        )}
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
