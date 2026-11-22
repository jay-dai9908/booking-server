import prisma from '../prismaClient.js';
import { getBookingBill } from '../services/billing/billService.js';
import { getActiveLayoutForDate } from '../services/seating/layoutService.js';
import { dateOnly, formatTimeHHmm } from '../../../shared/time.js';
import { ensureDisplaySetting } from './displaySettingController.js';
import { getEnabledPaymentMethods, resolveTwqrConfig } from '../services/display/displayConfigHelper.js';
import displayBus from '../services/display/displayBus.js';

const VALID_PHASES = new Set(['open', 'method', 'paid', 'close']);

function resolveTableLabel(layout, assignedSeats = [], personSeats = []) {
  const seatCodes = [...personSeats, ...assignedSeats].filter((s) => s && !String(s).startsWith('WAIT-'));
  if (layout?.tables && layout?.seats && seatCodes.length > 0) {
    const tableMap = new Map(layout.tables.map((t) => [t.id, t.label]));
    for (const code of seatCodes) {
      const sRow = layout.seats.find((ls) => ls.code === code);
      if (sRow?.table_id && tableMap.has(sRow.table_id)) {
        const lbl = String(tableMap.get(sRow.table_id) || '').trim();
        if (lbl) return lbl.endsWith('桌') ? lbl : `${lbl} 桌`;
      }
    }
  }
  if (seatCodes.length > 0) {
    const prefix = String(seatCodes[0]).split('-')[0].trim();
    if (prefix) return prefix.endsWith('桌') ? prefix : `${prefix} 桌`;
  }
  return '現場桌位';
}

function buildPersonLines(p, booking, payments) {
  const lines = [];

  // 1. 入場
  if (p.entry) {
    if (p.entry.mode === 'unlimited') {
      lines.push({ kind: '入場', desc: '不限時', amount: Number(p.entry.amount) || 0 });
    } else {
      const hrs = Number(p.entry.hours) || 0;
      const rangeStr = booking.start_time && booking.end_time ? ` ${booking.start_time}–${booking.end_time}` : '';
      lines.push({
        kind: '入場',
        desc: `計時${rangeStr}（${hrs} 小時）`,
        amount: Number(p.entry.amount) || 0
      });
    }
  }

  // 2. 智能板
  for (const u of p.board?.units || []) {
    const segs = Array.isArray(u.segments) ? u.segments : [];
    const name = segs[0]?.name || u.name || '智能板';
    const firstStart = segs[0]?.start_at ? formatTimeHHmm(segs[0].start_at) : '';
    const lastSeg = segs[segs.length - 1];
    const lastEndRaw = lastSeg?.end_at || lastSeg?.planned_end_at;
    const lastEnd = lastEndRaw ? formatTimeHHmm(lastEndRaw) : '';
    const timePart = firstStart && lastEnd ? ` ${firstStart}–${lastEnd}` : '';
    const hrs = Number(u.hours ?? u.billed_hours ?? 0);
    const hrPart = hrs > 0 ? `（${hrs} 小時）` : '';
    lines.push({
      kind: '智能板',
      desc: `${name}${timePart}${hrPart}`,
      amount: Number(u.total) || 0
    });
  }

  // 3. 個人加購
  for (const a of p.addons || []) {
    const qty = Number(a.qty) || 1;
    lines.push({
      kind: '加購',
      desc: `${a.name} ×${qty}`,
      amount: Number(a.subtotal) || 0
    });
  }

  // 4. 計次卡折抵
  const passPayments = (payments || []).filter(
    (pay) =>
      pay.status === 'valid' &&
      pay.method === 'pass' &&
      (!Array.isArray(pay.person_nos) || pay.person_nos.length === 0 || pay.person_nos.includes(p.person_no))
  );
  for (const pp of passPayments) {
    const pj = pp.pass_json && typeof pp.pass_json === 'object' ? pp.pass_json : {};
    const planName = pj.plan_name || pj.name || '計次卡';
    const deduct = pj.deducted ?? 1;
    const remPart = pj.remaining_after != null ? `（剩 ${pj.remaining_after} 次）` : '';
    const count = Array.isArray(pp.person_nos) && pp.person_nos.length > 0 ? pp.person_nos.length : 1;
    const perPersonAmt = Math.round((Number(pp.amount) || 0) / count);
    lines.push({
      kind: '計次卡',
      desc: `${planName} 扣 ${deduct} 次${remPart}`,
      amount: -Math.abs(perPersonAmt)
    });
  }

  // 5. 分攤到這位的整單優惠或費用
  for (const pr of p.promos || []) {
    lines.push({
      kind: '優惠',
      desc: `${pr.name || pr.code || '優惠'} 分攤`,
      amount: Number(pr.amount) || 0
    });
  }
  for (const sh of p.shares || []) {
    lines.push({
      kind: (Number(sh.amount) || 0) < 0 ? '優惠' : '加購',
      desc: sh.label || '分攤項目',
      amount: Number(sh.amount) || 0
    });
  }
  if (p.adjust?.amount) {
    lines.push({
      kind: '調整',
      desc: p.adjust.reason || '手動調整',
      amount: Number(p.adjust.amount) || 0
    });
  }

  return lines;
}

