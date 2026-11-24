import '../src/loadEnv.js';
import { pathToFileURL } from 'url';
import prisma from '../src/prismaClient.js';
import { toTaipeiDateString } from '../../shared/time.js';
import { normalizePromoRule } from '../../shared/promo.js';
import { computeBill } from '../../shared/billing.js';
import { getBookingBill, refreshBillingCache } from '../src/services/billing/billService.js';
import auditService from '../src/services/audit/auditService.js';

function upgradeOrderPromo(op, promoRow, hourlyPrice) {
  if (op && Number(op.rule_v) === 2) return op;
  const sourcePromo = promoRow || {
    id: op?.promo_id ?? null,
    code: op?.code || '',
    name: op?.name || op?.code || '',
    discount_type: op?.discount_type || 'fixed_order',
    discount_value: op?.discount_value ?? 0,
    max_discount_amount: op?.max_discount_amount ?? null,
    target_scope: op?.target_scope || 'all'
  };
  const rule = normalizePromoRule(sourcePromo, { hourly_price: hourlyPrice });
  return {
    ...rule,
    ...(op?.person_nos !== undefined ? { person_nos: op.person_nos } : {}),
    ...(op?.split_mode !== undefined ? { split_mode: op.split_mode } : {}),
    ...(op?.split !== undefined ? { split: op.split } : {}),
    ...(op?.target_person_no !== undefined ? { target_person_no: op.target_person_no } : {}),
    ...(op?.person_no !== undefined ? { person_no: op.person_no } : {})
  };
}

export async function runMigratePromoDrafts({ apply = false, client = prisma } = {}) {
  const rows = await client.reservation.findMany({
    where: { status: { not: 'cancelled' } },
    select: {
      booking_ref: true,
      checkout_details: true,
      is_self_service: true,
      session: { select: { session_date: true } }
    },
    orderBy: [{ created_at: 'asc' }]
  });

  // Deduplicate by booking_ref and filter drafts containing legacy order_promos without rule_v
  const byRef = new Map();
  for (const r of rows) {
    if (!r.booking_ref || byRef.has(r.booking_ref)) continue;
    const draft = r.checkout_details;
    const ops = Array.isArray(draft?.order_promos) ? draft.order_promos : [];
    if (ops.some((op) => op && op.rule_v == null)) {
      byRef.set(r.booking_ref, r);
    }
  }

  const candidateRefs = Array.from(byRef.keys());
  if (candidateRefs.length === 0) {
    return { apply, total_candidates: 0, migrated: 0, items: [] };
  }

  // Fetch BookingPrepay for candidates so unverified self-service bookings are excluded
  const prepays = await client.bookingPrepay.findMany({
    where: { booking_ref: { in: candidateRefs } },
    select: { booking_ref: true, status: true }
  });
  const prepayStatusByRef = new Map(prepays.map((p) => [p.booking_ref, p.status]));

  const allPromoRows = await client.promoCode.findMany();
  const promoByCode = new Map(allPromoRows.map((p) => [String(p.code).toUpperCase(), p]));
  const promoById = new Map(allPromoRows.map((p) => [p.id, p]));

  const items = [];
  let migrated = 0;

  for (const bookingRef of candidateRefs) {
    const prepayStatus = prepayStatusByRef.get(bookingRef);
    if (prepayStatus !== undefined && prepayStatus !== 'verified') {
      continue;
    }

    const billData = await getBookingBill(bookingRef, client);
    const hasUnpaid = (billData.bill?.persons || []).some((p) => !p.is_paid);
    if (!hasUnpaid) {
      continue;
    }

    const oldDue = billData.bill?.summary?.amount_due ?? 0;
    const hourlyPrice = billData.pricing?.hourly ?? 150;
    const draft = billData.draft || {};
    const oldOps = Array.isArray(draft.order_promos) ? draft.order_promos : [];
    const newOps = oldOps.map((op) => {
      const pRow = (op?.promo_id ? promoById.get(op.promo_id) : null) || promoByCode.get(String(op?.code || '').toUpperCase()) || null;
      return upgradeOrderPromo(op, pRow, hourlyPrice);
    });

    const newDraft = {
      ...draft,
      order_promos: newOps,
      rev: (Number(draft.rev) || 1) + 1,
      updated_at: new Date().toISOString(),
      updated_by: '系統遷移'
    };

    const simulatedBill = computeBill({
      ...billData.billInput,
      orderPromos: newOps
    });
    const newDue = simulatedBill.summary?.amount_due ?? oldDue;
    const codes = newOps.map((o) => o.code).filter(Boolean).join(',');
    const dateStr = toTaipeiDateString(billData.booking?.session_date);

    const record = {
      booking_ref: bookingRef,
      date: dateStr,
      codes,
      old_amount_due: oldDue,
      new_amount_due: newDue
    };
    items.push(record);

    if (apply) {
      await client.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${bookingRef}))`;
        await tx.reservation.updateMany({
          where: { booking_ref: bookingRef },
          data: { checkout_details: newDraft }
        });
        await refreshBillingCache(tx, bookingRef);
        await auditService.log(tx, {
          booking_ref: bookingRef,
          category: 'amount',
          event_type: 'promo_rule_migrated',
          summary: `遷移優惠碼規則 (${codes})：應收 NT$${oldDue} → NT$${newDue}`,
          amount: newDue - oldDue,
          before_json: { amount_due: oldDue, order_promos: oldOps },
          after_json: { amount_due: newDue, order_promos: newOps },
          staff_name: '系統',
          device_label: 'script'
        });
      });
      migrated += 1;
    }
  }

  return {
    apply,
    total_candidates: items.length,
    migrated,
    items
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const apply = process.argv.includes('--apply');
  runMigratePromoDrafts({ apply })
    .then((res) => {
      console.log(`[migrate-promo-drafts] mode=${apply ? 'APPLY' : 'DRY-RUN'}, candidates=${res.total_candidates}, migrated=${res.migrated}`);
      for (const it of res.items) {
        console.log(`  - ${it.booking_ref} | ${it.date} | ${it.codes} | old=NT$${it.old_amount_due} -> new=NT$${it.new_amount_due}`);
      }
      return prisma.$disconnect();
    })
    .catch((err) => {
      console.error('[migrate-promo-drafts] Failed:', err);
      return prisma.$disconnect().finally(() => process.exit(1));
    });
}
