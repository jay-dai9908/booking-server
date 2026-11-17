// shared/floorMapLayout.js

export const SZ = {
  name: 13,
  table: 12,
  icon: 16,
  tag: 13,
  seat: 4,
  mine: 7,
  wall: 3,
  glass: 2.5
};

export const PAL = {
  grey: ['#E9E6E1', '#7D736A'],
  brown: ['#E9D6C6', '#7A4F3A'],
  coral: ['#F5DDD2', '#8A4A36'],
  blue: ['#DCE4EC', '#4F6577'],
  honey: ['#F4E4C4', '#7D5718'],
  sage: ['#DFE9D9', '#52704A'],
  lavender: ['#E6E0EE', '#5E5378'],
  pink: ['#F6DDE3', '#8A4057']
};

export const ACCENT = '#5F7A55';
export const BROWN = '#8B5B43';
export const PAD = 24; // cm around walls

export function bbox(pts = []) {
  if (!pts || pts.length === 0) {
    return { x1: 0, x2: 0, y1: 0, y2: 0, cx: 0, cy: 0, w: 0, h: 0 };
  }
  const xs = pts.map(p => p[0]);
  const ys = pts.map(p => p[1]);
  const x1 = Math.min(...xs);
  const x2 = Math.max(...xs);
  const y1 = Math.min(...ys);
  const y2 = Math.max(...ys);
  return {
    x1,
    x2,
    y1,
    y2,
    cx: (x1 + x2) / 2,
    cy: (y1 + y2) / 2,
    w: x2 - x1,
    h: y2 - y1
  };
}

/**
 * 將名稱依每行最多 per 個字做平均換行；若名稱內已有 \n 則照 \n 換行
 * @param {string} name
 * @param {number} per
 * @returns {string[]}
 */
export function wrap(name, per = 99) {
  if (!name) return [];
  if (name.includes('\n')) return name.split('\n');
  const ch = [...name];
  const p = Math.max(1, per);
  const lines = Math.ceil(ch.length / p);
  const each = Math.ceil(ch.length / lines);
  const out = [];
  for (let i = 0; i < ch.length; i += each) {
    out.push(ch.slice(i, i + each).join(''));
  }
  return out;
}

/**
 * 依旋轉角度順時針旋轉整個座位地圖幾何
 * @param {object} map
 * @param {number} [rotationOverride]
 * @returns {object}
 */
export function rotateFloorMap(map, rotationOverride = null) {
  if (!map) return map;
  const rot = ((rotationOverride !== null ? rotationOverride : (map.rotation || 0)) % 360 + 360) % 360;
  if (rot === 0) return map;

  const w = Number(map.w) || 0;
  const h = Number(map.h) || 0;

  const transformPt = (x, y) => {
    if (rot === 90) return [h - y, x];
    if (rot === 180) return [w - x, h - y];
    if (rot === 270) return [y, w - x];
    return [x, y];
  };

  const newW = (rot === 90 || rot === 270) ? h : w;
  const newH = (rot === 90 || rot === 270) ? w : h;

  const newDoor = map.door ? transformPt(map.door[0], map.door[1]) : [0, 0];

  const newShapes = (map.shapes || []).map(s => ({
    ...s,
    pts: (s.pts || []).map(p => transformPt(p[0], p[1]))
  }));

  const newTables = (map.tables || []).map(t => ({
    ...t,
    pts: (t.pts || []).map(p => transformPt(p[0], p[1]))
  }));

  const newSeats = (map.seats || []).map(s => {
    const [nx, ny] = transformPt(s.x, s.y);
    return { ...s, x: nx, y: ny };
  });

  return {
    ...map,
    w: newW,
    h: newH,
    rotation: 0,
    door: newDoor,
    shapes: newShapes,
    tables: newTables,
    seats: newSeats
  };
}

/**
 * 計算標籤擺放位置（照 phone-map-template.html 演算法）
 * @param {object} params
 * @param {object} params.floor - 已套用旋轉的地圖資料
 * @param {string[]} params.seatCodes - 欲標示的座位代號
 * @param {number} params.containerWidth - 容器寬度（CSS 像素）
 * @param {function} [params.measureText] - 文字寬度量測函式 (text, fontSize, fontWeight) => width
 * @returns {object} layoutResult
 */
