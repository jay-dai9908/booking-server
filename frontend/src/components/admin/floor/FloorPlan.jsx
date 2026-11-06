import React from 'react';
import SeatTile from './SeatTile';

export default function FloorPlan({
  layout = {},
  seatStates = {}, // { [seatCode]: { state, isPaid, timerText, paxName, boards } }
  selectedSeats = [],
  suggestedSeats = [],
  onSeatClick = null,
  interactive = true,
  scale = 1,
  fitContainer = false,
  className = ''
}) {
  const containerRef = React.useRef(null);
  const [containerWidth, setContainerWidth] = React.useState(0);

  React.useEffect(() => {
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
  const elements = layout.elements || [];

  const effectiveScale = (fitContainer && containerWidth > 0)
    ? Math.min(1, containerWidth / canvasW)
    : scale;

  return (
    <div
      ref={containerRef}
      className={`relative overflow-hidden bg-[#FAF7F2] border border-sg-line rounded-2xl select-none ${className}`}
      style={{
        width: fitContainer ? '100%' : canvasW * scale,
        height: canvasH * effectiveScale,
        maxWidth: canvasW,
        minHeight: canvasH * effectiveScale
      }}
    >
      <div
        className="absolute inset-0 origin-top-left"
        style={{
          width: canvasW,
          height: canvasH,
          transform: `scale(${effectiveScale})`
        }}
      >
        {/* Background photo if any */}
        {layout.bg_image_url && (
          <img
            src={layout.bg_image_url}
            alt="底圖"
            className="absolute inset-0 w-full h-full object-cover pointer-events-none"
            style={{ opacity: (layout.bg_opacity ?? 30) / 100 }}
          />
        )}

        {/* SVG architectural elements (walls, doors, counters) */}
        <svg className="absolute inset-0 w-full h-full pointer-events-none">
          {elements.map((el, idx) => {
            if (el.type === 'wall') {
              return (
                <line
                  key={idx}
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
            if (el.type === 'counter') {
              return (
                <rect
                  key={idx}
                  x={el.x}
                  y={el.y}
                  width={el.w}
                  height={el.h}
                  fill="#E5DDD0"
                  stroke="#C8BEB2"
                  strokeWidth="2"
                  rx="6"
                />
              );
            }
            if (el.type === 'pillar') {
              return (
                <rect
                  key={idx}
                  x={el.x}
                  y={el.y}
                  width={el.w}
                  height={el.h}
                  fill="#796E65"
                  rx="4"
                />
              );
            }
            return null;
          })}
        </svg>

        {/* Tables */}
        {tables.map((t) => (
          <div
            key={t.id}
            className="absolute border border-[#C8BEB2] rounded-xl flex items-center justify-center pointer-events-none"
            style={{
              left: t.cx - t.w / 2,
              top: t.cy - t.h / 2,
              width: t.w,
              height: t.h,
              backgroundColor: '#EADDCF',
              transform: `rotate(${t.rotation || 0}deg)`,
              transformOrigin: 'center center'
            }}
          >
            <span className="text-[12px] font-bold text-sg-brown/80 tracking-wide select-none">
              {t.label}
            </span>
          </div>
        ))}

        {/* Seats */}
        {seats.map((seat) => {
          const table = tables.find(t => t.id === seat.table_id);
          const tRot = (table?.rotation || 0) * (Math.PI / 180);
          const rad = (table?.rotation || 0);

          // Absolute position: table.cx + rotated lx, table.cy + rotated ly
          const lx = seat.lx || 0;
          const ly = seat.ly || 0;
          const cos = Math.cos(tRot);
          const sin = Math.sin(tRot);
          const rotLx = lx * cos - ly * sin;
          const rotLy = lx * sin + ly * cos;

          const cx = (table?.cx || 0) + rotLx;
          const cy = (table?.cy || 0) + rotLy;

          // State determination
          const seatInfo = seatStates[seat.code] || {};
          let state = seatInfo.state || (seat.is_active ? 'empty' : 'off');
          if (selectedSeats.includes(seat.code)) {
            state = 'pick';
          } else if (suggestedSeats.includes(seat.code)) {
            state = 'sugg';
          }

          const isVent = seat.priority === 'last';

          return (
            <div
              key={seat.id || seat.code}
              className="absolute -translate-x-1/2 -translate-y-1/2"
              style={{
                left: cx,
                top: cy,
                transform: `translate(-50%, -50%) rotate(${rad}deg)`,
                transformOrigin: 'center center'
              }}
            >
              <SeatTile
                code={seat.code}
                state={state}
                isVent={isVent}
                isPaid={Boolean(seatInfo.isPaid)}
                boards={seatInfo.boards || []}
                timerText={seatInfo.timerText}
                paxName={seatInfo.paxName}
                onClick={interactive && onSeatClick ? () => onSeatClick(seat) : null}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}
