// shared/allocator/score.js
// 排位計分與候選坐法生成（純函式，前端預覽與後端排位共用）

import { resolveLayoutGeometry } from './geometry.js';

export const DEFAULT_WEIGHTS = {
  zone: 1,
  zone_fill_first: 50,
  opposite: 3,
  beside: 6,
  second: 20,
  last: 100,
  split: 4
};

/**
 * 取得一組座位的所有候選組合
 * @param {object} params
 * @param {any} params.layout
 * @param {any} params.rules
 * @param {number} params.pax
 * @param {string[]|number[]} params.sessionIds
 * @param {Record<string|number, Record<string, string>>} [params.occupancy]
 * @param {boolean} [params.allowSplit=false]
 * @returns {Array<{ seats: string[], type: string, tableIds: number[], zoneRank: number }>}
 */
export function generateCandidateSeatings({
  layout,
  rules,
  pax,
  sessionIds = [],
  occupancy = {},
  allowSplit = false
}) {
  const resolved = resolveLayoutGeometry(layout);
  const seats = (resolved.seats || []).filter(s => {
    if (!s.is_active) return false;
    if (s.priority === 'manual_only') return false;
    // Check occupancy across all sessionIds
    for (const sid of sessionIds) {
      if (occupancy[sid]?.[s.code]) return false;
    }
    return true;
  });

  const seatMap = new Map(seats.map(s => [s.code, s]));
  const tables = (resolved.tables || []).slice().sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
  const zones = (resolved.zones || []).slice().sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
  const zoneRankMap = new Map(zones.map((z, idx) => [z.id, idx]));

  const candidates = [];

  // Group available seats by table
  const seatsByTable = new Map();
  const standaloneSeats = [];
  for (const s of seats) {
    if (s.table_id != null) {
      if (!seatsByTable.has(s.table_id)) seatsByTable.set(s.table_id, []);
      seatsByTable.get(s.table_id).push(s);
    } else {
      standaloneSeats.push(s);
    }
  }

  // Helper to add candidate
  const addCandidate = (codeList, type) => {
    if (!codeList || codeList.length !== pax) return;
    const tIds = new Set();
    let zRank = 999;
    for (const c of codeList) {
      const s = seatMap.get(c);
      if (!s) return;
      if (s.table_id != null) tIds.add(s.table_id);
      const r = zoneRankMap.has(s.zone_id) ? zoneRankMap.get(s.zone_id) : 0;
      if (r < zRank) zRank = r;
    }
    candidates.push({
      seats: codeList,
      type,
      tableIds: Array.from(tIds),
      zoneRank: zRank === 999 ? 0 : zRank
    });
  };

  // Helper for consecutive seats on same side
  const getConsecutiveSeats = (sideSeats, count) => {
    const res = [];
    for (let i = 0; i <= sideSeats.length - count; i++) {
      // Check if adjacent_resolved links them sequentially
      let valid = true;
      for (let k = 0; k < count - 1; k++) {
        if (!sideSeats[k + i].adjacent_resolved.includes(sideSeats[k + i + 1].code)) {
          valid = false;
          break;
        }
      }
      if (valid) {
        res.push(sideSeats.slice(i, i + count).map(s => s.code));
      }
    }
    return res;
  };

  // Pax = 1: Any single available seat
  if (pax === 1) {
    for (const s of seats) {
      addCandidate([s.code], 'single');
    }
    return dedupeCandidates(candidates);
  }

  // Pax = 2:
  // 1. Same side adjacent 2
  // 2. Same table face-to-face 2
  if (pax === 2) {
    for (const [tId, tSeats] of seatsByTable.entries()) {
      const left = tSeats.filter(s => s.side === 'L').sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
      const right = tSeats.filter(s => s.side === 'R').sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));

      getConsecutiveSeats(left, 2).forEach(c => addCandidate(c, 'side'));
      getConsecutiveSeats(right, 2).forEach(c => addCandidate(c, 'side'));

      // Face-to-face 2
      for (const l of left) {
        for (const r of right) {
          if (l.opposite_resolved?.includes(r.code)) {
            addCandidate([l.code, r.code], 'face');
          }
        }
      }
    }

    // Standalone / Round table connected 2
    for (const s of seats) {
      for (const adjCode of (s.adjacent_resolved || [])) {
        if (seatMap.has(adjCode) && s.code < adjCode) {
          addCandidate([s.code, adjCode], 'adjacent_pair');
        }
      }
    }

    if (allowSplit) {
      // If no normal candidate or allowed split
      addSplitCandidates(candidates, seats, pax, zoneRankMap);
    }
    return dedupeCandidates(candidates);
  }

  // Pax = 3:
  // 1. Same side consecutive 3
  // 2. Same side adjacent 2 + opposite of one of them
  if (pax === 3) {
    for (const [tId, tSeats] of seatsByTable.entries()) {
      const left = tSeats.filter(s => s.side === 'L').sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
      const right = tSeats.filter(s => s.side === 'R').sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));

      getConsecutiveSeats(left, 3).forEach(c => addCandidate(c, 'side3'));
      getConsecutiveSeats(right, 3).forEach(c => addCandidate(c, 'side3'));

      // 2 on side + 1 opposite
      const checkSidePlusOne = (sideA, sideB) => {
        for (const pair of getConsecutiveSeats(sideA, 2)) {
          const s1 = seatMap.get(pair[0]);
          const s2 = seatMap.get(pair[1]);
          const oppCodes = new Set([...(s1?.opposite_resolved || []), ...(s2?.opposite_resolved || [])]);
          for (const opp of sideB) {
            if (oppCodes.has(opp.code)) {
              addCandidate([...pair, opp.code], 'side_plus_one');
            }
          }
        }
      };
      checkSidePlusOne(left, right);
      checkSidePlusOne(right, left);
    }

    if (allowSplit) {
      addSplitCandidates(candidates, seats, pax, zoneRankMap);
    }
    return dedupeCandidates(candidates);
  }

  // Pax = 4:
  // 1. Entire 4-person table empty
  // 2. Same side consecutive 4
  // 3. Same zone adjacent two tables each side 2 (split2)
  if (pax === 4) {
    for (const [tId, tSeats] of seatsByTable.entries()) {
      if (tSeats.length === 4) {
        addCandidate(tSeats.map(s => s.code), 'table');
      }
      const left = tSeats.filter(s => s.side === 'L').sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
      const right = tSeats.filter(s => s.side === 'R').sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));

      getConsecutiveSeats(left, 4).forEach(c => addCandidate(c, 'side4'));
      getConsecutiveSeats(right, 4).forEach(c => addCandidate(c, 'side4'));
    }

    // Split across two adjacent tables in same zone (2 + 2)
    for (let i = 0; i < tables.length - 1; i++) {
      const t1 = tables[i];
      const t2 = tables[i + 1];
      if (t1.zone_id === t2.zone_id) {
        const s1 = seatsByTable.get(t1.id) || [];
        const s2 = seatsByTable.get(t2.id) || [];
        const pairs1 = getConsecutiveSeats(s1.filter(s => s.side === 'L'), 2)
          .concat(getConsecutiveSeats(s1.filter(s => s.side === 'R'), 2));
        const pairs2 = getConsecutiveSeats(s2.filter(s => s.side === 'L'), 2)
          .concat(getConsecutiveSeats(s2.filter(s => s.side === 'R'), 2));
        for (const p1 of pairs1) {
          for (const p2 of pairs2) {
            addCandidate([...p1, ...p2], 'split2');
          }
        }
      }
    }

    if (allowSplit) {
      addSplitCandidates(candidates, seats, pax, zoneRankMap);
    }
    return dedupeCandidates(candidates);
  }

  // Pax >= 5:
  // Same zone adjacent tables: fill first table's empty seats, then second table's...
  for (let i = 0; i < tables.length; i++) {
    const t1 = tables[i];
    const zoneId = t1.zone_id;
    let gathered = [];
    const usedTableIds = [];

    for (let j = i; j < tables.length; j++) {
      const t = tables[j];
      if (t.zone_id !== zoneId) break;
      const tSeats = seatsByTable.get(t.id) || [];
      if (tSeats.length > 0) {
        usedTableIds.push(t.id);
        gathered = gathered.concat(tSeats.map(s => s.code));
      }
      if (gathered.length >= pax) {
        addCandidate(gathered.slice(0, pax), 'multi');
        break;
      }
    }
  }

  if (candidates.length === 0 || allowSplit) {
    addSplitCandidates(candidates, seats, pax, zoneRankMap);
  }

  return dedupeCandidates(candidates);
}

