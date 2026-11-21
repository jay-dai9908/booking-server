// frontend/src/components/display/DisplayFloorMap.jsx
import React, { useMemo } from 'react';
import { PAL, bbox, wrap } from '../../../../shared/floorMapLayout.js';
import { KIOSK_ICONS } from '../../assets/kiosk-icons/index.js';
import {
  DISPLAY_MAP_SZ,
  DISPLAY_MAP_BOX,
  DISPLAY_PAD,
  computeDisplayMapData
} from '../../utils/display/mapMarkers.js';
import { computeSeatVisualState } from '../../utils/display/seatStatus.js';

const EXTRA_ICONS = {
  __pin: '<path d="M12 21s-6.5-5.8-6.5-11.2a6.5 6.5 0 0 1 13 0C18.5 15.2 12 21 12 21z"/><circle cx="12" cy="9.8" r="2.4"/>'
};

let sharedCanvasCtx = null;
function getMeasureTextFn() {
  if (typeof document === 'undefined') return null;
  if (!sharedCanvasCtx) {
    const canvas = document.createElement('canvas');
    sharedCanvasCtx = canvas.getContext('2d');
  }
  return (text, px, weight = 500) => {
    sharedCanvasCtx.font = `${weight} ${px}px "Noto Sans TC", sans-serif`;
    return sharedCanvasCtx.measureText(text).width;
  };
}

function getIconInner(iconId) {
  if (!iconId) return null;
  if (EXTRA_ICONS[iconId]) return EXTRA_ICONS[iconId];
  return KIOSK_ICONS[iconId]?.inner || null;
}

/**
 * Floor map for /display (and mini rotation thumbnails in /admin/display).
 * Adapts FloorGuideMap + store-display-mock.html geometry, bead seat tiles, entrance capsule, and "你在這裡" marker.
 */
