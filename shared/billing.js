// shared/billing.js
// 帳單計算、分攤（最大餘數法）、收費時數與狀態判定（純函式）

import { blocksBy1030, floorMinutes, formatTimerHMM, formatBillingHours } from './time.js';
import { calculateBoardTotal } from './boardPricing.js';

export const PAYMENT_METHOD_LABELS = {
  cash: '現金',
  line_pay: 'LINE Pay',
  jkopay: '街口支付',
  card: '刷卡',
  transfer: '銀行轉帳',
  pass: '卡券折抵',
  other: '其他',
  none: '免收',
  mixed: '多種方式'
};

/**
 * 顯示品名替換：把「洞洞板」替換為「智能板」
 * @param {string} name
 * @returns {string}
 */
export function displayBoardName(name) {
  if (typeof name !== 'string') return '';
  return name.replace(/洞洞板/g, '智能板');
}

/**
 * 最大餘數法分攤金額（確保每一筆加總剛好等於 total，不能差 1 元）
 * @param {number} total - 要分攤的總金額（可正可負）
 * @param {Array<{ person_no: number, weight: number }>} items
 * @returns {Array<{ person_no: number, amount: number }>}
 */
export function splitAmount(total, items = []) {
  if (!items || items.length === 0) return [];
  const tot = Math.round(Number(total) || 0);
  if (tot === 0) {
    return items.map(it => ({ person_no: it.person_no, amount: 0 }));
  }

  const sign = tot < 0 ? -1 : 1;
  const T = Math.abs(tot);
  const totalWeight = items.reduce((sum, it) => sum + Math.max(0, Number(it.weight) || 0), 0);
  const hasPositiveWeight = totalWeight > 0;
  const W = hasPositiveWeight ? totalWeight : items.length;
  const weights = hasPositiveWeight ? items.map(it => Math.max(0, Number(it.weight) || 0)) : items.map(() => 1);

  const raw = weights.map(w => (T * w) / W);
  const base = raw.map(Math.floor);
  let left = T - base.reduce((s, b) => s + b, 0);

  // 排序：餘數大者優先，若餘數相同則 person_no 小者優先
  const order = raw
    .map((r, i) => ({ i, frac: r - Math.floor(r), no: items[i].person_no }))
    .sort((a, b) => b.frac - a.frac || a.no - b.no);

  for (const o of order) {
    if (left <= 0) break;
    base[o.i] += 1;
    left -= 1;
  }

  return items.map((it, i) => ({
    person_no: it.person_no,
    amount: sign * base[i]
  }));
}

/**
 * 計算單一位客人的入場收費時數與入場費（Section 4.3）
 * @param {object} params
 * @param {number} params.bookedMinutes - 預約時數（分鐘）
 * @param {number|null} [params.actualMinutes] - 實際時間（分鐘），若無計時紀錄為 null
 * @param {number} [params.pausedMinutes=0] - 暫停時間（分鐘）
 * @param {string} [params.mode='hourly'] - 'hourly' | 'unlimited'
 * @param {number|null} [params.hoursOverride=null] - 手動時數
 * @param {object} params.pricing - { hourly, unlimited, allow_unlimited, day_type }
 * @param {object} [params.rules] - { grace, block, early_leave_mode }
 * @returns {{ hours: number, amount: number, mode: string, isCapped: boolean, explain: string, explainDetail?: string }}
 */
