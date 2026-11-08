import React from 'react';
import { Wind, Check, Pause, Clock } from 'lucide-react';

const STATE_STYLES = {
  run: 'bg-sg-sage-soft text-sg-sage-ink border-sg-sage/40',
  warn: 'bg-sg-honey-soft text-sg-honey-ink border-sg-honey/40',
  over: 'bg-sg-danger-soft text-sg-danger border-sg-danger/40 animate-pulse',
  pause: 'bg-sg-vent/15 text-sg-vent border-sg-vent/40',
  resv: 'bg-sg-paper text-sg-muted border-sg-line',
  empty: 'bg-white text-sg-muted border-sg-line hover:border-sg-brown/50',
  ended: 'bg-sg-paper/60 text-sg-muted border-sg-line/60',
  pick: 'bg-sg-brown text-white border-sg-brown shadow-sm',
  sugg: 'bg-sg-peach-soft text-sg-peach-ink border-sg-peach border-dashed',
  used: 'bg-sg-paper text-sg-muted border-sg-line opacity-50 cursor-not-allowed',
  off: 'bg-sg-line text-sg-muted border-sg-line opacity-30 cursor-not-allowed'
};

export default function SeatTile({
  code = '',
  state = 'empty', // run | warn | over | pause | resv | empty | ended | pick | sugg | used | off
  size = 'full', // full | demo | edit | mini | map
  isVent = false,
  isPaid = false,
  boards = [], // ['S', 'M']
  timerText = null,
  paxName = null,
  onClick = null,
  className = ''
}) {
  const stateClass = STATE_STYLES[state] || STATE_STYLES.empty;

  let sizeClasses = 'min-w-[56px] min-h-[44px] p-1.5 text-[12px]';
  if (size === 'mini' || size === 'map') {
    sizeClasses = 'min-w-[36px] min-h-[30px] p-1 text-[11px]';
  } else if (size === 'edit') {
    sizeClasses = 'w-[52px] h-[40px] p-1 text-[11px]';
  }

  const content = (
    <div
      className={`relative rounded-xl border flex flex-col justify-between select-none transition ${sizeClasses} ${stateClass} ${className}`}
    >
      {/* Top row: code & badges */}
      <div className="flex items-center justify-between w-full leading-none">
        <span className="font-bold truncate">{code}</span>
        <div className="flex items-center gap-0.5 ml-1">
          {isVent && <Wind className="w-2.5 h-2.5 text-sg-vent flex-shrink-0" />}
          {isPaid && <Check className="w-2.5 h-2.5 text-sg-sage-ink flex-shrink-0" />}
        </div>
      </div>

      {/* Middle/Bottom: timerText and paxName formatted cleanly on separate lines */}
      {(paxName || timerText) && size !== 'mini' && size !== 'map' && (
        <div className="mt-1 flex flex-col gap-0.5 text-[11px] font-medium leading-tight">
          {paxName && <span className="truncate max-w-full font-bold">{paxName}</span>}
          {timerText && (
            <span className="font-bold flex items-center gap-0.5 text-[10px] opacity-90">
              {state === 'pause' && <Pause className="w-2 h-2 flex-shrink-0" />}
              {timerText}
            </span>
          )}
        </div>
      )}

      {/* Smart board badges if any */}
      {boards && boards.length > 0 && size !== 'mini' && size !== 'map' && (
        <div className="absolute -top-1.5 -right-1 flex gap-0.5">
          {boards.map((b, i) => (
            <span
              key={i}
              className="px-1 py-0.2 rounded-full text-[9px] font-bold bg-sg-brown text-white leading-none shadow-xs"
            >
              {b}
            </span>
          ))}
        </div>
      )}
    </div>
  );

  if (onClick && state !== 'used' && state !== 'off') {
    return (
      <button
        type="button"
        onClick={onClick}
        className="focus:outline-none active:scale-95 transition"
      >
        {content}
      </button>
    );
  }

  return content;
}
