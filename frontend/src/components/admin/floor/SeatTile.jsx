import React from 'react';
import { Wind, Check } from 'lucide-react';

const STATE_STYLES = {
  in_use: 'bg-sg-sage-soft text-sg-sage-ink border-sg-sage/40',
  run: 'bg-sg-sage-soft text-sg-sage-ink border-sg-sage/40',
  warn: 'bg-sg-honey-soft text-sg-honey-ink border-sg-honey/40',
  over: 'bg-sg-danger-soft text-sg-danger border-sg-danger/40 animate-pulse',
  paused: 'bg-sg-vent/15 text-sg-vent border-sg-vent/40',
  pause: 'bg-sg-vent/15 text-sg-vent border-sg-vent/40',
  reserved: 'bg-white text-sg-ink border-sg-brown',
  resv: 'bg-white text-sg-ink border-sg-brown',
  empty: 'bg-white text-sg-muted border-sg-line hover:border-sg-brown/50',
  ended: 'bg-sg-paper/60 text-sg-muted border-sg-line/60',
  pick: 'bg-sg-brown text-white border-sg-brown shadow-sm',
  sugg: 'bg-sg-peach-soft text-sg-peach-ink border-sg-peach border-dashed',
  used: 'bg-sg-paper text-sg-muted border-sg-line opacity-50 cursor-not-allowed',
  off: 'bg-gray-100 text-gray-400 border-gray-200 opacity-40 cursor-pointer'
};

export default function SeatTile({
  code = '',
  state = 'empty', // in_use | run | warn | over | paused | pause | reserved | resv | empty | ended | pick | sugg | used | off
  size = 'full', // full (58×46) | mini (24×16) | demo (48×33) | edit (42×29) | map (20×14)
  isVent = false,
  isPaid = false,
  boards = [], // e.g. ['小板'] or ['小→中']
  timerText = null,
  paxName = null,
  onClick = null,
  className = ''
}) {
  const stateClass = STATE_STYLES[state] || STATE_STYLES.empty;

  let sizeClasses = 'w-[58px] h-[46px] min-w-[58px] min-h-[46px] p-1';
  if (size === 'mini') {
    sizeClasses = 'w-[24px] h-[16px] min-w-[24px] min-h-[16px] p-0.5';
  } else if (size === 'demo') {
    sizeClasses = 'w-[48px] h-[33px] min-w-[48px] min-h-[33px] p-1 text-[11px]';
  } else if (size === 'edit') {
    sizeClasses = 'w-[42px] h-[29px] min-w-[42px] min-h-[29px] p-1 text-[11px]';
  } else if (size === 'map') {
    sizeClasses = 'w-[20px] h-[14px] min-w-[20px] min-h-[14px] p-0.5';
  }

  // 6.4.2 內容：
  // 名字：12px，超過 4 個字截斷
  const displayName = paxName ? (paxName.length > 4 ? `${paxName.slice(0, 4)}…` : paxName) : '';

  // 計時或狀態：「2:38」「暫停 1:23」「超時 40 分」「16:00 到」「空位」
  let displayTimer = timerText;
  if (!displayTimer) {
    if (state === 'empty') displayTimer = '空位';
  } else if (state === 'pause' || state === 'paused') {
    if (!displayTimer.startsWith('暫停') && !displayTimer.startsWith('已暫停')) {
      displayTimer = `暫停 ${displayTimer}`;
    }
  }

  const boardTag = (boards && boards.length > 0) ? boards[0] : null;

  const content = (
    <div
      {...(!onClick || state === 'used' ? { 'data-seat-code': code } : {})}
      className={`relative rounded-xl border flex flex-col justify-between select-none transition ${sizeClasses} ${stateClass} ${className}`}
      style={{ boxSizing: 'border-box' }}
    >
      {/* Top row: code & optional board tag, and isPaid check on top-right */}
      <div className="flex items-center justify-between w-full leading-none">
        <div className="flex items-center gap-0.5 truncate">
          <span className="font-num text-[13px] font-bold tracking-tight">{code}</span>
          {boardTag && size === 'full' && (
            <span className="text-[9px] font-bold text-sg-brown px-0.5 rounded bg-sg-brown-soft/80 truncate">
              {boardTag}
            </span>
          )}
        </div>
        {isPaid && size !== 'mini' && size !== 'map' && (
          <Check className="w-3 h-3 text-sg-sage-ink flex-shrink-0" />
        )}
      </div>

      {/* Middle row: paxName (12px, truncated over 4 chars) */}
      {(size === 'full' || size === 'demo') && (
        <div className="text-[12px] font-medium leading-tight truncate text-sg-ink">
          {displayName}
        </div>
      )}

      {/* Bottom row: timer/status & vent icon on bottom-right */}
      {size === 'full' && (
        <div className="flex items-center justify-between w-full leading-none">
          <span className="text-[10px] font-bold text-sg-muted truncate">
            {displayTimer}
          </span>
          {isVent && <Wind className="w-2.5 h-2.5 text-sg-vent flex-shrink-0 ml-0.5" />}
        </div>
      )}

      {/* Mini mode: blue dot for vent */}
      {size === 'mini' && isVent && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <span className="w-1.5 h-1.5 rounded-full bg-blue-500" />
        </div>
      )}
    </div>
  );

  if (onClick && state !== 'used') {
    return (
      <button
        type="button"
        onClick={onClick}
        data-seat-code={code}
        className="focus:outline-none active:scale-95 transition cursor-pointer p-0 m-0 border-0 bg-transparent block"
        style={{
          width: size === 'mini' ? 24 : (size === 'demo' ? 48 : (size === 'edit' ? 42 : (size === 'map' ? 20 : 58))),
          height: size === 'mini' ? 16 : (size === 'demo' ? 33 : (size === 'edit' ? 29 : (size === 'map' ? 14 : 46)))
        }}
      >
        {content}
      </button>
    );
  }

  return content;
}
