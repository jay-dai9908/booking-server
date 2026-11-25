import React, { useState, useEffect, useCallback } from 'react';
import { RefreshCw, CheckCircle2, AlertTriangle, Bell } from 'lucide-react';
import api from '../../api/axios';
import { formatBookingRef } from '../../utils/admin/floorSelectors';
import { formatDateTime } from '../../utils/format';

const PREPAY_STATUS_BADGES = {
  pending_payment: { label: '待付款', cls: 'bg-amber-100 text-amber-800 border-amber-200' },
  reported_pending_verify: { label: '已回報待對帳', cls: 'bg-orange-100 text-orange-800 border-orange-200' },
  mismatch: { label: '金額不符', cls: 'bg-red-100 text-red-700 border-red-200' },
  verified: { label: '已確認', cls: 'bg-emerald-100 text-emerald-800 border-emerald-200' },
  expired: { label: '逾期已取消', cls: 'bg-gray-100 text-gray-600 border-gray-200' },
  cancelled: { label: '已取消', cls: 'bg-gray-100 text-gray-500 border-gray-200' }
};

function renderContentSummary(item) {
  const parts = [];
  if (item.pass_persons > 0) parts.push(`用卡 ${item.pass_persons} 位`);
  if (item.board_count > 0) parts.push(`智能板 ${item.board_count} 台`);
  return parts.length > 0 ? parts.join(' · ') : '一般入場';
}

