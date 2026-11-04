import React from 'react';
import { PAYMENT_METHOD_LABELS } from '../../utils/sunmiPrinter';

const DEFAULT_METHODS = [
  { code: 'cash', label: '現金' },
  { code: 'line_pay', label: 'LINE Pay' },
  { code: 'jkopay', label: '街口支付' },
  { code: 'card', label: '刷卡' },
  { code: 'transfer', label: '銀行轉帳' },
  { code: 'pass', label: '卡券折抵' },
  { code: 'other', label: '其他' }
];

export default function PayMethodGrid({
  value = 'cash',
  onChange,
  methods = DEFAULT_METHODS,
  hidePass = false,
  className = ''
}) {
  const visibleMethods = hidePass ? methods.filter(m => m.code !== 'pass') : methods;

  return (
    <div className={`grid grid-cols-3 gap-2 ${className}`}>
      {visibleMethods.map((m) => {
        const isSelected = value === m.code;
        return (
          <button
            key={m.code}
            type="button"
            onClick={() => onChange(m.code)}
            className={`min-h-[46px] p-2.5 rounded-xl border text-[13px] font-bold flex items-center justify-center text-center transition active:scale-[0.98] ${
              isSelected
                ? 'bg-sg-brown text-white border-sg-brown shadow-sm'
                : 'bg-sg-paper text-sg-ink border-sg-line hover:border-sg-muted hover:bg-white'
            }`}
          >
            {m.label || PAYMENT_METHOD_LABELS[m.code] || m.code}
          </button>
        );
      })}
    </div>
  );
}
