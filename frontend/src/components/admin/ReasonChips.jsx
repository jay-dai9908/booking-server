import React, { useState, useEffect } from 'react';

export default function ReasonChips({
  presets = ['提早結束', '作品未完成', '店家招待', '熟客優惠', '算錯金額', '客人改用其他方式'],
  value = '',
  onChange,
  label = '原因',
  required = true,
  className = ''
}) {
  const isPreset = presets.includes(value);
  const [isOther, setIsOther] = useState(!isPreset && Boolean(value));
  const [customText, setCustomText] = useState(!isPreset ? value : '');

  useEffect(() => {
    if (!presets.includes(value) && value) {
      setIsOther(true);
      setCustomText(value);
    } else if (presets.includes(value)) {
      setIsOther(false);
    }
  }, [value, presets]);

  const handleSelectPreset = (p) => {
    setIsOther(false);
    onChange(p);
  };

  const handleSelectOther = () => {
    setIsOther(true);
    onChange(customText || '');
  };

  const handleCustomChange = (e) => {
    const text = e.target.value;
    setCustomText(text);
    onChange(text);
  };

  return (
    <div className={`space-y-2 ${className}`}>
      {label && (
        <div className="flex items-center justify-between text-[13px] font-bold text-sg-ink">
          <span>{label} {required && <span className="text-sg-danger">*</span>}</span>
        </div>
      )}

      <div className="flex flex-wrap gap-1.5">
        {presets.map((p) => {
          const selected = !isOther && value === p;
          return (
            <button
              key={p}
              type="button"
              onClick={() => handleSelectPreset(p)}
              className={`min-h-[36px] px-3 py-1.5 rounded-full text-[12px] font-medium border transition active:scale-95 ${
                selected
                  ? 'bg-sg-brown text-white border-sg-brown font-bold'
                  : 'bg-sg-paper text-sg-ink border-sg-line hover:border-sg-muted'
              }`}
            >
              {p}
            </button>
          );
        })}

        <button
          type="button"
          onClick={handleSelectOther}
          className={`min-h-[36px] px-3 py-1.5 rounded-full text-[12px] font-medium border transition active:scale-95 ${
            isOther
              ? 'bg-sg-brown text-white border-sg-brown font-bold'
              : 'bg-sg-paper text-sg-ink border-sg-line hover:border-sg-muted'
          }`}
        >
          其他
        </button>
      </div>

      {isOther && (
        <div className="pt-1">
          <input
            type="text"
            value={customText}
            onChange={handleCustomChange}
            placeholder="請輸入原因..."
            className="w-full px-3 py-2 rounded-xl border border-sg-line text-[13px] text-sg-ink bg-white focus:outline-none focus:border-sg-brown focus:ring-1 focus:ring-sg-brown"
          />
        </div>
      )}
    </div>
  );
}
