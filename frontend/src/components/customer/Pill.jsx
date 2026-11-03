import React from 'react';

const VARIANTS = {
  ok: 'bg-sg-sage-soft text-sg-sage-ink',
  low: 'bg-sg-honey-soft text-sg-honey-ink',
  full: 'bg-sg-full-soft text-sg-muted',
  brand: 'bg-sg-brown-soft text-sg-brown',
  peach: 'bg-sg-peach-soft text-sg-peach-ink',
};

export default function Pill({
  children,
  variant = 'full',
  selected = false,
  onClick,
  className = '',
  disabled = false,
  ...props
}) {
  const activeVariant = selected ? 'brand' : variant;
  const styleClasses = VARIANTS[activeVariant] || VARIANTS.full;

  if (onClick) {
    return (
      <button
        type="button"
        disabled={disabled}
        onClick={onClick}
        className={`relative inline-flex items-center justify-center -my-[6px] py-[6px] select-none ${className}`}
        {...props}
      >
        <span
          className={`inline-flex items-center min-h-[32px] rounded-full px-[10px] py-[3px] text-[12px] font-bold leading-[1.6] whitespace-nowrap transition active:scale-[0.96] ${styleClasses}`}
        >
          {children}
        </span>
      </button>
    );
  }

  return (
    <span
      className={`inline-flex items-center rounded-full px-[10px] py-[3px] text-[12px] font-bold leading-[1.6] whitespace-nowrap ${styleClasses} ${className}`}
      {...props}
    >
      {children}
    </span>
  );
}