export default function DisplayFloorMap({
  floor,
  rotation = 0,
  hereElement = '',
  seats = [],
  nowMs,
  soonMinutes = 10,
  timeMode = 'remain',
  mini = false,
  className = '',
  style = {}
}) {
  const seatMap = useMemo(() => {
    const map = new Map();
    if (Array.isArray(seats)) {
      for (const s of seats) {
        if (s?.code) map.set(s.code, s);
      }
    }
    return map;
  }, [seats]);

  const mapData = useMemo(() => {
    if (!floor) return null;
    const measureText = getMeasureTextFn();
    return computeDisplayMapData({
      floor,
      rotation,
      hereElement,
      box: mini ? { w: 300, h: 188 } : DISPLAY_MAP_BOX,
      pad: mini ? 24 : DISPLAY_PAD,
      measureText,
      mini
    });
  }, [floor, rotation, hereElement, mini]);

  // Place fixture labels outside/inside avoiding obstacles (matching mock lines 646-672)
  const placedFixtureLabels = useMemo(() => {
    if (!mapData || mini) return [];
    const { shapes, u, k, tw, roomW, roomH, pad, obstacles } = mapData;
    const obs = [...(obstacles || [])];

    const fixtures = shapes
      .filter(s => s.kind === 'fixture' && s.show !== 'hidden')
      .sort((a, b) => a._box.w * a._box.h - b._box.w * b._box.h);

    const results = [];
    for (const s of fixtures) {
      const b = s._box;
      const [, ink] = PAL[s.color] || PAL.grey;
      const wantIcon = (s.show === 'icon' || s.show === 'icon_name') && Boolean(getIconInner(s.icon));
      const name = (s.show === 'name' || s.show === 'icon_name') && s.label ? s.label : '';
      if (!wantIcon && !name) continue;

      const w = b.w * k;
      const h = b.h * k;
      const is = wantIcon ? DISPLAY_MAP_SZ.icon : 0;
      const gap = wantIcon && name ? 6 : 0;
      const lh = DISPLAY_MAP_SZ.name * 1.3;
      const cw = tw('字', DISPLAY_MAP_SZ.name, 500) || DISPLAY_MAP_SZ.name;
      const nameW = name ? Math.max(...name.split('\n').map(l => tw(l, DISPLAY_MAP_SZ.name, 500))) : 0;
      const inside = s.pattern !== 'beads';

      if (inside && !name.includes('\n') && is + gap + nameW <= w - 12 && Math.max(is, DISPLAY_MAP_SZ.name) <= h - 10) {
        const startX = b.cx - u(is + gap + nameW) / 2;
        results.push({
          key: `fx-${s._idx}`,
          ink,
          icon: wantIcon ? { id: s.icon, x: startX, y: b.cy - u(is) / 2, px: is } : null,
          text: name ? { lines: [name], cx: startX + u(is + gap + nameW / 2), cy: b.cy } : null
        });
        continue;
      }

      const lines = name ? wrap(name, Math.max(1, Math.floor((w - 8) / cw))) : [];
      const blockW = Math.max(is, ...lines.map(l => tw(l, DISPLAY_MAP_SZ.name, 500)), 0);
      const blockH = is + (wantIcon && name ? 4 : 0) + lines.length * lh;
      if (inside && blockW <= w - 8 && blockH <= h - 8) {
        let y = b.cy - u(blockH) / 2;
        const iconObj = wantIcon ? { id: s.icon, x: b.cx - u(is) / 2, y, px: is } : null;
        if (wantIcon) y += u(is + 4);
        results.push({
          key: `fx-${s._idx}`,
          ink,
          icon: iconObj,
          text: name ? { lines, cx: b.cx, cy: y + u(lines.length * lh) / 2 } : null
        });
        continue;
      }

      const row = name ? [name.replace(/\n/g, '')] : [];
      const rowTW = name ? tw(row[0], DISPLAY_MAP_SZ.name, 500) : 0;
      const rowW = is + gap + rowTW;
      const rowH = Math.max(is, lh);

      const at = (x, y) => ({
        x1: x,
        y1: y - u(rowH) / 2,
        x2: x + u(rowW),
        y2: y + u(rowH) / 2,
        icon: wantIcon ? { id: s.icon, x, y: y - u(is) / 2, px: is } : null,
        text: name ? { lines: row, cx: x + u(is + gap + rowTW / 2), cy: y } : null
      });

      const cands = [
        at(b.x2 + u(10), b.cy),
        at(b.x1 - u(10 + rowW), b.cy),
        at(b.cx - u(rowW) / 2, b.y2 + u(8 + rowH / 2)),
        at(b.cx - u(rowW) / 2, b.y1 - u(8 + rowH / 2))
      ];
      if (b.cx > roomW / 2) {
        cands.unshift(cands.splice(1, 1)[0]);
      }

      const inRoom = (r) =>
        r.x1 >= -pad && r.x2 <= roomW + pad && r.y1 >= -pad && r.y2 <= roomH + pad;

      const overlap = (r) => obs.reduce((sum, ob) => {
        if (ob.x1 === b.x1 && ob.y1 === b.y1 && ob.x2 === b.x2 && ob.y2 === b.y2) return sum;
        const xo = Math.max(0, Math.min(r.x2, ob.x2) - Math.max(r.x1, ob.x1));
        const yo = Math.max(0, Math.min(r.y2, ob.y2) - Math.max(r.y1, ob.y1));
        return sum + xo * yo;
      }, 0);

      const pick = cands.find(r => inRoom(r) && overlap(r) === 0)
        || cands.filter(inRoom).sort((p, q) => overlap(p) - overlap(q))[0]
        || cands[0];

      obs.push(pick);
      results.push({
        key: `fx-${s._idx}`,
        ink,
        icon: pick.icon,
        text: pick.text
      });
    }
    return results;
  }, [mapData, mini]);

  if (!mapData) return null;

  const {
    vbW,
    vbH,
    pad,
    k,
    u,
    tw,
    shapes,
    tables,
    seats: floorSeats,
    doorPt,
    doorTag,
    hereTag
  } = mapData;

  const pid = `display-peg-${rotation}-${mini ? 'm' : 'f'}`;
  const formatPts = (pts) => (pts || []).map(p => `${p[0]},${p[1]}`).join(' ');

  const renderBeads = (b) => {
    const cols = ['#E57C6E', '#F2B544', '#7EB07A', '#6FA3D0', '#B48AD6', '#F08DB4'];
    const vert = b.h > b.w;
    const len = vert ? b.h : b.w;
    const thick = vert ? b.w : b.h;
    const step = u(13);
    const rows = thick >= u(26) ? 2 : 1;
    const circles = [];
    for (let row = 0; row < rows; row++) {
      for (let i = 0, off = step * 0.8; off < len - step * 0.4; i++, off += step) {
        const across = rows === 1 ? 0 : (row ? thick / 4 : -thick / 4);
        circles.push(
          <circle
            key={`bd-${row}-${i}`}
            cx={vert ? b.cx + across : b.x1 + off}
            cy={vert ? b.y1 + off : b.cy + across}
            r={u(4.2)}
            fill={cols[(i + row * 3) % 6]}
            fillOpacity={0.85}
          />
        );
      }
    }
    return circles;
  };

  const renderTagCapsule = (tag, key) => {
    if (!tag) return null;
    const { dims, cx, cy, color, icon, label } = tag;
    const x1 = cx - u(dims.w) / 2;
    const y1 = cy - u(dims.h) / 2;
    const iconInner = getIconInner(icon);
    return (
      <g key={key} data-testid={key === 'here' ? 'display-here-tag' : 'display-entrance-tag'}>
        <rect
          x={x1}
          y={y1}
          width={u(dims.w)}
          height={u(dims.h)}
          rx={u(dims.h / 2)}
          fill={color}
        />
        {iconInner && (
          <g
            transform={`translate(${x1 + u(17)} ${cy - u(dims.is) / 2}) scale(${u(dims.is) / 24})`}
            fill="none"
            stroke="#FFFDF9"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            dangerouslySetInnerHTML={{ __html: iconInner }}
          />
        )}
        <text
          x={x1 + u(17 + dims.is + dims.gap + dims.textW / 2)}
          y={cy}
          fontSize={u(DISPLAY_MAP_SZ.tag)}
          fontWeight={700}
          fill="#FFFDF9"
          textAnchor="middle"
          dominantBaseline="central"
          fontFamily='"LXGW WenKai TC", serif'
        >
          {label}
        </text>
      </g>
    );
  };

  const pillW = u(DISPLAY_MAP_SZ.pillW);
  const pillH = u(DISPLAY_MAP_SZ.pillH);

  return (
    <svg
      viewBox={`${-pad} ${-pad} ${vbW} ${vbH}`}
      preserveAspectRatio="xMidYMid meet"
      className={className || 'flex-1 min-h-0 w-full block'}
      style={style}
      data-testid={mini ? `display-rot-thumb-${rotation}` : 'display-floor-map'}
    >
      <defs>
        <pattern
          id={pid}
          width={u(28)}
          height={u(28)}
          patternUnits="userSpaceOnUse"
        >
          <circle cx={u(14)} cy={u(14)} r={u(2.2)} fill="#EFE6DA" />
        </pattern>
      </defs>

      {/* Wall background fill + pegboard dot grid */}
      {shapes
        .filter(s => s.kind === 'wall' && s.pts && s.pts.length >= 3)
        .map((s, idx) => (
          <g key={`wall-bg-${idx}`}>
            <polygon points={formatPts(s.pts)} fill="#FFFDF9" />
            {!mini && <polygon points={formatPts(s.pts)} fill={`url(#${pid})`} />}
          </g>
        ))}

      {/* Fixtures & Pillars */}
      {shapes.map((s, idx) => {
        if ((s.kind !== 'fixture' && s.kind !== 'pillar') || s.show === 'hidden') return null;
        const [fill] = PAL[s.color] || PAL.grey;
        const b = s._box;
        return (
          <g key={`shape-${idx}`}>
            <rect
              x={b.x1}
              y={b.y1}
              width={b.w}
              height={b.h}
              rx={u(mini ? 3 : 9)}
              fill={s.kind === 'pillar' ? '#CFC6BC' : fill}
            />
            {s.pattern === 'beads' && !mini && renderBeads(b)}
          </g>
        );
      })}

      {/* Tables */}
      {tables.map((t, idx) => {
        const b = t._box;
        const showLabel = !mini && t.label && tw(t.label, DISPLAY_MAP_SZ.table, 800) <= Math.max(b.w, b.h) * k;
        return (
          <g key={`table-${idx}`}>
            <rect
              x={b.x1}
              y={b.y1}
              width={b.w}
              height={b.h}
              rx={u(mini ? 3 : 12)}
              fill="#E4D8CA"
            />
            {showLabel && (
              <text
                x={b.cx}
                y={b.cy}
                fontSize={u(DISPLAY_MAP_SZ.table)}
                fontWeight={800}
                fill="#A08E7F"
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

      {/* Wall outer halo */}
      {!mini && shapes
        .filter(s => s.kind === 'wall')
        .map((s, idx) => (
          <polyline
            key={`wall-halo-${idx}`}
            points={formatPts(s.pts)}
            fill="none"
            stroke="#F1E8DD"
            strokeWidth={u(DISPLAY_MAP_SZ.wall * 3)}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ))}

      {/* Walls, Windows, Doors */}
      {shapes.map((s, idx) => {
        if (s.kind === 'wall' || s.kind === 'window') {
          return (
            <polyline
              key={`line-${idx}`}
              points={formatPts(s.pts)}
              fill="none"
              stroke={s.kind === 'wall' ? '#6F645B' : '#7FB3C4'}
              strokeWidth={u(s.kind === 'wall' ? DISPLAY_MAP_SZ.wall : DISPLAY_MAP_SZ.glass)}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          );
        }
        if (s.kind === 'door') {
          const b = bbox(s.pts || []);
          const horiz = b.w >= b.h;
          return horiz ? (
            <line
              key={`door-${idx}`}
              x1={b.x1}
              y1={b.cy}
              x2={b.x2}
              y2={b.cy}
              stroke="#8B5B43"
              strokeWidth={u(10)}
              strokeLinecap="round"
            />
          ) : (
            <line
              key={`door-${idx}`}
              x1={b.cx}
              y1={b.y1}
              x2={b.cx}
              y2={b.y2}
              stroke="#8B5B43"
              strokeWidth={u(10)}
              strokeLinecap="round"
            />
          );
        }
        return null;
      })}

      {/* Mini mode seats + door dot */}
      {mini && (
        <>
          {floorSeats.map(s => (
            <circle key={`ms-${s.code}`} cx={s.x} cy={s.y} r={u(3.4)} fill="#E7B4A2" />
          ))}
          <circle cx={doorPt[0]} cy={doorPt[1]} r={u(9)} fill="#8B5B43" />
        </>
      )}

      {/* Full mode fixture labels */}
      {!mini && placedFixtureLabels.map(fx => {
        const iconInner = fx.icon ? getIconInner(fx.icon.id) : null;
        const lh = DISPLAY_MAP_SZ.name * 1.3;
        return (
          <g key={fx.key}>
            {iconInner && (
              <g
                transform={`translate(${fx.icon.x} ${fx.icon.y}) scale(${u(fx.icon.px) / 24})`}
                fill="none"
                stroke={fx.ink}
                strokeWidth={2}
                strokeLinecap="round"
                strokeLinejoin="round"
                dangerouslySetInnerHTML={{ __html: iconInner }}
              />
            )}
            {fx.text && (
              <text
                x={fx.text.cx}
                y={fx.text.cy - u(lh * (fx.text.lines.length - 1) / 2)}
                fontSize={u(DISPLAY_MAP_SZ.name)}
                fontWeight={500}
                fill={fx.ink}
                textAnchor="middle"
                dominantBaseline="central"
                fontFamily='"Noto Sans TC", sans-serif'
              >
                {fx.text.lines.map((ln, i) => (
                  <tspan key={i} x={fx.text.cx} dy={i ? u(lh) : 0}>
                    {ln}
                  </tspan>
                ))}
              </text>
            )}
          </g>
        );
      })}

      {/* Full mode seats */}
      {!mini && floorSeats.map(s => {
        const seatData = seatMap.get(s.code) || null;
        const st = computeSeatVisualState(seatData, { nowMs, soonMinutes, timeMode });
        if (st.cls === 'empty') {
          return (
            <circle
              key={`seat-${s.code}`}
              cx={s.x}
              cy={s.y}
              r={u(DISPLAY_MAP_SZ.dot)}
              fill="#FFFDF9"
              stroke="#D3CAC0"
              strokeWidth={u(3)}
            />
          );
        }
        return (
          <g
            key={`seat-${s.code}`}
            transform={`translate(${s.x},${s.y})`}
            data-testid={`display-seat-${s.code}`}
            data-seat-state={st.cls}
          >
            <rect
              x={-pillW / 2}
              y={-pillH / 2}
              width={pillW}
              height={pillH}
              rx={u(10)}
              fill={st.colors.bg}
              stroke={st.colors.bd}
              strokeWidth={u(2.5)}
              strokeDasharray={st.cls === 'booked' ? `${u(6)} ${u(5)}` : undefined}
            />
            <text
              x={0}
              y={-u(10)}
              textAnchor="middle"
              dominantBaseline="central"
              fontSize={u(DISPLAY_MAP_SZ.code)}
              fontWeight={800}
              fontFamily="Nunito, sans-serif"
              fill={st.colors.fg}
              opacity={0.8}
            >
              {s.code}
            </text>
            <text
              x={0}
              y={u(9)}
              textAnchor="middle"
              dominantBaseline="central"
              fontSize={u(DISPLAY_MAP_SZ.time)}
              fontWeight={800}
              fontFamily="Nunito, sans-serif"
              fill={st.colors.fg}
            >
              {st.timeText}
            </text>
            {st.hasBoard && (
              <g data-testid={`display-seat-board-${s.code}`}>
                <rect
                  x={pillW / 2 - u(14)}
                  y={-pillH / 2 - u(8)}
                  width={u(20)}
                  height={u(20)}
                  rx={u(5)}
                  fill="#D9A441"
                  stroke="#FFFDF9"
                  strokeWidth={u(2)}
                />
                <text
                  x={pillW / 2 - u(4)}
                  y={-pillH / 2 + u(2)}
                  textAnchor="middle"
                  dominantBaseline="central"
                  fontSize={u(12)}
                  fontWeight={700}
                  fill="#FFFDF9"
                  fontFamily='"Noto Sans TC", sans-serif'
                >
                  板
                </text>
              </g>
            )}
          </g>
        );
      })}

      {/* Entrance & Here capsules */}
      {!mini && renderTagCapsule(doorTag, 'entrance')}
      {!mini && renderTagCapsule(hereTag, 'here')}
    </svg>
  );
}
