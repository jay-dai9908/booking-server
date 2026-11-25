import test from 'node:test';
import assert from 'node:assert/strict';
import { computeDayInfo } from '../dayType.js';

test('shared/dayType computeDayInfo covers auto, manual, self, closed, and zero sessions', () => {
  // 2026-11-25 (三) 沒有設定、有時段：weekday / weekday / auto
  const wedAuto = computeDayInfo({ date: '2026-11-25', dailySetting: null, bookableSessionCount: 3 });
  assert.equal(wedAuto.type, 'weekday');
  assert.equal(wedAuto.price_type, 'weekday');
  assert.equal(wedAuto.source, 'auto');

  // 2026-11-28 (六) 沒有設定、有時段：holiday / holiday
  const satAuto = computeDayInfo({ date: '2026-11-28', dailySetting: null, bookableSessionCount: 3 });
  assert.equal(satAuto.type, 'holiday');
  assert.equal(satAuto.price_type, 'holiday');
  assert.equal(satAuto.source, 'auto');

  // 2026-11-25 手動 holiday：holiday / holiday / manual
  const wedManualHoliday = computeDayInfo({
    date: '2026-11-25',
    dailySetting: { day_type: 'holiday', day_type_source: 'manual' },
    bookableSessionCount: 3
  });
  assert.equal(wedManualHoliday.type, 'holiday');
  assert.equal(wedManualHoliday.price_type, 'holiday');
  assert.equal(wedManualHoliday.source, 'manual');

  // 2026-11-28 手動 weekday：weekday / weekday
  const satManualWeekday = computeDayInfo({
    date: '2026-11-28',
    dailySetting: { day_type: 'weekday', day_type_source: 'manual' },
    bookableSessionCount: 3
  });
  assert.equal(satManualWeekday.type, 'weekday');
  assert.equal(satManualWeekday.price_type, 'weekday');
  assert.equal(satManualWeekday.source, 'manual');

  // 2026-11-28 半自助、price_type 沒設定：self / holiday
  const satSelfAutoPrice = computeDayInfo({
    date: '2026-11-28',
    dailySetting: { is_self_service: true },
    bookableSessionCount: 3
  });
  assert.equal(satSelfAutoPrice.type, 'self');
  assert.equal(satSelfAutoPrice.price_type, 'holiday');

  // 2026-11-28 半自助、price_type: 'weekday'：self / weekday
  const satSelfWeekdayPrice = computeDayInfo({
    date: '2026-11-28',
    dailySetting: { is_self_service: true, price_type: 'weekday', day_type_source: 'manual' },
    bookableSessionCount: 3
  });
  assert.equal(satSelfWeekdayPrice.type, 'self');
  assert.equal(satSelfWeekdayPrice.price_type, 'weekday');

  // 2026-11-28 手動 closed：closed / holiday
  const satManualClosed = computeDayInfo({
    date: '2026-11-28',
    dailySetting: { day_type: 'closed', closed_note: '員工旅遊', day_type_source: 'manual' },
    bookableSessionCount: 3
  });
  assert.equal(satManualClosed.type, 'closed');
  assert.equal(satManualClosed.price_type, 'holiday');
  assert.equal(satManualClosed.closed_note, '員工旅遊');

  // 沒有可預約時段：closed
  const noSessions = computeDayInfo({
    date: '2026-11-25',
    dailySetting: { day_type: 'holiday' },
    bookableSessionCount: 0
  });
  assert.equal(noSessions.type, 'closed');
  assert.equal(noSessions.price_type, 'weekday');
});
