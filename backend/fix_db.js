import { PrismaClient } from '@prisma/client';
import { allocateSeats } from './src/utils/SeatAllocator.js'; // Just to get SEATS, findConsecutiveSeats etc? No they are not exported.

const prisma = new PrismaClient();

const SEATS = [
  'A1-1', 'A1-2', 'A1-3', 'A1-4', 
  'A2-1', 'A2-2', 'A2-3', 'A2-4', 
  'B1-1', 'B1-2', 'B1-3', 'B1-4', 
  'B2-1', 'B2-2', 'B2-3', 'B2-4'
];

const areAvailable = (availableSeats, targets) => targets.every(t => availableSeats.includes(t));

const findConsecutiveSeats = (availableSeats, pax) => {
  if (pax > 4) return null;
  if (pax === 4) {
    if (areAvailable(availableSeats, ['B1-1', 'B1-2', 'B1-3', 'B1-4'])) return ['B1-1', 'B1-2', 'B1-3', 'B1-4'];
    if (areAvailable(availableSeats, ['B2-1', 'B2-2', 'B2-3', 'B2-4'])) return ['B2-1', 'B2-2', 'B2-3', 'B2-4'];
    if (areAvailable(availableSeats, ['A1-1', 'A1-2', 'A1-3', 'A1-4'])) return ['A1-1', 'A1-2', 'A1-3', 'A1-4'];
    if (areAvailable(availableSeats, ['A2-1', 'A2-2', 'A2-3', 'A2-4'])) return ['A2-1', 'A2-2', 'A2-3', 'A2-4'];
  }
  if (pax === 3) {
    const aOptions = [['A1-1', 'A1-2', 'A1-3'], ['A1-2', 'A1-3', 'A1-4'], ['A2-1', 'A2-2', 'A2-3'], ['A2-2', 'A2-3', 'A2-4']];
    for (const opt of aOptions) if (areAvailable(availableSeats, opt)) return opt;
    const bOptions = [['B1-1', 'B1-2', 'B1-3'], ['B1-1', 'B1-2', 'B1-4'], ['B1-2', 'B1-3', 'B1-4'], ['B1-1', 'B1-3', 'B1-4'],
                      ['B2-1', 'B2-2', 'B2-3'], ['B2-1', 'B2-2', 'B2-4'], ['B2-2', 'B2-3', 'B2-4'], ['B2-1', 'B2-3', 'B2-4']];
    for (const opt of bOptions) if (areAvailable(availableSeats, opt)) return opt;
  }
  if (pax === 2) {
    const bOptions = [['B1-1', 'B1-2'], ['B1-3', 'B1-4'], ['B2-1', 'B2-2'], ['B2-3', 'B2-4']];
    for (const opt of bOptions) if (areAvailable(availableSeats, opt)) return opt;
    const aOptions = [['A1-1', 'A1-2'], ['A1-2', 'A1-3'], ['A1-3', 'A1-4'], ['A2-1', 'A2-2'], ['A2-2', 'A2-3'], ['A2-3', 'A2-4']];
    for (const opt of aOptions) if (areAvailable(availableSeats, opt)) return opt;
  }
  if (pax === 1) {
    const aSeats = availableSeats.filter(s => s.startsWith('A'));
    if (aSeats.length > 0) return [aSeats[0]];
    const bSeats = availableSeats.filter(s => s.startsWith('B'));
    if (bSeats.length > 0) return [bSeats[0]];
  }
  return null;
};

const getIntersectionAvailableSeats = (blocks, targetSessionIds, excludeRef = null) => {
  const occupiedSeats = new Set();
  for (const block of blocks) {
    if (excludeRef && block.booking_ref === excludeRef) continue;
    const intersects = block.session_ids.some(sid => targetSessionIds.includes(sid));
    if (intersects && block.assigned_seats) {
      block.assigned_seats.forEach(seat => occupiedSeats.add(seat));
    }
  }
  return SEATS.filter(s => !occupiedSeats.has(s));
};

