import { allocateSeats } from './src/utils/SeatAllocator.js';

console.log("=== Test 1: Simple FCFS ===");
const result1 = allocateSeats([], { id: 'RES1', pax: 4 });
console.log(result1); // Should assign a full B table e.g. B1-1 to B1-4

console.log("\n=== Test 2: N=3 FCFS ===");
const result2 = allocateSeats([], { id: 'RES2', pax: 3 });
console.log(result2); // Should assign A table e.g. A1-1 to A1-3

console.log("\n=== Test 3: Local Reshuffle ===");
// Let's pretend the system is highly fragmented
const fragmentedReservations = [
  { id: 'RES_A', pax: 1, attendance: null, assigned_seats: ['A1-1'] },
  { id: 'RES_B', pax: 1, attendance: null, assigned_seats: ['A1-3'] },
  { id: 'RES_C', pax: 2, attendance: null, assigned_seats: ['A2-1', 'A2-3'] }, // highly fragmented
];

// Try to book 4 people. Without reshuffle, FCFS might fail if all tables have at least 1 person.
// Wait, if B tables are empty, FCFS will just grab B tables. 
// Let's occupy all tables:
const heavilyFragmented = [
  { id: 'R1', pax: 1, attendance: null, assigned_seats: ['A1-1'] },
  { id: 'R2', pax: 1, attendance: null, assigned_seats: ['A2-1'] },
  { id: 'R3', pax: 1, attendance: null, assigned_seats: ['B1-1'] },
  { id: 'R4', pax: 1, attendance: null, assigned_seats: ['B2-1'] },
  { id: 'R5', pax: 1, attendance: null, assigned_seats: ['A1-3'] },
  { id: 'R6', pax: 1, attendance: null, assigned_seats: ['A2-3'] },
  { id: 'R7', pax: 1, attendance: null, assigned_seats: ['B1-3'] },
  { id: 'R8', pax: 1, attendance: null, assigned_seats: ['B2-3'] },
]; // 8 pax total, no table has 3 consecutive seats!

const result3 = allocateSeats(heavilyFragmented, { id: 'NEW_RES_3', pax: 3 });
console.log(result3);
// Should succeed, pack the 1s together and give NEW_RES_3 a solid block!

console.log("\n=== Test 4: Force Split Fallback ===");
// Pinned reservations occupying all tables
const pinnedFragmented = heavilyFragmented.map(r => ({ ...r, attendance: 'checked_in' }));
const result4 = allocateSeats(pinnedFragmented, { id: 'NEW_RES_3', pax: 3, forceSplit: false });
console.log(result4); // Should fail with SPLIT_REQUIRED

const result5 = allocateSeats(pinnedFragmented, { id: 'NEW_RES_3', pax: 3 }, true); // forceSplit = true
console.log(result5); // Should succeed and grab scattered seats
