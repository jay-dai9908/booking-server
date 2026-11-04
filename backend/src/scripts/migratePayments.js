import '../loadEnv.js';
import crypto from 'crypto';
import prisma from '../prismaClient.js';
import { toTaipeiDateString } from '../../../shared/time.js';

const isDryRun = process.argv.includes('--dry-run');

async function run() {
  console.log(`[migratePayments] Starting migration... (dry_run: ${isDryRun})`);

  // Find all confirmed reservations that are marked paid
  const paidReservations = await prisma.reservation.findMany({
    where: {
      status: { not: 'cancelled' },
      is_paid: true
    },
    include: { session: true },
    orderBy: { created_at: 'asc' }
  });

  const bookingsMap = new Map();
  for (const r of paidReservations) {
    if (!bookingsMap.has(r.booking_ref)) {
      bookingsMap.set(r.booking_ref, r);
    }
  }

  const existingPayments = await prisma.payment.findMany({
    select: { booking_ref: true }
  });
  const existingRefs = new Set(existingPayments.map(p => p.booking_ref));

  const toMigrate = [];
  for (const [bRef, r] of bookingsMap.entries()) {
    if (!existingRefs.has(bRef)) {
      toMigrate.push(r);
    }
  }

  console.log(`[migratePayments] Found ${bookingsMap.size} paid bookings, ${existingRefs.size} already in Payment table.`);
  console.log(`[migratePayments] ${toMigrate.length} bookings to be migrated.`);

  if (toMigrate.length === 0) {
    console.log('[migratePayments] Nothing to migrate.');
    await prisma.$disconnect();
    return;
  }

  if (isDryRun) {
    console.log(`[migratePayments] DRY RUN completed. Would migrate ${toMigrate.length} payments.`);
    await prisma.$disconnect();
    return;
  }

  let migratedCount = 0;
  for (const r of toMigrate) {
    const createdAt = r.paid_at || r.created_at || new Date();
    const dStr = toTaipeiDateString(createdAt);
    const d = new Date(`${dStr}T00:00:00+08:00`);

    const counter = await prisma.dailyCounter.upsert({
      where: { date_key: { date: d, key: 'payment' } },
      update: { value: { increment: 1 } },
      create: { date: d, key: 'payment', value: 1 }
    });

    const paymentNo = `R-${String(counter.value).padStart(4, '0')}`;
    const batchNo = `B-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    const amount = r.total_amount || 0;
    const method = r.payment_method || 'other';
    const personNos = Array.from({ length: r.pax || 1 }, (_, i) => i + 1);

    const breakdownJson = r.checkout_details && typeof r.checkout_details === 'object'
      ? r.checkout_details
      : { legacy: true, amount };

    await prisma.payment.create({
      data: {
        payment_no: paymentNo,
        batch_no: batchNo,
        booking_ref: r.booking_ref,
        kind: 'charge',
        status: 'valid',
        method,
        amount,
        person_nos: personNos,
        breakdown_json: breakdownJson,
        staff_name: '舊資料轉入',
        device_label: '系統',
        created_at: createdAt
      }
    });

    migratedCount++;
  }

  // Write single audit log summary for migration
  await prisma.accountingEvent.create({
    data: {
      event_type: 'payment_created',
      category: 'payment',
      summary: `舊資料轉入 ${migratedCount} 筆收款`,
      staff_name: '系統',
      device_label: '系統'
    }
  });

  console.log(`[migratePayments] Successfully migrated ${migratedCount} payments.`);
  await prisma.$disconnect();
}

run().catch(err => {
  console.error('[migratePayments] Error:', err);
  process.exit(1);
});
