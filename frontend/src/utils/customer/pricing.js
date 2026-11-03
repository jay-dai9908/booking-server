import { calculateEquipmentChargeableHours } from '../equipmentPricing.js';
import { boardDiscountTexts } from './discountText.js';
import { toDateObj } from './format.js';

export function parseYMD(dateStr) {
  if (!dateStr) return new Date();
  if (dateStr instanceof Date) return dateStr;
  return toDateObj(dateStr);
}


export function getDayPricing(dateStr, global, daily) {
  const dow = parseYMD(dateStr).getDay();
  const isWeekend = dow === 0 || dow === 6;
  const baseHourly = isWeekend ? global?.weekend_hourly_price : global?.weekday_hourly_price;
  const baseCap = isWeekend ? global?.weekend_unlimited_price : global?.weekday_unlimited_price;
  const hourly = daily?.hourly_price ?? baseHourly ?? 0;
  const cap = daily?.unlimited_price ?? baseCap ?? 0;
  const isSpecial = hourly !== baseHourly || cap !== baseCap;
  return {
    isWeekend,
    dayType: isSpecial ? 'special' : isWeekend ? 'weekend' : 'weekday',
    hourly,
    cap,
    allowUnlimited: daily?.allow_unlimited ?? true,
  };
}

export const DAY_TYPE_LABEL = { weekday: '平日', weekend: '假日', special: '特別價' };
export const DAY_PRICE_LABEL = { weekday: '平日價', weekend: '假日價', special: '特別價' };

export function unlimitedThresholdHours({ hourly, cap }) {
  if (!hourly || hourly <= 0) return 1;
  return Math.ceil(cap / hourly);
}

export function seatPrice({ pax, hours, hourly, cap, allowUnlimited = true, mode = 'timed' }) {
  const raw = pax * hourly * hours;
  const capTotal = pax * cap;
  if (mode === 'unlimited') {
    return { raw, total: capTotal, capSaving: 0, isCapped: true };
  }
  if (allowUnlimited && raw > capTotal) {
    return { raw, total: capTotal, capSaving: raw - capTotal, isCapped: true };
  }
  return { raw, total: raw, capSaving: 0, isCapped: false };
}

export function buildDiscountConfig(s) {
  return {
    enabled: s?.equipment_discount_enabled !== false,
    buy_hours: s?.equipment_discount_buy_hours ?? 3,
    free_hours: s?.equipment_discount_free_hours ?? 1,
    stackable: s?.equipment_discount_stackable !== false,
    tier2_enabled: s?.equipment_discount2_enabled === true,
    tier2_buy_hours: s?.equipment_discount2_buy_hours ?? 8,
    tier2_free_hours: s?.equipment_discount2_free_hours ?? 4,
  };
}

export function equipmentUnitPrice(config, hours, discountConfig) {
  const chargeable = calculateEquipmentChargeableHours(hours, discountConfig);
  const raw = (config?.hourly_rate ?? 0) * hours;
  const afterDiscount = (config?.hourly_rate ?? 0) * chargeable;
  const price = (config?.daily_cap > 0) ? Math.min(afterDiscount, config.daily_cap) : afterDiscount;
  return {
    hours,
    chargeable,
    freeHours: hours - chargeable,
    raw,
    discountSaving: raw - afterDiscount,
    capSaving: afterDiscount - price,
    price,
  };
}

export const shortBoardName = (name) => (name || '').replace(/\s*[（(][^)）]*[)）]\s*/g, '').trim();

export function groupUnits(units = [], bookingSessions = []) {
  const H = Array.isArray(bookingSessions) ? bookingSessions.length : 0;
  const boundaryTime = typeof bookingSessions === 'function'
    ? bookingSessions
    : (k) => {
        if (Array.isArray(bookingSessions)) {
          if (k < H) return bookingSessions[k]?.start_time;
          if (H > 0) return bookingSessions[H - 1]?.end_time;
        }
        return '';
      };
  return Object.values(units.reduce((acc, u) => {
    const start = u.start || (typeof u.from === 'number' ? boundaryTime(u.from) : '');
    const end = u.end || (typeof u.to === 'number' ? boundaryTime(u.to) : '');
    const hours = u.hours ?? ((typeof u.to === 'number' && typeof u.from === 'number') ? (u.to - u.from) : 0);
    const key = `${u.equipment_id}|${u.from}|${u.to}|${start}|${end}|${hours}`;
    acc[key] ??= {
      equipment_id: u.equipment_id,
      qty: 0,
      hours,
      start,
      end,
      from: u.from,
      to: u.to
    };
    acc[key].qty += 1;
    return acc;
  }, {}));
}

