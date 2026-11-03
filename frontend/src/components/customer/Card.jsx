import React from 'react';

export function Card({
  children,
  gap = 10,
  muted = false,
  className = '',
  as: Component = 'div',
  ...props
}) {
  let gapClass = 'gap-[10px]';
  if (gap === 0) gapClass = 'gap-0';
  else if (gap === 1) gapClass = 'gap-1';
  else if (gap === 2) gapClass = 'gap-2';
  else if (gap === 3) gapClass = 'gap-3';
  else if (gap === 4) gapClass = 'gap-1';
  else if (gap === 6) gapClass = 'gap-[6px]';
  else if (gap === 8) gapClass = 'gap-2';
  else if (gap === 12) gapClass = 'gap-3';

  const mutedClass = muted === true ? 'opacity-[.85]' : typeof muted === 'string' ? muted : '';

  return (
    <Component
      className={`grid ${gapClass} rounded-[18px] border border-sg-line bg-sg-paper p-[14px] ${mutedClass} ${className}`}
      {...props}
    >
      {children}
    </Component>
  );
}

export function KV({
  label,
  value,
  children,
  tone,
  className = '',
  leftClassName = '',
  rightClassName = '',
}) {
  const isSave = tone === 'save';
  const lColor = isSave ? 'text-sg-sage-ink font-bold' : 'text-sg-muted';
  const rColor = isSave ? 'text-sg-sage-ink font-bold' : 'text-sg-ink';

  return (
    <div
      className={`flex justify-between items-start gap-[10px] text-[13px] leading-[1.5] ${className}`}
    >
      <span className={`shrink-0 ${lColor} ${leftClassName}`}>{label}</span>
      <div className={`text-right ${rColor} ${rightClassName}`}>
        {value ?? children}
      </div>
    </div>
  );
}

export function Divider({ className = '' }) {
  return <div className={`h-px bg-sg-line w-full my-1 ${className}`} aria-hidden="true" />;
}

export default Card;
