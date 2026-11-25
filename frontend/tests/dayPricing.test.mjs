import test from 'node:test';
import assert from 'node:assert/strict';
import { getDayPricing } from '../src/utils/customer/pricing.js';

const globalMock = {
  weekday_hourly_price: 150,
  weekday_unlimited_price: 750,
  weekend_hourly_price: 180,
  weekend_unlimited_price: 1100
};

test('getDayPricing respects daily.price_type override for manual holidays and weekdays', () => {
  const wedAuto = getDayPricing('2026-11-25', globalMock, null);
  assert.equal(wedAuto.isWeekend, false);
  assert.equal(wedAuto.dayType, 'weekday');
  assert.equal(wedAuto.hourly, 150);

  const wedHoliday = getDayPricing('2026-11-25', globalMock, {
    day_type: 'holiday',
    price_type: 'holiday',
    hourly_price: null,
    unlimited_price: null
  });
  assert.equal(wedHoliday.isWeekend, true);
  assert.equal(wedHoliday.dayType, 'weekend');
  assert.equal(wedHoliday.hourly, 180);

  const satWeekday = getDayPricing('2026-11-28', globalMock, {
    day_type: 'weekday',
    price_type: 'weekday',
    hourly_price: null,
    unlimited_price: null
  });
  assert.equal(satWeekday.isWeekend, false);
  assert.equal(satWeekday.dayType, 'weekday');
  assert.equal(satWeekday.hourly, 150);
});