export function calcPromoDiscount(promo, { pax, hours, seatingAmount, equipmentAmount, hourly }) {
  if (!promo) return 0;
  const subtotalBeforePromo = seatingAmount + equipmentAmount;
  if (promo.min_pax && pax < promo.min_pax) return 0;
  if (promo.min_hours && hours < promo.min_hours) return 0;
  if (promo.min_amount && subtotalBeforePromo < promo.min_amount) return 0;

  let targetBase = subtotalBeforePromo;
  if (promo.target_scope === 'seating') {
    targetBase = seatingAmount;
  } else if (promo.target_scope === 'equipment') {
    targetBase = equipmentAmount;
  }

  let amt = 0;
  if (promo.discount_type === 'fixed_order') {
    amt = promo.discount_value;
  } else if (promo.discount_type === 'fixed_per_pax') {
    amt = promo.discount_value * pax;
  } else if (promo.discount_type === 'percentage') {
    const val = promo.discount_value;
    const pctOff = val > 50 && val < 100 ? (100 - val) : val;
    amt = Math.round(targetBase * (pctOff / 100));
  } else if (promo.discount_type === 'free_hours') {
    amt = Math.round(hourly * promo.discount_value);
  }

  if (promo.max_discount_amount && promo.max_discount_amount > 0) {
    amt = Math.min(amt, promo.max_discount_amount);
  }

  return Math.min(targetBase, Math.max(0, amt));
}

export function buildPriceLines({ pax, hours, startTime, endTime, day, mode, units = [], configs = {}, discountCfg, promo, bookingSessions = [] }) {
  const lines = [];
  const seat = seatPrice({ pax, hours, hourly: day.hourly, cap: day.cap, allowUnlimited: day.allowUnlimited, mode });

  if (mode === 'unlimited') {
    lines.push({ label: `當日不限時暢玩 ${pax} 位`, amount: seat.total });
  } else {
    lines.push({ label: `入場 ${pax} 位 × ${hours} 小時`, amount: seat.raw });
    if (seat.capSaving > 0) {
      lines.push({ label: `時數封頂（當日不限時暢玩 NT$${day.cap.toLocaleString()}）`, amount: -seat.capSaving, tone: 'save' });
    }
  }

  const texts = boardDiscountTexts(discountCfg);
  let equipmentTotal = 0, equipmentSaving = 0;
  const groups = groupUnits(units, bookingSessions);
  for (const group of groups) {
    const cfg = configs[group.equipment_id];
    if (!cfg) continue;
    const p = equipmentUnitPrice(cfg, group.hours, discountCfg);
    lines.push({ label: `智能拼豆板 ${shortBoardName(cfg.name)} ×${group.qty} · ${group.start} 到 ${group.end}`, amount: p.raw * group.qty });
    if (p.discountSaving > 0 && texts) {
      lines.push({ label: texts.lineLabel(p.freeHours), amount: -p.discountSaving * group.qty, tone: 'save' });
    }
    if (p.capSaving > 0) {
      lines.push({ label: `智能板單日上限（每台 NT$${cfg.daily_cap.toLocaleString()}）`, amount: -p.capSaving * group.qty, tone: 'save' });
    }
    equipmentTotal += p.price * group.qty;
    equipmentSaving += (p.discountSaving + p.capSaving) * group.qty;
  }

  const promoAmount = promo ? calcPromoDiscount(promo, { pax, hours, seatingAmount: seat.total, equipmentAmount: equipmentTotal, hourly: day.hourly }) : 0;
  if (promoAmount > 0) lines.push({ label: `折扣碼 ${promo.code}`, amount: -promoAmount, tone: 'save' });

  const total = Math.max(0, seat.total + equipmentTotal - promoAmount);
  const saving = seat.capSaving + equipmentSaving + promoAmount;
  return { lines, seat, equipmentTotal, promoAmount, total, saving };
}
