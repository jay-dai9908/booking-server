// frontend/src/utils/display/mapMarkers.js
import { bbox, rotateFloorMap } from '../../../../shared/floorMapLayout.js';

export const DISPLAY_MAP_SZ = {
  name: 23,
  table: 20,
  icon: 28,
  tag: 23,
  wall: 5,
  glass: 5,
  pillW: 56,
  pillH: 48,
  code: 12.5,
  time: 19,
  dot: 8
};

export const DISPLAY_PAD = 30;
export const DISPLAY_MAP_BOX = { w: 1282, h: 748 };

/**
 * Compute inward center position for the entrance capsule so it stays inside the room away from wall lines.
 */
export function inwardTagPosition(doorPt, dims, roomW, roomH, u, gapPx = DISPLAY_MAP_SZ.wall * 2 + 16) {
  const [x, y] = doorPt || [roomW / 2, roomH];
  const cx = roomW / 2;
  const cy = roomH / 2;
  const dx = cx - x;
  const dy = cy - y;
  const signX = dx >= 0 ? 1 : -1;
  const signY = dy >= 0 ? 1 : -1;

  if (roomW > 0 && roomH > 0 && Math.abs(dx) / roomW > Math.abs(dy) / roomH) {
    return [x + signX * u(dims.w / 2 + gapPx), y];
  }
  return [x, y + signY * u(dims.h / 2 + gapPx)];
}

/**
 * Find the fixture shape matching here_element.
 * Supports element id, "kind:label", "type+label", or label match.
 */
export function findHereShape(shapes = [], hereElement = '') {
  if (!hereElement || !Array.isArray(shapes)) return null;
  const target = String(hereElement).trim();
  if (!target) return null;

  for (const s of shapes) {
    if (s.show === 'hidden') continue;
    if (s.id !== undefined && s.id !== null && String(s.id) === target) return s;
    if (s.element_id !== undefined && s.element_id !== null && String(s.element_id) === target) return s;
  }

  for (const s of shapes) {
    if (s.show === 'hidden') continue;
    const label = (s.label || '').trim();
    const kind = s.kind || s.type || '';
    if (!label) continue;
    if (`${kind}:${label}` === target || `${kind}+${label}` === target || `${kind}|${label}` === target) {
      return s;
    }
    if (s.type && (`${s.type}:${label}` === target || `${s.type}+${label}` === target)) {
      return s;
    }
  }

  for (const s of shapes) {
    if (s.show === 'hidden') continue;
    if (s.kind === 'fixture' && (s.label || '').trim() === target) return s;
  }

  return null;
}

/**
 * Compute position for the "你在這裡" capsule next to the target fixture, toward the room interior.
 */
export function computeHereTagPosition(shapeBox, dims, roomW, roomH, u, pad = DISPLAY_PAD) {
  if (!shapeBox) return null;
  const side = shapeBox.cx < roomW / 2 ? 1 : -1;
  const offset = u(dims.w / 2 + 16);
  let cx = side > 0 ? shapeBox.x2 + offset : shapeBox.x1 - offset;
  const halfW = u(dims.w / 2);
  const halfH = u(dims.h / 2);

  cx = Math.max(-pad + halfW + u(4), Math.min(cx, roomW + pad - halfW - u(4)));
  const cy = Math.max(-pad + halfH + u(4), Math.min(shapeBox.cy, roomH + pad - halfH - u(4)));

  return { cx, cy, side };
}

/**
 * Compute rotated map geometry + entrance capsule + optional "你在這裡" marker + fixture label placements.
 */