function dedupeCandidates(list) {
  const seen = new Set();
  const res = [];
  for (const c of list) {
    const sortedKey = [...c.seats].sort().join(',');
    if (!seen.has(sortedKey)) {
      seen.add(sortedKey);
      res.push(c);
    }
  }
  return res;
}

function addSplitCandidates(candidates, seats, pax, zoneRankMap) {
  if (seats.length < pax) return;
  // Fallback split candidate
  const sorted = [...seats].sort((a, b) => {
    const za = zoneRankMap.get(a.zone_id) || 0;
    const zb = zoneRankMap.get(b.zone_id) || 0;
    if (za !== zb) return za - zb;
    return (a.sort_order || 0) - (b.sort_order || 0);
  });
  const chunk = sorted.slice(0, pax).map(s => s.code);
  const tIds = Array.from(new Set(chunk.map(c => seats.find(s => s.code === c)?.table_id).filter(Boolean)));
  candidates.push({
    seats: chunk,
    type: 'split_fallback',
    tableIds: tIds,
    zoneRank: 0
  });
}

/**
 * 計分（越低越好）
 * @param {object} params
 * @param {string[]} params.candidateSeats
 * @param {any} params.layout
 * @param {any} params.rules
 * @param {string[]|number[]} params.sessionIds
 * @param {Record<string|number, Record<string, string>>} [params.occupancy]
 * @returns {{ score: number, breakdown: object, reason: string }}
 */
