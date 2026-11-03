import React from 'react';
import { Minus, Plus } from 'lucide-react';

export default function Stepper({
  value = 1,
  min = 0,
  max = 999,
  onChange,
  onMinus,
  onPlus,
  disabledMinus,
  disabledPlus,
  emphasis = false,
  label = '數量',
  className = '',
}) {
  const numericValue = Number(value) || 0;
  const canMinus = (disabledMinus !== undefined ? !disabledMinus : true) && numericValue > min;
  const canPlus = (disabledPlus !== undefined ? !disabledPlus : true) && numericValue < max;

  const handleMinus = () => {
    if (canMinus) {
      if (onMinus) onMinus();
      else onChange?.(numericValue - 1);
    }
  };

  const handlePlus = () => {
    if (canPlus) {
      if (onPlus) onPlus();
      else onChange?.(numericValue + 1);
    }
  };


  return (
    <div className={`flex items-center gap-[6px] select-none ${className}`}>
      <button
        type="button"
        disabled={!canMinus}
        onClick={handleMinus}
        aria-label={`減少${label}`}
        className="relative h-8 w-8 rounded-full border-[1.5px] border-sg-line bg-sg-paper text-sg-brown grid place-items-center before:absolute before:inset-[-6px] before:content-[''] disabled:text-sg-full disabled:cursor-not-allowed hover:bg-sg-brown-soft/40 active:scale-[0.95] transition"
      >
        <Minus className="w-4 h-4" strokeWidth={2.5} />
      </button>

      <span
        aria-live="polite"
        className="font-num font-extrabold text-[18px] min-w-[24px] text-center text-sg-ink tabular-nums"
      >
        {value}
      </span>

      <button
        type="button"
        disabled={!canPlus}
        onClick={handlePlus}
        aria-label={`增加${label}`}
        className={`relative h-8 w-8 rounded-full border-[1.5px] grid place-items-center before:absolute before:inset-[-6px] before:content-[''] disabled:opacity-40 disabled:cursor-not-allowed active:scale-[0.95] transition ${
          emphasis
            ? 'bg-sg-brown text-white border-sg-brown hover:bg-sg-brown-hover'
            : 'border-sg-line bg-sg-paper text-sg-brown hover:bg-sg-brown-soft/40'
        }`}
      >
        <Plus className="w-4 h-4" strokeWidth={2.5} />
      </button>
    </div>
  );
}