export default function SelfServicePrepaysPanel({ onCountsChange, onToast }) {
  const [statusFilter, setStatusFilter] = useState('reported_pending_verify');
  const [dateFilter, setDateFilter] = useState('');
  const [items, setItems] = useState([]);
  const [counts, setCounts] = useState({
    pending_payment: 0,
    reported_pending_verify: 0,
    verified: 0,
    expired: 0
  });
  const [loading, setLoading] = useState(false);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);

  const [verifyTarget, setVerifyTarget] = useState(null);
  const [verifyReceivedInput, setVerifyReceivedInput] = useState('');
  const [verifying, setVerifying] = useState(false);

  const [mismatchTarget, setMismatchTarget] = useState(null);
  const [mismatchNote, setMismatchNote] = useState('');
  const [submittingMismatch, setSubmittingMismatch] = useState(false);

  const [overpaidRefundTarget, setOverpaidRefundTarget] = useState(null);
  const [overpaidRefundNote, setOverpaidRefundNote] = useState('');
  const [submittingOverpaidRefund, setSubmittingOverpaidRefund] = useState(false);

  const [releasePoolTarget, setReleasePoolTarget] = useState(null);
  const [releasePoolNote, setReleasePoolNote] = useState('');
  const [releasingPool, setReleasingPool] = useState(false);

  const [remindingRef, setRemindingRef] = useState(null);

  const notify = (msg) => {
    if (onToast) onToast(msg);
  };

  const fetchPrepays = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (statusFilter) params.set('status', statusFilter);
      if (dateFilter) params.set('date', dateFilter);
      params.set('page', String(page));
      params.set('limit', '30');
      const res = await api.get(`/reservations/admin/prepays?${params.toString()}`);
      const nextItems = res.data?.items || [];
      const nextCounts = res.data?.counts || {
        pending_payment: 0,
        reported_pending_verify: 0,
        verified: 0,
        expired: 0
      };
      setItems(nextItems);
      setCounts(nextCounts);
      setTotal(res.data?.total ?? nextItems.length);
      setTotalPages(res.data?.total_pages ?? 1);
      if (onCountsChange) onCountsChange(nextCounts);
    } catch (err) {
      console.error('Failed to fetch prepays:', err);
      notify(err.response?.data?.error || '載入半自助對帳資料失敗');
    } finally {
      setLoading(false);
    }
  }, [statusFilter, dateFilter, page]);

  useEffect(() => {
    fetchPrepays();
  }, [fetchPrepays]);

  const openVerifyModal = (item) => {
    setVerifyTarget(item);
    setVerifyReceivedInput('');
  };

  const handleConfirmVerify = async (e) => {
    if (e && e.preventDefault) e.preventDefault();
    if (!verifyTarget) return;
    const body = {};
    if (verifyTarget.amount_due > 0) {
      const num = Number(verifyReceivedInput);
      if (!Number.isInteger(num) || num < 1) {
        notify('請填寫有效的實收整數金額（至少 NT$ 1）');
        return;
      }
      body.received_amount = num;
    }
    setVerifying(true);
    try {
      const res = await api.post(`/reservations/admin/prepays/${verifyTarget.booking_ref}/verify`, body);
      notify(res.data?.message || '已確認收款');
      setVerifyTarget(null);
      setVerifyReceivedInput('');
      await fetchPrepays();
      window.dispatchEvent(new CustomEvent('admin-data-updated'));
    } catch (err) {
      notify(err.response?.data?.error || '對帳確認失敗');
    } finally {
      setVerifying(false);
    }
  };

  const handleSubmitOverpaidRefund = async (e) => {
    e.preventDefault();
    if (!overpaidRefundTarget || !overpaidRefundNote.trim()) return;
    setSubmittingOverpaidRefund(true);
    try {
      await api.post(
        `/reservations/admin/prepays/${overpaidRefundTarget.booking_ref}/overpaid-refunded`,
        { note: overpaidRefundNote.trim() }
      );
      notify('已記錄退還多收金額');
      setOverpaidRefundTarget(null);
      setOverpaidRefundNote('');
      await fetchPrepays();
      window.dispatchEvent(new CustomEvent('admin-data-updated'));
    } catch (err) {
      notify(err.response?.data?.error || '記錄退還失敗');
    } finally {
      setSubmittingOverpaidRefund(false);
    }
  };

  const handleSubmitMismatch = async (e) => {
    e.preventDefault();
    if (!mismatchTarget || !mismatchNote.trim()) return;
    setSubmittingMismatch(true);
    try {
      await api.post(`/reservations/admin/prepays/${mismatchTarget.booking_ref}/mismatch`, {
        note: mismatchNote.trim()
      });
      notify('已標記金額不符並通知顧客');
      setMismatchTarget(null);
      setMismatchNote('');
      await fetchPrepays();
      window.dispatchEvent(new CustomEvent('admin-data-updated'));
    } catch (err) {
      notify(err.response?.data?.error || '標記金額不符失敗');
    } finally {
      setSubmittingMismatch(false);
    }
  };

  const handleRemind = async (item) => {
    setRemindingRef(item.booking_ref);
    try {
      const res = await api.post(`/reservations/admin/prepays/${item.booking_ref}/remind`);
      notify(res.data?.message || '已發送匯款提醒');
      await fetchPrepays();
    } catch (err) {
      notify(err.response?.data?.error || '發送提醒失敗');
    } finally {
      setRemindingRef(null);
    }
  };

  const handleSubmitReleasePool = async (e) => {
    e.preventDefault();
    if (!releasePoolTarget || !releasePoolNote.trim()) return;
    setReleasingPool(true);
    try {
      const res = await api.post(
        `/reservations/admin/prepays/${releasePoolTarget.booking_ref}/release-account`,
        { note: releasePoolNote.trim() }
      );
      notify(res.data?.message || '已釋放收款帳號回帳號池');
      setReleasePoolTarget(null);
      setReleasePoolNote('');
      await fetchPrepays();
      window.dispatchEvent(new CustomEvent('admin-data-updated'));
    } catch (err) {
      notify(err.response?.data?.error || '釋放收款帳號失敗');
    } finally {
      setReleasingPool(false);
    }
  };

  const canAct = (st) => ['pending_payment', 'reported_pending_verify', 'mismatch'].includes(st);

  return (
    <div className="space-y-4">
      {/* Header & Controls */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="flex items-center gap-2.5 flex-wrap">
          <h2 className="text-base font-bold text-gray-900">半自助預約對帳</h2>
          <span
            data-testid="prepay-pending-verify-badge"
            className="px-2.5 py-0.5 rounded-full text-xs font-bold bg-orange-100 text-orange-800 border border-orange-200"
          >
            {counts.reported_pending_verify || 0} 筆待對帳
          </span>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <input
            type="date"
            value={dateFilter}
            onChange={(e) => {
              setDateFilter(e.target.value);
              setPage(1);
            }}
            aria-label="篩選使用日期"
            className="px-3 py-1.5 border border-gray-200 rounded-xl text-sm bg-white"
          />
          {dateFilter && (
            <button
              type="button"
              onClick={() => {
                setDateFilter('');
                setPage(1);
              }}
              className="text-xs px-2.5 py-1.5 rounded-lg bg-gray-100 text-gray-700 hover:bg-gray-200"
            >
              全部日期
            </button>
          )}
          <button
            type="button"
            onClick={fetchPrepays}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl border border-gray-200 bg-white hover:bg-gray-50 text-xs font-bold text-gray-700"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            重新整理
          </button>
        </div>
      </div>

      {/* 4 Filter Tabs */}
      <div className="w-full max-w-full overflow-x-auto pb-1 text-xs font-bold">
        <div className="inline-flex items-center gap-1.5 min-w-max">
          {[
            { key: 'reported_pending_verify', label: `待對帳 (${counts.reported_pending_verify || 0})` },
            { key: 'pending_payment', label: `待付款 (${counts.pending_payment || 0})` },
            { key: 'verified', label: `已確認 (${counts.verified || 0})` },
            { key: 'expired', label: `逾期已取消 (${counts.expired || 0})` }
          ].map((tab) => (
            <button
              key={tab.key}
              type="button"
              data-testid={`prepay-filter-${tab.key}`}
              onClick={() => {
                setStatusFilter(tab.key);
                setPage(1);
              }}
              className={`px-3 py-1.5 rounded-xl whitespace-nowrap transition ${
                statusFilter === tab.key
                  ? 'bg-sg-brown text-white shadow-2xs'
                  : 'bg-white text-gray-600 border border-gray-200 hover:bg-gray-50'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {/* Content */}
      <div className="bg-white rounded-2xl shadow-sm border border-gray-200 overflow-hidden">
        {loading ? (
          <div className="p-10 text-center text-sm text-gray-400">載入對帳清單中...</div>
        ) : items.length === 0 ? (
          <div className="p-10 text-center text-sm text-gray-400 font-medium">
            目前沒有符合篩選條件的半自助預付紀錄
          </div>
        ) : (
          <>
            {/* Mobile Cards (< 768px, zero horizontal scroll) */}
            <div className="md:hidden divide-y divide-gray-100">
              {items.map((item) => {
                const badge = PREPAY_STATUS_BADGES[item.status] || PREPAY_STATUS_BADGES.pending_payment;
                return (
                  <div
                    key={item.booking_ref}
                    data-testid={`prepay-card-${item.booking_ref}`}
                    className={`p-4 space-y-2.5 ${item.is_overdue ? 'bg-red-50/40' : ''}`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="text-xs font-bold text-gray-500">
                          {item.session_date} · {item.start_time}-{item.end_time}
                        </div>
                        <div className="font-bold text-[15px] text-gray-900 mt-0.5">
                          {item.user_name} · {item.pax} 位
                        </div>
                        {item.user_phone && (
                          <div className="text-xs text-gray-500 font-mono">{item.user_phone}</div>
                        )}
                      </div>
                      <div className="flex flex-col items-end gap-1 shrink-0">
                        <span className={`text-[11px] font-bold px-2 py-0.5 rounded-full border ${badge.cls}`}>
                          {badge.label}
                        </span>
                        {item.status === 'reported_pending_verify' && /作廢入帳/.test(item.admin_note || '') && (
                          <span className="text-[11px] font-bold px-2 py-0.5 rounded-full bg-rose-100 text-rose-800 border border-rose-200">
                            入帳已作廢
                          </span>
                        )}
                        {item.is_overdue && (
                          <span className="text-[11px] font-bold px-2 py-0.5 rounded-full bg-red-600 text-white">
                            已過期限，請儘快處理
                          </span>
                        )}
                      </div>
                    </div>

                    <div className="text-xs text-gray-600 bg-gray-50 rounded-xl p-2.5 space-y-1">
                      <div className="flex justify-between">
                        <span>內容</span>
                        <span className="font-medium text-gray-900">{renderContentSummary(item)}</span>
                      </div>
                      <div className="flex justify-between">
                        <span>需匯金額</span>
                        <span className="font-mono font-bold text-sg-brown">NT$ {item.amount_due.toLocaleString()}</span>
                      </div>
                      <div className="flex justify-between gap-2">
                        <span className="shrink-0">帳號 / 方式</span>
                        <span className="text-right break-all">
                          {item.payment_method_name}
                          {item.assigned_pool_account ? ` · ${item.assigned_pool_account}` : item.selected_bank_info ? ` · ${item.selected_bank_info}` : ''}
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span>末五碼 / 回報</span>
                        <span className="font-mono font-bold">
                          {item.remittance_last5 || '尚未回報'}
                          {item.remittance_reported_at ? ` (${formatDateTime(item.remittance_reported_at, 'MM/dd HH:mm')})` : ''}
                        </span>
                      </div>
                      {item.deadline_at && (
                        <div className="flex justify-between">
                          <span>付款期限</span>
                          <span className="font-mono">{formatDateTime(item.deadline_at, 'MM/dd HH:mm')}</span>
                        </div>
                      )}
                      {item.admin_note && (
                        <div className="text-red-700 font-medium pt-1">備註：{item.admin_note}</div>
                      )}
                      {item.status === 'mismatch' && item.received_amount != null && item.shortfall > 0 && (
                        <div className="text-amber-800 font-bold pt-0.5">
                          已收 NT${item.received_amount.toLocaleString()}、還差 NT${item.shortfall.toLocaleString()}
                        </div>
                      )}
                      {item.overpaid_amount > 0 && !item.overpaid_refunded_at && (
                        <div className="text-amber-900 font-bold pt-0.5">
                          多收 NT${item.overpaid_amount.toLocaleString()}，待退還
                        </div>
                      )}
                      {(item.status === 'cancelled' || item.status === 'expired') && item.has_held_pool_account && (
                        <div className="text-amber-800 font-bold pt-0.5">
                          帳號保留中（已回報匯款）
                        </div>
                      )}
                    </div>

                    <div className="flex items-center justify-between gap-2 pt-1">
                      <span className="font-mono text-[11px] text-gray-400">{formatBookingRef(item.booking_ref)}</span>
                      <div className="flex items-center gap-1.5 flex-wrap justify-end">
                        {(item.status === 'cancelled' || item.status === 'expired') && item.has_held_pool_account && (
                          <button
                            type="button"
                            onClick={() => {
                              setReleasePoolTarget(item);
                              setReleasePoolNote('');
                            }}
                            className="px-2.5 py-1.5 rounded-lg bg-amber-600 hover:bg-amber-700 text-white text-xs font-bold"
                          >
                            確認沒有入帳，釋放帳號
                          </button>
                        )}
                        {canAct(item.status) && (
                          <>
                            <button
                              type="button"
                              data-testid={`prepay-verify-btn-${item.booking_ref}`}
                              onClick={() => openVerifyModal(item)}
                              className="px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold"
                            >
                              確認收款
                            </button>
                            <button
                              type="button"
                              data-testid={`prepay-mismatch-btn-${item.booking_ref}`}
                              onClick={() => {
                                setMismatchTarget(item);
                                setMismatchNote(item.admin_note || '');
                              }}
                              className="px-2.5 py-1.5 rounded-lg bg-red-50 hover:bg-red-100 text-red-700 border border-red-200 text-xs font-bold"
                            >
                              金額不符
                            </button>
                          </>
                        )}
                        {item.overpaid_amount > 0 && !item.overpaid_refunded_at && (
                          <button
                            type="button"
                            onClick={() => {
                              setOverpaidRefundTarget(item);
                              setOverpaidRefundNote('');
                            }}
                            className="px-2.5 py-1.5 rounded-lg bg-amber-600 hover:bg-amber-700 text-white text-xs font-bold"
                          >
                            已退還
                          </button>
                        )}
                        {item.status === 'pending_payment' && (
                          <button
                            type="button"
                            data-testid={`prepay-remind-btn-${item.booking_ref}`}
                            disabled={remindingRef === item.booking_ref}
                            onClick={() => handleRemind(item)}
                            className="px-2.5 py-1.5 rounded-lg bg-amber-50 hover:bg-amber-100 text-amber-800 border border-amber-200 text-xs font-bold disabled:opacity-50"
                          >
                            提醒付款
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Desktop Table (>= 768px) */}
            <div className="hidden md:block overflow-x-auto">
              <table className="w-full text-left text-sm whitespace-nowrap">
                <thead>
                  <tr className="bg-gray-50 text-gray-500 text-xs border-b border-gray-200">
                    <th className="px-4 py-3 font-medium">使用日期 / 時段</th>
                    <th className="px-4 py-3 font-medium">顧客與人數</th>
                    <th className="px-4 py-3 font-medium">內容</th>
                    <th className="px-4 py-3 font-medium text-right">應匯金額</th>
                    <th className="px-4 py-3 font-medium">付款方式 / 帳號</th>
                    <th className="px-4 py-3 font-medium">末五碼 / 回報時間</th>
                    <th className="px-4 py-3 font-medium">期限 / 狀態</th>
                    <th className="px-4 py-3 font-medium text-right">操作</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {items.map((item) => {
                    const badge = PREPAY_STATUS_BADGES[item.status] || PREPAY_STATUS_BADGES.pending_payment;
                    return (
                      <tr
                        key={item.booking_ref}
                        data-testid={`prepay-row-${item.booking_ref}`}
                        className={item.is_overdue ? 'bg-red-50/40' : 'hover:bg-gray-50'}
                      >
                        <td className="px-4 py-3">
                          <div className="font-semibold text-gray-900">{item.session_date}</div>
                          <div className="text-xs text-gray-500 font-mono">
                            {item.start_time}-{item.end_time}
                          </div>
                          <div className="text-[11px] font-mono text-sg-brown">{formatBookingRef(item.booking_ref)}</div>
                        </td>
                        <td className="px-4 py-3">
                          <div className="font-medium text-gray-900">
                            {item.user_name} <span className="text-xs text-gray-500">· {item.pax} 位</span>
                          </div>
                          <div className="text-xs text-gray-500 font-mono">{item.user_phone || '—'}</div>
                        </td>
                        <td className="px-4 py-3 text-xs text-gray-700">{renderContentSummary(item)}</td>
                        <td className="px-4 py-3 text-right font-mono font-bold text-sg-brown">
                          NT$ {item.amount_due.toLocaleString()}
                        </td>
                        <td className="px-4 py-3 max-w-[200px] whitespace-normal text-xs">
                          <div className="font-medium text-gray-800">{item.payment_method_name}</div>
                          <div className="text-gray-500 font-mono break-all">
                            {item.assigned_pool_account || item.selected_bank_info || '—'}
                          </div>
                        </td>
                        <td className="px-4 py-3">
                          <div className="font-mono font-bold text-gray-900">
                            {item.remittance_last5 || '—'}
                          </div>
                          {item.remittance_reported_at && (
                            <div className="text-[11px] text-gray-500 font-mono">
                              {formatDateTime(item.remittance_reported_at, 'MM/dd HH:mm')}
                            </div>
                          )}
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex flex-col items-start gap-1">
                            <span className={`text-[11px] font-bold px-2 py-0.5 rounded-full border ${badge.cls}`}>
                              {badge.label}
                            </span>
                            {item.status === 'reported_pending_verify' && /作廢入帳/.test(item.admin_note || '') && (
                              <span className="text-[11px] font-bold px-2 py-0.5 rounded-full bg-rose-100 text-rose-800 border border-rose-200">
                                入帳已作廢
                              </span>
                            )}
                            {item.deadline_at && (
                              <span className="text-[11px] text-gray-500 font-mono">
                                期限 {formatDateTime(item.deadline_at, 'MM/dd HH:mm')}
                              </span>
                            )}
                            {item.is_overdue && (
                              <span className="text-[11px] font-bold px-2 py-0.5 rounded-full bg-red-600 text-white">
                                已過期限，請儘快處理
                              </span>
                            )}
                            {item.admin_note && (
                              <span className="text-[11px] text-red-700 max-w-[180px] truncate" title={item.admin_note}>
                                {item.admin_note}
                              </span>
                            )}
                            {item.status === 'mismatch' && item.received_amount != null && item.shortfall > 0 && (
                              <span className="text-[11px] font-bold px-2 py-0.5 rounded-full bg-amber-50 text-amber-800 border border-amber-200">
                                已收 NT${item.received_amount.toLocaleString()}、還差 NT${item.shortfall.toLocaleString()}
                              </span>
                            )}
                            {item.overpaid_amount > 0 && !item.overpaid_refunded_at && (
                              <span className="text-[11px] font-bold px-2 py-0.5 rounded-full bg-amber-100 text-amber-900 border border-amber-300">
                                多收 NT${item.overpaid_amount.toLocaleString()}，待退還
                              </span>
                            )}
                            {item.overpaid_amount > 0 && item.overpaid_refunded_at && (
                              <span className="text-[11px] font-bold px-2 py-0.5 rounded-full bg-gray-100 text-gray-700 border border-gray-200">
                                已退還多收 NT${item.overpaid_amount.toLocaleString()}
                              </span>
                            )}
                            {(item.status === 'cancelled' || item.status === 'expired') && item.has_held_pool_account && (
                              <span
                                data-testid={`prepay-held-pool-badge-${item.booking_ref}`}
                                className="text-[11px] font-bold px-2 py-0.5 rounded-full bg-amber-100 text-amber-800 border border-amber-200"
                              >
                                帳號保留中（已回報匯款）
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="px-4 py-3 text-right">
                          <div className="inline-flex items-center gap-1.5">
                            {(item.status === 'cancelled' || item.status === 'expired') && item.has_held_pool_account && (
                              <button
                                type="button"
                                data-testid={`prepay-release-pool-btn-${item.booking_ref}`}
                                onClick={() => {
                                  setReleasePoolTarget(item);
                                  setReleasePoolNote('');
                                }}
                                className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-amber-600 hover:bg-amber-700 text-white text-xs font-bold"
                              >
                                確認沒有入帳，釋放帳號
                              </button>
                            )}
                            {canAct(item.status) && (
                              <>
                                <button
                                  type="button"
                                  data-testid={`prepay-verify-btn-${item.booking_ref}`}
                                  onClick={() => openVerifyModal(item)}
                                  className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold"
                                >
                                  <CheckCircle2 className="w-3.5 h-3.5" />
                                  確認收款
                                </button>
                                <button
                                  type="button"
                                  data-testid={`prepay-mismatch-btn-${item.booking_ref}`}
                                  onClick={() => {
                                    setMismatchTarget(item);
                                    setMismatchNote(item.admin_note || '');
                                  }}
                                  className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-red-50 hover:bg-red-100 text-red-700 border border-red-200 text-xs font-bold"
                                >
                                  <AlertTriangle className="w-3.5 h-3.5" />
                                  金額不符
                                </button>
                              </>
                            )}
                            {item.overpaid_amount > 0 && !item.overpaid_refunded_at && (
                              <button
                                type="button"
                                data-testid={`prepay-overpaid-refund-btn-${item.booking_ref}`}
                                onClick={() => {
                                  setOverpaidRefundTarget(item);
                                  setOverpaidRefundNote('');
                                }}
                                className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-amber-600 hover:bg-amber-700 text-white text-xs font-bold"
                              >
                                已退還
                              </button>
                            )}
                            {item.status === 'pending_payment' && (
                              <button
                                type="button"
                                data-testid={`prepay-remind-btn-${item.booking_ref}`}
                                disabled={remindingRef === item.booking_ref}
                                onClick={() => handleRemind(item)}
                                className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-amber-50 hover:bg-amber-100 text-amber-800 border border-amber-200 text-xs font-bold disabled:opacity-50"
                              >
                                <Bell className="w-3.5 h-3.5" />
                                提醒付款
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>

      {/* Pagination Bar */}
      {total > 0 && (
        <div className="flex items-center justify-between text-xs text-gray-600 bg-white rounded-xl border border-gray-200 px-4 py-2.5">
          <span>共 {total} 筆（第 {page} / {totalPages} 頁）</span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={page <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              className="px-3 py-1 rounded-lg border border-gray-200 font-bold disabled:opacity-40 hover:bg-gray-50"
            >
              上一頁
            </button>
            <button
              type="button"
              disabled={page >= totalPages}
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              className="px-3 py-1 rounded-lg border border-gray-200 font-bold disabled:opacity-40 hover:bg-gray-50"
            >
              下一頁
            </button>
          </div>
        </div>
      )}

      {/* Bottom Help Note */}
      <div className="text-xs text-gray-500 bg-gray-50 rounded-xl px-4 py-3 border border-gray-200 leading-relaxed">
        確認收款後，顧客的預約頁會變成「已確認」，並收到 LINE 通知。超過付款期限還沒付款的預約，系統會自動取消並釋出名額；已經回報末五碼的不會自動取消，請在這裡處理。
      </div>

      {/* Verify Received Amount Modal */}
      {verifyTarget && (
        <div role="dialog" aria-modal="true" className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
          <form
            onSubmit={handleConfirmVerify}
            className="bg-white rounded-2xl shadow-xl max-w-md w-full p-5 space-y-4"
          >
            <div>
              <h4 className="text-base font-bold text-gray-900">確認已收到匯款並入帳？</h4>
              <div className="text-xs text-gray-600 mt-1.5 space-y-1">
                <div>顧客：{verifyTarget.user_name}（{verifyTarget.session_date} {verifyTarget.start_time}-{verifyTarget.end_time}）</div>
                <div className="font-bold text-sg-brown">應匯金額：NT$ {verifyTarget.amount_due.toLocaleString()}</div>
                {verifyTarget.received_amount > 0 && (
                  <div className="font-bold text-amber-700">
                    已累計實收：NT$ {verifyTarget.received_amount.toLocaleString()}
                    {verifyTarget.amount_due > verifyTarget.received_amount
                      ? `（尚差 NT$ ${(verifyTarget.amount_due - verifyTarget.received_amount).toLocaleString()}）`
                      : ''}
                  </div>
                )}
                <div>回報末五碼：{verifyTarget.remittance_last5 || '尚未填寫'}</div>
                {verifyTarget.pass_persons > 0 && (
                  <div>另有 {verifyTarget.pass_persons} 位用計次不限時卡，已扣次</div>
                )}
              </div>
            </div>

            {verifyTarget.amount_due > 0 && (
              <div>
                <label className="block text-xs font-bold text-gray-700 mb-1">
                  這次查到的入帳金額
                </label>
                <input
                  type="number"
                  min={1}
                  step={1}
                  required
                  data-testid="prepay-received-amount-input"
                  value={verifyReceivedInput}
                  onChange={(e) => setVerifyReceivedInput(e.target.value)}
                  placeholder="請輸入實際入帳整數金額"
                  className="w-full rounded-xl border border-gray-300 px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-sg-brown"
                />
              </div>
            )}

            <div className="flex justify-end gap-2">
              <button
                type="button"
                disabled={verifying}
                onClick={() => setVerifyTarget(null)}
                className="px-4 py-2 rounded-xl border border-gray-200 text-sm font-medium text-gray-700 hover:bg-gray-50"
              >
                取消
              </button>
              <button
                type="submit"
                data-testid="prepay-confirm-submit-btn"
                disabled={verifying}
                className="px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-bold disabled:opacity-50"
              >
                {verifying ? '處理中...' : '確認收款'}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Overpaid Refunded Modal */}
      {overpaidRefundTarget && (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
          <form
            onSubmit={handleSubmitOverpaidRefund}
            className="bg-white rounded-2xl shadow-xl max-w-md w-full p-5 space-y-4"
          >
            <div>
              <h3 className="text-base font-bold text-gray-900">記錄已退還多收金額</h3>
              <p className="text-xs text-gray-500 mt-1">
                {overpaidRefundTarget.user_name} · {formatBookingRef(overpaidRefundTarget.booking_ref)}（多收 NT$ {(overpaidRefundTarget.overpaid_amount || 0).toLocaleString()}）
              </p>
            </div>
            <div>
              <label className="block text-xs font-bold text-gray-700 mb-1">
                退還說明／備註（必填）
              </label>
              <input
                type="text"
                required
                data-testid="prepay-overpaid-note-input"
                value={overpaidRefundNote}
                onChange={(e) => setOverpaidRefundNote(e.target.value)}
                placeholder="例如：已轉回客人帳戶"
                className="w-full rounded-xl border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-sg-brown"
              />
            </div>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                disabled={submittingOverpaidRefund}
                onClick={() => setOverpaidRefundTarget(null)}
                className="px-4 py-2 rounded-xl border border-gray-200 text-sm font-medium text-gray-700 hover:bg-gray-50"
              >
                取消
              </button>
              <button
                type="submit"
                data-testid="prepay-overpaid-submit-btn"
                disabled={submittingOverpaidRefund || !overpaidRefundNote.trim()}
                className="px-4 py-2 rounded-xl bg-amber-600 hover:bg-amber-700 text-white text-sm font-bold disabled:opacity-50"
              >
                {submittingOverpaidRefund ? '儲存中...' : '確認已退還'}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Release Held Pool Account Modal */}
      {releasePoolTarget && (
        <div role="dialog" aria-modal="true" className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
          <form
            onSubmit={handleSubmitReleasePool}
            className="bg-white rounded-2xl shadow-xl max-w-md w-full p-5 space-y-4"
          >
            <div>
              <h3 className="text-base font-bold text-gray-900">確認沒有入帳，釋放帳號</h3>
              <p className="text-xs text-gray-500 mt-1">
                {releasePoolTarget.user_name} · {formatBookingRef(releasePoolTarget.booking_ref)}（帳號 {releasePoolTarget.assigned_pool_account}）
              </p>
            </div>
            <div>
              <label className="block text-xs font-bold text-gray-700 mb-1">
                查帳確認說明（必填）
              </label>
              <textarea
                rows={3}
                required
                data-testid="prepay-release-pool-note"
                value={releasePoolNote}
                onChange={(e) => setReleasePoolNote(e.target.value)}
                placeholder="例如：已核對網銀明細，確認無匯款入帳"
                className="w-full rounded-xl border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-sg-brown"
              />
            </div>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                disabled={releasingPool}
                onClick={() => setReleasePoolTarget(null)}
                className="px-4 py-2 rounded-xl border border-gray-200 text-sm font-medium text-gray-700 hover:bg-gray-50"
              >
                取消
              </button>
              <button
                type="submit"
                data-testid="prepay-release-pool-submit"
                disabled={releasingPool || !releasePoolNote.trim()}
                className="px-4 py-2 rounded-xl bg-amber-600 hover:bg-amber-700 text-white text-sm font-bold disabled:opacity-50"
              >
                {releasingPool ? '釋放中...' : '確認沒有入帳，釋放帳號'}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Mismatch Modal */}
      {mismatchTarget && (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
          <form
            onSubmit={handleSubmitMismatch}
            className="bg-white rounded-2xl shadow-xl max-w-md w-full p-5 space-y-4"
          >
            <div>
              <h3 className="text-base font-bold text-gray-900">標記金額不符</h3>
              <p className="text-xs text-gray-500 mt-1">
                {mismatchTarget.user_name} · {formatBookingRef(mismatchTarget.booking_ref)}（應匯 NT$ {mismatchTarget.amount_due.toLocaleString()}）
              </p>
            </div>
            <div>
              <label className="block text-xs font-bold text-gray-700 mb-1">
                不符原因／備註（將附於 LINE 通知）
              </label>
              <textarea
                rows={3}
                required
                value={mismatchNote}
                onChange={(e) => setMismatchNote(e.target.value)}
                placeholder="例如：實收金額僅 NT$ 500，與應匯 NT$ 750 不符"
                className="w-full rounded-xl border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-sg-brown"
              />
            </div>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                disabled={submittingMismatch}
                onClick={() => setMismatchTarget(null)}
                className="px-4 py-2 rounded-xl border border-gray-200 text-sm font-medium text-gray-700 hover:bg-gray-50"
              >
                取消
              </button>
              <button
                type="submit"
                disabled={submittingMismatch || !mismatchNote.trim()}
                className="px-4 py-2 rounded-xl bg-red-600 hover:bg-red-700 text-white text-sm font-bold disabled:opacity-50"
              >
                {submittingMismatch ? '處理中...' : '送出並通知顧客'}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
