import 'dotenv/config';
import { pathToFileURL } from 'url';
import prisma from '../src/prismaClient.js';
import auditService from '../src/services/audit/auditService.js';

/**
 * Enable auto_expire on legacy pending_payment shop orders that are not cancelled.
 * Default mode is dry-run (reads only). Pass --apply to write updates and extend expired deadlines.
 */
export async function runEnableShopOrderExpiry({
  prismaClient = prisma,
  apply = false,
  now = new Date()
} = {}) {
  const globalSetting = await prismaClient.globalSetting.findUnique({ where: { id: 1 } });
  const deadlineDays = globalSetting?.shop_deposit_deadline_days ?? 2;

  const targets = await prismaClient.productOrder.findMany({
    where: {
      auto_expire: false,
      payment_status: 'pending_payment',
      order_status: { not: 'cancelled' }
    },
    orderBy: [{ created_at: 'asc' }, { id: 'asc' }],
    select: {
      id: true,
      order_ref: true,
      payment_method_code: true,
      payment_deadline: true,
      order_status: true,
      payment_status: true
    }
  });

  if (!apply) {
    return {
      apply: false,
      deadlineDays,
      matchedCount: targets.length,
      updatedCount: 0,
      orders: targets
    };
  }

  const extendedDeadline = new Date(now.getTime() + deadlineDays * 24 * 60 * 60 * 1000);
  let updatedCount = 0;

  for (const order of targets) {
    const isExpiredOrMissing = !order.payment_deadline || new Date(order.payment_deadline) < now;
    const nextDeadline = isExpiredOrMissing ? extendedDeadline : order.payment_deadline;

    await prismaClient.$transaction(async (tx) => {
      const res = await tx.productOrder.updateMany({
        where: {
          id: order.id,
          auto_expire: false,
          payment_status: 'pending_payment',
          order_status: { not: 'cancelled' }
        },
        data: {
          auto_expire: true,
          payment_deadline: nextDeadline
        }
      });

      if (res.count > 0) {
        await auditService.log(tx, {
          booking_ref: order.order_ref,
          event_type: 'shop_order_deadline_extended',
          category: 'shop',
          summary: `舊商城訂單 ${order.order_ref} 啟用自動逾期並順延付款期限`,
          reason: '啟用全付款方式自動逾期排程（enable-shop-order-expiry）',
          before_json: {
            auto_expire: false,
            payment_deadline: order.payment_deadline
          },
          after_json: {
            auto_expire: true,
            payment_deadline: nextDeadline
          },
          staff_name: '系統腳本'
        });
        updatedCount++;
      }
    });
  }

  return {
    apply: true,
    deadlineDays,
    matchedCount: targets.length,
    updatedCount,
    orders: targets
  };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const apply = process.argv.includes('--apply');
  runEnableShopOrderExpiry({ apply })
    .then((result) => {
      console.log(
        `[enable-shop-order-expiry] mode=${apply ? 'APPLY' : 'DRY-RUN'}, deadlineDays=${result.deadlineDays}, matched=${result.matchedCount}, updated=${result.updatedCount}`
      );
      for (const ord of result.orders) {
        const dl = ord.payment_deadline ? new Date(ord.payment_deadline).toISOString() : 'none';
        console.log(`  - ${ord.order_ref} | method=${ord.payment_method_code} | deadline=${dl} | status=${ord.order_status}`);
      }
    })
    .catch((err) => {
      console.error('[enable-shop-order-expiry] error:', err);
      process.exitCode = 1;
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}
