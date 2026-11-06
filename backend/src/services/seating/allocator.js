// backend/src/services/seating/allocator.js
// 結合資料庫版面與排位計分演算法（含鎖定判定、局部洗牌與拆桌容錯）

import { allocate } from '../../../../shared/allocator/score.js';
import { loadAllocatorContext } from './layoutService.js';

export function isReservationPinned(r) {
  if (!r) return false;
  if (r.is_pinned === true) return true;
  if (r.attendance === 'checked_in') return true;
  if (r.is_seat_locked === true) return true;
  if (r.seat_source === 'staff') return true;
  if (r.persons && Array.isArray(r.persons) && r.persons.some(p => p.seat_code)) return true;
  return false;
}

/**
 * 版面排位主函式（與 legacyAllocateSeats 介面相容）
 * @param {Array<any>} currentReservations
 * @param {object} newReservationBlock
 * @param {boolean} [forceSplit=false]
 * @param {object} ctx - { layout, rules }
 * @returns {{ success: boolean, updates: Array<{ booking_ref: string, assigned_seats: string[] }>, error?: string }}
 */
export function allocateWithLayout(currentReservations = [], newReservationBlock, forceSplit = false, ctx = {}) {
  const { layout, rules = {} } = ctx;
  if (!layout) {
    return { success: false, error: 'INSUFFICIENT_SEATS' };
  }

  // 整理目標時段
  let targetSessionIds = [];
  if (newReservationBlock?.session_ids && Array.isArray(newReservationBlock.session_ids)) {
    targetSessionIds = newReservationBlock.session_ids;
  } else if (newReservationBlock?.original_sessions && Array.isArray(newReservationBlock.original_sessions)) {
    targetSessionIds = newReservationBlock.original_sessions.map(s => s.session_id);
  } else if (newReservationBlock?.session_id != null) {
    targetSessionIds = [newReservationBlock.session_id];
  }

  // Group current reservations by booking_ref
  const blocksMap = new Map();
  for (const r of currentReservations) {
    const ref = r.booking_ref || r.id;
    if (!ref) continue;
    if (newReservationBlock && (ref === newReservationBlock.booking_ref || ref === newReservationBlock.id)) {
      continue; // Skip the new booking itself
    }
    if (!blocksMap.has(ref)) {
      blocksMap.set(ref, {
        booking_ref: ref,
        pax: r.pax,
        assigned_seats: Array.isArray(r.assigned_seats) ? [...r.assigned_seats] : [],
        created_at: r.created_at ? new Date(r.created_at).getTime() : 0,
        is_pinned: isReservationPinned(r),
        session_ids: new Set()
      });
    }
    const b = blocksMap.get(ref);
    if (r.session_id != null) b.session_ids.add(r.session_id);
    if (isReservationPinned(r)) b.is_pinned = true;
  }

  const allBlocks = Array.from(blocksMap.values()).map(b => ({
    ...b,
    session_ids: Array.from(b.session_ids)
  }));

  // Build current occupancy map: occupancy[sessionId][seatCode] = booking_ref
  const buildOccupancy = (blocks) => {
    const occ = {};
    for (const sid of targetSessionIds) {
      occ[sid] = {};
    }
    for (const b of blocks) {
      for (const sid of b.session_ids) {
        if (!occ[sid]) occ[sid] = {};
        for (const seat of b.assigned_seats) {
          if (!seat.startsWith('WAIT-')) {
            occ[sid][seat] = b.booking_ref;
          }
        }
      }
    }
    return occ;
  };

  const initialOccupancy = buildOccupancy(allBlocks);

  // 1. 常規排位（直接分配）
  const directAlloc = allocate({
    layout,
    rules,
    pax: newReservationBlock.pax,
    sessionIds: targetSessionIds,
    occupancy: initialOccupancy,
    allowSplit: Boolean(forceSplit)
  });

  if (directAlloc && directAlloc.seats && !directAlloc.error) {
    return {
      success: true,
      updates: [
        {
          booking_ref: newReservationBlock.booking_ref || newReservationBlock.id,
          assigned_seats: directAlloc.seats
        }
      ]
    };
  }

  // 2. 局部洗牌（Reshuffle）
  // 找出重疊時段中可以挪動（非 pinned）且已佔用實體座位的預約
  const overlappingMovable = allBlocks.filter(b => {
    if (b.is_pinned) return false;
    if (!b.assigned_seats || !b.assigned_seats.some(s => s && !s.startsWith('WAIT-'))) return false;
    return b.session_ids.some(sid => targetSessionIds.includes(sid));
  });

  // 如果有可挪動預約，進行動態洗牌
  if (overlappingMovable.length > 0) {
    const queueToAllocate = [
      ...overlappingMovable,
      {
        booking_ref: newReservationBlock.booking_ref || newReservationBlock.id,
        pax: newReservationBlock.pax,
        session_ids: targetSessionIds,
        created_at: Date.now(),
        is_pinned: false
      }
    ];

    // 依「時段數多 → 人數多 → 建立時間早」排序 (Section 4.7.7)
    queueToAllocate.sort((a, b) => {
      if (b.session_ids.length !== a.session_ids.length) {
        return b.session_ids.length - a.session_ids.length;
      }
      if (b.pax !== a.pax) {
        return b.pax - a.pax;
      }
      return (a.created_at || 0) - (b.created_at || 0);
    });

    // 以 pinned reservations 為底座建立虛擬排位表
    const pinnedBlocks = allBlocks.filter(b => !overlappingMovable.some(m => m.booking_ref === b.booking_ref));
    const virtualOccupancy = buildOccupancy(pinnedBlocks);

    let reshuffleSuccess = true;
    const virtualAssigned = new Map();

    for (const reqBlock of queueToAllocate) {
      const res = allocate({
        layout,
        rules,
        pax: reqBlock.pax,
        sessionIds: reqBlock.session_ids,
        occupancy: virtualOccupancy,
        allowSplit: false
      });

      if (res && res.seats && !res.error) {
        virtualAssigned.set(reqBlock.booking_ref, res.seats);
        // Occupy in virtual occupancy
        for (const sid of reqBlock.session_ids) {
          if (!virtualOccupancy[sid]) virtualOccupancy[sid] = {};
          for (const s of res.seats) {
            virtualOccupancy[sid][s] = reqBlock.booking_ref;
          }
        }
      } else {
        reshuffleSuccess = false;
        break;
      }
    }

    if (reshuffleSuccess) {
      const updates = [];
      for (const [ref, seats] of virtualAssigned.entries()) {
        const orig = allBlocks.find(b => b.booking_ref === ref);
        if (!orig) {
          // New booking
          updates.push({ booking_ref: ref, assigned_seats: seats });
        } else {
          // Compare with original seats
          const origSeats = orig.assigned_seats || [];
          const changed = seats.length !== origSeats.length || !seats.every(s => origSeats.includes(s));
          if (changed) {
            updates.push({ booking_ref: ref, assigned_seats: seats });
          }
        }
      }
      return { success: true, updates };
    }
  }

  // 3. 洗牌失敗防呆：若不允許拆桌，回傳 SPLIT_REQUIRED
  if (!forceSplit) {
    return { success: false, error: 'SPLIT_REQUIRED' };
  }

  // 4. 強制拆桌：拆成每段最多 4 人，各自排，不夠才給 WAIT-n
  let remainingPax = newReservationBlock.pax;
  const forcedAssigned = [];
  let waitCounter = 1;

  // Find highest current WAIT number
  for (const b of allBlocks) {
    for (const s of b.assigned_seats || []) {
      if (s.startsWith('WAIT-')) {
        const num = parseInt(s.replace('WAIT-', ''), 10);
        if (!isNaN(num) && num >= waitCounter) waitCounter = num + 1;
      }
    }
  }

  const currentOccupancy = buildOccupancy(allBlocks);

  while (remainingPax > 0) {
    let chunk = remainingPax >= 4 ? 4 : remainingPax;
    let chunkAlloc = null;

    while (chunk > 0) {
      chunkAlloc = allocate({
        layout,
        rules,
        pax: chunk,
        sessionIds: targetSessionIds,
        occupancy: currentOccupancy,
        allowSplit: true
      });
      if (chunkAlloc && chunkAlloc.seats && !chunkAlloc.error) break;
      chunk--;
    }

    if (chunkAlloc && chunkAlloc.seats && !chunkAlloc.error) {
      forcedAssigned.push(...chunkAlloc.seats);
      for (const sid of targetSessionIds) {
        if (!currentOccupancy[sid]) currentOccupancy[sid] = {};
        for (const s of chunkAlloc.seats) {
          currentOccupancy[sid][s] = newReservationBlock.booking_ref || newReservationBlock.id;
        }
      }
      remainingPax -= chunkAlloc.seats.length;
    } else {
      // Fallback WAIT-n
      forcedAssigned.push(`WAIT-${waitCounter++}`);
      remainingPax -= 1;
    }
  }

  return {
    success: true,
    updates: [
      {
        booking_ref: newReservationBlock.booking_ref || newReservationBlock.id,
        assigned_seats: forcedAssigned
      }
    ]
  };
}

