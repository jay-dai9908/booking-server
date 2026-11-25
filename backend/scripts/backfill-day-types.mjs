#!/usr/bin/env node
import 'dotenv/config';
import { pathToFileURL } from 'node:url';
import prisma from '../src/prismaClient.js';
import { dateOnly, toTaipeiDateString } from '../../shared/time.js';
import { autoDayTypeByWeekday, computeDayInfo, enumerateDateStrs } from '../../shared/dayType.js';
import { bookableSessionWhere } from '../src/services/calendar/sessionFilters.js';

function addDaysYmd(ymd, deltaDays) {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + deltaDays, 12, 0, 0)).toISOString().slice(0, 10);
}

function parseCliArgs(argv) {
  const opts = { from: null, to: null, apply: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--apply') {
      opts.apply = true;
    } else if (arg === '--from' && argv[i + 1]) {
      opts.from = argv[++i];
    } else if (arg === '--to' && argv[i + 1]) {
      opts.to = argv[++i];
    }
  }
  return opts;
}

/**
 * 補齊過去日期的 day_type、price_type、day_type_source='migrated'。
 * 沒有 DailySetting 那一列的日子新增一列時，僅寫入上述 3 個欄位；
 * 其他欄位保留資料表預設值（allow_unlimited=true、hourly_price=null、unlimited_price=null、is_self_service=false），
 * 與「無該列」時 getEffectiveDailyRates 讀到的行為完全相同。不修改任何價格、不固化、不修改任何 pricing_snapshot。
 */
export async function runBackfillDayTypes({
  client = prisma,
  from = null,
  to = null,
  apply = false,
  now = new Date()
} = {}) {
  const db = client || prisma;
  const yesterdayStr = addDaysYmd(toTaipeiDateString(now), -1);
  const toStr = to ? String(to).trim() : yesterdayStr;

  let fromStr = from ? String(from).trim() : null;
  if (!fromStr) {
    const [minSession, minSetting] = await Promise.all([
      db.session.findFirst({ orderBy: { session_date: 'asc' }, select: { session_date: true } }),
      db.dailySetting.findFirst({ orderBy: { date: 'asc' }, select: { date: true } })
    ]);
    const candidates = [minSession?.session_date, minSetting?.date]
      .filter(Boolean)
      .map((d) => toTaipeiDateString(d))
      .sort();
    fromStr = candidates[0] || null;
  }

  if (!fromStr || fromStr > toStr) {
    return {
      mode: apply ? 'apply' : 'dry-run',
      from: fromStr,
      to: toStr,
      totalDays: 0,
      typeCounts: { weekday: 0, holiday: 0, self: 0, closed: 0 },
      insertCount: 0,
      updateCount: 0,
      skipCount: 0,
      appliedCount: 0,
      preview20: []
    };
  }

  const allDates = enumerateDateStrs(fromStr, toStr);
  const startDate = dateOnly(fromStr);
  const endDate = dateOnly(toStr);

  const [existingRows, sessionGroups] = await Promise.all([
    db.dailySetting.findMany({
      where: { date: { gte: startDate, lte: endDate } }
    }),
    db.session.groupBy({
      by: ['session_date'],
      where: {
        session_date: { gte: startDate, lte: endDate },
        ...bookableSessionWhere()
      },
      _count: { _all: true }
    })
  ]);

  const existingByDate = new Map(existingRows.map((r) => [toTaipeiDateString(r.date), r]));
  const sessionCountByDate = new Map(
    sessionGroups.map((g) => [toTaipeiDateString(g.session_date), Number(g._count?._all || 0)])
  );

  const typeCounts = { weekday: 0, holiday: 0, self: 0, closed: 0 };
  const pendingWrites = [];
  let insertCount = 0;
  let updateCount = 0;
  let skipCount = 0;

  for (const dStr of allDates) {
    const existing = existingByDate.get(dStr) || null;
    if (existing && existing.day_type) {
      skipCount += 1;
      continue;
    }

    const bookableCount = sessionCountByDate.get(dStr) ?? 0;
    const autoInfo = computeDayInfo({
      date: dStr,
      dailySetting: existing,
      bookableSessionCount: bookableCount,
      ignoreManual: true
    });
    const priceType = autoDayTypeByWeekday(dStr);

    typeCounts[autoInfo.type] = (typeCounts[autoInfo.type] || 0) + 1;
    if (existing) {
      updateCount += 1;
    } else {
      insertCount += 1;
    }

    pendingWrites.push({
      dateStr: dStr,
      dateObj: dateOnly(dStr),
      action: existing ? 'update' : 'insert',
      day_type: autoInfo.type,
      price_type: priceType,
      day_type_source: 'migrated'
    });
  }

  let appliedCount = 0;
  if (apply && pendingWrites.length > 0) {
    const CHUNK_SIZE = 200;
    for (let i = 0; i < pendingWrites.length; i += CHUNK_SIZE) {
      const chunk = pendingWrites.slice(i, i + CHUNK_SIZE);
      await db.$transaction(async (tx) => {
        for (const item of chunk) {
          if (item.action === 'update') {
            const res = await tx.dailySetting.updateMany({
              where: { date: item.dateObj, day_type: null },
              data: {
                day_type: item.day_type,
                price_type: item.price_type,
                day_type_source: 'migrated'
              }
            });
            appliedCount += res.count;
          } else {
            await tx.dailySetting.create({
              data: {
                date: item.dateObj,
                day_type: item.day_type,
                price_type: item.price_type,
                day_type_source: 'migrated'
              }
            });
            appliedCount += 1;
          }
        }
      });
    }
  }

  return {
    mode: apply ? 'apply' : 'dry-run',
    from: fromStr,
    to: toStr,
    totalDays: allDates.length,
    typeCounts,
    insertCount,
    updateCount,
    skipCount,
    appliedCount,
    preview20: pendingWrites.slice(0, 20).map(({ dateStr, action, day_type, price_type, day_type_source }) => ({
      date: dateStr,
      action,
      day_type,
      price_type,
      day_type_source
    }))
  };
}

async function main() {
  const opts = parseCliArgs(process.argv.slice(2));
  try {
    const summary = await runBackfillDayTypes({
      client: prisma,
      from: opts.from,
      to: opts.to,
      apply: opts.apply
    });
    console.log(`[backfill-day-types] mode=${summary.mode} range=${summary.from || '-'}..${summary.to || '-'} totalDays=${summary.totalDays}`);
    console.log(`  typeCounts: ${JSON.stringify(summary.typeCounts)}`);
    console.log(`  insertCount=${summary.insertCount} updateCount=${summary.updateCount} skipCount=${summary.skipCount} appliedCount=${summary.appliedCount}`);
    console.log('  preview (up to 20 days):');
    for (const row of summary.preview20) {
      console.log(`    ${row.date} [${row.action}] day_type=${row.day_type} price_type=${row.price_type} source=${row.day_type_source}`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error('[backfill-day-types] Failed:', err);
    process.exit(1);
  });
}
