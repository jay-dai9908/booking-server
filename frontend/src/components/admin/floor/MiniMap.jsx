import React, { useRef, useState, useEffect } from 'react';

export default function MiniMap({
  layout = {},
  seatStates = {},
  activeTableId = null,
  onTableClick = null,
  className = ''
}) {
  const containerRef = useRef(null);
  const [containerW, setContainerW] = useState(340);

  const canvasW = layout.canvas_w || 1000;
  const canvasH = layout.canvas_h || 625;
  const tables = layout.tables || [];
  const seats = layout.seats || [];

  useEffect(() => {
    if (!containerRef.current) return;
    const updateWidth = () => {
      if (containerRef.current) {
        setContainerW(containerRef.current.clientWidth || 340);
      }
    };
    updateWidth();
    const ro = new ResizeObserver(updateWidth);
    ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, []);

  const availableH = 84;
  const availableW = Math.max(100, containerW - 16);
  const scale = Math.min(availableW / canvasW, availableH / canvasH);
  const mapW = canvasW * scale;
  const mapH = canvasH * scale;

  return (
    <div
      ref={containerRef}
      className={`relative overflow-hidden bg-white/95 backdrop-blur-md border border-sg-line rounded-2xl shadow-sm select-none flex flex-col h-[120px] ${className}`}
    >
      {/* Header bar: Spec 6.5 */}
      <div className="flex items-center justify-between px-3 py-1 border-b border-sg-line/60 bg-sg-paper/80 shrink-0">
        <span className="font-bold text-sg-ink text-[12px]">全店縮圖</span>
        <span className="text-[11px] text-sg-muted">點桌子跳到下方</span>
      </div>

      {/* Map canvas container */}
      <div className="flex-1 flex items-center justify-center overflow-hidden p-1">
        <div
          className="relative origin-top-left"
          style={{
            width: canvasW,
            height: canvasH,
            transform: `scale(${scale})`,
            marginBottom: `-${canvasH * (1 - scale)}px`,
            marginRight: `-${canvasW * (1 - scale)}px`
          }}
        >
          {/* Tables */}
          {tables.map((t) => {
            const isActive = t.id === activeTableId;
            // Ensure minimum touch target of 44x44px in scaled space
            const minW = Math.max(t.w, 44 / (scale || 0.1));
            const minH = Math.max(t.h, 44 / (scale || 0.1));

            return (
              <React.Fragment key={t.id}>
                <div
                  className={`absolute border rounded flex items-center justify-center pointer-events-none transition-all ${
                    isActive
                      ? 'bg-sg-brown text-white border-sg-brown shadow-md ring-4 ring-sg-peach'
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
                  <span className="text-[14px] font-bold tracking-tight">{t.label}</span>
                </div>

                {/* Touch/Click Hit Area */}
                <button
                  type="button"
                  onClick={() => onTableClick && onTableClick(t)}
                  aria-label={t.label}
                  className="absolute cursor-pointer -translate-x-1/2 -translate-y-1/2 z-10 opacity-0"
                  style={{
                    left: t.cx,
                    top: t.cy,
                    width: minW,
                    height: minH
                  }}
                />
              </React.Fragment>
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
            if (seatInfo.state === 'run' || seatInfo.state === 'in_use') dotColor = 'bg-sg-sage';
            else if (seatInfo.state === 'over') dotColor = 'bg-sg-danger';
            else if (seatInfo.state === 'warn') dotColor = 'bg-sg-honey';
            else if (seatInfo.state === 'pause' || seatInfo.state === 'paused') dotColor = 'bg-sg-vent';
            else if (seatInfo.state === 'wait' || seatInfo.state === 'pending') dotColor = 'bg-white border border-sg-brown';

            return (
              <div
                key={seat.code}
                className={`absolute w-3 h-3 rounded-full -translate-x-1/2 -translate-y-1/2 pointer-events-none ${dotColor}`}
                style={{ left: cx, top: cy }}
              />
            );
          })}
        </div>
      </div>
    </div>
  );
}
