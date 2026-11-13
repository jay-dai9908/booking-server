import React, { useRef, useState, useEffect, useMemo, useCallback } from 'react';
import SeatTile from './SeatTile';

export default function FloorPlan({
  layout = {},
  seatStates = {}, // { [seatCode]: { state, isPaid, timerText, paxName, boards, bookingRef } }
  selectedSeats = [],
  suggestedSeats = [],
  onSeatClick = null,
  interactive = true,
  scale = 1,
  fitContainer = false,
  className = '',
  filterMode = 'all', // 'all' | 'alert' | 'pending' | 'empty'
  alerts = [],
  size = 'full' // 'full' (58×46) | 'mini' (24×16)
}) {
  const containerRef = useRef(null);
  const [containerWidth, setContainerWidth] = useState(0);

  // Zoom & Pan state (Spec 6.4.1: 0.6 ~ 2.5x)
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });

  const activePointersRef = useRef(new Map());
  const initialPinchDistRef = useRef(null);
  const initialZoomRef = useRef(1);
  const dragStartRef = useRef({ x: 0, y: 0 });
  const isDraggingRef = useRef(false);
  const dragDistanceRef = useRef(0);

  useEffect(() => {
    if (!fitContainer || !containerRef.current) return;
    const updateW = () => {
      if (containerRef.current) {
        setContainerWidth(containerRef.current.clientWidth);
      }
    };
    updateW();
    const ro = new ResizeObserver(updateW);
    ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, [fitContainer]);

  const canvasW = layout.canvas_w || 1000;
  const canvasH = layout.canvas_h || 625;
  const tables = layout.tables || [];
  const seats = layout.seats || [];
  const elements = layout.elements_json || layout.elements || [];
  const bgImg = layout.background_image || layout.bg_image_url;
  const bgOpacity = (layout.background_opacity ?? layout.bg_opacity ?? 30) / 100;
  const bgRect = layout.background_rect || { x: 0, y: 0, w: canvasW, h: canvasH };

  // Calculate seat center positions in canvas coordinates
  const seatCenters = useMemo(() => {
    return seats.map(seat => {
      const table = tables.find(t => t.id === seat.table_id);
      const tRot = (table?.rotation || 0) * (Math.PI / 180);
      const lx = seat.lx || 0;
      const ly = seat.ly || 0;
      const cos = Math.cos(tRot);
      const sin = Math.sin(tRot);
      const rotLx = lx * cos - ly * sin;
      const rotLy = lx * sin + ly * cos;
      const rawCx = (table?.cx || 0) + rotLx;
      const rawCy = (table?.cy || 0) + rotLy;
      return {
        seat,
        code: seat.code,
        x: rawCx,
        y: rawCy
      };
    });
  }, [seats, tables]);

  // Find minimum distance between any two seat centers in canvas coordinates
  const minDistCanvas = useMemo(() => {
    if (seatCenters.length < 2) return null;
    let min = Infinity;
    for (let i = 0; i < seatCenters.length; i++) {
      for (let j = i + 1; j < seatCenters.length; j++) {
        const d = Math.hypot(seatCenters[i].x - seatCenters[j].x, seatCenters[i].y - seatCenters[j].y);
        if (d > 0.001 && d < min) {
          min = d;
        }
      }
    }
    return min === Infinity ? null : min;
  }, [seatCenters]);

  // Round 13b Item 2:
  // 預設縮放 k 取「塞進寬度」和「最近兩個座位中心距離 ≥ 50px」兩者中比較大的那個
  const kFit = (fitContainer && containerWidth > 0)
    ? (containerWidth / canvasW)
    : (scale || 1);
  const kMinDist = minDistCanvas ? (50 / minDistCanvas) : 0;
  const baseK = Math.max(kFit, kMinDist);

  // Total coordinate scale k: baseK * zoom
  const k = baseK * zoom;

  // Center pan calculation: centers the occupied area (or all seats)
  const getCenteredPan = useCallback((targetZoom = 1) => {
    const targetK = baseK * targetZoom;
    const viewW = containerWidth > 0 ? containerWidth : canvasW * targetK;
    const viewH = canvasH * baseK;

    const occupied = seatCenters.filter(sc => {
      const info = seatStates[sc.code];
      if (!info) return false;
      return (
        info.state === 'in_use' ||
        info.state === 'run' ||
        info.state === 'warn' ||
        info.state === 'over' ||
        info.state === 'paused' ||
        info.state === 'reserved' ||
        info.state === 'resv' ||
        Boolean(info.paxName)
      );
    });

    const targets = occupied.length > 0 ? occupied : (seatCenters.length > 0 ? seatCenters : [{ x: canvasW / 2, y: canvasH / 2 }]);
    const minX = Math.min(...targets.map(p => p.x));
    const maxX = Math.max(...targets.map(p => p.x));
    const minY = Math.min(...targets.map(p => p.y));
    const maxY = Math.max(...targets.map(p => p.y));
    const targetCenterX = (minX + maxX) / 2;
    const targetCenterY = (minY + maxY) / 2;

    const panX = (viewW / 2) - targetCenterX * targetK;
    const panY = (viewH / 2) - targetCenterY * targetK;

    return { x: panX, y: panY };
  }, [baseK, containerWidth, canvasW, canvasH, seatCenters, seatStates]);

  // Initial centering when container width is first measured
  const initialCenteredRef = useRef(false);
  useEffect(() => {
    if (containerWidth > 0 && !initialCenteredRef.current) {
      initialCenteredRef.current = true;
      setPan(getCenteredPan(1));
    }
  }, [containerWidth, getCenteredPan]);

  // Pointer event handlers for pinch zoom & drag pan
  const handlePointerDown = (e) => {
    activePointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    dragDistanceRef.current = 0;

    if (activePointersRef.current.size === 1) {
      isDraggingRef.current = true;
      dragStartRef.current = {
        x: e.clientX - pan.x,
        y: e.clientY - pan.y
      };
    } else if (activePointersRef.current.size === 2) {
      isDraggingRef.current = false;
      const pts = Array.from(activePointersRef.current.values());
      initialPinchDistRef.current = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      initialZoomRef.current = zoom;
    }
  };

  const handlePointerMove = (e) => {
    if (!activePointersRef.current.has(e.pointerId)) return;
    const prevPt = activePointersRef.current.get(e.pointerId);
    if (prevPt) {
      dragDistanceRef.current += Math.hypot(e.clientX - prevPt.x, e.clientY - prevPt.y);
    }
    activePointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (activePointersRef.current.size === 2 && initialPinchDistRef.current) {
      const pts = Array.from(activePointersRef.current.values());
      const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      const ratio = dist / initialPinchDistRef.current;
      const newZoom = Math.min(2.5, Math.max(0.6, initialZoomRef.current * ratio));
      setZoom(newZoom);
    } else if (activePointersRef.current.size === 1 && isDraggingRef.current) {
      setPan({
        x: e.clientX - dragStartRef.current.x,
        y: e.clientY - dragStartRef.current.y
      });
    }
  };

  const handlePointerUp = (e) => {
    activePointersRef.current.delete(e.pointerId);
    if (activePointersRef.current.size < 2) {
      initialPinchDistRef.current = null;
    }
    if (activePointersRef.current.size === 1) {
      const [remaining] = Array.from(activePointersRef.current.values());
      dragStartRef.current = {
        x: remaining.x - pan.x,
        y: remaining.y - pan.y
      };
      isDraggingRef.current = true;
    } else {
      isDraggingRef.current = false;
    }
  };

  const handleWheel = (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) {
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.08 : 0.92;
      setZoom(prev => Math.min(2.5, Math.max(0.6, prev * factor)));
    }
  };

  // Center / Reset zoom and pan (Round 13b Item 2: 置中回到預設縮放，並把有人的區域置中)
  const handleResetCenter = (e) => {
    e.stopPropagation();
    setZoom(1);
    setPan(getCenteredPan(1));
  };

  // Round 13b Item 2: 縮小到格子會重疊時，座位格自動改用 demo 尺寸（48×33，只顯示代號和名字）
  const hasTileOverlap = useMemo(() => {
    for (let i = 0; i < seatCenters.length; i++) {
      for (let j = i + 1; j < seatCenters.length; j++) {
        const dx = Math.abs(seatCenters[i].x - seatCenters[j].x) * k;
        const dy = Math.abs(seatCenters[i].y - seatCenters[j].y) * k;
        if (dx < 58 && dy < 46) {
          return true;
        }
      }
    }
    return false;
  }, [seatCenters, k]);

  const effectiveSize = (size === 'mini' || size === 'map')
    ? size
    : (hasTileOverlap ? 'demo' : size);

  // Filter alert bookings
  const alertBookingRefs = new Set((alerts || []).map(a => a.booking_ref));

  return (
    <div
      ref={containerRef}
      data-testid="floor-plan-container"
      data-zoom={zoom}
      className={`relative overflow-hidden bg-[#FAF7F2] border border-sg-line rounded-2xl select-none ${className}`}
      style={{
        width: fitContainer ? '100%' : canvasW * baseK,
        height: canvasH * baseK,
        minHeight: canvasH * baseK,
        touchAction: 'none'
      }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      onWheel={handleWheel}
    >
      {/* Reset Center Button (Spec 6.4.1) */}
      <button
        type="button"
        data-testid="floor-plan-center-btn"
        onClick={handleResetCenter}
        className="absolute bottom-3 right-3 z-30 px-3 py-1.5 rounded-xl bg-white/95 border border-sg-line shadow-xs text-[12px] font-bold text-sg-ink hover:bg-white active:scale-95 transition cursor-pointer"
      >
        置中
      </button>

      {/* Layer 1: Background photo if any */}
      {bgImg && (
        <img
          src={bgImg}
          alt="底圖"
          className="absolute pointer-events-none object-cover"
          style={{
            left: bgRect.x * k + pan.x,
            top: bgRect.y * k + pan.y,
            width: (bgRect.w ?? canvasW) * k,
            height: (bgRect.h ?? canvasH) * k,
            opacity: bgOpacity
          }}
        />
      )}

      {/* Layer 2: Bottom SVG Layer (scales with k, viewBox 0 0 canvasW canvasH) */}
      <svg
        className="absolute pointer-events-none"
        style={{
          left: pan.x,
          top: pan.y,
          width: canvasW * k,
          height: canvasH * k
        }}
        viewBox={`0 0 ${canvasW} ${canvasH}`}
      >
        {/* Architectural elements (walls, windows, doors, counters, pillars) */}
        {elements.map((el, idx) => {
          if (el.type === 'wall') {
            if (el.points && el.points.length > 1) {
              return (
                <polyline
                  key={el.id || idx}
                  points={el.points.map(p => p.join(',')).join(' ')}
                  stroke="#796E65"
                  strokeWidth={el.thickness || 4}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  fill="none"
                />
              );
            }
            return (
              <line
                key={el.id || idx}
                x1={el.x1}
                y1={el.y1}
                x2={el.x2}
                y2={el.y2}
                stroke="#796E65"
                strokeWidth={el.thickness || 4}
                strokeLinecap="round"
              />
            );
          }
          if (el.type === 'window') {
            if (el.points && el.points.length > 1) {
              return (
                <polyline
                  key={el.id || idx}
                  points={el.points.map(p => p.join(',')).join(' ')}
                  stroke="#78B5C5"
                  strokeWidth={el.thickness || 3}
                  strokeDasharray="6,3"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  fill="none"
                />
              );
            }
          }
          if (el.type === 'door') {
            return (
              <rect
                key={el.id || idx}
                x={el.x}
                y={el.y}
                width={el.w}
                height={el.h}
                fill="#FBF6EE"
                stroke="#A78B71"
                strokeWidth="2"
                strokeDasharray="4,2"
                rx="2"
                transform={el.rotation ? `rotate(${el.rotation} ${el.x + el.w / 2} ${el.y + el.h / 2})` : undefined}
              />
            );
          }
          if (el.type === 'counter') {
            return (
              <rect
                key={el.id || idx}
                x={el.x}
                y={el.y}
                width={el.w}
                height={el.h}
                fill="#E5DDD0"
                stroke="#C8BEB2"
                strokeWidth="2"
                rx="6"
                transform={el.rotation ? `rotate(${el.rotation} ${el.x + el.w / 2} ${el.y + el.h / 2})` : undefined}
              />
            );
          }
          if (el.type === 'pillar') {
            return (
              <rect
                key={el.id || idx}
                x={el.x}
                y={el.y}
                width={el.w}
                height={el.h}
                fill="#796E65"
                rx="4"
                transform={el.rotation ? `rotate(${el.rotation} ${el.x + el.w / 2} ${el.y + el.h / 2})` : undefined}
              />
            );
          }
          return null;
        })}

        {/* Tables drawn in SVG (Spec 6.4.1) */}
        {tables.map((t) => {
          const isCircle = t.shape === 'circle' || t.shape === 'round';
          const rotCenter = `${t.cx} ${t.cy}`;
          return (
            <g key={t.id} transform={t.rotation ? `rotate(${t.rotation} ${rotCenter})` : undefined}>
              {isCircle ? (
                <circle
                  cx={t.cx}
                  cy={t.cy}
                  r={Math.min(t.w, t.h) / 2}
                  fill="#EADDCF"
                  stroke="#C8BEB2"
                  strokeWidth="1.5"
                />
              ) : (
                <rect
                  x={t.cx - t.w / 2}
                  y={t.cy - t.h / 2}
                  width={t.w}
                  height={t.h}
                  rx={t.rx ?? 12}
                  fill="#EADDCF"
                  stroke="#C8BEB2"
                  strokeWidth="1.5"
                />
              )}
              <text
                x={t.cx}
                y={t.cy}
                textAnchor="middle"
                dominantBaseline="central"
                fill="#796E65"
                fontSize="12"
                fontWeight="bold"
                style={{ userSelect: 'none' }}
              >
                {t.label}
              </text>
            </g>
          );
        })}
      </svg>

      {/* Layer 3: Absolute HTML Seats Layer (fixed size, position = coord * k + pan) */}
      <div className="absolute inset-0 pointer-events-none">
        {seats.map((seat) => {
          const table = tables.find(t => t.id === seat.table_id);
          const tRot = (table?.rotation || 0) * (Math.PI / 180);

          const lx = seat.lx || 0;
          const ly = seat.ly || 0;
          const cos = Math.cos(tRot);
          const sin = Math.sin(tRot);
          const rotLx = lx * cos - ly * sin;
          const rotLy = lx * sin + ly * cos;

          const rawCx = (table?.cx || 0) + rotLx;
          const rawCy = (table?.cy || 0) + rotLy;

          // Seat position in pixels
          const seatX = rawCx * k + pan.x;
          const seatY = rawCy * k + pan.y;

          // Seat state
          const seatInfo = seatStates[seat.code] || {};
          let state = seatInfo.state || (seat.is_active ? 'empty' : 'off');
          if (selectedSeats.includes(seat.code)) {
            state = 'pick';
          } else if (suggestedSeats.includes(seat.code)) {
            state = 'sugg';
          }

          const isVent = seat.priority === 'last';

          // Filter opacity check (Spec: 篩選 chip 選了「需要注意」「待入座」「空位」時，不符合的座位加 opacity: .35)
          let isDimmed = false;
          if (filterMode === 'alert') {
            isDimmed = !alertBookingRefs.has(seatInfo.bookingRef);
          } else if (filterMode === 'pending') {
            isDimmed = state !== 'reserved' && state !== 'resv';
          } else if (filterMode === 'empty') {
            isDimmed = state !== 'empty' || seat.is_active === false;
          }

          return (
            <div
              key={seat.id || seat.code}
              className="absolute pointer-events-auto transition-opacity duration-150"
              style={{
                left: seatX,
                top: seatY,
                transform: 'translate(-50%, -50%)',
                opacity: isDimmed ? 0.35 : 1
              }}
            >
              <SeatTile
                code={seat.code}
                state={state}
                size={effectiveSize}
                isVent={isVent}
                isPaid={Boolean(seatInfo.isPaid)}
                boards={seatInfo.boards || []}
                boardPauseAlert={Boolean(seatInfo.boardPauseAlert)}
                timerText={seatInfo.timerText}
                paxName={seatInfo.paxName}
                onClick={
                  interactive && onSeatClick
                    ? () => {
                        // Prevent click firing if user was actively dragging/panning
                        if (dragDistanceRef.current < 6) {
                          onSeatClick(seat);
                        }
                      }
                    : null
                }
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}
