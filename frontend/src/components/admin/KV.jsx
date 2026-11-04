import React from 'react';

export default function KV({
  label,
  value,
  variant = 'normal', // 'normal' | 'strong' | 'save' | 'danger'
  sub = null,
  className = '',
  children
}) {
  let valueStyle = 'text-sg-ink font-medium';
  if (variant === 'strong') {
    valueStyle = 'text-sg-ink font-bold text-[16px]';
  } else if (variant === 'save') {
    valueStyle = 'text-sg-sage-ink font-bold';
  } else if (variant === 'danger') {
    valueStyle = 'text-sg-danger font-bold';
  }

  return (
    <div className={`flex items-baseline justify-between py-1 text-[13px] ${className}`}>
      <span className="text-sg-muted flex-shrink-0">{label}</span>
      <div className="text-right">
        <span className={valueStyle}>{children || value}</span>
        {sub && <div className="text-[11px] text-sg-muted">{sub}</div>}
      </div>
    </div>
  );
}