export function scoreCandidate({
  candidateSeats,
  layout,
  rules = {},
  sessionIds = [],
  occupancy = {}
}) {
  const resolved = resolveLayoutGeometry(layout);
  const seatMap = new Map((resolved.seats || []).map(s => [s.code, s]));
  const tableMap = new Map((resolved.tables || []).map(t => [t.id, t]));
  const zones = (resolved.zones || []).slice().sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
  const zoneRankMap = new Map(zones.map((z, idx) => [z.id, idx]));

  const weights = { ...DEFAULT_WEIGHTS, ...(rules.weights || {}) };
  const spreadTables = rules.spread_tables !== false;
  const avoidOpposite = rules.avoid_opposite !== false;
  const avoidBeside = rules.avoid_beside !== false;
  const isFillZoneFirst = rules.zone_mode === 'fill_zone_first' || rules.zone_mode === '前區全部坐滿才排後區';

  const candSet = new Set(candidateSeats);
  const firstSeat = seatMap.get(candidateSeats[0]);
  const zoneRank = firstSeat && zoneRankMap.has(firstSeat.zone_id) ? zoneRankMap.get(firstSeat.zone_id) : 0;

  // Zone score
  const zoneScore = isFillZoneFirst ? zoneRank * weights.zone_fill_first : zoneRank * weights.zone;

  // Tables used
  const tablesUsed = new Set();
  for (const c of candidateSeats) {
    const s = seatMap.get(c);
    if (s?.table_id != null) tablesUsed.add(s.table_id);
  }
  const splitScore = weights.split * Math.max(0, tablesUsed.size - 1);

  // Priority scores: second and last
  let secondCount = 0;
  let lastCount = 0;
  for (const c of candidateSeats) {
    const s = seatMap.get(c);
    if (s?.priority === 'second') secondCount++;
    if (s?.priority === 'last' || s?.tags?.includes('vent')) lastCount++;
  }
  const secondScore = weights.second * secondCount;
  const lastScore = weights.last * lastCount;

  // Session-dependent: opposite and beside (take maximum over all sessionIds)
  let maxOppositeCount = 0;
  let maxBesideCount = 0;

  for (const sid of sessionIds) {
    const sessionOcc = occupancy[sid] || {};
    let sessionOppositeCount = 0;
    let sessionBesideCount = 0;

    // Check opposite: on each table used, does the opposite side have any other guests?
    if (avoidOpposite) {
      for (const tId of tablesUsed) {
        const tableSeats = (resolved.seats || []).filter(s => s.table_id === tId);
        // Find which sides are used by candidate on this table
        const candidateSides = new Set(tableSeats.filter(s => candSet.has(s.code)).map(s => s.side).filter(Boolean));
        // Check if opposite side has any outside guests
        for (const s of tableSeats) {
          if (!candSet.has(s.code) && sessionOcc[s.code]) {
            if (s.side && !candidateSides.has(s.side)) {
              sessionOppositeCount++;
              break; // count once per table
            }
          }
        }
      }
    }

    // Check beside: does any seat in candidate have adjacent seat occupied by outside guest?
    if (avoidBeside) {
      const besideOccChecked = new Set();
      for (const c of candidateSeats) {
        const s = seatMap.get(c);
        if (s?.adjacent_resolved) {
          for (const adjCode of s.adjacent_resolved) {
            if (!candSet.has(adjCode) && sessionOcc[adjCode]) {
              besideOccChecked.add(adjCode);
            }
          }
        }
      }
      sessionBesideCount = besideOccChecked.size;
    }

    if (sessionOppositeCount > maxOppositeCount) maxOppositeCount = sessionOppositeCount;
    if (sessionBesideCount > maxBesideCount) maxBesideCount = sessionBesideCount;
  }

  const oppositeScore = avoidOpposite ? weights.opposite * maxOppositeCount : 0;
  const besideScore = avoidBeside ? weights.beside * maxBesideCount : 0;

  const totalScore = zoneScore + splitScore + secondScore + lastScore + oppositeScore + besideScore;

  // Build human-friendly reason text
  const reasons = [];
  const zName = firstSeat ? zones.find(z => z.id === firstSeat.zone_id)?.name || '前區' : '前區';
  if (lastCount > 0) {
    reasons.push('只剩冷氣出風口');
  } else if (secondCount > 0) {
    reasons.push('使用次選座位');
  } else if (maxOppositeCount > 0) {
    reasons.push('每張桌都有人了，開始排對面有人的位置');
  } else if (zoneRank > 0) {
    reasons.push(`${zName}長桌旁邊沒人，已避開冷氣出風口`);
  } else {
    reasons.push(`${zName}有空桌`);
  }

  return {
    score: totalScore,
    breakdown: {
      zone: zoneScore,
      split: splitScore,
      second: secondScore,
      last: lastScore,
      opposite: oppositeScore,
      beside: besideScore
    },
    reason: reasons.join('；')
  };
}

