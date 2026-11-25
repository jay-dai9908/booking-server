import React, { useEffect, useState } from 'react';
import { X, AlertTriangle, RotateCcw } from 'lucide-react';
import api from '../../api/axios';
import ReasonChips from './ReasonChips';

const FALLBACK_METHODS = [
  { key: 'cash', label: '現金' },
  { key: 'line_pay', label: 'LINE Pay' },
  { key: 'card', label: '刷卡' },
  { key: 'transfer', label: '轉帳' }
];

export function PassStatusReasonModal({ target, onClose, onSuccess, onError }) {
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    setReason('');
  }, [target]);

  if (!target) return null;
  const { pass, nextStatus } = target;
  const isRevoke = nextStatus === 'REVOKED';

  const handleSubmit = async (e) => {
    e.preventDefault();
    const trimmed = reason.trim();
    if (!trimmed || submitting) return;
    setSubmitting(true);
    try {
      const res = await api.patch(`/passes/admin/${pass.id}/status`, {
        status: nextStatus,
        reason: trimmed
      });
      if (onSuccess) onSuccess(res.data);
    } catch (err) {
      if (onError) onError(err.response?.data?.error || '更新卡券狀態失敗');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[170] flex items-center justify-center p-4" onClick={onClose}>
      <div className="absolute inset-0 bg-black/50 backdrop-blur-xs" />
      <form
        onSubmit={handleSubmit}
        onClick={(e) => e.stopPropagation()}
        className="relative z-10 w-full max-w-md bg-white rounded-3xl shadow-2xl border border-[#E8DEC8] overflow-hidden"
        data-testid="pass-status-modal"
      >
        <div className="px-5 py-4 bg-[#FAF7F2] border-b border-[#E8DEC8] flex items-center justify-between">
          <div className="flex items-center gap-2">
            {isRevoke ? (
              <AlertTriangle className="w-4 h-4 text-rose-600" />
            ) : (
              <RotateCcw className="w-4 h-4 text-emerald-700" />
            )}
            <h3 className="font-extrabold text-base text-[#3E332B]">
              {isRevoke ? '作廢卡券' : '恢復卡券使用'}
            </h3>
          </div>
          <button type="button" onClick={onClose} className="p-1 text-[#8C8279] hover:text-[#3E332B]">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-5 space-y-4 text-sm">
          <div className="p-3 rounded-xl bg-[#FAF7F2] border border-[#E8DEC8] text-xs space-y-1">
            <div className="font-bold text-[#3E332B]">
              {pass.plan?.name || pass.plan_name_snapshot || '卡券'} · <span className="font-mono">{pass.pass_code}</span>
            </div>
            <div className="text-[#6D5D52]">
              剩餘額度：{pass.remaining_quota !== null && pass.remaining_quota !== undefined ? `${pass.remaining_quota} 次` : '無限制'}
            </div>
          </div>

          <div className="space-y-2">
            <label className="block text-xs font-bold text-[#3E332B]">異動原因（必填）</label>
            <ReasonChips
              presets={isRevoke ? ['顧客要求作廢', '補發作廢舊卡', '違規使用停權'] : ['誤按作廢恢復', '補件恢復啟用']}
              value={reason}
              onChange={setReason}
              placeholder={isRevoke ? '請輸入作廢原因...' : '請輸入恢復原因...'}
              inputTestId="pass-status-reason-input"
            />
          </div>
        </div>

        <div className="px-5 py-3.5 bg-[#FAF7F2] border-t border-[#E8DEC8] flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 rounded-xl border border-[#E8DEC8] text-xs font-bold text-[#6D5D52] bg-white hover:bg-gray-50"
          >
            取消
          </button>
          <button
            type="submit"
            disabled={!reason.trim() || submitting}
            data-testid="confirm-pass-status-btn"
            className={`px-4 py-2 rounded-xl text-xs font-bold text-white disabled:opacity-40 ${
              isRevoke ? 'bg-rose-600 hover:bg-rose-700' : 'bg-[#8B5B43] hover:bg-[#7A4F3A]'
            }`}
          >
            {submitting ? '處理中...' : (isRevoke ? '確認作廢' : '確認恢復')}
          </button>
        </div>
      </form>
    </div>
  );
}

