import React, { useState, useEffect } from 'react';
import api from '../../api/axios';
import { PAYMENT_METHOD_LABELS } from '../../utils/sunmiPrinter';

const DEFAULT_METHODS = [
  { key: 'cash', label: '現金', enabled: true },
  { key: 'linepay', label: 'LINE Pay', enabled: true },
  { key: 'transfer', label: '銀行轉帳', enabled: true }
];

export default function PayMethodGrid({
  value = 'cash',
  onChange,
  methods: propMethods,
  hidePass = false,
  className = ''
}) {
  const [configuredMethods, setConfiguredMethods] = useState(null);

  useEffect(() => {
    if (propMethods && propMethods.length > 0) return;
    let isMounted = true;
    api.get('/daily-settings/global')
      .then(res => {
        if (isMounted && Array.isArray(res.data?.payment_methods_json)) {
          setConfiguredMethods(res.data.payment_methods_json);
        }
      })
      .catch(() => {});
    return () => { isMounted = false; };
  }, [propMethods]);

  const rawList = (propMethods && propMethods.length > 0)
    ? propMethods
    : (configuredMethods || DEFAULT_METHODS);

  // Enabled methods in configured order
  const enabledItems = rawList
    .filter(m => {
      const k = (m.key || m.code || '').toLowerCase();
      if (k === 'cash') return true;
      return m.enabled !== false;
    })
    .map(m => {
      const code = m.key || m.code;
      return {
        code,
        label: m.label || PAYMENT_METHOD_LABELS[code] || code
      };
    });

  // Ensure card / other / etc if passed explicitly or pass tender placed at the end
  const finalMethods = [...enabledItems.filter(m => m.code !== 'pass')];
  if (!hidePass) {
    finalMethods.push({ code: 'pass', label: '卡券折抵' });
  }

  return (
    <div className={`grid grid-cols-3 gap-2 ${className}`}>
      {finalMethods.map((m) => {
        const isSelected = value === m.code ||
          (value === 'line_pay' && m.code === 'linepay') ||
          (value === 'linepay' && m.code === 'line_pay');

        return (
          <button
            key={m.code}
            type="button"
            data-testid={`pay-method-${m.code}`}
            onClick={() => onChange(m.code)}
            className={`min-h-[46px] p-2.5 rounded-xl border text-[13px] font-bold flex items-center justify-center text-center transition active:scale-[0.98] ${
              isSelected
                ? 'bg-sg-brown text-white border-sg-brown shadow-sm'
                : 'bg-sg-paper text-sg-ink border-sg-line hover:border-sg-muted hover:bg-white'
            }`}
          >
            {m.label}
          </button>
        );
      })}
    </div>
  );
}
