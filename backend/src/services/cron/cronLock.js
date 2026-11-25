import os from 'os';
import prisma from '../../prismaClient.js';

/**
 * Format Taipei-timezone run keys for scheduled jobs.
 * - daily:   YYYY-MM-DD
 * - hourly:  YYYY-MM-DDTHH
 * - fiveMin: YYYY-MM-DDTHH:mm (floored to 5-minute intervals)
 */
export function taipeiCronRunKeys(now = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Taipei',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  });
  const parts = Object.fromEntries(fmt.formatToParts(now).map((p) => [p.type, p.value]));
  const ymd = `${parts.year}-${parts.month}-${parts.day}`;
  const hh = parts.hour;
  const mmFloor = String(Math.floor(Number(parts.minute) / 5) * 5).padStart(2, '0');
  return {
    daily: ymd,
    hourly: `${ymd}T${hh}`,
    fiveMin: `${ymd}T${hh}:${mmFloor}`
  };
}

/**
 * Distributed single-execution cron lock backed by PostgreSQL CronRun @@unique([job, run_key]).
 *
 * Why CronRun instead of PostgreSQL session advisory lock (pg_try_advisory_lock):
 * Prisma's connection pool does not guarantee that lock acquisition and unlock happen on
 * the exact same underlying PostgreSQL connection, which can cause leaked or colliding
 * session locks across requests/processes. An atomic INSERT + unique constraint cleanly
 * arbitrates execution ownership across processes.
 */
export async function runCronOnce(job, runKey, fn, client = prisma) {
  const host = os.hostname();
  let record = null;
  try {
    record = await client.cronRun.create({
      data: {
        job: String(job),
        run_key: String(runKey),
        status: 'running',
        host
      }
    });
  } catch (err) {
    if (err?.code === 'P2002') {
      console.log(`[CronLock] Duplicate run skipped: job=${job}, run_key=${runKey}`);
      return { skipped: true, reason: 'ALREADY_CLAIMED' };
    }
    throw err;
  }

  try {
    const result = await fn();
    const resultPayload = result !== undefined ? result : { ok: true };
    await client.cronRun.update({
      where: { id: record.id },
      data: {
        status: 'done',
        finished_at: new Date(),
        result_json: resultPayload
      }
    });
    return { skipped: false, status: 'done', result: resultPayload };
  } catch (err) {
    const errMsg = err?.message || String(err);
    await client.cronRun.update({
      where: { id: record.id },
      data: {
        status: 'failed',
        finished_at: new Date(),
        result_json: { error: errMsg }
      }
    });
    throw err;
  }
}
