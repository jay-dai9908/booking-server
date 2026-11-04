// shared/allocator/geometry.js
// 左右側判斷、相鄰、對面、旋轉與座標計算（純函式）

/**
 * 旋轉一個點（度數，順時針）
 * @param {number} x
 * @param {number} y
 * @param {number} degrees
 * @returns {[number, number]}
 */
export function rotatePoint(x, y, degrees) {
  const rad = (degrees * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  return [x * cos - y * sin, x * sin + y * cos];
}

/**
 * 判斷桌子的長邊方向
 * @param {{ w: number, h: number }} table
 * @returns {'y' | 'x'}
 */
export function getTableLongAxis(table) {
  const w = Number(table?.w) || 60;
  const h = Number(table?.h) || 150;
  return h >= w ? 'y' : 'x';
}

/**
 * 側邊顯示文字
 * @param {'y' | 'x'} longAxis
 * @param {'L' | 'R' | null} side
 * @returns {string}
 */
export function getSideLabel(longAxis, side) {
  if (!side) return '';
  if (longAxis === 'y') {
    return side === 'L' ? '左側' : '右側';
  } else {
    return side === 'L' ? '上側' : '下側';
  }
}

/**
 * 計算單一座位在桌子上的側邊（自動模式）
 * @param {{ w: number, h: number }} table
 * @param {{ lx: number, ly: number, side_mode?: string, side?: string }} seat
 * @returns {'L' | 'R' | null}
 */
export function determineSeatSide(table, seat) {
  if (seat.side_mode === 'manual' && seat.side) {
    return seat.side;
  }
  const longAxis = getTableLongAxis(table);
  const lx = Number(seat.lx) || 0;
  const ly = Number(seat.ly) || 0;

  if (longAxis === 'y') {
    return lx < 0 ? 'L' : 'R';
  } else {
    return ly < 0 ? 'L' : 'R';
  }
}

/**
 * 解析整份版面的幾何關係（相鄰、對面、側邊、絕對座標）
 * @param {{ tables?: any[], seats?: any[] }} layout
 * @returns {{ tables: any[], seats: any[] }}
 */
export function resolveLayoutGeometry(layout) {
  const tables = layout?.tables || [];
  const rawSeats = layout?.seats || [];

  // Group seats by table_id
  const seatsByTable = new Map();
  const standaloneSeats = [];

  for (const seat of rawSeats) {
    if (seat.table_id != null) {
      if (!seatsByTable.has(seat.table_id)) {
        seatsByTable.set(seat.table_id, []);
      }
      seatsByTable.get(seat.table_id).push({ ...seat });
    } else {
      standaloneSeats.push({ ...seat });
    }
  }

  const tableMap = new Map(tables.map(t => [t.id, t]));
  const resolvedSeats = [];

  // 1. Process table seats
  for (const [tableId, tSeats] of seatsByTable.entries()) {
    const table = tableMap.get(tableId) || { cx: 0, cy: 0, w: 60, h: 150, rotation: 0, arrangement: 'two_sides' };
    const longAxis = getTableLongAxis(table);
    const isRound = table.shape === 'round' || table.arrangement === 'around';
    const isOneSide = table.arrangement === 'one_side';

    // Calculate absolute positions & side
    for (const seat of tSeats) {
      const [rx, ry] = rotatePoint(Number(seat.lx) || 0, Number(seat.ly) || 0, Number(table.rotation) || 0);
      seat.abs_x = (Number(table.cx) || 0) + rx;
      seat.abs_y = (Number(table.cy) || 0) + ry;

      if (isRound) {
        seat.side = null;
        seat.side_label = null;
      } else {
        seat.side = determineSeatSide(table, seat);
        seat.side_label = getSideLabel(longAxis, seat.side);
      }
    }

    if (isRound) {
      // Sort seats by angle around table center
      const sorted = [...tSeats].sort((a, b) => {
        const angA = Math.atan2(Number(a.ly) || 0, Number(a.lx) || 0);
        const angB = Math.atan2(Number(b.ly) || 0, Number(b.lx) || 0);
        return angA - angB;
      });
      const N = sorted.length;
      for (let i = 0; i < N; i++) {
        const curr = sorted[i];
        const prev = sorted[(i - 1 + N) % N];
        const next = sorted[(i + 1) % N];
        const adj = new Set([prev.code, next.code]);
        if (Array.isArray(curr.adjacent_codes)) {
          curr.adjacent_codes.forEach(c => adj.add(c));
        }
        curr.adjacent_resolved = Array.from(adj);

        // Opposite in round table: other seats not adjacent
        const opp = new Set();
        for (let j = 0; j < N; j++) {
          if (j !== i && j !== (i - 1 + N) % N && j !== (i + 1) % N) {
            opp.add(sorted[j].code);
          }
        }
        if (Array.isArray(curr.opposite_codes)) {
          curr.opposite_codes.forEach(c => opp.add(c));
        }
        curr.opposite_resolved = Array.from(opp);
      }
    } else {
      // Partition by side
      const leftSeats = tSeats.filter(s => s.side === 'L');
      const rightSeats = tSeats.filter(s => s.side === 'R');

      // Sort each side along long axis
      const coordKey = longAxis === 'y' ? 'ly' : 'lx';
      leftSeats.sort((a, b) => (Number(a[coordKey]) || 0) - (Number(b[coordKey]) || 0));
      rightSeats.sort((a, b) => (Number(a[coordKey]) || 0) - (Number(b[coordKey]) || 0));

      const processSide = (sameSideSeats, oppositeSideSeats) => {
        for (let i = 0; i < sameSideSeats.length; i++) {
          const curr = sameSideSeats[i];
          const adj = new Set();
          if (i > 0) adj.add(sameSideSeats[i - 1].code);
          if (i < sameSideSeats.length - 1) adj.add(sameSideSeats[i + 1].code);
          if (Array.isArray(curr.adjacent_codes)) {
            curr.adjacent_codes.forEach(c => adj.add(c));
          }
          curr.adjacent_resolved = Array.from(adj);

          const opp = new Set();
          if (!isOneSide && oppositeSideSeats.length > 0) {
            // Find opposite seat on other side with closest longAxis coordinate
            const currCoord = Number(curr[coordKey]) || 0;
            let bestOpp = oppositeSideSeats[0];
            let minDist = Math.abs((Number(bestOpp[coordKey]) || 0) - currCoord);
            for (let k = 1; k < oppositeSideSeats.length; k++) {
              const candidate = oppositeSideSeats[k];
              const dist = Math.abs((Number(candidate[coordKey]) || 0) - currCoord);
              if (dist < minDist) {
                minDist = dist;
                bestOpp = candidate;
              }
            }
            if (bestOpp) {
              opp.add(bestOpp.code);
            }
          }
          if (Array.isArray(curr.opposite_codes)) {
            curr.opposite_codes.forEach(c => opp.add(c));
          }
          curr.opposite_resolved = Array.from(opp);
        }
      };

      processSide(leftSeats, rightSeats);
      processSide(rightSeats, leftSeats);
    }

    resolvedSeats.push(...tSeats);
  }

  // 2. Process standalone seats
  for (const seat of standaloneSeats) {
    seat.abs_x = Number(seat.lx) || 0;
    seat.abs_y = Number(seat.ly) || 0;
    seat.side = null;
    seat.side_label = null;
    seat.adjacent_resolved = Array.isArray(seat.adjacent_codes) ? [...seat.adjacent_codes] : [];
    seat.opposite_resolved = Array.isArray(seat.opposite_codes) ? [...seat.opposite_codes] : [];
    resolvedSeats.push(seat);
  }

  // Bidirectional link for manually configured adjacent_codes
  const seatByCode = new Map(resolvedSeats.map(s => [s.code, s]));
  for (const s of resolvedSeats) {
    for (const adjCode of (s.adjacent_resolved || [])) {
      const neighbor = seatByCode.get(adjCode);
      if (neighbor && !neighbor.adjacent_resolved.includes(s.code)) {
        neighbor.adjacent_resolved.push(s.code);
      }
    }
  }

  return {
    ...layout,
    tables,
    seats: resolvedSeats
  };
}
