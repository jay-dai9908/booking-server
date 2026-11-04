import React from 'react';

export default function MiniMap({
  layout = {},
  seatStates = {},
  activeTableId = null,
  onTableClick = null,
  className = ''
}) {
  const canvasW = layout.canvas_w || 1000;
  const canvasH = layout.canvas_h || 625;
  const tables = layout.tables || [];
  const seats = layout.seats || [];

  const mapW = 140;
  const scale = mapW / canvasW;
  const mapH = canvasH * scale;

  return (
    <div
      className={`relative overflow-hidden bg-white/90 backdrop-blur-sm border border-sg-line rounded-xl shadow-sm p-1 select-none ${className}`}
      style={{ width: mapW, height: mapH }}
    >
      <div
        className="relative origin-top-left"
        style={{ width: canvasW, height: canvasH, transform: `scale(${scale})` }}
      >
        {/* Tables */}
        {tables.map((t) => {
          const isActive = t.id === activeTableId;
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => onTableClick && onTableClick(t)}
              className={`absolute border rounded flex items-center justify-center transition ${
                isActive
                  ? 'bg-sg-brown text-white border-sg-brown shadow-sm'
                  : 'bg-[#EADDCF] border-[#C8BEB2] text-sg-brown'
              }`}
              style={{
                left: t.cx - t.w / 2,
                top: t.cy - t.h / 2,
                width: t.w,
                height: t.h,
                transform: `rotate(${t.rotation || 0}deg)`
              }}
            >
              <span className="text-[14px] font-bold">{t.label}</span>
            </button>
          );
        })}

        {/* Miniature seat dots */}
        {seats.map((seat) => {
          const table = tables.find(t => t.id === seat.table_id);
          const tRot = (table?.rotation || 0) * (Math.PI / 180);
          const lx = seat.lx || 0;
          const ly = seat.ly || 0;
          const rotLx = lx * Math.cos(tRot) - ly * Math.sin(tRot);
          const rotLy = lx * Math.sin(tRot) + ly * Math.cos(tRot);
          const cx = (table?.cx || 0) + rotLx;
          const cy = (table?.cy || 0) + rotLy;

          const seatInfo = seatStates[seat.code] || {};
          let dotColor = 'bg-sg-line';
          if (seatInfo.state === 'run') dotColor = 'bg-sg-sage';
          else if (seatInfo.state === 'over') dotColor = 'bg-sg-danger';
          else if (seatInfo.state === 'warn') dotColor = 'bg-sg-honey';
          else if (seatInfo.state === 'pause') dotColor = 'bg-sg-vent';

          return (
            <div
              key={seat.code}
              className={`absolute w-3 h-3 rounded-full -translate-x-1/2 -translate-y-1/2 ${dotColor}`}
              style={{ left: cx, top: cy }}
            />
          );
        })}
      </div>
    </div>
  );
}
