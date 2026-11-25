import prisma from '../../prismaClient.js';
import { dateOnly, toTaipeiDateString } from '../../../../shared/time.js';
import { getDayInfoRange } from '../calendar/dayType.js';

/**
 * 將 through 日（含）以前所有曾有場次（Session）但尚未固化價格的日期，
 * 以當下 GlobalSetting 的平日／假日預設價格補齊 DailySetting 空白欄位。
 * 已設定的值（包含 0）與 allow_unlimited 等其他欄位維持不動。
 */
export async function solidifyDailyPrices({ through, txOrPrisma = prisma } = {}) {
  const client = txOrPrisma || prisma;
  const throughStr = toTaipeiDateString(through || new Date());
  const throughDate = dateOnly(throughStr);

  const sessionDates = await client.session.findMany({
    where: { session_date: { lte: throughDate } },
    distinct: ['session_date'],
    select: { session_date: true },
    orderBy: { session_date: 'asc' }
  });

  if (sessionDates.length === 0) {
    console.log(`[Solidify] Completed solidifyDailyPrices(through=${throughStr}): updated 0 day(s).`);
    return { count: 0, updatedDates: [] };
  }

  const globalSetting = await client.globalSetting.findUnique({ where: { id: 1 } })
    || await client.globalSetting.findFirst();
  if (!globalSetting) {
    console.log(`[Solidify] Skipped solidifyDailyPrices(through=${throughStr}): no GlobalSetting found.`);
    return { count: 0, updatedDates: [] };
  }

  const firstStr = toTaipeiDateString(sessionDates[0].session_date);
  const lastStr = toTaipeiDateString(sessionDates[sessionDates.length - 1].session_date);
  const [existingList, dayInfoMap] = await Promise.all([
    client.dailySetting.findMany({
      where: {
        date: { in: sessionDates.map(s => dateOnly(s.session_date)) }
      }
    }),
    getDayInfoRange(client, firstStr, lastStr)
  ]);
  const existingMap = new Map(existingList.map(ds => [toTaipeiDateString(ds.date), ds]));

  const updatedDates = [];
  for (const row of sessionDates) {
    const dOnly = dateOnly(row.session_date);
    const dStr = toTaipeiDateString(dOnly);
    const existing = existingMap.get(dStr);

    if (existing && existing.hourly_price !== null && existing.unlimited_price !== null) {
      continue;
    }

    const isWeekend = dayInfoMap.get(dStr)?.price_type === 'holiday';
    const defaultHourly = isWeekend
      ? globalSetting.weekend_hourly_price
      : globalSetting.weekday_hourly_price;
    const defaultUnlimited = isWeekend
      ? globalSetting.weekend_unlimited_price
      : globalSetting.weekday_unlimited_price;

    const nextHourly = existing?.hourly_price ?? defaultHourly;
    const nextUnlimited = existing?.unlimited_price ?? defaultUnlimited;

    if (existing) {
      await client.dailySetting.update({
        where: { date: dOnly },
        data: {
          hourly_price: nextHourly,
          unlimited_price: nextUnlimited
        }
      });
    } else {
      await client.dailySetting.create({
        data: {
          date: dOnly,
          allow_unlimited: true,
          hourly_price: nextHourly,
          unlimited_price: nextUnlimited
        }
      });
    }

    updatedDates.push(dStr);
    console.log(`[Solidify] Solidified daily prices for ${dStr} (hourly=${nextHourly}, unlimited=${nextUnlimited})`);
  }

  console.log(`[Solidify] Completed solidifyDailyPrices(through=${throughStr}): updated ${updatedDates.length} day(s).`);
  return { count: updatedDates.length, updatedDates };
}

export default { solidifyDailyPrices };
