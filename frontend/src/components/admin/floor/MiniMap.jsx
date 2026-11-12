import React, { useRef, useState, useEffect, useMemo, useCallback } from 'react';
import { ZoomOut } from 'lucide-react';

const STATE_COLORS = {
  in_use: '#4E6B51',   // 計時中 (sage green)
  warn: '#C98A2C',     // 快到時 (honey)
  over: '#B43A3A',     // 超時 (danger red)
  paused: '#6B8B97',   // 暫停 (vent blue)
  reserved: '#8C6D58', // 已預約 (brown)
  empty: '#D1C7BD'     // 空位 (neutral)
};

const LEGEND_ITEMS = [
  { key: 'empty', label: '空位', color: STATE_COLORS.empty },
  { key: 'in_use', label: '計時中', color: STATE_COLORS.in_use },
  { key: 'warn', label: '快到時', color: STATE_COLORS.warn },
  { key: 'over', label: '超時', color: STATE_COLORS.over },
  { key: 'paused', label: '暫停', color: STATE_COLORS.paused },
  { key: 'reserved', label: '已預約', color: STATE_COLORS.reserved }
];

export default function MiniMap({
  layout = {},
  seatStates = {},
  activeTableId = null,
  onTableClick = null,
  waitingPaxCount = 0,
  waitPax = null,
  className = ''
}) {
  const effectiveWaitPax = waitPax != null ? waitPax : waitingPaxCount;
  const containerRef = useRef(null);
  const [containerW, setContainerW] = useState(360);

  const canvasW = layout.canvas_w || 1000;
  const canvasH = layout.canvas_h || 625;
  const tables = useMemo(() => layout.tables || [], [layout.tables]);
  const seats = useMemo(() => layout.seats || [], [layout.seats]);

  // Legend filter state: null | 'in_use' | 'warn' | 'over' | 'paused' | 'reserved' | 'empty'
  const [activeFilter, setActiveFilter] = useState(null);

  // Zoom / Viewport state for > 8 tables
  const [zoomedTableId, setZoomedTableId] = useState(null);
  const [viewport, setViewport] = useState(null); // { x, y, w, h }

  useEffect(() => {
    if (!containerRef.current) return;
    const updateWidth = () => {
      if (containerRef.current) {
        setContainerW(containerRef.current.clientWidth || 360);
      }
    };
    updateWidth();
    const ro = new ResizeObserver(updateWidth);
    ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, []);

  const availableH = 92;
  const availableW = Math.max(100, containerW - 16);

  // Classify seat state
  const getSeatCategory = useCallback((sCode) => {
    const seatInfo = seatStates[sCode] || {};
    const state = seatInfo.state;
    if (state === 'in_use' || state === 'run') return 'in_use';
    if (state === 'warn' || state === 'expiring') return 'warn';
    if (state === 'over' || state === 'overtime') return 'over';
    if (state === 'paused' || state === 'pause') return 'paused';
    if (state === 'reserved' || state === 'wait' || state === 'pending' || state === 'resv') return 'reserved';
    return 'empty';
  }, [seatStates]);

  // Helper to calculate zoom viewport enclosing table T and its nearest neighbor in same zone
  const calculateZoomViewport = useCallback((targetTable) => {
    const sameZoneTables = tables.filter(
      (t) => t.id !== targetTable.id && (t.zone_id != null && targetTable.zone_id != null ? t.zone_id === targetTable.zone_id : true)
    );

    let nearest = null;
    let minDist = Infinity;
    for (const other of sameZoneTables) {
      const d = Math.hypot(other.cx - targetTable.cx, other.cy - targetTable.cy);
      if (d < minDist) {
        minDist = d;
        nearest = other;
      }
    }

    const included = nearest ? [targetTable, nearest] : [targetTable];
    const pad = 65;
    const minX = Math.min(...included.map(t => t.cx - t.w / 2)) - pad;
    const maxX = Math.max(...included.map(t => t.cx + t.w / 2)) + pad;
    const minY = Math.min(...included.map(t => t.cy - t.h / 2)) - pad;
    const maxY = Math.max(...included.map(t => t.cy + t.h / 2)) + pad;

    let boxW = Math.max(maxX - minX, 260);
    let boxH = Math.max(maxY - minY, 170);
    const aspect = availableW / availableH;

    if (boxW / boxH < aspect) {
      boxW = boxH * aspect;
    } else {
      boxH = boxW / aspect;
    }

    const centerX = (minX + maxX) / 2;
    const centerY = (minY + maxY) / 2;

    return {
      x: centerX - boxW / 2,
      y: centerY - boxH / 2,
      w: boxW,
      h: boxH
    };
  }, [tables, availableW, availableH]);

  // Check if a table is fully visible in current viewport
  const isTableFullyVisible = useCallback((t, vp) => {
    if (!vp) return true;
    const left = t.cx - t.w / 2;
    const right = t.cx + t.w / 2;
    const top = t.cy - t.h / 2;
    const bottom = t.cy + t.h / 2;
    return left >= vp.x && right <= vp.x + vp.w && top >= vp.y && bottom <= vp.y + vp.h;
  }, []);

  // Pointer drag panning logic
  const svgRef = useRef(null);
  const isDraggingRef = useRef(false);
  const dragStartRef = useRef({ x: 0, y: 0, vpX: 0, vpY: 0 });
  const dragMovedRef = useRef(false);

  const handlePointerDown = (e) => {
    if (!viewport) return;
    isDraggingRef.current = true;
    dragMovedRef.current = false;
    dragStartRef.current = {
      x: e.clientX,
      y: e.clientY,
      vpX: viewport.x,
      vpY: viewport.y
    };
  };

  const handlePointerMove = (e) => {
    if (!isDraggingRef.current || !viewport) return;
    const dx = e.clientX - dragStartRef.current.x;
    const dy = e.clientY - dragStartRef.current.y;
    if (Math.hypot(dx, dy) > 5) {
      dragMovedRef.current = true;
    }
    const scaleFactor = viewport.w / availableW;
    setViewport({
      ...viewport,
      x: dragStartRef.current.vpX - dx * scaleFactor,
      y: dragStartRef.current.vpY - dy * scaleFactor
    });
  };

  const handlePointerUp = () => {
    isDraggingRef.current = false;
  };

  // Handle clicking on empty canvas (灰色的地方): moves viewport to nearest table
  const handleSvgClick = (e) => {
    if (dragMovedRef.current) return;
    if (!viewport || tables.length <= 8) return;
    const svgEl = svgRef.current;
    if (!svgEl) return;

    try {
      const pt = svgEl.createSVGPoint();
      pt.x = e.clientX;
      pt.y = e.clientY;
      const svgP = pt.matrixTransform(svgEl.getScreenCTM().inverse());

      let nearestTable = null;
      let minDist = Infinity;
      for (const t of tables) {
        const d = Math.hypot(t.cx - svgP.x, t.cy - svgP.y);
        if (d < minDist) {
          minDist = d;
          nearestTable = t;
        }
      }

      if (nearestTable) {
        const fullyVisible = isTableFullyVisible(nearestTable, viewport);
        if (!fullyVisible) {
          const newVp = calculateZoomViewport(nearestTable);
          setViewport(newVp);
          setZoomedTableId(nearestTable.id);
        }
      }
    } catch (err) {
      console.warn('[MiniMap] Click coordinate transform failed:', err);
    }
  };

  // Handle clicking on a table
  const handleTableInteraction = (t, e) => {
    if (e) e.stopPropagation();
    if (dragMovedRef.current) return;

    // Rule: 8 張以內不放大，點桌子直接捲到桌卡
    if (tables.length <= 8) {
      if (onTableClick) onTableClick(t);
      return;
    }

    // Over 8 tables:
    if (!viewport) {
      // Not yet zoomed -> zoom into this table + nearest in same zone
      const newVp = calculateZoomViewport(t);
      setViewport(newVp);
      setZoomedTableId(t.id);
    } else {
      // Already zoomed
      const fullyVisible = isTableFullyVisible(t, viewport);
      if (!fullyVisible) {
        // 沒有完整顯示的桌子變淡，點它或旁邊灰色的地方，畫面就移過去
        const newVp = calculateZoomViewport(t);
        setViewport(newVp);
        setZoomedTableId(t.id);
      } else {
        // 再點桌子，捲到下方那張桌卡
        if (onTableClick) onTableClick(t);
      }
    }
  };

  // Active viewBox
  const currentViewBox = viewport
    ? `${viewport.x} ${viewport.y} ${viewport.w} ${viewport.h}`
    : `0 0 ${canvasW} ${canvasH}`;

  const isZoomed = Boolean(viewport);

  return (
    <div
      ref={containerRef}
      className={`relative overflow-hidden bg-white/95 backdrop-blur-md border border-sg-line rounded-2xl shadow-sm select-none flex flex-col ${className}`}
    >
      {/* Header bar */}
      <div className="flex items-center justify-between px-3 py-1 border-b border-sg-line/60 bg-sg-paper/80 shrink-0">
        <div className="flex items-center gap-1.5">
          <span className="font-bold text-sg-ink text-[12px]">全店縮圖</span>
          {isZoomed && (
            <button
              type="button"
              onClick={() => {
                setViewport(null);
                setZoomedTableId(null);
              }}
              className="flex items-center gap-0.5 px-1.5 py-0.5 rounded-full text-[10px] font-bold bg-sg-paper border border-sg-line text-sg-brown hover:bg-sg-brown-soft transition"
              title="縮小回全圖"
            >
              <ZoomOut className="w-3 h-3" />
              <span>全圖</span>
            </button>
          )}
        </div>
        <span className="text-[11px] text-sg-muted">
          {isZoomed ? '拖曳移動 · 點桌號捲至桌卡' : '點桌子可檢視座位'}
        </span>
      </div>

      {/* Map canvas container */}
      <div
        className="flex-1 flex items-center justify-center overflow-hidden p-1 touch-none"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
      >
        <div
          className="relative"
          style={{
            width: availableW,
            height: availableH
          }}
        >
          <svg
            ref={svgRef}
            onClick={handleSvgClick}
            className="w-full h-full select-none"
            viewBox={currentViewBox}
            preserveAspectRatio="xMidYMid meet"
          >
            {/* Architectural elements (walls, counters, doors, windows, pillars) */}
            <g className="pointer-events-none">
              {(layout.elements_json || layout.elements || []).map((el, idx) => {
                if (el.type === 'wall' && el.points && el.points.length > 1) {
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
                if (el.type === 'window' && el.points && el.points.length > 1) {
                  return (
                    <polyline
                      key={el.id || idx}
                      points={el.points.map(p => p.join(',')).join(' ')}
                      stroke="#78B5C5"
                      strokeWidth={el.thickness || 3}
                      strokeDasharray="6,3"
                      fill="none"
                    />
                  );
                }
                if (el.type === 'door' || el.type === 'counter' || el.type === 'pillar') {
                  return (
                    <rect
                      key={el.id || idx}
                      x={el.x}
                      y={el.y}
                      width={el.w}
                      height={el.h}
                      fill={el.type === 'pillar' ? '#796E65' : '#E5DDD0'}
                      stroke="#C8BEB2"
                      strokeWidth="1.5"
                      rx="3"
                      transform={el.rotation ? `rotate(${el.rotation} ${el.x + el.w / 2} ${el.y + el.h / 2})` : undefined}
                    />
                  );
                }
                return null;
              })}
            </g>

            {/* Tables */}
            {tables.map((t) => {
              const isActive = t.id === activeTableId || t.id === zoomedTableId;
              const fullyVisible = isTableFullyVisible(t, viewport);
              const tableOpacity = isZoomed && !fullyVisible ? 0.35 : 1;

              return (
                <g
                  key={t.id}
                  data-minimap-table={t.label}
                  onClick={(e) => handleTableInteraction(t, e)}
                  className="cursor-pointer transition-opacity duration-200"
                  opacity={tableOpacity}
                  transform={`rotate(${t.rotation || 0} ${t.cx} ${t.cy})`}
                >
                  {/* Pale background for table */}
                  <rect
                    x={t.cx - t.w / 2}
                    y={t.cy - t.h / 2}
                    width={t.w}
                    height={t.h}
                    rx="6"
                    fill={isActive ? '#DFD3C3' : '#EADDCF'}
                    stroke={isActive ? '#8C6D58' : '#C8BEB2'}
                    strokeWidth={isActive ? '2' : '1.5'}
                  />

                  {/* Table Label: only shown after zoom (放大後才顯示桌號) */}
                  {isZoomed && (
                    <text
                      x={t.cx}
                      y={t.cy}
                      textAnchor="middle"
                      dominantBaseline="central"
                      fill="#5C4E43"
                      fontSize={Math.max(14, Math.min(t.w, t.h) * 0.35)}
                      fontWeight="bold"
                      className="pointer-events-none font-num"
                    >
                      {t.label}
                    </text>
                  )}
                </g>
              );
            })}

            {/* Seat colored dots (44 seats configuration, no overlap) */}
            {seats.map((seat) => {
              const table = tables.find(t => t.id === seat.table_id);
              const tRot = (table?.rotation || 0) * (Math.PI / 180);
              const lx = seat.lx || 0;
              const ly = seat.ly || 0;
              const rotLx = lx * Math.cos(tRot) - ly * Math.sin(tRot);
              const rotLy = lx * Math.sin(tRot) + ly * Math.cos(tRot);
              const cx = (table?.cx || 0) + rotLx;
              const cy = (table?.cy || 0) + rotLy;

              const category = getSeatCategory(seat.code);
              const color = STATE_COLORS[category] || STATE_COLORS.empty;

              // Filter logic: if activeFilter is set, only match category is fully visible
              const isMatch = !activeFilter || activeFilter === category;
              const dotOpacity = isMatch ? 1 : 0.15;
              const dotRadius = isZoomed ? 9 : 6.5;

              return (
                <g key={seat.code} className="pointer-events-none" opacity={dotOpacity}>
                  <circle
                    cx={cx}
                    cy={cy}
                    r={dotRadius}
                    fill={color}
                    stroke={category === 'empty' ? '#A89F95' : '#FFFFFF'}
                    strokeWidth="1.2"
                  />
                  {activeFilter && isMatch && (
                    <circle
                      cx={cx}
                      cy={cy}
                      r={dotRadius + 3}
                      fill="none"
                      stroke={color}
                      strokeWidth="1.5"
                      opacity="0.8"
                    />
                  )}
                </g>
              );
            })}
          </svg>
        </div>
      </div>

      {/* Legend & Filter Bar (下方圖例同時是篩選：點「快到時」，只亮快到時的點) */}
      <div className="flex items-center justify-between px-2 py-1 border-t border-sg-line/60 bg-sg-paper/60 text-[10px] gap-1 overflow-x-auto shrink-0">
        <div className="flex items-center gap-1.5 flex-nowrap">
          {LEGEND_ITEMS.map((item) => {
            const isSelected = activeFilter === item.key;
            return (
              <button
                key={item.key}
                type="button"
                onClick={() => setActiveFilter(prev => prev === item.key ? null : item.key)}
                className={`flex items-center gap-1 px-1.5 py-0.5 rounded-full transition cursor-pointer shrink-0 ${
                  isSelected
                    ? 'bg-white shadow-xs font-bold text-sg-ink ring-1 ring-sg-brown'
                    : 'text-sg-muted hover:text-sg-ink hover:bg-white/60'
                }`}
              >
                <span
                  className="w-2 h-2 rounded-full shrink-0"
                  style={{ backgroundColor: item.color }}
                />
                <span>{item.label}</span>
              </button>
            );
          })}
        </div>

        {/* Waiting area badge in bottom-right */}
        <button
          type="button"
          onClick={() => {
            const el = document.getElementById('waiting-area-section');
            if (el) el.scrollIntoView({ behavior: 'smooth' });
          }}
          className="px-1.5 py-0.5 rounded-full text-[10px] font-bold bg-white border border-sg-line text-sg-brown shadow-2xs hover:bg-sg-brown-soft transition flex items-center gap-1 shrink-0 ml-1"
        >
          <span className="w-1.5 h-1.5 rounded-full bg-sg-honey" />
          <span>等待區 {effectiveWaitPax}</span>
        </button>
      </div>
    </div>
  );
}

