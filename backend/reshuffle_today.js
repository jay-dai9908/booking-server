import prisma from './src/prismaClient.js';
import { allocateSeats } from './src/utils/SeatAllocator.js';

// We will temporarily redefine groupReservations to force everyone to be unpinned
function forceGroupReservations(reservations) {
  const blocksMap = new Map();
  for (const r of reservations) {
    if (!blocksMap.has(r.booking_ref)) {
      blocksMap.set(r.booking_ref, {
        booking_ref: r.booking_ref,
        pax: r.pax,
        session_ids: [],
        assigned_seats: [],
        is_pinned: false,
        original_sessions: []
      });
    }
    const block = blocksMap.get(r.booking_ref);
    if (!block.session_ids.includes(r.session_id)) {
      block.session_ids.push(r.session_id);
    }
  }
  return Array.from(blocksMap.values());
}

const SEATS = [
  'A1-1', 'A1-2', 'A1-3', 'A1-4', 
  'A2-1', 'A2-2', 'A2-3', 'A2-4', 
  'B1-1', 'B1-2', 'B1-3', 'B1-4', 
  'B2-1', 'B2-2', 'B2-3', 'B2-4'
];

const areAvailable = (availableSeats, targets) => {
  return targets.every(t => availableSeats.includes(t));
};

const findConsecutiveSeats = (availableSeats, pax) => {
  if (pax > 4) return null;

  if (pax === 4) {
    if (areAvailable(availableSeats, ['B1-1', 'B1-2', 'B1-3', 'B1-4'])) return ['B1-1', 'B1-2', 'B1-3', 'B1-4'];
    if (areAvailable(availableSeats, ['B2-1', 'B2-2', 'B2-3', 'B2-4'])) return ['B2-1', 'B2-2', 'B2-3', 'B2-4'];
    if (areAvailable(availableSeats, ['A1-1', 'A1-2', 'A1-3', 'A1-4'])) return ['A1-1', 'A1-2', 'A1-3', 'A1-4'];
    if (areAvailable(availableSeats, ['A2-1', 'A2-2', 'A2-3', 'A2-4'])) return ['A2-1', 'A2-2', 'A2-3', 'A2-4'];
  }

  if (pax === 3) {
    const aOptions = [
      ['A1-1', 'A1-2', 'A1-3'], ['A1-2', 'A1-3', 'A1-4'],
      ['A2-1', 'A2-2', 'A2-3'], ['A2-2', 'A2-3', 'A2-4']
    ];
    for (const opt of aOptions) {
      if (areAvailable(availableSeats, opt)) return opt;
    }
    const bOptions = [
      ['B1-1', 'B1-2', 'B1-3'], ['B1-1', 'B1-2', 'B1-4'], ['B1-2', 'B1-3', 'B1-4'], ['B1-1', 'B1-3', 'B1-4'],
      ['B2-1', 'B2-2', 'B2-3'], ['B2-1', 'B2-2', 'B2-4'], ['B2-2', 'B2-3', 'B2-4'], ['B2-1', 'B2-3', 'B2-4']
    ];
    for (const opt of bOptions) {
      if (areAvailable(availableSeats, opt)) return opt;
    }
  }

  if (pax === 2) {
    const bOptions = [
      ['B1-1', 'B1-2'], ['B1-3', 'B1-4'],
      ['B2-1', 'B2-2'], ['B2-3', 'B2-4']
    ];
    for (const opt of bOptions) {
      if (areAvailable(availableSeats, opt)) return opt;
    }
    const aOptions = [
      ['A1-1', 'A1-2'], ['A1-2', 'A1-3'], ['A1-3', 'A1-4'],
      ['A2-1', 'A2-2'], ['A2-2', 'A2-3'], ['A2-3', 'A2-4']
    ];
    for (const opt of aOptions) {
      if (areAvailable(availableSeats, opt)) return opt;
    }
  }

  if (pax === 1) {
    const aSeats = availableSeats.filter(s => s.startsWith('A'));
    if (aSeats.length > 0) return [aSeats[0]];
    const bSeats = availableSeats.filter(s => s.startsWith('B'));
    if (bSeats.length > 0) return [bSeats[0]];
  }

  return null;
};

const getIntersectionAvailableSeats = (blocks, targetSessionIds) => {
  const occupiedSeats = new Set();
  for (const block of blocks) {
    const intersects = block.session_ids.some(sid => targetSessionIds.includes(sid));
    if (intersects && block.assigned_seats) {
      block.assigned_seats.forEach(seat => occupiedSeats.add(seat));
    }
  }
  return SEATS.filter(s => !occupiedSeats.has(s));
};

async function reshuffle() {
  const targetDateStr = process.argv[2] || new Date().toISOString().split('T')[0];
  const start = new Date(`${targetDateStr}T00:00:00Z`);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  console.log(`Reshuffling seats for date: ${targetDateStr}`);

  const sessions = await prisma.session.findMany({
    where: { session_date: { gte: start, lt: end } }
  });
  const sessionIds = sessions.map(s => s.id);

  const reservations = await prisma.reservation.findMany({
    where: { session_id: { in: sessionIds }, status: 'confirmed' }
  });

  const unpinnedBlocks = forceGroupReservations(reservations);
  
  unpinnedBlocks.sort((a, b) => {
    if (b.pax !== a.pax) return b.pax - a.pax;
    return b.session_ids.length - a.session_ids.length;
  });

  const virtualBlocks = [];
  const updates = [];
  let waitCounter = 1;

  for (const reqBlock of unpinnedBlocks) {
    const virtAvailable = getIntersectionAvailableSeats(virtualBlocks, reqBlock.session_ids);
    const seats = findConsecutiveSeats(virtAvailable, reqBlock.pax);
    
    if (seats) {
      virtualBlocks.push({
        ...reqBlock,
        assigned_seats: seats
      });
      updates.push({
        booking_ref: reqBlock.booking_ref,
        assigned_seats: seats
      });
    } else {
      console.log('Failed to fit:', reqBlock.booking_ref);
      const waitSeats = [];
      for (let i = 0; i < (reqBlock.pax || 1); i++) {
        waitSeats.push(`WAIT-${waitCounter++}`);
      }
      updates.push({
        booking_ref: reqBlock.booking_ref,
        assigned_seats: waitSeats
      });
    }
  }

  if (updates.length > 0) {
    const txs = updates.map(update => 
      prisma.reservation.updateMany({
        where: { booking_ref: update.booking_ref },
        data: { 
          assigned_seats: update.assigned_seats,
          is_seat_locked: false // reset lock
        }
      })
    );
    await prisma.$transaction(txs);
    console.log(`Successfully forced reallocated ${updates.length} groups.`);
  }
}

reshuffle()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