export function computeDisplayMapData({
  floor,
  rotation = 0,
  hereElement = '',
  box = DISPLAY_MAP_BOX,
  pad = DISPLAY_PAD,
  measureText = null,
  mini = false
} = {}) {
  if (!floor) return null;
  const rotated = rotateFloorMap(floor, rotation);
  const roomW = Number(rotated.w) || 720;
  const roomH = Number(rotated.h) || 1167;
  const vbW = roomW + pad * 2;
  const vbH = roomH + pad * 2;
  const k = Math.min(box.w / vbW, box.h / vbH);
  const u = px => px / k;

  const tw = (text, px = DISPLAY_MAP_SZ.name, weight = 500) => {
    if (typeof measureText === 'function') {
      return measureText(text, px, weight);
    }
    return [...String(text || '')].reduce((sum, ch) => sum + (ch.charCodeAt(0) > 255 ? px : px * 0.6), 0);
  };

  const shapes = (rotated.shapes || []).map((s, idx) => ({
    ...s,
    _idx: idx,
    _box: bbox(s.pts || [])
  }));

  const tables = (rotated.tables || []).map((t, idx) => ({
    ...t,
    _idx: idx,
    _box: bbox(t.pts || [])
  }));

  const doorPt = rotated.door || [roomW / 2, roomH];

  if (mini) {
    return {
      floor: rotated,
      roomW,
      roomH,
      vbW,
      vbH,
      pad,
      k,
      u,
      shapes,
      tables,
      seats: rotated.seats || [],
      doorPt,
      doorTag: null,
      hereTag: null,
      placedFixtures: []
    };
  }

  const obstacles = [];
  for (const s of shapes) {
    if (s.show === 'hidden') continue;
    if (s.kind === 'fixture' || s.kind === 'pillar') {
      obstacles.push(s._box);
    }
  }
  for (const t of tables) {
    const b = t._box;
    obstacles.push({
      x1: b.x1 - u(DISPLAY_MAP_SZ.pillH / 2),
      y1: b.y1 - u(DISPLAY_MAP_SZ.pillH / 2),
      x2: b.x2 + u(DISPLAY_MAP_SZ.pillH / 2),
      y2: b.y2 + u(DISPLAY_MAP_SZ.pillH / 2)
    });
  }

  const tagDims = (label, hasIcon) => {
    const is = hasIcon ? DISPLAY_MAP_SZ.icon * 0.8 : 0;
    const gap = hasIcon ? 6 : 0;
    const textW = tw(label, DISPLAY_MAP_SZ.tag, 700);
    return {
      is,
      gap,
      textW,
      w: is + gap + textW + 34,
      h: DISPLAY_MAP_SZ.tag + 22
    };
  };

  const entranceDims = tagDims('入口', true);
  const [tx, ty] = inwardTagPosition(doorPt, entranceDims, roomW, roomH, u, DISPLAY_MAP_SZ.wall * 2 + 16);
  const doorTag = {
    label: '入口',
    icon: 'entrance',
    color: '#8B5B43',
    cx: tx,
    cy: ty,
    dims: entranceDims,
    box: {
      x1: tx - u(entranceDims.w) / 2,
      y1: ty - u(entranceDims.h) / 2,
      x2: tx + u(entranceDims.w) / 2,
      y2: ty + u(entranceDims.h) / 2
    }
  };
  obstacles.push(doorTag.box);

  let hereTag = null;
  const hereShape = Number.isInteger(floor.here_index)
    ? (floor.here_index >= 0 ? shapes[floor.here_index] || null : null)
    : findHereShape(shapes, hereElement);
  if (hereShape) {
    const hereDims = tagDims('你在這裡', true);
    const pos = computeHereTagPosition(hereShape._box, hereDims, roomW, roomH, u, pad);
    if (pos) {
      hereTag = {
        label: '你在這裡',
        icon: '__pin',
        color: '#C08C2E',
        cx: pos.cx,
        cy: pos.cy,
        dims: hereDims,
        shape: hereShape,
        box: {
          x1: pos.cx - u(hereDims.w) / 2,
          y1: pos.cy - u(hereDims.h) / 2,
          x2: pos.cx + u(hereDims.w) / 2,
          y2: pos.cy + u(hereDims.h) / 2
        }
      };
      obstacles.push(hereTag.box);
    }
  }

  return {
    floor: rotated,
    roomW,
    roomH,
    vbW,
    vbH,
    pad,
    k,
    u,
    tw,
    shapes,
    tables,
    seats: rotated.seats || [],
    doorPt,
    doorTag,
    hereTag,
    obstacles
  };
}
