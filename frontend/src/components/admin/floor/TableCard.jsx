import React, { useMemo, useRef, useState, useEffect, useCallback } from 'react';
import SeatTile from './SeatTile';

const GROUP_COLORS = [
  { stroke: '#8C6D58', fill: 'rgba(140, 109, 88, 0.05)' },  // brown
  { stroke: '#4E6B51', fill: 'rgba(78, 107, 81, 0.05)' },   // sage
  { stroke: '#6B8B97', fill: 'rgba(107, 139, 151, 0.05)' }, // vent
  { stroke: '#C98A2C', fill: 'rgba(201, 138, 44, 0.05)' }   // honey
];

export default function TableCard({
  table,
  zoneName = '',
  seats = [],
  seatStates = {},
  selectedSeats = [],
  suggestedSeats = [],
  onSeatClick = null,
  onTableTitleClick = null,
  className = ''
}) {
  const containerRef = useRef(null);
  const [groupBoxes, setGroupBoxes] = useState([]);

  const leftSeats = useMemo(() => seats.filter(s => s.side_resolved === 'L' || s.side === 'L'), [seats]);
  const rightSeats = useMemo(() => seats.filter(s => s.side_resolved === 'R' || s.side === 'R'), [seats]);
  const isOneSide = table.arrangement === 'one_side' || rightSeats.length === 0;

  // Helper to get bookingRef for a seat
  const getBookingRef = useCallback((seatCode) => {
    const info = seatStates[seatCode];
    if (!info) return null;
    return info.bookingRef || info.booking?.booking_ref || null;
  }, [seatStates]);

  // Group summary for header (Round 17 Item 5)
  const groupSummary = useMemo(() => {
    const map = new Map();
    for (const seat of seats) {
      const info = seatStates[seat.code];
      if (!info) continue;
      const ref = info.bookingRef || info.booking?.booking_ref;
      const name = info.paxName || info.booking?.name;
      if (!ref && !name) continue;

      const key = ref || name;
      if (!map.has(key)) {
        map.set(key, {
          name: name || '客人',
          pax: info.booking?.pax || 1,
          seatCount: 1,
          timerText: info.timerText && info.timerText !== '空位' && info.timerText !== '已停用' ? info.timerText : ''
        });
      } else {
        map.get(key).seatCount += 1;
      }
    }

    const summaries = [];
    for (const item of map.values()) {
      const paxText = `${item.pax || item.seatCount} 位`;
      const timePart = item.timerText ? ` ${item.timerText}` : '';
      summaries.push(`${item.name} ${paxText}${timePart}`);
    }
    return summaries.join(' · ');
  }, [seats, seatStates]);

  // Measure seat positions and calculate dashed frames for each group
  const updateGroupBoxes = useCallback(() => {
    if (!containerRef.current) return;
    const containerEl = containerRef.current;
    const cRect = containerEl.getBoundingClientRect();

    // Map each seat code to its relative rect
    const seatRects = {};
    for (const s of seats) {
      const el = containerEl.querySelector(`[data-seat-code="${s.code}"]`);
      if (el) {
        const r = el.getBoundingClientRect();
        seatRects[s.code] = {
          left: r.left - cRect.left,
          top: r.top - cRect.top,
          right: r.right - cRect.left,
          bottom: r.bottom - cRect.top,
          width: r.width,
          height: r.height
        };
      }
    }

    const centerEl = containerEl.querySelector(`[data-table-center="${table.id}"]`);
    let centerRect = null;
    if (centerEl) {
      const cr = centerEl.getBoundingClientRect();
      centerRect = {
        left: cr.left - cRect.left,
        top: cr.top - cRect.top,
        right: cr.right - cRect.left,
        bottom: cr.bottom - cRect.top,
        width: cr.width,
        height: cr.height
      };
    }

    // Collect distinct bookingRefs sitting at this table
    const distinctRefs = [];
    for (const s of seats) {
      const ref = getBookingRef(s.code);
      if (ref && !distinctRefs.includes(ref)) {
        distinctRefs.push(ref);
      }
    }

    const pad = 4;
    const activeSeats = seats.filter(s => s.is_active);
    const totalActive = activeSeats.length;
    const computed = [];

    // Helper to cluster contiguous runs of seats matching a ref
    const clusterByContiguity = (seatList, targetRef) => {
      const clusters = [];
      let current = [];
      for (const s of seatList) {
        if (getBookingRef(s.code) === targetRef) {
          current.push(s);
        } else {
          if (current.length > 0) {
            clusters.push(current);
            current = [];
          }
        }
      }
      if (current.length > 0) {
        clusters.push(current);
      }
      return clusters;
    };

    distinctRefs.forEach((ref, groupIdx) => {
      const color = GROUP_COLORS[groupIdx % GROUP_COLORS.length];
      const gSeats = seats.filter(s => getBookingRef(s.code) === ref && seatRects[s.code]);
      if (gSeats.length === 0) return;

      if (isOneSide) {
        // Long table: group adjacent seats by line / row
        const rowMap = new Map();
        for (const s of seats) {
          const r = seatRects[s.code];
          if (!r) continue;
          const rowKey = Math.round(r.top / 20) * 20;
          if (!rowMap.has(rowKey)) rowMap.set(rowKey, []);
          rowMap.get(rowKey).push(s);
        }

        rowMap.forEach((rSeats, rowKey) => {
          // Sort seats in row by left coordinate
          rSeats.sort((a, b) => (seatRects[a.code]?.left || 0) - (seatRects[b.code]?.left || 0));
          const clusters = clusterByContiguity(rSeats, ref);

          clusters.forEach((cluster, cIdx) => {
            const rects = cluster.map(s => seatRects[s.code]).filter(Boolean);
            if (rects.length === 0) return;
            const minL = Math.min(...rects.map(r => r.left)) - pad;
            const maxR = Math.max(...rects.map(r => r.right)) + pad;
            const minT = Math.min(...rects.map(r => r.top)) - pad;
            const maxB = Math.max(...rects.map(r => r.bottom)) + pad;
            computed.push({
              type: 'rect',
              key: `${ref}-row-${rowKey}-${cIdx}`,
              x: minL,
              y: minT,
              w: maxR - minL,
              h: maxB - minT,
              stroke: color.stroke,
              fill: color.fill
            });
          });
        });
      } else {
        // Two-sided table
        const leftInGroup = leftSeats.filter(s => getBookingRef(s.code) === ref);
        const rightInGroup = rightSeats.filter(s => getBookingRef(s.code) === ref);

        const isMajority = gSeats.length > totalActive / 2;
        const allLeft = leftSeats.length > 0 && leftSeats.every(s => getBookingRef(s.code) === ref);
        const allRight = rightSeats.length > 0 && rightSeats.every(s => getBookingRef(s.code) === ref);
        const hasFullSide = allLeft || allRight;
        const wrapTableLabel = isMajority && hasFullSide;

        // Check if row r has both sides in this group
        const maxR = Math.max(leftSeats.length, rightSeats.length);
        const fullRows = [];
        for (let r = 0; r < maxR; r++) {
          const lS = leftSeats[r];
          const rS = rightSeats[r];
          if (lS && rS && getBookingRef(lS.code) === ref && getBookingRef(rS.code) === ref) {
            fullRows.push(r);
          }
        }

        if (wrapTableLabel && (gSeats.length === totalActive || (allLeft && allRight))) {
          // Enclose entire table including center badge
          const allRects = [...gSeats.map(s => seatRects[s.code]), centerRect].filter(Boolean);
          const minL = Math.min(...allRects.map(r => r.left)) - pad;
          const maxR = Math.max(...allRects.map(r => r.right)) + pad;
          const minT = Math.min(...allRects.map(r => r.top)) - pad;
          const maxB = Math.max(...allRects.map(r => r.bottom)) + pad;
          computed.push({
            type: 'rect',
            key: `${ref}-all`,
            x: minL,
            y: minT,
            w: maxR - minL,
            h: maxB - minT,
            stroke: color.stroke,
            fill: color.fill
          });
        } else if (wrapTableLabel) {
          // Majority + full side: wraps the table number into the frame!
          // Box 1: wraps the entire full side + center badge
          const fullSideSeats = (allLeft ? leftSeats : rightSeats).map(s => seatRects[s.code]);
          const sidePlusCenter = [...fullSideSeats, centerRect].filter(Boolean);
          const sMinL = Math.min(...sidePlusCenter.map(r => r.left)) - pad;
          const sMaxR = Math.max(...sidePlusCenter.map(r => r.right)) + pad;
          const sMinT = Math.min(...sidePlusCenter.map(r => r.top)) - pad;
          const sMaxB = Math.max(...sidePlusCenter.map(r => r.bottom)) + pad;
          computed.push({
            type: 'rect',
            key: `${ref}-side-center`,
            x: sMinL,
            y: sMinT,
            w: sMaxR - sMinL,
            h: sMaxB - sMinT,
            stroke: color.stroke,
            fill: color.fill
          });

          // Box 2+: cluster adjacent seats on other side so opposing groups are NEVER swallowed
          const otherSideSeats = allLeft ? rightSeats : leftSeats;
          const otherClusters = clusterByContiguity(otherSideSeats, ref);
          otherClusters.forEach((cluster, cIdx) => {
            const rects = cluster.map(s => seatRects[s.code]).filter(Boolean);
            if (rects.length === 0) return;
            const cMinL = Math.min(...rects.map(r => r.left)) - pad;
            const cMaxR = Math.max(...rects.map(r => r.right)) + pad;
            const cMinT = Math.min(...rects.map(r => r.top)) - pad;
            const cMaxB = Math.max(...rects.map(r => r.bottom)) + pad;
            computed.push({
              type: 'rect',
              key: `${ref}-other-cluster-${cIdx}`,
              x: cMinL,
              y: cMinT,
              w: cMaxR - cMinL,
              h: cMaxB - cMinT,
              stroke: color.stroke,
              fill: color.fill
            });
          });
        } else if (fullRows.length > 0) {
          // Rule: 某一排兩面都是同一組，框就穿過中間桌號那一排連起來
          fullRows.forEach((rIdx) => {
            const lRect = seatRects[leftSeats[rIdx]?.code];
            const rRect = seatRects[rightSeats[rIdx]?.code];
            if (lRect && rRect) {
              const minL = Math.min(lRect.left, rRect.left) - pad;
              const maxR = Math.max(lRect.right, rRect.right) + pad;
              const minT = Math.min(lRect.top, rRect.top) - pad;
              const maxB = Math.max(lRect.bottom, rRect.bottom) + pad;
              computed.push({
                type: 'rect',
                key: `${ref}-row-${rIdx}`,
                x: minL,
                y: minT,
                w: maxR - minL,
                h: maxB - minT,
                stroke: color.stroke,
                fill: color.fill
              });
            }
          });

          // Any remaining seats not in fullRows
          const remainingLeft = leftSeats.filter(
            (s, idx) => !fullRows.includes(idx) && getBookingRef(s.code) === ref
          );
          const remainingRight = rightSeats.filter(
            (s, idx) => !fullRows.includes(idx) && getBookingRef(s.code) === ref
          );

          clusterByContiguity(remainingLeft, ref).forEach((cluster, cIdx) => {
            const rects = cluster.map(s => seatRects[s.code]).filter(Boolean);
            if (rects.length === 0) return;
            const minL = Math.min(...rects.map(r => r.left)) - pad;
            const maxR = Math.max(...rects.map(r => r.right)) + pad;
            const minT = Math.min(...rects.map(r => r.top)) - pad;
            const maxB = Math.max(...rects.map(r => r.bottom)) + pad;
            computed.push({
              type: 'rect',
              key: `${ref}-rem-left-${cIdx}`,
              x: minL,
              y: minT,
              w: maxR - minL,
              h: maxB - minT,
              stroke: color.stroke,
              fill: color.fill
            });
          });

          clusterByContiguity(remainingRight, ref).forEach((cluster, cIdx) => {
            const rects = cluster.map(s => seatRects[s.code]).filter(Boolean);
            if (rects.length === 0) return;
            const minL = Math.min(...rects.map(r => r.left)) - pad;
            const maxR = Math.max(...rects.map(r => r.right)) + pad;
            const minT = Math.min(...rects.map(r => r.top)) - pad;
            const maxB = Math.max(...rects.map(r => r.bottom)) + pad;
            computed.push({
              type: 'rect',
              key: `${ref}-rem-right-${cIdx}`,
              x: minL,
              y: minT,
              w: maxR - minL,
              h: maxB - minT,
              stroke: color.stroke,
              fill: color.fill
            });
          });
        } else {
          // Separate sides with contiguity clustering
          clusterByContiguity(leftSeats, ref).forEach((cluster, cIdx) => {
            const rects = cluster.map(s => seatRects[s.code]).filter(Boolean);
            if (rects.length === 0) return;
            const minL = Math.min(...rects.map(r => r.left)) - pad;
            const maxR = Math.max(...rects.map(r => r.right)) + pad;
            const minT = Math.min(...rects.map(r => r.top)) - pad;
            const maxB = Math.max(...rects.map(r => r.bottom)) + pad;
            computed.push({
              type: 'rect',
              key: `${ref}-left-${cIdx}`,
              x: minL,
              y: minT,
              w: maxR - minL,
              h: maxB - minT,
              stroke: color.stroke,
              fill: color.fill
            });
          });

          clusterByContiguity(rightSeats, ref).forEach((cluster, cIdx) => {
            const rects = cluster.map(s => seatRects[s.code]).filter(Boolean);
            if (rects.length === 0) return;
            const minL = Math.min(...rects.map(r => r.left)) - pad;
            const maxR = Math.max(...rects.map(r => r.right)) + pad;
            const minT = Math.min(...rects.map(r => r.top)) - pad;
            const maxB = Math.max(...rects.map(r => r.bottom)) + pad;
            computed.push({
              type: 'rect',
              key: `${ref}-right-${cIdx}`,
              x: minL,
              y: minT,
              w: maxR - minL,
              h: maxB - minT,
              stroke: color.stroke,
              fill: color.fill
            });
          });
        }
      }
    });

    setGroupBoxes(computed);
  }, [seats, table.id, isOneSide, leftSeats, rightSeats, getBookingRef]);

  useEffect(() => {
    updateGroupBoxes();
    const timer = setTimeout(updateGroupBoxes, 50);
    return () => clearTimeout(timer);
  }, [updateGroupBoxes]);

  useEffect(() => {
    if (!containerRef.current) return;
    const ro = new ResizeObserver(() => {
      updateGroupBoxes();
    });
    ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, [updateGroupBoxes]);

  return (
    <div
      id={`table-card-${table.id}`}
      className={`bg-white rounded-2xl border border-sg-line p-4 shadow-xs space-y-3 scroll-mt-20 ${className}`}
    >
      <div className="flex flex-wrap items-center justify-between pb-2 border-b border-sg-line gap-2">
        <div className="flex items-center gap-2 flex-wrap min-w-0">
          {/* Table title button (約 58 行改成按鈕，後面加「›」，點了開第 3 項的整桌面板) */}
          <button
            type="button"
            onClick={() => onTableTitleClick && onTableTitleClick(table)}
            data-testid={`table-title-btn-${table.id}`}
            aria-label={`${table.label} 整桌管理`}
            className="flex items-center gap-1 font-bold text-[16px] text-sg-ink hover:text-sg-brown group transition cursor-pointer select-none"
          >
            <span>{table.label}</span>
            <span className="text-sg-muted group-hover:text-sg-brown text-[16px] leading-none">›</span>
          </button>

          {groupSummary && (
            <span className="text-[13px] font-bold text-sg-brown truncate">
              {groupSummary}
            </span>
          )}
        </div>
        <span className="text-[12px] font-medium text-sg-muted shrink-0">
          {seats.filter(s => s.is_active).length} 個座位
        </span>
      </div>

      {/* Seats container with SVG dashed boundary overlay */}
      <div ref={containerRef} className="relative">
        {/* SVG Overlay for Group Dashed Boxes */}
        <svg
          className="absolute inset-0 pointer-events-none w-full h-full overflow-visible z-0"
          aria-hidden="true"
        >
          {groupBoxes.map((box) => (
            <rect
              key={box.key}
              x={box.x}
              y={box.y}
              width={box.w}
              height={box.h}
              rx="16"
              ry="16"
              fill={box.fill}
              stroke={box.stroke}
              strokeWidth="2"
              strokeDasharray="5,4"
              data-group-box="true"
            />
          ))}
        </svg>

        {isOneSide ? (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 relative z-10">
            {seats.map((seat) => {
              const seatInfo = seatStates[seat.code] || {};
              let state = seatInfo.state || (seat.is_active ? 'empty' : 'off');
              if (selectedSeats.includes(seat.code)) state = 'pick';
              else if (suggestedSeats.includes(seat.code)) state = 'sugg';

              return (
                <div key={seat.code} data-seat-code={seat.code} className="inline-block">
                  <SeatTile
                    code={seat.code}
                    state={state}
                    isVent={seat.priority === 'last'}
                    isPaid={Boolean(seatInfo.isPaid)}
                    boards={seatInfo.boards || []}
                    timerText={seatInfo.timerText}
                    paxName={seatInfo.paxName}
                    onClick={onSeatClick ? () => onSeatClick(seat) : null}
                  />
                </div>
              );
            })}
          </div>
        ) : (
          <div className="grid grid-cols-[1fr_auto_1fr] gap-3 items-center relative z-10">
            {/* Left side (L) */}
            <div className="space-y-2">
              <div className="text-[11px] font-bold text-sg-muted text-center">左側 (L)</div>
              <div className="space-y-2 flex flex-col items-center">
                {leftSeats.map((seat) => {
                  const seatInfo = seatStates[seat.code] || {};
                  let state = seatInfo.state || (seat.is_active ? 'empty' : 'off');
                  if (selectedSeats.includes(seat.code)) state = 'pick';
                  else if (suggestedSeats.includes(seat.code)) state = 'sugg';

                  return (
                    <div key={seat.code} data-seat-code={seat.code} className="inline-block">
                      <SeatTile
                        code={seat.code}
                        state={state}
                        isVent={seat.priority === 'last'}
                        isPaid={Boolean(seatInfo.isPaid)}
                        boards={seatInfo.boards || []}
                        timerText={seatInfo.timerText}
                        paxName={seatInfo.paxName}
                        onClick={onSeatClick ? () => onSeatClick(seat) : null}
                      />
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Center table surface with table label */}
            <div className="flex flex-col items-center justify-center pt-5">
              <div
                data-table-center={table.id}
                className="px-2 py-3 rounded-xl bg-sg-paper/90 border border-sg-line/80 text-sg-brown flex flex-col items-center justify-center shadow-2xs select-none min-h-[46px]"
              >
                <span className="text-[11px] font-bold tracking-wider">{table.label}</span>
              </div>
            </div>

            {/* Right side (R) */}
            <div className="space-y-2">
              <div className="text-[11px] font-bold text-sg-muted text-center">右側 (R)</div>
              <div className="space-y-2 flex flex-col items-center">
                {rightSeats.map((seat) => {
                  const seatInfo = seatStates[seat.code] || {};
                  let state = seatInfo.state || (seat.is_active ? 'empty' : 'off');
                  if (selectedSeats.includes(seat.code)) state = 'pick';
                  else if (suggestedSeats.includes(seat.code)) state = 'sugg';

                  return (
                    <div key={seat.code} data-seat-code={seat.code} className="inline-block">
                      <SeatTile
                        code={seat.code}
                        state={state}
                        isVent={seat.priority === 'last'}
                        isPaid={Boolean(seatInfo.isPaid)}
                        boards={seatInfo.boards || []}
                        timerText={seatInfo.timerText}
                        paxName={seatInfo.paxName}
                        onClick={onSeatClick ? () => onSeatClick(seat) : null}
                      />
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

