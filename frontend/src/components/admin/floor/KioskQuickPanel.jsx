import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { DoorOpen, Search, RefreshCw, AlertCircle, CheckCircle2 } from 'lucide-react';
import api from '../../../api/axios';
import ResponsivePanel from '../ResponsivePanel';
import { formatTimeHHmm } from '../../../../../shared/time.js';
import {
  METHOD_LABELS,
  RESULT_LABELS,
  RESULT_STYLES,
  KIOSK_BOOKING_STATE_LABELS
} from '../../../utils/admin/kioskLabels';

export default function KioskQuickPanel({
  isOpen = false,
  onClose,
  bookings = [],
  initialBooking = null
}) {
  const [logs, setLogs] = useState([]);
  const [logsLoading, setLogsLoading] = useState(false);
  const [logsError, setLogsError] = useState('');

  const [query, setQuery] = useState('');
  const [selectedBooking, setSelectedBooking] = useState(null);
  const [bookingStatus, setBookingStatus] = useState(null);
  const [statusLoading, setStatusLoading] = useState(false);
  const [statusError, setStatusError] = useState('');

  const fetchRecentLogs = useCallback(async () => {
    setLogsLoading(true);
    setLogsError('');
    try {
      const res = await api.get('/floor/kiosk/recent');
      setLogs(res.data?.logs || []);
    } catch (err) {
      setLogsError(err.response?.data?.error || '無法讀取報到機紀錄');
    } finally {
      setLogsLoading(false);
    }
  }, []);

  const fetchBookingStatus = useCallback(async (booking) => {
    if (!booking?.booking_ref) return;
    setSelectedBooking(booking);
    setStatusLoading(true);
    setStatusError('');
    try {
      const res = await api.get(`/floor/kiosk/booking/${booking.booking_ref}`);
      setBookingStatus(res.data);
    } catch (err) {
      setBookingStatus(null);
      setStatusError(err.response?.data?.error || '無法查詢這組的進場狀態');
    } finally {
      setStatusLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!isOpen) return undefined;
    fetchRecentLogs();
    const timer = setInterval(fetchRecentLogs, 15000);
    return () => clearInterval(timer);
  }, [isOpen, fetchRecentLogs]);

  useEffect(() => {
    if (!isOpen) {
      setQuery('');
      setSelectedBooking(null);
      setBookingStatus(null);
      setStatusError('');
      return;
    }
    if (initialBooking?.booking_ref) {
      fetchBookingStatus(initialBooking);
    } else {
      setSelectedBooking(null);
      setBookingStatus(null);
      setStatusError('');
    }
  }, [isOpen, initialBooking, fetchBookingStatus]);

  const matchedBookings = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return (bookings || [])
      .filter((b) => {
        const nameMatch = b.name && b.name.toLowerCase().includes(q);
        const maskedMatch = b.phone_masked && b.phone_masked.toLowerCase().includes(q);
        const phoneMatch = b.phone && String(b.phone).includes(q);
        const refMatch = b.ref_display && b.ref_display.toLowerCase().includes(q);
        return nameMatch || maskedMatch || phoneMatch || refMatch;
      })
      .slice(0, 8);
  }, [bookings, query]);

  return (
    <ResponsivePanel
      isOpen={isOpen}
      onClose={onClose}
      title="報到機異常小工具"
      subtitle="唯讀查詢最近刷門紀錄與顧客可開門狀態"
      width={460}
    >
      <div className="space-y-5 py-1" data-testid="kiosk-quick-panel">
        {/* Upper: Recent 20 logs */}
        <section className="space-y-2.5">
          <div className="flex items-center justify-between">
            <h4 className="text-[13px] font-bold text-sg-ink flex items-center gap-1.5">
              <DoorOpen className="w-4 h-4 text-sg-brown" />
              <span>最近刷門紀錄（今天最多 20 筆）</span>
            </h4>
            <button
              type="button"
              onClick={fetchRecentLogs}
              disabled={logsLoading}
              className="text-[11px] text-sg-brown font-bold flex items-center gap-1 hover:underline cursor-pointer disabled:opacity-50"
            >
              <RefreshCw className={`w-3 h-3 ${logsLoading ? 'animate-spin' : ''}`} />
              <span>重新整理</span>
            </button>
          </div>

          {logsError && (
            <div className="p-2.5 rounded-xl bg-sg-danger-soft text-sg-danger text-[12px] flex items-center gap-1.5">
              <AlertCircle className="w-4 h-4 shrink-0" />
              <span>{logsError}</span>
            </div>
          )}

          {!logsError && logs.length === 0 ? (
            <div className="p-4 rounded-2xl bg-sg-paper/50 border border-sg-line text-center text-[12px] text-sg-muted">
              {logsLoading ? '讀取中...' : '今天還沒有報到機刷門紀錄'}
            </div>
          ) : (
            <div className="space-y-1.5 max-h-[240px] overflow-y-auto pr-0.5" data-testid="kiosk-recent-logs">
              {logs.map((log, idx) => {
                const timeText = log.at && !log.at_unknown ? formatTimeHHmm(log.at) : '時間未知';
                const methodText = METHOD_LABELS[log.method] || log.method || '';
                const resultText = RESULT_LABELS[log.result] || log.result || '';
                const resultBadgeStyle = RESULT_STYLES[log.result] || 'bg-stone-100 text-stone-700 border-stone-200';
                const methodWithHint = log.hint ? `${methodText} ${log.hint}` : methodText;
                const summary = [
                  timeText,
                  methodWithHint,
                  resultText,
                  log.user_name || log.booking_ref_display || ''
                ].filter(Boolean).join(' · ');

                return (
                  <div
                    key={`${log.at || idx}-${idx}`}
                    data-open-door={log.open_door ? 'true' : 'false'}
                    className={`px-3 py-2 rounded-xl border text-[12px] flex items-center justify-between gap-2 ${
                      log.open_door
                        ? 'bg-emerald-50/70 border-emerald-200 text-emerald-950'
                        : 'bg-white border-sg-line text-sg-ink'
                    }`}
                  >
                    <span className="truncate font-medium">{summary}</span>
                    <span
                      className={`text-[10px] font-bold px-2 py-0.5 rounded-full border shrink-0 ${
                        log.open_door
                          ? 'bg-emerald-100 text-emerald-800 border-emerald-300'
                          : resultBadgeStyle
                      }`}
                    >
                      {log.open_door ? '已開門' : resultText}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        {/* Lower: Check single booking entry status */}
        <section className="space-y-2.5 pt-3 border-t border-sg-line">
          <h4 className="text-[13px] font-bold text-sg-ink">查客人現在掃碼會不會開門</h4>
          <div className="relative">
            <Search className="w-4 h-4 text-sg-muted absolute left-3 top-2.5" />
            <input
              type="text"
              data-testid="kiosk-quick-search-input"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="輸入客人姓名或電話末三碼..."
              className="w-full pl-9 pr-3 py-2 rounded-xl border border-sg-line text-[13px] bg-white focus:outline-none focus:border-sg-brown"
            />
          </div>

          {query.trim() && (
            <div className="space-y-1.5" data-testid="kiosk-quick-search-results">
              {matchedBookings.length === 0 ? (
                <div className="p-3 rounded-xl bg-sg-paper/50 border border-sg-line text-[12px] text-sg-muted text-center">
                  今天名單裡找不到符合「{query.trim()}」的預約
                </div>
              ) : (
                matchedBookings.map((b) => (
                  <button
                    key={b.booking_ref}
                    type="button"
                    data-testid={`kiosk-quick-pick-${b.booking_ref}`}
                    onClick={() => fetchBookingStatus(b)}
                    className={`w-full text-left px-3 py-2 rounded-xl border text-[12px] flex items-center justify-between transition cursor-pointer ${
                      selectedBooking?.booking_ref === b.booking_ref
                        ? 'bg-sg-brown-soft border-sg-brown text-sg-ink font-bold'
                        : 'bg-white border-sg-line hover:border-sg-brown'
                    }`}
                  >
                    <span>
                      {b.name || '客人'} · {b.pax} 位
                      {b.phone_masked ? ` · ${b.phone_masked}` : ''}
                    </span>
                    <span className="text-[11px] text-sg-muted font-num">
                      {formatTimeHHmm(b.start_at)}–{formatTimeHHmm(b.end_at)}
                    </span>
                  </button>
                ))
              )}
            </div>
          )}

          {selectedBooking && (
            <div
              data-testid="kiosk-quick-booking-status"
              className="p-3.5 rounded-2xl bg-sg-paper/60 border border-sg-line space-y-2 text-[12px]"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="font-bold text-[13px] text-sg-ink">
                  {selectedBooking.name || '客人'} · {selectedBooking.pax} 位
                </span>
                {bookingStatus?.state && (
                  <span
                    className={`px-2 py-0.5 rounded-full text-[11px] font-bold border ${
                      bookingStatus.state === 'open' || bookingStatus.state === 'in'
                        ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                        : 'bg-white text-sg-ink border-sg-line'
                    }`}
                  >
                    {KIOSK_BOOKING_STATE_LABELS[bookingStatus.state] || bookingStatus.state}
                  </span>
                )}
              </div>

              {statusLoading ? (
                <div className="text-sg-muted">查詢狀態中...</div>
              ) : statusError ? (
                <div className="text-sg-danger font-bold">{statusError}</div>
              ) : bookingStatus ? (
                <div className="space-y-1.5">
                  <div className="flex items-center gap-1.5 font-bold text-[13px] text-sg-ink">
                    {(bookingStatus.state === 'open' || bookingStatus.state === 'in') && (
                      <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
                    )}
                    <span data-testid="kiosk-quick-booking-reason">{bookingStatus.reason}</span>
                  </div>
                  <div className="text-[11px] text-sg-muted flex flex-wrap gap-x-3 gap-y-1">
                    {bookingStatus.open_at && <span>可進場：{bookingStatus.open_at} 起</span>}
                    {bookingStatus.until && <span>可使用到：{bookingStatus.until}</span>}
                    {Array.isArray(bookingStatus.seats) && bookingStatus.seats.length > 0 && (
                      <span>座位：{bookingStatus.seats.join('、')}</span>
                    )}
                  </div>
                </div>
              ) : null}
            </div>
          )}
        </section>
      </div>
    </ResponsivePanel>
  );
}
