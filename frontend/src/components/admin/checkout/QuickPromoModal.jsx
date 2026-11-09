import React, { useState } from 'react';
import ResponsivePanel from '../ResponsivePanel';
import Button from '../../customer/Button';
import api from '../../../api/axios';

export default function QuickPromoModal({
  isOpen = false,
  onClose,
  onSuccess
}) {
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [discountType, setDiscountType] = useState('fixed_order'); // 'fixed_order' | 'percentage'
  const [discountValue, setDiscountValue] = useState(30);
  const [isPosOnly, setIsPosOnly] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!name.trim()) {
      setError('請填寫優惠名稱');
      return;
    }

    const finalCode = (code.trim() || `POS${Date.now().toString().slice(-4)}`).toUpperCase();

    try {
      setLoading(true);
      setError(null);
      const res = await api.post('/checkout/promo-codes', {
        code: finalCode,
        name: name.trim(),
        discount_type: discountType,
        discount_value: parseInt(discountValue, 10) || 0,
        channel: isPosOnly ? 'pos' : 'all',
        is_pos_quick_select: true,
        is_active: true
      });

      if (onSuccess) {
        onSuccess(res.data);
      }
      onClose();
    } catch (err) {
      console.error('[QuickPromoModal] Submit error:', err);
      setError(err.response?.data?.error || '新增優惠失敗');
    } finally {
      setLoading(false);
    }
  };

  return (
    <ResponsivePanel
      isOpen={isOpen}
      onClose={onClose}
      title="新增櫃檯優惠"
      subtitle="建立直接可在櫃檯快速選取的優惠碼"
      footer={
        <div className="flex items-center justify-end gap-2">
          <Button variant="secondary" size="md" onClick={onClose}>
            取消
          </Button>
          <Button
            data-testid="submit-quick-promo-btn"
            variant="primary"
            size="md"
            onClick={handleSubmit}
            loading={loading}
          >
            建立優惠
          </Button>
        </div>
      }
    >
      <form onSubmit={handleSubmit} className="space-y-4 py-2">
        {error && (
          <div className="p-2.5 rounded-xl bg-sg-danger-soft text-sg-danger text-[12px] font-bold">
            {error}
          </div>
        )}

        {/* Name */}
        <div>
          <label className="block text-[12px] font-bold text-sg-ink mb-1">
            優惠名稱 <span className="text-sg-danger">*</span>
          </label>
          <input
            type="text"
            required
            data-testid="quick-promo-name-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="例：熟客折抵、現場滿額折扣"
            className="w-full px-3 py-2 rounded-xl border border-sg-line text-[13px] focus:ring-sg-brown focus:border-sg-brown"
          />
        </div>

        {/* Code (optional) */}
        <div>
          <label className="block text-[12px] font-bold text-sg-ink mb-1">
            優惠代碼 <span className="text-sg-muted font-normal">(選填，未填將自動產生)</span>
          </label>
          <input
            type="text"
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            placeholder="例：POS50、VIP90"
            className="w-full px-3 py-2 rounded-xl border border-sg-line text-[13px] font-mono uppercase focus:ring-sg-brown focus:border-sg-brown"
          />
        </div>

        {/* Discount type & value */}
        <div>
          <label className="block text-[12px] font-bold text-sg-ink mb-2">折抵方式</label>
          <div className="grid grid-cols-2 gap-2 mb-3">
            <button
              type="button"
              onClick={() => setDiscountType('fixed_order')}
              className={`p-2.5 rounded-xl border text-[13px] font-bold transition ${
                discountType === 'fixed_order'
                  ? 'bg-sg-brown text-white border-sg-brown'
                  : 'bg-white text-sg-ink border-sg-line hover:bg-sg-paper'
              }`}
            >
              固定折抵金額 ($)
            </button>
            <button
              type="button"
              onClick={() => setDiscountType('percentage')}
              className={`p-2.5 rounded-xl border text-[13px] font-bold transition ${
                discountType === 'percentage'
                  ? 'bg-sg-brown text-white border-sg-brown'
                  : 'bg-white text-sg-ink border-sg-line hover:bg-sg-paper'
              }`}
            >
              比例折數 (%)
            </button>
          </div>

          <div className="relative">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sg-muted text-[13px] font-bold">
              {discountType === 'fixed_order' ? 'NT$' : '%'}
            </span>
            <input
              type="number"
              required
              min="1"
              max={discountType === 'percentage' ? 100 : 9999}
              value={discountValue}
              onChange={(e) => setDiscountValue(e.target.value)}
              className="w-full pl-12 pr-3 py-2 rounded-xl border border-sg-line text-[14px] font-bold focus:ring-sg-brown focus:border-sg-brown"
            />
          </div>
          <span className="block text-[11px] text-sg-muted mt-1">
            {discountType === 'fixed_order'
              ? '整單結帳時直接扣減指定金額'
              : '例：填 10 代表折抵 10%（九折）；填 20 代表折抵 20%（八折）'}
          </span>
        </div>

        {/* POS Channel limit */}
        <div className="pt-2 border-t border-sg-line">
          <label className="flex items-center gap-2.5 text-[13px] text-sg-ink cursor-pointer select-none">
            <input
              type="checkbox"
              checked={isPosOnly}
              onChange={(e) => setIsPosOnly(e.target.checked)}
              className="w-4 h-4 rounded text-sg-brown focus:ring-sg-brown cursor-pointer"
            />
            <span className="font-bold">僅限門市櫃檯使用</span>
          </label>
          <span className="block text-[11px] text-sg-muted ml-6 mt-0.5">
            勾選時線上預約客人無法看到此優惠碼，僅供門市人員結帳時手動點選
          </span>
        </div>
      </form>
    </ResponsivePanel>
  );
}