/**
 * 完整排位分配演算法
 * @param {object} params
 * @param {any} params.layout
 * @param {any} params.rules
 * @param {number} params.pax
 * @param {string[]|number[]} params.sessionIds
 * @param {Record<string|number, Record<string, string>>} [params.occupancy]
 * @param {boolean} [params.allowSplit=false]
 * @returns {{ seats: string[], score: number, reason: string } | { error: string }}
 */
export function allocate({
  layout,
  rules = {},
  pax,
  sessionIds = [],
  occupancy = {},
  allowSplit = false
}) {
  const resolved = resolveLayoutGeometry(layout);
  const candidates = generateCandidateSeatings({
    layout: resolved,
    rules,
    pax,
    sessionIds,
    occupancy,
    allowSplit
  });

  if (!candidates || candidates.length === 0) {
    if (!allowSplit) {
      // Check if splitting would allow seating
      const splitCandidates = generateCandidateSeatings({
        layout: resolved,
        rules,
        pax,
        sessionIds,
        occupancy,
        allowSplit: true
      });
      if (splitCandidates.length > 0) {
        return { error: 'SPLIT_REQUIRED' };
      }
    }
    return { error: 'INSUFFICIENT_SEATS' };
  }

  const seatMap = new Map((resolved.seats || []).map(s => [s.code, s]));
  const tableMap = new Map((resolved.tables || []).map(t => [t.id, t]));
  const zones = (resolved.zones || []).slice().sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
  const zoneRankMap = new Map(zones.map((z, idx) => [z.id, idx]));

  // Tables sorted by zone and sort_order
  const tablesByZone = new Map();
  for (const t of (resolved.tables || [])) {
    if (!tablesByZone.has(t.zone_id)) tablesByZone.set(t.zone_id, []);
    tablesByZone.get(t.zone_id).push(t);
  }
  for (const [zId, tList] of tablesByZone.entries()) {
    tList.sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
  }

  const spreadTables = rules.spread_tables !== false;

  // Score each candidate and tie-break
  const scored = candidates.map(c => {
    const sc = scoreCandidate({
      candidateSeats: c.seats,
      layout: resolved,
      rules,
      sessionIds,
      occupancy
    });
    return {
      ...c,
      ...sc
    };
  });

  // Tie-breaker comparator
  scored.sort((a, b) => {
    // 1. Total score lower is better
    if (a.score !== b.score) return a.score - b.score;

    // 2. Zone sort_order smaller is better
    const sA0 = seatMap.get(a.seats[0]);
    const sB0 = seatMap.get(b.seats[0]);
    const zRankA = sA0 && zoneRankMap.has(sA0.zone_id) ? zoneRankMap.get(sA0.zone_id) : 0;
    const zRankB = sB0 && zoneRankMap.has(sB0.zone_id) ? zoneRankMap.get(sB0.zone_id) : 0;
    if (zRankA !== zRankB) return zRankA - zRankB;

    // 3. First table's sort_order smaller is better (standalone seats without table use -1)
    const tA0 = sA0?.table_id ? tableMap.get(sA0.table_id) : null;
    const tB0 = sB0?.table_id ? tableMap.get(sB0.table_id) : null;
    const tSortA = tA0 ? (tA0.sort_order ?? 0) : -1;
    const tSortB = tB0 ? (tB0.sort_order ?? 0) : -1;
    if (tSortA !== tSortB) return tSortA - tSortB;

    // 4. spread_tables: Table index i in zone is even -> prefer L, odd -> prefer R
    if (spreadTables && tA0 && tB0 && tA0.id === tB0.id) {
      const zoneTables = tablesByZone.get(tA0.zone_id) || [];
      const tableIdx = zoneTables.findIndex(t => t.id === tA0.id);
      const preferredSide = tableIdx % 2 === 0 ? 'L' : 'R';
      const sideA = sA0.side;
      const sideB = sB0.side;
      if (sideA !== sideB) {
        if (sideA === preferredSide) return -1;
        if (sideB === preferredSide) return 1;
      }
    }

    // 5. First seat's sort_order smaller is better
    const seatSortA = sA0?.sort_order ?? 0;
    const seatSortB = sB0?.sort_order ?? 0;
    if (seatSortA !== seatSortB) return seatSortA - seatSortB;

    // 6. Seat code string comparison
    const aKey = a.seats.join(',');
    const bKey = b.seats.join(',');
    return aKey.localeCompare(bKey);
  });

  const winner = scored[0];
  return {
    seats: winner.seats,
    score: winner.score,
    reason: winner.reason,
    breakdown: winner.breakdown
  };
}
