import assert from 'node:assert';
import {
  parseYMD,
  getDayPricing,
  unlimitedThresholdHours,
  seatPrice,
  buildDiscountConfig,
  equipmentUnitPrice,
  shortBoardName,
  groupUnits,
  calcPromoDiscount,
  buildPriceLines,
} from '../src/utils/customer/pricing.js';
import {
  isSessionPast,
  slotState,
  meterBeads,
  dayState,
} from '../src/utils/customer/availability.js';
import {
  tapSlot,
  buildUnlimitedOptions,
} from '../src/utils/customer/selection.js';
import { boardDiscountTexts } from '../src/utils/customer/discountText.js';
import {
  formatMoney,
  formatMoneyBig,
  formatMinus,
  formatDateShort,
  formatDateFull,
  formatTimeRange,
  formatPhone,
  cnNum,
  formatBookingRef,
} from '../src/utils/customer/format.js';

console.log('--- Running tests on customer utils ---');

const globalSettings = {
  weekday_hourly_price: 100,
  weekday_unlimited_price: 550,
  weekend_hourly_price: 150,
  weekend_unlimited_price: 800,
  equipment_discount_enabled: true,
  equipment_discount_buy_hours: 2,
  equipment_discount_free_hours: 1,
  equipment_discount_stackable: true,
  equipment_discount2_enabled: false,
};

const configs = {
  small: { id: 'small', name: '小板 (50×50)', hourly_rate: 100, daily_cap: 500, min_contiguous_hours: 2 },
  medium: { id: 'medium', name: '中板 (78×78)', hourly_rate: 120, daily_cap: 600, min_contiguous_hours: 2 },
  large: { id: 'large', name: '大板 (100×100)', hourly_rate: 140, daily_cap: 700, min_contiguous_hours: 2 },
};

const discountCfg = buildDiscountConfig(globalSettings);

// 情境 1: 平日 1 位 12:00–14:00 計時 → NT$200；沒有封頂
{
  const day = getDayPricing('2026-11-05', globalSettings, null); // 11/05 is Thu (weekday)
  assert.strictEqual(day.dayType, 'weekday');
  const res = seatPrice({ pax: 1, hours: 2, hourly: day.hourly, cap: day.cap, allowUnlimited: day.allowUnlimited });
  assert.strictEqual(res.total, 200);
  assert.strictEqual(res.isCapped, false);
  console.log('✓ Scenario 1 passed');
}

// 情境 2: 平日 1 位 12:00–18:00 計時 → 刪除線 NT$600、NT$ 550；封頂每人最高只收 NT$550
{
  const day = getDayPricing('2026-11-05', globalSettings, null);
  const res = seatPrice({ pax: 1, hours: 6, hourly: day.hourly, cap: day.cap, allowUnlimited: day.allowUnlimited });
  assert.strictEqual(res.raw, 600);
  assert.strictEqual(res.total, 550);
  assert.strictEqual(res.capSaving, 50);
  assert.strictEqual(res.isCapped, true);
  console.log('✓ Scenario 2 passed');
}

// 情境 3: 平日 2 位 12:00–18:00，中板 1 台 14:00–18:00 → 合計 NT$1,460；共省 NT$220
{
  const day = getDayPricing('2026-11-05', globalSettings, null);
  const units = [{ uid: '1', equipment_id: 'medium', from: 2, to: 6, start: '14:00', end: '18:00' }];
  const bookingSessions = [
    { start_time: '12:00', end_time: '13:00' },
    { start_time: '13:00', end_time: '14:00' },
    { start_time: '14:00', end_time: '15:00' },
    { start_time: '15:00', end_time: '16:00' },
    { start_time: '16:00', end_time: '17:00' },
    { start_time: '17:00', end_time: '18:00' },
  ];
  const linesRes = buildPriceLines({
    pax: 2,
    hours: 6,
    day,
    mode: 'timed',
    units,
    configs,
    discountCfg,
    bookingSessions,
  });
  assert.strictEqual(linesRes.total, 1460);
  assert.strictEqual(linesRes.saving, 220);
  assert.strictEqual(linesRes.seat.raw, 1200);
  assert.strictEqual(linesRes.seat.capSaving, 100);
  assert.strictEqual(linesRes.equipmentTotal, 360);
  console.log('✓ Scenario 3 passed');
}

