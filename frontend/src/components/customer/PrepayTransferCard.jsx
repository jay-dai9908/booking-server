import React, { useState } from 'react';
import { Copy } from 'lucide-react';
import Button from './Button';
import { useToast } from './Toast';
import { formatDateTime, formatMoneyBig, weekdayChar } from '../../utils/customer/format';
import api from '../../api/axios';
import { safeHttpUrl } from '@shared/safeUrl.js';

function formatDeadlineDisplay(deadlineAt) {
  if (!deadlineAt) return '';
  const dt = new Date(deadlineAt);
  if (isNaN(dt.getTime())) return '';
  const md = formatDateTime(dt, 'MM/dd HH:mm');
  const ymd = formatDateTime(dt, 'yyyy-MM-dd');
  const wk = weekdayChar(ymd);
  const [datePart, timePart] = md.split(' ');
  return `${datePart}（${wk}）${timePart}`;
}

export default function PrepayTransferCard({ reservation, onReported }) {
  const toast = useToast();
  const prepay = reservation?.prepay;
  const bookingRef = reservation?.booking_ref;
  const [last5, setLast5] = useState(prepay?.remittance_last5 || '');
  const [submitting, setSubmitting] = useState(false);

  if (!prepay) return null;

  const isMismatch = prepay.status === 'mismatch';
  const deadlineText = formatDeadlineDisplay(prepay.deadline_at);
  const safeAssignedPoolUrl = safeHttpUrl(prepay.assigned_pool_url);

  const bankLabel = prepay.assigned_pool_account
    ? '822 中國信託（專屬帳號）'
    : prepay.selected_bank_info
    ? String(prepay.selected_bank_info).split(/\s+/)[0]
    : prepay.payment_method_code || '銀行匯款';

  const accountNumber = prepay.assigned_pool_account
    ? prepay.assigned_pool_account
    : prepay.selected_bank_info
    ? String(prepay.selected_bank_info).replace(/^\S+\s*(?:\([^)]+\)\s*)?/, '').trim() || prepay.selected_bank_info
    : '請依門市公告帳號匯款';

  const handleCopyAccount = async () => {
    const clean = String(accountNumber).replace(/\s+/g, '');
    try {
      await navigator.clipboard.writeText(clean);
      toast.show('已複製帳號', { type: 'success' });
    } catch (e) {
      toast.show(clean, { type: 'info' });
    }
  };

  const handleSubmitLast5 = async () => {
    const clean = last5.trim();
    if (!/^\d{5}$/.test(clean)) {
      toast.show('請輸入 5 位數字帳號末五碼', { type: 'error' });
      return;
    }
    setSubmitting(true);
    try {
      await api.patch(`/reservations/${bookingRef}/prepay/remittance`, { remittance_last5: clean });
      toast.show('已回報匯款末五碼，請等候對帳', { type: 'success' });
      if (onReported) await onReported();
    } catch (err) {
      toast.show(err.response?.data?.error || '回報失敗，請稍後再試', { type: 'error' });
    } finally {
      setSubmitting(false);
    }
  };

  const holds = Array.isArray(prepay.pass_holds) ? prepay.pass_holds : [];
  const totalPassUnits = holds.reduce((s, h) => s + (Number(h.units) || 0), 0);

  return (
    <div
      data-testid="prepay-transfer-card"
      className={`rounded-[16px] border p-3.5 grid gap-2.5 text-sg-ink ${
        isMismatch
          ? 'bg-sg-danger-soft border-sg-danger/40'
          : 'bg-sg-orange-soft border-sg-orange/60'
      }`}
    >
      <div>
        <div className="text-[15px] font-bold">
          {isMismatch
            ? '匯款金額與預約金額不符'
            : deadlineText
            ? `請在 ${deadlineText} 前完成匯款`
            : '請於付款期限前完成匯款'}
        </div>
        <div className="text-[12.5px] text-sg-muted mt-0.5">
          {isMismatch
            ? '請重新核對匯款金額或透過 LINE 聯絡我們確認，亦可更新正確末五碼。'
            : '超過時間沒付款，預約會自動取消。'}
        </div>
      </div>

      {prepay.pass_persons > 0 && (
        <div className="text-[12.5px] bg-sg-paper/80 rounded-[10px] px-2.5 py-2 border border-sg-line">
          已用計次不限時卡折抵 {prepay.pass_persons} 位，共扣 {totalPassUnits || prepay.pass_persons} 次。逾期取消會把次數退回。
        </div>
      )}

      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-[13.5px] bg-sg-paper/90 rounded-[12px] p-3 border border-sg-line">
        <dt className="text-sg-muted">銀行</dt>
        <dd className="text-right font-medium break-all">{bankLabel}</dd>
        <dt className="text-sg-muted">帳號</dt>
        <dd className="text-right flex items-center justify-end gap-1.5 min-w-0">
          <span className="font-num font-extrabold text-[16px] tracking-wide break-all">{accountNumber}</span>
          <button
            type="button"
            onClick={handleCopyAccount}
            className="text-sg-brown p-1 rounded hover:bg-sg-brown-soft shrink-0"
            title="複製帳號"
            aria-label="複製帳號"
          >
            <Copy className="w-3.5 h-3.5" />
          </button>
        </dd>
        <dt className="text-sg-muted">金額</dt>
        <dd className="text-right font-num font-extrabold text-[15px] text-sg-brown">
          {formatMoneyBig(prepay.amount_due)}
        </dd>
      </dl>

      {safeAssignedPoolUrl && (
        <a
          href={safeAssignedPoolUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="text-center text-[13px] font-bold text-sg-brown underline"
        >
          開啟付款連結 →
        </a>
      )}

      <div className="grid gap-1.5 pt-1">
        <label className="text-[12.5px] text-sg-muted font-medium" htmlFor={`prepay-last5-${bookingRef}`}>
          匯款後，填帳號末五碼
        </label>
        <input
          id={`prepay-last5-${bookingRef}`}
          data-testid="prepay-last5-input"
          type="text"
          inputMode="numeric"
          maxLength={5}
          value={last5}
          onChange={(e) => setLast5(e.target.value.replace(/\D/g, '').slice(0, 5))}
          placeholder="12345"
          className="w-full h-[44px] rounded-[10px] border-[1.5px] border-sg-line bg-sg-paper px-3 font-num text-[18px] font-bold text-sg-ink focus:border-sg-brown focus:outline-none"
        />
        <Button
          variant="primary"
          size="md"
          loading={submitting}
          disabled={submitting}
          onClick={handleSubmitLast5}
          data-testid="prepay-report-btn"
          className="w-full"
        >
          回報已匯款
        </Button>
      </div>
    </div>
  );
}
