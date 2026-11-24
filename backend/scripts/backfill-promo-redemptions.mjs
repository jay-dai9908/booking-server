import '../src/loadEnv.js';
import { pathToFileURL } from 'url';
import prisma from '../src/prismaClient.js';

export async function runBackfillPromoRedemptions({ apply = false, client = prisma } = {}) {
  const promos = await client.promoCode.findMany({ orderBy: { id: 'asc' } });
  const promoByCode = new Map(promos.map((p) => [String(p.code).trim().toUpperCase(), p]));

  const reservations = await client.reservation.findMany({
    where: { status: { not: 'cancelled' } },
    select: {
      booking_ref: true,
      user_id: true,
      promo_code: true,
      is_self_service: true,
      checkout_details: true
    }
  });

  const validPayments = await client.payment.findMany({
    where: { status: 'valid' },
    select: { booking_ref: true }
  });
  const paidRefs = new Set(validPayments.map((p) => p.booking_ref));

  // Deduplicate desired redemptions keyed by `${promo_id}|${booking_ref}`
  const desiredMap = new Map();

  // 1) Reservation.promo_code (comma-separated exact token match, never substring)
  for (const r of reservations) {
    if (!r.booking_ref) continue;
    if (r.promo_code) {
      const tokens = String(r.promo_code)
        .split(',')
        .map((c) => c.trim().toUpperCase())
        .filter(Boolean);
      for (const token of tokens) {
        const promo = promoByCode.get(token);
        if (!promo) continue;
        const key = `${promo.id}|${r.booking_ref}`;
        if (!desiredMap.has(key)) {
          desiredMap.set(key, {
            promo_id: promo.id,
            code: promo.code,
            booking_ref: r.booking_ref,
            user_id: r.user_id ?? null,
            channel: r.is_self_service ? 'self' : 'online',
            status: 'active'
          });
        }
      }
    }

    // 2) Draft order_promos / person promos for bookings with valid payments
    if (paidRefs.has(r.booking_ref) && r.checkout_details && typeof r.checkout_details === 'object') {
      const draft = r.checkout_details;
      const draftCodes = [];
      for (const op of draft.order_promos || []) {
        if (op?.code) draftCodes.push(String(op.code).trim().toUpperCase());
      }
      for (const p of draft.persons || []) {
        for (const pr of p.promos || []) {
          if (pr?.code) draftCodes.push(String(pr.code).trim().toUpperCase());
        }
      }
      for (const code of draftCodes) {
        const promo = promoByCode.get(code);
        if (!promo) continue;
        const key = `${promo.id}|${r.booking_ref}`;
        if (!desiredMap.has(key)) {
          desiredMap.set(key, {
            promo_id: promo.id,
            code: promo.code,
            booking_ref: r.booking_ref,
            user_id: r.user_id ?? null,
            channel: 'pos',
            status: 'active'
          });
        }
      }
    }
  }

  const existingActive = await client.promoRedemption.findMany({
    select: { promo_id: true, booking_ref: true, status: true }
  });
  const existingKeySet = new Set(existingActive.map((e) => `${e.promo_id}|${e.booking_ref}`));

  const toCreate = [];
  const derivedByPromoId = new Map();
  for (const e of existingActive) {
    if (e.status === 'active') {
      derivedByPromoId.set(e.promo_id, (derivedByPromoId.get(e.promo_id) || 0) + 1);
    }
  }
  for (const [key, entry] of desiredMap.entries()) {
    if (!existingKeySet.has(key)) {
      toCreate.push(entry);
      derivedByPromoId.set(entry.promo_id, (derivedByPromoId.get(entry.promo_id) || 0) + 1);
    }
  }

  const summary = promos.map((p) => ({
    promo_id: p.id,
    code: p.code,
    current_used_count: p.used_count,
    derived_count: derivedByPromoId.get(p.id) || 0
  }));

  if (apply) {
    await client.$transaction(async (tx) => {
      if (toCreate.length > 0) {
        await tx.promoRedemption.createMany({
          data: toCreate,
          skipDuplicates: true
        });
      }
      for (const p of promos) {
        const count = await tx.promoRedemption.count({
          where: { promo_id: p.id, status: 'active' }
        });
        if (count !== p.used_count) {
          await tx.promoCode.update({
            where: { id: p.id },
            data: { used_count: count }
          });
        }
      }
    });
  }

  return {
    apply,
    created_redemptions: apply ? toCreate.length : 0,
    pending_redemptions: toCreate.length,
    summary
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const apply = process.argv.includes('--apply');
  runBackfillPromoRedemptions({ apply })
    .then((res) => {
      console.log(`[backfill-promo-redemptions] mode=${apply ? 'APPLY' : 'DRY-RUN'}, pending=${res.pending_redemptions}, created=${res.created_redemptions}`);
      for (const s of res.summary) {
        if (s.current_used_count !== s.derived_count || s.derived_count > 0) {
          console.log(`  - ${s.code} | current used_count=${s.current_used_count} | derived=${s.derived_count}`);
        }
      }
      return prisma.$disconnect();
    })
    .catch((err) => {
      console.error('[backfill-promo-redemptions] Failed:', err);
      return prisma.$disconnect().finally(() => process.exit(1));
    });
}
