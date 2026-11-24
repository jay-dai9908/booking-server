import '../src/loadEnv.js';
import { pathToFileURL } from 'url';
import prisma from '../src/prismaClient.js';
import { dateOnly, toTaipeiDateString } from '../../shared/time.js';
import { computeBill } from '../../shared/billing.js';
import { evaluatePromoCode } from '../src/controllers/checkoutController.js';
import { buildInitialDraft, getBookingBill, refreshBillingCache } from '../src/services/billing/billService.js';
import auditService from '../src/services/audit/auditService.js';

export async function runBackfillOnlineDrafts({ apply = false, client = prisma, now = new Date() } = {}) {
  const todayDate = dateOnly(toTaipeiDateString(now));

  const rows = await client.reservation.findMany({
    where: {
      status: 'confirmed',
      is_self_service: false,
      session: { session_date: { gte: todayDate } },
      OR: [
        { promo_code: { not: null } },
        { is_unlimited: true }
      ]
    },
    include: { session: true },
    orderBy: [{ session: { session_date: 'asc' } }, { session: { start_time: 'asc' } }]
  });

  const byRef = new Map();
  for (const r of rows) {
    if (!r.booking_ref) continue;
    if (!byRef.has(r.booking_ref)) byRef.set(r.booking_ref, []);
    byRef.get(r.booking_ref).push(r);
  }

  const candidateRefs = Array.from(byRef.keys());
  if (candidateRefs.length === 0) {
    return { apply, total_candidates: 0, skipped: 0, backfilled: 0, items: [] };
  }

  const validPayments = await client.payment.findMany({
    where: { booking_ref: { in: candidateRefs }, status: 'valid' },
    select: { booking_ref: true }
  });
  const paidRefs = new Set(validPayments.map((p) => p.booking_ref));

  const items = [];
  let backfilled = 0;
  let skipped = 0;

  for (const bookingRef of candidateRefs) {
    if (paidRefs.has(bookingRef)) continue;

    const resGroup = byRef.get(bookingRef);
    const firstRes = resGroup[0];
    const promoCodes = String(firstRes.promo_code || '')
      .split(',')
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean);
    const needsUnlimited = Boolean(firstRes.is_unlimited);

    if (promoCodes.length === 0 && !needsUnlimited) continue;

    const existingDraft = firstRes.checkout_details;
    const existingPromos = Array.isArray(existingDraft?.order_promos) ? existingDraft.order_promos : [];
    const existingPromoSet = new Set(existingPromos.map((op) => String(op?.code || '').trim().toUpperCase()));
    const existingPersons = Array.isArray(existingDraft?.persons) ? existingDraft.persons : [];

    const missingCodes = promoCodes.filter((c) => !existingPromoSet.has(c));
    const missingUnlimited = needsUnlimited && (
      existingPersons.length < firstRes.pax ||
      existingPersons.some((p) => p.mode !== 'unlimited')
    );

    if (missingCodes.length === 0 && !missingUnlimited) {
      continue;
    }

    const billData = await getBookingBill(bookingRef, client);
    const currentDue = billData.bill?.summary?.amount_due ?? 0;
    const dateStr = toTaipeiDateString(firstRes.session?.session_date);

    // Build simulated persons array first so unlimited rate affects promo base accurately
    const count = Math.max(1, Number(firstRes.pax) || 1);
    const baseDraft = existingDraft && existingDraft.version === 2
      ? { ...existingDraft }
      : buildInitialDraft({ pax: count, isUnlimited: needsUnlimited });

    const nextPersons = Array.from({ length: count }, (_, idx) => {
      const pNo = idx + 1;
      const found = (baseDraft.persons || []).find((p) => Number(p.person_no) === pNo);
      return {
        ...(found || { person_no: pNo }),
        mode: needsUnlimited ? 'unlimited' : (found?.mode || 'hourly')
      };
    });

    const simPersonsBillInput = (billData.billInput?.persons || []).map((p) => ({
      ...p,
      mode: needsUnlimited ? 'unlimited' : p.mode
    }));
    const prePromoBill = computeBill({
      ...billData.billInput,
      persons: simPersonsBillInput,
      orderPromos: existingPromos
    });

    const simSeatingTotal = (prePromoBill.persons || []).reduce((s, p) => s + (p.entry?.amount || 0), 0);
    const simBoardTotal = (prePromoBill.persons || []).reduce((s, p) => s + (p.board?.amount || 0), 0);
    const simBaseTotal = (prePromoBill.persons || []).reduce((s, p) => s + (p.base_amount || 0), 0);

    let skipReason = null;
    const newRules = [];
    for (const code of missingCodes) {
      const evalRes = await evaluatePromoCode(client, {
        code,
        session_date: firstRes.session?.session_date,
        pax: count,
        hours: resGroup.length,
        is_unlimited: needsUnlimited,
        base_amount: simBaseTotal,
        hourly_price: billData.pricing?.hourly,
        user_id: firstRes.user_id,
        skip_usage_check: true,
        seating_amount: simSeatingTotal,
        equipment_amount: simBoardTotal,
        persons: (prePromoBill.persons || []).map((p) => ({
          person_no: p.person_no,
          entry_amount: p.entry?.amount || 0,
          board_amount: p.board?.amount || 0,
          base_amount: p.base_amount || 0
        }))
      });
      if (!evalRes.valid) {
        skipReason = `${code}: ${evalRes.error || '優惠碼已失效'}`;
        break;
      }
      newRules.push({
        ...evalRes.rule,
        split_mode: baseDraft.split_mode || billData.rules?.default_split_mode || 'proportional'
      });
    }

    if (skipReason) {
      skipped += 1;
      items.push({
        booking_ref: bookingRef,
        date: dateStr,
        promo_code: firstRes.promo_code,
        is_unlimited: needsUnlimited,
        current_amount_due: currentDue,
        backfilled_amount_due: null,
        status: 'skipped',
        skip_reason: skipReason
      });
      continue;
    }

    const nextOrderPromos = [...existingPromos, ...newRules];
    const nextDraft = {
      ...baseDraft,
      version: 2,
      persons: nextPersons,
      order_promos: nextOrderPromos,
      rev: (Number(baseDraft.rev) || 1) + 1,
      updated_at: new Date().toISOString(),
      updated_by: '系統回填'
    };

    const postBill = computeBill({
      ...billData.billInput,
      persons: simPersonsBillInput,
      orderPromos: nextOrderPromos
    });
    const backfilledDue = postBill.summary?.amount_due ?? currentDue;

    items.push({
      booking_ref: bookingRef,
      date: dateStr,
      promo_code: firstRes.promo_code,
      is_unlimited: needsUnlimited,
      current_amount_due: currentDue,
      backfilled_amount_due: backfilledDue,
      status: apply ? 'backfilled' : 'pending'
    });

    if (apply) {
      await client.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${bookingRef}))`;
        await tx.reservation.updateMany({
          where: { booking_ref: bookingRef },
          data: { checkout_details: nextDraft }
        });
        await refreshBillingCache(tx, bookingRef);
        await auditService.log(tx, {
          booking_ref: bookingRef,
          category: 'amount',
          event_type: 'draft_backfilled',
          summary: `補齊預約帳單草稿（${firstRes.promo_code || ''}${needsUnlimited ? ' 不限時' : ''}）：應收 NT$${currentDue} → NT$${backfilledDue}`,
          amount: backfilledDue - currentDue,
          before_json: { amount_due: currentDue, checkout_details: existingDraft },
          after_json: { amount_due: backfilledDue, checkout_details: nextDraft },
          staff_name: '系統',
          device_label: 'script'
        });
      });
      backfilled += 1;
    }
  }

  return {
    apply,
    total_candidates: items.length,
    skipped,
    backfilled,
    items
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const apply = process.argv.includes('--apply');
  runBackfillOnlineDrafts({ apply })
    .then((res) => {
      console.log(`[backfill-online-drafts] mode=${apply ? 'APPLY' : 'DRY-RUN'}, candidates=${res.total_candidates}, skipped=${res.skipped}, backfilled=${res.backfilled}`);
      for (const it of res.items) {
        if (it.status === 'skipped') {
          console.log(`  - [略過] ${it.booking_ref} | ${it.date} | ${it.promo_code || '-'} | reason=${it.skip_reason}`);
        } else {
          console.log(`  - ${it.booking_ref} | ${it.date} | ${it.promo_code || '-'} | unlimited=${it.is_unlimited} | old=NT$${it.current_amount_due} -> new=NT$${it.backfilled_amount_due}`);
        }
      }
      return prisma.$disconnect();
    })
    .catch((err) => {
      console.error('[backfill-online-drafts] Failed:', err);
      return prisma.$disconnect().finally(() => process.exit(1));
    });
}