export async function postDisplayCheckout(req, res) {
  const { booking_ref, phase, person_nos, method, cash_received } = req.body || {};

  const cleanRef = typeof booking_ref === 'string' ? booking_ref.trim() : '';
  if (!cleanRef) {
    return res.status(400).json({ error: '請提供預約編號' });
  }
  if (!VALID_PHASES.has(phase)) {
    return res.status(422).json({ error: 'phase 必須為 open、method、paid 或 close' });
  }

  try {
    if (phase === 'close') {
      const closed = displayBus.clearCheckoutSync(cleanRef);
      return res.json({ ok: true, closed });
    }

    const [displaySetting, enabledMethods] = await Promise.all([
      ensureDisplaySetting(prisma),
      getEnabledPaymentMethods(prisma)
    ]);

    if (displaySetting.checkout_sync === false) {
      displayBus.forceClearCheckoutSync();
      return res.json({ ok: true, synced: false });
    }

    // Recompute bill strictly server-side (ignore any client-sent amounts)
    const billData = await getBookingBill(cleanRef, prisma);
    const layout = await getActiveLayoutForDate(prisma, dateOnly(billData.booking.session_date));

    const allPersons = billData.bill?.persons || [];
    const personSeats = allPersons.map((p) => p.seat_code).filter(Boolean);
    const tableLabel = resolveTableLabel(layout, billData.booking.assigned_seats, personSeats);
    const seats = [...new Set([...personSeats, ...(billData.booking.assigned_seats || [])])]
      .filter((s) => s && !String(s).startsWith('WAIT-'));

    // Resolve selected person_nos
    const requestedNos = Array.isArray(person_nos)
      ? person_nos.map(Number).filter((n) => Number.isInteger(n) && n > 0)
      : [];

    let selectedPersonNos;
    if (phase === 'paid') {
      selectedPersonNos = requestedNos.length > 0
        ? allPersons.filter((p) => requestedNos.includes(p.person_no)).map((p) => p.person_no)
        : allPersons.map((p) => p.person_no);
    } else {
      const unpaidNos = allPersons.filter((p) => !p.is_paid).map((p) => p.person_no);
      if (requestedNos.length > 0) {
        selectedPersonNos = requestedNos.filter((n) => unpaidNos.includes(n));
        if (selectedPersonNos.length === 0) selectedPersonNos = unpaidNos;
      } else {
        selectedPersonNos = unpaidNos;
      }
    }

    const selectedSet = new Set(selectedPersonNos);
    const perPersonDetail = displaySetting.checkout_per_person !== false;

    const sanitizedPersons = allPersons.map((p) => ({
      person_no: p.person_no,
      seat_code: p.seat_code || null,
      paid: Boolean(p.is_paid),
      selected: selectedSet.has(p.person_no),
      subtotal: Number(p.total) || 0,
      lines: perPersonDetail ? buildPersonLines(p, billData.booking, billData.payments) : []
    }));

    const amountDue = sanitizedPersons
      .filter((p) => selectedSet.has(p.person_no))
      .reduce((sum, p) => sum + p.subtotal, 0);

    // Validate selected payment method dynamically against GlobalSetting.payment_methods_json
    let selectedMethod = null;
    let selectedMethodLabel = null;
    if (method && typeof method === 'string') {
      const normReq = method.trim().toLowerCase().replace(/[-_]/g, '');
      const matched = enabledMethods.find(
        (m) => m.key.toLowerCase().replace(/[-_]/g, '') === normReq
      );
      if (matched) {
        selectedMethod = matched.key;
        selectedMethodLabel = matched.label;
      }
    }

    // Cash received & change calculation
    let cashReceivedNum = null;
    let changeNum = null;
    if (selectedMethod === 'cash' && cash_received !== undefined && cash_received !== null && cash_received !== '') {
      const parsedCash = Number(cash_received);
      if (Number.isFinite(parsedCash) && parsedCash >= 0) {
        cashReceivedNum = Math.round(parsedCash);
        changeNum = cashReceivedNum - amountDue;
      }
    }

    // TWQR details ONLY when transfer is selected (and never expose raw account in state)
    const twqrMeta = resolveTwqrConfig(displaySetting);
    const twqrPayloadObj = selectedMethod === 'transfer'
      ? {
          enabled: twqrMeta.has_twqr,
          use_raw_image: twqrMeta.has_raw_image,
          payload: twqrMeta.has_raw_image ? '' : twqrMeta.payload,
          raw_image_url: twqrMeta.raw_image_url,
          logo_enabled: twqrMeta.logo_enabled,
          logo_url: twqrMeta.logo_url
        }
      : null;

    const thanksSeconds = displaySetting.thanks_seconds ?? 8;
    const idleMinutes = displaySetting.idle_minutes ?? 5;

    // Sanitized SSE payload: ZERO customer name, phone, LINE ID, or booking_ref!
    const checkoutPayload = {
      active: true,
      phase,
      table_label: tableLabel,
      seats,
      pax: sanitizedPersons.length,
      selected_person_nos: selectedPersonNos,
      per_person_detail: perPersonDetail,
      persons: sanitizedPersons,
      amount_due: amountDue,
      payment_methods: enabledMethods,
      method: selectedMethod,
      method_label: selectedMethodLabel,
      cash_received: cashReceivedNum,
      change: changeNum,
      twqr: twqrPayloadObj,
      wake: Boolean(displaySetting.checkout_wake),
      thanks_seconds: thanksSeconds,
      idle_minutes: idleMinutes,
      updated_at: new Date().toISOString()
    };

    const autoClearMs = phase === 'paid'
      ? thanksSeconds * 1000
      : idleMinutes * 60 * 1000;

    displayBus.setCheckoutSync({
      booking_ref: cleanRef,
      payload: checkoutPayload,
      autoClearMs
    });

    return res.json({
      ok: true,
      synced: true,
      checkout: checkoutPayload
    });
  } catch (err) {
    if (err?.status) {
      return res.status(err.status).json({ error: err.message });
    }
    console.error('[displayCheckout] postDisplayCheckout error:', err.message);
    return res.status(500).json({ error: '同步結帳畫面失敗' });
  }
}
