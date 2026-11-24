import prisma from '../../prismaClient.js';

/**
 * Sync cached PromoCode.used_count from active PromoRedemption rows inside the current transaction.
 */
export async function syncPromoUsedCount(tx, promo_id) {
  const client = tx || prisma;
  const activeCount = await client.promoRedemption.count({
    where: {
      promo_id: Number(promo_id),
      status: 'active'
    }
  });
  await client.promoCode.update({
    where: { id: Number(promo_id) },
    data: { used_count: activeCount }
  });
  return activeCount;
}

/**
 * Atomically record/reactivate a PromoRedemption row under per-promo advisory lock
 * and enforce max_uses + max_uses_per_user limits.
 */
export async function redeemPromo(tx, { promo, booking_ref, user_id = null, channel = 'online' }) {
  if (!promo?.id || !booking_ref) {
    throw { status: 400, code: 'PROMO_INVALID', error: '缺少優惠碼或預約編號' };
  }
  const promoId = Number(promo.id);
  const lockKey = `promo:${promoId}`;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;

  const freshPromo = await tx.promoCode.findUnique({ where: { id: promoId } });
  if (!freshPromo) {
    throw { status: 400, code: 'PROMO_NOT_FOUND', error: '找不到此優惠碼' };
  }

  const existing = await tx.promoRedemption.findUnique({
    where: {
      promo_id_booking_ref: {
        promo_id: promoId,
        booking_ref
      }
    }
  });

  if (existing && existing.status === 'active') {
    return { redemption: existing, alreadyActive: true };
  }

  if (freshPromo.max_uses != null) {
    const activeTotal = await tx.promoRedemption.count({
      where: { promo_id: promoId, status: 'active' }
    });
    if (activeTotal >= freshPromo.max_uses) {
      throw {
        status: 400,
        code: 'PROMO_MAX_USES',
        error: '此優惠碼已達總使用次數上限',
        message: '此優惠碼已達總使用次數上限'
      };
    }
  }

  const uid = user_id != null ? Number(user_id) : null;
  if (uid != null && !Number.isNaN(uid) && freshPromo.max_uses_per_user != null) {
    const activeUserTotal = await tx.promoRedemption.count({
      where: { promo_id: promoId, user_id: uid, status: 'active' }
    });
    if (activeUserTotal >= freshPromo.max_uses_per_user) {
      const msg = `每位會員限用 ${freshPromo.max_uses_per_user} 次，您已達使用上限`;
      throw {
        status: 400,
        code: 'PROMO_USER_LIMIT',
        error: msg,
        message: msg
      };
    }
  }

  const now = new Date();
  let redemption;
  if (existing) {
    redemption = await tx.promoRedemption.update({
      where: { id: existing.id },
      data: {
        status: 'active',
        code: freshPromo.code,
        user_id: uid,
        channel,
        released_at: null,
        released_reason: null
      }
    });
  } else {
    redemption = await tx.promoRedemption.create({
      data: {
        promo_id: promoId,
        code: freshPromo.code,
        booking_ref,
        user_id: uid,
        channel,
        status: 'active',
        created_at: now
      }
    });
  }

  await syncPromoUsedCount(tx, promoId);
  return { redemption, alreadyActive: false };
}

/**
 * Release matching active PromoRedemption rows for a booking and recompute used_count cache.
 */
export async function releasePromo(tx, { booking_ref, promo_id = null, reason = 'released', channels = null }) {
  if (!booking_ref) return { released: 0 };

  const where = {
    booking_ref,
    status: 'active',
    ...(promo_id != null ? { promo_id: Number(promo_id) } : {}),
    ...(Array.isArray(channels) && channels.length > 0 ? { channel: { in: channels } } : {})
  };

  const activeRows = await tx.promoRedemption.findMany({
    where,
    select: { id: true, promo_id: true }
  });
  if (activeRows.length === 0) return { released: 0 };

  const promoIds = [...new Set(activeRows.map((r) => r.promo_id))].sort((a, b) => a - b);
  for (const pid of promoIds) {
    const lockKey = `promo:${pid}`;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;
  }

  const res = await tx.promoRedemption.updateMany({
    where: {
      id: { in: activeRows.map((r) => r.id) },
      status: 'active'
    },
    data: {
      status: 'released',
      released_at: new Date(),
      released_reason: String(reason || 'released')
    }
  });

  for (const pid of promoIds) {
    await syncPromoUsedCount(tx, pid);
  }

  return { released: res.count };
}
