/**
 * 拾光製所｜第八輪修正：處理舊資料腳本
 * 把「已結清或免收，但還有人在計時或暫停中」的訂單，全部結束計時（暫停也一起結束）並標記已離場。
 *
 * 執行方式：
 *   先 dry-run 預覽：
 *     node backend/src/scripts/endTimersForPaidBookings.js --dry-run
 *   確認後正式執行：
 *     node backend/src/scripts/endTimersForPaidBookings.js
 */
import prisma from '../prismaClient.js';
import { billingStatus } from '../../../shared/billing.js';

async function main() {
  const isDryRun = process.argv.includes('--dry-run');

  if (isDryRun) {
    console.log('=== [DRY RUN 模式] 只列出欲處理的訂單，不會變更任何資料 ===\n');
  } else {
    console.log('=== [正式執行模式] 開始清理已結清但計時未結束的訂單 ===\n');
  }

  try {
    const reservations = await prisma.reservation.findMany({
      where: {
        status: { not: 'cancelled' },
        OR: [
          { billing_status: { in: ['paid', 'waived'] } },
          { is_paid: true }
        ]
      },
      include: {
        user: true,
        session: true
      },
      orderBy: { id: 'asc' }
    });

    const bookingsMap = new Map();
    for (const r of reservations) {
      if (!r.booking_ref) continue;
      if (!bookingsMap.has(r.booking_ref)) {
        bookingsMap.set(r.booking_ref, []);
      }
      bookingsMap.get(r.booking_ref).push(r);
    }

    let processedCount = 0;

    for (const [bRef, resList] of bookingsMap.entries()) {
      const firstRes = resList[0];
      const persons = await prisma.bookingPerson.findMany({
        where: { booking_ref: bRef },
        include: { pauses: true }
      });

      // 檢查是否有人計時還在進行或暫停中（未結束）
      const unfinishedPersons = persons.filter(p =>
        !p.timer_ended_at && (p.timer_started_at || p.paused_at)
      );

      if (unfinishedPersons.length === 0) {
        continue;
      }

      // 嚴格檢查：不可以處理未結帳或部分已付的訂單
      const payments = await prisma.payment.findMany({
        where: { booking_ref: bRef, status: 'valid' }
      });

      const bStatus = billingStatus({
        persons: persons.length ? persons : Array.from({ length: firstRes.pax }, (_, i) => ({ person_no: i + 1, status: 'active' })),
        payments
      });

      const isPaidOrWaived =
        firstRes.is_paid === true ||
        firstRes.billing_status === 'paid' ||
        firstRes.billing_status === 'waived' ||
        bStatus.code === 'paid' ||
        bStatus.code === 'waived';

      if (!isPaidOrWaived) {
        continue;
      }

      processedCount++;
      const shortRef = bRef.slice(0, 8);
      const name = firstRes.user?.name || '客人';
      const statusLabel = firstRes.billing_status || bStatus.code || 'paid';
      console.log(`[${shortRef}] ${name} (${statusLabel}) - ${unfinishedPersons.length} 位計時中/已暫停`);

      if (!isDryRun) {
        await prisma.$transaction(async (tx) => {
          const now = new Date();
          for (const p of unfinishedPersons) {
            let pauseDurationSec = 0;
            if (p.paused_at) {
              const openPause = p.pauses?.find(pa => !pa.ended_at);
              if (openPause) {
                pauseDurationSec = Math.max(0, Math.floor((now.getTime() - new Date(openPause.started_at).getTime()) / 1000));
                await tx.timerPause.update({
                  where: { id: openPause.id },
                  data: { ended_at: now }
                });
              }
            }
            await tx.bookingPerson.update({
              where: { id: p.id },
              data: {
                paused_at: null,
                paused_seconds: (p.paused_seconds || 0) + pauseDurationSec,
                timer_ended_at: now
              }
            });
          }

          await tx.reservation.updateMany({
            where: { booking_ref: bRef },
            data: { attendance: 'completed' }
          });
        });
      }
    }

    if (processedCount === 0) {
      console.log('沒有需要處理的訂單。');
    } else if (isDryRun) {
      console.log(`\n[dry-run] 共發現 ${processedCount} 筆已結清/免收但計時未結束的訂單，未做任何修改。正式執行請移除 --dry-run`);
    } else {
      console.log(`\n已成功結束 ${processedCount} 筆訂單的計時並標記為已離場。`);
    }
  } catch (err) {
    console.error('執行失敗:', err);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

main();
