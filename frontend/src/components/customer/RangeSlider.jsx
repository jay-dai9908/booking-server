import React, { useRef, useCallback } from 'react';

export function RangeSlider({
  totalHours = 6,
  minHours = 2,
  from = 0, // 0..totalHours
  to = 6,   // 0..totalHours
  onChange,
  onCommit,
  boundaryTimes = [], // ['12:00', '13:00', ... '18:00']
  boardIndex = 1,
  className = '',
}) {
  const trackRef = useRef(null);
  const draggingHandleRef = useRef(null); // 'from' | 'to'

  const effectiveMin = Math.min(minHours, totalHours);

  const getPercent = (hourIdx) => (totalHours > 0 ? (hourIdx / totalHours) * 100 : 0);

  const hourFromPointer = useCallback(
    (clientX) => {
      if (!trackRef.current) return 0;
      const rect = trackRef.current.getBoundingClientRect();
      const relX = Math.max(0, Math.min(rect.width, clientX - rect.left));
      const ratio = rect.width > 0 ? relX / rect.width : 0;
      return Math.round(ratio * totalHours);
    },
    [totalHours]
  );

  const handlePointerDown = (handleType, e) => {
    e.preventDefault();
    e.stopPropagation();
    draggingHandleRef.current = handleType;
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const handlePointerMove = (e) => {
    if (!draggingHandleRef.current) return;
    const targetHour = hourFromPointer(e.clientX);
    const handleType = draggingHandleRef.current;

    if (handleType === 'from') {
      const maxAllowed = to - effectiveMin;
      const newFrom = Math.max(0, Math.min(maxAllowed, targetHour));
      if (newFrom !== from) {
        onChange({ from: newFrom, to });
      }
    } else if (handleType === 'to') {
      const minAllowed = from + effectiveMin;
      const newTo = Math.max(minAllowed, Math.min(totalHours, targetHour));
      if (newTo !== to) {
        onChange({ from, to: newTo });
      }
    }
  };

  const handlePointerUp = (e) => {
    if (draggingHandleRef.current) {
      draggingHandleRef.current = null;
      if (onCommit) onCommit({ from, to });
    }
  };

  const handleTrackPointerDown = (e) => {
    const targetHour = hourFromPointer(e.clientX);
    const distToFrom = Math.abs(targetHour - from);
    const distToTo = Math.abs(targetHour - to);

    if (distToFrom <= distToTo) {
      const maxAllowed = to - effectiveMin;
      const newFrom = Math.max(0, Math.min(maxAllowed, targetHour));
      onChange({ from: newFrom, to });
      if (onCommit) onCommit({ from: newFrom, to });
    } else {
      const minAllowed = from + effectiveMin;
      const newTo = Math.max(minAllowed, Math.min(totalHours, targetHour));
      onChange({ from, to: newTo });
      if (onCommit) onCommit({ from, to: newTo });
    }
  };

  const handleKeyDown = (handleType, e) => {
    let delta = 0;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') delta = -1;
    else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') delta = 1;
    else if (e.key === 'Home') delta = -999;
    else if (e.key === 'End') delta = 999;
    else return;

    e.preventDefault();

    if (handleType === 'from') {
      const maxAllowed = to - effectiveMin;
      let newFrom = delta === -999 ? 0 : delta === 999 ? maxAllowed : from + delta;
      newFrom = Math.max(0, Math.min(maxAllowed, newFrom));
      onChange({ from: newFrom, to });
      if (onCommit) onCommit({ from: newFrom, to });
    } else {
      const minAllowed = from + effectiveMin;
      let newTo = delta === -999 ? minAllowed : delta === 999 ? totalHours : to + delta;
      newTo = Math.max(minAllowed, Math.min(totalHours, newTo));
      onChange({ from, to: newTo });
      if (onCommit) onCommit({ from, to: newTo });
    }
  };

  const fromLeftPct = getPercent(from);
  const toLeftPct = getPercent(to);
  const fillWidthPct = toLeftPct - fromLeftPct;

  const showShortTickLabel = boundaryTimes.length > 7;

  return (
    <div className={`w-full select-none ${className}`}>
      {/* Slider Track and Thumbs */}
      <div
        className="sg-range"
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
      >
        {/* Clickable Track */}
        <div
          ref={trackRef}
          onPointerDown={handleTrackPointerDown}
          className="sg-range-track cursor-pointer"
        />

        {/* Selected Fill Range */}
        <div
          className="sg-range-fill pointer-events-none"
          style={{ left: `${fromLeftPct}%`, width: `${fillWidthPct}%` }}
        />

        {/* Start Handle (from) */}
        <div
          role="slider"
          tabIndex={0}
          aria-valuemin={0}
          aria-valuemax={to - effectiveMin}
          aria-valuenow={from}
          aria-valuetext={boundaryTimes[from] || `${from}:00`}
          aria-label={`第 ${boardIndex} 台開始時間`}
          onPointerDown={(e) => handlePointerDown('from', e)}
          onKeyDown={(e) => handleKeyDown('from', e)}
          style={{ left: `${fromLeftPct}%` }}
          className="sg-range-handle focus-visible:outline focus-visible:outline-2 focus-visible:outline-sg-brown"
        />

        {/* End Handle (to) */}
        <div
          role="slider"
          tabIndex={0}
          aria-valuemin={from + effectiveMin}
          aria-valuemax={totalHours}
          aria-valuenow={to}
          aria-valuetext={boundaryTimes[to] || `${to}:00`}
          aria-label={`第 ${boardIndex} 台結束時間`}
          onPointerDown={(e) => handlePointerDown('to', e)}
          onKeyDown={(e) => handleKeyDown('to', e)}
          style={{ left: `${toLeftPct}%` }}
          className="sg-range-handle focus-visible:outline focus-visible:outline-2 focus-visible:outline-sg-brown"
        />
      </div>

      {/* Ticks */}
      <div className="sg-ticks" aria-hidden="true">
        {boundaryTimes.map((time, idx) => {
          const pct = getPercent(idx);
          const isInRange = idx >= from && idx <= to;
          const displayLabel = showShortTickLabel ? time.split(':')[0] : time;

          return (
            <span
              key={idx}
              className={isInRange ? 'sg-tick-in' : ''}
              style={{ left: `${pct}%` }}
            >
              {displayLabel}
            </span>
          );
        })}
      </div>
    </div>
  );
}

export function BoardTimeBox({
  unit, // { uid, equipment_id, from, to }
  config,
  boardIndex = 1,
  totalHours = 6,
  boundaryTimes = [],
  onChange,
  onCommit,
  className = '',
}) {
  const minHours = Math.min(config?.min_contiguous_hours || 2, totalHours);
  const hours = unit.to - unit.from;
  const startTime = boundaryTimes[unit.from] || '';
  const endTime = boundaryTimes[unit.to] || '';

  const isFullSpan = totalHours <= minHours;

  return (
    <div className={`grid gap-[6px] rounded-[12px] bg-sg-bg p-[10px] w-full ${className}`}>
      <div className="flex justify-between items-center text-[12px]">
        <span className="text-sg-muted">
          第 <span className="font-num font-bold">{boardIndex}</span> 台使用時間
        </span>
        <span className="font-num font-bold text-sg-ink">
          {startTime} 到 {endTime} · {hours} 小時
        </span>
      </div>

      {isFullSpan ? (
        <div className="sg-small py-1">
          整段 {startTime} 到 {endTime} · {hours} 小時
        </div>
      ) : (
        <>
          <RangeSlider
            totalHours={totalHours}
            minHours={minHours}
            from={unit.from}
            to={unit.to}
            boardIndex={boardIndex}
            boundaryTimes={boundaryTimes}
            onChange={(val) => onChange && onChange(val)}
            onCommit={(val) => onCommit && onCommit(val)}
          />
          <div className="sg-small mt-1">
            拖曳兩端的圓點調整，至少 {minHours} 小時；其他時間用傳統板
          </div>
        </>
      )}
    </div>
  );
}

export default RangeSlider;
