import React, { useState, useEffect, useMemo } from 'react';
import {
  DollarSign,
  FileText,
  AlertTriangle,
  Printer,
  RotateCcw,
  Clock,
  CheckCircle2,
  XCircle,
  HelpCircle,
  Search,
  Calendar,
  Filter,
  Eye,
  Check,
  ChevronRight,
  ChevronDown,
  MoreVertical
} from 'lucide-react';
import api from '../../api/axios';
import SegmentedTabs from '../../components/admin/SegmentedTabs';
import StatusPill from '../../components/admin/StatusPill';
import ResponsivePanel from '../../components/admin/ResponsivePanel';
import ReasonChips from '../../components/admin/ReasonChips';
import MoneyInput from '../../components/admin/MoneyInput';
import ConfirmPanel from '../../components/admin/ConfirmPanel';
import Button from '../../components/customer/Button';
import CheckoutWorkbench from '../../components/admin/checkout/CheckoutWorkbench';
import ReservationDetailsModal from '../../components/ReservationDetailsModal';
import { printJobOnThisDevice } from '../../utils/sunmiPrinter';
import { buildClosingSlip, commandsToPreviewHtml } from '@shared/receipts.js';
import { toTaipeiDateString } from '@shared/time.js';

export default function AccountingPage() {
  const [activeTab, setActiveTab] = useState('payments');

  // Today string in Asia/Taipei
  const todayStr = useMemo(() => {
    return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Taipei' });
  }, []);

  // Shared state
  const [dateFrom, setDateFrom] = useState(todayStr);
  const [dateTo, setDateTo] = useState(todayStr);
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedStaff, setSelectedStaff] = useState('');
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  // Tab 1: Payments list state
  const [payments, setPayments] = useState([]);
  const [summary, setSummary] = useState(null);
  const [paymentKindFilter, setPaymentKindFilter] = useState('all');
  const [paymentMethodFilter, setPaymentMethodFilter] = useState('all');
  const [loadingPayments, setLoadingPayments] = useState(false);

  // Tab 2: Audit events state
  const [events, setEvents] = useState([]);
  const [eventCategoryFilter, setEventCategoryFilter] = useState('all');
  const [selectedEventDetail, setSelectedEventDetail] = useState(null);
  const [loadingEvents, setLoadingEvents] = useState(false);

  // Tab 3: Print jobs state
  const [printJobs, setPrintJobs] = useState([]);
  const [printStatusFilter, setPrintStatusFilter] = useState('all');
  const [loadingPrintJobs, setLoadingPrintJobs] = useState(false);

  // Tab 4: Closing state
  const [closingPreview, setClosingPreview] = useState(null);
  const [closingsList, setClosingsList] = useState([]);
  const [countedCash, setCountedCash] = useState(0);
  const [closingFloat, setClosingFloat] = useState(2000);
  const [closingNote, setClosingNote] = useState('');
  const [closingSubmitting, setClosingSubmitting] = useState(false);
  const [showClosingPreviewModal, setShowClosingPreviewModal] = useState(false);
  const [closingSlipHtml, setClosingSlipHtml] = useState('');

  // Tab 5: Unpaid follow-up state
  const [unpaidList, setUnpaidList] = useState([]);
  const [loadingUnpaid, setLoadingUnpaid] = useState(false);

  // Void payment modal state
  const [voidPaymentTarget, setVoidPaymentTarget] = useState(null);
  const [voidReason, setVoidReason] = useState('收錯付款方式');
  const [voidLoading, setVoidLoading] = useState(false);

  // Modals
  const [checkoutBookingRef, setCheckoutBookingRef] = useState(null);
  const [detailsReservation, setDetailsReservation] = useState(null);

  // Toast
  const [toastMsg, setToastMsg] = useState(null);
  const showToast = (msg) => {
    setToastMsg(msg);
    setTimeout(() => setToastMsg(null), 3000);
  };

  // Fetch Payments & Summary
  const fetchPayments = async () => {
    try {
      setLoadingPayments(true);
      const [sumRes, payRes] = await Promise.all([
        api.get('/accounting/summary', { params: { start_date: dateFrom, end_date: dateTo } }),
        api.get('/accounting/payments', {
          params: {
            date_from: dateFrom,
            date_to: dateTo,
            kind: paymentKindFilter !== 'all' ? paymentKindFilter : undefined,
            method: paymentMethodFilter !== 'all' ? paymentMethodFilter : undefined,
            staff: selectedStaff || undefined,
            q: searchTerm || undefined
          }
        })
      ]);
      setSummary(sumRes.data);
      setPayments(payRes.data?.payments || []);
    } catch (err) {
      console.error(err);
    } finally {
      setLoadingPayments(false);
    }
  };

  // Fetch Events
  const fetchEvents = async () => {
    try {
      setLoadingEvents(true);
      const res = await api.get('/accounting/events', {
        params: {
          date_from: dateFrom,
          date_to: dateTo,
          category: eventCategoryFilter !== 'all' ? eventCategoryFilter : undefined,
          staff: selectedStaff || undefined,
          q: searchTerm || undefined
        }
      });
      setEvents(res.data?.events || []);
    } catch (err) {
      console.error(err);
    } finally {
      setLoadingEvents(false);
    }
  };

  // Fetch Print Jobs
  const fetchPrintJobs = async () => {
    try {
      setLoadingPrintJobs(true);
      const res = await api.get('/accounting/print-jobs', {
        params: {
          date: dateFrom,
          status: printStatusFilter !== 'all' ? printStatusFilter : undefined
        }
      });
      setPrintJobs(res.data?.print_jobs || []);
    } catch (err) {
      console.error(err);
    } finally {
      setLoadingPrintJobs(false);
    }
  };

  // Fetch Closing Preview & History
  const fetchClosing = async () => {
    try {
      const [prevRes, listRes] = await Promise.all([
        api.get('/accounting/closing/preview', { params: { date: dateFrom } }),
        api.get('/accounting/closings', { params: { date: dateFrom } })
      ]);
      setClosingPreview(prevRes.data);
      setClosingFloat(prevRes.data?.float_amount ?? 2000);
      setCountedCash(prevRes.data?.expected_cash ?? 0);
      setClosingsList(listRes.data?.closings || []);
    } catch (err) {
      console.error(err);
    }
  };

  // Fetch Unpaid
  const fetchUnpaid = async () => {
    try {
      setLoadingUnpaid(true);
      const res = await api.get('/accounting/unpaid');
      setUnpaidList(res.data?.unpaid || res.data?.reservations || []);
    } catch (err) {
      console.error(err);
    } finally {
      setLoadingUnpaid(false);
    }
  };

  useEffect(() => {
    if (activeTab === 'payments') fetchPayments();
    else if (activeTab === 'events') fetchEvents();
    else if (activeTab === 'print-jobs') fetchPrintJobs();
    else if (activeTab === 'closing') fetchClosing();
    else if (activeTab === 'unpaid') fetchUnpaid();
  }, [activeTab, dateFrom, dateTo, paymentKindFilter, paymentMethodFilter, eventCategoryFilter, printStatusFilter, selectedStaff]);

  // Void payment
  const handleConfirmVoid = async () => {
    if (!voidPaymentTarget) return;
    try {
      setVoidLoading(true);
      await api.post(`/billing/payments/${voidPaymentTarget.id}/void`, {
        reason: voidReason
      });
      setVoidPaymentTarget(null);
      fetchPayments();
      showToast(`已作廢收款 ${voidPaymentTarget.payment_no}`);
    } catch (err) {
      showToast(err.response?.data?.error || '作廢失敗');
    } finally {
      setVoidLoading(false);
    }
  };

  // Reprint payment
  const handleReprintPayment = async (pay) => {
    try {
      const res = await api.post('/print/jobs', {
        type: 'receipt',
        payment_id: pay.id,
        booking_ref: pay.booking_ref,
        is_reprint: true
      });
      if (res.data?.job) {
        await printJobOnThisDevice(res.data.job);
      }
      showToast('補印收據已送出');
    } catch (err) {
      showToast(err.response?.data?.error || '補印失敗');
    }
  };

  // Submit daily closing
  const handleSubmitClosing = async () => {
    try {
      setClosingSubmitting(true);
      const res = await api.post('/accounting/closing', {
        date: dateFrom,
        float_amount: closingFloat,
        counted_cash: countedCash,
        note: closingNote,
        print: true
      });
      fetchClosing();
      showToast('完成交班日結！');
    } catch (err) {
      showToast(err.response?.data?.error || '日結交班失敗');
    } finally {
      setClosingSubmitting(false);
    }
  };

  // Preview closing slip
  const handlePreviewClosingSlip = () => {
    if (!closingPreview) return;
    try {
      const diff = (countedCash || 0) - (closingPreview.expected_cash || 0);
      const cmds = buildClosingSlip(
        dateFrom,
        {
          float_amount: closingFloat,
          expected_cash: closingPreview.expected_cash,
          counted_cash: countedCash,
          difference: diff
        },
        {
          net_revenue: closingPreview.net_revenue,
          by_method: closingPreview.by_method,
          refunds: closingPreview.refunds,
          void_count: closingPreview.voids?.count,
          void_amount: closingPreview.voids?.amount,
          unpaid_count: closingPreview.unpaid?.count,
          unpaid_amount: closingPreview.unpaid?.amount
        }
      );
      setClosingSlipHtml(commandsToPreviewHtml(cmds));
      setShowClosingPreviewModal(true);
    } catch (err) {
      console.error(err);
    }
  };

  // Format payment method
  const getMethodLabel = (m) => {
    switch (m) {
      case 'cash': return '現金';
      case 'line_pay': return 'LINE Pay';
      case 'jkopay': return '街口支付';
      case 'card': return '刷卡';
      case 'transfer': return '銀行轉帳';
      case 'pass': return '卡券折抵';
      case 'other': return '其他';
      default: return m || '其他';
    }
  };

  return (
    <div className="space-y-4 max-w-7xl mx-auto pb-12">
      {/* Toast */}
      {toastMsg && (
        <div className="fixed top-4 right-4 z-50 bg-sg-ink text-white px-4 py-2.5 rounded-2xl shadow-lg text-[13px] font-bold animate-fade-in">
          {toastMsg}
        </div>
      )}

      {/* Top Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 bg-white p-4 rounded-3xl border border-sg-line shadow-xs">
        <div>
          <h1 className="text-[18px] font-bold text-sg-ink">帳務管理</h1>
          <p className="text-[12px] text-sg-muted">
            收支結算、日結交班、異動審計與列印佇列監控
          </p>
        </div>

        {/* Desktop Tabs (sm and above) */}
        <div className="hidden sm:flex items-center gap-2">
          <SegmentedTabs
            tabs={[
              { id: 'payments', label: '收款明細' },
              { id: 'events', label: '異動紀錄' },
              { id: 'print-jobs', label: '列印紀錄' },
              { id: 'closing', label: '日結' },
              { id: 'unpaid', label: `未結追蹤 ${summary?.unpaid?.count ? `(${summary.unpaid.count})` : ''}` }
            ]}
            activeTab={activeTab}
            onChange={setActiveTab}
          />

          {activeTab === 'closing' && (
            <Button variant="secondary" size="sm" onClick={handlePreviewClosingSlip}>
              <Printer className="w-4 h-4 mr-1 text-sg-muted" />
              列印日結單
            </Button>
          )}
        </div>

        {/* Mobile Tabs (below sm) - Spec 6.22 */}
        <div className="flex sm:hidden items-center justify-between gap-1 w-full">
          <SegmentedTabs
            tabs={[
              { id: 'closing', label: '日結' },
              { id: 'events', label: '異動' },
              { id: 'unpaid', label: `未結${summary?.unpaid?.count ? ` ${summary.unpaid.count}` : ''}` }
            ]}
            activeTab={['closing', 'events', 'unpaid'].includes(activeTab) ? activeTab : null}
            onChange={(tab) => {
              setActiveTab(tab);
              setMobileMenuOpen(false);
            }}
          />

          {/* More menu for 'payments' and 'print-jobs' */}
          <div className="relative">
            <button
              type="button"
              onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
              className={`p-2 rounded-2xl border transition ${
                ['payments', 'print-jobs'].includes(activeTab)
                  ? 'bg-sg-brown text-white border-sg-brown'
                  : 'bg-white text-sg-ink border-sg-line hover:border-sg-muted'
              }`}
              title="更多分頁"
            >
              <MoreVertical className="w-4 h-4" />
            </button>

            {mobileMenuOpen && (
              <div className="absolute right-0 top-full mt-1.5 w-36 bg-white border border-sg-line rounded-2xl shadow-lg z-30 py-1.5 text-[13px]">
                <button
                  type="button"
                  onClick={() => {
                    setActiveTab('payments');
                    setMobileMenuOpen(false);
                  }}
                  className={`w-full text-left px-3 py-2 font-bold transition flex items-center justify-between ${
                    activeTab === 'payments' ? 'bg-sg-paper text-sg-brown' : 'text-sg-ink hover:bg-sg-paper/60'
                  }`}
                >
                  <span>收款明細</span>
                  {activeTab === 'payments' && <Check className="w-3.5 h-3.5 text-sg-brown" />}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setActiveTab('print-jobs');
                    setMobileMenuOpen(false);
                  }}
                  className={`w-full text-left px-3 py-2 font-bold transition flex items-center justify-between ${
                    activeTab === 'print-jobs' ? 'bg-sg-paper text-sg-brown' : 'text-sg-ink hover:bg-sg-paper/60'
                  }`}
                >
                  <span>列印紀錄</span>
                  {activeTab === 'print-jobs' && <Check className="w-3.5 h-3.5 text-sg-brown" />}
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Date & Search Filter Bar (for tabs 1, 2, 3) */}
      {activeTab !== 'unpaid' && (
        <div className="flex flex-wrap items-center justify-between gap-2 bg-white p-3 rounded-2xl border border-sg-line text-[12px]">
          <div className="flex items-center gap-2">
            <span className="text-sg-muted">日期區間：</span>
            <input
              type="date"
              value={dateFrom}
              onChange={(e) => setDateFrom(e.target.value)}
              className="px-2.5 py-1 rounded-xl border border-sg-line text-[12px]"
            />
            <span className="text-sg-muted">至</span>
            <input
              type="date"
              value={dateTo}
              onChange={(e) => setDateTo(e.target.value)}
              className="px-2.5 py-1 rounded-xl border border-sg-line text-[12px]"
            />
            <button
              type="button"
              onClick={() => {
                setDateFrom(todayStr);
                setDateTo(todayStr);
              }}
              className="text-sg-brown font-bold hover:underline px-1"
            >
              今天
            </button>
          </div>

          <div className="flex items-center gap-2">
            <div className="relative">
              <Search className="w-3.5 h-3.5 text-sg-muted absolute left-2.5 top-2" />
              <input
                type="text"
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    if (activeTab === 'payments') fetchPayments();
                    else if (activeTab === 'events') fetchEvents();
                  }
                }}
                placeholder="搜尋單號、姓名、收款號"
                className="pl-8 pr-3 py-1 rounded-xl border border-sg-line text-[12px] w-48"
              />
            </div>
          </div>
        </div>
      )}

      {/* TAB 1: PAYMENTS LIST (收款明細) */}
      {activeTab === 'payments' && (
        <div className="space-y-4">
          {/* Summary Cards */}
          {summary && (
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
              <div className="p-3.5 rounded-2xl bg-white border border-sg-line">
                <span className="text-sg-muted text-[11px] block">實收淨額</span>
                <span className="text-[18px] font-bold text-sg-ink font-num">
                  NT${summary.net_revenue}
                </span>
              </div>
              <div className="p-3.5 rounded-2xl bg-white border border-sg-line">
                <span className="text-sg-muted text-[11px] block">現金實收</span>
                <span className="text-[18px] font-bold text-sg-ink font-num">
                  NT${summary.by_method?.cash?.amount || 0}
                </span>
              </div>
              <div className="p-3.5 rounded-2xl bg-white border border-sg-line">
                <span className="text-sg-muted text-[11px] block">LINE Pay</span>
                <span className="text-[18px] font-bold text-sg-ink font-num">
                  NT${summary.by_method?.line_pay?.amount || 0}
                </span>
              </div>
              <div className="p-3.5 rounded-2xl bg-white border border-sg-line">
                <span className="text-sg-muted text-[11px] block">退款合計</span>
                <span className="text-[18px] font-bold text-sg-danger font-num">
                  -NT${summary.total_refunds || 0}
                </span>
              </div>
              <div className="p-3.5 rounded-2xl bg-white border border-sg-line">
                <span className="text-sg-muted text-[11px] block">卡券折抵額</span>
                <span className="text-[18px] font-bold text-sg-brown font-num">
                  NT${summary.pass_value || 0}
                </span>
              </div>
            </div>
          )}

          {/* Filter Bar */}
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[12px] text-sg-muted">種類：</span>
            {['all', 'charge', 'supplement', 'refund', 'waive'].map((k) => (
              <button
                key={k}
                type="button"
                onClick={() => setPaymentKindFilter(k)}
                className={`px-2.5 py-1 rounded-xl text-[11px] font-bold border ${
                  paymentKindFilter === k
                    ? 'bg-sg-brown text-white border-sg-brown'
                    : 'bg-white text-sg-ink border-sg-line'
                }`}
              >
                {k === 'all' ? '全部種類' : k === 'charge' ? '收款' : k === 'supplement' ? '補收' : k === 'refund' ? '退款' : '免收'}
              </button>
            ))}

            <span className="text-[12px] text-sg-muted ml-3">方式：</span>
            {['all', 'cash', 'line_pay', 'card', 'transfer', 'pass'].map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setPaymentMethodFilter(m)}
                className={`px-2.5 py-1 rounded-xl text-[11px] font-bold border ${
                  paymentMethodFilter === m
                    ? 'bg-sg-brown text-white border-sg-brown'
                    : 'bg-white text-sg-ink border-sg-line'
                }`}
              >
                {m === 'all' ? '全部方式' : getMethodLabel(m)}
              </button>
            ))}
          </div>

          {/* Table */}
          <div className="bg-white rounded-3xl border border-sg-line overflow-hidden shadow-xs">
            <table className="w-full text-left border-collapse text-[13px]">
              <thead>
                <tr className="bg-sg-paper/80 border-b border-sg-line text-[12px] text-sg-muted">
                  <th className="py-2.5 px-3 font-semibold">時間</th>
                  <th className="py-2.5 px-3 font-semibold">收款編號</th>
                  <th className="py-2.5 px-3 font-semibold">預約單號</th>
                  <th className="py-2.5 px-2 font-semibold">顧客</th>
                  <th className="py-2.5 px-2 font-semibold">種類</th>
                  <th className="py-2.5 px-2 font-semibold">方式</th>
                  <th className="py-2.5 px-3 font-semibold text-right">金額</th>
                  <th className="py-2.5 px-3 font-semibold">經手店員</th>
                  <th className="py-2.5 px-3 font-semibold text-right">操作</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-sg-line">
                {loadingPayments ? (
                  <tr>
                    <td colSpan={9} className="py-12 text-center text-sg-muted">載入明細中...</td>
                  </tr>
                ) : payments.length === 0 ? (
                  <tr>
                    <td colSpan={9} className="py-12 text-center text-sg-muted">尚無符合條件的收款紀錄</td>
                  </tr>
                ) : (
                  payments.map((p) => {
                    const isVoided = p.status === 'voided';
                    const timeStr = new Date(p.created_at).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Taipei' });

                    return (
                      <tr
                        key={p.id}
                        className={`transition ${isVoided ? 'bg-sg-paper/50 opacity-60 line-through' : 'hover:bg-sg-paper/30'}`}
                      >
                        <td className="py-3 px-3 font-mono text-[12px] text-sg-muted">{timeStr}</td>
                        <td className="py-3 px-3 font-mono font-bold text-sg-ink text-[12px]">{p.payment_no}</td>
                        <td className="py-3 px-3 font-mono text-[12px] text-sg-brown font-bold">{p.booking_ref}</td>
                        <td className="py-3 px-2 font-bold text-sg-ink">
                          {p.breakdown_json?.customer_name || '現場顧客'}
                        </td>
                        <td className="py-3 px-2">
                          <span className={`px-2 py-0.5 rounded-lg text-[10px] font-bold ${
                            p.kind === 'refund' ? 'bg-sg-danger-soft text-sg-danger' :
                            p.kind === 'supplement' ? 'bg-sg-honey-soft text-sg-honey' :
                            p.kind === 'waive' ? 'bg-sg-paper text-sg-muted' :
                            'bg-sg-sage-soft text-sg-sage-ink'
                          }`}>
                            {p.kind === 'refund' ? '退款' : p.kind === 'supplement' ? '補收' : p.kind === 'waive' ? '免收' : '收款'}
                          </span>
                        </td>
                        <td className="py-3 px-2 text-[12px] text-sg-ink">
                          {getMethodLabel(p.method)}
                        </td>
                        <td className="py-3 px-3 text-right font-bold text-sg-ink font-num">
                          {p.kind === 'refund' ? `-NT$${p.amount}` : `NT$${p.amount}`}
                        </td>
                        <td className="py-3 px-3 text-[12px]">
                          <span className="font-bold text-sg-ink">{p.staff_name || '門市人員'}</span>
                          {p.device_label && (
                            <span className="block text-[10px] text-sg-muted">{p.device_label}</span>
                          )}
                        </td>
                        <td className="py-3 px-3 text-right space-x-2">
                          <button
                            type="button"
                            onClick={() => handleReprintPayment(p)}
                            className="text-sg-brown font-bold text-[12px] hover:underline"
                          >
                            補印
                          </button>
                          {!isVoided && (
                            <button
                              type="button"
                              onClick={() => {
                                setVoidPaymentTarget(p);
                                setVoidReason('收錯付款方式');
                              }}
                              className="text-sg-danger font-bold text-[12px] hover:underline"
                            >
                              作廢
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* TAB 2: AUDIT EVENTS (異動紀錄) */}
      {activeTab === 'events' && (
        <div className="space-y-4">
          {/* Category Chips */}
          <div className="flex flex-wrap items-center gap-1.5">
            {[
              { key: 'all', label: '全部' },
              { key: 'charge', label: '收款' },
              { key: 'void', label: '作廢' },
              { key: 'refund', label: '退款' },
              { key: 'amount_change', label: '改金額' },
              { key: 'print', label: '列印' },
              { key: 'more', label: '更多 (免收/卡券/交班)' }
            ].map((c) => (
              <button
                key={c.key}
                type="button"
                onClick={() => setEventCategoryFilter(c.key)}
                className={`px-3 py-1 rounded-2xl text-[12px] font-bold border transition ${
                  eventCategoryFilter === c.key
                    ? 'bg-sg-brown text-white border-sg-brown'
                    : 'bg-white text-sg-ink border-sg-line'
                }`}
              >
                {c.label}
              </button>
            ))}
          </div>

          {/* Table */}
          <div className="bg-white rounded-3xl border border-sg-line overflow-hidden shadow-xs">
            <table className="w-full text-left border-collapse text-[13px]">
              <thead>
                <tr className="bg-sg-paper/80 border-b border-sg-line text-[12px] text-sg-muted">
                  <th className="py-2.5 px-3 font-semibold">時間</th>
                  <th className="py-2.5 px-3 font-semibold">誰</th>
                  <th className="py-2.5 px-3 font-semibold">訂單</th>
                  <th className="py-2.5 px-3 font-semibold">做了什麼</th>
                  <th className="py-2.5 px-3 font-semibold text-right">類別</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-sg-line">
                {loadingEvents ? (
                  <tr>
                    <td colSpan={5} className="py-12 text-center text-sg-muted">載入異動紀錄中...</td>
                  </tr>
                ) : events.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="py-12 text-center text-sg-muted">尚無符合的異動紀錄</td>
                  </tr>
                ) : (
                  events.map((ev) => {
                    const isSensitive = ev.category === 'void' || ev.category === 'refund' || ev.category === 'amount_change';
                    const timeStr = new Date(ev.created_at).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Taipei' });

                    return (
                      <tr
                        key={ev.id}
                        onClick={() => setSelectedEventDetail(ev)}
                        className={`cursor-pointer transition ${
                          isSensitive ? 'bg-sg-honey-soft/30 hover:bg-sg-honey-soft/50' : 'hover:bg-sg-paper/30'
                        }`}
                      >
                        <td className="py-3 px-3 font-mono text-[12px] text-sg-muted">{timeStr}</td>
                        <td className="py-3 px-3 text-[12px]">
                          <span className="font-bold text-sg-ink block">{ev.staff_name || '門市人員'}</span>
                          <span className="text-[10px] text-sg-muted">{ev.device_label || '裝置'}</span>
                        </td>
                        <td className="py-3 px-3 font-mono text-[12px] text-sg-brown font-bold">
                          {ev.booking_ref || '-'}
                        </td>
                        <td className="py-3 px-3 text-[13px] text-sg-ink font-medium">
                          {ev.summary}
                          {ev.reason && (
                            <span className="text-[11px] text-sg-muted block">原因：{ev.reason}</span>
                          )}
                        </td>
                        <td className="py-3 px-3 text-right">
                          <span className={`px-2 py-0.5 rounded-lg text-[10px] font-bold ${
                            ev.category === 'void' ? 'bg-sg-danger-soft text-sg-danger' :
                            ev.category === 'refund' ? 'bg-sg-peach-soft text-sg-peach' :
                            'bg-sg-paper text-sg-muted'
                          }`}>
                            {ev.category}
                          </span>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>

          <p className="text-[11px] text-sg-muted text-center">
            每一筆都記錄改之前和改之後的內容，不能刪除；作廢、退款、改金額一定要填原因。
          </p>
        </div>
      )}

      {/* TAB 3: PRINT JOBS (列印紀錄) */}
      {activeTab === 'print-jobs' && (
        <div className="space-y-4">
          <div className="bg-white rounded-3xl border border-sg-line overflow-hidden shadow-xs">
            <table className="w-full text-left border-collapse text-[13px]">
              <thead>
                <tr className="bg-sg-paper/80 border-b border-sg-line text-[12px] text-sg-muted">
                  <th className="py-2.5 px-3 font-semibold">編號</th>
                  <th className="py-2.5 px-3 font-semibold">標題</th>
                  <th className="py-2.5 px-3 font-semibold">來源裝置</th>
                  <th className="py-2.5 px-3 font-semibold">狀態</th>
                  <th className="py-2.5 px-3 font-semibold">送出時間</th>
                  <th className="py-2.5 px-3 font-semibold text-right">操作</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-sg-line">
                {loadingPrintJobs ? (
                  <tr>
                    <td colSpan={6} className="py-12 text-center text-sg-muted">載入列印紀錄中...</td>
                  </tr>
                ) : printJobs.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="py-12 text-center text-sg-muted">尚無列印工作紀錄</td>
                  </tr>
                ) : (
                  printJobs.map((job) => {
                    const timeStr = new Date(job.created_at).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Taipei' });

                    return (
                      <tr key={job.id} className="hover:bg-sg-paper/30 transition">
                        <td className="py-3 px-3 font-mono font-bold text-sg-ink text-[12px]">#{job.id}</td>
                        <td className="py-3 px-3 font-bold text-sg-ink text-[13px]">{job.title || job.type}</td>
                        <td className="py-3 px-3 text-[12px] text-sg-muted">{job.source_device || '門市端'}</td>
                        <td className="py-3 px-3">
                          <span className={`px-2 py-0.5 rounded-lg text-[10px] font-bold ${
                            job.status === 'succeeded' ? 'bg-sg-sage-soft text-sg-sage-ink' :
                            job.status === 'failed' ? 'bg-sg-danger-soft text-sg-danger' :
                            job.status === 'claimed' ? 'bg-sg-honey-soft text-sg-honey' :
                            'bg-sg-paper text-sg-muted'
                          }`}>
                            {job.status === 'succeeded' ? '已印出' : job.status === 'failed' ? '失敗' : job.status === 'claimed' ? '列印中' : '排隊中'}
                          </span>
                        </td>
                        <td className="py-3 px-3 font-mono text-[12px] text-sg-muted">{timeStr}</td>
                        <td className="py-3 px-3 text-right">
                          <button
                            type="button"
                            onClick={async () => {
                              await printJobOnThisDevice(job);
                              showToast('已觸發本機列印');
                            }}
                            className="text-sg-brown font-bold text-[12px] hover:underline"
                          >
                            本機印
                          </button>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* TAB 4: CLOSING (日結) */}
      {activeTab === 'closing' && closingPreview && (
        <div className="space-y-6">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {/* Left: Financial summary */}
            <div className="bg-white p-5 rounded-3xl border border-sg-line shadow-xs space-y-4">
              <div>
                <span className="text-sg-muted text-[12px] block">今日實收淨額</span>
                <span className="text-[28px] font-bold text-sg-ink font-num">
                  NT${closingPreview.net_revenue}
                </span>
              </div>

              <div className="divide-y divide-sg-line text-[13px] pt-2">
                <div className="py-2 flex justify-between">
                  <span className="text-sg-ink">現金收款（{closingPreview.by_method?.cash?.count || 0} 筆）</span>
                  <span className="font-num font-bold">NT${closingPreview.by_method?.cash?.amount || 0}</span>
                </div>
                <div className="py-2 flex justify-between">
                  <span className="text-sg-ink">LINE Pay（{closingPreview.by_method?.line_pay?.count || 0} 筆）</span>
                  <span className="font-num font-bold">NT${closingPreview.by_method?.line_pay?.amount || 0}</span>
                </div>
                <div className="py-2 flex justify-between">
                  <span className="text-sg-ink">銀行轉帳（{closingPreview.by_method?.transfer?.count || 0} 筆）</span>
                  <span className="font-num font-bold">NT${closingPreview.by_method?.transfer?.amount || 0}</span>
                </div>
                {closingPreview.refunds?.cash?.amount > 0 && (
                  <div className="py-2 flex justify-between text-sg-danger">
                    <span>退款（{closingPreview.refunds?.cash?.count || 0} 筆）</span>
                    <span className="font-num font-bold">-NT${closingPreview.refunds?.cash?.amount || 0}</span>
                  </div>
                )}
                <div className="py-2 flex justify-between text-sg-muted">
                  <span>卡券折抵（{closingPreview.passes?.count || 0} 筆，不計入）</span>
                  <span className="font-num">NT${closingPreview.passes?.amount || 0}</span>
                </div>
                <div className="py-2 flex justify-between text-sg-muted">
                  <span>作廢（{closingPreview.voids?.count || 0} 筆，不計入）</span>
                  <span className="font-num">NT${closingPreview.voids?.amount || 0}</span>
                </div>
                <div className="py-2 flex justify-between text-sg-honey font-bold">
                  <span>未結（{closingPreview.unpaid?.count || 0} 筆）</span>
                  <span className="font-num">NT${closingPreview.unpaid?.amount || 0}</span>
                </div>
              </div>
            </div>

            {/* Right: Cash Float & Count verification */}
            <div className="bg-white p-5 rounded-3xl border border-sg-line shadow-xs space-y-4">
              <h3 className="text-[16px] font-bold text-sg-ink">交班點錢</h3>

              <div className="space-y-3">
                <div className="flex items-center justify-between text-[13px]">
                  <span className="text-sg-muted">起始零用金</span>
                  <div className="flex items-center gap-1 font-num font-bold">
                    <span>NT$</span>
                    <input
                      type="number"
                      value={closingFloat}
                      onChange={(e) => setClosingFloat(parseInt(e.target.value, 10) || 0)}
                      className="w-24 px-2 py-1 rounded-xl border border-sg-line text-right"
                    />
                  </div>
                </div>

                <div className="flex items-center justify-between text-[14px]">
                  <span className="text-sg-ink font-bold">現金應有總額</span>
                  <span className="text-[18px] font-bold text-sg-ink font-num">
                    NT${closingPreview.expected_cash}
                  </span>
                </div>

                <div className="pt-2 border-t border-sg-line">
                  <MoneyInput
                    label="實點現金總額"
                    value={countedCash}
                    onChange={setCountedCash}
                  />
                </div>

                {/* Diff Result */}
                {(() => {
                  const diff = countedCash - closingPreview.expected_cash;
                  if (diff === 0) {
                    return (
                      <div className="p-3 rounded-2xl bg-sg-sage-soft text-sg-sage-ink font-bold text-[13px] text-center">
                        相符，沒有差額
                      </div>
                    );
                  } else if (diff < 0) {
                    return (
                      <div className="p-3 rounded-2xl bg-sg-danger-soft text-sg-danger font-bold text-[13px] text-center">
                        短少 NT${Math.abs(diff)}
                      </div>
                    );
                  } else {
                    return (
                      <div className="p-3 rounded-2xl bg-sg-honey-soft text-sg-honey font-bold text-[13px] text-center">
                        多出 NT${diff}
                      </div>
                    );
                  }
                })()}

                <div>
                  <label className="block text-[12px] text-sg-muted font-medium mb-1">交班備註</label>
                  <input
                    type="text"
                    value={closingNote}
                    onChange={(e) => setClosingNote(e.target.value)}
                    placeholder="若有差額請填寫原因..."
                    className="w-full px-3 py-2 rounded-xl border border-sg-line text-[13px]"
                  />
                </div>

                <Button
                  variant="primary"
                  size="md"
                  onClick={handleSubmitClosing}
                  loading={closingSubmitting}
                  className="w-full"
                >
                  完成交班
                </Button>
              </div>
            </div>
          </div>

          {/* Previous Closings History */}
          {closingsList.length > 0 && (
            <div className="bg-white p-4 rounded-3xl border border-sg-line shadow-xs space-y-2">
              <span className="text-[13px] font-bold text-sg-ink block">歷史交班紀錄</span>
              <div className="space-y-1.5">
                {closingsList.map((c) => (
                  <div key={c.id} className="p-2.5 rounded-2xl bg-sg-paper/40 border border-sg-line flex items-center justify-between text-[12px]">
                    <div>
                      <span className="font-bold text-sg-ink mr-2">{new Date(c.closed_at).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Taipei' })}</span>
                      <span className="text-sg-muted">{c.staff_name}</span>
                    </div>
                    <div>
                      <span className="text-sg-muted mr-3">實點 NT${c.counted_cash}</span>
                      <span className={`font-bold ${c.difference === 0 ? 'text-sg-sage-ink' : 'text-sg-danger'}`}>
                        差額 NT${c.difference}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* TAB 5: UNPAID FOLLOW-UP (未結追蹤) */}
      {activeTab === 'unpaid' && (
        <div className="space-y-3">
          <div className="text-[12px] text-sg-muted">
            下列預約訂單尚未完成全額結帳，點選「結帳」可立即開啟結帳工作台。
          </div>

          <div className="bg-white rounded-3xl border border-sg-line overflow-hidden shadow-xs">
            <table className="w-full text-left border-collapse text-[13px]">
              <thead>
                <tr className="bg-sg-paper/80 border-b border-sg-line text-[12px] text-sg-muted">
                  <th className="py-2.5 px-3 font-semibold">日期</th>
                  <th className="py-2.5 px-3 font-semibold">單號</th>
                  <th className="py-2.5 px-3 font-semibold">顧客</th>
                  <th className="py-2.5 px-2 font-semibold">人數</th>
                  <th className="py-2.5 px-2 font-semibold">狀態</th>
                  <th className="py-2.5 px-3 font-semibold text-right">未收金額</th>
                  <th className="py-2.5 px-3 font-semibold text-right">操作</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-sg-line">
                {loadingUnpaid ? (
                  <tr>
                    <td colSpan={7} className="py-12 text-center text-sg-muted">載入未結追蹤中...</td>
                  </tr>
                ) : unpaidList.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="py-12 text-center text-sg-muted">太棒了！目前沒有未結款項。</td>
                  </tr>
                ) : (
                  unpaidList.map((r) => {
                    const due = (r.amount_due || 0) - (r.amount_received || 0);

                    return (
                      <tr key={r.booking_ref} className="hover:bg-sg-paper/30 transition">
                        <td className="py-3 px-3 text-sg-muted text-[12px]">
                          {r.session_date ? new Date(r.session_date).toLocaleDateString('zh-TW', { month: 'numeric', day: 'numeric', timeZone: 'Asia/Taipei' }) : '-'}
                        </td>
                        <td className="py-3 px-3 font-mono font-bold text-sg-brown text-[12px]">
                          {r.ref_display || r.booking_ref}
                        </td>
                        <td className="py-3 px-3 font-bold text-sg-ink">
                          {r.name || r.user?.name || '現場貴賓'}
                        </td>
                        <td className="py-3 px-2 text-sg-muted font-num">{r.pax} 位</td>
                        <td className="py-3 px-2">
                          <StatusPill status={r.billing_status || 'unpaid'} />
                        </td>
                        <td className="py-3 px-3 text-right font-bold text-sg-danger font-num">
                          NT${due}
                        </td>
                        <td className="py-3 px-3 text-right">
                          <Button
                            variant="primary"
                            size="sm"
                            data-testid={`checkout-btn-${r.booking_ref}`}
                            onClick={() => setCheckoutBookingRef(r.booking_ref)}
                          >
                            結帳
                          </Button>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Void Payment Modal */}
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

      {/* Closing Slip Preview Modal */}
      <ResponsivePanel
        isOpen={showClosingPreviewModal}
        onClose={() => setShowClosingPreviewModal(false)}
        title="日結單預覽 (58mm)"
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="secondary" size="sm" onClick={() => setShowClosingPreviewModal(false)}>關閉</Button>
            <Button variant="primary" size="sm" onClick={() => window.print()}>列印</Button>
          </div>
        }
      >
        <div
          className="bg-sg-paper/60 p-4 rounded-xl border border-sg-line font-mono text-[12px] overflow-x-auto max-h-[60vh]"
          dangerouslySetInnerHTML={{ __html: closingSlipHtml }}
        />
      </ResponsivePanel>

      {/* Event Detail Modal */}
      <ResponsivePanel
        isOpen={Boolean(selectedEventDetail)}
        onClose={() => setSelectedEventDetail(null)}
        title="異動詳細紀錄"
        subtitle={`事件 #${selectedEventDetail?.id} · ${selectedEventDetail?.created_at ? new Date(selectedEventDetail.created_at).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' }) : ''}`}
      >
        {selectedEventDetail && (
          <div className="space-y-4 py-2 text-[13px]">
            <div className="p-3 rounded-2xl bg-sg-paper/40 border border-sg-line space-y-1">
              <div><span className="text-sg-muted">操作人員：</span><span className="font-bold">{selectedEventDetail.staff_name}</span></div>
              <div><span className="text-sg-muted">操作裝置：</span><span>{selectedEventDetail.device_label}</span></div>
              <div><span className="text-sg-muted">關聯訂單：</span><span className="font-mono text-sg-brown font-bold">{selectedEventDetail.booking_ref || '無'}</span></div>
              <div><span className="text-sg-muted">填寫原因：</span><span className="font-bold text-sg-danger">{selectedEventDetail.reason || '無'}</span></div>
            </div>

            <div>
              <span className="font-bold text-sg-ink block mb-1">異動前後快照 (Snapshot)</span>
              <pre className="p-3 rounded-2xl bg-sg-ink text-sg-paper text-[11px] overflow-x-auto max-h-60">
                {JSON.stringify({ before: selectedEventDetail.before_snapshot, after: selectedEventDetail.after_snapshot }, null, 2)}
              </pre>
            </div>
          </div>
        )}
      </ResponsivePanel>

      {/* Checkout Workbench Modal */}
      {checkoutBookingRef && (
        <CheckoutWorkbench
          isOpen={Boolean(checkoutBookingRef)}
          onClose={() => setCheckoutBookingRef(null)}
          bookingRef={checkoutBookingRef}
          onPaymentSuccess={() => {
            if (activeTab === 'payments') fetchPayments();
            else if (activeTab === 'unpaid') fetchUnpaid();
          }}
        />
      )}
    </div>
  );
}
