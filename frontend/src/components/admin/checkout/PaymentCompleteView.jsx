import React, { useState } from 'react';
import { CheckCircle2, Printer, RotateCcw, Check } from 'lucide-react';
import Button from '../../customer/Button';
import { PAYMENT_METHOD_LABELS, printJobOnThisDevice } from '../../../utils/sunmiPrinter';
import api from '../../../api/axios';

export default function PaymentCompleteView({
  data,
  bookingRef,
  booking = null,
  onNextPerson,
  onDone
}) {
  const [reprinting, setReprinting] = useState(false);
  const [printLocalMsg, setPrintLocalMsg] = useState(null);
  const [departing, setDeparting] = useState(false);

  const payments = data?.payments || [];
  const firstPay = payments[0] || {};
  const totalCollected = payments.reduce((sum, p) => sum + (p.amount || 0), 0);
  const methodLabel = PAYMENT_METHOD_LABELS[firstPay.method] || firstPay.method || '現金';
  const changeGiven = firstPay.change_given ?? 0;
  const personNos = firstPay.person_nos || [];
  const personDesc = personNos.length > 0 ? `第 ${personNos.join('、')} 位` : '顧客';

  // Find remaining unpaid persons
  const allPersons = data?.bill?.persons || [];
  const unpaidPersons = allPersons.filter(p => !p.paid && !p.is_paid && !p.is_frozen && p.status !== 'removed');
  const hasUnpaid = unpaidPersons.length > 0;
  const nextUnpaid = unpaidPersons[0];

  // Check if booking session has already ended
  const endAt = booking?.end_at || data?.bill?.booking?.end_at;
  const isSessionEnded = (() => {
    if (endAt) {
      const endMs = new Date(endAt).getTime();
      if (!isNaN(endMs)) return endMs <= Date.now();
    }
    const sessDate = booking?.session_date || data?.bill?.booking?.session_date;
    const endTime = booking?.end_time || data?.bill?.booking?.end_time;
    if (sessDate && endTime) {
      const dStr = typeof sessDate === 'string' ? sessDate.slice(0, 10) : new Date(sessDate).toISOString().slice(0, 10);
      const endMs = new Date(`${dStr}T${endTime}:00+08:00`).getTime();
      if (!isNaN(endMs)) return endMs <= Date.now();
    }
    return false;
  })();

  const handleCompleteAndDepart = async () => {
    try {
      setDeparting(true);
      await api.post(`/floor/${bookingRef}/timer`, {
        action: 'end',
        person_nos: 'all'
      });
      onDone();
    } catch (err) {
      console.error('Depart error:', err);
      onDone();
    } finally {
      setDeparting(false);
    }
  };

  const handleReprint = async () => {
    if (!firstPay.id) return;
    try {
      setReprinting(true);
      const res = await api.post('/print/jobs', {
        type: 'receipt',
        payment_id: firstPay.id,
        booking_ref: bookingRef,
        is_reprint: true
      });
      if (res.data?.job) {
        await printJobOnThisDevice(res.data.job);
      }
      setPrintLocalMsg('已送出補印');
      setTimeout(() => setPrintLocalMsg(null), 3000);
    } catch (err) {
      console.error(err);
      setPrintLocalMsg('補印失敗');
      setTimeout(() => setPrintLocalMsg(null), 3000);
    } finally {
      setReprinting(false);
    }
  };

  const handlePrintOnThisDevice = async () => {
    if (!data?.print_jobs?.length) {
      handleReprint();
      return;
    }
    try {
      setReprinting(true);
      for (const job of data.print_jobs) {
        await printJobOnThisDevice(job);
      }
      setPrintLocalMsg('本機列印已送出');
      setTimeout(() => setPrintLocalMsg(null), 3000);
    } catch (err) {
      console.error(err);
      setPrintLocalMsg('列印失敗');
      setTimeout(() => setPrintLocalMsg(null), 3000);
    } finally {
      setReprinting(false);
    }
  };

  return (
    <div className="space-y-5 py-4 animate-fade-in" data-testid="payment-complete-view">
      {/* 1. Success Hero */}
      <div className="text-center space-y-2">
        <div className="w-14 h-14 rounded-full bg-sg-sage-soft text-sg-sage-ink mx-auto grid place-items-center">
          <CheckCircle2 className="w-8 h-8 text-sg-sage" />
        </div>
        <div>
          <div className="text-[24px] font-bold text-sg-ink font-num" data-testid="collected-amount-text">
            已收款 NT${totalCollected}
          </div>
          <p className="text-[14px] text-sg-muted mt-0.5">
            {personDesc} · {methodLabel} · 找零 NT${changeGiven}
          </p>
        </div>
      </div>

      {/* 2. Print Status & Actions Card (Spec 6.15) */}
      <div className="p-4 rounded-2xl border border-sg-line bg-sg-paper/50 space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Printer className="w-4 h-4 text-sg-muted" />
            <span className="text-[13px] font-bold text-sg-ink">
              收據列印進度
            </span>
          </div>
          <span className="text-[12px] font-bold text-sg-sage-ink flex items-center gap-1">
            <Check className="w-3.5 h-3.5" />
            已送出
          </span>
        </div>

        {printLocalMsg && (
          <div className="text-[12px] text-sg-sage font-bold">
            {printLocalMsg}
          </div>
        )}

        <div className="flex items-center gap-2 pt-1">
          <Button
            variant="secondary"
            size="sm"
            onClick={handleReprint}
            loading={reprinting}
            className="flex-1"
          >
            再印一張
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={handlePrintOnThisDevice}
            loading={reprinting}
            className="flex-1"
          >
            用這台印
          </Button>
        </div>
      </div>

      {/* 3. Payment Records Summary */}
      <div className="space-y-2">
        <span className="text-[12px] font-bold text-sg-muted uppercase tracking-wider block">
          本筆訂單收款紀錄
        </span>
        <div className="space-y-1.5 max-h-40 overflow-y-auto">
          {payments.map((p) => (
            <div
              key={p.id}
              className="p-2.5 rounded-xl border border-sg-line bg-white flex items-center justify-between text-[12px]"
            >
              <div>
                <span className="font-bold text-sg-ink mr-2">{p.payment_no}</span>
                <span className="text-sg-muted">
                  {PAYMENT_METHOD_LABELS[p.method] || p.method} NT${p.amount}
                </span>
              </div>
              <span className="text-sg-sage-ink font-bold">成功</span>
            </div>
          ))}
        </div>
      </div>

      {/* 4. Bottom Action Buttons */}
      <div className="pt-2 border-t border-sg-line">
        {hasUnpaid ? (
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              size="md"
              onClick={onDone}
              className="flex-1"
            >
              完成
            </Button>
            <Button
              variant="primary"
              size="md"
              onClick={() => onNextPerson(nextUnpaid.person_no)}
              className="flex-1"
            >
              結第 {nextUnpaid.person_no} 位
            </Button>
          </div>
        ) : isSessionEnded ? (
          <Button
            variant="primary"
            size="md"
            onClick={onDone}
            className="w-full"
          >
            完成
          </Button>
        ) : (
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              size="md"
              onClick={onDone}
              className="flex-1"
            >
              客人還沒走
            </Button>
            <Button
              variant="primary"
              size="md"
              loading={departing}
              onClick={handleCompleteAndDepart}
              className="flex-1"
            >
              完成並離場
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
