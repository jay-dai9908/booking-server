import React from 'react';
import { BeadRow } from './Bead.jsx';

export default function EmptyState({
  title = '',
  description = '',
  action,
  className = '',
  children,
}) {
  return (
    <div
      className={`grid justify-items-center gap-2 py-8 text-center select-none ${className}`}
    >
      <BeadRow className="mb-1" count={5} />
      {title && (
        <h3 className="text-[15px] font-bold text-sg-ink">
          {title}
        </h3>
      )}
      {description && (
        <p className="text-[13px] text-sg-muted max-w-[280px]">
          {description}
        </p>
      )}
      {children}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}
