import React from 'react';

export default function CashPad({
  dueAmount = 0,
  cashReceived = 0,
  onChange,
  className = ''
}) {
  const due = Math.max(0, parseInt(dueAmount, 10) || 0);
  const received = parseInt(cashReceived, 10) || 0;
  const change = Math.max(0, received - due);

  const presets = [
    { label: '剛好', value: due },
    { label: `${Math.ceil(due / 100) * 100 || 100}`, value: Math.ceil(due / 100) * 100 || 100 },
    { label: `${Math.ceil(due / 500) * 500 || 500}`, value: Math.ceil(due / 500) * 500 || 500 },
    { label: `${Math.ceil(due / 1000) * 1000 || 1000}`, value: Math.ceil(due / 1000) * 1000 || 1000 }
  ];

  // Unique values
  const uniquePresets = [];
  const seen = new Set();
  for (const p of presets) {
    if (!seen.has(p.value) && p.value >= due) {
      seen.add(p.value);
      uniquePresets.push(p);
    }
  }

  return (
    <div className={`space-y-3 ${className}`}>
      <div className="flex items-center gap-2">
        {uniquePresets.map((p) => {
          const isSelected = received === p.value;
          return (
            <button
              key={p.label}
              type="button"
              onClick={() => onChange(p.value)}
              className={`flex-1 min-h-[40px] px-2 py-1.5 rounded-xl border text-[13px] font-bold transition active:scale-95 ${
                isSelected
                  ? 'bg-sg-brown text-white border-sg-brown'
                  : 'bg-sg-paper text-sg-ink border-sg-line hover:border-sg-muted'
              }`}
            >
              {p.label === '剛好' ? '剛好' : `NT$${p.value}`}
            </button>
          );
        })}
      </div>

      <div className="flex items-center justify-between p-3 rounded-xl bg-sg-paper border border-sg-line">
        <span className="text-[13px] font-medium text-sg-muted">實收金額</span>
        <div className="flex items-center gap-1">
          <span className="text-[14px] font-bold text-sg-muted">NT$</span>
          <input
            type="text"
            inputMode="numeric"
            value={received === 0 ? '' : received}
            placeholder={String(due)}
            onChange={(e) => {
              const val = parseInt(e.target.value.replace(/[^0-9]/g, ''), 10) || 0;
              onChange(val);
            }}
            className="w-24 text-right font-bold text-[18px] text-sg-ink bg-transparent focus:outline-none"
          />
        </div>
      </div>

      <div className="flex items-center justify-between px-1 text-[14px]">
        <span className="text-sg-muted">應找零</span>
        <span className={`font-bold ${change > 0 ? 'text-sg-danger text-[16px]' : 'text-sg-ink'}`}>
          NT${change}
        </span>
      </div>
    </div>
  );
}