// 情境 4: 平日 1 位 10:00–19:00，大板 1 台整段（9 小時）
// 原價 NT$1,260、折抵 3 小時 -NT$420、上限 -NT$140、實收 NT$700
{
  const p = equipmentUnitPrice(configs.large, 9, discountCfg);
  assert.strictEqual(p.raw, 1260);
  assert.strictEqual(p.discountSaving, 420);
  assert.strictEqual(p.capSaving, 140);
  assert.strictEqual(p.price, 700);
  console.log('✓ Scenario 4 passed');
}

// 情境 5: 中板 2 台，一台 12:00–14:00、一台 14:00–18:00
{
  const units = [
    { uid: 'u1', equipment_id: 'medium', from: 0, to: 2, start: '12:00', end: '14:00' },
    { uid: 'u2', equipment_id: 'medium', from: 2, to: 6, start: '14:00', end: '18:00' },
  ];
  const groups = groupUnits(units);
  assert.strictEqual(groups.length, 2);
  assert.strictEqual(groups[0].hours, 2);
  assert.strictEqual(groups[1].hours, 4);
  console.log('✓ Scenario 5 passed');
}

// 情境 6: 假日不限時，10:00 有空位 → N = 6
{
  const day = getDayPricing('2026-11-07', globalSettings, null); // 11/07 is Sat (weekend)
  assert.strictEqual(day.dayType, 'weekend');
  const N = unlimitedThresholdHours(day);
  assert.strictEqual(N, 6);

  // 10:00 to 21:00 (11 sessions: index 0..10)
  const sessions = [];
  for (let h = 10; h < 21; h++) {
    sessions.push({
      start_time: `${h}:00`,
      end_time: `${h + 1}:00`,
      remaining_capacity: 20,
      max_capacity: 20,
    });
  }

  const { arrivals, leavesFor } = buildUnlimitedOptions(sessions, {
    N,
    usable: () => true,
    linked: () => true,
    isPast: () => false,
  });

  // 10:00 to 15:00 can have 6 hours (enabled: true)
  // 16:00 and 17:00 enabled: false
  const a10 = arrivals.find((a) => a.time === '10:00');
  const a15 = arrivals.find((a) => a.time === '15:00');
  const a16 = arrivals.find((a) => a.time === '16:00');
  const a17 = arrivals.find((a) => a.time === '17:00');
  assert.strictEqual(a10.enabled, true);
  assert.strictEqual(a15.enabled, true);
  assert.strictEqual(a16.enabled, false);
  assert.strictEqual(a17.enabled, false);

  // Arrival at 13:00 (index 3)
  const leaves13 = leavesFor(3);
  // leaves: j in [4..11] -> times 14:00 to 21:00
  // j >= 3 + 6 = 9 -> 19:00, 20:00, 21:00 enabled
  // 17:00 (j=7), 18:00 (j=8) disabled
  const l17 = leaves13.find((l) => l.time === '17:00');
  const l18 = leaves13.find((l) => l.time === '18:00');
  const l19 = leaves13.find((l) => l.time === '19:00');
  const l20 = leaves13.find((l) => l.time === '20:00');
  const l21 = leaves13.find((l) => l.time === '21:00');
  assert.strictEqual(l17.enabled, false);
  assert.strictEqual(l18.enabled, false);
  assert.strictEqual(l19.enabled, true);
  assert.strictEqual(l20.enabled, true);
  assert.strictEqual(l21.enabled, true);
  assert.strictEqual(l21.isClosing, true);

  const priceRes = seatPrice({ pax: 1, hours: 8, hourly: day.hourly, cap: day.cap, allowUnlimited: true, mode: 'unlimited' });
  assert.strictEqual(priceRes.total, 800);
  console.log('✓ Scenario 6 passed');
}

// 情境 7: 平日不限時，10:00 額滿 → 到店 10:00 反灰
{
  const sessions = [];
  for (let h = 10; h < 21; h++) {
    sessions.push({
      start_time: `${h}:00`,
      end_time: `${h + 1}:00`,
      remaining_capacity: h === 10 ? 0 : 20,
      max_capacity: 20,
    });
  }
  const { arrivals } = buildUnlimitedOptions(sessions, {
    N: 6,
    usable: (i) => i !== 0,
    linked: () => true,
    isPast: () => false,
  });
  const a10 = arrivals.find((a) => a.time === '10:00');
  const a11 = arrivals.find((a) => a.time === '11:00');
  assert.strictEqual(a10.enabled, false);
  assert.strictEqual(a11.enabled, true);
  console.log('✓ Scenario 7 passed');
}