export function computeEntry({
  bookedMinutes,
  actualMinutes = null,
  pausedMinutes = 0,
  mode = 'hourly',
  hoursOverride = null,
  pricing = { hourly: 150, unlimited: 750, allow_unlimited: true },
  rules = { grace: 10, block: 30, early_leave_mode: 'booked' }
}) {
  const booked = Math.max(0, (Number(bookedMinutes) || 0) / 60);
  let hours = booked;
  let isManual = false;
  let isEarlyLeave = false;
  let isInGrace = false;
  let isOvertime = false;
  let overtimeMinutes = 0;

  if (hoursOverride != null) {
    hours = Math.max(0.5, Number(hoursOverride) || 0.5);
    isManual = true;
  } else if (actualMinutes == null) {
    hours = booked;
  } else {
    const act = Math.max(0, actualMinutes);
    const over = act - (Number(bookedMinutes) || 0);

    if (over > 0) {
      isOvertime = true;
      overtimeMinutes = over;
      hours = booked + blocksBy1030(over, rules) * 0.5;
    } else if (rules.early_leave_mode === 'booked') {
      hours = booked;
      if (act < (Number(bookedMinutes) || 0)) {
        if (Math.abs(over) <= (rules.grace || 10)) {
          isInGrace = true;
        } else {
          isEarlyLeave = true;
        }
      }
    } else {
      // actual mode
      hours = Math.max(1, blocksBy1030(act, rules) * 0.5);
      isEarlyLeave = true;
    }
  }

  const hourlyPrice = Number(pricing.hourly) || 150;
  const unlimitedPrice = Number(pricing.unlimited) || 750;
  const allowUnlimited = pricing.allow_unlimited !== false;

  const hourlyCost = Math.round(hours * hourlyPrice);
  const capped = allowUnlimited && hourlyCost >= unlimitedPrice;
  const isUnlimitedMode = (mode === 'unlimited' && allowUnlimited) || capped;
  const amount = isUnlimitedMode ? unlimitedPrice : hourlyCost;

  // 說明文字模板（逐字照抄 4.3.4）
  let explain = '';
  let explainDetail = '';

  const pauseText = pausedMinutes > 0 ? `（已扣暫停 ${pausedMinutes} 分）` : '';

  if (isManual) {
    explain = `收 ${formatBillingHours(hours)}（手動）`;
  } else if (actualMinutes == null) {
    explain = `沒有計時紀錄，照預約收 ${formatBillingHours(booked)}`;
  } else if (isUnlimitedMode) {
    explain = capped ? `達封頂，改收不限時 NT$${unlimitedPrice}` : `不限時 NT$${unlimitedPrice}`;
    explainDetail = `計時 ${formatTimerHMM(actualMinutes)}${pauseText}`;
  } else if (isOvertime) {
    explain = `計時 ${formatTimerHMM(actualMinutes)} → 收 ${formatBillingHours(hours)}`;
    const addedHours = hours - booked;
    explainDetail = `超過預約 ${overtimeMinutes} 分：扣寬限 ${rules.grace || 10} 分後加 ${addedHours} 小時${pauseText}`;
  } else if (isEarlyLeave) {
    explain = `計時 ${formatTimerHMM(actualMinutes)} → 提早離開，照預約收 ${formatBillingHours(booked)}${pauseText}`;
  } else if (isInGrace) {
    explain = `計時 ${formatTimerHMM(actualMinutes)} → 收 ${formatBillingHours(hours)}（寬限 ${rules.grace || 10} 分內）${pauseText}`;
  } else {
    explain = `計時 ${formatTimerHMM(actualMinutes)} → 收 ${formatBillingHours(hours)}${pauseText}`;
  }

  return {
    hours,
    amount,
    mode: isUnlimitedMode ? 'unlimited' : 'hourly',
    isCapped: capped,
    explain,
    explainDetail: explainDetail || undefined
  };
}

/**
 * 完整帳單計算（Section 4.5）
 * @param {object} params
 * @returns {object} bill
 */
