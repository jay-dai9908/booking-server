import '../src/loadEnv.js';
import { pathToFileURL } from 'url';
import prisma from '../src/prismaClient.js';
import { getTaipeiDateParts } from '../src/utils/dateUtils.js';

/**
 * Backfill BookingPerson.left_at for legacy rows where timer_ended_at is already set
 * and the reservation has completed or belongs to a day earlier than Taipei today.
 * Default is dry-run; pass --apply to write changes.
 */
export async function backfillPersonLeftAt({ dryRun = true, client = prisma, now = new Date() } = {}) {
  const { dateObject: todayMidnightUtc } = getTaipeiDateParts(now);

  const candidates = await client.bookingPerson.findMany({
    where: {
      timer_ended_at: { not: null },
      left_at: null
    },
    orderBy: [{ booking_ref: 'asc' }, { person_no: 'asc' }],
    select: {
      id: true,
      booking_ref: true,
      person_no: true,
      timer_ended_at: true
    }
  });

  if (candidates.length === 0) {
    return { dryRun, total: 0, updated: 0, sample: [] };
  }

  const bookingRefs = [...new Set(candidates.map(c => c.booking_ref))];
  const reservations = await client.reservation.findMany({
    where: {
      booking_ref: { in: bookingRefs },
      status: { not: 'cancelled' }
    },
    select: {
      booking_ref: true,
      attendance: true,
      session: { select: { session_date: true } }
    }
  });

  const eligibleRefs = new Set();
  for (const r of reservations) {
    const isCompleted = r.attendance === 'completed';
    const isPastDay = r.session?.session_date && new Date(r.session.session_date).getTime() < todayMidnightUtc.getTime();
    if (isCompleted || isPastDay) {
      eligibleRefs.add(r.booking_ref);
    }
  }

  const targets = candidates.filter(c => eligibleRefs.has(c.booking_ref));
  const sample = targets.slice(0, 20).map(t => ({
    booking_ref: t.booking_ref,
    person_no: t.person_no
  }));

  if (dryRun || targets.length === 0) {
    return { dryRun, total: targets.length, updated: 0, sample };
  }

  let updated = 0;
  for (const t of targets) {
    const res = await client.bookingPerson.updateMany({
      where: { id: t.id, left_at: null },
      data: { left_at: t.timer_ended_at }
    });
    updated += res.count;
  }

  return { dryRun: false, total: targets.length, updated, sample };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const apply = process.argv.includes('--apply');
  backfillPersonLeftAt({ dryRun: !apply })
    .then((result) => {
      console.log(`[backfill-person-left-at] mode=${result.dryRun ? 'DRY-RUN' : 'APPLY'} eligible=${result.total} updated=${result.updated}`);
      for (const row of result.sample) {
        console.log(`  - ${row.booking_ref} person_no=${row.person_no}`);
      }
      return prisma.$disconnect();
    })
    .catch(async (err) => {
      console.error('[backfill-person-left-at] Error:', err);
      await prisma.$disconnect().catch(() => {});
      process.exit(1);
    });
}
