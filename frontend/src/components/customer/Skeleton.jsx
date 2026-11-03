import React from 'react';

export function Skeleton({ className = '' }) {
  return (
    <div
      className={`rounded-[14px] bg-sg-line/60 animate-pulse ${className}`}
      aria-hidden="true"
    />
  );
}

export function SlotGridSkeleton({ count = 9, className = '' }) {
  return (
    <div className={`grid grid-cols-3 gap-2 w-full ${className}`} aria-hidden="true">
      {Array.from({ length: count }).map((_, i) => (
        <Skeleton key={i} className="min-h-[76px] rounded-[14px]" />
      ))}
    </div>
  );
}

export function DateStripSkeleton({ count = 7, className = '' }) {
  return (
    <div className={`flex gap-[6px] overflow-hidden min-h-[58px] ${className}`} aria-hidden="true">
      {Array.from({ length: count }).map((_, i) => (
        <Skeleton key={i} className="w-[44px] min-h-[56px] rounded-[12px] flex-none" />
      ))}
    </div>
  );
}

export default Skeleton;
