const SEATS = [
  'A1-1', 'A1-2', 'A1-3', 'A1-4', 
  'A2-1', 'A2-2', 'A2-3', 'A2-4', 
  'B1-1', 'B1-2', 'B1-3', 'B1-4', 
  'B2-1', 'B2-2', 'B2-3', 'B2-4'
];

// Helper to check if an array of target seats are all available
const areAvailable = (availableSeats, targets) => {
  return targets.every(t => availableSeats.includes(t));
};

/**
 * 階段一：常規劃位 (FCFS Allocation)
 * @param {string[]} availableSeats - 系統中剩餘的空位
 * @param {number} pax - 預約人數
 * @returns {string[]|null} - 回傳分配到的座位陣列，若無符合規則的空位則回傳 null
 */
const findConsecutiveSeats = (availableSeats, pax) => {
  if (pax > 4) return null; // 單筆訂單大於 4 人需強制拆桌或拆單

  if (pax === 4) {
    // 優先：B型桌 (完整包桌)
    if (areAvailable(availableSeats, ['B1-1', 'B1-2', 'B1-3', 'B1-4'])) return ['B1-1', 'B1-2', 'B1-3', 'B1-4'];
    if (areAvailable(availableSeats, ['B2-1', 'B2-2', 'B2-3', 'B2-4'])) return ['B2-1', 'B2-2', 'B2-3', 'B2-4'];
    // 其次：A型桌
    if (areAvailable(availableSeats, ['A1-1', 'A1-2', 'A1-3', 'A1-4'])) return ['A1-1', 'A1-2', 'A1-3', 'A1-4'];
    if (areAvailable(availableSeats, ['A2-1', 'A2-2', 'A2-3', 'A2-4'])) return ['A2-1', 'A2-2', 'A2-3', 'A2-4'];
  }

  if (pax === 3) {
    // 優先：A型桌相鄰 3 座位
    const aOptions = [
      ['A1-1', 'A1-2', 'A1-3'], ['A1-2', 'A1-3', 'A1-4'],
      ['A2-1', 'A2-2', 'A2-3'], ['A2-2', 'A2-3', 'A2-4']
    ];
    for (const opt of aOptions) {
      if (areAvailable(availableSeats, opt)) return opt;
    }
    // 降級 (Fallback)：B 型桌 (接受浪費 1 座位)
    const bOptions = [
      ['B1-1', 'B1-2', 'B1-3'], ['B1-1', 'B1-2', 'B1-4'], ['B1-2', 'B1-3', 'B1-4'], ['B1-1', 'B1-3', 'B1-4'],
      ['B2-1', 'B2-2', 'B2-3'], ['B2-1', 'B2-2', 'B2-4'], ['B2-2', 'B2-3', 'B2-4'], ['B2-1', 'B2-3', 'B2-4']
    ];
    for (const opt of bOptions) {
      if (areAvailable(availableSeats, opt)) return opt;
    }
  }

  if (pax === 2) {
    // 優先：B 型桌同側
    const bOptions = [
      ['B1-1', 'B1-2'], ['B1-3', 'B1-4'],
      ['B2-1', 'B2-2'], ['B2-3', 'B2-4']
    ];
    for (const opt of bOptions) {
      if (areAvailable(availableSeats, opt)) return opt;
    }
    // 其次：A 型桌相鄰 2 座位
    const aOptions = [
      ['A1-1', 'A1-2'], ['A1-2', 'A1-3'], ['A1-3', 'A1-4'],
      ['A2-1', 'A2-2'], ['A2-2', 'A2-3'], ['A2-3', 'A2-4']
    ];
    for (const opt of aOptions) {
      if (areAvailable(availableSeats, opt)) return opt;
    }
  }

  if (pax === 1) {
    // 優先：A 型桌零星空位
    const aSeats = availableSeats.filter(s => s.startsWith('A'));
    if (aSeats.length > 0) return [aSeats[0]];
    // 其次：B 型桌零星空位
    const bSeats = availableSeats.filter(s => s.startsWith('B'));
    if (bSeats.length > 0) return [bSeats[0]];
  }

  return null;
};

// Helper: Group reservations by booking_ref
const groupReservations = (reservations) => {
  const blocksMap = new Map();
  for (const r of reservations) {
    if (!blocksMap.has(r.booking_ref)) {
      blocksMap.set(r.booking_ref, {
        booking_ref: r.booking_ref,
        pax: r.pax,
        session_ids: [],
        assigned_seats: r.assigned_seats || [],
        is_pinned: (r.attendance !== null || r.pax >= 3 || r.is_seat_locked === true)
      });
    }
    // 確保不會重複加入同一個 session_id
    if (!blocksMap.get(r.booking_ref).session_ids.includes(r.session_id)) {
      blocksMap.get(r.booking_ref).session_ids.push(r.session_id);
    }
  }
  return Array.from(blocksMap.values());
};

