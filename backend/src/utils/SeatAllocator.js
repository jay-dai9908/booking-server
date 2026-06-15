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

/**
 * 核心演算法：排位與散客智能挪位 (Local Reshuffle)
 * @param {Array} currentReservations - 該時段目前所有的訂單 (包含新進訂單)
 * @param {Object} newReservation - 本次預約的訂單 (尚未有 assigned_seats)
 * @param {boolean} forceSplit - 是否允許強行拆桌
 * @returns {Object} { success: boolean, updates: Array, error: string } 
 */
export const allocateSeats = (currentReservations, newReservation, forceSplit = false) => {
  // 1. 計算所有已被佔用的座位 (不含本次新訂單)
  const occupiedSeats = new Set();
  currentReservations.forEach(r => {
    if (r.id !== newReservation.id && r.assigned_seats) {
      r.assigned_seats.forEach(seat => occupiedSeats.add(seat));
    }
  });

  const availableSeats = SEATS.filter(s => !occupiedSeats.has(s));

  // 階段一：嘗試常規劃位 (FCFS)
  let assigned = findConsecutiveSeats(availableSeats, newReservation.pax);
  if (assigned) {
    return {
      success: true,
      updates: [{ id: newReservation.id, assigned_seats: assigned }]
    };
  }

  // 階段二：觸發檢查 (Trigger Check)
  if (availableSeats.length < newReservation.pax) {
    return { success: false, error: 'INSUFFICIENT_SEATS' };
  }

  // 階段三：散客智能挪位 (Virtual Reshuffle)
  const updates = []; // 紀錄哪些訂單的座位被改變了
  let virtualAvailable = [...SEATS];
  
  // 3.1 釘死 (Pin) 特定訂單：已報到/未到 或 pax >= 3 的大組客 或 手動鎖定的座位
  const pinnedReservations = currentReservations.filter(r => 
    r.id !== newReservation.id && 
    (r.attendance !== null || r.pax >= 3 || r.is_seat_locked === true)
  );

  pinnedReservations.forEach(r => {
    r.assigned_seats.forEach(s => {
      const index = virtualAvailable.indexOf(s);
      if (index > -1) virtualAvailable.splice(index, 1); // 標記為已使用
    });
  });

  // 3.2 解鎖 (Unpin) 尚未報到的散客 (pax <= 2) 且 未被鎖定
  const unpinnedReservations = currentReservations.filter(r => 
    r.id !== newReservation.id && 
    r.attendance === null && 
    r.pax <= 2 &&
    !r.is_seat_locked
  );

  // 準備虛擬分配佇列 (包含新訂單與被解鎖的訂單)
  const queueToAllocate = [newReservation, ...unpinnedReservations];
  
  // 依照人數降冪排序 (Best Fit Decreasing)
  queueToAllocate.sort((a, b) => b.pax - a.pax);

  let reshuffleSuccess = true;
  for (const r of queueToAllocate) {
    const seats = findConsecutiveSeats(virtualAvailable, r.pax);
    if (seats) {
      // 成功分配，從 virtualAvailable 中移除
      virtualAvailable = virtualAvailable.filter(s => !seats.includes(s));
      updates.push({ id: r.id, assigned_seats: seats });
    } else {
      reshuffleSuccess = false;
      break;
    }
  }

  if (reshuffleSuccess) {
    return { success: true, updates };
  }

  // 階段四：兩段式強行拆桌防呆
  if (!forceSplit) {
    return { success: false, error: 'SPLIT_REQUIRED' }; // 回傳 409，需前端確認
  }

  // 強制拆桌：直接從剩下的位子抓取
  // 注意：我們捨棄剛才失敗的虛擬重排，直接在最原始的 availableSeats 中強抓
  const forcedSeats = availableSeats.slice(0, newReservation.pax);
  return {
    success: true,
    updates: [{ id: newReservation.id, assigned_seats: forcedSeats }]
  };
};
