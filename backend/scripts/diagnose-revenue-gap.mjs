// Read-only diagnostic script for daily revenue vs paid bookings without Payment rows
// Usage: node backend/scripts/diagnose-revenue-gap.mjs --from YYYY-MM-DD --to YYYY-MM-DD
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import prisma from '../src/prismaClient.js';
import { dateOnly, toTaipeiDateString } from '../../shared/time.js';
import { REVENUE_PAYMENT_SOURCES, isRevenuePayment } from '../src/services/accounting/revenueScope.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env') });

function buildDateList(fromStr, toStr) {
  const days = [];
  const cursor = new Date(`${fromStr}T00:00:00Z`);
  const endD = new Date(`${toStr}T00:00:00Z`);
  while (cursor <= endD) {
    days.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return days;
}

/**
 * 唯讀診斷：逐日比較 Payment 營收與「已標記已付但無有效 Payment 紀錄 / 只有作廢收款」的預約差額
 */
export async function diagnoseRevenueGap(client = prisma, { from, to } = {}) {
  const todayStr = toTaipeiDateString(new Date());
  const defaultFrom = `${todayStr.slice(0, 7)}-01`;
  const fromStr = (from || defaultFrom).trim();
  const toStr = (to || todayStr).trim();

  const startDt = new Date(`${fromStr}T00:00:00+08:00`);
  const endDt = new Date(`${toStr}T23:59:59.999+08:00`);
  const sessionStart = dateOnly(fromStr);
  const sessionEnd = dateOnly(toStr);

  const [periodPayments, reservations] = await Promise.all([
    client.payment.findMany({
      where: {
        created_at: { gte: startDt, lte: endDt },
        source: { in: REVENUE_PAYMENT_SOURCES }
      },
      select: {
        id: true,
        booking_ref: true,
        source: true,
        kind: true,
        method: true,
        status: true,
        amount: true,
        created_at: true
      }
    }),
    client.reservation.findMany({
      where: {
        status: { not: 'cancelled' },
        session: {
          session_date: { gte: sessionStart, lte: sessionEnd }
        }
      },
      select: {
        booking_ref: true,
        is_paid: true,
        billing_status: true,
        total_amount: true,
        amount_due: true,
        session: { select: { session_date: true } }
      }
    })
  ]);

  // Unique reservations in range
  const resByRef = new Map();
  for (const r of reservations) {
    if (!resByRef.has(r.booking_ref)) {
      resByRef.set(r.booking_ref, {
        booking_ref: r.booking_ref,
        date: toTaipeiDateString(r.session.session_date),
        is_paid: Boolean(r.is_paid) || r.billing_status === 'paid',
        amount: r.total_amount ?? r.amount_due ?? 0
      });
    }
  }

  const targetRefs = Array.from(resByRef.keys());
  const allPaymentsForRefs = targetRefs.length > 0
    ? await client.payment.findMany({
        where: {
          source: 'booking',
          booking_ref: { in: targetRefs }
        },
        select: {
          booking_ref: true,
          status: true
        }
      })
    : [];

  const payStateByRef = new Map();
  for (const p of allPaymentsForRefs) {
    const cur = payStateByRef.get(p.booking_ref) || { validCount: 0, voidCount: 0 };
    if (p.status === 'valid') cur.validCount += 1;
    else if (p.status === 'voided') cur.voidCount += 1;
    payStateByRef.set(p.booking_ref, cur);
  }

  const dailyMap = new Map();
  for (const d of buildDateList(fromStr, toStr)) {
    dailyMap.set(d, {
      date: d,
      payment_net_revenue: 0,
      paid_no_payment_count: 0,
      paid_no_payment_amount: 0,
      void_only_count: 0
    });
  }

  for (const p of periodPayments) {
    if (p.status !== 'valid' || !isRevenuePayment(p) || p.method === 'pass') continue;
    const dStr = toTaipeiDateString(p.created_at);
    const bucket = dailyMap.get(dStr);
    if (!bucket) continue;
    if (p.kind === 'charge' || p.kind === 'supplement') {
      bucket.payment_net_revenue += p.amount || 0;
    } else if (p.kind === 'refund') {
      bucket.payment_net_revenue -= p.amount || 0;
    }
  }

  for (const r of resByRef.values()) {
    const bucket = dailyMap.get(r.date);
    if (!bucket) continue;
    const st = payStateByRef.get(r.booking_ref) || { validCount: 0, voidCount: 0 };
    if (r.is_paid && st.validCount === 0) {
      bucket.paid_no_payment_count += 1;
      bucket.paid_no_payment_amount += r.amount || 0;
    }
    if (st.validCount === 0 && st.voidCount > 0) {
      bucket.void_only_count += 1;
    }
  }

  const days = Array.from(dailyMap.values());
  const totals = days.reduce(
    (acc, d) => {
      acc.payment_net_revenue += d.payment_net_revenue;
      acc.paid_no_payment_count += d.paid_no_payment_count;
      acc.paid_no_payment_amount += d.paid_no_payment_amount;
      acc.void_only_count += d.void_only_count;
      return acc;
    },
    { payment_net_revenue: 0, paid_no_payment_count: 0, paid_no_payment_amount: 0, void_only_count: 0 }
  );

  return { from: fromStr, to: toStr, days, totals };
}

function parseArgs(argv) {
  let from = null;
  let to = null;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--from' && argv[i + 1]) from = argv[i + 1];
    if (argv[i] === '--to' && argv[i + 1]) to = argv[i + 1];
  }
  return { from, to };
}

async function main() {
  const { from, to } = parseArgs(process.argv.slice(2));
  const report = await diagnoseRevenueGap(prisma, { from, to });
  console.log(`=== Revenue Gap Diagnosis (${report.from} ~ ${report.to}, read-only) ===`);
  console.log('date\tpayment_net\tpaid_no_payment_cnt\tpaid_no_payment_amt\tvoid_only_cnt');
  for (const d of report.days) {
    console.log(
      `${d.date}\t${d.payment_net_revenue}\t${d.paid_no_payment_count}\t${d.paid_no_payment_amount}\t${d.void_only_count}`
    );
  }
  console.log('--- TOTALS ---');
  console.log(JSON.stringify(report.totals));
  await prisma.$disconnect();
}

const isEntrypoint = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntrypoint) {
  main().catch(async (err) => {
    console.error('[diagnose-revenue-gap] Error:', err);
    await prisma.$disconnect().catch(() => {});
    process.exit(1);
  });
}
