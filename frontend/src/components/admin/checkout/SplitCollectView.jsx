import React, { useState } from 'react';
import { Lock, Plus, RotateCcw, AlertTriangle, Check, Ticket, Printer } from 'lucide-react';
import api from '../../../api/axios';
import ResponsivePanel from '../ResponsivePanel';
import PayMethodGrid from '../PayMethodGrid';
import CashPad from '../CashPad';
import ReasonChips from '../ReasonChips';
import MoneyInput from '../MoneyInput';
import ConfirmPanel from '../ConfirmPanel';
import Button from '../../customer/Button';
import PassTenderSheet from './PassTenderSheet';
import { printJobOnThisDevice } from '../../../utils/sunmiPrinter';

export default function SplitCollectView({
  isOpen = false,
  onClose,
  bookingRef,
  billData,
  onPaymentSuccess
}) {
  const bill = billData?.bill || {};
  const persons = bill.persons || [];
  const pricing = billData?.pricing || {};

  // Selection of unpaid persons to collect
  const [selectedPersonNos, setSelectedPersonNos] = useState(() => {
    return persons.filter(p => !p.paid).map(p => p.person_no);
  });

  const [method, setMethod] = useState('cash');
  const [cashReceived, setCashReceived] = useState(0);
  const [passTenders, setPassTenders] = useState([]);
  const [note, setNote] = useState('');
  const [autoPrint, setAutoPrint] = useState(true);
  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState(null);

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

      // Print jobs created automatically by backend (Section 3.8)
      if (res.data?.print_jobs?.length) {
        for (const job of res.data.print_jobs) {
          try {
            await printJobOnThisDevice(job);
          } catch (printErr) {
            console.warn('[SplitCollect] Local print trigger:', printErr);
          }
        }
      }

      onPaymentSuccess(res.data);
      onClose();
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
      onPaymentSuccess();
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
      onPaymentSuccess();
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
      onPaymentSuccess();
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
      onPaymentSuccess();
      onClose();
    } catch (err) {
      setErrorMessage(err.response?.data?.error || '免收失敗');
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <ResponsivePanel
        isOpen={isOpen}
        onClose={onClose}
        title="分開收款與帳務作業"
        subtitle={`預約單號 ${billData?.booking?.ref_display || bookingRef}`}
        footer={
          <div className="space-y-2">
            {errorMessage && (
              <div className="p-2.5 rounded-xl bg-sg-danger-soft text-sg-danger text-[12px] font-bold">
                {errorMessage}
              </div>
            )}
            <div className="flex items-center justify-between">
              <label className="flex items-center gap-2 text-[13px] text-sg-ink cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={autoPrint}
                  onChange={(e) => setAutoPrint(e.target.checked)}
                  className="w-4 h-4 rounded text-sg-brown focus:ring-sg-brown"
                />
                <Printer className="w-4 h-4 text-sg-muted" />
                <span>結帳完成自動列印收據</span>
              </label>

              <div className="flex items-center gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => setShowWaiveModal(true)}
                  disabled={selectedPersonNos.length === 0}
                >
                  免收
                </Button>
                <Button
                  variant="primary"
                  size="sm"
                  onClick={handleCollect}
                  loading={loading}
                  disabled={selectedPersonNos.length === 0}
                >
                  確認收款 NT${netCashDue}
                </Button>
              </div>
            </div>
          </div>
        }
      >
        <div className="space-y-4 py-2">
          {/* Persons Checklist */}
          <div className="space-y-2">
            <span className="text-[13px] font-bold text-sg-ink block">選擇本次結帳對象</span>
            <div className="space-y-2">
              {persons.map((p) => {
                const isPaid = Boolean(p.paid);
                const isSelected = selectedPersonNos.includes(p.person_no);

                if (isPaid) {
                  return (
                    <div
                      key={p.person_no}
                      className="p-3 rounded-2xl bg-sg-paper/60 border border-sg-line flex items-center justify-between"
                    >
                      <div className="flex items-center gap-2.5">
                        <Lock className="w-4 h-4 text-sg-muted" />
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
                            setActionAmount(60);
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
                          時數 {p.hours || 0}h · 應付 NT${p.total || 0}
                        </div>
                      </div>
                    </div>

                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        setPassSheetPersonNo(p.person_no);
                      }}
                      className="px-2.5 py-1 rounded-xl text-[11px] font-bold border border-sg-line bg-white hover:border-sg-brown flex items-center gap-1"
                    >
                      <Ticket className="w-3 h-3 text-sg-muted" />
                      卡券折抵
                    </button>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Payment Method Selector */}
          {selectedPersonNos.length > 0 && (
            <div className="space-y-3 pt-2 border-t border-sg-line">
              <span className="text-[13px] font-bold text-sg-ink block">選擇收款方式</span>
              <PayMethodGrid value={method} onChange={setMethod} />

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
      </ResponsivePanel>

      {/* Pass Tender Sheet */}
      {passSheetPersonNo && (
        <PassTenderSheet
          isOpen={Boolean(passSheetPersonNo)}
          onClose={() => setPassSheetPersonNo(null)}
          bookingRef={bookingRef}
          personNo={passSheetPersonNo}
          hourlyRate={pricing.hourly || 150}
          onSelectPass={(tender) => {
            setPassTenders(prev => [...prev.filter(t => t.person_no !== tender.person_no), tender]);
          }}
        />
      )}

      {/* Supplement Modal */}
      <ResponsivePanel
        isOpen={Boolean(supplementTarget)}
        onClose={() => setSupplementTarget(null)}
        title={`第 ${supplementTarget?.person_no} 位 · 補收款`}
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="secondary" size="sm" onClick={() => setSupplementTarget(null)}>取消</Button>
            <Button variant="primary" size="sm" onClick={handleSupplement} loading={loading}>
              確認補收 NT${actionAmount}
            </Button>
          </div>
        }
      >
        <div className="space-y-3 py-2 text-[13px]">
          <div>
            <label className="block text-sg-muted font-medium mb-1">補收項目</label>
            <input
              type="text"
              value={actionItemLabel}
              onChange={(e) => setActionItemLabel(e.target.value)}
              className="w-full px-3 py-2 rounded-xl border border-sg-line font-bold"
            />
          </div>
          <MoneyInput
            label="補收金額"
            value={actionAmount}
            onChange={setActionAmount}
          />
          <PayMethodGrid value={method} onChange={setMethod} />
        </div>
      </ResponsivePanel>

      {/* Refund Modal */}
      <ResponsivePanel
        isOpen={Boolean(refundTarget)}
        onClose={() => setRefundTarget(null)}
        title={`第 ${refundTarget?.person_no} 位 · 退款`}
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="secondary" size="sm" onClick={() => setRefundTarget(null)}>取消</Button>
            <Button variant="danger" size="sm" onClick={handleRefund} loading={loading}>
              確認退款 NT${actionAmount}
            </Button>
          </div>
        }
      >
        <div className="space-y-3 py-2 text-[13px]">
          <MoneyInput
            label="退款金額"
            value={actionAmount}
            onChange={setActionAmount}
          />
          <ReasonChips
            presets={['提早結束', '作品未完成', '算錯金額', '客人不滿意']}
            value={actionReason}
            onChange={setActionReason}
          />
          <PayMethodGrid value={method} onChange={setMethod} />
        </div>
      </ResponsivePanel>

      {/* Void Modal */}
      <ConfirmPanel
        isOpen={Boolean(voidTargetPayment)}
        onClose={() => setVoidTargetPayment(null)}
        onConfirm={handleVoidPayment}
        title="確認作廢此筆收款"
        message={`將一起作廢同一次收款的所有交易紀錄（${voidTargetPayment?.payment_no} · NT$${voidTargetPayment?.amount}），卡券額度將自動歸還。`}
        danger={true}
        loading={loading}
      >
        <ReasonChips
          presets={['客人改用 LINE Pay', '客人改刷卡', '算錯金額', '其他']}
          value={actionReason}
          onChange={setActionReason}
        />
      </ConfirmPanel>

      {/* Waive Modal */}
      <ConfirmPanel
        isOpen={showWaiveModal}
        onClose={() => setShowWaiveModal(false)}
        onConfirm={handleWaive}
        title="確認免收此預約款項"
        message={`將免收第 ${selectedPersonNos.join('、')} 位的所有應付費用。`}
        danger={false}
        loading={loading}
      >
        <ReasonChips
          presets={['店家招待', '活動優惠', '熟客免收', '客訴補償']}
          value={actionReason}
          onChange={setActionReason}
        />
      </ConfirmPanel>
    </>
  );
}