export function computeBill({
  now = Date.now(),
  pricing = { hourly: 150, unlimited: 750, allow_unlimited: true, day_type: 'weekday' },
  rules = { grace: 10, block: 30, early_leave_mode: 'booked', default_split_mode: 'proportional' },
  discountConfig,
  booking = { start_at: null, end_at: null, booked_minutes: 0, is_walk_in: false },
  persons = [],
  boards = [],
  orderAddons = [],
  orderPromos = [],
  manualDiscount = null,
  totalOverride = null,
  payments = [],
  pendingSupplements = []
}) {
  const activePersons = persons.filter(p => p.status !== 'removed');
  const validPayments = (payments || []).filter(p => p.status === 'valid');

  // Identify paid persons and their frozen breakdown snapshot (Section 4.5.5)
  const paidSnapshotByPerson = new Map();
  for (const pay of validPayments) {
    if (pay.kind === 'charge' || pay.kind === 'waive') {
      const snapPersons = pay.breakdown_json?.persons || [];
      for (const sp of snapPersons) {
        paidSnapshotByPerson.set(sp.person_no, sp);
      }
    }
  }

  // Pre-calculate smart board totals for each board unit
  const boardUnitMap = new Map(); // unit_group -> calculated board object
  for (const b of (boards || [])) {
    const calc = calculateBoardTotal({ segments: b.segments || [], discountConfig });
    boardUnitMap.set(b.unit_group, { ...b, ...calc });
  }

  // 1. Calculate each person's entry, board, and personal addons
  const computedPersons = [];
  for (const p of activePersons) {
    const pNo = p.person_no;
    const frozenSnap = paidSnapshotByPerson.get(pNo);

    if (frozenSnap) {
      // FROZEN: Use breakdown from snapshot exactly!
      computedPersons.push({
        ...frozenSnap,
        is_paid: true,
        is_frozen: true
      });
      continue;
    }

    // Unpaid person: Compute dynamically
    // Timer calculation
    let actualMinutes = null;
    let pausedMinutes = 0;
    if (p.timer?.timer_started_at) {
      const startAt = new Date(p.timer.billing_start_at || booking.start_at || p.timer.timer_started_at).getTime();
      const endAt = p.timer.timer_ended_at ? new Date(p.timer.timer_ended_at).getTime() : now;
      pausedMinutes = Math.floor((p.timer.paused_seconds || 0) / 60);
      if (p.timer.paused_at && !p.timer.timer_ended_at) {
        const currentlyPausedMs = Math.max(0, now - new Date(p.timer.paused_at).getTime());
        pausedMinutes += Math.floor(currentlyPausedMs / 60000);
      }
      const rawElapsed = Math.max(0, endAt - startAt);
      actualMinutes = Math.max(0, floorMinutes(rawElapsed) - pausedMinutes);
    }

    const entry = computeEntry({
      bookedMinutes: booking.booked_minutes || 0,
      actualMinutes,
      pausedMinutes,
      mode: p.mode || 'hourly',
      hoursOverride: p.hours_override,
      pricing,
      rules
    });

    // Boards belonging to this person
    const personBoards = [];
    let boardAmount = 0;
    for (const b of boards || []) {
      if (b.person_no === pNo) {
        const bCalc = boardUnitMap.get(b.unit_group);
        if (bCalc) {
          personBoards.push(bCalc);
          boardAmount += bCalc.total;
        }
      }
    }

    // Personal addons
    const personalAddons = (p.addons || []).map(a => ({
      key: a.key,
      name: a.name,
      price: Number(a.price) || 0,
      qty: Number(a.qty) || 1,
      subtotal: (Number(a.price) || 0) * (Number(a.qty) || 1)
    }));
    const personalAddonAmount = personalAddons.reduce((s, a) => s + a.subtotal, 0);

    const base_i = entry.amount + boardAmount + personalAddonAmount;

    computedPersons.push({
      person_no: pNo,
      seat_code: p.seat_code,
      label: `第 ${pNo} 位`,
      is_paid: false,
      is_frozen: false,
      entry,
      board: {
        amount: boardAmount,
        units: personBoards
      },
      addons: personalAddons,
      base_amount: base_i,
      shares: [],
      promos: [],
      adjust: p.adjust || null,
      total: 0
    });
  }

  // 2. Distribute Order-level shared items
  const unpaidPersons = computedPersons.filter(p => !p.is_frozen);
  const paidPersons = computedPersons.filter(p => p.is_frozen);

  // Helper to split an order item among persons
  const distributeOrderItem = ({
    source_key,
    label,
    totalAmount,
    splitMode = rules.default_split_mode || 'proportional',
    targetPersonNo = null,
    scope = 'all',
    addedAfterPayment = false,
    includePaid = false
  }) => {
    if (totalAmount === 0) return;

    // Check how much was already frozen in paid snapshots
    let frozenAllocated = 0;
    for (const pp of paidPersons) {
      const prevShare = pp.shares?.find(s => s.source_key === source_key);
      if (prevShare) {
        frozenAllocated += prevShare.amount;
      }
    }

    if (!addedAfterPayment) {
      // Standard item: remaining amount goes to unpaid persons
      const remainingAmount = totalAmount - frozenAllocated;
      if (remainingAmount === 0 || unpaidPersons.length === 0) return;

      let weights = [];
      if (splitMode === 'even') {
        weights = unpaidPersons.map(p => ({ person_no: p.person_no, weight: 1 }));
      } else if (splitMode === 'first') {
        const first = unpaidPersons[0];
        weights = unpaidPersons.map(p => ({ person_no: p.person_no, weight: p.person_no === first.person_no ? 1 : 0 }));
      } else if (splitMode === 'person' && targetPersonNo != null) {
        weights = unpaidPersons.map(p => ({ person_no: p.person_no, weight: p.person_no === targetPersonNo ? 1 : 0 }));
      } else {
        // Proportional based on scope
        weights = unpaidPersons.map(p => {
          let w = p.base_amount || 0;
          if (scope === 'seating') w = p.entry.amount;
          else if (scope === 'equipment') w = p.board.amount;
          return { person_no: p.person_no, weight: Math.max(0, w) };
        });
      }

      const splitResults = splitAmount(remainingAmount, weights);
      for (const res of splitResults) {
        const p = unpaidPersons.find(u => u.person_no === res.person_no);
        if (p) {
          p.shares.push({ source_key, label, amount: res.amount });
        }
      }
    } else {
      // Added after payment (Section 4.5.5)
      if (includePaid && paidPersons.length > 0) {
        // Also split to paid persons -> becomes pending supplement
        const allPersons = computedPersons;
        let weights = [];
        if (splitMode === 'even') {
          weights = allPersons.map(p => ({ person_no: p.person_no, weight: 1 }));
        } else {
          weights = allPersons.map(p => ({ person_no: p.person_no, weight: Math.max(0, p.base_amount || 0) }));
        }
        const splitResults = splitAmount(totalAmount, weights);
        for (const res of splitResults) {
          const up = unpaidPersons.find(u => u.person_no === res.person_no);
          if (up) {
            up.shares.push({ source_key, label, amount: res.amount });
          } else {
            // Paid person: create/update pending supplement
            pendingSupplements.push({
              person_no: res.person_no,
              source_key,
              label,
              amount: res.amount
            });
          }
        }
      } else {
        // Only unpaid persons
        if (unpaidPersons.length === 0) return;
        let weights = [];
        if (splitMode === 'even') {
          weights = unpaidPersons.map(p => ({ person_no: p.person_no, weight: 1 }));
        } else if (splitMode === 'person' && targetPersonNo != null) {
          weights = unpaidPersons.map(p => ({ person_no: p.person_no, weight: p.person_no === targetPersonNo ? 1 : 0 }));
        } else {
          weights = unpaidPersons.map(p => ({ person_no: p.person_no, weight: Math.max(0, p.base_amount || 0) }));
        }
        const splitResults = splitAmount(totalAmount, weights);
        for (const res of splitResults) {
          const up = unpaidPersons.find(u => u.person_no === res.person_no);
          if (up) {
            up.shares.push({ source_key, label, amount: res.amount });
          }
        }
      }
    }
  };

  // 2a. Order Addons
  for (const oa of orderAddons || []) {
    const totalAddonAmount = (Number(oa.price) || 0) * (Number(oa.qty) || 1);
    distributeOrderItem({
      source_key: oa.key ? `order_addon:${oa.key}` : `order_addon:${oa.name}`,
      label: oa.name,
      totalAmount: totalAddonAmount,
      splitMode: oa.split?.mode || 'proportional',
      targetPersonNo: oa.split?.person_no,
      scope: 'all',
      addedAfterPayment: Boolean(oa.added_after_payment),
      includePaid: Boolean(oa.include_paid)
    });
  }

  // 2b. Order Promos
  for (const op of orderPromos || []) {
    // Calculate promo discount amount
    let promoDiscount = 0;
    if (op.discount_type === 'percentage') {
      // Target scope bases
      for (const up of unpaidPersons) {
        let base = up.base_amount;
        if (op.target_scope === 'seating') base = up.entry.amount;
        else if (op.target_scope === 'equipment') base = up.board.amount;
        const d = Math.round((base * (Number(op.discount_value) || 0)) / 100);
        up.promos.push({ code: op.code, name: op.name, amount: -d });
      }
      continue;
    } else if (op.discount_type === 'fixed_per_pax') {
      for (const up of unpaidPersons) {
        up.promos.push({ code: op.code, name: op.name, amount: -Math.min(up.base_amount, Number(op.discount_value) || 0) });
      }
      continue;
    } else {
      // fixed_order or free_hours
      promoDiscount = Number(op.discount_value) || 0;
      if (op.max_discount_amount) {
        promoDiscount = Math.min(promoDiscount, op.max_discount_amount);
      }
      distributeOrderItem({
        source_key: `promo:${op.code}`,
        label: op.name || op.code,
        totalAmount: -promoDiscount,
        splitMode: op.split?.mode || 'proportional',
        targetPersonNo: op.split?.person_no,
        scope: op.target_scope || 'all'
      });
    }
  }

  // 2c. Manual Discount
  if (manualDiscount && manualDiscount.amount) {
    const dAmt = Math.abs(Number(manualDiscount.amount) || 0);
    const reasonText = manualDiscount.reason ? `（${manualDiscount.reason}）` : '';
    distributeOrderItem({
      source_key: 'manual',
      label: `手動折讓${reasonText}`,
      totalAmount: -dAmt,
      splitMode: manualDiscount.split?.mode || 'proportional',
      targetPersonNo: manualDiscount.split?.person_no,
      scope: 'all'
    });
  }

  // 3. Finish per-person due amounts
  for (const p of unpaidPersons) {
    const sharesTotal = p.shares.reduce((s, sh) => s + sh.amount, 0);
    const promosTotal = p.promos.reduce((s, pr) => s + pr.amount, 0);
    const adjustAmount = p.adjust?.amount ? Number(p.adjust.amount) || 0 : 0;
    const rawTotal = p.base_amount + sharesTotal + promosTotal + adjustAmount;
    p.total = Math.max(0, rawTotal);
  }

  // 4. Total Override difference (if applied)
  if (totalOverride && totalOverride.amount != null) {
    const targetOrderTotal = Number(totalOverride.amount) || 0;
    const currentOrderTotal = computedPersons.reduce((s, p) => s + p.total, 0);
    const diff = targetOrderTotal - currentOrderTotal;
    if (diff !== 0 && unpaidPersons.length > 0) {
      const weights = unpaidPersons.map(p => ({ person_no: p.person_no, weight: p.total }));
      const diffSplits = splitAmount(diff, weights);
      for (const ds of diffSplits) {
        const up = unpaidPersons.find(u => u.person_no === ds.person_no);
        if (up) {
          up.shares.push({
            source_key: 'override',
            label: `直接改金額（${totalOverride.reason || '調整'}）`,
            amount: ds.amount
          });
          up.total = Math.max(0, up.total + ds.amount);
        }
      }
    }
  }

  // 5. Aggregate order totals
  let totalEntry = 0;
  let totalBoard = 0;
  let totalAddons = 0;
  let totalDiscounts = 0;
  let regularHoursTotal = 0;
  let unlimitedPaxTotal = 0;

  for (const p of computedPersons) {
    totalEntry += p.entry.amount;
    totalBoard += p.board.amount;
    totalAddons += (p.addons || []).reduce((s, a) => s + a.subtotal, 0);
    totalDiscounts += (p.promos || []).reduce((s, pr) => s + Math.abs(pr.amount), 0);
    for (const sh of p.shares || []) {
      if (sh.source_key?.startsWith('order_addon:')) totalAddons += sh.amount;
      else if (sh.amount < 0) totalDiscounts += Math.abs(sh.amount);
    }
    if (p.entry.mode === 'unlimited') {
      unlimitedPaxTotal += 1;
    } else {
      regularHoursTotal += p.entry.hours || 0;
    }
  }

  const amountDue = computedPersons.reduce((s, p) => s + p.total, 0);

  // Received amount: sum of valid charge/supplement minus refunds (excluding pass value)
  let amountReceived = 0;
  let hasRefund = false;
  let hasVoid = false;
  let passValueTotal = 0;

  for (const pay of payments || []) {
    if (pay.status === 'valid') {
      if (pay.method === 'pass') {
        passValueTotal += pay.amount || 0;
      } else {
        if (pay.kind === 'charge' || pay.kind === 'supplement') {
          amountReceived += pay.amount || 0;
        } else if (pay.kind === 'refund') {
          amountReceived -= pay.amount || 0;
          hasRefund = true;
        }
      }
    } else if (pay.status === 'voided') {
      hasVoid = true;
    }
  }

  const remainingDue = Math.max(0, amountDue - amountReceived);
  const statusInfo = billingStatus({
    persons: computedPersons,
    payments: validPayments,
    pendingSupplements,
    hasRefund
  });

  return {
    persons: computedPersons,
    summary: {
      regular_hours_total: regularHoursTotal,
      unlimited_pax_total: unlimitedPaxTotal,
      entry_total: totalEntry,
      board_total: totalBoard,
      addons_total: totalAddons,
      discounts_total: totalDiscounts,
      amount_due: amountDue,
      amount_received: amountReceived,
      amount_remaining: remainingDue,
      pass_value_total: passValueTotal
    },
    status: statusInfo,
    pending_supplements: pendingSupplements
  };
}