async function main() {
  const dates = await prisma.session.findMany({ select: { session_date: true }, distinct: ['session_date'] });

  for (const { session_date } of dates) {
    console.log(`Processing date: ${session_date.toISOString().split('T')[0]}`);
    
    await prisma.$transaction(async (tx) => {
      const sessionsOfDay = await tx.session.findMany({ where: { session_date } });
      const sessionIds = sessionsOfDay.map(s => s.id);

      const currentReservations = await tx.reservation.findMany({
        where: { session_id: { in: sessionIds }, status: 'confirmed' }
      });

      if (currentReservations.length === 0) return;

      const blocksMap = new Map();
      for (const r of currentReservations) {
        if (!blocksMap.has(r.booking_ref)) {
          blocksMap.set(r.booking_ref, {
            booking_ref: r.booking_ref,
            pax: r.pax,
            session_ids: [],
            assigned_seats: r.assigned_seats || [],
            is_pinned: false,
            original_sessions: []
          });
        }
        const block = blocksMap.get(r.booking_ref);
        if (!block.session_ids.includes(r.session_id)) block.session_ids.push(r.session_id);
        if (r.attendance !== null || r.pax >= 3 || r.is_seat_locked === true || block.session_ids.length > 1) block.is_pinned = true;
        block.original_sessions.push({ session_id: r.session_id, assigned_seats: r.assigned_seats || [] });
      }

      for (const block of blocksMap.values()) {
        let inconsistent = false;
        // 0. CRITICAL: Filter out any null/undefined ghost seats!
        const baseSeats = (block.assigned_seats || []).filter(s => s !== null && s !== undefined);
        
        // 1. Check if seats are consistent across all sessions
        for (const os of block.original_sessions) {
          const osSeats = (os.assigned_seats || []).filter(s => s !== null && s !== undefined);
          if (baseSeats.length !== osSeats.length || !baseSeats.every(s => osSeats.includes(s))) {
            inconsistent = true; break;
          }
        }
        
        // 2. CRITICAL: Check if the block has fewer seats than pax (partial seats bug)
        if (baseSeats.length < block.pax) {
          inconsistent = true;
        }

        // 3. CRITICAL: If the block is sitting in the WAIT area, it MUST be unpinned so it has a chance to get a real seat!
        if (baseSeats.some(s => typeof s === 'string' && s.startsWith('WAIT-'))) {
          inconsistent = true;
        }

        if (inconsistent) block.is_pinned = false;
      }

      // 3. SUPER CRITICAL: Double Booking Detection
      // Check if any pinned blocks collide with each other in any session
      const blocks = Array.from(blocksMap.values());
      const sessionSeatMap = new Map(); // "session_id_seatId" -> booking_ref
      for (const block of blocks) {
        if (!block.is_pinned) continue;
        const validSeats = (block.assigned_seats || []).filter(s => s !== null && s !== undefined);
        for (const sid of block.session_ids) {
          for (const seat of validSeats) {
            const key = `${sid}_${seat}`;
            if (sessionSeatMap.has(key)) {
              // COLLISION DETECTED! Unpin BOTH blocks!
              const otherRef = sessionSeatMap.get(key);
              const otherBlock = blocks.find(b => b.booking_ref === otherRef);
              if (otherBlock) otherBlock.is_pinned = false;
              block.is_pinned = false;
            } else {
              sessionSeatMap.set(key, block.booking_ref);
            }
          }
        }
      }

      const updates = [];
      const unpinnedBlocks = blocks.filter(b => !b.is_pinned);
      const pinnedBlocks = blocks.filter(b => b.is_pinned);

      unpinnedBlocks.sort((a, b) => {
        if (b.pax !== a.pax) return b.pax - a.pax;
        return b.session_ids.length - a.session_ids.length;
      });

      const virtualBlocks = [...pinnedBlocks]; 
      let reshuffleSuccess = true;

      for (const reqBlock of unpinnedBlocks) {
        const virtAvailable = getIntersectionAvailableSeats(virtualBlocks, reqBlock.session_ids);
        let seats = findConsecutiveSeats(virtAvailable, reqBlock.pax);
        
        if (!seats) {
           console.log(`    ! Forced split required for ${reqBlock.booking_ref} pax ${reqBlock.pax}`);
           seats = [];
           let remaining = reqBlock.pax;
           let tempAvail = [...virtAvailable];
           while(remaining > 0) {
              let chunk = remaining > 4 ? 4 : remaining;
              let chunkSeats = null;
              while(chunk > 0) {
                 chunkSeats = findConsecutiveSeats(tempAvail, chunk);
                 if (chunkSeats) break;
                 chunk--;
              }
              if (!chunkSeats) {
                 const s = tempAvail.shift() || `WAIT-${Math.random().toString(36).substring(2, 6).toUpperCase()}`;
                 chunkSeats = [s];
              }
              seats.push(...chunkSeats);
              tempAvail = tempAvail.filter(s => !chunkSeats.includes(s));
              remaining -= chunkSeats.length;
           }
        }

        if (seats.length < reqBlock.pax) {
           console.log(`    ! FAILED to allocate enough continuous seats for ${reqBlock.booking_ref}. Retaining original inconsistent seats.`);
           // Fallback: Just put their original inconsistent seats back into virtualBlocks so they occupy space
           for (const os of reqBlock.original_sessions) {
             virtualBlocks.push({
               ...reqBlock,
               session_ids: [os.session_id],
               assigned_seats: os.assigned_seats
             });
           }
           // Do not add to updates, so DB retains original
           continue;
        }

        virtualBlocks.push({ ...reqBlock, assigned_seats: seats });
        updates.push({ booking_ref: reqBlock.booking_ref, assigned_seats: seats });
      }

      let count = 0;
      for (const update of updates) {
        await tx.reservation.updateMany({
          where: { booking_ref: update.booking_ref },
          data: { assigned_seats: update.assigned_seats }
        });
        count++;
      }
      if (count > 0) {
        console.log(`  -> Reallocated ${count} unpinned/inconsistent blocks.`);
      }
    });
  }
}

main().catch(e => { console.error(e); process.exit(1); }).finally(async () => { await prisma.$disconnect(); });
