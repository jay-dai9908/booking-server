import prisma from '../../prismaClient.js';

/**
 * 計算會員目前同時佔用虛擬帳號的待付款筆數（商城預購＋半自助預約合計）
 */
export async function countActivePoolHolds(tx, userId) {
  const client = tx || prisma;
  const uid = Number(userId);
  const [shopCount, prepayCount] = await Promise.all([
    client.productOrder.count({
      where: {
        user_id: uid,
        order_status: { not: 'cancelled' },
        payment_status: 'pending_payment',
        assigned_pool_account: { not: null }
      }
    }),
    client.bookingPrepay.count({
      where: {
        user_id: uid,
        status: 'pending_payment',
        assigned_pool_account: { not: null }
      }
    })
  ]);
  return shopCount + prepayCount;
}

/**
 * 在交易內以鎖定列方式指派一組 AVAILABLE 的專屬收款帳號
 * 同時檢查「商城預購＋半自助預約」合計待繳納帳號上限（預設最多 2 筆）
 */
export async function assignPoolAccount(
  tx,
  {
    userId,
    orderRef,
    paymentMethodCode = 'ctbc_pool',
    maxHolds = 2,
    checkHoldLimit = true,
    holdLimitMessage = '您目前已有 2 筆待付款並佔用專屬收款帳號的訂單／預約，請先完成匯款回報，或聯繫門市人員協助！'
  }
) {
  const uid = Number(userId);
  await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${uid} FOR UPDATE`;

  if (checkHoldLimit) {
    const activeHolds = await countActivePoolHolds(tx, uid);
    if (activeHolds >= maxHolds) {
      const err = new Error(holdLimitMessage);
      err.isBusinessError = true;
      err.code = 'POOL_HOLD_LIMIT';
      err.status = 409;
      throw err;
    }
  }

  const allocated = await tx.$queryRaw`
    UPDATE "OneTimeAccountPool"
    SET "status" = 'ASSIGNED',
        "assigned_order_ref" = ${orderRef},
        "assigned_user_id" = ${uid},
        "assigned_at" = NOW()
    WHERE "id" = (
      SELECT "id" FROM "OneTimeAccountPool"
      WHERE "payment_method_code" = ${paymentMethodCode} AND "status" = 'AVAILABLE'
      ORDER BY "id" ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    RETURNING "id", "account_number", "payment_url", "bank_code", "bank_name";
  `;

  if (Array.isArray(allocated) && allocated.length > 0) {
    return {
      id: allocated[0].id,
      accountNumber: allocated[0].account_number,
      paymentUrl: allocated[0].payment_url || null,
      bankCode: allocated[0].bank_code || null,
      bankName: allocated[0].bank_name || null
    };
  }
  return null;
}

/**
 * 將 ASSIGNED 的虛擬帳號釋放回 AVAILABLE（必填 orderRef，避免誤釋放其他訂單帳號）
 */
export async function releasePoolAccount(tx, { accountNumber, orderRef }) {
  if (!orderRef || !String(orderRef).trim()) {
    throw new Error('releasePoolAccount requires orderRef');
  }
  if (!accountNumber) return { count: 0 };
  const client = tx || prisma;
  return client.oneTimeAccountPool.updateMany({
    where: {
      account_number: accountNumber,
      assigned_order_ref: String(orderRef).trim(),
      status: 'ASSIGNED'
    },
    data: {
      status: 'AVAILABLE',
      assigned_order_ref: null,
      assigned_user_id: null,
      assigned_at: null
    }
  });
}

/**
 * 對帳確認後將虛擬帳號標記為 USED（必填 orderRef，避免誤標其他訂單帳號）
 */
export async function markPoolAccountUsed(tx, { accountNumber, orderRef }) {
  if (!orderRef || !String(orderRef).trim()) {
    throw new Error('markPoolAccountUsed requires orderRef');
  }
  if (!accountNumber) return { count: 0 };
  const client = tx || prisma;
  return client.oneTimeAccountPool.updateMany({
    where: {
      account_number: accountNumber,
      assigned_order_ref: String(orderRef).trim(),
      status: 'ASSIGNED'
    },
    data: {
      status: 'USED',
      verified_at: new Date()
    }
  });
}