export function computeFloorLayout({
  floor,
  seatCodes = [],
  containerWidth = 320,
  measureText = null
}) {
  const rotatedFloor = rotateFloorMap(floor);
  const W = Math.max(10, containerWidth - 12);
  const roomW = rotatedFloor.w || 720;
  const roomH = rotatedFloor.h || 1160;
  const vbW = roomW + PAD * 2;
  const vbH = roomH + PAD * 2;
  const k = W / vbW; // CSS px per cm
  const u = px => px / k; // px -> cm

  const tw = (text, size, weight = 500) => {
    if (typeof measureText === 'function') {
      return measureText(text, size, weight);
    }
    // 預設以每個字 13px 估算（中文等寬 13px，英數字約 8px）
    return [...String(text)].reduce((sum, ch) => sum + (ch.charCodeAt(0) > 255 ? 13 : 8), 0);
  };

  const mine = new Set(seatCodes || []);
  const mineSeats = (rotatedFloor.seats || []).filter(s => mine.has(s.code));
  const mineTables = new Set(mineSeats.map(s => s.table));

  const obstacles = [];

  // 1. Shapes obstacles (fixtures & pillars)
  const labelsToPlace = [];
  (rotatedFloor.shapes || []).forEach(s => {
    if (s.show === 'hidden') return;
    if (s.kind === 'fixture' || s.kind === 'pillar') {
      const b = bbox(s.pts);
      obstacles.push({ x1: b.x1, y1: b.y1, x2: b.x2, y2: b.y2 });
      if (s.kind === 'fixture') {
        const [, ink] = PAL[s.color] || PAL.grey;
        labelsToPlace.push({ shape: s, b, ink });
      }
    }
  });

  // 2. Tables obstacles
  (rotatedFloor.tables || []).forEach(t => {
    const b = bbox(t.pts);
    obstacles.push({
      x1: b.x1 - u(6),
      y1: b.y1 - u(6),
      x2: b.x2 + u(6),
      y2: b.y2 + u(6)
    });
  });

  // 3. Entrance tag obstacle
  const doorPt = rotatedFloor.door || [roomW / 2, roomH];
  const entranceTagW = tw('入口', SZ.tag, 700) + 18;
  const entranceTagH = SZ.tag + 10;
  let entranceLeft = doorPt[0] - u(entranceTagW) / 2;
  entranceLeft = Math.max(-PAD + u(2), Math.min(entranceLeft, roomW + PAD - u(entranceTagW) - u(2)));
  const entranceTop = doorPt[1] - u(6) - u(entranceTagH + 6);
  const entranceTagBox = {
    x1: entranceLeft,
    y1: Math.min(entranceTop, entranceTop - u(6)),
    x2: entranceLeft + u(entranceTagW),
    y2: entranceTop + u(entranceTagH + 6)
  };
  obstacles.push(entranceTagBox);

  // 4. Place fixture marks (smallest shape first)
  labelsToPlace.sort((p, q) => p.b.w * p.b.h - q.b.w * q.b.h);
  const placedLabels = [];

  labelsToPlace.forEach(({ shape: s, b, ink }) => {
    const wantIcon = (s.show === 'icon' || s.show === 'icon_name') && Boolean(s.icon);
    const name = (s.show === 'name' || s.show === 'icon_name') && s.label ? s.label : '';
    if (!wantIcon && !name) return;

    const w = b.w * k;
    const h = b.h * k;
    const is = wantIcon ? SZ.icon : 0;
    const gap = wantIcon && name ? 4 : 0;
    const lh = SZ.name * 1.3;
    const cw = tw('字', SZ.name, 500) || 13;
    const nameW = name ? Math.max(...name.split('\n').map(l => tw(l, SZ.name, 500))) : 0;
    const hasBreak = name.includes('\n');
    const inside = s.pattern !== 'beads';

    // 1. One row inside
    if (inside && !hasBreak && is + gap + nameW <= w - 6 && Math.max(is, SZ.name) <= h - 6) {
      const startX = b.cx - u(is + gap + nameW) / 2;
      placedLabels.push({
        shape: s,
        placement: 'inside_row',
        ink,
        box: b,
        iconPos: wantIcon ? { x: startX, y: b.cy - u(is) / 2, size: is } : null,
        textPos: name ? { lines: [name], cx: startX + u(is + gap + nameW / 2), cy: b.cy } : null
      });
      return;
    }

    // 2. Icon over wrapped name, inside
    const lines = name ? wrap(name, Math.floor((w - 4) / cw)) : [];
    const blockW = Math.max(is, ...lines.map(l => tw(l, SZ.name, 500)), 0);
    const blockH = is + (wantIcon && name ? 3 : 0) + lines.length * lh;
    if (inside && blockW <= w - 4 && blockH <= h - 4) {
      let y = b.cy - u(blockH) / 2;
      let iconPos = null;
      if (wantIcon) {
        iconPos = { x: b.cx - u(is) / 2, y, size: is };
        y += u(is + 3);
      }
      const textPos = name ? { lines, cx: b.cx, cy: y + u(lines.length * lh) / 2 } : null;
      placedLabels.push({
        shape: s,
        placement: 'inside_stacked',
        ink,
        box: b,
        iconPos,
        textPos
      });
      return;
    }

    // 3. Outside
    const midX = roomW / 2;
    const midY = roomH / 2;
    const cands = [];
    const row = name ? wrap(name, 99) : [];
    const rowTW = name ? tw(row[0] || '', SZ.name, 500) : 0;
    const rowW = is + gap + rowTW;
    const rowH = Math.max(is, lh);

    const side4 = name ? wrap(name, 4) : [];
    const sideTW = Math.max(0, ...side4.map(l => tw(l, SZ.name, 500)));
    const sideW = is + gap + sideTW;
    const sideH = Math.max(is, side4.length * lh);

    const rowAt = (x, y) => ({
      x1: x,
      y1: y - u(rowH) / 2,
      x2: x + u(rowW),
      y2: y + u(rowH) / 2,
      build() {
        return {
          shape: s,
          placement: 'outside',
          ink,
          box: { x1: x, y1: y - u(rowH) / 2, x2: x + u(rowW), y2: y + u(rowH) / 2 },
          iconPos: wantIcon ? { x, y: y - u(is) / 2, size: is } : null,
          textPos: name ? { lines: row, cx: x + u(is + gap + rowTW / 2), cy: y } : null
        };
      }
    });

    const sideAt = (x) => ({
      x1: x,
      y1: b.cy - u(sideH) / 2,
      x2: x + u(sideW),
      y2: b.cy + u(sideH) / 2,
      build() {
        return {
          shape: s,
          placement: 'outside',
          ink,
          box: { x1: x, y1: b.cy - u(sideH) / 2, x2: x + u(sideW), y2: b.cy + u(sideH) / 2 },
          iconPos: wantIcon ? { x, y: b.cy - u(is) / 2, size: is } : null,
          textPos: name ? { lines: side4, cx: x + u(is + gap + sideTW / 2), cy: b.cy } : null
        };
      }
    });

    const stackAt = (top) => {
      const ls = name ? wrap(name, Math.max(1, Math.floor((w - 2) / cw))) : [];
      const hgt = is + (wantIcon && name ? 3 : 0) + ls.length * lh;
      const y0 = top === 'below' ? b.y2 + u(4) : b.y1 - u(4 + hgt);
      const bw = Math.max(is, ...ls.map(l => tw(l, SZ.name, 500)), 0);
      return {
        x1: b.cx - u(bw) / 2,
        y1: y0,
        x2: b.cx + u(bw) / 2,
        y2: y0 + u(hgt),
        build() {
          let y = y0;
          let iconPos = null;
          if (wantIcon) {
            iconPos = { x: b.cx - u(is) / 2, y, size: is };
            y += u(is + 3);
          }
          const textPos = name ? { lines: ls, cx: b.cx, cy: y + u(ls.length * lh) / 2 } : null;
          return {
            shape: s,
            placement: 'outside',
            ink,
            box: { x1: b.cx - u(bw) / 2, y1: y0, x2: b.cx + u(bw) / 2, y2: y0 + u(hgt) },
            iconPos,
            textPos
          };
        }
      };
    };

    const toMid = b.cy < midY ? ['below', 'above'] : ['above', 'below'];
    const lr = b.cx < midX ? ['right', 'left'] : ['left', 'right'];
    const vert = v => v === 'below'
      ? rowAt(b.cx - u(rowW) / 2, b.y2 + u(4 + rowH / 2))
      : rowAt(b.cx - u(rowW) / 2, b.y1 - u(4 + rowH / 2));
    const horiz = v => v === 'right'
      ? sideAt(b.x2 + u(5))
      : sideAt(b.x1 - u(5 + sideW));

    if (b.w >= b.h) {
      toMid.forEach(v => cands.push(vert(v)));
      toMid.forEach(v => cands.push(stackAt(v)));
      lr.forEach(v => cands.push(horiz(v)));
    } else {
      lr.forEach(v => cands.push(horiz(v)));
      toMid.forEach(v => cands.push(vert(v)));
    }

    const inRoom = r =>
      r.x1 >= -PAD + u(1) &&
      r.x2 <= roomW + PAD - u(1) &&
      r.y1 >= -PAD + u(1) &&
      r.y2 <= roomH + PAD - u(1);

    const overlap = r => obstacles.reduce((sum, o) => {
      if (o.x1 === b.x1 && o.y1 === b.y1) return sum;
      const xOverlap = Math.max(0, Math.min(r.x2, o.x2) - Math.max(r.x1, o.x1));
      const yOverlap = Math.max(0, Math.min(r.y2, o.y2) - Math.max(r.y1, o.y1));
      return sum + xOverlap * yOverlap;
    }, 0);

    const pick = cands.find(r => inRoom(r) && overlap(r) === 0)
      || cands.filter(inRoom).sort((p, q) => overlap(p) - overlap(q))[0]
      || cands[0];

    placedLabels.push(pick.build());
    obstacles.push(pick);
  });

  return {
    floor: rotatedFloor,
    vbW,
    vbH,
    k,
    u,
    mineSeats,
    mineTables,
    placedLabels,
    obstacles,
    doorPt,
    entranceTagBox
  };
}
