import prisma from '../../prismaClient.js';
import { dateOnly, toTaipeiDateString } from '../../../../shared/time.js';
import { computeDayInfo, enumerateDateStrs } from '../../../../shared/dayType.js';
import { bookableSessionWhere } from './sessionFilters.js';

/**
 * 查詢單一日期的完整日期類型與計價基準（全系統唯一入口）
 * @param {import('@prisma/client').PrismaClient} client
 * @param {string|Date} date
 */
export async function getDayInfo(client = prisma, date = new Date()) {
  const db = client || prisma;
  const targetStr = typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date.trim())
    ? date.trim()
    : toTaipeiDateString(date);
  const targetDate = dateOnly(targetStr);

  const [dailySetting, bookableSessionCount] = await Promise.all([
    db.dailySetting.findUnique({ where: { date: targetDate } }),
    db.session.count({
      where: {
        session_date: targetDate,
        ...bookableSessionWhere()
      }
    })
  ]);

  const info = computeDayInfo({
    date: targetStr,
    dailySetting,
    bookableSessionCount
  });

  return {
    ...info,
    is_self_service: Boolean(dailySetting?.is_self_service)
  };
}

/**
 * 一次查詢一段日期區間的日期類型對照表 Map<YYYY-MM-DD, DayInfo>
 * @param {import('@prisma/client').PrismaClient} client
 * @param {string|Date} start
 * @param {string|Date} end
 */
export async function getDayInfoRange(client = prisma, start, end) {
  const db = client || prisma;
  const startStr = typeof start === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(start.trim())
    ? start.trim()
    : toTaipeiDateString(start);
  const endStr = typeof end === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(end.trim())
    ? end.trim()
    : toTaipeiDateString(end);

  const dateStrs = enumerateDateStrs(startStr, endStr);
  const resultMap = new Map();
  if (dateStrs.length === 0) return resultMap;

  const startDate = dateOnly(startStr);
  const endDate = dateOnly(endStr);

  const [settings, sessionGroups] = await Promise.all([
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

  const settingMap = new Map(settings.map((s) => [toTaipeiDateString(s.date), s]));
  const sessionCountMap = new Map(
    sessionGroups.map((g) => [toTaipeiDateString(g.session_date), Number(g._count?._all || 0)])
  );

  for (const dateStr of dateStrs) {
    const dailySetting = settingMap.get(dateStr) || null;
    const bookableSessionCount = sessionCountMap.get(dateStr) ?? 0;
    const info = computeDayInfo({
      date: dateStr,
      dailySetting,
      bookableSessionCount
    });
    resultMap.set(dateStr, {
      ...info,
      is_self_service: Boolean(dailySetting?.is_self_service)
    });
  }

  return resultMap;
}

/**
 * 相容第 28 輪簽名：取得單日系統類型（closed / self / holiday / weekday）
 * @param {string|Date} date
 * @param {import('@prisma/client').PrismaClient} [prismaClient]
 * @returns {Promise<'closed'|'self'|'holiday'|'weekday'>}
 */
export async function getDayType(date, prismaClient = prisma) {
  const info = await getDayInfo(prismaClient || prisma, date);
  return info.type;
}

export default { getDayInfo, getDayInfoRange, getDayType };
