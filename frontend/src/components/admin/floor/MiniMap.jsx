import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

/**
 * 全店縮圖（地圖色點）
 *
 * - layout: { tables[{id,label,cx,cy,w,h,rotation,zone_id}], seats[{code,table_id,lx,ly,is_active}], zones[{id,name}], elements_json? }
 * - seatStates: { [seatCode]: { state } }，state 為 buildSeatStates 的值：in_use | warn | over | paused | reserved | empty | off
 * - activeTableId: 目前捲到的桌子（scroll spy），縮圖上加框
 * - onTableClick(table): 點桌子時呼叫，由頁面捲到桌卡
 * - waitPax / waitingPaxCount: 等待區人數
 * - mapHeight: 地圖高度（px），預設 132
 *
 * 互動規則：
 * - 8 張桌子以內：不放大，直接顯示桌號，點桌子 → onTableClick。
 * - 超過 8 張：全圖只顯示色點和區域框，點區域 → 放大到點到的桌子＋同區另一張（取範圍最小的一對，保證兩張完整）。
 * - 放大後：沒完整顯示的桌子變淡；點變淡的桌子或灰色處 → 移過去；可拖曳；點完整的桌子 → onTableClick。
 * - 下方圖例同時是篩選，只列出有數量的狀態，一行左右滑。
 */

const DENSE_TABLES = 8;
const SEAT_PAD = 18; // 座位色點外圍（畫布單位），算桌子範圍時要包含座位
const ANIM_MS = 220;

const STATES = {
  in_use: { label: '使用中', fill: '#7E9A72', stroke: null },
  warn: { label: '快到時', fill: '#D9A441', stroke: null },
  over: { label: '超時', fill: '#B4553F', stroke: null },
  paused: { label: '暫停', fill: '#B3A79B', stroke: null },
  reserved: { label: '待入座', fill: '#FFFDF9', stroke: '#8B5B43' },
  empty: { label: '空位', fill: '#FFFDF9', stroke: '#CFC2B4' },
};
const ORDER = ['in_use', 'warn', 'over', 'paused', 'reserved', 'empty'];

function categoryOf(state) {
  switch (state) {
    case 'in_use': case 'run': return 'in_use';
    case 'warn': case 'expiring': return 'warn';
    case 'over': case 'overtime': return 'over';
    case 'paused': case 'pause': return 'paused';
    case 'reserved': case 'wait': case 'pending': case 'resv': return 'reserved';
    case 'off': return null; // 停用的座位不畫
    default: return 'empty';
  }
}

const boundsOf = (pts) => {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of pts) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
};
const unionBox = (boxes, pad = 0) => {
  const b = boundsOf(boxes.flatMap(r => [[r.x, r.y], [r.x + r.w, r.y + r.h]]));
  return { x: b.x - pad, y: b.y - pad, w: b.w + pad * 2, h: b.h + pad * 2 };
};
// 把範圍撐成跟畫面一樣的長寬比（置中）
const fitAspect = (b, ar) => {
  let { x, y, w, h } = b;
  if (!(ar > 0) || !(w > 0) || !(h > 0)) return b;
  if (w / h < ar) { const nw = h * ar; x -= (nw - w) / 2; w = nw; } else { const nh = w / ar; y -= (nh - h) / 2; h = nh; }
  return { x, y, w, h };
};
const grow = (b, k) => ({ x: b.x - b.w * (k - 1) / 2, y: b.y - b.h * (k - 1) / 2, w: b.w * k, h: b.h * k });
const contains = (vb, b) => b.x >= vb.x - 1 && b.y >= vb.y - 1 && b.x + b.w <= vb.x + vb.w + 1 && b.y + b.h <= vb.y + vb.h + 1;
const sameBox = (a, b) => a && b && ['x', 'y', 'w', 'h'].every(k => Math.abs(a[k] - b[k]) < 0.01);

