// shared/__tests__/displaySchedule.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { decide, DEFAULT_DISPLAY_SCHEDULE } from '../displaySchedule.js';

const tp = (isoLocal) => new Date(`${isoLocal}+08:00`);

test('decide handles all four day types with default schedule', () => {
  const date = '2026-11-23'; // Monday
  const openTime = '10:00';
  const closeTime = '21:00';

  // 1. weekday -> timers, 09:45-21:15
  assert.deepEqual(
    decide({
      dayType: 'weekday',
      schedule: DEFAULT_DISPLAY_SCHEDULE,
      specialDates: [],
      date,
      now: tp('2026-11-23T14:00:00'),
      openTime,
      closeTime
    }),
    { on: true, content: 'timers', window: ['09:45', '21:15'] }
  );

  // 2. holiday -> timers, 09:45-21:30
  assert.deepEqual(
    decide({
      dayType: 'holiday',
      schedule: DEFAULT_DISPLAY_SCHEDULE,
      specialDates: [],
      date: '2026-11-22',
      now: tp('2026-11-22T21:20:00'),
      openTime,
      closeTime
    }),
    { on: true, content: 'timers', window: ['09:45', '21:30'] }
  );

  // 3. self -> slides_self, 09:30-21:30
  assert.deepEqual(
    decide({
      dayType: 'self',
      schedule: DEFAULT_DISPLAY_SCHEDULE,
      specialDates: [],
      date,
      now: tp('2026-11-23T09:35:00'),
      openTime,
      closeTime
    }),
    { on: true, content: 'slides_self', window: ['09:30', '21:30'] }
  );

  // 4. closed -> off, window null
  assert.deepEqual(
    decide({
      dayType: 'closed',
      schedule: DEFAULT_DISPLAY_SCHEDULE,
      specialDates: [],
      date,
      now: tp('2026-11-23T14:00:00'),
      openTime: null,
      closeTime: null
    }),
    { on: false, content: 'off', window: null }
  );
});

test('decide handles biz before/after boundaries accurately', () => {
  const schedule = {
    weekday: { mode: 'biz', before: 20, after: 45, content: 'timers_self' }
  };
  const base = {
    dayType: 'weekday',
    schedule,
    specialDates: [],
    date: '2026-11-24',
    openTime: '10:00',
    closeTime: '20:00'
  };

  // Window is 09:40 - 20:45
  assert.deepEqual(decide({ ...base, now: tp('2026-11-24T09:39:59') }), {
    on: false,
    content: 'off',
    window: ['09:40', '20:45']
  });
  assert.deepEqual(decide({ ...base, now: tp('2026-11-24T09:40:00') }), {
    on: true,
    content: 'timers_self',
    window: ['09:40', '20:45']
  });
  assert.deepEqual(decide({ ...base, now: tp('2026-11-24T20:44:59') }), {
    on: true,
    content: 'timers_self',
    window: ['09:40', '20:45']
  });
  assert.deepEqual(decide({ ...base, now: tp('2026-11-24T20:45:00') }), {
    on: false,
    content: 'off',
    window: ['09:40', '20:45']
  });
});

test('decide handles fixed mode', () => {
  const schedule = {
    weekday: { mode: 'fixed', on: '11:30', off: '19:00', content: 'slides_gen' }
  };
  const base = { dayType: 'weekday', schedule, date: '2026-11-24', openTime: '10:00', closeTime: '21:00' };

  assert.deepEqual(decide({ ...base, now: tp('2026-11-24T11:29:00') }), {
    on: false,
    content: 'off',
    window: ['11:30', '19:00']
  });
  assert.deepEqual(decide({ ...base, now: tp('2026-11-24T15:00:00') }), {
    on: true,
    content: 'slides_gen',
    window: ['11:30', '19:00']
  });
  assert.deepEqual(decide({ ...base, now: tp('2026-11-24T19:00:00') }), {
    on: false,
    content: 'off',
    window: ['11:30', '19:00']
  });
});

test('decide handles always and never modes', () => {
  const alwaysSched = { weekday: { mode: 'always', content: 'slides_gen' } };
  assert.deepEqual(
    decide({ dayType: 'weekday', schedule: alwaysSched, date: '2026-11-24', now: tp('2026-11-24T03:00:00') }),
    { on: true, content: 'slides_gen', window: ['00:00', '24:00'] }
  );

  const neverSched = { weekday: { mode: 'never', content: 'timers' } };
  assert.deepEqual(
    decide({ dayType: 'weekday', schedule: neverSched, date: '2026-11-24', now: tp('2026-11-24T14:00:00'), openTime: '10:00', closeTime: '21:00' }),
    { on: false, content: 'off', window: null }
  );
});

test('decide handles specialDates extending closing time', () => {
  const specialDates = [{ date: '2026-12-31', off: '23:30', note: '跨年延長營業' }];
  const base = {
    dayType: 'weekday',
    schedule: DEFAULT_DISPLAY_SCHEDULE,
    specialDates,
    date: '2026-12-31',
    openTime: '10:00',
    closeTime: '21:00'
  };

  // Normally closes at 21:15, but special date extends to 23:30
  assert.deepEqual(decide({ ...base, now: tp('2026-12-31T22:30:00') }), {
    on: true,
    content: 'timers',
    window: ['09:45', '23:30']
  });
  assert.deepEqual(decide({ ...base, now: tp('2026-12-31T23:30:00') }), {
    on: false,
    content: 'off',
    window: ['09:45', '23:30']
  });
});

test('decide handles crossing midnight both before and after midnight', () => {
  // Case A: Special date extends New Year Eve past midnight to 01:00
  const specialDates = [{ date: '2026-12-31', off: '01:00', note: '跨年通宵' }];
  const baseSpecial = {
    dayType: 'holiday',
    schedule: DEFAULT_DISPLAY_SCHEDULE,
    specialDates,
    date: '2026-12-31',
    openTime: '10:00',
    closeTime: '21:00'
  };

  // Before midnight (23:55)
  assert.deepEqual(decide({ ...baseSpecial, now: tp('2026-12-31T23:55:00') }), {
    on: true,
    content: 'timers',
    window: ['09:45', '01:00']
  });

  // After midnight (00:30 next day)
  assert.deepEqual(decide({ ...baseSpecial, now: tp('2027-01-01T00:30:00') }), {
    on: true,
    content: 'timers',
    window: ['09:45', '01:00']
  });

  // After 01:00 closing (01:05 next day)
  assert.deepEqual(decide({ ...baseSpecial, now: tp('2027-01-01T01:05:00') }), {
    on: false,
    content: 'off',
    window: ['09:45', '01:00']
  });

  // Case B: Fixed mode crossing midnight (20:00 - 02:00)
  const fixedMidnight = { weekday: { mode: 'fixed', on: '20:00', off: '02:00', content: 'slides_gen' } };
  assert.deepEqual(
    decide({ dayType: 'weekday', schedule: fixedMidnight, date: '2026-12-31', now: tp('2026-12-31T23:59:00') }),
    { on: true, content: 'slides_gen', window: ['20:00', '02:00'] }
  );
  assert.deepEqual(
    decide({ dayType: 'weekday', schedule: fixedMidnight, date: '2026-12-31', now: tp('2027-01-01T01:59:00') }),
    { on: true, content: 'slides_gen', window: ['20:00', '02:00'] }
  );
  assert.deepEqual(
    decide({ dayType: 'weekday', schedule: fixedMidnight, date: '2026-12-31', now: tp('2027-01-01T02:00:00') }),
    { on: false, content: 'off', window: ['20:00', '02:00'] }
  );
});
