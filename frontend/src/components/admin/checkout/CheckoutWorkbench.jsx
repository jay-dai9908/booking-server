import React, { useState, useEffect, useRef, useMemo } from 'react';
import {
  X,
  CreditCard,
  Plus,
  Minus,
  Check,
  AlertTriangle,
  RotateCcw,
  Ticket,
  Printer,
  ChevronDown,
  ChevronRight,
  User,
  Clock,
  Sparkles,
  Info,
  MoreVertical,
  Trash2
} from 'lucide-react';
import api from '../../../api/axios';
import ResponsivePanel from '../ResponsivePanel';
import StatusPill from '../StatusPill';
import PayMethodGrid from '../PayMethodGrid';
import CashPad from '../CashPad';
import ReasonChips from '../ReasonChips';
import MoneyInput from '../MoneyInput';
import ConfirmPanel from '../ConfirmPanel';
import PrinterStatusLine from '../PrinterStatusLine';
import Button from '../../customer/Button';
import SplitCollectView from './SplitCollectView';
import PassTenderSheet from './PassTenderSheet';
import { printJobOnThisDevice } from '../../../utils/sunmiPrinter';
import { buildOrderSummary, buildReceipt, commandsToPreviewHtml } from '@shared/receipts.js';
import { formatTimerHMM, formatBillingHours } from '@shared/time.js';
import { displayBoardName } from '@shared/billing.js';

