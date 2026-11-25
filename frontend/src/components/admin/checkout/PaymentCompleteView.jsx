import React, { useState, useEffect } from 'react';
import { CheckCircle2, Printer, RotateCcw, Check } from 'lucide-react';
import Button from '../../customer/Button';
import { methodLabel } from '@shared/paymentMethods.js';
import { printJobOnThisDevice, isPrintGloballyEnabled } from '../../../utils/sunmiPrinter';
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
  const [configuredMethods, setConfiguredMethods] = useState([]);

  useEffect(() => {
    let isMounted = true;
    api.get('/daily-settings/global')
      .then((res) => {
        if (isMounted && Array.isArray(res.data?.payment_methods_json)) {
          setConfiguredMethods(res.data.payment_methods_json);
        }
      })
      .catch(() => {});
    return () => { isMounted = false; };
  }, []);

  const payments = data?.payments || [];
  const firstPay = payments[0] || {};
  const primaryPay = payments.find(p => p.method !== 'pass') || firstPay;
  const cashOrOtherTotal = payments
    .filter(p => p.method !== 'pass')
    .reduce((sum, p) => sum + (p.amount || 0), 0);
  const passDiscountTotal = payments
    .filter(p => p.method === 'pass')
    .reduce((sum, p) => sum + (p.amount || 0), 0);
  const payMethodLabel = methodLabel(primaryPay.method || 'cash', configuredMethods) || '現金';
  const changeGiven = primaryPay.change_given ?? 0;
  const personNos = primaryPay.person_nos?.length ? primaryPay.person_nos : (firstPay.person_nos || []);
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
    if (!primaryPay.id) return;
    try {
      setReprinting(true);
      await api.post('/print/jobs', {
        type: 'receipt',
        payment_id: primaryPay.id,
        booking_ref: bookingRef,
        is_reprint: true
      });
      setPrintLocalMsg('已送出補印至列印佇列');
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
    try {
      setReprinting(true);
      let jobsToPrint = Array.isArray(data?.print_jobs) ? [...data.print_jobs] : [];
      if (jobsToPrint.length === 0 && primaryPay.id) {
        const res = await api.post('/print/jobs', {
          type: 'receipt',
          payment_id: primaryPay.id,
          booking_ref: bookingRef,
          is_reprint: true
        });
        if (res.data?.job) jobsToPrint = [res.data.job];
      }

      if (jobsToPrint.length === 0) {
        setPrintLocalMsg('找不到可列印的收據');
        return;
      }

      for (const job of jobsToPrint) {
        try {
          await api.post(`/print/jobs/${job.id}/local-claim`);
        } catch (claimErr) {
          if (claimErr.response?.status === 409) {
            setPrintLocalMsg(claimErr.response?.data?.error || '列印站已經在印或已印出');
          } else {
            setPrintLocalMsg(claimErr.response?.data?.error || '無法領取本機列印');
          }
          return;
        }

        let printRes = { success: false, via: 'browser', message: '列印失敗' };
        try {
          printRes = await printJobOnThisDevice(job);
        } catch (pErr) {
          printRes = { success: false, via: 'browser', message: pErr.message || '列印失敗' };
        }

        try {
          await api.post(`/print/jobs/${job.id}/local`, {
            result: printRes?.success ? 'printed' : 'failed',
            via: printRes?.via || 'browser',
            error: printRes?.success ? undefined : (printRes?.message || '列印失敗')
          });
        } catch (repErr) {
          console.warn('[PaymentCompleteView] report local result error:', repErr);
        }

        if (!printRes?.success) {
          setPrintLocalMsg('換好紙，重印');
          return;
        }
      }

      setPrintLocalMsg('本機列印完成');
      setTimeout(() => setPrintLocalMsg(null), 3000);
    } catch (err) {
      console.error(err);
      setPrintLocalMsg('換好紙，重印');
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
            已收款 NT${cashOrOtherTotal}
          </div>
          <p className="text-[14px] text-sg-muted mt-0.5">
            {personDesc} · {payMethodLabel} · 找零 NT${changeGiven}
          </p>
          {passDiscountTotal > 0 && (
            <p className="text-[13px] font-bold text-sg-brown mt-0.5" data-testid="pass-discount-text">
              卡券折抵 NT${passDiscountTotal}
            </p>
          )}
        </div>
      </div>

      {/* 2. Print Status & Actions Card (Spec 6.15) */}
      {!isPrintGloballyEnabled() ? (
        <div className="text-center py-2 text-xs text-sg-muted font-medium">
          列印已關閉
        </div>
      ) : (
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
      )}

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
                  {methodLabel(p.method, configuredMethods)} NT${p.amount}
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
