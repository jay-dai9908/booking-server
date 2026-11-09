import React, { useRef, useState, useEffect } from 'react';

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
  const tables = layout.tables || [];
  const seats = layout.seats || [];

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

  const availableH = 96;
  const availableW = Math.max(100, containerW - 16);
  const scale = Math.min(availableW / canvasW, availableH / canvasH);
  const mapW = canvasW * scale;
  const mapH = canvasH * scale;

  const getSeatStatusStyle = (sCode) => {
    const seatInfo = seatStates[sCode] || {};
    const state = seatInfo.state;
    if (state === 'in_use' || state === 'run') {
      return 'bg-sg-sage text-white border border-sg-sage-ink/20 shadow-2xs';
    }
    if (state === 'over' || state === 'overtime') {
      return 'bg-sg-danger text-white border border-sg-danger shadow-2xs animate-pulse';
    }
    if (state === 'warn' || state === 'expiring') {
      return 'bg-sg-honey text-white border border-sg-honey shadow-2xs';
    }
    if (state === 'paused' || state === 'pause') {
      return 'bg-sg-vent text-white border border-sg-vent shadow-2xs';
    }
    if (state === 'reserved' || state === 'wait' || state === 'pending') {
      return 'bg-white text-sg-brown border-2 border-sg-brown shadow-2xs';
    }
    if (state === 'off') {
      return 'bg-sg-paper text-sg-muted border border-sg-line/50 opacity-40';
    }
    return 'bg-white text-sg-ink border border-sg-line';
  };

  return (
    <div
      ref={containerRef}
      className={`relative overflow-hidden bg-white/95 backdrop-blur-md border border-sg-line rounded-2xl shadow-sm select-none flex flex-col h-[136px] ${className}`}
    >
      {/* Header bar */}
      <div className="flex items-center justify-between px-3 py-1 border-b border-sg-line/60 bg-sg-paper/80 shrink-0">
        <span className="font-bold text-sg-ink text-[12px]">全店縮圖</span>
        <span className="text-[11px] text-sg-muted">點桌子跳到下方</span>
      </div>

      {/* Map canvas container */}
      <div className="flex-1 flex items-center justify-center overflow-hidden p-1">
        <div
          className="relative"
          style={{
            width: mapW,
            height: mapH
          }}
        >
          {/* Architectural elements (walls, counters, doors, windows, pillars) */}
          <svg
            className="absolute inset-0 pointer-events-none"
            style={{ width: mapW, height: mapH }}
            viewBox={`0 0 ${canvasW} ${canvasH}`}
          >
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
          </svg>

          {/* Tables */}
          {tables.map((t) => {
            const isActive = t.id === activeTableId;
            const tLeft = (t.cx - t.w / 2) * scale;
            const tTop = (t.cy - t.h / 2) * scale;
            const tWidth = t.w * scale;
            const tHeight = t.h * scale;

            return (
              <React.Fragment key={t.id}>
                <div
                  className={`absolute border rounded flex items-center justify-center pointer-events-none transition-all ${
                    isActive
                      ? 'bg-sg-brown text-white border-sg-brown shadow-md ring-2 ring-sg-peach'
                      : 'bg-[#EADDCF]/90 border-[#C8BEB2] text-sg-brown'
                  }`}
                  style={{
                    left: tLeft,
                    top: tTop,
                    width: tWidth,
                    height: tHeight,
                    transform: `rotate(${t.rotation || 0}deg)`
                  }}
                >
                  <span className="text-[10px] font-bold tracking-tight">{t.label}</span>
                </div>

                {/* Touch/Click Hit Area */}
                <button
                  type="button"
                  onClick={() => onTableClick && onTableClick(t)}
                  aria-label={t.label}
                  className="absolute cursor-pointer -translate-x-1/2 -translate-y-1/2 z-20 opacity-0"
                  style={{
                    left: t.cx * scale,
                    top: t.cy * scale,
                    width: Math.max(tWidth, 36),
                    height: Math.max(tHeight, 36)
                  }}
                />
              </React.Fragment>
            );
          })}

          {/* Miniature seat cells (Round 17 Item 5): fixed 24x16 in mini mode, not scaled with map */}
          {seats.map((seat) => {
            const table = tables.find(t => t.id === seat.table_id);
            const tRot = (table?.rotation || 0) * (Math.PI / 180);
            const lx = seat.lx || 0;
            const ly = seat.ly || 0;
            const rotLx = lx * Math.cos(tRot) - ly * Math.sin(tRot);
            const rotLy = lx * Math.sin(tRot) + ly * Math.cos(tRot);
            const cx = (table?.cx || 0) + rotLx;
            const cy = (table?.cy || 0) + rotLy;

            const miniX = cx * scale;
            const miniY = cy * scale;
            const statusClass = getSeatStatusStyle(seat.code);

            return (
              <div
                key={seat.code}
                className={`absolute rounded-[4px] pointer-events-none flex items-center justify-center z-10 transition-colors ${statusClass}`}
                style={{
                  left: miniX - 12,
                  top: miniY - 8,
                  width: 24,
                  height: 16
                }}
                title={seat.code}
              >
                <span className="text-[9px] font-num font-bold leading-none select-none truncate px-0.5">
                  {seat.code}
                </span>
              </div>
            );
          })}
        </div>
      </div>

      {/* Waiting area badge in bottom-right */}
      <button
        type="button"
        onClick={() => {
          const el = document.getElementById('waiting-area-section');
          if (el) el.scrollIntoView({ behavior: 'smooth' });
        }}
        className="absolute bottom-1.5 right-1.5 z-20 px-2 py-0.5 rounded-full text-[11px] font-bold bg-sg-paper border border-sg-line text-sg-brown shadow-xs hover:bg-sg-brown-soft transition flex items-center gap-1"
      >
        <span className="w-2 h-2 rounded-full bg-sg-honey" />
        <span>等待區 {effectiveWaitPax}</span>
      </button>
    </div>
  );
}
