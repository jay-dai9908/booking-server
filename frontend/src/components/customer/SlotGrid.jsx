import React from 'react';
import { BeadMeter } from './Bead.jsx';
import { meterBeads } from '../../utils/customer/availability.js';

export function SlotCell({
  session,
  state = 'ok', // 'ok' | 'low' | 'full' | 'past'
  isSelected = false,
  readOnly = false,
  onClick,
  className = '',
}) {
  const isPast = state === 'past';
  const isFull = state === 'full';
  const isMuted = isPast || isFull;

  let cellBg = 'bg-sg-paper border-sg-line';
  let startColor = 'text-sg-ink';
  let endColor = 'text-sg-muted';
  let statusColor = state === 'low' ? 'text-sg-honey-ink font-bold' : 'text-sg-muted';
  let statusText = `剩 ${session.remaining_capacity}`;

  if (isFull) {
    statusText = '額滿';
    cellBg = 'bg-sg-bg border-dashed border-sg-line';
    startColor = 'text-sg-full';
    endColor = 'text-sg-full';
    statusColor = 'text-sg-full';
  } else if (isPast) {
    statusText = '已過';
    cellBg = 'bg-sg-bg border-dashed border-sg-line';
    startColor = 'text-sg-full';
    endColor = 'text-sg-full';
    statusColor = 'text-sg-full';
  }

  if (isSelected) {
    cellBg = 'bg-sg-brown border-sg-brown';
    startColor = 'text-white';
    endColor = 'text-white/85';
    statusColor = 'text-white font-bold';
    statusText = '已選';
  }

  const beadCount = meterBeads(session.remaining_capacity, session.max_capacity);

  const ariaLabel = isSelected
    ? `${session.start_time} 到 ${session.end_time}，已選取`
    : isFull
    ? `${session.start_time} 到 ${session.end_time}，已額滿`
    : isPast
    ? `${session.start_time} 到 ${session.end_time}，已過`
    : `${session.start_time} 到 ${session.end_time}，剩 ${session.remaining_capacity} 位`;

  const content = (
    <>
      <span className={`sg-slot-start font-num font-extrabold text-[16px] leading-[1.15] ${startColor}`}>
        {session.start_time}
      </span>
      <span className={`sg-slot-end font-num font-semibold text-[12px] leading-[1.2] -mt-[2px] ${endColor}`}>
        到 {session.end_time}
      </span>
      <BeadMeter
        count={beadCount}
        state={state}
        isSelected={isSelected}
      />
      <span className={`sg-slot-status text-[12px] leading-[1.3] ${statusColor}`}>
        {statusText}
      </span>
    </>
  );

  if (readOnly) {
    return (
      <div
        className={`grid justify-items-center gap-[3px] rounded-[14px] border pt-2 px-1 pb-[7px] min-h-[76px] cursor-default select-none ${cellBg} ${className}`}
        aria-label={ariaLabel}
      >
        {content}
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={isSelected}
      aria-disabled={isMuted ? 'true' : undefined}
      aria-label={ariaLabel}
      className={`grid justify-items-center gap-[3px] rounded-[14px] border pt-2 px-1 pb-[7px] min-h-[76px] select-none transition-colors duration-150 active:scale-[0.98] ${cellBg} ${className}`}
    >
      {content}
    </button>
  );
}

export function SlotGrid({ children, className = '' }) {
  return (
    <div className={`grid grid-cols-3 gap-2 w-full ${className}`}>
      {children}
    </div>
  );
}

export default SlotGrid;
