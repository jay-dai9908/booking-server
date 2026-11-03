import React from 'react';
import { BeadMeter } from './Bead.jsx';
import { meterBeads } from '../../utils/customer/availability.js';

export function SlotCell({
  session,
  startTime,
  endTime,
  remaining,
  maxCapacity,
  state: stateProp,
  beads: beadsProp,
  isSelected = false,
  readOnly = false,
  onClick,
  className = '',
}) {
  const st = session?.start_time ?? startTime ?? '';
  const et = session?.end_time ?? endTime ?? '';
  const rem = session?.remaining_capacity ?? remaining ?? 0;
  const maxCap = session?.max_capacity ?? maxCapacity ?? 10;
  const state = stateProp ?? 'ok';

  const isPast = state === 'past';
  const isFull = state === 'full';
  const isMuted = isPast || isFull;

  let cellBg = 'bg-sg-paper border-sg-line';
  let startColor = 'text-sg-ink';
  let endColor = 'text-sg-muted';
  let statusColor = state === 'low' ? 'text-sg-honey-ink font-bold' : 'text-sg-muted';
  let statusText = `剩 ${rem}`;

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

  const beadCount = beadsProp ?? meterBeads(rem, maxCap);

  const ariaLabel = isSelected
    ? `${st} 到 ${et}，已選取`
    : isFull
    ? `${st} 到 ${et}，已額滿`
    : isPast
    ? `${st} 到 ${et}，已過`
    : `${st} 到 ${et}，剩 ${rem} 位`;

  const content = (
    <>
      <span className={`sg-slot-start font-num font-extrabold text-[16px] leading-[1.15] ${startColor}`}>
        {st}
      </span>
      <span className={`sg-slot-end font-num font-semibold text-[12px] leading-[1.2] -mt-[2px] ${endColor}`}>
        到 {et}
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
