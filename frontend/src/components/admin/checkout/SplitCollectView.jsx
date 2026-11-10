import React, { useState } from 'react';
import { Lock, Plus, RotateCcw, AlertTriangle, Check, Ticket, Printer, MoreVertical } from 'lucide-react';
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
import PassTenderSheet from './PassTenderSheet';
import PaymentCompleteView from './PaymentCompleteView';
import { printJobOnThisDevice, isPrintGloballyEnabled } from '../../../utils/sunmiPrinter';

export default function SplitCollectView({
  isOpen = false,
  onClose,
  bookingRef,
  billData,
  onPaymentSuccess,
  initialPersonNo = null,
  onOpenSharedSplit = null,
  initialSupplementPerson = null
}) {
  const bill = billData?.bill || {};
  const persons = bill.persons || [];
  const pricing = billData?.pricing || {};

  // Selection of unpaid persons to collect
  const [selectedPersonNos, setSelectedPersonNos] = useState(() => {
    if (initialPersonNo != null) return [initialPersonNo];
    return persons.filter(p => !p.paid && !p.is_paid && !p.is_frozen).map(p => p.person_no);
  });

  const [method, setMethod] = useState('cash');
  const [cashReceived, setCashReceived] = useState(0);
  const [passTenders, setPassTenders] = useState([]);
  const [note, setNote] = useState('');
  const [autoPrint, setAutoPrint] = useState(true);
  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState(null);
  const [showMoreMenu, setShowMoreMenu] = useState(false);
  const [showMarkUnpaidModal, setShowMarkUnpaidModal] = useState(false);
  const [unpaidReason, setUnpaidReason] = useState('收錯訂單');
  const [unpaidLoading, setUnpaidLoading] = useState(false);
  const [toastMsg, setToastMsg] = useState(null);
  const [successPaymentData, setSuccessPaymentData] = useState(null);

  // Sub-modal states
  const [passSheetPersonNo, setPassSheetPersonNo] = useState(null);
  const [supplementTarget, setSupplementTarget] = useState(initialSupplementPerson || null);
  const [refundTarget, setRefundTarget] = useState(null);
  const [voidTargetPayment, setVoidTargetPayment] = useState(null);
  const [showWaiveModal, setShowWaiveModal] = useState(false);

  // Sub-modal form states
  const [supplementMethod, setSupplementMethod] = useState('cash');
  const [supplementType, setSupplementType] = useState(() => {
    if (initialSupplementPerson?.pending_supplement > 0) return 'pending';
    return 'addon';
  });
  const [extraHours, setExtraHours] = useState(0.5);
  const addonPresets = (billData?.addon_presets && billData.addon_presets.length > 0)
    ? billData.addon_presets
    : [
        { id: 'keychain', name: '鑰匙圈', price: 60 },
        { id: 'drink', name: '飲料', price: 40 },
        { id: 'socks', name: '防滑襪', price: 50 }
      ];
  const [selectedAddons, setSelectedAddons] = useState(() => ({
    [addonPresets[0]?.name || '鑰匙圈']: 1
  }));
  const [refundMethod, setRefundMethod] = useState('cash');
  const [actionReason, setActionReason] = useState('');
  const [actionAmount, setActionAmount] = useState(() => {
    if (initialSupplementPerson?.pending_supplement > 0) return initialSupplementPerson.pending_supplement;
    return 60;
  });
  const [actionItemLabel, setActionItemLabel] = useState(() => {
    if (initialSupplementPerson?.pending_supplement > 0) return '整單共同項目補收';
    return '加時 0.5 小時';
  });

  // Supplement calculations (Spec 6.18)
  const supplementOptions = [];
  if (supplementTarget?.pending_supplement > 0) {
    supplementOptions.push({
      key: 'pending',
      label: `待補收 NT$${supplementTarget.pending_supplement}`
    });
  }
  supplementOptions.push(
    { key: 'addon', label: '加購' },
    { key: 'hours', label: '加時' },
    { key: 'unlimited_diff', label: '改成不限時的差額' },
    { key: 'other', label: '其他' }
  );

  const targetPersonPayment = (billData?.payments || [])
    .filter(pay => pay.status === 'valid' && (pay.person_nos || []).includes(supplementTarget?.person_no))
    .find(pay => pay.kind === 'charge');
  const targetPersonInPay = (targetPersonPayment?.breakdown_json?.persons || []).find(
    p => Number(p.person_no) === supplementTarget?.person_no
  );
  const personPaidEntry = targetPersonInPay?.entry?.amount ?? supplementTarget?.entry?.amount ?? 600;
  const unlimitedPrice = pricing.unlimited || 750;
  const diffAmount = Math.max(0, unlimitedPrice - personPaidEntry);

  const hourlyRate = pricing.hourly || 150;
  const hoursAmount = Math.round(extraHours * hourlyRate);

  const addonTotal = addonPresets.reduce(
    (sum, a) => sum + (selectedAddons[a.name] || 0) * (a.price || 0),
    0
  );

  let currentSupplementAmount = 0;
  let supplementDetailDesc = '';

  if (supplementType === 'pending') {
    currentSupplementAmount = supplementTarget?.pending_supplement || 0;
    supplementDetailDesc = `待補收 NT$${currentSupplementAmount}`;
  } else if (supplementType === 'addon') {
    currentSupplementAmount = addonTotal;
    const activeAddons = addonPresets.filter(a => (selectedAddons[a.name] || 0) > 0);
    if (activeAddons.length > 0) {
      supplementDetailDesc = activeAddons
        .map(a => `${a.name} ×${selectedAddons[a.name]} NT$${selectedAddons[a.name] * a.price}`)
        .join('、');
    } else {
      supplementDetailDesc = '加購品項 NT$0';
    }
  } else if (supplementType === 'hours') {
    currentSupplementAmount = hoursAmount;
    supplementDetailDesc = `時數 +${extraHours} 小時 NT$${hoursAmount}`;
  } else if (supplementType === 'unlimited_diff') {
    currentSupplementAmount = diffAmount;
    supplementDetailDesc = `升級不限時差額 NT$${diffAmount}`;
  } else if (supplementType === 'other') {
    currentSupplementAmount = actionAmount;
    supplementDetailDesc = `${actionItemLabel || '其他'} NT$${actionAmount}`;
  }

  const supplementPersonPaid = (() => {
    if (!supplementTarget) return 0;
    const pPayments = (billData?.payments || []).filter(
      pay => pay.status === 'valid' && (pay.person_nos || []).includes(supplementTarget.person_no)
    );
    if (pPayments.length > 0) {
      const paid = pPayments
        .filter(p => p.kind === 'charge' || p.kind === 'supplement')
        .reduce((s, p) => s + p.amount, 0);
      const refunded = pPayments
        .filter(p => p.kind === 'refund')
        .reduce((s, p) => s + p.amount, 0);
      return Math.max(0, paid - refunded);
    }
    return supplementTarget.total || 0;
  })();

  const combinedPersonTotal = supplementPersonPaid + currentSupplementAmount;

  const handleOpenRefund = (p) => {
    setRefundTarget(p);
    const pPayments = (billData?.payments || []).filter(
      pay => pay.status === 'valid' && (pay.person_nos || []).includes(p.person_no)
    );
    const origPayment = [...pPayments].reverse().find(pay => pay.kind === 'charge' || pay.kind === 'supplement') || pPayments[0];
    const origMethod = origPayment?.method || 'cash';
    const initialMethod = (origMethod === 'line_pay') ? 'linepay' : origMethod;
    setRefundMethod(initialMethod);
    const paid = pPayments.filter(pay => pay.kind === 'charge' || pay.kind === 'supplement').reduce((s, pay) => s + pay.amount, 0);
    const refunded = pPayments.filter(pay => pay.kind === 'refund').reduce((s, pay) => s + pay.amount, 0);
    const maxRef = Math.max(0, paid - refunded) || p.total || 0;
    setActionAmount(maxRef);
    setActionReason('');
  };

  const refundTargetPayments = refundTarget
    ? (billData?.payments || []).filter(
        pay => pay.status === 'valid' && (pay.person_nos || []).includes(refundTarget.person_no)
      )
    : [];
  const refundTargetPaid = refundTargetPayments
    .filter(pay => pay.kind === 'charge' || pay.kind === 'supplement')
    .reduce((s, pay) => s + pay.amount, 0);
  const refundTargetRefunded = refundTargetPayments
    .filter(pay => pay.kind === 'refund')
    .reduce((s, pay) => s + pay.amount, 0);
  const refundTargetMaxRefundable = refundTargetPayments.length > 0
    ? Math.max(0, refundTargetPaid - refundTargetRefunded)
    : (refundTarget?.total || 0);

  const hasPassPayment = refundTargetPayments.some(
    pay => pay.method === 'pass' || (Array.isArray(pay.pass_json) && pay.pass_json.length > 0)
  );

  const refundMethodOptions = [
    { code: 'cash', label: '現金退回' },
    { code: 'linepay', label: 'LINE Pay 退回' },
    { code: 'transfer', label: '銀行轉帳退回' },
    { code: 'other', label: '其他' }
  ];
  if (hasPassPayment) {
    refundMethodOptions.push({ code: 'pass', label: '卡券退回' });
  }

  const selectedPersons = persons.filter(p => selectedPersonNos.includes(p.person_no));
  const rawDueAmount = selectedPersons.reduce((sum, p) => sum + (p.total || 0), 0);

  // Subtract pass discount
  const passDiscountTotal = passTenders.reduce((sum, pt) => {
    const p = selectedPersons.find(sp => sp.person_no === pt.person_no);
    return sum + Math.min(p?.entry?.amount || 0, pt.units * (pricing.hourly || 150));
  }, 0);

  const netCashDue = Math.max(0, rawDueAmount - passDiscountTotal);

  const togglePerson = (pNo) => {
    if (selectedPersonNos.includes(pNo)) {
      setSelectedPersonNos(selectedPersonNos.filter(n => n !== pNo));
    } else {
      setSelectedPersonNos([...selectedPersonNos, pNo]);
    }
  };

  const handleMethodChange = (m) => {
    if (m === 'pass') {
      if (selectedPersonNos.length === 0) {
        setErrorMessage('請先選擇一位顧客再折抵卡券');
        return;
      }
      setPassSheetPersonNo(selectedPersonNos[0]);
      return;
    }
    setMethod(m);
  };

  const handleCollect = async () => {
    if (selectedPersonNos.length === 0) {
      setErrorMessage('請至少勾選一位顧客收款');
      return;
    }
    if (method === 'cash' && cashReceived > 0 && cashReceived < netCashDue) {
      setErrorMessage(`實收現金不足（應收 NT$${netCashDue}）`);
      return;
    }

    try {
      setLoading(true);
      setErrorMessage(null);
      const clientBatchId = (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : `b-${Date.now()}`;

      const res = await api.post(`/billing/${bookingRef}/collect`, {
        client_batch_id: clientBatchId,
        person_nos: selectedPersonNos,
        expected_amount: rawDueAmount,
        method: method === 'pass' ? 'cash' : method,
        cash_received: method === 'cash' ? (cashReceived || netCashDue) : null,
        pass_tenders: passTenders,
        note,
        print: autoPrint
      });

      // Print jobs created automatically by backend
      if (res.data?.print_jobs?.length) {
        for (const job of res.data.print_jobs) {
          try {
            await printJobOnThisDevice(job);
          } catch (printErr) {
            console.warn('[SplitCollect] Local print trigger:', printErr);
          }
        }
      }

      const payData = {
        ...res.data,
        booking_ref: res.data?.booking_ref || bookingRef,
        status: res.data?.status || { code: 'paid', label: '已結清' }
      };
      setSuccessPaymentData(payData);
      if (onPaymentSuccess) {
        onPaymentSuccess(payData);
      }
    } catch (err) {
      console.error(err);
      if (err.response?.status === 409) {
        setErrorMessage('金額剛剛有變動，請重新確認帳單！');
      } else {
        setErrorMessage(err.response?.data?.error || '收款失敗');
      }
    } finally {
      setLoading(false);
    }
  };

  const handleSupplement = async () => {
    if (!supplementTarget) return;
    try {
      setLoading(true);
      let items = [];
      if (supplementType === 'pending') {
        items = [{ type: 'pending', amount: currentSupplementAmount, label: '結清待補收' }];
      } else if (supplementType === 'addon') {
        items = Object.entries(selectedAddons)
          .filter(([_, qty]) => qty > 0)
          .map(([name, qty]) => {
            const preset = addonPresets.find(a => a.name === name);
            return {
              type: 'addon',
              name,
              price: preset?.price || 0,
              qty
            };
          });
        if (items.length === 0) {
          setErrorMessage('請至少選擇一項加購品');
          setLoading(false);
          return;
        }
      } else if (supplementType === 'hours') {
        items = [{
          type: 'hours',
          hours: extraHours
        }];
      } else if (supplementType === 'unlimited_diff') {
        items = [{
          type: 'unlimited_diff',
          unlimited_price: unlimitedPrice
        }];
      } else if (supplementType === 'other') {
        items = [{
          type: 'other',
          label: actionItemLabel || '其他',
          amount: actionAmount
        }];
      }

      await api.post(`/billing/${bookingRef}/supplement`, {
        person_no: supplementTarget.person_no,
        items,
        method: supplementMethod,
        cash_received: supplementMethod === 'cash' ? currentSupplementAmount : null,
        print: autoPrint
      });
      setSupplementTarget(null);
      if (onPaymentSuccess) onPaymentSuccess();
      onClose();
    } catch (err) {
      setErrorMessage(err.response?.data?.error || '補收失敗');
    } finally {
      setLoading(false);
    }
  };

  const handleRefund = async () => {
    if (!refundTarget) return;
    if (!actionReason) {
      setErrorMessage('請填寫退款原因');
      return;
    }
    try {
      setLoading(true);
      await api.post(`/billing/${bookingRef}/refund`, {
        person_no: refundTarget.person_no,
        amount: actionAmount,
        method: refundMethod,
        reason: actionReason,
        print: autoPrint
      });
      setRefundTarget(null);
      if (onPaymentSuccess) onPaymentSuccess();
      onClose();
    } catch (err) {
      setErrorMessage(err.response?.data?.error || '退款失敗');
    } finally {
      setLoading(false);
    }
  };

  const handleVoidPayment = async () => {
    if (!voidTargetPayment) return;
    if (!actionReason) {
      setErrorMessage('請填寫作廢原因');
      return;
    }
    try {
      setLoading(true);
      await api.post(`/billing/payments/${voidTargetPayment.id}/void`, {
        reason: actionReason
      });
      setVoidTargetPayment(null);
      if (onPaymentSuccess) onPaymentSuccess();
      onClose();
    } catch (err) {
      setErrorMessage(err.response?.data?.error || '作廢失敗');
    } finally {
      setLoading(false);
    }
  };

  const handleWaive = async () => {
    if (!actionReason) {
      setErrorMessage('請填寫免收原因');
      return;
    }
    try {
      setLoading(true);
      await api.post(`/billing/${bookingRef}/waive`, {
        person_nos: selectedPersonNos,
        reason: actionReason
      });
      setShowWaiveModal(false);
      if (onPaymentSuccess) onPaymentSuccess();
      onClose();
    } catch (err) {
      setErrorMessage(err.response?.data?.error || '免收失敗');
    } finally {
      setLoading(false);
    }
  };

  const handleMarkUnpaid = async () => {
    if (!unpaidReason || !unpaidReason.trim()) return;
    try {
      setUnpaidLoading(true);
      const res = await api.post(`/billing/${bookingRef}/mark-unpaid`, {
        reason: unpaidReason.trim()
      });
      setShowMarkUnpaidModal(false);
      setToastMsg('已標記未結帳');
      window.dispatchEvent(new CustomEvent('admin-data-updated'));
      if (onPaymentSuccess) {
        onPaymentSuccess({
          booking_ref: bookingRef,
          status: res.data?.status || { code: 'unpaid', label: '未結帳' },
          message: '已標記未結帳'
        });
      }
      setTimeout(() => {
        onClose();
      }, 800);
    } catch (err) {
      console.error('[handleMarkUnpaid] Error:', err);
      setErrorMessage(err.response?.data?.error || err.response?.data?.message || '標記未結帳失敗');
    } finally {
      setUnpaidLoading(false);
    }
  };

  return (
    <>
      <ResponsivePanel
        isOpen={isOpen}
        onClose={onClose}
        title={
          <div>
            <button
              type="button"
              data-testid="back-to-workbench-btn"
              onClick={onClose}
              className="text-[12px] font-normal text-sg-brown hover:text-sg-brown-dark hover:underline flex items-center gap-0.5 mb-1 cursor-pointer"
            >
              ‹ 回結帳工作台
            </button>
            <span>{successPaymentData ? '收款完成' : '分開收款與帳務作業'}</span>
          </div>
        }
        subtitle={`預約單號 ${billData?.booking?.ref_display || bookingRef}`}
        headerRight={<StatusPill data-testid="split-status-pill" status={billData?.status?.code || 'unpaid'} label={billData?.status?.label} />}
        footer={
          successPaymentData ? null : (
            <div className="space-y-2.5">
              {errorMessage && (
                <div className="p-2.5 rounded-xl bg-sg-danger-soft text-sg-danger text-[12px] font-bold">
                  {errorMessage}
                </div>
              )}
              {/* Single line print toggle with PrinterStatusLine (D1) */}
              {isPrintGloballyEnabled() && (
                <div className="flex items-center justify-between">
                  <label className="flex items-center gap-2 text-[13px] text-sg-ink cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={autoPrint}
                      onChange={(e) => setAutoPrint(e.target.checked)}
                      className="w-4 h-4 rounded text-sg-brown focus:ring-sg-brown cursor-pointer"
                    />
                    <span>收款後列印收據</span>
                  </label>

                  <PrinterStatusLine
                    printer={billData?.printer || { online: true, state: 'ok', label: '在線 · 正常' }}
                  />
                </div>
              )}

              {/* Bottom buttons:免收 moved to ⋯ menu, text never wraps */}
              <div className="flex items-center justify-between gap-2 pt-1 border-t border-sg-line/50">
                <div className="relative">
                  <button
                    type="button"
                    data-testid="split-more-btn"
                    onClick={() => setShowMoreMenu(!showMoreMenu)}
                    className="p-2 rounded-xl border border-sg-line bg-white hover:bg-sg-paper text-sg-muted hover:text-sg-ink transition"
                    title="更多帳務操作"
                  >
                    <MoreVertical className="w-4 h-4" />
                  </button>

                  {showMoreMenu && (
                    <div className="absolute left-0 bottom-full mb-1 w-36 bg-white border border-sg-line rounded-2xl shadow-lg z-30 py-1 text-[13px] animate-fade-in">
                      <button
                        type="button"
                        disabled={selectedPersonNos.length === 0}
                        onClick={() => {
                          setShowMoreMenu(false);
                          setShowWaiveModal(true);
                        }}
                        className="w-full text-left px-3 py-1.5 hover:bg-sg-paper text-sg-ink font-medium disabled:opacity-40"
                      >
                        免收此對象
                      </button>
                      <button
                        type="button"
                        data-testid="split-mark-unpaid-btn"
                        onClick={() => {
                          setShowMoreMenu(false);
                          setUnpaidReason('收錯訂單');
                          setShowMarkUnpaidModal(true);
                        }}
                        className="w-full text-left px-3 py-1.5 hover:bg-sg-paper text-sg-danger font-medium"
                      >
                        標記未結帳
                      </button>
                    </div>
                  )}
                </div>

                <Button
                  variant="primary"
                  size="md"
                  onClick={handleCollect}
                  loading={loading}
                  disabled={selectedPersonNos.length === 0}
                  className="whitespace-nowrap"
                >
                  確認收款 NT${netCashDue}
                </Button>
              </div>
            </div>
          )
        }
      >
        {successPaymentData ? (
          <PaymentCompleteView
            data={successPaymentData}
            bookingRef={bookingRef}
            booking={billData?.booking}
            onNextPerson={(nextPNo) => {
              setSuccessPaymentData(null);
              setSelectedPersonNos([nextPNo]);
            }}
            onDone={() => {
              if (onPaymentSuccess) onPaymentSuccess(successPaymentData);
              onClose();
            }}
          />
        ) : (
          <div className="space-y-4 py-2">
            {/* Persons Checklist */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-[13px] font-bold text-sg-ink">選擇本次結帳對象</span>
                <button
                  type="button"
                  data-testid="select-all-unpaid-btn"
                  onClick={() => {
                    const unpaidNos = persons.filter(p => !p.paid && !p.is_paid && !p.is_frozen).map(p => p.person_no);
                    setSelectedPersonNos(unpaidNos);
                  }}
                  className="text-[12px] font-bold text-sg-brown hover:text-sg-brown-dark hover:underline cursor-pointer"
                >
                  全選未付
                </button>
              </div>

              {/* Shared items split row */}
              <button
                type="button"
                data-testid="open-shared-split-panel-btn"
                onClick={() => {
                  if (onOpenSharedSplit) {
                    onOpenSharedSplit();
                  }
                }}
                className="w-full p-2.5 rounded-2xl border border-sg-line bg-white hover:bg-sg-paper/60 transition flex items-center justify-between text-left group"
              >
                <div className="flex items-center gap-2">
                  <span className="text-[13px] font-bold text-sg-ink">整單共用項目 · 改分攤</span>
                  {bill.order_addons?.length > 0 && (
                    <span className="text-[11px] text-sg-muted font-medium">({bill.order_addons.length} 項)</span>
                  )}
                </div>
                <span className="text-[13px] text-sg-muted group-hover:text-sg-ink transition font-bold">›</span>
              </button>

              <div className="space-y-2">
                {persons.map((p) => {
                  const isPaid = Boolean(p.paid || p.is_paid || p.is_frozen);
                  const isSelected = selectedPersonNos.includes(p.person_no);
                  const hoursVal = p.entry?.hours ?? p.hours ?? 2;

                  if (isPaid) {
                    return (
                      <div
                        key={p.person_no}
                        className="p-3 rounded-2xl bg-sg-paper/60 border border-sg-line space-y-1.5"
                      >
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-2.5">
                            <Lock className="w-4 h-4 text-sg-muted flex-shrink-0" />
                            <div>
                              <div className="text-[13px] font-bold text-sg-ink">
                                第 {p.person_no} 位 ({p.seat_code || '未帶位'})
                              </div>
                              <div className="flex items-center gap-1.5">
                                <span className="text-[11px] text-sg-sage-ink font-bold">已結清 NT${p.total}</span>
                                {p.pending_supplement > 0 && (
                                  <span className="text-[10px] font-bold text-amber-800 bg-amber-100 px-1.5 py-0.5 rounded border border-amber-300">
                                    待補收 NT${p.pending_supplement}
                                  </span>
                                )}
                              </div>
                            </div>
                          </div>

                          <div className="flex items-center gap-1.5">
                            <button
                              type="button"
                              onClick={() => {
                                setSupplementTarget(p);
                                setSupplementMethod('cash');
                                if (p.pending_supplement > 0) {
                                  setSupplementType('pending');
                                } else {
                                  setSupplementType('addon');
                                }
                                setActionAmount(p.pending_supplement || 60);
                              }}
                              className="px-2.5 py-1 rounded-xl text-[12px] font-bold border border-sg-line bg-white hover:bg-sg-paper"
                            >
                              補收
                            </button>
                            <button
                              type="button"
                              onClick={() => handleOpenRefund(p)}
                              className="px-2.5 py-1 rounded-xl text-[12px] font-bold border border-sg-line bg-white hover:bg-sg-paper text-sg-danger"
                            >
                              退款
                            </button>
                          </div>
                        </div>
                        <div className="text-[11px] text-sg-muted pl-6">
                          第 {p.person_no} 位已付，不能直接改時數。要調整請按「補收」
                        </div>
                      </div>
                    );
                  }

                  return (
                    <div
                      key={p.person_no}
                      data-testid={`split-person-card-${p.person_no}`}
                      onClick={() => togglePerson(p.person_no)}
                      className={`p-3 rounded-2xl border flex items-center justify-between cursor-pointer transition select-none ${
                        isSelected
                          ? 'bg-sg-brown-soft border-sg-brown'
                          : 'bg-white border-sg-line hover:border-sg-muted'
                      }`}
                    >
                      <div className="flex items-center gap-3">
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={() => {}}
                          className="w-4 h-4 rounded text-sg-brown focus:ring-sg-brown pointer-events-none"
                        />
                        <div>
                          <div className="text-[13px] font-bold text-sg-ink">
                            第 {p.person_no} 位 ({p.seat_code || '未帶位'})
                          </div>
                          <div className="text-[12px] text-sg-muted">
                            時數 {hoursVal} 小時 · 應付 NT${p.total || 0}
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Payment Method Selector */}
            {selectedPersonNos.length > 0 && (
              <div className="space-y-3 pt-2 border-t border-sg-line">
                <span className="text-[13px] font-bold text-sg-ink block">選擇收款方式</span>
                <PayMethodGrid value={method} onChange={handleMethodChange} />

                {method === 'cash' && (
                  <CashPad
                    dueAmount={netCashDue}
                    cashReceived={cashReceived || netCashDue}
                    onChange={setCashReceived}
                  />
                )}

                <div>
                  <label className="block text-[12px] text-sg-muted font-medium mb-1">收款備註</label>
                  <input
                    type="text"
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    placeholder="可選填..."
                    className="w-full px-3 py-1.5 rounded-xl border border-sg-line text-[13px]"
                  />
                </div>
              </div>
            )}

            {/* Void Previous Payments List */}
            {billData?.payments?.length > 0 && (
              <div className="pt-3 border-t border-sg-line space-y-2">
                <span className="text-[12px] font-bold text-sg-muted uppercase tracking-wider block">歷史收款紀錄</span>
                <div className="space-y-1.5">
                  {billData.payments.map((pay) => (
                    <div
                      key={pay.id}
                      className="p-2.5 rounded-xl border border-sg-line bg-sg-paper/40 flex items-center justify-between text-[12px]"
                    >
                      <div>
                        <span className="font-bold text-sg-ink mr-2">{pay.payment_no}</span>
                        <span className="text-sg-muted">{pay.method} NT${pay.amount}</span>
                        {pay.status === 'voided' && <span className="ml-2 text-sg-danger font-bold">(已作廢)</span>}
                      </div>
                      {pay.status === 'valid' && (
                        <button
                          type="button"
                          onClick={() => {
                            setVoidTargetPayment(pay);
                            setActionReason('');
                          }}
                          className="text-sg-danger hover:underline font-bold"
                        >
                          作廢
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </ResponsivePanel>

      {/* Pass Tender Sheet */}
      {passSheetPersonNo && (
        <PassTenderSheet
          isOpen={Boolean(passSheetPersonNo)}
          onClose={() => setPassSheetPersonNo(null)}
          bookingRef={bookingRef}
          personNo={passSheetPersonNo}
          onApply={(tenders) => {
            setPassTenders(tenders);
            setPassSheetPersonNo(null);
          }}
        />
      )}

      {/* Waive Modal */}
      {showWaiveModal && (
        <ResponsivePanel
          isOpen={showWaiveModal}
          onClose={() => setShowWaiveModal(false)}
          title="免收帳款"
          subtitle={`第 ${selectedPersonNos.join('、')} 位 · 金額 NT$${netCashDue}`}
          footer={
            <div className="flex items-center justify-end gap-2">
              <Button variant="secondary" size="sm" onClick={() => setShowWaiveModal(false)}>
                取消
              </Button>
              <Button variant="danger" size="sm" onClick={handleWaive} loading={loading}>
                確認免收
              </Button>
            </div>
          }
        >
          <div className="space-y-3 py-2">
            <span className="text-[12px] font-bold text-sg-muted uppercase tracking-wider block">免收原因</span>
            <ReasonChips
              reasons={['店家招待', '體驗滿額折扣', '熟客招待', '客訴補償', '其他']}
              selected={actionReason}
              onSelect={setActionReason}
            />
            <input
              type="text"
              value={actionReason}
              onChange={(e) => setActionReason(e.target.value)}
              placeholder="請填寫或選擇免收原因..."
              className="w-full px-3 py-2 rounded-xl border border-sg-line text-[13px]"
            />
          </div>
        </ResponsivePanel>
      )}

      {/* Supplement Modal */}
      {supplementTarget && (
        <ResponsivePanel
          isOpen={Boolean(supplementTarget)}
          onClose={() => setSupplementTarget(null)}
          title={`補收：第 ${supplementTarget.person_no} 位`}
          subtitle="現場臨時加購或逾時加時"
          footer={
            <div className="flex items-center justify-end gap-2">
              <Button variant="secondary" size="sm" onClick={() => setSupplementTarget(null)}>
                取消
              </Button>
              <Button
                variant="primary"
                size="sm"
                data-testid="confirm-supplement-btn"
                onClick={handleSupplement}
                loading={loading}
              >
                補收 NT${currentSupplementAmount}
              </Button>
            </div>
          }
        >
          <div className="space-y-4 py-2">
            {/* Payment Method */}
            <div>
              <label className="block text-[12px] font-bold text-sg-ink mb-1.5">付款方式</label>
              <PayMethodGrid
                value={supplementMethod}
                onChange={setSupplementMethod}
                hidePass={true}
              />
            </div>

            {/* Supplement Type Chips */}
            <div className="space-y-1.5">
              <label className="block text-[12px] font-bold text-sg-ink">補收什麼</label>
              <div className="flex flex-wrap gap-1.5">
                {supplementOptions.map((opt) => (
                  <button
                    key={opt.key}
                    type="button"
                    data-testid={`supplement-chip-${opt.key}`}
                    onClick={() => setSupplementType(opt.key)}
                    className={`px-3 py-1.5 rounded-xl text-[12px] font-bold border transition active:scale-[0.98] ${
                      supplementType === opt.key
                        ? 'bg-sg-brown text-white border-sg-brown shadow-sm'
                        : 'bg-white text-sg-ink border-sg-line hover:border-sg-muted hover:bg-sg-paper'
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Type-Specific Content */}
            {supplementType === 'pending' && (
              <div className="p-3 bg-amber-50 border border-amber-200 rounded-xl text-[13px] text-amber-900 font-bold flex items-center justify-between">
                <span>結清待補收項目</span>
                <span className="font-num text-[15px]">NT${supplementTarget.pending_supplement}</span>
              </div>
            )}

            {supplementType === 'addon' && (
              <div className="space-y-2">
                <label className="block text-[12px] font-bold text-sg-ink">選擇加購品項與數量</label>
                <div className="grid grid-cols-2 gap-2">
                  {addonPresets.map((preset) => {
                    const qty = selectedAddons[preset.name] || 0;
                    const isSelected = qty > 0;
                    return (
                      <div
                        key={preset.id || preset.name}
                        data-testid={`addon-item-${preset.name}`}
                        className={`p-2.5 rounded-xl border flex items-center justify-between transition ${
                          isSelected
                            ? 'bg-sg-brown-soft border-sg-brown'
                            : 'bg-white border-sg-line hover:border-sg-muted'
                        }`}
                      >
                        <div
                          className="flex-1 cursor-pointer select-none"
                          onClick={() => {
                            setSelectedAddons(prev => ({
                              ...prev,
                              [preset.name]: (prev[preset.name] || 0) + 1
                            }));
                          }}
                        >
                          <div className="text-[13px] font-bold text-sg-ink">{preset.name}</div>
                          <div className="text-[12px] text-sg-muted font-num">NT${preset.price}</div>
                        </div>
                        {isSelected ? (
                          <div className="flex items-center gap-1.5 ml-2">
                            <button
                              type="button"
                              onClick={() => {
                                setSelectedAddons(prev => {
                                  const currentQty = prev[preset.name] || 0;
                                  if (currentQty <= 1) {
                                    const copy = { ...prev };
                                    delete copy[preset.name];
                                    return copy;
                                  }
                                  return { ...prev, [preset.name]: currentQty - 1 };
                                });
                              }}
                              className="w-6 h-6 rounded-lg bg-white border border-sg-line flex items-center justify-center font-bold text-sg-ink hover:bg-sg-paper text-[12px]"
                            >
                              −
                            </button>
                            <span className="w-5 text-center font-bold text-[13px] font-num">{qty}</span>
                            <button
                              type="button"
                              onClick={() => {
                                setSelectedAddons(prev => ({
                                  ...prev,
                                  [preset.name]: (prev[preset.name] || 0) + 1
                                }));
                              }}
                              className="w-6 h-6 rounded-lg bg-white border border-sg-line flex items-center justify-center font-bold text-sg-ink hover:bg-sg-paper text-[12px]"
                            >
                              +
                            </button>
                          </div>
                        ) : (
                          <button
                            type="button"
                            onClick={() => {
                              setSelectedAddons(prev => ({
                                ...prev,
                                [preset.name]: 1
                              }));
                            }}
                            className="px-2 py-1 rounded-lg border border-sg-line bg-white hover:bg-sg-paper text-[11px] font-bold text-sg-ink"
                          >
                            +1
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {supplementType === 'hours' && (
              <div className="space-y-2">
                <label className="block text-[12px] font-bold text-sg-ink">加時時數（每 0.5 小時）</label>
                <div className="flex items-center justify-between p-3 bg-white border border-sg-line rounded-xl">
                  <div className="flex items-center border border-sg-line rounded-xl bg-sg-paper/40 overflow-hidden">
                    <button
                      type="button"
                      data-testid="hours-decrement-btn"
                      onClick={() => setExtraHours(prev => Math.max(0.5, prev - 0.5))}
                      className="w-10 h-10 flex items-center justify-center font-bold text-sg-ink hover:bg-sg-paper active:scale-95 transition"
                    >
                      −
                    </button>
                    <span className="w-20 text-center font-bold text-[14px] text-sg-ink font-num">
                      +{extraHours} 小時
                    </span>
                    <button
                      type="button"
                      data-testid="hours-increment-btn"
                      onClick={() => setExtraHours(prev => prev + 0.5)}
                      className="w-10 h-10 flex items-center justify-center font-bold text-sg-ink hover:bg-sg-paper active:scale-95 transition"
                    >
                      +
                    </button>
                  </div>
                  <div className="text-right">
                    <span className="text-[11px] text-sg-muted block">單價 NT${hourlyRate}/h</span>
                    <span className="text-[17px] font-bold text-sg-ink font-num">NT${hoursAmount}</span>
                  </div>
                </div>
              </div>
            )}

            {supplementType === 'unlimited_diff' && (
              <div className="space-y-2">
                <label className="block text-[12px] font-bold text-sg-ink">改成不限時差額計算</label>
                <div className="p-3.5 bg-white border border-sg-line rounded-xl text-[13px] font-bold text-sg-ink text-center">
                  不限時 NT${unlimitedPrice} − 已付入場 NT${personPaidEntry} = NT${diffAmount}
                </div>
              </div>
            )}

            {supplementType === 'other' && (
              <div className="space-y-3">
                <div>
                  <label className="block text-[12px] font-bold text-sg-ink mb-1">補收項目說明</label>
                  <input
                    type="text"
                    value={actionItemLabel}
                    onChange={(e) => setActionItemLabel(e.target.value)}
                    placeholder="請輸入項目名稱..."
                    className="w-full px-3 py-2 rounded-xl border border-sg-line text-[13px]"
                  />
                </div>
                <MoneyInput label="補收金額" value={actionAmount} onChange={setActionAmount} />
              </div>
            )}

            {/* Amount Summary Box (規格 6.18) */}
            <div className="p-3 bg-sg-paper/60 border border-sg-line rounded-xl space-y-1.5 text-[13px]">
              <div className="flex justify-between text-sg-muted">
                <span>已付 NT${supplementPersonPaid}</span>
              </div>
              <div className="flex justify-between text-sg-ink font-medium">
                <span>補收 {supplementDetailDesc}</span>
              </div>
              <div className="pt-1.5 border-t border-sg-line flex justify-between font-bold text-sg-ink">
                <span>第 {supplementTarget.person_no} 位合計 NT${combinedPersonTotal}</span>
              </div>
            </div>
          </div>
        </ResponsivePanel>
      )}

      {/* Refund Modal */}
      {refundTarget && (
        <ResponsivePanel
          isOpen={Boolean(refundTarget)}
          onClose={() => setRefundTarget(null)}
          title={`退款：第 ${refundTarget.person_no} 位`}
          subtitle={`已付 NT$${refundTargetPaid || refundTarget.total}`}
          footer={
            <div className="flex items-center justify-end gap-2">
              <Button variant="secondary" size="sm" onClick={() => setRefundTarget(null)}>
                取消
              </Button>
              <Button variant="danger" size="sm" onClick={handleRefund} loading={loading}>
                確認退款 NT${actionAmount}
              </Button>
            </div>
          }
        >
          <div className="space-y-3 py-2">
            <div className="p-3 bg-amber-50 border border-amber-200 rounded-xl flex items-start gap-2.5 text-[12px] text-amber-900">
              <AlertTriangle className="w-4 h-4 text-amber-700 flex-shrink-0 mt-0.5" />
              <span>退款會記到帳務的異動紀錄，訂單狀態變成「有退款」。</span>
            </div>

            <div className="space-y-1.5">
              <label className="block text-[12px] font-bold text-sg-ink">退款方式</label>
              <div className="grid grid-cols-2 gap-2">
                {refundMethodOptions.map((opt) => {
                  const isSelected = refundMethod === opt.code;
                  return (
                    <button
                      key={opt.code}
                      type="button"
                      data-testid={`refund-method-${opt.code}`}
                      onClick={() => setRefundMethod(opt.code)}
                      className={`min-h-[40px] p-2 rounded-xl border text-[13px] font-bold flex items-center justify-center text-center transition active:scale-[0.98] ${
                        isSelected
                          ? 'bg-sg-brown text-white border-sg-brown shadow-sm'
                          : 'bg-sg-paper text-sg-ink border-sg-line hover:border-sg-muted hover:bg-white'
                      }`}
                    >
                      {opt.label}
                    </button>
                  );
                })}
              </div>
            </div>

            <div>
              <label className="block text-[12px] font-bold text-sg-ink mb-1">退款金額</label>
              <div className="flex items-center gap-2">
                <div className="flex-1">
                  <MoneyInput value={actionAmount} onChange={setActionAmount} />
                </div>
                <button
                  type="button"
                  data-testid="refund-full-amount-btn"
                  onClick={() => setActionAmount(refundTargetMaxRefundable)}
                  className="min-h-[44px] px-3 rounded-xl border border-sg-line bg-white hover:bg-sg-paper text-sg-ink text-[12px] font-bold whitespace-nowrap active:scale-[0.98] transition"
                >
                  全額 NT${refundTargetMaxRefundable}
                </button>
              </div>
              <div className="text-[12px] text-sg-muted mt-1">
                最多可退 NT${refundTargetMaxRefundable}
              </div>
            </div>

            <div className="space-y-1.5">
              <label className="block text-[12px] font-bold text-sg-ink">退款原因</label>
              <ReasonChips
                reasons={['客人提前離場', '操作失誤多收', '作品未完成退費', '其他']}
                selected={actionReason}
                onSelect={setActionReason}
              />
              <input
                type="text"
                value={actionReason}
                onChange={(e) => setActionReason(e.target.value)}
                placeholder="請填寫退款原因..."
                className="w-full px-3 py-2 rounded-xl border border-sg-line text-[13px]"
              />
            </div>
          </div>
        </ResponsivePanel>
      )}

      {/* Void Modal */}
      {voidTargetPayment && (
        <ConfirmPanel
          isOpen={Boolean(voidTargetPayment)}
          onClose={() => setVoidTargetPayment(null)}
          onConfirm={handleVoidPayment}
          title="確認作廢收款"
          message={`確定要作廢收款 ${voidTargetPayment.payment_no} (NT$${voidTargetPayment.amount}) 嗎？作廢後不可復原。`}
        />
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

      {/* Toast Notification */}
      {toastMsg && (
        <div
          data-testid="split-toast"
          className="fixed top-6 left-1/2 -translate-x-1/2 z-[250] px-4 py-2 bg-emerald-600 text-white text-[13px] font-bold rounded-2xl shadow-xl animate-in fade-in slide-in-from-top duration-200"
        >
          {toastMsg}
        </div>
      )}
    </>
  );
}