export default function MiniMap({
  layout = {},
  seatStates = {},
  activeTableId = null,
  onTableClick = null,
  waitingPaxCount = 0,
  waitPax = null,
  mapHeight = 132,
  className = '',
}) {
  const effectiveWaitPax = waitPax != null ? waitPax : waitingPaxCount;
  const wrapRef = useRef(null);
  const svgRef = useRef(null);
  const [size, setSize] = useState({ w: 360, h: mapHeight });
  const [zoom, setZoom] = useState(null); // null = 全圖；{ box, zoneId } = 放大
  const [filter, setFilter] = useState(null);

  // ---- 量測畫面大小 ----
  useEffect(() => {
    const el = wrapRef.current; if (!el) return undefined;
    const update = () => setSize({ w: el.clientWidth || 360, h: el.clientHeight || mapHeight });
    update();
    const ro = new ResizeObserver(update); ro.observe(el);
    return () => ro.disconnect();
  }, [mapHeight]);

  // ---- 幾何：每張桌子的座位位置與範圍（含座位） ----
  const geo = useMemo(() => {
    const seats = layout.seats || [];
    const tables = (layout.tables || []).map((t) => {
      const rad = ((t.rotation || 0) * Math.PI) / 180; const cos = Math.cos(rad); const sin = Math.sin(rad);
      const at = (lx, ly) => [t.cx + lx * cos - ly * sin, t.cy + lx * sin + ly * cos];
      const tSeats = seats
        .filter(s => s.table_id === t.id && s.is_active !== false)
        .map((s) => { const [x, y] = at(s.lx || 0, s.ly || 0); return { code: s.code, x, y }; });
      const hw = (t.w || 60) / 2; const hh = (t.h || 60) / 2;
      const corners = [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]].map(([a, b]) => at(a, b));
      const box = boundsOf([...corners, ...tSeats.flatMap(s => [[s.x - SEAT_PAD, s.y - SEAT_PAD], [s.x + SEAT_PAD, s.y + SEAT_PAD]])]);
      return { raw: t, id: t.id, label: t.label, cx: t.cx, cy: t.cy, w: t.w || 60, h: t.h || 60, rotation: t.rotation || 0, zoneKey: t.zone_id ?? '__all', seats: tSeats, box };
    });
    const content = tables.length
      ? unionBox(tables.map(t => t.box), 16)
      : { x: 0, y: 0, w: layout.canvas_w || 1000, h: layout.canvas_h || 625 };
    const zoneName = new Map((layout.zones || []).map(z => [z.id, z.name]));
    const zoneBoxes = [];
    const byZone = new Map();
    tables.forEach((t) => { if (!byZone.has(t.zoneKey)) byZone.set(t.zoneKey, []); byZone.get(t.zoneKey).push(t); });
    byZone.forEach((list, key) => zoneBoxes.push({ key, name: zoneName.get(key) || '', box: unionBox(list.map(t => t.box), 10) }));
    return { tables, content, zoneBoxes, zoneName };
  }, [layout]);

  const dense = geo.tables.length > DENSE_TABLES;

  // 換平面圖、或變成不需要放大時，回到全圖
  useEffect(() => { setZoom(null); }, [layout.id]);
  useEffect(() => { if (!dense) setZoom(null); }, [dense]);

  // ---- 目前的 viewBox 與螢幕像素換算 ----
  const ar = size.w / size.h;
  // 全圖：桌子＋座位的實際範圍。超過 8 桌時，區域名稱標在框線上方，先多留一點高度給它。
  const fullBox = useMemo(() => {
    if (!dense) return geo.content;
    const s0 = Math.min(size.w / geo.content.w, size.h / geo.content.h) || 0.35;
    const labelSpace = 20 / s0;
    return unionBox([geo.content, ...geo.zoneBoxes.map(z => ({ ...z.box, y: z.box.y - labelSpace, h: z.box.h + labelSpace }))]);
  }, [dense, geo, size]);
  const vb = useMemo(() => fitAspect(zoom ? zoom.box : fullBox, ar), [zoom, fullBox, ar]);
  const scale = Math.min(size.w / vb.w, size.h / vb.h) || 0.35;
  const px = useCallback(n => n / scale, [scale]); // n 個螢幕像素 = 多少畫布單位

  // ---- viewBox 動畫：先畫到目標，再在 layout effect 裡從舊值補間 ----
  const shownVbRef = useRef(vb);
  const animateNextRef = useRef(false);
  useLayoutEffect(() => {
    const svg = svgRef.current; const from = shownVbRef.current; shownVbRef.current = vb;
    if (!svg || !animateNextRef.current || sameBox(from, vb)) { animateNextRef.current = false; return undefined; }
    animateNextRef.current = false;
    const reduce = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (reduce) return undefined;
    let raf = 0; const t0 = performance.now();
    const step = (now) => {
      const k = Math.min(1, (now - t0) / ANIM_MS); const e = 1 - Math.pow(1 - k, 3);
      const cur = ['x', 'y', 'w', 'h'].map(p => from[p] + (vb[p] - from[p]) * e);
      svg.setAttribute('viewBox', cur.join(' '));
      if (k < 1) raf = requestAnimationFrame(step);
    };
    svg.setAttribute('viewBox', `${from.x} ${from.y} ${from.w} ${from.h}`);
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [vb]);

  // ---- 放大到某一點：點到的桌子＋同區另一張，取範圍最小的一對 ----
  const focusAt = useCallback((p) => {
    if (!geo.tables.length) return;
    const t0 = geo.tables.reduce((best, t) => (Math.hypot(t.cx - p.x, t.cy - p.y) < Math.hypot(best.cx - p.x, best.cy - p.y) ? t : best));
    const mates = geo.tables.filter(t => t !== t0 && t.zoneKey === t0.zoneKey);
    const candidates = mates.length
      ? mates.map(m => fitAspect(unionBox([t0.box, m.box], 8), ar))
      : [fitAspect(unionBox([t0.box], 30), ar)];
    const target = candidates.reduce((a, b) => (a.w * a.h <= b.w * b.h ? a : b));
    animateNextRef.current = true;
    setZoom({ box: grow(target, 1.12), zoneId: t0.raw.zone_id ?? null }); // 1.12：留一點邊，讓旁邊的桌子露出來
  }, [geo.tables, ar]);

  const resetZoom = () => { animateNextRef.current = true; setZoom(null); };

  // ---- 拖曳（只在放大時）----
  const dragRef = useRef(null);
  const suppressClickRef = useRef(false);
  const onPointerDown = (e) => {
    if (!zoom || e.button > 0) return;
    const r = svgRef.current.getBoundingClientRect();
    dragRef.current = { id: e.pointerId, x: e.clientX, y: e.clientY, start: { ...vb }, k: Math.max(vb.w / r.width, vb.h / r.height), moved: false, cur: vb };
  };
  const onPointerMove = (e) => {
    const d = dragRef.current; if (!d || d.id !== e.pointerId) return;
    const dx = e.clientX - d.x; const dy = e.clientY - d.y;
    if (!d.moved) {
      if (Math.hypot(dx, dy) < 6) return;
      d.moved = true;
      // 開始拖曳後才 capture，否則單純點擊的 click 目標會變成 svg
      try { svgRef.current.setPointerCapture(e.pointerId); } catch { /* 部分瀏覽器不支援 */ }
    }
    d.cur = { ...d.start, x: d.start.x - dx * d.k, y: d.start.y - dy * d.k };
    svgRef.current.setAttribute('viewBox', `${d.cur.x} ${d.cur.y} ${d.cur.w} ${d.cur.h}`); // 拖曳中直接改屬性，不重畫整張圖
  };
  const endDrag = (e) => {
    const d = dragRef.current; if (!d || (e && d.id !== e.pointerId)) return;
    dragRef.current = null;
    if (!d.moved) return;
    suppressClickRef.current = true; setTimeout(() => { suppressClickRef.current = false; }, 60);
    const c = { x: d.cur.x + d.cur.w / 2, y: d.cur.y + d.cur.h / 2 };
    const near = geo.tables.reduce((best, t) => (Math.hypot(t.cx - c.x, t.cy - c.y) < Math.hypot(best.cx - c.x, best.cy - c.y) ? t : best));
    shownVbRef.current = d.cur;
    setZoom({ box: d.cur, zoneId: near.raw.zone_id ?? null });
  };

  const svgPoint = (e) => {
    const svg = svgRef.current; const pt = svg.createSVGPoint(); pt.x = e.clientX; pt.y = e.clientY;
    return pt.matrixTransform(svg.getScreenCTM().inverse());
  };

  const activate = (kind, payload, e) => {
    if (suppressClickRef.current) return;
    if (kind === 'table') { onTableClick?.(payload.raw); return; }
    if (kind === 'focus') focusAt(e ? svgPoint(e) : payload);
  };
  const keyActivate = (kind, payload) => (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate(kind, payload, null); }
  };

  // ---- 計數與篩選 ----
  const catOf = useCallback(code => categoryOf(seatStates[code]?.state), [seatStates]);
  const counts = useMemo(() => {
    const c = {}; geo.tables.forEach(t => t.seats.forEach((s) => { const k = catOf(s.code); if (k) c[k] = (c[k] || 0) + 1; }));
    return c;
  }, [geo.tables, catOf]);
  useEffect(() => { if (filter && !counts[filter]) setFilter(null); }, [counts, filter]);

  const zoomed = Boolean(zoom);
  const showLabels = !dense || zoomed;
  const zoneTitle = zoomed && zoom.zoneId != null ? geo.zoneName.get(zoom.zoneId) : null;
  const hint = zoomed ? '拖曳或點灰色處移動' : dense ? '點區域放大' : '點桌子跳到下方';
  const dotR = Math.min(16, px(5.5));
  const minHit = px(44); // 手指點擊範圍至少 44px

  return (
    <div className={`bg-sg-paper border border-sg-line rounded-2xl overflow-hidden select-none ${className}`}>
      {/* 標題列 */}
      <div className="flex items-center justify-between gap-2 px-3 pt-1.5 min-h-[32px]">
        <div className="flex items-center gap-1.5 min-w-0">
          {zoomed ? (
            <>
              <button type="button" onClick={resetZoom} className="shrink-0 rounded-full bg-sg-brown-soft px-2.5 py-1 text-[12px] font-bold text-sg-brown">
                ‹ 全店
              </button>
              {zoneTitle && (
                <>
                  <span aria-hidden="true" className="text-sg-muted text-[12px]">·</span>
                  <b className="truncate text-[13px] text-sg-ink">{zoneTitle}</b>
                </>
              )}
            </>
          ) : (
            <b className="text-[13px] text-sg-ink">全店縮圖</b>
          )}
        </div>
        <span className="shrink-0 text-[12px] text-sg-muted">{hint}</span>
      </div>

      {/* 地圖 */}
      <div ref={wrapRef} style={{ height: mapHeight }}>
        <svg
          ref={svgRef}
          className={`block w-full h-full ${zoomed ? 'cursor-grab' : ''}`}
          style={{ touchAction: zoomed ? 'none' : 'manipulation' }}
          viewBox={`${vb.x} ${vb.y} ${vb.w} ${vb.h}`}
          preserveAspectRatio="xMidYMid meet"
          role="img"
          aria-label="全店座位縮圖"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
        >
          {/* 牆、門、櫃台（淡淡的，只當參考） */}
          <g pointerEvents="none" opacity="0.6">
            {(layout.elements_json || layout.elements || []).map((el, i) => {
              if ((el.type === 'wall' || el.type === 'window') && el.points?.length > 1) {
                return <polyline key={el.id || i} points={el.points.map(p => p.join(',')).join(' ')} fill="none" stroke="#C9BFB4" strokeWidth={px(1.5)} strokeDasharray={el.type === 'window' ? `${px(4)} ${px(3)}` : undefined} />;
              }
              if (['door', 'counter', 'pillar'].includes(el.type)) {
                return <rect key={el.id || i} x={el.x} y={el.y} width={el.w} height={el.h} rx={px(3)} fill="#EEE9E3" transform={el.rotation ? `rotate(${el.rotation} ${el.x + el.w / 2} ${el.y + el.h / 2})` : undefined} />;
              }
              return null;
            })}
          </g>

          {/* 放大時：整片灰色處都可以點，畫面移過去 */}
          {zoomed && (
            <rect x={vb.x - vb.w * 4} y={vb.y - vb.h * 4} width={vb.w * 9} height={vb.h * 9} fill="transparent" data-pan="1"
              onClick={e => activate('focus', null, e)} />
          )}

          {/* 桌子與座位色點 */}
          {geo.tables.map((t) => {
            const dim = zoomed && !contains(vb, t.box);
            const cur = activeTableId === t.id;
            return (
              <g key={t.id} opacity={dim ? 0.38 : 1} pointerEvents="none" data-minimap-table={t.label}>
                <rect x={t.cx - t.w / 2} y={t.cy - t.h / 2} width={t.w} height={t.h} rx={Math.min(10, t.w / 4, t.h / 4)}
                  fill="#EADDCF" stroke={cur ? '#8B5B43' : 'none'} strokeWidth={px(2)}
                  transform={t.rotation ? `rotate(${t.rotation} ${t.cx} ${t.cy})` : undefined} />
                {t.seats.map((s) => {
                  const k = catOf(s.code); if (!k) return null;
                  const st = STATES[k];
                  return (
                    <circle key={s.code} cx={s.x} cy={s.y} r={dotR} fill={st.fill}
                      stroke={st.stroke || 'none'} strokeWidth={st.stroke ? px(1.5) : 0}
                      opacity={filter && filter !== k ? 0.18 : 1} />
                  );
                })}
                {showLabels && !dim && (
                  <text x={t.cx} y={t.cy} textAnchor="middle" dominantBaseline="central" fontSize={px(11)} fontWeight="700" fill="#3E332B">
                    {t.label}
                  </text>
                )}
              </g>
            );
          })}

          {/* 點擊範圍 */}
          {dense && !zoomed
            ? geo.zoneBoxes.map((z) => {
              const hitW = Math.max(z.box.w, minHit);
              const hitH = Math.max(z.box.h, minHit);
              return (
                <g key={z.key}>
                  <rect x={z.box.x} y={z.box.y} width={z.box.w} height={z.box.h} rx={px(10)} fill="none"
                    stroke="#8B5B43" strokeWidth={px(1)} strokeDasharray={`${px(4)} ${px(3)}`} pointerEvents="none" />
                  <rect
                    x={z.box.x + z.box.w / 2 - hitW / 2}
                    y={z.box.y + z.box.h / 2 - hitH / 2}
                    width={hitW}
                    height={hitH}
                    rx={px(10)}
                    fill="transparent"
                    role="button"
                    tabIndex={0}
                    aria-label={`放大 ${z.name || '這一區'}`}
                    className="cursor-pointer"
                    onClick={e => activate('focus', null, e)}
                    onKeyDown={keyActivate('focus', { x: z.box.x + z.box.w / 2, y: z.box.y + z.box.h / 2 })}
                  />
                  {z.name && (
                    <g pointerEvents="none">
                      <rect x={z.box.x + px(6)} y={z.box.y - px(17)} width={px(11) * z.name.length + px(10)} height={px(16)} rx={px(8)} fill="#FFFDF9" />
                      <text x={z.box.x + px(11)} y={z.box.y - px(9)} dominantBaseline="central" fontSize={px(11)} fontWeight="700" fill="#8B5B43">{z.name}</text>
                    </g>
                  )}
                </g>
              );
            })
            : geo.tables.filter(t => !zoomed || contains(vb, t.box)).map((t) => {
              const w = Math.max(t.box.w, minHit);
              const h = Math.max(t.box.h, minHit);
              return (
                <rect key={`hit-${t.id}`} x={t.box.x + t.box.w / 2 - w / 2} y={t.box.y + t.box.h / 2 - h / 2} width={w} height={h}
                  fill="transparent" role="button" tabIndex={0} aria-label={`${t.label}，跳到桌卡`} className="cursor-pointer"
                  data-table={t.id}
                  onClick={e => activate('table', t, e)} onKeyDown={keyActivate('table', t)} />
              );
            })}
        </svg>
      </div>

      {/* 圖例＝篩選（只列有數量的狀態，一行左右滑） */}
      <div className="flex items-center gap-1 overflow-x-auto px-2 pb-2 pt-1" role="group" aria-label="狀態篩選">
        {ORDER.filter(k => counts[k]).map((k) => {
          const st = STATES[k]; const on = filter === k;
          return (
            <button key={k} type="button" aria-pressed={on}
              onClick={() => setFilter(f => (f === k ? null : k))}
              className={`inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 min-h-[32px] text-[12px] text-sg-ink ${on ? 'border-sg-brown bg-sg-brown-soft font-bold' : 'border-transparent'}`}>
              <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: st.fill, boxShadow: st.stroke ? `inset 0 0 0 1.5px ${st.stroke}` : 'none' }} />
              {st.label} <span className="font-num">{counts[k]}</span>
            </button>
          );
        })}
        <button type="button"
          onClick={() => document.getElementById('waiting-area-section')?.scrollIntoView({ behavior: 'smooth' })}
          className="ml-auto inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border border-sg-line bg-white px-2.5 min-h-[32px] text-[12px] font-bold text-sg-brown">
          <span className="h-2 w-2 rounded-full bg-sg-honey" />等待區 <span className="font-num">{effectiveWaitPax}</span>
        </button>
      </div>
    </div>
  );
}
