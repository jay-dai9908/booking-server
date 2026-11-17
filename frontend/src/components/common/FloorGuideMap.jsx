// frontend/src/components/common/FloorGuideMap.jsx
import React, { useRef, useState, useEffect } from 'react';
import {
  SZ,
  PAL,
  ACCENT,
  BROWN,
  PAD,
  bbox,
  computeFloorLayout
} from '../../../../shared/floorMapLayout.js';
import { KIOSK_ICONS } from '../../assets/kiosk-icons/index.js';

let sharedCanvasCtx = null;
function getMeasureTextFn() {
  if (typeof document === 'undefined') return null;
  if (!sharedCanvasCtx) {
    const canvas = document.createElement('canvas');
    sharedCanvasCtx = canvas.getContext('2d');
  }
  return (text, size, weight = 500) => {
    sharedCanvasCtx.font = `${weight} ${size}px "Noto Sans TC", sans-serif`;
    return sharedCanvasCtx.measureText(text).width;
  };
}

export default function FloorGuideMap({
  floor,
  seatCodes = [],
  className = '',
  style = {}
}) {
  const containerRef = useRef(null);
  const [containerWidth, setContainerWidth] = useState(360);

  useEffect(() => {
    if (!containerRef.current) return;
    const updateW = () => {
      if (containerRef.current) {
        setContainerWidth(containerRef.current.clientWidth || 360);
      }
    };
    updateW();
    const ro = new ResizeObserver(updateW);
    ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, []);

  if (!floor) return null;

  const measureText = getMeasureTextFn();
  const layout = computeFloorLayout({
    floor,
    seatCodes,
    containerWidth,
    measureText
  });

  const {
    floor: rotatedFloor,
    vbW,
    vbH,
    k,
    u,
    mineSeats,
    mineTables,
    placedLabels,
    doorPt
  } = layout;

  const mine = new Set(seatCodes || []);

  // Bead pattern generator
  const renderBeads = (b) => {
    const cols = ['#E57C6E', '#F2B544', '#7EB07A', '#6FA3D0', '#B48AD6', '#F08DB4'];
    const vert = b.h > b.w;
    const len = vert ? b.h : b.w;
    const thick = vert ? b.w : b.h;
    const step = u(7);
    const rows = thick >= u(12) ? 2 : 1;
    const circles = [];
    for (let r = 0; r < rows; r++) {
      for (let i = 0, o = step * 0.8; o < len - step * 0.4; i++, o += step) {
        const across = rows === 1 ? 0 : (r ? thick / 4 : -thick / 4);
        const cx = vert ? b.cx + across : b.x1 + o;
        const cy = vert ? b.y1 + o : b.cy + across;
        circles.push(
          <circle
            key={`bead-${r}-${i}`}
            cx={cx}
            cy={cy}
            r={u(2.2)}
            fill={cols[(i + r * 3) % 6]}
            fillOpacity={0.85}
          />
        );
      }
    }
    return circles;
  };

  // Entrance tag calculation
  const entranceW = 42; // Tag width approx
  const entranceH = SZ.tag + 10;
  let entranceLeft = doorPt[0] - u(entranceW) / 2;
  entranceLeft = Math.max(-PAD + u(2), Math.min(entranceLeft, (rotatedFloor.w || 720) + PAD - u(entranceW) - u(2)));
  const entranceTop = doorPt[1] - u(6) - u(entranceH + 6);
  const txEntrance = Math.max(entranceLeft + u(8), Math.min(doorPt[0], entranceLeft + u(entranceW) - u(8)));

  // Guest tag calculation
  let guestTag = null;
  if (mineSeats.length > 0) {
    const xs = mineSeats.map(s => s.x);
    const ys = mineSeats.map(s => s.y);
    const minXs = Math.min(...xs);
    const maxXs = Math.max(...xs);
    const minYs = Math.min(...ys);
    const maxYs = Math.max(...ys);
    const midX = (minXs + maxXs) / 2;
    const above = minYs * k > 44;
    const tagW = 76; // '你的座位' width
    const tagH = SZ.tag + 10;
    let tagLeft = midX - u(tagW) / 2;
    tagLeft = Math.max(-PAD + u(2), Math.min(tagLeft, (rotatedFloor.w || 720) + PAD - u(tagW) - u(2)));
    const tagTop = above ? minYs - u(14) - u(tagH + 6) : maxYs + u(14) + u(6);
    const txGuest = Math.max(tagLeft + u(8), Math.min(midX, tagLeft + u(tagW) - u(8)));

    guestTag = {
      above,
      left: tagLeft,
      top: tagTop,
      width: u(tagW),
      height: u(tagH),
      tx: txGuest,
      midX
    };
  }

  return (
    <div
      ref={containerRef}
      className={`relative w-full max-w-full overflow-hidden flex items-center justify-center ${className}`}
      style={{ maxHeight: '60vh', ...style }}
    >
      <style>{`
        @keyframes ripple {
          from { r: var(--r0); opacity: 0.85; }
          to { r: var(--r1); opacity: 0; }
        }
        .floor-ripple {
          animation: ripple 1.6s ease-out infinite;
        }
        .floor-ripple-delay {
          animation: ripple 1.6s ease-out infinite 0.8s;
        }
        @keyframes bob {
          0%, 100% { transform: translateY(0); }
          50% { transform: translateY(var(--bob)); }
        }
        .floor-bob {
          animation: bob 1.1s ease-in-out infinite;
        }
        @media (prefers-reduced-motion: reduce) {
          .floor-ripple, .floor-ripple-delay, .floor-bob {
            animation: none !important;
          }
        }
      `}</style>
      <svg
        viewBox={`${-PAD} ${-PAD} ${vbW} ${vbH}`}
        role="img"
        aria-label="店內地圖，標出你的座位"
        className="block w-full h-auto select-none"
        style={{ maxHeight: '60vh' }}
      >
        {/* Floor background polygons for walls */}
        {(rotatedFloor.shapes || [])
          .filter(s => s.kind === 'wall' && s.pts && s.pts.length >= 3)
          .map((s, idx) => (
            <polygon
              key={`wall-poly-${idx}`}
              points={s.pts.map(p => p.join(',')).join(' ')}
              fill="#FFFDF9"
            />
          ))}

        {/* Fixtures & Pillars shapes */}
        {(rotatedFloor.shapes || []).map((s, idx) => {
          if ((s.kind !== 'fixture' && s.kind !== 'pillar') || s.show === 'hidden') return null;
          const [fill] = PAL[s.color] || PAL.grey;
          const b = bbox(s.pts);
          return (
            <g key={`shape-${idx}`}>
              <rect
                x={b.x1}
                y={b.y1}
                width={b.w}
                height={b.h}
                rx={u(3)}
                fill={s.kind === 'pillar' ? '#B3A99F' : fill}
              />
              {s.pattern === 'beads' && renderBeads(b)}
            </g>
          );
        })}

        {/* Tables */}
        {(rotatedFloor.tables || []).map((t, idx) => {
          const b = bbox(t.pts);
          const hl = mineTables.has(idx);
          const showLabel = b.w * k >= 18;
          return (
            <g key={`table-${idx}`}>
              <rect
                x={b.x1}
                y={b.y1}
                width={b.w}
                height={b.h}
                rx={u(4)}
                fill={hl ? '#D5E0CF' : '#E4D8CA'}
                stroke={hl ? ACCENT : 'none'}
                strokeWidth={u(2)}
              />
              {showLabel && t.label && (
                <text
                  x={b.cx}
                  y={b.cy}
                  fontSize={u(SZ.table)}
                  fontWeight={700}
                  fill={hl ? ACCENT : '#A08E7F'}
                  textAnchor="middle"
                  dominantBaseline="central"
                  fontFamily="Nunito, sans-serif"
                >
                  {t.label}
                </text>
              )}
            </g>
          );
        })}

        {/* Other Seats */}
        {(rotatedFloor.seats || []).map((s) => {
          if (mine.has(s.code)) return null;
          return (
            <circle
              key={`seat-${s.code}`}
              cx={s.x}
              cy={s.y}
              r={u(SZ.seat)}
              fill="#D3CAC0"
            />
          );
        })}

        {/* Walls and Windows polylines */}
        {(rotatedFloor.shapes || []).map((s, idx) => {
          if (s.kind === 'wall' || s.kind === 'window') {
            return (
              <polyline
                key={`line-${idx}`}
                points={s.pts.map(p => p.join(',')).join(' ')}
                fill="none"
                stroke={s.kind === 'wall' ? '#6F645B' : '#7FB3C4'}
                strokeWidth={u(s.kind === 'wall' ? SZ.wall : SZ.glass)}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            );
          }
          if (s.kind === 'door') {
            const b = bbox(s.pts);
            return (
              <line
                key={`door-line-${idx}`}
                x1={b.x1}
                y1={b.cy}
                x2={b.x2}
                y2={b.cy}
                stroke={BROWN}
                strokeWidth={u(6)}
                strokeLinecap="round"
              />
            );
          }
          return null;
        })}

        {/* Entrance Tag */}
        <g>
          <rect
            x={entranceLeft}
            y={entranceTop}
            width={u(entranceW)}
            height={u(entranceH)}
            rx={u(8)}
            fill={BROWN}
          />
          <polygon
            points={`${txEntrance - u(6)},${entranceTop + u(entranceH) - 0.5} ${txEntrance + u(6)},${entranceTop + u(entranceH) - 0.5} ${txEntrance},${entranceTop + u(entranceH + 6)}`}
            fill={BROWN}
          />
          <text
            x={entranceLeft + u(entranceW) / 2}
            y={entranceTop + u(entranceH) / 2}
            fontSize={u(SZ.tag)}
            fontWeight={700}
            fill="#FFFDF9"
            textAnchor="middle"
            dominantBaseline="central"
            fontFamily='"Noto Sans TC", sans-serif'
          >
            入口
          </text>
        </g>

        {/* Fixture Labels */}
        {placedLabels.map((item, idx) => {
          const { shape, ink, iconPos, textPos } = item;
          const iconDef = shape.icon && KIOSK_ICONS[shape.icon];
          const lh = SZ.name * 1.3;

          return (
            <g key={`lbl-${idx}`}>
              {iconPos && iconDef && (
                <g
                  transform={`translate(${iconPos.x} ${iconPos.y}) scale(${u(iconPos.size) / 24})`}
                  fill="none"
                  stroke={ink}
                  strokeWidth={2}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  dangerouslySetInnerHTML={{ __html: iconDef.inner }}
                />
              )}
              {textPos && (
                <text
                  x={textPos.cx}
                  y={textPos.cy - u(lh * (textPos.lines.length - 1) / 2)}
                  fontSize={u(SZ.name)}
                  fontWeight={500}
                  fill={ink}
                  textAnchor="middle"
                  dominantBaseline="central"
                  fontFamily='"Noto Sans TC", sans-serif'
                >
                  {textPos.lines.map((ln, lineIdx) => (
                    <tspan
                      key={`ln-${lineIdx}`}
                      x={textPos.cx}
                      dy={lineIdx ? u(lh) : 0}
                    >
                      {ln}
                    </tspan>
                  ))}
                </text>
              )}
            </g>
          );
        })}

        {/* Guest Seats Highlight Ripples & Dots */}
        {mineSeats.map(s => (
          <g key={`guest-seat-${s.code}`}>
            <circle
              cx={s.x}
              cy={s.y}
              className="floor-ripple"
              style={{ '--r0': `${u(8)}px`, '--r1': `${u(26)}px` }}
              r={u(8)}
              fill={ACCENT}
              fillOpacity={0.25}
              stroke={ACCENT}
              strokeWidth={u(2.5)}
            />
            <circle
              cx={s.x}
              cy={s.y}
              className="floor-ripple-delay"
              style={{ '--r0': `${u(8)}px`, '--r1': `${u(26)}px` }}
              r={u(8)}
              fill={ACCENT}
              fillOpacity={0.25}
              stroke={ACCENT}
              strokeWidth={u(2.5)}
            />
            <circle
              cx={s.x}
              cy={s.y}
              r={u(SZ.mine)}
              fill={ACCENT}
              stroke="#FFFDF9"
              strokeWidth={u(2)}
            />
          </g>
        ))}

        {/* Guest Seat Tag ("你的座位") */}
        {guestTag && (
          <g
            className="floor-bob"
            style={{ '--bob': guestTag.above ? `-${u(6)}px` : `${u(6)}px` }}
          >
            <rect
              x={guestTag.left}
              y={guestTag.top}
              width={guestTag.width}
              height={guestTag.height}
              rx={u(8)}
              fill={ACCENT}
            />
            <polygon
              points={
                guestTag.above
                  ? `${guestTag.tx - u(6)},${guestTag.top + guestTag.height - 0.5} ${guestTag.tx + u(6)},${guestTag.top + guestTag.height - 0.5} ${guestTag.tx},${guestTag.top + guestTag.height + u(6)}`
                  : `${guestTag.tx - u(6)},${guestTag.top + 0.5} ${guestTag.tx + u(6)},${guestTag.top + 0.5} ${guestTag.tx},${guestTag.top - u(6)}`
              }
              fill={ACCENT}
            />
            <text
              x={guestTag.left + guestTag.width / 2}
              y={guestTag.top + guestTag.height / 2}
              fontSize={u(SZ.tag)}
              fontWeight={700}
              fill="#FFFDF9"
              textAnchor="middle"
              dominantBaseline="central"
              fontFamily='"Noto Sans TC", sans-serif'
            >
              你的座位
            </text>
          </g>
        )}
      </svg>
    </div>
  );
}
