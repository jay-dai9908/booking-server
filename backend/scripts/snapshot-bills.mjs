#!/usr/bin/env node
import 'dotenv/config';
import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import prisma from '../src/prismaClient.js';
import { dateOnly, toTaipeiDateString } from '../../shared/time.js';
import { getBookingBill } from '../src/services/billing/billService.js';
import { isRevenuePayment } from '../src/services/accounting/revenueScope.js';
import { getConfiguredPaymentMethods, buildMethodBreakdown } from '../src/services/accounting/methodAggregation.js';
import { getUnpaidBookings } from '../src/services/accounting/unpaidQuery.js';

function parseCliArgs(argv) {
  const opts = { from: null, to: null, out: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--from' && argv[i + 1]) opts.from = argv[++i];
    else if (a === '--to' && argv[i + 1]) opts.to = argv[++i];
    else if (a === '--out' && argv[i + 1]) opts.out = argv[++i];
  }
  return opts;
}

function enumerateMonths(fromStr, toStr) {
  const months = [];
  let [y, m] = fromStr.slice(0, 7).split('-').map(Number);
  const [ey, em] = toStr.slice(0, 7).split('-').map(Number);
  while (y < ey || (y === ey && m <= em)) {
    months.push(`${y}-${String(m).padStart(2, '0')}`);
    m += 1;
    if (m > 12) {
      y += 1;
      m = 1;
    }
  }
  return months;
}

function summarizePayments(payments, configuredMethods) {
  const validPayments = payments.filter((p) => p.status === 'valid');
  const storePayments = validPayments.filter(isRevenuePayment);
  const charges = storePayments.filter((p) => (p.kind === 'charge' || p.kind === 'supplement') && p.method !== 'pass');
  const passes = storePayments.filter((p) => (p.kind === 'charge' || p.kind === 'supplement') && p.method === 'pass');
  const refunds = storePayments.filter((p) => p.kind === 'refund' && p.method !== 'pass');
  const voids = payments.filter((p) => p.status === 'voided' && isRevenuePayment(p));

  const totalIncome = charges.reduce((sum, p) => sum + p.amount, 0);
  const totalRefund = refunds.reduce((sum, p) => sum + p.amount, 0);
  const netRevenue = totalIncome - totalRefund;
  const passValue = passes.reduce((sum, p) => sum + p.amount, 0);
  const { by_method } = buildMethodBreakdown(charges, refunds, configuredMethods);
  const sortedByMethod = Object.fromEntries(
    Object.entries(by_method).sort(([a], [b]) => a.localeCompare(b))
  );

  return {
    net_revenue: netRevenue,
    total_income: totalIncome,
    total_refunds: totalRefund,
    by_method: sortedByMethod,
    pass_value: passValue,
    void_count: voids.length,
    void_amount: voids.reduce((sum, p) => sum + p.amount, 0)
  };
}

export async function collectBillSnapshot({ client = prisma, from, to }) {
  const db = client || prisma;
  const fromStr = String(from).trim();
  const toStr = String(to).trim();
  const fromDate = dateOnly(fromStr);
  const toDate = dateOnly(toStr);

  const [reservations, configuredMethods] = await Promise.all([
    db.reservation.findMany({
      where: {
        session: {
          session_date: { gte: fromDate, lte: toDate }
        }
      },
      include: { session: true },
      orderBy: [{ booking_ref: 'asc' }, { session: { start_time: 'asc' } }]
    }),
    getConfiguredPaymentMethods(db)
  ]);

  const byRef = new Map();
  for (const r of reservations) {
    if (!byRef.has(r.booking_ref)) byRef.set(r.booking_ref, []);
    byRef.get(r.booking_ref).push(r);
  }

  const bookings = [];
  const refsSorted = Array.from(byRef.keys()).sort();
  for (const ref of refsSorted) {
    const rows = byRef.get(ref);
    const first = rows[0];
    const dateStr = toTaipeiDateString(first.session.session_date);
    const { bill } = await getBookingBill(ref, db);
    bookings.push({
      booking_ref: ref,
      date: dateStr,
      status: first.status,
      amount_due: bill?.summary?.amount_due ?? 0,
      billing_status: bill?.summary?.billing_status ?? null,
      remaining_due: bill?.summary?.remaining_due ?? 0,
      persons: (bill?.persons || [])
        .map((p) => ({ person_no: p.person_no, total: p.total ?? 0 }))
        .sort((a, b) => a.person_no - b.person_no)
    });
  }

  const monthKeys = enumerateMonths(fromStr, toStr);
  const months = [];
  for (const ym of monthKeys) {
    const [y, m] = ym.split('-').map(Number);
    const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const mStartStr = `${ym}-01`;
    const mEndStr = `${ym}-${String(lastDay).padStart(2, '0')}`;
    const startAt = new Date(`${mStartStr}T00:00:00+08:00`);
    const endAt = new Date(`${mEndStr}T23:59:59.999+08:00`);

    const [createdInMonthPayments, unpaidStats] = await Promise.all([
      db.payment.findMany({
        where: { created_at: { gte: startAt, lte: endAt } },
        orderBy: { id: 'asc' }
      }),
      getUnpaidBookings(db, {
        dateFrom: dateOnly(mStartStr),
        dateTo: dateOnly(mEndStr)
      })
    ]);

    const periodRefs = bookings.filter((b) => b.date.startsWith(ym)).map((b) => b.booking_ref);
    const bookingLinkedPayments = periodRefs.length > 0
      ? await db.payment.findMany({
          where: { booking_ref: { in: periodRefs } },
          orderBy: { id: 'asc' }
        })
      : [];

    months.push({
      month: ym,
      calendar_created_summary: summarizePayments(createdInMonthPayments, configuredMethods),
      booking_linked_summary: summarizePayments(bookingLinkedPayments, configuredMethods),
      unpaid: {
        count: unpaidStats.count,
        amount: unpaidStats.amount,
        no_show_count: unpaidStats.no_show_count
      }
    });
  }

  return {
    range: { from: fromStr, to: toStr },
    bookings,
    months
  };
}

async function main() {
  const opts = parseCliArgs(process.argv.slice(2));
  if (!opts.from || !opts.to || !opts.out) {
    console.error('用法：node backend/scripts/snapshot-bills.mjs --from YYYY-MM-DD --to YYYY-MM-DD --out <檔案>');
    process.exit(2);
  }
  try {
    const snap = await collectBillSnapshot({ client: prisma, from: opts.from, to: opts.to });
    await fs.writeFile(opts.out, JSON.stringify(snap, null, 2), 'utf8');
    console.log(`[snapshot-bills] Wrote ${snap.bookings.length} booking(s) & ${snap.months.length} month(s) to ${opts.out}`);
  } finally {
    await prisma.$disconnect();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error('[snapshot-bills] Failed:', err);
    process.exit(1);
  });
}