export default function CheckoutWorkbench({
  isOpen = false,
  onClose,
  bookingRef,
  onPaymentSuccess
}) {
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [billData, setBillData] = useState(null);

  // Local draft state
  const [draftState, setDraftState] = useState(null);
  const [isSavingDraft, setIsSavingDraft] = useState(false);
  const [draftConflictMsg, setDraftConflictMsg] = useState(null);

  // Sub-modal states
  const [adjustPersonNo, setAdjustPersonNo] = useState(null);
  const [showOverrideModal, setShowOverrideModal] = useState(false);
  const [showPassCenter, setShowPassCenter] = useState(false);
  const [showPreviewModal, setShowPreviewModal] = useState(false);
  const [previewHtml, setPreviewHtml] = useState('');
  const [showCollectModal, setShowCollectModal] = useState(false);
  const [showSplitCollect, setShowSplitCollect] = useState(false);
  const [showWaiveModal, setShowWaiveModal] = useState(false);
  const [successPaymentData, setSuccessPaymentData] = useState(null);

  // Addon inputs
  const [addonTarget, setAddonTarget] = useState(1); // 1 = person 1, 'order' = order
  const [customAddonName, setCustomAddonName] = useState('');
  const [customAddonPrice, setCustomAddonPrice] = useState(30);
  const [showCustomAddonInput, setShowCustomAddonInput] = useState(false);

  // Discount & promo inputs
  const [promoInput, setPromoInput] = useState('');
  const [promoError, setPromoError] = useState('');
  const [isValidatingPromo, setIsValidatingPromo] = useState(false);

  // Total override input
  const [overrideAmount, setOverrideAmount] = useState(0);
  const [overrideReason, setOverrideReason] = useState('熟客優惠');

  // Collect modal state (together collection)
  const [collectMethod, setCollectMethod] = useState('cash');
  const [collectCashReceived, setCollectCashReceived] = useState(0);
  const [collectAutoPrint, setCollectAutoPrint] = useState(true);
  const [collectNote, setCollectNote] = useState('');
  const [collectLoading, setCollectLoading] = useState(false);
  const [collectError, setCollectError] = useState(null);

  // Waive state
  const [waiveReason, setWaiveReason] = useState('店家招待');
  const [waiveLoading, setWaiveLoading] = useState(false);
  const [waiveError, setWaiveError] = useState(null);

  // Debounce ref
  const saveTimeoutRef = useRef(null);
  const isInitialLoadRef = useRef(true);

  // Load bill data
  const loadBill = async () => {
    if (!bookingRef) return;
    try {
      setLoading(true);
      setLoadError(null);
      const res = await api.get(`/billing/${bookingRef}`);
      setBillData(res.data);
      setDraftState(res.data.draft || {
        version: 2,
        rev: 1,
        split_mode: 'proportional',
        persons: [],
        order_addons: [],
        order_promos: [],
        manual_discount: null,
        total_override: null,
        note: ''
      });
      if (res.data.draft?.total_override) {
        setOverrideAmount(res.data.draft.total_override.amount);
        setOverrideReason(res.data.draft.total_override.reason || '熟客優惠');
      }
      isInitialLoadRef.current = true;
    } catch (err) {
      console.error('[CheckoutWorkbench] Load error:', err);
      setLoadError(err.response?.data?.error || '價格設定讀不到，暫時無法結帳，請重新整理');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (isOpen && bookingRef) {
      loadBill();
    } else {
      setBillData(null);
      setDraftState(null);
    }
    return () => {
      if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    };
  }, [isOpen, bookingRef]);

  // Debounced draft save
  const triggerDraftSave = (newDraft) => {
    if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    saveTimeoutRef.current = setTimeout(async () => {
      if (!bookingRef || !billData) return;
      try {
        setIsSavingDraft(true);
        setDraftConflictMsg(null);
        const res = await api.put(`/billing/${bookingRef}/draft`, {
          base_rev: billData.draft?.rev || 1,
          draft: newDraft
        });
        if (res.data?.bill) {
          setBillData(prev => ({
            ...prev,
            bill: res.data.bill,
            draft: { ...newDraft, rev: (prev.draft?.rev || 1) + 1 }
          }));
        }
      } catch (err) {
        console.error('[CheckoutWorkbench] Draft save error:', err);
        if (err.response?.status === 409) {
          setDraftConflictMsg('另一台裝置剛改過這筆帳，已重新載入');
          loadBill();
        }
      } finally {
        setIsSavingDraft(false);
      }
    }, 600);
  };

  const updateDraft = (updater) => {
    setDraftState(prev => {
      const next = typeof updater === 'function' ? updater(prev) : { ...prev, ...updater };
      triggerDraftSave(next);
      return next;
    });
  };

  if (!isOpen) return null;

  const booking = billData?.booking || {};
  const pricing = billData?.pricing;

  if (!loading && (!pricing || pricing.hourly == null)) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-sg-ink/50 backdrop-blur-sm">
        <div className="bg-white rounded-3xl p-6 max-w-md w-full text-center space-y-4 border border-sg-line shadow-xl">
          <p className="text-sm font-bold text-sg-danger">
            價格設定讀不到，暫時無法結帳，請重新整理
          </p>
          <Button variant="secondary" size="sm" onClick={onClose}>
            關閉
          </Button>
        </div>
      </div>
    );
  }

  const bill = billData?.bill || {};
  const persons = bill.persons || [];
  const unpaidPersons = persons.filter(p => !p.is_frozen);
  const paidPersons = persons.filter(p => p.is_frozen);
  const statusInfo = billData?.status || { status: 'unpaid' };
  const payments = billData?.payments || [];

  // Handlers for person adjustments
  const handleHoursStep = (personNo, delta) => {
    updateDraft(prev => {
      const pList = [...(prev.persons || [])];
      const idx = pList.findIndex(p => p.person_no === personNo);
      const curr = idx >= 0 ? pList[idx] : { person_no: personNo };
      const currentHours = curr.hours_override != null ? curr.hours_override : (booking.session_count || 1);
      const newHours = Math.max(0.5, currentHours + delta);
      const updatedPerson = { ...curr, hours_override: newHours };
      if (idx >= 0) pList[idx] = updatedPerson;
      else pList.push(updatedPerson);
      return { ...prev, persons: pList };
    });
  };

  const handleToggleMode = (personNo) => {
    updateDraft(prev => {
      const pList = [...(prev.persons || [])];
      const idx = pList.findIndex(p => p.person_no === personNo);
      const curr = idx >= 0 ? pList[idx] : { person_no: personNo };
      const newMode = curr.mode === 'unlimited' ? 'hourly' : 'unlimited';
      const updatedPerson = { ...curr, mode: newMode };
      if (idx >= 0) pList[idx] = updatedPerson;
      else pList.push(updatedPerson);
      return { ...prev, persons: pList };
    });
  };

  // Addons handling
  const handleAddPreset = (preset) => {
    if (addonTarget === 'order') {
      updateDraft(prev => {
        const list = [...(prev.order_addons || [])];
        const existingIdx = list.findIndex(a => a.name === preset.name);
        if (existingIdx >= 0) {
          list[existingIdx] = { ...list[existingIdx], qty: list[existingIdx].qty + 1 };
        } else {
          list.push({
            key: `order-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
            name: preset.name,
            price: Number(preset.price) || 0,
            qty: 1,
            split_mode: prev.split_mode || 'proportional'
          });
        }
        return { ...prev, order_addons: list };
      });
    } else {
      const pNo = Number(addonTarget);
      updateDraft(prev => {
        const pList = [...(prev.persons || [])];
        const idx = pList.findIndex(p => p.person_no === pNo);
        const curr = idx >= 0 ? pList[idx] : { person_no: pNo, addons: [] };
        const aList = [...(curr.addons || [])];
        const existingIdx = aList.findIndex(a => a.name === preset.name);
        if (existingIdx >= 0) {
          aList[existingIdx] = { ...aList[existingIdx], qty: aList[existingIdx].qty + 1 };
        } else {
          aList.push({
            key: `p${pNo}-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
            name: preset.name,
            price: Number(preset.price) || 0,
            qty: 1
          });
        }
        const updated = { ...curr, addons: aList };
        if (idx >= 0) pList[idx] = updated;
        else pList.push(updated);
        return { ...prev, persons: pList };
      });
    }
  };

  const handleAddCustomAddon = () => {
    if (!customAddonName.trim()) return;
    handleAddPreset({ name: customAddonName.trim(), price: Number(customAddonPrice) || 0 });
    setCustomAddonName('');
    setShowCustomAddonInput(false);
  };

  const handleRemoveAddon = (isOrder, pNo, addonKey) => {
    if (isOrder) {
      updateDraft(prev => ({
        ...prev,
        order_addons: (prev.order_addons || []).filter(a => a.key !== addonKey)
      }));
    } else {
      updateDraft(prev => {
        const pList = [...(prev.persons || [])];
        const idx = pList.findIndex(p => p.person_no === pNo);
        if (idx < 0) return prev;
        pList[idx] = {
          ...pList[idx],
          addons: (pList[idx].addons || []).filter(a => a.key !== addonKey)
        };
        return { ...prev, persons: pList };
      });
    }
  };

  // Promo handling
  const handleValidatePromo = async (codeToValidate) => {
    const code = (codeToValidate || promoInput).trim().toUpperCase();
    if (!code) return;
    try {
      setIsValidatingPromo(true);
      setPromoError('');
      const res = await api.post('/checkout/promo-codes/validate', {
        code,
        booking_ref: bookingRef,
        pax: booking.pax || persons.length
      });
      if (res.data?.valid) {
        const promo = res.data.promo;
        updateDraft(prev => {
          const list = [...(prev.order_promos || [])];
          if (list.some(p => p.code === promo.code)) return prev;
          list.push({
            promo_id: promo.id,
            code: promo.code,
            name: promo.name,
            discount_type: promo.discount_type,
            discount_value: promo.discount_value,
            split_mode: prev.split_mode || 'proportional'
          });
          return { ...prev, order_promos: list };
        });
        setPromoInput('');
      } else {
        setPromoError(res.data?.error || '折扣碼無效或未達門檻');
      }
    } catch (err) {
      setPromoError(err.response?.data?.error || '折扣碼驗證失敗');
    } finally {
      setIsValidatingPromo(false);
    }
  };

  // Manual Discount
  const handleManualDiscountChange = (amount, reason) => {
    updateDraft(prev => ({
      ...prev,
      manual_discount: amount > 0 ? {
        amount,
        reason: reason || '熟客優惠',
        split_mode: prev.split_mode || 'proportional'
      } : null
    }));
  };

  // Total Override
  const handleApplyOverride = () => {
    updateDraft(prev => ({
      ...prev,
      total_override: overrideAmount > 0 ? {
        amount: overrideAmount,
        reason: overrideReason || '熟客優惠'
      } : null
    }));
    setShowOverrideModal(false);
  };

  // Full Order Collect
  const handleCollectFullOrder = async () => {
    if (unpaidPersons.length === 0) return;
    const unpaidNos = unpaidPersons.map(p => p.person_no);
    const expectedAmount = unpaidPersons.reduce((s, p) => s + (p.total || 0), 0);

    if (collectMethod === 'cash' && collectCashReceived > 0 && collectCashReceived < expectedAmount) {
      setCollectError('收到的現金不夠');
      return;
    }

    try {
      setCollectLoading(true);
      setCollectError(null);
      const clientBatchId = (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : `b-${Date.now()}`;

      const res = await api.post(`/billing/${bookingRef}/collect`, {
        client_batch_id: clientBatchId,
        person_nos: unpaidNos,
        expected_amount: expectedAmount,
        method: collectMethod,
        cash_received: collectMethod === 'cash' ? (collectCashReceived || expectedAmount) : null,
        pass_tenders: [],
        note: collectNote,
        print: collectAutoPrint
      });

      // Print jobs created automatically by backend (Section 3.8)
      if (res.data?.print_jobs?.length) {
        for (const job of res.data.print_jobs) {
          try {
            await printJobOnThisDevice(job);
          } catch (pErr) {
            console.warn('[CheckoutWorkbench] Local print fallback error:', pErr);
          }
        }
      }

      setSuccessPaymentData(res.data);
      setShowCollectModal(false);
      if (onPaymentSuccess) onPaymentSuccess(res.data);
    } catch (err) {
      console.error(err);
      if (err.response?.status === 409) {
        setCollectError('金額剛剛有變動，請確認後再收款');
        loadBill();
      } else {
        setCollectError(err.response?.data?.error || '收款失敗');
      }
    } finally {
      setCollectLoading(false);
    }
  };

  // Waive
  const handleWaiveOrder = async () => {
    try {
      setWaiveLoading(true);
      setWaiveError(null);
      const unpaidNos = unpaidPersons.map(p => p.person_no);
      await api.post(`/billing/${bookingRef}/waive`, {
        person_nos: unpaidNos,
        reason: waiveReason
      });
      setShowWaiveModal(false);
      loadBill();
      if (onPaymentSuccess) onPaymentSuccess();
    } catch (err) {
      setWaiveError(err.response?.data?.error || '免收失敗');
    } finally {
      setWaiveLoading(false);
    }
  };

  // Preview receipt
  const handleOpenPreview = () => {
    try {
      const summaryCmds = buildOrderSummary(
        {
          booking_ref: booking.booking_ref,
          name: booking.customer_name,
          pax: booking.pax,
          start_at: booking.start_at,
          end_at: booking.end_at,
          table_label: booking.table_label
        },
        payments,
        { refDisplay: booking.ref_display || bookingRef }
      );
      setPreviewHtml(commandsToPreviewHtml(summaryCmds));
      setShowPreviewModal(true);
    } catch (err) {
      console.error('Preview build failed:', err);
    }
  };

  const netDue = unpaidPersons.reduce((s, p) => s + (p.total || 0), 0);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-2 sm:p-4 bg-sg-ink/50 backdrop-blur-sm animate-fade-in">
      <div className="bg-white rounded-3xl shadow-2xl w-full max-w-5xl max-h-[96vh] flex flex-col overflow-hidden border border-sg-line">
        {/* Header */}
        <div className="px-5 py-4 border-b border-sg-line flex items-center justify-between bg-sg-paper/40">
          <div className="flex items-center gap-3">
            <h2 className="text-[17px] font-bold text-sg-ink">
              結帳 · {booking.customer_name || '現場顧客'} {booking.pax || persons.length} 位
            </h2>
            <span className="font-mono text-[12px] bg-sg-paper px-2 py-0.5 rounded-lg border border-sg-line text-sg-muted">
              {booking.ref_display || bookingRef}
            </span>
            <StatusPill status={statusInfo.status || 'unpaid'} />
          </div>

          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => setShowPassCenter(true)}
              className="text-[13px] font-bold text-sg-brown hover:text-sg-brown-hover hover:underline flex items-center gap-1"
            >
              <Ticket className="w-4 h-4" />
              卡券中心
            </button>
            <button
              type="button"
              onClick={onClose}
              className="w-8 h-8 rounded-full flex items-center justify-center hover:bg-sg-paper text-sg-muted hover:text-sg-ink"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Conflict Toast */}
        {draftConflictMsg && (
          <div className="bg-sg-honey-soft text-sg-honey px-4 py-2 text-[12px] font-bold flex items-center gap-2 border-b border-sg-line">
            <AlertTriangle className="w-4 h-4 flex-shrink-0" />
            <span>{draftConflictMsg}</span>
          </div>
        )}

        {/* Content Body */}
        {loading ? (
          <div className="p-12 text-center text-sg-muted text-[14px]">載入結帳工作台中...</div>
        ) : loadError ? (
          <div className="p-12 text-center space-y-4">
            <div className="text-sg-danger font-bold text-[14px]">{loadError}</div>
            <Button variant="secondary" size="sm" onClick={loadBill}>重試</Button>
          </div>
        ) : (
          <div className="flex-1 overflow-y-auto p-4 sm:p-6 space-y-6">
            {/* 1. Info Bar */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 p-3.5 rounded-2xl bg-sg-paper/50 border border-sg-line text-[12px]">
              <div>
                <span className="text-sg-muted block">預約時段</span>
                <span className="font-bold text-sg-ink">
                  {booking.session_time_range || '未定'} · {booking.session_count || 1} 小時
                </span>
              </div>
              <div>
                <span className="text-sg-muted block">報到紀錄</span>
                <span className="font-bold text-sg-ink">
                  {booking.checked_in_at ? new Date(booking.checked_in_at).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', hour12: false }) : '未報到'}
                  {booking.checked_in_by ? ` · ${booking.checked_in_by}` : ''}
                </span>
              </div>
              <div>
                <span className="text-sg-muted block">分配座位</span>
                <span className="font-bold text-sg-ink">
                  {booking.assigned_seats?.length ? booking.assigned_seats.join('、') : '未排座'}
                </span>
              </div>
              <div>
                <span className="text-sg-muted block">計費牌告</span>
                <span className="font-bold text-sg-ink">
                  {pricing.is_weekend ? '假日' : '平日'} NT${pricing.hourly} ／時 · 封頂 NT${pricing.unlimited}
                </span>
              </div>
            </div>

            {/* 2. Person Table */}
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="text-[14px] font-bold text-sg-ink">
                    每位時數與金額（依計時自動計算，可以調整）
                  </h3>
                  <p className="text-[11px] text-sg-muted">點選任一列可展開計時明細與手動微調</p>
                </div>
                <div className="text-[12px] text-sg-muted">
                  {isSavingDraft ? <span className="text-sg-brown">自動儲存草稿中...</span> : <span>草稿已同步</span>}
                </div>
              </div>

              <div className="border border-sg-line rounded-2xl overflow-hidden bg-white shadow-sm">
                <table className="w-full text-left border-collapse text-[13px]">
                  <thead>
                    <tr className="bg-sg-paper/80 border-b border-sg-line text-[12px] text-sg-muted">
                      <th className="py-2.5 px-3 font-semibold">座位</th>
                      <th className="py-2.5 px-2 font-semibold">計費</th>
                      <th className="py-2.5 px-2 font-semibold">計時</th>
                      <th className="py-2.5 px-2 font-semibold">收費時數</th>
                      <th className="py-2.5 px-2 font-semibold text-right">入場</th>
                      <th className="py-2.5 px-2 font-semibold text-right">智能板</th>
                      <th className="py-2.5 px-2 font-semibold text-right">加購</th>
                      <th className="py-2.5 px-2 font-semibold text-right">調整</th>
                      <th className="py-2.5 px-3 font-semibold text-right">小計</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-sg-line">
                    {persons.map((p) => {
                      const isFrozen = p.is_frozen;
                      const hasOverride = p.hours_override != null;
                      const isUnl = p.mode === 'unlimited';

                      return (
                        <React.Fragment key={p.person_no}>
                          <tr
                            onClick={() => !isFrozen && setAdjustPersonNo(p.person_no)}
                            className={`cursor-pointer transition ${
                              isFrozen
                                ? 'bg-sg-paper/40 text-sg-muted'
                                : adjustPersonNo === p.person_no
                                ? 'bg-sg-brown-soft/40'
                                : 'hover:bg-sg-paper/30'
                            }`}
                          >
                            <td className="py-3 px-3">
                              <div className="font-bold text-sg-ink">
                                第 {p.person_no} 位
                                {p.seat_code && (
                                  <span className="ml-1.5 font-mono text-[11px] bg-sg-paper px-1.5 py-0.5 rounded border border-sg-line">
                                    {p.seat_code}
                                  </span>
                                )}
                              </div>
                              {isFrozen && (
                                <span className="inline-block mt-0.5 text-[10px] text-sg-sage-ink font-bold bg-sg-sage-soft px-1.5 py-0.2 rounded">
                                  已付清
                                </span>
                              )}
                            </td>
                            <td className="py-3 px-2">
                              <span className={`inline-block px-2 py-0.5 rounded-lg text-[11px] font-bold ${
                                isUnl ? 'bg-sg-peach-soft text-sg-peach' : 'bg-sg-paper text-sg-ink'
                              }`}>
                                {isUnl ? '不限時' : '計時'}
                              </span>
                            </td>
                            <td className="py-3 px-2">
                              <div className="font-mono font-medium">
                                {formatTimerHMM(p.entry?.actual_minutes ?? p.actual_minutes ?? 0)}
                              </div>
                              {p.entry?.explainDetail && (
                                <div className="text-[10px] text-sg-muted truncate max-w-[120px]">
                                  {p.entry.explainDetail}
                                </div>
                              )}
                            </td>
                            <td className="py-3 px-2">
                              {isFrozen ? (
                                <span className="font-bold">{formatBillingHours(p.entry?.hours || 0)}</span>
                              ) : (
                                <div className="flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
                                  <button
                                    type="button"
                                    onClick={() => handleHoursStep(p.person_no, -0.5)}
                                    className="w-6 h-6 rounded-lg bg-sg-paper hover:bg-sg-line flex items-center justify-center font-bold text-sg-ink text-[12px]"
                                  >
                                    -
                                  </button>
                                  <span className="font-bold min-w-[32px] text-center font-num">
                                    {p.entry?.hours || 0}h
                                  </span>
                                  <button
                                    type="button"
                                    onClick={() => handleHoursStep(p.person_no, 0.5)}
                                    className="w-6 h-6 rounded-lg bg-sg-paper hover:bg-sg-line flex items-center justify-center font-bold text-sg-ink text-[12px]"
                                  >
                                    +
                                  </button>
                                  <span className="text-[10px] text-sg-muted ml-1">
                                    {hasOverride ? '手動' : '自動'}
                                  </span>
                                </div>
                              )}
                            </td>
                            <td className="py-3 px-2 text-right font-num">
                              NT${p.entry?.amount || 0}
                            </td>
                            <td className="py-3 px-2 text-right">
                              <span className="font-num">NT${p.board?.amount || 0}</span>
                              {p.board?.units?.length > 0 && (
                                <div className="text-[10px] text-sg-muted">
                                  {p.board.units.map(u => (u.segments || []).map(s => displayBoardName(s.name)).join('→')).join(', ')}
                                </div>
                              )}
                            </td>
                            <td className="py-3 px-2 text-right">
                              <span className="font-num">
                                NT${(p.addons || []).reduce((s, a) => s + (a.subtotal || a.price * a.qty), 0)}
                              </span>
                            </td>
                            <td className="py-3 px-2 text-right font-num text-sg-brown">
                              {p.adjust?.amount ? (p.adjust.amount >= 0 ? `+${p.adjust.amount}` : p.adjust.amount) : '-'}
                            </td>
                            <td className="py-3 px-3 text-right font-bold text-sg-ink font-num">
                              NT${p.total || 0}
                            </td>
                          </tr>

                          {/* Expanded Detail View */}
                          {adjustPersonNo === p.person_no && !isFrozen && (
                            <tr className="bg-sg-paper/40">
                              <td colSpan={9} className="p-4 border-t border-b border-sg-line space-y-3">
                                <div className="flex items-center justify-between">
                                  <span className="text-[12px] font-bold text-sg-brown">
                                    第 {p.person_no} 位計費細項調整
                                  </span>
                                  <button
                                    type="button"
                                    onClick={() => setAdjustPersonNo(null)}
                                    className="text-[12px] text-sg-muted hover:text-sg-ink"
                                  >
                                    收合
                                  </button>
                                </div>

                                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-[12px]">
                                  <div className="p-2.5 rounded-xl bg-white border border-sg-line">
                                    <span className="text-sg-muted block text-[11px] mb-1">計費方案切換</span>
                                    <div className="flex items-center gap-2">
                                      <button
                                        type="button"
                                        onClick={() => handleToggleMode(p.person_no)}
                                        className={`px-3 py-1 rounded-lg font-bold text-[12px] border ${
                                          p.mode === 'unlimited'
                                            ? 'bg-sg-peach-soft text-sg-peach border-sg-peach'
                                            : 'bg-white text-sg-ink border-sg-line'
                                        }`}
                                      >
                                        {p.mode === 'unlimited' ? '目前：不限時 NT$750' : '改為不限時 (NT$750)'}
                                      </button>
                                    </div>
                                  </div>

                                  <div className="p-2.5 rounded-xl bg-white border border-sg-line">
                                    <span className="text-sg-muted block text-[11px] mb-1">單人金額微調 (±元)</span>
                                    <div className="flex items-center gap-2">
                                      <input
                                        type="number"
                                        value={p.adjust?.amount || 0}
                                        onChange={(e) => {
                                          const val = parseInt(e.target.value, 10) || 0;
                                          updateDraft(prev => {
                                            const pList = [...(prev.persons || [])];
                                            const idx = pList.findIndex(pr => pr.person_no === p.person_no);
                                            const curr = idx >= 0 ? pList[idx] : { person_no: p.person_no };
                                            const updated = {
                                              ...curr,
                                              adjust: val !== 0 ? { amount: val, reason: curr.adjust?.reason || '現場調整' } : null
                                            };
                                            if (idx >= 0) pList[idx] = updated;
                                            else pList.push(updated);
                                            return { ...prev, persons: pList };
                                          });
                                        }}
                                        className="w-24 px-2 py-1 rounded-lg border border-sg-line font-num font-bold text-[13px]"
                                      />
                                      <span className="text-sg-muted text-[11px]">原因：{p.adjust?.reason || '現場調整'}</span>
                                    </div>
                                  </div>

                                  <div className="p-2.5 rounded-xl bg-white border border-sg-line flex items-center justify-between">
                                    <div>
                                      <span className="text-sg-muted block text-[11px]">計時規則套用</span>
                                      <span className="text-sg-ink text-[12px] font-bold">
                                        {p.entry?.explain || '依預約時數計算'}
                                      </span>
                                    </div>
                                    <button
                                      type="button"
                                      onClick={() => {
                                        updateDraft(prev => {
                                          const pList = (prev.persons || []).map(pr => {
                                            if (pr.person_no === p.person_no) {
                                              return { ...pr, hours_override: null, mode: 'hourly', adjust: null };
                                            }
                                            return pr;
                                          });
                                          return { ...prev, persons: pList };
                                        });
                                      }}
                                      className="text-sg-brown text-[11px] font-bold hover:underline"
                                    >
                                      改回自動
                                    </button>
                                  </div>
                                </div>
                              </td>
                            </tr>
                          )}
                        </React.Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>

            {/* 3. Addon Items Section */}
            <div className="space-y-3 p-4 rounded-2xl border border-sg-line bg-white shadow-sm">
              <div className="flex items-center justify-between">
                <h3 className="text-[14px] font-bold text-sg-ink">
                  吊飾、周邊與代燙加購
                </h3>
                <div className="flex items-center gap-1.5">
                  <span className="text-[12px] text-sg-muted">加購對象：</span>
                  <button
                    type="button"
                    onClick={() => setAddonTarget('order')}
                    className={`px-2.5 py-1 rounded-xl text-[12px] font-bold border transition ${
                      addonTarget === 'order'
                        ? 'bg-sg-brown text-white border-sg-brown'
                        : 'bg-sg-paper text-sg-ink border-sg-line'
                    }`}
                  >
                    整單共同
                  </button>
                  {persons.map(p => (
                    <button
                      key={p.person_no}
                      type="button"
                      onClick={() => setAddonTarget(p.person_no)}
                      className={`px-2.5 py-1 rounded-xl text-[12px] font-bold border transition ${
                        addonTarget === p.person_no
                          ? 'bg-sg-brown text-white border-sg-brown'
                          : 'bg-sg-paper text-sg-ink border-sg-line'
                      }`}
                    >
                      第 {p.person_no} 位
                    </button>
                  ))}
                </div>
              </div>

              {/* Preset Chips */}
              <div className="flex flex-wrap gap-2 pt-1">
                {(billData?.addon_presets || []).map((preset) => (
                  <button
                    key={preset.id || preset.name}
                    type="button"
                    onClick={() => handleAddPreset(preset)}
                    className="px-3 py-1.5 rounded-xl border border-sg-line bg-sg-paper/60 hover:bg-sg-brown-soft hover:border-sg-brown text-[12px] font-bold text-sg-ink flex items-center gap-1.5 transition"
                  >
                    <Plus className="w-3.5 h-3.5 text-sg-brown" />
                    <span>{preset.name}</span>
                    <span className="text-sg-muted font-num">NT${preset.price}</span>
                  </button>
                ))}

                <button
                  type="button"
                  onClick={() => setShowCustomAddonInput(!showCustomAddonInput)}
                  className="px-3 py-1.5 rounded-xl border border-dashed border-sg-line hover:border-sg-brown text-[12px] font-bold text-sg-muted hover:text-sg-brown"
                >
                  ＋ 自訂加購
                </button>
              </div>

              {/* Custom Addon Input */}
              {showCustomAddonInput && (
                <div className="flex items-center gap-2 p-3 bg-sg-paper/50 rounded-xl border border-sg-line">
                  <input
                    type="text"
                    value={customAddonName}
                    onChange={(e) => setCustomAddonName(e.target.value)}
                    placeholder="品名，例如：客製燙布貼"
                    className="flex-1 px-3 py-1.5 rounded-xl border border-sg-line text-[13px]"
                  />
                  <input
                    type="number"
                    value={customAddonPrice}
                    onChange={(e) => setCustomAddonPrice(e.target.value)}
                    placeholder="金額"
                    className="w-24 px-3 py-1.5 rounded-xl border border-sg-line text-[13px]"
                  />
                  <Button variant="primary" size="sm" onClick={handleAddCustomAddon}>
                    加入
                  </Button>
                </div>
              )}

              {/* Active Added List */}
              {((draftState?.order_addons?.length > 0) || persons.some(p => p.addons?.length > 0)) && (
                <div className="space-y-1.5 pt-2 border-t border-sg-line">
                  <span className="text-[11px] font-bold text-sg-muted uppercase tracking-wider block">
                    已加購項目清單
                  </span>
                  {/* Order level */}
                  {(draftState?.order_addons || []).map((a) => (
                    <div
                      key={a.key}
                      className="flex items-center justify-between p-2 rounded-xl bg-sg-paper/40 border border-sg-line text-[12px]"
                    >
                      <div className="flex items-center gap-2">
                        <span className="font-bold text-sg-ink">{a.name} ×{a.qty}</span>
                        <span className="px-1.5 py-0.5 rounded bg-sg-paper border border-sg-line text-[10px] text-sg-muted">
                          整單共同
                        </span>
                        <span className="font-num text-sg-muted">NT${a.price * a.qty}</span>
                      </div>
                      <button
                        type="button"
                        onClick={() => handleRemoveAddon(true, null, a.key)}
                        className="text-sg-danger hover:opacity-80 p-1"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ))}
                  {/* Per person */}
                  {persons.map(p => (
                    (p.addons || []).map(a => (
                      <div
                        key={a.key}
                        className="flex items-center justify-between p-2 rounded-xl bg-sg-paper/40 border border-sg-line text-[12px]"
                      >
                        <div className="flex items-center gap-2">
                          <span className="font-bold text-sg-ink">{a.name} ×{a.qty}</span>
                          <span className="px-1.5 py-0.5 rounded bg-sg-brown-soft text-[10px] text-sg-brown font-bold">
                            第 {p.person_no} 位
                          </span>
                          <span className="font-num text-sg-muted">NT${a.price * a.qty}</span>
                        </div>
                        <button
                          type="button"
                          onClick={() => handleRemoveAddon(false, p.person_no, a.key)}
                          className="text-sg-danger hover:opacity-80 p-1"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    ))
                  ))}
                </div>
              )}
            </div>

            {/* 4. Discounts & Promo Section */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {/* Promo code & POS chips */}
              <div className="p-4 rounded-2xl border border-sg-line bg-white shadow-sm space-y-3">
                <h3 className="text-[14px] font-bold text-sg-ink">優惠券與折扣碼</h3>

                {/* Quick Promos */}
                <div className="flex flex-wrap gap-2">
                  {(billData?.quick_promos || []).map((qp) => (
                    <button
                      key={qp.id}
                      type="button"
                      onClick={() => handleValidatePromo(qp.code)}
                      className="px-2.5 py-1 rounded-xl border border-sg-line bg-sg-paper/60 hover:bg-sg-brown-soft hover:border-sg-brown text-[12px] font-bold text-sg-ink"
                    >
                      {qp.name}
                    </button>
                  ))}
                </div>

                {/* Manual Promo Input */}
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    value={promoInput}
                    onChange={(e) => setPromoInput(e.target.value)}
                    placeholder="輸入折扣碼，例如 VIP2026"
                    className="flex-1 px-3 py-1.5 rounded-xl border border-sg-line text-[13px] uppercase"
                  />
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => handleValidatePromo()}
                    loading={isValidatingPromo}
                  >
                    驗證套用
                  </Button>
                </div>
                {promoError && (
                  <div className="text-[12px] text-sg-danger font-bold">{promoError}</div>
                )}

                {/* Applied Promos List */}
                {(draftState?.order_promos || []).length > 0 && (
                  <div className="space-y-1.5 pt-2 border-t border-sg-line">
                    <span className="text-[11px] font-bold text-sg-muted uppercase">已套用優惠</span>
                    {draftState.order_promos.map((p) => (
                      <div
                        key={p.code}
                        className="flex items-center justify-between p-2 rounded-xl bg-sg-peach-soft text-sg-peach text-[12px] font-bold"
                      >
                        <span>{p.name} ({p.code})</span>
                        <button
                          type="button"
                          onClick={() => {
                            updateDraft(prev => ({
                              ...prev,
                              order_promos: (prev.order_promos || []).filter(pr => pr.code !== p.code)
                            }));
                          }}
                          className="hover:underline text-[11px]"
                        >
                          移除
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Manual Discount & Split Mode */}
              <div className="p-4 rounded-2xl border border-sg-line bg-white shadow-sm space-y-3">
                <h3 className="text-[14px] font-bold text-sg-ink">店員手動折讓與分攤</h3>

                {/* Split Mode Selector */}
                <div>
                  <span className="text-[11px] text-sg-muted block mb-1">整單折扣分攤方式</span>
                  <div className="grid grid-cols-3 gap-1.5">
                    {[
                      { key: 'proportional', label: '依金額比例' },
                      { key: 'even', label: '平均分攤' },
                      { key: 'first', label: '全算第 1 位' }
                    ].map(m => (
                      <button
                        key={m.key}
                        type="button"
                        onClick={() => updateDraft({ split_mode: m.key })}
                        className={`py-1 rounded-xl text-[11px] font-bold border transition ${
                          (draftState?.split_mode || 'proportional') === m.key
                            ? 'bg-sg-brown text-white border-sg-brown'
                            : 'bg-sg-paper text-sg-ink border-sg-line'
                        }`}
                      >
                        {m.label}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Manual Discount Input */}
                <div>
                  <MoneyInput
                    label="手動折讓金額"
                    value={draftState?.manual_discount?.amount || 0}
                    onChange={(val) => handleManualDiscountChange(val, draftState?.manual_discount?.reason)}
                  />
                  <div className="pt-2">
                    <ReasonChips
                      presets={['熟客優惠', '設備問題', '抹零', '其他']}
                      value={draftState?.manual_discount?.reason || '熟客優惠'}
                      onChange={(r) => handleManualDiscountChange(draftState?.manual_discount?.amount || 0, r)}
                    />
                  </div>
                </div>
              </div>
            </div>

            {/* 5. Summary & Bottom Breakdown */}
            <div className="p-5 rounded-2xl border border-sg-line bg-sg-paper/40 space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
                {/* Left: Calculation Breakdown */}
                <div className="space-y-2 text-[13px]">
                  <h4 className="font-bold text-sg-ink text-[14px]">整單費用結算</h4>
                  <div className="flex justify-between text-sg-muted">
                    <span>入場人時合計</span>
                    <span className="font-num">NT${bill.order_summary?.entry_total ?? persons.reduce((s, p) => s + (p.entry?.amount || 0), 0)}</span>
                  </div>
                  <div className="flex justify-between text-sg-muted">
                    <span>智能板租借</span>
                    <span className="font-num">NT${bill.order_summary?.board_total ?? persons.reduce((s, p) => s + (p.board?.amount || 0), 0)}</span>
                  </div>
                  <div className="flex justify-between text-sg-muted">
                    <span>加購品項</span>
                    <span className="font-num">NT${bill.order_summary?.addon_total ?? 0}</span>
                  </div>
                  {draftState?.manual_discount?.amount > 0 && (
                    <div className="flex justify-between text-sg-brown font-bold">
                      <span>手動折讓（{draftState.manual_discount.reason}）</span>
                      <span className="font-num">-NT${draftState.manual_discount.amount}</span>
                    </div>
                  )}
                  {draftState?.total_override && (
                    <div className="flex justify-between text-sg-peach font-bold">
                      <span>直接改應收（{draftState.total_override.reason}）</span>
                      <span className="font-num">NT${draftState.total_override.amount}</span>
                    </div>
                  )}
                  <div className="pt-2 border-t border-sg-line flex items-baseline justify-between">
                    <div className="flex items-center gap-2">
                      <span className="text-[16px] font-bold text-sg-ink">整單應收總額</span>
                      <button
                        type="button"
                        onClick={() => setShowOverrideModal(true)}
                        className="text-[11px] text-sg-brown hover:underline font-bold"
                      >
                        直接改應收金額
                      </button>
                    </div>
                    <span className="text-[22px] font-bold text-sg-ink font-num">
                      NT${bill.total_amount ?? netDue}
                    </span>
                  </div>
                </div>

                {/* Right: Notes & Member Accrual */}
                <div className="space-y-3">
                  <div>
                    <label className="block text-[12px] font-bold text-sg-muted mb-1">
                      收據備註（會印在收據上）
                    </label>
                    <textarea
                      value={draftState?.note || ''}
                      onChange={(e) => updateDraft({ note: e.target.value })}
                      placeholder="選填，例如：特別包場、自備材料..."
                      rows={2}
                      className="w-full px-3 py-2 rounded-xl border border-sg-line text-[13px]"
                    />
                  </div>

                  <div className="p-3 rounded-xl bg-white border border-sg-line text-[12px]">
                    <span className="text-sg-muted block text-[11px]">會員時數累計（結帳後自動寫入）</span>
                    <span className="font-bold text-sg-ink">
                      計時 {persons.reduce((s, p) => s + (p.entry?.hours || 0), 0)} 人時 · 不限時 {persons.filter(p => p.mode === 'unlimited').length} 人次
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Footer Actions */}
        <div className="p-4 border-t border-sg-line bg-white flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Button variant="secondary" size="sm" onClick={handleOpenPreview}>
              <Printer className="w-4 h-4 mr-1 text-sg-muted" />
              預覽總單
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setShowSplitCollect(true)}
            >
              分開收款
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setShowWaiveModal(true)}
              disabled={unpaidPersons.length === 0}
            >
              免收（招待）
            </Button>
          </div>

          <div className="flex items-center gap-3">
            <div className="text-right">
              <span className="text-[11px] text-sg-muted block">未收 {unpaidPersons.length} 位</span>
              <span className="text-[16px] font-bold text-sg-ink font-num">NT${netDue}</span>
            </div>
            <Button
              variant="primary"
              size="md"
              onClick={() => setShowCollectModal(true)}
              disabled={unpaidPersons.length === 0}
            >
              一併收款
            </Button>
          </div>
        </div>
      </div>

      {/* Total Override Modal */}
      <ResponsivePanel
        isOpen={showOverrideModal}
        onClose={() => setShowOverrideModal(false)}
        title="直接修改整單應收金額"
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="secondary" size="sm" onClick={() => setShowOverrideModal(false)}>取消</Button>
            <Button variant="primary" size="sm" onClick={handleApplyOverride}>套用金額</Button>
          </div>
        }
      >
        <div className="space-y-4 py-2">
          <MoneyInput
            label="新的整單應收金額"
            value={overrideAmount}
            onChange={setOverrideAmount}
          />
          <ReasonChips
            presets={['熟客優惠', '活動促銷', '設備問題補償', '包場特惠', '其他']}
            value={overrideReason}
            onChange={setOverrideReason}
          />
          {draftState?.total_override && (
            <button
              type="button"
              onClick={() => {
                updateDraft(prev => ({ ...prev, total_override: null }));
                setShowOverrideModal(false);
              }}
              className="text-sg-danger text-[12px] font-bold hover:underline"
            >
              清除直接改應收，改回依細項計算
            </button>
          )}
        </div>
      </ResponsivePanel>

      {/* Receipt Preview Modal */}
      <ResponsivePanel
        isOpen={showPreviewModal}
        onClose={() => setShowPreviewModal(false)}
        title="總單收據預覽 (58mm)"
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="secondary" size="sm" onClick={() => setShowPreviewModal(false)}>關閉</Button>
            <Button
              variant="primary"
              size="sm"
              onClick={() => {
                window.print();
              }}
            >
              瀏覽器列印
            </Button>
          </div>
        }
      >
        <div
          className="bg-sg-paper/60 p-4 rounded-xl border border-sg-line font-mono text-[12px] overflow-x-auto max-h-[60vh]"
          dangerouslySetInnerHTML={{ __html: previewHtml }}
        />
      </ResponsivePanel>

      {/* Collect Modal (Together for all unpaid) */}
      <ResponsivePanel
        isOpen={showCollectModal}
        onClose={() => setShowCollectModal(false)}
        title={`一併收款 NT$${netDue}`}
        subtitle={`${unpaidPersons.length} 位顧客 · 單號 ${booking.ref_display || bookingRef}`}
        footer={
          <div className="space-y-3">
            {collectError && (
              <div className="p-2.5 rounded-xl bg-sg-danger-soft text-sg-danger text-[12px] font-bold">
                {collectError}
              </div>
            )}
            <div className="flex items-center justify-between">
              <label className="flex items-center gap-2 text-[13px] text-sg-ink cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={collectAutoPrint}
                  onChange={(e) => setCollectAutoPrint(e.target.checked)}
                  className="w-4 h-4 rounded text-sg-brown focus:ring-sg-brown"
                />
                <Printer className="w-4 h-4 text-sg-muted" />
                <span>結帳完成自動列印收據</span>
              </label>
              <Button
                variant="primary"
                size="md"
                onClick={handleCollectFullOrder}
                loading={collectLoading}
              >
                確認收款 NT${netDue}
              </Button>
            </div>
          </div>
        }
      >
        <div className="space-y-4 py-2">
          <div>
            <span className="text-[13px] font-bold text-sg-ink block mb-2">付款方式</span>
            <PayMethodGrid value={collectMethod} onChange={setCollectMethod} />
          </div>

          {collectMethod === 'cash' && (
            <CashPad
              dueAmount={netDue}
              cashReceived={collectCashReceived || netDue}
              onChange={setCollectCashReceived}
            />
          )}

          <div>
            <label className="block text-[12px] text-sg-muted font-medium mb-1">收款備註</label>
            <input
              type="text"
              value={collectNote}
              onChange={(e) => setCollectNote(e.target.value)}
              placeholder="可選填..."
              className="w-full px-3 py-1.5 rounded-xl border border-sg-line text-[13px]"
            />
          </div>

          <PrinterStatusLine />
        </div>
      </ResponsivePanel>

      {/* Waive Modal */}
      <ConfirmPanel
        isOpen={showWaiveModal}
        onClose={() => {
          setShowWaiveModal(false);
          setWaiveError(null);
        }}
        onConfirm={handleWaiveOrder}
        title="確認免收整筆訂單？"
        message={`將免收剩餘 ${unpaidPersons.length} 位的全部費用（NT$${netDue}），此動作將記入帳務異動紀錄。`}
        danger={false}
        loading={waiveLoading}
      >
        {waiveError && (
          <div className="mb-3 p-2.5 bg-rose-50 border border-rose-200 text-rose-700 text-xs rounded-xl font-bold">
            {waiveError}
          </div>
        )}
        <ReasonChips
          presets={['店家招待', '活動特惠', '熟客免收', '客訴補償', '其他']}
          value={waiveReason}
          onChange={setWaiveReason}
        />
      </ConfirmPanel>

      {/* Split Collect View */}
      {showSplitCollect && (
        <SplitCollectView
          isOpen={showSplitCollect}
          onClose={() => {
            setShowSplitCollect(false);
            loadBill();
          }}
          bookingRef={bookingRef}
          billData={billData}
          onPaymentSuccess={() => {
            loadBill();
            if (onPaymentSuccess) onPaymentSuccess();
          }}
        />
      )}

      {/* Member Pass Center Modal */}
      {showPassCenter && (
        <PassTenderSheet
          isOpen={showPassCenter}
          onClose={() => setShowPassCenter(false)}
          bookingRef={bookingRef}
          personNo={1}
          hourlyRate={pricing.hourly}
          onSelectPass={() => {
            setShowPassCenter(false);
          }}
        />
      )}
    </div>
  );
}
