import prisma from '../../prismaClient.js';
import { dateOnly } from '../../../../shared/time.js';
import { getEffectiveDailyRates } from '../../controllers/reservationController.js';

/**
 * 判斷指定日期的顯示屏／系統日期類型（共用唯一入口）
 * 依序：
 * 1. 當天沒有任何時段：closed
 * 2. DailySetting.is_self_service：self
 * 3. getEffectiveDailyRates 的 is_weekend 是 true：holiday
 * 4. 其他：weekday
 *
 * @param {string|Date} date
 * @param {import('@prisma/client').PrismaClient} [prismaClient]
 * @returns {Promise<'closed'|'self'|'holiday'|'weekday'>}
 */
export async function getDayType(date, prismaClient = prisma) {
  const targetDate = dateOnly(date);

  const sessionCount = await prismaClient.session.count({
    where: { session_date: targetDate }
  });
  if (sessionCount === 0) {
    return 'closed';
  }

  const dailySetting = await prismaClient.dailySetting.findUnique({
    where: { date: targetDate },
    select: { is_self_service: true }
  });
  if (dailySetting?.is_self_service) {
    return 'self';
  }

  const rates = await getEffectiveDailyRates(prismaClient, targetDate);
  if (rates?.is_weekend === true) {
    return 'holiday';
  }

  return 'weekday';
}

export default { getDayType };
