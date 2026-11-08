import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { transitionMode, buildUnlimitedOptions } from '../src/utils/customer/selection.js';

describe('Customer booking selection mode switching (Section 2.2)', () => {
  const mockSessions = [
    { start_time: '10:00', end_time: '11:00' }, // 0
    { start_time: '11:00', end_time: '12:00' }, // 1
    { start_time: '12:00', end_time: '13:00' }, // 2
    { start_time: '13:00', end_time: '14:00' }, // 3
    { start_time: '14:00', end_time: '15:00' }, // 4
    { start_time: '15:00', end_time: '16:00' }, // 5
    { start_time: '16:00', end_time: '17:00' }, // 6
    { start_time: '17:00', end_time: '18:00' }, // 7
    { start_time: '18:00', end_time: '19:00' }, // 8
    { start_time: '19:00', end_time: '20:00' }, // 9
    { start_time: '20:00', end_time: '21:00' }, // 10
  ];

  const N = 4; // minimum 4 hours for unlimited
  const usable = () => true;
  const linked = () => true;
  const isPast = () => false;
  const unlimitedOptions = buildUnlimitedOptions(mockSessions, { N, usable, linked, isPast });

  test('1. Pick 1 slot (13:00, index 3), switch timed -> unlimited -> timed, preserves original 1 slot (1 hour)', () => {
    let state = {
      mode: 'timed',
      sel: { start: 3, end: 3 },
      arrival: null,
      leave: null,
      lastTimedSel: null,
      lastUnlimited: null,
    };

    // Switch 1: timed -> unlimited
    state = transitionMode({
      currentMode: state.mode,
      targetMode: 'unlimited',
      sel: state.sel,
      arrival: state.arrival,
      leave: state.leave,
      lastTimedSel: state.lastTimedSel,
      lastUnlimited: state.lastUnlimited,
      N,
      unlimitedOptions
    });

    assert.equal(state.mode, 'unlimited');
    assert.equal(state.arrival, 3, 'Arrival defaults to selected start slot');
    // Default leave is arrival + N = 3 + 4 = 7 (not the very end 11!)
    assert.equal(state.leave, 7, 'Default leave is arrival + N hours, not the end of the day');

    // Switch 2: unlimited -> timed
    state = transitionMode({
      currentMode: state.mode,
      targetMode: 'timed',
      sel: state.sel,
      arrival: state.arrival,
      leave: state.leave,
      lastTimedSel: state.lastTimedSel,
      lastUnlimited: state.lastUnlimited,
      N,
      unlimitedOptions
    });

    assert.equal(state.mode, 'timed');
    assert.deepEqual(state.sel, { start: 3, end: 3 }, 'Restores exact 1-slot selection, not 8 slots');

    // Continuous 3 switches test
    for (let i = 0; i < 3; i++) {
      state = transitionMode({ ...state, currentMode: 'timed', targetMode: 'unlimited', N, unlimitedOptions });
      state = transitionMode({ ...state, currentMode: 'unlimited', targetMode: 'timed', N, unlimitedOptions });
    }
    assert.deepEqual(state.sel, { start: 3, end: 3 }, 'Remains 1 slot after 3 consecutive toggles');
  });

  test('2. Pick 3 slots (11:00-14:00, index 1..3), switch back and forth 3 times, preserves 3 slots', () => {
    let state = {
      mode: 'timed',
      sel: { start: 1, end: 3 },
      arrival: null,
      leave: null,
      lastTimedSel: null,
      lastUnlimited: null,
    };

    for (let i = 0; i < 3; i++) {
      state = transitionMode({ ...state, currentMode: 'timed', targetMode: 'unlimited', N, unlimitedOptions });
      assert.equal(state.arrival, 1);
      assert.equal(state.leave, 1 + N); // 5
      state = transitionMode({ ...state, currentMode: 'unlimited', targetMode: 'timed', N, unlimitedOptions });
      assert.deepEqual(state.sel, { start: 1, end: 3 });
    }
  });

  test('3. Starting in unlimited without prior timed selection: switching to timed gives null (no selection)', () => {
    let state = {
      mode: 'unlimited',
      sel: null,
      arrival: 0,
      leave: 4,
      lastTimedSel: null,
      lastUnlimited: null,
    };

    state = transitionMode({
      currentMode: 'unlimited',
      targetMode: 'timed',
      sel: null,
      arrival: state.arrival,
      leave: state.leave,
      lastTimedSel: null,
      lastUnlimited: null,
      N,
      unlimitedOptions
    });

    assert.equal(state.sel, null, 'Must NOT deduce timed selection from unlimited range if never chosen before');
  });

  test('4. If timed selection ends later than arrival + N, unlimited defaults to the later end time', () => {
    // e.g. timed selection is 6 hours: 10:00 to 16:00 (index 0 to 5, end is 6)
    const state = transitionMode({
      currentMode: 'timed',
      targetMode: 'unlimited',
      sel: { start: 0, end: 5 },
      arrival: null,
      leave: null,
      lastTimedSel: null,
      lastUnlimited: null,
      N,
      unlimitedOptions
    });

    assert.equal(state.arrival, 0);
    assert.equal(state.leave, 6, 'Uses original timed end time if later than arrival + N');
  });

  test('5. Spec 2.4: HourRangeScrollPicker does not contain hardcoded business hour presets', () => {
    const filePath = path.resolve('frontend/src/components/HourRangeScrollPicker.jsx');
    const fileContent = fs.readFileSync(filePath, 'utf-8');
    assert.ok(!fileContent.includes('常用營業時段一鍵套用'), 'Must not have hardcoded preset header');
    assert.ok(!fileContent.includes('平日 (13:00~21:00)'), 'Must not have hardcoded preset button');
    assert.ok(!fileContent.includes('假日 (09:00~21:00)'), 'Must not have hardcoded preset button');
    assert.ok(!fileContent.includes('全天 (10:00~22:00)'), 'Must not have hardcoded preset button');
  });

  test('6. Spec 2.6: CheckInPanel does not contain hardcoded fallback reason', () => {
    const filePath = path.resolve('frontend/src/components/admin/floor/CheckInPanel.jsx');
    const fileContent = fs.readFileSync(filePath, 'utf-8');
    assert.ok(!fileContent.includes('已避開冷氣出風口並優先安排同側或相鄰座位。'), 'Must not have hardcoded fallback reason');
  });

  test('7. Spec 2.7: CheckoutWorkbench collect modal title has thousand separator and subtitle has 位一起', () => {
    const filePath = path.resolve('frontend/src/components/admin/checkout/CheckoutWorkbench.jsx');
    const fileContent = fs.readFileSync(filePath, 'utf-8');
    assert.ok(!fileContent.includes('一併收款 NT${netDue}'), 'Must not use unformatted 一併收款 title');
    assert.ok(!fileContent.includes('位顧客 · 單號'), 'Must use "位一起 · BK-..." subtitle instead of "位顧客 · 單號"');
    assert.ok(fileContent.includes('Number(netDue).toLocaleString()'), 'Must format netDue with toLocaleString()');
  });
});