/**
 * 訂單結帳狀態判定（Section 4.6）
 * @param {object} params
 * @returns {{ code: string, label: string, pill_style: string, covered: number, total: number, tags: string[] }}
 */
export function billingStatus({
  persons = [],
  payments = [],
  pendingSupplements = [],
  hasRefund = false
}) {
  const activePersons = persons.filter(p => p.status !== 'removed');
  const n = activePersons.length || 1;

  // Persons covered by valid charge or waive
  const coveredSet = new Set();
  let allWaived = true;

  for (const pay of payments || []) {
    if (pay.status === 'valid' && (pay.kind === 'charge' || pay.kind === 'waive')) {
      if (pay.kind !== 'waive') allWaived = false;
      for (const pNo of pay.person_nos || []) {
        coveredSet.add(pNo);
      }
    }
  }

  const covered = coveredSet.size;
  let code = 'unpaid';
  let label = '未結帳';
  let pillStyle = 'low'; // honey

  if (covered === 0) {
    code = 'unpaid';
    label = '未結帳';
    pillStyle = 'low';
  } else if (covered < n) {
    code = 'partial';
    label = `已結 ${covered}/${n}`;
    pillStyle = 'low';
  } else {
    // covered === n
    if (allWaived) {
      code = 'waived';
      label = '免收';
      pillStyle = 'full';
    } else {
      code = 'paid';
      label = '已結清';
      pillStyle = 'ok';
    }
  }

  const tags = [];
  if (hasRefund) {
    tags.push({ code: 'refund', label: '有退款', style: 'danger' });
  }

  const pendingAmount = (pendingSupplements || []).reduce((s, p) => s + (Number(p.amount) || 0), 0);
  if (pendingAmount > 0) {
    tags.push({ code: 'pending', label: `待補收 NT$${pendingAmount}`, style: 'low' });
  }

  return {
    code,
    label,
    pill_style: pillStyle,
    covered,
    total: n,
    tags
  };
}