export function PassRefundModal({ pass, onClose, onSuccess, onError }) {
  const maxRefund = Number(pass?.refundable_remaining ?? pass?.sale_amount ?? 0);
  const [amount, setAmount] = useState(maxRefund > 0 ? String(maxRefund) : '');
  const [method, setMethod] = useState(pass?.sale_method || 'cash');
  const [reason, setReason] = useState('');
  const [methods, setMethods] = useState(FALLBACK_METHODS);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!pass) return;
    const m = Number(pass.refundable_remaining ?? pass.sale_amount ?? 0);
    setAmount(m > 0 ? String(m) : '');
    setMethod(pass.sale_method && pass.sale_method !== 'pass' ? pass.sale_method : 'cash');
    setReason('');

    api.get('/daily-settings/global')
      .then((res) => {
        const list = Array.isArray(res.data?.payment_methods_json) ? res.data.payment_methods_json : [];
        const enabled = list
          .filter((item) => item && item.enabled !== false && item.key !== 'pass')
          .map((item) => ({ key: item.key, label: item.label || item.key }));
        if (enabled.length > 0) setMethods(enabled);
      })
      .catch(() => {});
  }, [pass]);

  if (!pass) return null;

  const handleSubmit = async (e) => {
    e.preventDefault();
    const parsed = parseInt(amount, 10);
    if (!Number.isInteger(parsed) || parsed <= 0 || !reason.trim() || submitting) return;
    setSubmitting(true);
    try {
      const clientBatchId = (typeof crypto !== 'undefined' && crypto.randomUUID)
        ? `pass-refund-${crypto.randomUUID()}`
        : `pass-refund-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const res = await api.post(`/passes/admin/${pass.id}/refund`, {
        amount: parsed,
        method,
        reason: reason.trim(),
        client_batch_id: clientBatchId
      });
      if (onSuccess) onSuccess(res.data);
    } catch (err) {
      if (onError) onError(err.response?.data?.error || '卡券退費失敗');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[170] flex items-center justify-center p-4" onClick={onClose}>
      <div className="absolute inset-0 bg-black/50 backdrop-blur-xs" />
      <form
        onSubmit={handleSubmit}
        onClick={(e) => e.stopPropagation()}
        className="relative z-10 w-full max-w-md bg-white rounded-3xl shadow-2xl border border-[#E8DEC8] overflow-hidden"
        data-testid="pass-refund-modal"
      >
        <div className="px-5 py-4 bg-[#FAF7F2] border-b border-[#E8DEC8] flex items-center justify-between">
          <h3 className="font-extrabold text-base text-[#3E332B]">卡券販售退費（退費後自動作廢）</h3>
          <button type="button" onClick={onClose} className="p-1 text-[#8C8279] hover:text-[#3E332B]">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-5 space-y-4 text-sm">
          <div className="p-3 rounded-xl bg-[#FAF7F2] border border-[#E8DEC8] text-xs space-y-1">
            <div className="font-bold text-[#3E332B]">
              {pass.plan?.name || pass.plan_name_snapshot || '卡券'} · <span className="font-mono">{pass.pass_code}</span>
            </div>
            <div className="text-[#6D5D52]">
              原售金額：NT${pass.sale_amount ?? 0} ｜ 可退餘額：<span className="font-bold text-rose-700">NT${maxRefund}</span>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-bold text-[#3E332B] mb-1">退費金額 (NT$)</label>
              <input
                type="number"
                min={1}
                max={maxRefund}
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                className="w-full px-3 py-2 border border-[#E8DEC8] rounded-xl text-sm font-bold text-[#3E332B]"
                data-testid="pass-refund-amount-input"
              />
            </div>
            <div>
              <label className="block text-xs font-bold text-[#3E332B] mb-1">退款方式</label>
              <select
                value={method}
                onChange={(e) => setMethod(e.target.value)}
                className="w-full px-3 py-2 border border-[#E8DEC8] rounded-xl text-sm font-bold text-[#3E332B] bg-white"
              >
                {methods.map((m) => (
                  <option key={m.key} value={m.key}>{m.label}</option>
                ))}
              </select>
            </div>
          </div>

          <div className="space-y-2">
            <label className="block text-xs font-bold text-[#3E332B]">退費原因（必填）</label>
            <ReasonChips
              presets={['顧客未使用申請退費', '方案買錯退費重購', '門市協議退餘額']}
              value={reason}
              onChange={setReason}
              placeholder="請輸入退費原因..."
              inputTestId="pass-refund-reason-input"
            />
          </div>
        </div>

        <div className="px-5 py-3.5 bg-[#FAF7F2] border-t border-[#E8DEC8] flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 rounded-xl border border-[#E8DEC8] text-xs font-bold text-[#6D5D52] bg-white hover:bg-gray-50"
          >
            取消
          </button>
          <button
            type="submit"
            disabled={!reason.trim() || !(parseInt(amount, 10) > 0) || submitting}
            data-testid="confirm-pass-refund-btn"
            className="px-4 py-2 rounded-xl text-xs font-bold text-white bg-rose-600 hover:bg-rose-700 disabled:opacity-40"
          >
            {submitting ? '退費中...' : '確認退費並作廢'}
          </button>
        </div>
      </form>
    </div>
  );
}