// 情境 8: 某天 allow_unlimited = false，計時 10 小時 → 不封頂（NT$1,000）
{
  const daily = { allow_unlimited: false };
  const day = getDayPricing('2026-11-05', globalSettings, daily);
  assert.strictEqual(day.allowUnlimited, false);
  const res = seatPrice({ pax: 1, hours: 10, hourly: day.hourly, cap: day.cap, allowUnlimited: day.allowUnlimited });
  assert.strictEqual(res.total, 1000);
  assert.strictEqual(res.isCapped, false);
  console.log('✓ Scenario 8 passed');
}

// 情境 9: 某天特別價每小時 120、不限時 700 → 標特別價，N = 6
{
  const daily = { allow_unlimited: true, hourly_price: 120, unlimited_price: 700 };
  const day = getDayPricing('2026-11-05', globalSettings, daily);
  assert.strictEqual(day.dayType, 'special');
  assert.strictEqual(day.hourly, 120);
  assert.strictEqual(day.cap, 700);
  assert.strictEqual(unlimitedThresholdHours(day), 6);
  console.log('✓ Scenario 9 passed');
}

// 情境 10: 後台改成買 3 送 1
{
  const cfg = buildDiscountConfig({
    equipment_discount_enabled: true,
    equipment_discount_buy_hours: 3,
    equipment_discount_free_hours: 1,
    equipment_discount_stackable: true,
  });
  const texts = boardDiscountTexts(cfg);
  assert.strictEqual(texts.deal, '買三送一');
  assert.strictEqual(texts.rule, '租滿 4 小時自動折抵 1 小時（買三送一）');
  assert.strictEqual(texts.home, '租借時段買三送一');
  console.log('✓ Scenario 10 passed');
}

// 情境 11: 後台關閉「可疊加」，中板 6 小時（買 2 送 1） → 只折 1 小時：實收 NT$600 (120 × 5)
{
  const cfg = buildDiscountConfig({
    equipment_discount_enabled: true,
    equipment_discount_buy_hours: 2,
    equipment_discount_free_hours: 1,
    equipment_discount_stackable: false,
  });
  const p = equipmentUnitPrice(configs.medium, 6, cfg);
  assert.strictEqual(p.freeHours, 1);
  assert.strictEqual(p.chargeable, 5);
  assert.strictEqual(p.price, 600);
  console.log('✓ Scenario 11 passed');
}

// 情境 12: 後台關閉智能板優惠
{
  const cfg = buildDiscountConfig({
    equipment_discount_enabled: false,
  });
  const texts = boardDiscountTexts(cfg);
  assert.strictEqual(texts, null);
  console.log('✓ Scenario 12 passed');
}

// 情境 13: 折扣碼（9 折、只折座位）
{
  const promo = {
    code: 'SEAT90',
    target_scope: 'seating',
    discount_type: 'percentage',
    discount_value: 90, // 9折
  };
  const discountAmt = calcPromoDiscount(promo, {
    pax: 2,
    hours: 6,
    seatingAmount: 1100,
    equipmentAmount: 360,
    hourly: 100,
  });
  assert.strictEqual(discountAmt, 110);
  console.log('✓ Scenario 13 passed');
}

// 測試選取連貫性 tapSlot
{
  const usable = (i) => true;
  const linked = () => true;

  // 點 12:00 (index 2)
  let s1 = tapSlot(null, 2, { usable, linked }).sel;
  assert.deepStrictEqual(s1, { start: 2, end: 2 });

  // 點 15:00 (index 5) -> 2..5
  let s2 = tapSlot(s1, 5, { usable, linked }).sel;
  assert.deepStrictEqual(s2, { start: 2, end: 5 });

  // 再點 13:00 (index 3) -> 2..3
  let s3 = tapSlot(s2, 3, { usable, linked }).sel;
  assert.deepStrictEqual(s3, { start: 2, end: 3 });

  // 點 12:00 (start=2) -> 3..3
  let s4 = tapSlot(s3, 2, { usable, linked }).sel;
  assert.deepStrictEqual(s4, { start: 3, end: 3 });

  // 再點 13:00 (start=3, end=3) -> null
  let s5 = tapSlot(s4, 3, { usable, linked }).sel;
  assert.strictEqual(s5, null);

  // 中間有額滿
  const usableWithGap = (i) => i !== 3;
  let gapSel = tapSlot(null, 2, { usable: usableWithGap, linked }).sel;
  let gapNext = tapSlot(gapSel, 5, { usable: usableWithGap, linked }).sel;
  assert.deepStrictEqual(gapNext, { start: 5, end: 5 }); // resets to clicked slot

  console.log('✓ tapSlot selection tests passed');
}

console.log('=== ALL TESTS PASSED SUCCESSFULLY! ===');
