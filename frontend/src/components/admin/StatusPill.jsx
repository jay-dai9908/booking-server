import React from 'react';

const STATUS_CONFIGS = {
  unpaid: { label: '未結帳', bg: 'bg-sg-danger-soft text-sg-danger border-sg-danger/20' },
  partial: { label: '部分已付', bg: 'bg-sg-honey-soft text-sg-honey-ink border-sg-honey/30' },
  paid: { label: '已結清', bg: 'bg-sg-sage-soft text-sg-sage-ink border-sg-sage/30' },
  waived: { label: '免收', bg: 'bg-sg-full-soft text-sg-muted border-sg-line' },
  refund: { label: '有退款', bg: 'bg-sg-danger-soft text-sg-danger border-sg-danger/20' },
  pending: { label: '待補收', bg: 'bg-sg-honey-soft text-sg-honey-ink border-sg-honey/30' }
};

export default function StatusPill({ status = 'unpaid', label = null, className = '', children }) {
  const conf = STATUS_CONFIGS[status] || STATUS_CONFIGS.unpaid;
  const displayLabel = children || label || conf.label;

  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded-full text-[12px] font-bold border whitespace-nowrap leading-[1.6] ${conf.bg} ${className}`}
    >
      {displayLabel}
    </span>
  );
}
