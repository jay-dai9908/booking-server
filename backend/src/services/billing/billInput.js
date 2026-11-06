import { toTaipeiDateString, dateOnly } from '../../../../shared/time.js';

/**
 * Pure function: constructs computeBill parameters from database rows
 * (Spec 3.1 & 3.2)
 */
export function buildBillInput({
  bookingRef,
  reservations = [],
  bookingPersons = [],
  bookingEquipments = [],
  payments = [],
  globalSetting = {},
  pricing = {},
  now = Date.now(),
  draft = null
}) {
  if (!reservations.length) {
    throw new Error('reservations must not be empty');
  }

  const firstRes = reservations[0];
  const lastRes = reservations[reservations.length - 1];
  const user = firstRes.user || {};
  const sessionDate = firstRes.session?.session_date || firstRes.session_date;
  const dStr = toTaipeiDateString(sessionDate);

  const bookingStartDt = new Date(`${dStr}T${firstRes.session.start_time}:00+08:00`);
  const bookingEndDt = new Date(`${dStr}T${lastRes.session.end_time}:00+08:00`);
  const bookedMinutes = Math.max(0, Math.floor((bookingEndDt.getTime() - bookingStartDt.getTime()) / 60000));

  const effectiveDraft = draft || firstRes.checkout_details || {};

  // 1. Build persons
  const effectivePersons = bookingPersons.length > 0
    ? bookingPersons
    : Array.from({ length: firstRes.pax || 1 }, (_, i) => ({
        person_no: i + 1,
        seat_code: firstRes.assigned_seats?.[i] || null,
        status: 'active',
        billing_start_at: bookingStartDt,
        timer_started_at: null,
        timer_ended_at: null,
        paused_seconds: 0,
        paused_at: null
      }));

  const personInputs = effectivePersons.map(p => {
    const pDraft = effectiveDraft.persons?.find(dp => dp.person_no === p.person_no) || {};

    return {
      person_no: p.person_no,
      seat_code: p.seat_code,
      status: p.status || 'active',
      mode: pDraft.mode || 'hourly',
      hours_override: pDraft.hours_override ?? null,
      addons: pDraft.addons || [],
      promos: pDraft.promos || [],
      adjust: pDraft.adjust || null,
      timer: {
        billing_start_at: p.billing_start_at ? new Date(p.billing_start_at).toISOString() : bookingStartDt.toISOString(),
        timer_started_at: p.timer_started_at ? new Date(p.timer_started_at).toISOString() : null,
        timer_ended_at: p.timer_ended_at ? new Date(p.timer_ended_at).toISOString() : null,
        paused_at: p.paused_at ? new Date(p.paused_at).toISOString() : null,
        paused_seconds: p.paused_seconds || 0
      }
    };
  });

  // 2. Build smart boards / equipment segments (Section 3.2)
  const boardGroups = new Map();
  for (const be of bookingEquipments) {
    const uGroup = be.unit_group || `single-${be.id}`;
    if (!boardGroups.has(uGroup)) {
      const assignedPerson = be.person_id ? effectivePersons.find(p => p.id === be.person_id) : (effectivePersons[0] || null);
      boardGroups.set(uGroup, {
        unit_group: be.unit_group || uGroup,
        person_no: assignedPerson ? assignedPerson.person_no : 1,
        subtotal_price: be.subtotal_price,
        raw_items: []
      });
    }
    boardGroups.get(uGroup).raw_items.push(be);
  }

  const boards = [];
  for (const [uGroup, bg] of boardGroups.entries()) {
    const items = bg.raw_items.sort((a, b) => (a.segment_no || 1) - (b.segment_no || 1));
    const isSingleUnmodified = items.length === 1 && !items[0].ended_reason;

    const segments = items.map(be => {
      const startDt = be.start_at ? new Date(be.start_at) : bookingStartDt;
      let endDt;
      if (be.ended_reason === 'returned') {
        endDt = be.planned_end_at ? new Date(be.planned_end_at) : (be.end_at ? new Date(be.end_at) : bookingEndDt);
      } else if (be.end_at) {
        endDt = new Date(be.end_at);
      } else if (be.planned_end_at) {
        endDt = new Date(be.planned_end_at);
      } else {
        endDt = bookingEndDt;
      }

      let hours;
      if (isSingleUnmodified) {
        hours = be.rental_hours || Math.round((Math.max(0, endDt.getTime() - startDt.getTime()) / 3600000) * 2) / 2;
      } else {
        const diffMinutes = Math.max(0, Math.round((endDt.getTime() - startDt.getTime()) / 60000));
        hours = Math.round((diffMinutes / 60) * 2) / 2;
      }

      return {
        equipment_id: be.equipment_id,
        name: be.equipment?.name || be.equipment_name_snapshot,
        rate: be.unit_rate || be.equipment?.hourly_rate || 60,
        hours,
        start_at: be.start_at,
        end_at: be.end_at,
        ended_reason: be.ended_reason,
        planned_end_at: be.planned_end_at
      };
    });

    boards.push({
      unit_group: bg.unit_group,
      person_no: bg.person_no,
      fixed_total: isSingleUnmodified && bg.subtotal_price != null && bg.subtotal_price > 0 ? bg.subtotal_price : undefined,
      segments
    });
  }

  // 3. Discount config
  const discountConfig = {
    enabled: globalSetting.equipment_discount_enabled ?? true,
    buy_hours: globalSetting.equipment_discount_buy_hours ?? 3,
    free_hours: globalSetting.equipment_discount_free_hours ?? 1,
    tier2_enabled: globalSetting.equipment_discount2_enabled ?? false,
    tier2_buy_hours: globalSetting.equipment_discount2_buy_hours ?? 8,
    tier2_free_hours: globalSetting.equipment_discount2_free_hours ?? 4,
    stackable: globalSetting.equipment_discount_stackable ?? true
  };

  // 4. Rules
  const rules = {
    grace: globalSetting.billing_grace_minutes ?? 10,
    block: globalSetting.billing_block_minutes ?? 30,
    early_leave_mode: globalSetting.early_leave_mode || 'booked',
    default_split_mode: globalSetting.default_split_mode || 'proportional'
  };

  // 5. Pricing
  const pricingObj = {
    hourly: pricing.hourly_price ?? 150,
    unlimited: pricing.unlimited_price ?? 750,
    allow_unlimited: pricing.allow_unlimited !== false,
    day_type: pricing.is_weekend ? 'weekend' : 'weekday'
  };

  const nowMs = typeof now === 'number' ? now : (now instanceof Date ? now.getTime() : new Date(now).getTime());

  return {
    now: nowMs,
    pricing: pricingObj,
    rules,
    discountConfig,
    booking: {
      booking_ref: bookingRef,
      start_at: bookingStartDt.toISOString(),
      end_at: bookingEndDt.toISOString(),
      booked_minutes: bookedMinutes,
      is_walk_in: Boolean(firstRes.is_walk_in)
    },
    persons: personInputs,
    boards,
    orderAddons: effectiveDraft.order_addons || [],
    orderPromos: effectiveDraft.order_promos || [],
    manualDiscount: effectiveDraft.manual_discount || null,
    totalOverride: effectiveDraft.total_override || null,
    pendingSupplements: effectiveDraft.pending_supplements || [],
    payments: payments || [],
    effectivePersons
  };
}
