import React, { useMemo, useRef, useState, useEffect, useCallback } from 'react';
import SeatTile from './SeatTile';

const GROUP_COLORS = [
  { stroke: '#8C6D58', fill: 'rgba(140, 109, 88, 0.05)' },  // brown
  { stroke: '#4E6B51', fill: 'rgba(78, 107, 81, 0.05)' },   // sage
  { stroke: '#6B8B97', fill: 'rgba(107, 139, 151, 0.05)' }, // vent
  { stroke: '#C98A2C', fill: 'rgba(201, 138, 44, 0.05)' }   // honey
];

// Snap values within tolerance to a canonical list to avoid tiny stair-steps
function snapToExisting(val, refs, tol = 4) {
  for (const r of refs) {
    if (Math.abs(val - r) <= tol) return r;
  }
  return val;
}

// Partition rectangles into connected clusters (overlap or touch within 1px)
function clusterConnectedRects(rects) {
  const clusters = [];
  const visited = new Array(rects.length).fill(false);

  const touches = (a, b) =>
    a.x0 <= b.x1 + 1 &&
    a.x1 >= b.x0 - 1 &&
    a.y0 <= b.y1 + 1 &&
    a.y1 >= b.y0 - 1;

  for (let i = 0; i < rects.length; i++) {
    if (visited[i]) continue;
    visited[i] = true;
    const queue = [i];
    const cluster = [];
    while (queue.length > 0) {
      const idx = queue.shift();
      const cur = rects[idx];
      cluster.push(cur);
      for (let j = 0; j < rects.length; j++) {
        if (!visited[j] && touches(cur, rects[j])) {
          visited[j] = true;
          queue.push(j);
        }
      }
    }
    clusters.push(cluster);
  }
  return clusters;
}

