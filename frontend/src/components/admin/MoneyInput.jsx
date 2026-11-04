import React from 'react';

export default function MoneyInput({
  value = 0,
  onChange,
  allowNegative = false,
  label = null,
  placeholder = '0',
  className = ''
}) {
  const numValue = parseInt(value, 10) || 0;
  const isNegative = numValue < 0;
  const absValue = Math.abs(numValue);

  const handleInputChange = (e) => {
    const raw = e.target.value.replace(/[^0-9]/g, '');
    const intVal = parseInt(raw, 10) || 0;
    onChange(isNegative ? -intVal : intVal);
  };

  const toggleSign = () => {
    if (!allowNegative) return;
    onChange(-numValue);
  };

  return (
    <div className={`space-y-1.5 ${className}`}>
      {label && <label className="block text-[13px] font-bold text-sg-ink">{label}</label>}
      <div className="relative flex items-center">
        {allowNegative && (
          <button
            type="button"
            onClick={toggleSign}
            className={`min-h-[44px] min-w-[44px] mr-1 rounded-xl text-[14px] font-bold border transition ${
              isNegative
                ? 'bg-sg-danger-soft text-sg-danger border-sg-danger/40'
                : 'bg-sg-paper text-sg-ink border-sg-line'
            }`}
          >
            {isNegative ? '−' : '+'}
          </button>
        )}
        <div className="relative flex-1">
          <span className="absolute left-3.5 top-1/2 -translate-y-1/2 text-sg-muted text-[14px] font-bold select-none">
            NT$
          </span>
          <input
            type="text"
            inputMode="numeric"
            pattern="[0-9]*"
            value={absValue === 0 ? '' : absValue}
            placeholder={placeholder}
            onChange={handleInputChange}
            className="w-full min-h-[44px] pl-12 pr-4 rounded-xl border border-sg-line text-[16px] font-bold text-sg-ink bg-white focus:outline-none focus:border-sg-brown focus:ring-1 focus:ring-sg-brown"
          />
        </div>
      </div>
    </div>
  );
}
