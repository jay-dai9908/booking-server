// backend/src/scripts/splitBoardUnits.js
import '../loadEnv.js';
import prisma from '../prismaClient.js';
import { splitBoardUnits } from '../services/floor/liveService.js';

async function run() {
  const bookingArgIndex = process.argv.findIndex(arg => arg === '--booking');
  const bookingRef = bookingArgIndex !== -1 ? process.argv[bookingArgIndex + 1] : process.argv[2];

  if (!bookingRef) {
    console.error('Usage: node src/scripts/splitBoardUnits.js --booking BK-xxxx');
    process.exit(1);
  }

  console.log(`[splitBoardUnits] Splitting equipment for booking: ${bookingRef}...`);
  try {
    const result = await prisma.$transaction(async (tx) => {
      return await splitBoardUnits(tx, bookingRef);
    });
    console.log(`[splitBoardUnits] Successfully split units for ${bookingRef}:`, result.length, 'units total.');
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    console.error('[splitBoardUnits] Error splitting equipment:', err);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

run();