// Trace the outer orthogonal contour(s) of a union of rectangles and convert to a rounded SVG path
function rectsToRoundedPath(rects, radius = 16) {
  if (!rects || rects.length === 0) return '';

  const roundCoord = v => Math.round(v * 2) / 2;
  const xs = [...new Set(rects.flatMap(r => [roundCoord(r.x0), roundCoord(r.x1)]))].sort((a, b) => a - b);
  const ys = [...new Set(rects.flatMap(r => [roundCoord(r.y0), roundCoord(r.y1)]))].sort((a, b) => a - b);

  const nx = xs.length - 1;
  const ny = ys.length - 1;
  if (nx <= 0 || ny <= 0) return '';

  const filled = Array.from({ length: ny }, (_, iy) =>
    Array.from({ length: nx }, (__, ix) => {
      const cx = (xs[ix] + xs[ix + 1]) / 2;
      const cy = (ys[iy] + ys[iy + 1]) / 2;
      return rects.some(r => cx > r.x0 && cx < r.x1 && cy > r.y0 && cy < r.y1);
    })
  );

  // Directed edges: { x0, y0, x1, y1, dir } (dir: 0=R, 1=D, 2=L, 3=U)
  const edges = [];
  const outByVertex = new Map();
  const addEdge = (ix0, iy0, ix1, iy1, dir) => {
    const idx = edges.length;
    edges.push({ ix0, iy0, ix1, iy1, dir });
    const key = `${ix0},${iy0}`;
    if (!outByVertex.has(key)) outByVertex.set(key, []);
    outByVertex.get(key).push(idx);
  };

  for (let iy = 0; iy < ny; iy++) {
    for (let ix = 0; ix < nx; ix++) {
      if (!filled[iy][ix]) continue;
      if (iy === 0 || !filled[iy - 1][ix]) addEdge(ix, iy, ix + 1, iy, 0);
      if (ix === nx - 1 || !filled[iy][ix + 1]) addEdge(ix + 1, iy, ix + 1, iy + 1, 1);
      if (iy === ny - 1 || !filled[iy + 1][ix]) addEdge(ix + 1, iy + 1, ix, iy + 1, 2);
      if (ix === 0 || !filled[iy][ix - 1]) addEdge(ix, iy + 1, ix, iy, 3);
    }
  }

  const used = new Array(edges.length).fill(false);
  const loops = [];

  for (let startIdx = 0; startIdx < edges.length; startIdx++) {
    if (used[startIdx]) continue;
    const rawPts = [];
    let curIdx = startIdx;

    while (curIdx !== -1 && !used[curIdx]) {
      used[curIdx] = true;
      const e = edges[curIdx];
      rawPts.push({ x: xs[e.ix0], y: ys[e.iy0] });

      const nextKey = `${e.ix1},${e.iy1}`;
      const candidates = (outByVertex.get(nextKey) || []).filter(idx => !used[idx]);
      if (candidates.length === 0) break;

      // Prefer turning right (keeps loops non-crossing if touching diagonally)
      const prefOrder = [(e.dir + 1) % 4, e.dir, (e.dir + 3) % 4, (e.dir + 2) % 4];
      candidates.sort((a, b) => prefOrder.indexOf(edges[a].dir) - prefOrder.indexOf(edges[b].dir));
      curIdx = candidates[0];
    }

    if (rawPts.length < 3) continue;

    // Remove collinear points
    const pts = rawPts.filter((p, i) => {
      const prev = rawPts[(i - 1 + rawPts.length) % rawPts.length];
      const next = rawPts[(i + 1) % rawPts.length];
      const cross = (p.x - prev.x) * (next.y - p.y) - (p.y - prev.y) * (next.x - p.x);
      return cross !== 0;
    });

    if (pts.length < 3) continue;

    // Build rounded orthogonal SVG path using quadratic Bezier corners
    const k = pts.length;
    const segments = [];
    for (let i = 0; i < k; i++) {
      const prev = pts[(i - 1 + k) % k];
      const curr = pts[i];
      const next = pts[(i + 1) % k];

      const dx1 = curr.x - prev.x;
      const dy1 = curr.y - prev.y;
      const dIn = Math.hypot(dx1, dy1);
      const dx2 = next.x - curr.x;
      const dy2 = next.y - curr.y;
      const dOut = Math.hypot(dx2, dy2);

      const r = Math.min(radius, dIn / 2, dOut / 2);
      const ax = curr.x - (dx1 / dIn) * r;
      const ay = curr.y - (dy1 / dIn) * r;
      const bx = curr.x + (dx2 / dOut) * r;
      const by = curr.y + (dy2 / dOut) * r;

      segments.push(`${i === 0 ? 'M' : 'L'} ${ax} ${ay}`);
      segments.push(`Q ${curr.x} ${curr.y} ${bx} ${by}`);
    }
    segments.push('Z');
    loops.push(segments.join(' '));
  }

  return loops.join(' ');
}

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

  const tableStatusBadge = useMemo(() => {
    const states = seats.map(s => seatStates[s.code]?.state).filter(Boolean);
    if (states.includes('over') || states.includes('overtime')) {
      return { label: '超時', cls: 'bg-sg-danger-soft text-sg-danger' };
    }
    if (states.includes('warn') || states.includes('expiring')) {
      return { label: '快到時', cls: 'bg-sg-honey-soft text-sg-honey-ink' };
    }
    if (states.includes('in_use') || states.includes('run')) {
      return { label: '計時中', cls: 'bg-sg-sage-soft text-sg-sage-ink' };
    }
    if (states.includes('paused') || states.includes('pause')) {
      return { label: '已暫停', cls: 'bg-sg-vent/15 text-sg-vent' };
    }
    if (states.includes('reserved') || states.includes('resv') || states.includes('pending')) {
      return { label: '待入座', cls: 'bg-white text-sg-brown border border-sg-brown/50' };
    }
    return null;
  }, [seats, seatStates]);

  const renderCardSeat = (seat) => {
    const seatInfo = seatStates[seat.code] || {};
    let state = seatInfo.state || (seat.is_active ? 'empty' : 'off');
    if (selectedSeats.includes(seat.code)) state = 'pick';
    else if (suggestedSeats.includes(seat.code)) state = 'sugg';

    return (
      <div key={seat.code} data-seat-code={seat.code} className="w-full">
        <SeatTile
          variant="card"
          code={seat.code}
          state={state}
          isVent={seat.priority === 'last'}
          isPaid={Boolean(seatInfo.isPaid)}
          boards={seatInfo.boards || []}
          boardPauseAlert={Boolean(seatInfo.boardPauseAlert)}
          timerText={seatInfo.timerText}
          paxName={seatInfo.paxName}
          onClick={onSeatClick ? () => onSeatClick(seat) : null}
        />
      </div>
    );
  };

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

    const pushMergedGroupShapes = (ref, rects, color) => {
      if (!rects || rects.length === 0) return;
      const clusters = clusterConnectedRects(rects);
      clusters.forEach((cluster, cIdx) => {
        const d = rectsToRoundedPath(cluster, 16);
        if (!d) return;
        computed.push({
          key: `${ref}-shape-${cIdx}`,
          d,
          stroke: color.stroke,
          fill: color.fill
        });
      });
    };

    // Precompute grid tracks for isOneSide
    let oneSideGrid = null;
    if (isOneSide) {
      const measured = seats.filter(s => seatRects[s.code]);
      const clusterTracks = (vals, tol = 12) => {
        const sorted = [...vals].sort((a, b) => a - b);
        const tracks = [];
        for (const v of sorted) {
          if (tracks.length === 0 || v - tracks[tracks.length - 1] > tol) {
            tracks.push(v);
          }
        }
        return tracks;
      };
      const rowAnchors = clusterTracks(measured.map(s => seatRects[s.code].top));
      const colAnchors = clusterTracks(measured.map(s => seatRects[s.code].left));

      const findTrack = (val, anchors) => {
        let best = 0;
        let bestDiff = Infinity;
        anchors.forEach((a, idx) => {
          const diff = Math.abs(val - a);
          if (diff < bestDiff) {
            bestDiff = diff;
            best = idx;
          }
        });
        return best;
      };

      const rowBounds = rowAnchors.map(() => ({ top: Infinity, bottom: -Infinity }));
      const colBounds = colAnchors.map(() => ({ left: Infinity, right: -Infinity }));
      const cellOf = {};

      for (const s of measured) {
        const rRect = seatRects[s.code];
        const r = findTrack(rRect.top, rowAnchors);
        const c = findTrack(rRect.left, colAnchors);
        cellOf[s.code] = { r, c };
        rowBounds[r].top = Math.min(rowBounds[r].top, rRect.top);
        rowBounds[r].bottom = Math.max(rowBounds[r].bottom, rRect.bottom);
        colBounds[c].left = Math.min(colBounds[c].left, rRect.left);
        colBounds[c].right = Math.max(colBounds[c].right, rRect.right);
      }

      oneSideGrid = { rowBounds, colBounds, cellOf };
    }

    distinctRefs.forEach((ref, groupIdx) => {
      const color = GROUP_COLORS[groupIdx % GROUP_COLORS.length];
      const gSeats = seats.filter(s => getBookingRef(s.code) === ref && seatRects[s.code]);
      if (gSeats.length === 0) return;

      const groupRects = [];

      if (isOneSide && oneSideGrid) {
        const { rowBounds, colBounds, cellOf } = oneSideGrid;
        const cellKeys = new Set();
        const gCells = [];
        for (const s of gSeats) {
          const cell = cellOf[s.code];
          if (!cell) continue;
          const key = `${cell.r},${cell.c}`;
          if (!cellKeys.has(key)) {
            cellKeys.add(key);
            gCells.push(cell);
          }
        }
        const hasCell = (r, c) => cellKeys.has(`${r},${c}`);

        for (const { r, c } of gCells) {
          const rb = rowBounds[r];
          const cb = colBounds[c];
          groupRects.push({
            x0: cb.left - pad,
            y0: rb.top - pad,
            x1: cb.right + pad,
            y1: rb.bottom + pad
          });

          // Horizontal bridge to adjacent right neighbor
          if (hasCell(r, c + 1)) {
            const cbNext = colBounds[c + 1];
            groupRects.push({
              x0: cb.right,
              y0: rb.top - pad,
              x1: cbNext.left,
              y1: rb.bottom + pad
            });
          }

          // Vertical bridge to adjacent bottom neighbor
          if (hasCell(r + 1, c)) {
            const rbNext = rowBounds[r + 1];
            groupRects.push({
              x0: cb.left - pad,
              y0: rb.bottom,
              x1: cb.right + pad,
              y1: rbNext.top
            });
          }

          // Fill 2x2 center intersection if all 4 surrounding cells belong to this group
          if (hasCell(r, c + 1) && hasCell(r + 1, c) && hasCell(r + 1, c + 1)) {
            const cbNext = colBounds[c + 1];
            const rbNext = rowBounds[r + 1];
            groupRects.push({
              x0: cb.right,
              y0: rb.bottom,
              x1: cbNext.left,
              y1: rbNext.top
            });
          }
        }
      } else {
        // Two-sided table
        const isMajority = gSeats.length > totalActive / 2;
        const allLeft = leftSeats.length > 0 && leftSeats.every(s => getBookingRef(s.code) === ref);
        const allRight = rightSeats.length > 0 && rightSeats.every(s => getBookingRef(s.code) === ref);
        const wrapTableLabel = isMajority && (allLeft || allRight);

        const maxR = Math.max(leftSeats.length, rightSeats.length);
        const fullRows = [];
        const rowBounds = [];
        for (let r = 0; r < maxR; r++) {
          const lS = leftSeats[r];
          const rS = rightSeats[r];
          if (lS && rS && getBookingRef(lS.code) === ref && getBookingRef(rS.code) === ref) {
            fullRows.push(r);
          }
          const rRects = [lS && seatRects[lS.code], rS && seatRects[rS.code]].filter(Boolean);
          rowBounds.push(
            rRects.length > 0
              ? {
                  top: Math.min(...rRects.map(x => x.top)),
                  bottom: Math.max(...rRects.map(x => x.bottom))
                }
              : null
          );
        }

        const measuredLeft = leftSeats.map(s => seatRects[s.code]).filter(Boolean);
        const measuredRight = rightSeats.map(s => seatRects[s.code]).filter(Boolean);
        const leftCol =
          measuredLeft.length > 0
            ? {
                left: Math.min(...measuredLeft.map(x => x.left)),
                right: Math.max(...measuredLeft.map(x => x.right))
              }
            : null;
        const rightCol =
          measuredRight.length > 0
            ? {
                left: Math.min(...measuredRight.map(x => x.left)),
                right: Math.max(...measuredRight.map(x => x.right))
              }
            : null;

        if (wrapTableLabel && (gSeats.length === totalActive || (allLeft && allRight))) {
          // Whole table enclosed including center badge
          const allRects = [...gSeats.map(s => seatRects[s.code]), centerRect].filter(Boolean);
          groupRects.push({
            x0: Math.min(...allRects.map(r => r.left)) - pad,
            y0: Math.min(...allRects.map(r => r.top)) - pad,
            x1: Math.max(...allRects.map(r => r.right)) + pad,
            y1: Math.max(...allRects.map(r => r.bottom)) + pad
          });
        } else {
          // Left side seats and vertical adjacency bridges
          if (leftCol) {
            for (let r = 0; r < leftSeats.length; r++) {
              const s = leftSeats[r];
              const rb = rowBounds[r];
              if (!rb || !seatRects[s.code] || getBookingRef(s.code) !== ref) continue;
              groupRects.push({
                x0: leftCol.left - pad,
                y0: rb.top - pad,
                x1: leftCol.right + pad,
                y1: rb.bottom + pad
              });
              if (
                r + 1 < leftSeats.length &&
                rowBounds[r + 1] &&
                seatRects[leftSeats[r + 1].code] &&
                getBookingRef(leftSeats[r + 1].code) === ref
              ) {
                groupRects.push({
                  x0: leftCol.left - pad,
                  y0: rb.bottom,
                  x1: leftCol.right + pad,
                  y1: rowBounds[r + 1].top
                });
              }
            }
          }

          // Right side seats and vertical adjacency bridges
          if (rightCol) {
            for (let r = 0; r < rightSeats.length; r++) {
              const s = rightSeats[r];
              const rb = rowBounds[r];
              if (!rb || !seatRects[s.code] || getBookingRef(s.code) !== ref) continue;
              groupRects.push({
                x0: rightCol.left - pad,
                y0: rb.top - pad,
                x1: rightCol.right + pad,
                y1: rb.bottom + pad
              });
              if (
                r + 1 < rightSeats.length &&
                rowBounds[r + 1] &&
                seatRects[rightSeats[r + 1].code] &&
                getBookingRef(rightSeats[r + 1].code) === ref
              ) {
                groupRects.push({
                  x0: rightCol.left - pad,
                  y0: rb.bottom,
                  x1: rightCol.right + pad,
                  y1: rowBounds[r + 1].top
                });
              }
            }
          }

          // Rule: 某一排兩面都是同一組，框就穿過中間桌號那一排連起來
          if (leftCol && rightCol) {
            fullRows.forEach((r) => {
              const rb = rowBounds[r];
              if (!rb) return;
              groupRects.push({
                x0: leftCol.right,
                y0: rb.top - pad,
                x1: rightCol.left,
                y1: rb.bottom + pad
              });
              if (fullRows.includes(r + 1) && rowBounds[r + 1]) {
                groupRects.push({
                  x0: leftCol.right,
                  y0: rb.bottom,
                  x1: rightCol.left,
                  y1: rowBounds[r + 1].top
                });
              }
            });
          }

          // Rule: 超過一半且包下一側全部時，將桌號納入同一外圍輪廓
          if (wrapTableLabel && centerRect) {
            const rowTopRefs = rowBounds.filter(Boolean).map(rb => rb.top - pad);
            const rowBottomRefs = rowBounds.filter(Boolean).map(rb => rb.bottom + pad);
            const cTop = snapToExisting(centerRect.top - pad, rowTopRefs, 5);
            const cBottom = snapToExisting(centerRect.bottom + pad, rowBottomRefs, 5);
            const cLeft = centerRect.left - pad;
            const cRight = centerRect.right + pad;

            groupRects.push({ x0: cLeft, y0: cTop, x1: cRight, y1: cBottom });

            if (allLeft && leftCol) {
              groupRects.push({ x0: leftCol.right, y0: cTop, x1: cLeft + 1, y1: cBottom });
            }
            if (allRight && rightCol) {
              groupRects.push({ x0: cRight - 1, y0: cTop, x1: rightCol.left, y1: cBottom });
            }
          }
        }
      }

      pushMergedGroupShapes(ref, groupRects, color);
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
      className={`bg-white/65 rounded-2xl border border-sg-line/60 p-3 space-y-2.5 scroll-mt-20 ${className}`}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <button
            type="button"
            onClick={() => onTableTitleClick && onTableTitleClick(table)}
            data-testid={`table-title-btn-${table.id}`}
            aria-label={`${table.label} 整桌管理`}
            className="flex items-center gap-0.5 font-bold text-[15px] text-sg-ink hover:text-sg-brown group transition cursor-pointer select-none shrink-0"
          >
            <span>{table.label}</span>
            <span className="text-sg-muted group-hover:text-sg-brown text-[15px] leading-none">›</span>
          </button>

          {groupSummary && (
            <span className="text-[12px] font-medium text-sg-muted truncate">
              {groupSummary}
            </span>
          )}
        </div>
        {tableStatusBadge ? (
          <span className={`text-[11px] font-bold px-2.5 py-0.5 rounded-full shrink-0 ${tableStatusBadge.cls}`}>
            {tableStatusBadge.label}
          </span>
        ) : (
          <span className="text-[11px] font-medium text-sg-muted shrink-0">
            {seats.filter(s => s.is_active).length} 個座位
          </span>
        )}
      </div>

      {/* Seats container with SVG dashed boundary overlay */}
      <div ref={containerRef} className="relative">
        {/* SVG Overlay for Group Dashed Boxes */}
        <svg
          className="absolute inset-0 pointer-events-none w-full h-full overflow-visible z-0"
          aria-hidden="true"
        >
          {groupBoxes.map((box) => (
            <path
              key={box.key}
              d={box.d}
              fillRule="evenodd"
              fill={box.fill}
              stroke={box.stroke}
              strokeWidth="2"
              strokeDasharray="5,4"
              strokeLinejoin="round"
              data-group-box="true"
            />
          ))}
        </svg>

        {isOneSide ? (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 relative z-10">
            {seats.map(renderCardSeat)}
          </div>
        ) : (
          <div className="grid grid-cols-[minmax(0,1fr)_28px_minmax(0,1fr)] gap-2 items-stretch relative z-10">
            {/* Left side (L) */}
            <div className="space-y-2 flex flex-col">
              {leftSeats.map(renderCardSeat)}
            </div>

            {/* Center table surface bar */}
            <div className="flex items-stretch justify-center">
              <div
                data-table-center={table.id}
                className="w-7 rounded-xl bg-[#EAE0D5] border border-[#D8CBB9] text-sg-brown flex items-center justify-center shadow-2xs select-none py-2"
              >
                <span
                  className="text-[11px] font-bold tracking-wider whitespace-nowrap"
                  style={{ writingMode: 'vertical-rl' }}
                >
                  {table.label}
                </span>
              </div>
            </div>

            {/* Right side (R) */}
            <div className="space-y-2 flex flex-col">
              {rightSeats.map(renderCardSeat)}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