// Helper: 針對目標時段尋找可用的座位交集
const getIntersectionAvailableSeats = (blocks, targetSessionIds, excludeRef = null) => {
  const occupiedSeats = new Set();
  
  for (const block of blocks) {
    if (excludeRef && block.booking_ref === excludeRef) continue;
    
    // 檢查這個 block 是否與目標時段有交集
    const intersects = block.session_ids.some(sid => targetSessionIds.includes(sid));
    if (intersects && block.assigned_seats) {
      block.assigned_seats.forEach(seat => occupiedSeats.add(seat));
    }
  }

  return SEATS.filter(s => !occupiedSeats.has(s));
};

/**
 * 核心演算法：多時段一致性排位與智能挪位 (Continuous Block Allocation & Local Reshuffle)
 * @param {Array} currentReservations - 該日期所有的訂單 (尚未包含新進訂單)
 * @param {Object} newReservationBlock - 本次預約的訂單區塊 { booking_ref: 'NEW_RES', pax, session_ids: [...] }
 * @param {boolean} forceSplit - 是否允許強行拆桌
 * @returns {Object} { success: boolean, updates: Array, error: string } 
 */
export const allocateSeats = (currentReservations, newReservationBlock, forceSplit = false) => {
  const blocks = groupReservations(currentReservations);
  
  // 1. 計算新訂單全時段可用空位交集
  const initialAvailable = getIntersectionAvailableSeats(blocks, newReservationBlock.session_ids);

  // 階段一：嘗試常規劃位 (FCFS)
  let assigned = findConsecutiveSeats(initialAvailable, newReservationBlock.pax);
  if (assigned) {
    return {
      success: true,
      updates: [{ booking_ref: newReservationBlock.booking_ref, assigned_seats: assigned }]
    };
  }

  // 檢查絕對容量防呆：如果可用空位數量連硬拆桌都不夠，直接擋下
  if (initialAvailable.length < newReservationBlock.pax) {
    return { success: false, error: 'INSUFFICIENT_SEATS' };
  }

  // 階段二：散客智能挪位 (Virtual Reshuffle)
  const updates = [];
  
  const unpinnedBlocks = blocks.filter(b => !b.is_pinned);
  const pinnedBlocks = blocks.filter(b => b.is_pinned);
  
  const queueToAllocate = [newReservationBlock, ...unpinnedBlocks];
  
  // 動態貪婪洗牌：依照 人數(降冪) -> 時段長度(降冪) 排序
  queueToAllocate.sort((a, b) => {
    if (b.pax !== a.pax) return b.pax - a.pax;
    return b.session_ids.length - a.session_ids.length;
  });

  const virtualBlocks = [...pinnedBlocks]; 
  let reshuffleSuccess = true;

  for (const reqBlock of queueToAllocate) {
    // 在目前的虛擬排位表中尋找可用空位交集
    const virtAvailable = getIntersectionAvailableSeats(virtualBlocks, reqBlock.session_ids);
    const seats = findConsecutiveSeats(virtAvailable, reqBlock.pax);
    
    if (seats) {
      virtualBlocks.push({
        ...reqBlock,
        assigned_seats: seats
      });
      
      const originalBlock = blocks.find(b => b.booking_ref === reqBlock.booking_ref);
      const originalSeats = originalBlock ? originalBlock.assigned_seats : [];
      
      // Zero-Diff Filter：只有座位真正改變時才加入 updates 回傳
      const seatsChanged = seats.length !== originalSeats.length || !seats.every(s => originalSeats.includes(s));
      
      if (seatsChanged) {
        updates.push({ booking_ref: reqBlock.booking_ref, assigned_seats: seats });
      }
    } else {
      reshuffleSuccess = false;
      break;
    }
  }

  if (reshuffleSuccess) {
    return { success: true, updates };
  }

  // 階段三：兩段式強行拆桌防呆
  if (!forceSplit) {
    return { success: false, error: 'SPLIT_REQUIRED' };
  }

  // 強制拆桌：回到最初的 availableSeats 進行拆桌
  let remainingPax = newReservationBlock.pax;
  let tempAvailable = [...initialAvailable];
  const forcedAssigned = [];

  while (remainingPax > 0) {
    let chunk = remainingPax >= 4 ? 4 : remainingPax;
    let seats = null;

    while (chunk > 0) {
      seats = findConsecutiveSeats(tempAvailable, chunk);
      if (seats) break;
      chunk--;
    }

    if (!seats) {
      const fallbackSeat = tempAvailable.shift();
      forcedAssigned.push(fallbackSeat);
      remainingPax -= 1;
    } else {
      forcedAssigned.push(...seats);
      tempAvailable = tempAvailable.filter(s => !seats.includes(s));
      remainingPax -= seats.length;
    }
  }

  return {
    success: true,
    updates: [{ booking_ref: newReservationBlock.booking_ref, assigned_seats: forcedAssigned }]
  };
};