/**
 * Reseat bookings displaced by check-in, move, or add-person across all their sessions.
 * (Section 4.1)
 * @param {any} tx - Prisma transaction
 * @param {object} params
 * @param {string[]} params.bookingRefs - refs of displaced bookings to reseat
 * @param {string[]} params.reservedSeats - seats being taken by the primary action
 * @param {number[]} params.sessionIds - session IDs where reservedSeats are held
 * @returns {Promise<Array<{ booking_ref: string, name: string, from: string[], to: string[] }>>}
 */
/**
 * 檢查給定時段是否有任何座位重複劃位（最後一道防線）
 */
export async function assertNoSeatCollisions(tx, sessionIds) {
  if (!sessionIds || !sessionIds.length) return;
  const numSessionIds = [...new Set(sessionIds.map(Number))].filter(n => Number.isInteger(n));
  if (!numSessionIds.length) return;

  const collisions = await tx.$queryRawUnsafe(`
    SELECT session_id, seat, count(distinct booking_ref)::int as count
    FROM "Reservation", unnest(assigned_seats) seat
    WHERE status <> 'cancelled' AND seat NOT LIKE 'WAIT-%'
      AND session_id IN (${numSessionIds.join(',')})
    GROUP BY 1, 2 HAVING count(distinct booking_ref) > 1
  `);

  if (collisions && collisions.length > 0) {
    const list = collisions.map(c => `${c.seat} (時段 ${c.session_id})`).join('、');
    throw {
      status: 409,
      code: 'SEAT_COLLISION',
      message: `座位衝突：時段內檢測到重複劃位（${list}）`
    };
  }
}

