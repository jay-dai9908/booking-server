import React from 'react';

export default function HourChips({
  title,
  options = [],
  selectedValue,
  onSelect,
  className = '',
}) {
  return (
    <div className={`grid gap-[6px] w-full ${className}`}>
      {title && (
        <h3 className="text-[14px] font-bold text-sg-ink">
          {title}
        </h3>
      )}
      <div className="grid grid-cols-4 gap-[6px]" role="radiogroup">
        {options.map((opt) => {
          const isSelected = selectedValue === opt.time || selectedValue === opt.index || selectedValue === opt.endIndex;
          const isClosing = opt.isClosing;
          const isEnabled = opt.enabled !== false;

          let btnClass = 'bg-sg-paper border-sg-line text-sg-ink hover:border-sg-brown/50';
          if (!isEnabled) {
            btnClass = 'bg-sg-bg border-dashed border-sg-line text-sg-full cursor-not-allowed';
          } else if (isSelected) {
            btnClass = 'bg-sg-brown border-sg-brown text-white';
          }

          return (
            <button
              key={opt.time + (opt.endIndex ?? '')}
              type="button"
              role="radio"
              aria-checked={isSelected}
              disabled={!isEnabled}
              aria-disabled={!isEnabled ? 'true' : undefined}
              onClick={() => isEnabled && onSelect(opt)}
              className={`min-h-[44px] grid place-items-center rounded-[10px] border select-none transition ${
                isClosing ? 'col-span-2' : ''
              } ${btnClass} ${isEnabled ? 'active:scale-[0.98]' : ''}`}
            >
              {isClosing ? (
                <span className="font-body text-[13px] font-bold">
                  玩到打烊 <span className="font-num">{opt.time}</span>
                </span>
              ) : (
                <span className="font-num font-bold text-[13px]">
                  {opt.time}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
