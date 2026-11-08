import React, { useRef, useCallback } from 'react';

export function RangeSlider({
  totalHours = 6,
  minHours = 2,
  from = 0, // 0..totalHours
  to = 6,   // 0..totalHours
  boundStart = 0,
  boundEnd = totalHours,
  blockedSlots = [],
  onChange,
  onCommit,
  boundaryTimes = [], // ['12:00', '13:00', ... '18:00']
  boardIndex = 1,
  className = '',
}) {
  const trackRef = useRef(null);
  const draggingHandleRef = useRef(null); // 'from' | 'to'

  const effectiveMin = Math.min(minHours, totalHours);
  const safeBoundStart = Math.max(0, boundStart);
  const safeBoundEnd = Math.min(totalHours, boundEnd);

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
      const newFrom = Math.max(safeBoundStart, Math.min(maxAllowed, targetHour));
      if (newFrom !== from) {
        onChange({ from: newFrom, to });
      }
    } else if (handleType === 'to') {
      const minAllowed = from + effectiveMin;
      const newTo = Math.max(minAllowed, Math.min(safeBoundEnd, targetHour));
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
      const newFrom = Math.max(safeBoundStart, Math.min(maxAllowed, targetHour));
      onChange({ from: newFrom, to });
      if (onCommit) onCommit({ from: newFrom, to });
    } else {
      const minAllowed = from + effectiveMin;
      const newTo = Math.max(minAllowed, Math.min(safeBoundEnd, targetHour));
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
      let newFrom = delta === -999 ? safeBoundStart : delta === 999 ? maxAllowed : from + delta;
      newFrom = Math.max(safeBoundStart, Math.min(maxAllowed, newFrom));
      onChange({ from: newFrom, to });
      if (onCommit) onCommit({ from: newFrom, to });
    } else {
      const minAllowed = from + effectiveMin;
      let newTo = delta === -999 ? minAllowed : delta === 999 ? safeBoundEnd : to + delta;
      newTo = Math.max(minAllowed, Math.min(safeBoundEnd, newTo));
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
        onPointerCancel={handlePointerUp}
      >
        {/* Clickable Track */}
        <div
          ref={trackRef}
          data-testid="slider-track"
          onPointerDown={handleTrackPointerDown}
          className="sg-range-track cursor-pointer relative"
        >
          {/* Muted blocked slot indicators */}
          {blockedSlots.map((slotIdx) => {
            const leftPct = getPercent(slotIdx);
            const widthPct = getPercent(slotIdx + 1) - leftPct;
            return (
              <div
                key={slotIdx}
                className="absolute top-0 bottom-0 bg-stone-300/70 rounded-[3px] pointer-events-none"
                style={{ left: `${leftPct}%`, width: `${widthPct}%` }}
                title="已租用其他智能板"
              />
            );
          })}
        </div>

        {/* Selected Fill Range */}
        <div
          className="sg-range-fill pointer-events-none"
          style={{ left: `${fromLeftPct}%`, width: `${fillWidthPct}%` }}
        />

        {/* Start Handle (from) */}
        <div
          role="slider"
          data-testid="handle-start"
          tabIndex={0}
          aria-valuemin={safeBoundStart}
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
          data-testid="handle-end"
          tabIndex={0}
          aria-valuemin={from + effectiveMin}
          aria-valuemax={safeBoundEnd}
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
  totalHours: totalHoursProp,
  boundaryTimes: boundaryTimesProp,
  boundStart,
  boundEnd,
  blockedSlots,
  onChange,
  onCommit,
  className = '',
  // Direct props support
  label,
  from: fromProp,
  to: toProp,
  minHours: minHoursProp,
  bookingSessions = [],
}) {
  let boundaryTimes = boundaryTimesProp;
  if ((!boundaryTimes || boundaryTimes.length === 0) && Array.isArray(bookingSessions) && bookingSessions.length > 0) {
    boundaryTimes = [
      ...bookingSessions.map((s) => s.start_time),
      bookingSessions[bookingSessions.length - 1]?.end_time,
    ];
  }
  if (!boundaryTimes) boundaryTimes = [];

  const totalHours = totalHoursProp ?? (boundaryTimes.length > 1 ? boundaryTimes.length - 1 : (bookingSessions.length || 6));
  const from = unit?.from ?? fromProp ?? 0;
  const to = unit?.to ?? toProp ?? totalHours;
  const minHours = minHoursProp ?? Math.min(config?.min_contiguous_hours || 2, totalHours);
  const hours = to - from;
  const startTime = boundaryTimes[from] || '';
  const endTime = boundaryTimes[to] || '';

  const isFullSpan = totalHours <= minHours && (!blockedSlots || blockedSlots.length === 0);

  const fireChange = (val) => {
    if (!onChange) return;
    if (onChange.length >= 2) {
      onChange(val.from, val.to);
    } else {
      onChange(val);
    }
  };

  const fireCommit = (val) => {
    if (!onCommit) return;
    if (onCommit.length >= 2) {
      onCommit(val.from, val.to);
    } else {
      onCommit(val);
    }
  };

  const titleText = label || (
    <>
      第 <span className="font-num font-bold">{boardIndex}</span> 台使用時間
    </>
  );

  return (
    <div className={`grid gap-[6px] rounded-[12px] bg-sg-bg p-[10px] w-full ${className}`}>
      <div className="flex justify-between items-center text-[12px]">
        <span className="text-sg-muted">{titleText}</span>
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
            from={from}
            to={to}
            boundStart={boundStart}
            boundEnd={boundEnd}
            blockedSlots={blockedSlots}
            boardIndex={boardIndex}
            boundaryTimes={boundaryTimes}
            onChange={fireChange}
            onCommit={fireCommit}
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
