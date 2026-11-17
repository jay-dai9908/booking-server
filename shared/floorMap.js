// shared/floorMap.js
import { resolveLayoutGeometry } from './allocator/geometry.js';

export const VALID_SHOWS = ['shape', 'name', 'icon', 'icon_name', 'hidden'];
export const VALID_ICONS = [
  'sofa', 'counter', 'iron', 'beads', 'locker', 'shelf', 'toilet',
  'sink', 'water', 'trash', 'bag', 'entrance', 'exit', 'stairs', 'ac', ''
];
export const VALID_COLORS = [
  'grey', 'brown', 'coral', 'blue', 'honey', 'sage', 'lavender', 'pink'
];
export const VALID_PATTERNS = ['none', 'beads'];
export const VALID_ROTATIONS = [0, 90, 180, 270];

/**
 * 依中心點、寬、高與旋轉角度（順時針度數）計算四個角座標
 * 順序：左上、右上、右下、左下
 */
export function calcRectCorners(cx, cy, w, h, rotDeg = 0) {
  const hw = w / 2;
  const hh = h / 2;
  const rad = (rotDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const local = [
    [-hw, -hh],
    [hw, -hh],
    [hw, hh],
    [-hw, hh]
  ];
  return local.map(([lx, ly]) => [
    Math.round(cx + lx * cos - ly * sin),
    Math.round(cy + lx * sin + ly * cos)
  ]);
}

/**
 * 從 SeatLayout 物件產生符合通訊協定第 8 節的座位地圖 JSON 結構
 * 純函式，前後端共用
 * @param {object} rawLayout - SeatLayout 資料庫記錄或草稿物件
 * @returns {object} floor_map
 */
export function buildFloorMap(rawLayout = {}) {
  let layout = rawLayout;
  // 解析 JSON 欄位（若為字串）
  let elements = [];
  if (Array.isArray(layout.elements_json)) {
    elements = layout.elements_json;
  } else if (typeof layout.elements_json === 'string') {
    try {
      elements = JSON.parse(layout.elements_json);
    } catch {
      elements = [];
    }
  }

  // 確保座位幾何位置（abs_x, abs_y）已計算
  const rawSeats = layout.seats || [];
  const needsGeometry = rawSeats.some(s => s.abs_x === undefined || s.abs_y === undefined);
  if (needsGeometry && typeof resolveLayoutGeometry === 'function') {
    layout = resolveLayoutGeometry({ ...layout, elements_json: elements });
  }

  const rawTables = layout.tables || [];
  // 桌子依 sort_order 排序
  const sortedTables = [...rawTables].sort(
    (a, b) => (Number(a.sort_order) || 0) - (Number(b.sort_order) || 0)
  );

  // 處理 shapes
  const shapes = [];
  let entranceDoorElem = null;
  let firstDoorElem = null;

  for (const el of elements) {
    const elType = el.type || el.kind;
    const isDoor = elType === 'door';

    if (isDoor) {
      if (!firstDoorElem) firstDoorElem = el;
      if (el.kiosk?.entrance) {
        entranceDoorElem = el;
      }
    }

    if (elType === 'wall' || elType === 'window') {
      const pts = (el.points || []).map(p => [Math.round(p[0]), Math.round(p[1])]);
      shapes.push({
        kind: elType === 'window' ? 'window' : 'wall',
        closed: false,
        pts,
        label: '',
        show: 'shape',
        color: 'grey',
        pattern: 'none',
        icon: ''
      });
    } else if (elType === 'pillar' || elType === 'door' || elType === 'counter' || elType === 'fixture') {
      const cx = el.cx !== undefined ? Number(el.cx) : (Number(el.x || 0) + Number(el.w || 0) / 2);
      const cy = el.cy !== undefined ? Number(el.cy) : (Number(el.y || 0) + Number(el.h || 0) / 2);
      const w = Number(el.w || 0);
      const h = Number(el.h || 0);
      const rot = Number(el.rotation || 0);
      const pts = calcRectCorners(cx, cy, w, h, rot);

      const kind = (elType === 'counter' || elType === 'fixture') ? 'fixture' : elType;

      if (kind === 'pillar' || kind === 'door') {
        shapes.push({
          kind,
          closed: true,
          pts,
          label: '',
          show: 'shape',
          color: 'grey',
          pattern: 'none',
          icon: ''
        });
      } else {
        // fixture: 依照名稱套用預設值或以 kiosk 物件覆蓋
        const name = (el.label || '').trim();
        let defShow = 'shape';
        let defIcon = '';
        let defColor = 'grey';
        let defPattern = 'none';

        if (name === '櫃檯') {
          defShow = 'icon_name';
          defIcon = 'counter';
          defColor = 'brown';
        } else if (name === '燙豆區') {
          defShow = 'icon_name';
          defIcon = 'iron';
          defColor = 'coral';
        } else if (name === '沙發') {
          defShow = 'icon_name';
          defIcon = 'sofa';
          defColor = 'blue';
        } else if (name === '拼豆牆') {
          defShow = 'name';
          defIcon = '';
          defColor = 'honey';
          defPattern = 'beads';
        }

        const k = el.kiosk || {};
        shapes.push({
          kind: 'fixture',
          closed: true,
          pts,
          label: el.label || '',
          show: k.show || defShow,
          color: k.color || defColor,
          pattern: k.pattern || defPattern,
          icon: k.icon !== undefined ? k.icon : defIcon
        });
      }
    }
  }

  // 處理 tables
  const tables = sortedTables.map(t => {
    const cx = Number(t.cx || 0);
    const cy = Number(t.cy || 0);
    const w = Number(t.w || 0);
    const h = Number(t.h || 0);
    const rot = Number(t.rotation || 0);
    return {
      label: t.label || '',
      pts: calcRectCorners(cx, cy, w, h, rot)
    };
  });

  // 處理 seats：只包含啟用中的座位
  const activeSeats = (layout.seats || []).filter(s => s.is_active !== false);
  const seats = activeSeats.map(s => {
    const tIndex = sortedTables.findIndex(t =>
      t.id === s.table_id ||
      String(t.id) === String(s.table_id) ||
      (t.key && (t.key === s.table_key || t.key === s.table_id))
    );
    return {
      code: s.code,
      x: Math.round(Number(s.abs_x ?? s.lx ?? 0)),
      y: Math.round(Number(s.abs_y ?? s.ly ?? 0)),
      table: tIndex >= 0 ? tIndex : -1
    };
  });

  // 決定入口 door 中心點
  const targetDoor = entranceDoorElem || firstDoorElem;
  let doorCenter = [0, 0];
  if (targetDoor) {
    const dcx = targetDoor.cx !== undefined
      ? Number(targetDoor.cx)
      : (Number(targetDoor.x || 0) + Number(targetDoor.w || 0) / 2);
    const dcy = targetDoor.cy !== undefined
      ? Number(targetDoor.cy)
      : (Number(targetDoor.y || 0) + Number(targetDoor.h || 0) / 2);
    doorCenter = [Math.round(dcx), Math.round(dcy)];
  }

  // 找出所有幾何點的最左、最上作為原點偏移
  const allPoints = [];
  for (const s of shapes) {
    for (const p of s.pts) allPoints.push(p);
  }
  for (const t of tables) {
    for (const p of t.pts) allPoints.push(p);
  }
  for (const st of seats) {
    allPoints.push([st.x, st.y]);
  }
  if (targetDoor) {
    allPoints.push(doorCenter);
  }

  let minX = 0;
  let minY = 0;
  let maxX = layout.canvas_w || 0;
  let maxY = layout.canvas_h || 0;

  if (allPoints.length > 0) {
    minX = Math.min(...allPoints.map(p => p[0]));
    minY = Math.min(...allPoints.map(p => p[1]));
    maxX = Math.max(...allPoints.map(p => p[0]));
    maxY = Math.max(...allPoints.map(p => p[1]));
  }

  // 平移所有點
  for (const s of shapes) {
    s.pts = s.pts.map(p => [Math.round(p[0] - minX), Math.round(p[1] - minY)]);
  }
  for (const t of tables) {
    t.pts = t.pts.map(p => [Math.round(p[0] - minX), Math.round(p[1] - minY)]);
  }
  for (const st of seats) {
    st.x = Math.round(st.x - minX);
    st.y = Math.round(st.y - minY);
  }
  const translatedDoor = [
    Math.round(doorCenter[0] - minX),
    Math.round(doorCenter[1] - minY)
  ];

  const w = Math.round(maxX - minX);
  const h = Math.round(maxY - minY);

  // version 格式：L<版面 id>-<發布時間的 unix 秒>
  const pubTime = layout.published_at || layout.updated_at || Date.now();
  const unixSec = Math.floor(new Date(pubTime).getTime() / 1000);
  const version = `L${layout.id || 'draft'}-${unixSec}`;

  const rotation = Number(layout.kiosk_map_rotation) || 0;

  return {
    version,
    w,
    h,
    rotation,
    door: translatedDoor,
    shapes,
    tables,
    seats
  };
}
