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
import { printJobOnThisDevice } from '../../../utils/sunmiPrinter';

export default function SplitCollectView({
  isOpen = false,
  onClose,
  bookingRef,
  billData,
  onPaymentSuccess,
  initialPersonNo = null,
  onOpenSharedSplit = null
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
  const [supplementTarget, setSupplementTarget] = useState(null);
  const [refundTarget, setRefundTarget] = useState(null);
  const [voidTargetPayment, setVoidTargetPayment] = useState(null);
  const [showWaiveModal, setShowWaiveModal] = useState(false);

  // Sub-modal form states
  const [actionReason, setActionReason] = useState('');
  const [actionAmount, setActionAmount] = useState(0);
  const [actionItemLabel, setActionItemLabel] = useState('加時 0.5 小時');

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
    setMethod(m);
    if (m === 'pass') {
      if (selectedPersonNos.length === 0) {
        setErrorMessage('請先選擇一位顧客再折抵卡券');
        return;
      }
      setPassSheetPersonNo(selectedPersonNos[0]);
    }
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
        method: netCashDue > 0 ? method : 'pass',
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
      await api.post(`/billing/${bookingRef}/supplement`, {
        person_no: supplementTarget.person_no,
        items: [{ type: 'other', label: actionItemLabel, amount: actionAmount }],
        method,
        cash_received: actionAmount,
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
        method,
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
          status: res.data?.status || { code: 'unpaid', label: '未結帳' }
        });
      }
      setTimeout(() => {
        onClose();
      }, 500);
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
                  const isPaid = Boolean(p.paid || p.is_paid);
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
                              <div className="text-[11px] text-sg-sage-ink font-bold">已結清 NT${p.total}</div>
                            </div>
                          </div>

                          <div className="flex items-center gap-1.5">
                            <button
                              type="button"
                              onClick={() => {
                                setSupplementTarget(p);
                                setActionAmount(p.pending_supplement || 60);
                              }}
                              className="px-2.5 py-1 rounded-xl text-[12px] font-bold border border-sg-line bg-white hover:bg-sg-paper"
                            >
                              補收
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                setRefundTarget(p);
                                setActionAmount(p.total);
                              }}
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
              <Button variant="primary" size="sm" onClick={handleSupplement} loading={loading}>
                確認補收 NT${actionAmount}
              </Button>
            </div>
          }
        >
          <div className="space-y-3 py-2">
            <div>
              <label className="block text-[12px] font-bold text-sg-ink mb-1">補收項目說明</label>
              <input
                type="text"
                value={actionItemLabel}
                onChange={(e) => setActionItemLabel(e.target.value)}
                className="w-full px-3 py-2 rounded-xl border border-sg-line text-[13px]"
              />
            </div>
            <MoneyInput label="補收金額" value={actionAmount} onChange={setActionAmount} />
          </div>
        </ResponsivePanel>
      )}

      {/* Refund Modal */}
      {refundTarget && (
        <ResponsivePanel
          isOpen={Boolean(refundTarget)}
          onClose={() => setRefundTarget(null)}
          title={`退款：第 ${refundTarget.person_no} 位`}
          subtitle={`已付 NT$${refundTarget.total}`}
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
            <MoneyInput label="退款金額" value={actionAmount} onChange={setActionAmount} />
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
          className="fixed top-6 left-1/2 -translate-x-1/2 z-[100] px-4 py-2 bg-emerald-600 text-white text-[13px] font-bold rounded-2xl shadow-xl animate-in fade-in slide-in-from-top duration-200"
        >
          {toastMsg}
        </div>
      )}
    </>
  );
}