/**
 * 重新排位指定預約（若被擠走）
 * @param {any} tx - Prisma transaction
 * @param {object} params
 * @param {string[]} params.bookingRefs - refs of displaced bookings to reseat
 * @param {string[]} params.reservedSeats - seats being taken by the primary action
 * @param {number[]} params.sessionIds - session IDs where reservedSeats are held
 * @param {string} [params.primaryBookingRef] - booking ref of the primary action (excluded from occupied reservations)
 * @returns {Promise<Array<{ booking_ref: string, name: string, from: string[], to: string[] }>>}
 */
export async function reseatBookings(tx, { bookingRefs = [], reservedSeats = [], sessionIds = [], primaryBookingRef = null }) {
  const displaced = [];
  if (!bookingRefs.length) return displaced;

  const uniqueRefs = [...new Set(bookingRefs)];
  const allTouchedSessionIds = new Set(sessionIds);

  for (const bRef of uniqueRefs) {
    const bResvs = await tx.reservation.findMany({
      where: { booking_ref: bRef, status: { not: 'cancelled' } },
      include: { session: true, user: true },
      orderBy: { session: { start_time: 'asc' } }
    });
    if (!bResvs.length) continue;

    const firstRes = bResvs[0];
    const bSessionIds = bResvs.map(r => r.session_id);
    bSessionIds.forEach(sid => allTouchedSessionIds.add(sid));
    const bPax = firstRes.pax;
    const bForceSplit = Boolean(firstRes.is_force_split);
    const sessionDate = firstRes.session.session_date;

    const ctx = await loadAllocatorContext(tx, sessionDate);
    if (!ctx.layout) {
      throw {
        status: 409,
        code: 'CANNOT_DISPLACE',
        message: `原座位佔用者（${firstRes.user?.name || bRef}）自動改排失敗，無可用版面`
      };
    }

    const allSessionIds = [...new Set([...bSessionIds, ...sessionIds])];
    const allResvsInSessions = await tx.reservation.findMany({
      where: { session_id: { in: allSessionIds }, status: { not: 'cancelled' } }
    });

    // Inject dummy pinned reservation for reservedSeats in relevant sessions
    const dummyReserved = sessionIds.map(sid => ({
      booking_ref: `__RESERVED_${sid}__`,
      session_id: sid,
      pax: reservedSeats.length,
      assigned_seats: reservedSeats,
      is_seat_locked: true,
      attendance: 'checked_in',
      is_pinned: true
    }));

    const excludeRefs = new Set([bRef, primaryBookingRef].filter(Boolean));
    const otherResvs = allResvsInSessions.filter(r => !excludeRefs.has(r.booking_ref));
    const currentReservations = [...otherResvs, ...dummyReserved];

    const newReservationBlock = {
      booking_ref: bRef,
      pax: bPax,
      session_ids: bSessionIds,
      original_sessions: bResvs
    };

    const allocResult = allocateWithLayout(currentReservations, newReservationBlock, bForceSplit, ctx);

    if (!allocResult.success || !allocResult.updates || !allocResult.updates.length) {
      throw {
        status: 409,
        code: 'CANNOT_DISPLACE',
        message: `原座位佔用者（${firstRes.user?.name || bRef}）自動改排失敗，座位不足`
      };
    }

    // Apply EVERY update in allocResult.updates (Spec 1.2)
    for (const update of allocResult.updates) {
      const uRef = update.booking_ref;
      if (!uRef || uRef.startsWith('__RESERVED_')) continue;
      const newSeats = update.assigned_seats;

      if (!newSeats || !newSeats.length || newSeats.some(s => s.startsWith('WAIT-'))) {
        throw {
          status: 409,
          code: 'CANNOT_DISPLACE',
          message: `原座位佔用者（${uRef}）自動改排失敗，座位不足`
        };
      }

      // Fetch original reservations for this booking
      const targetResvs = await tx.reservation.findMany({
        where: { booking_ref: uRef, status: { not: 'cancelled' } },
        include: { user: true }
      });
      if (!targetResvs.length) continue;
      const origSeats = targetResvs[0].assigned_seats || [];

      // Update reservation seats across ALL sessions of this booking
      await tx.reservation.updateMany({
        where: { booking_ref: uRef, status: { not: 'cancelled' } },
        data: { assigned_seats: newSeats }
      });

      // Sync booking person seats if any exist
      const bPersons = await tx.bookingPerson.findMany({
        where: { booking_ref: uRef },
        orderBy: { person_no: 'asc' }
      });
      for (let i = 0; i < bPersons.length; i++) {
        await tx.bookingPerson.update({
          where: { id: bPersons[i].id },
          data: { seat_code: newSeats[i] || null }
        });
      }

      // Add to displaced list
      const existingDisp = displaced.find(d => d.booking_ref === uRef);
      if (!existingDisp) {
        displaced.push({
          booking_ref: uRef,
          name: targetResvs[0].user?.name || '客人',
          from: origSeats,
          to: newSeats
        });
      } else {
        existingDisp.to = newSeats;
      }
    }
  }

  // Final check: assert no collisions in any touched sessions (when not in intermediate state with a caller)
  if (!primaryBookingRef) {
    await assertNoSeatCollisions(tx, Array.from(allTouchedSessionIds));
  }

  displaced.touchedSessionIds = Array.from(allTouchedSessionIds);
  return displaced;
}
