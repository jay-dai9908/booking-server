// frontend/tests/displayHelpers.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BEAD_COLORS,
  formatDurationHMM,
  formatTaipeiHHmm,
  formatTaipeiDateShort,
  computeSeatVisualState,
  getClosingWarning,
  computeBurnInShift
} from '../src/utils/display/seatStatus.js';
import {
  computeDisplayMapData,
  findHereShape
} from '../src/utils/display/mapMarkers.js';
import { msUntilNextTaipei0400 } from '../src/utils/display/taipeiReload.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

test('display seat status, colors, and duration formatting', async (t) => {
  const nowMs = new Date('2026-11-22T14:20:00+08:00').getTime();

  await t.test('formatDurationHMM formats h:mm flooring to minute', () => {
    assert.equal(formatDurationHMM(0), '0:00');
    assert.equal(formatDurationHMM(59), '0:00');
    assert.equal(formatDurationHMM(60), '0:01');
    assert.equal(formatDurationHMM(305), '0:05');
    assert.equal(formatDurationHMM(11280), '3:08');
  });

  await t.test('formatTaipeiHHmm & formatTaipeiDateShort', () => {
    assert.equal(formatTaipeiHHmm(nowMs), '14:20');
    assert.equal(formatTaipeiDateShort(nowMs), '11/22（日）');
  });

  await t.test('empty seat', () => {
    const res = computeSeatVisualState(null, { nowMs });
    assert.equal(res.cls, 'empty');
    assert.equal(res.timeText, '');
  });

  await t.test('running seat (remain and used mode)', () => {
    const seat = {
      code: 'A1-1',
      state: 'running',
      origin_at: '2026-11-22T13:00:00+08:00',
      mode: 'hourly',
      hours: 3,
      paused_seconds: 0,
      has_board: true
    };
    const rem = computeSeatVisualState(seat, { nowMs, soonMinutes: 10, timeMode: 'remain' });
    assert.equal(rem.cls, 'run');
    assert.deepEqual(rem.colors, BEAD_COLORS.run);
    assert.equal(rem.timeText, '1:40');
    assert.equal(rem.hasBoard, true);

    const used = computeSeatVisualState(seat, { nowMs, soonMinutes: 10, timeMode: 'used' });
    assert.equal(used.cls, 'run');
    assert.equal(used.timeText, '1:20');
  });

  await t.test('soon expiring seat (within soon_minutes)', () => {
    const seat = {
      code: 'A4-1',
      state: 'running',
      origin_at: '2026-11-22T13:30:00+08:00',
      mode: 'hourly',
      hours: 1,
      paused_seconds: 0,
      has_board: false
    };
    const res = computeSeatVisualState(seat, { nowMs, soonMinutes: 10, timeMode: 'remain' });
    assert.equal(res.cls, 'soon');
    assert.deepEqual(res.colors, BEAD_COLORS.soon);
    assert.equal(res.timeText, '0:10');
  });

  await t.test('overtime seat', () => {
    const seat = {
      code: 'B2-1',
      state: 'running',
      origin_at: '2026-11-22T10:00:00+08:00',
      mode: 'hourly',
      hours: 4,
      paused_seconds: 0,
      has_board: false
    };
    const res = computeSeatVisualState(seat, { nowMs, soonMinutes: 10, timeMode: 'remain' });
    assert.equal(res.cls, 'over');
    assert.deepEqual(res.colors, BEAD_COLORS.over);
    assert.equal(res.timeText, '+0:20');
  });

  await t.test('unlimited seat shows elapsed time', () => {
    const seat = {
      code: 'A2-1',
      state: 'unlimited',
      origin_at: '2026-11-22T12:00:00+08:00',
      mode: 'unlimited',
      hours: 0,
      paused_seconds: 0,
      has_board: true
    };
    const res = computeSeatVisualState(seat, { nowMs, soonMinutes: 10, timeMode: 'remain' });
    assert.equal(res.cls, 'unl');
    assert.deepEqual(res.colors, BEAD_COLORS.unl);
    assert.equal(res.timeText, '2:20');
  });

  await t.test('paused seat (both paused_seconds history and currently paused)', () => {
    const seatWithHistory = {
      code: 'A3-3',
      state: 'running',
      origin_at: '2026-11-22T11:00:00+08:00',
      mode: 'hourly',
      hours: 4,
      paused_seconds: 15 * 60,
      has_board: false
    };
    const res1 = computeSeatVisualState(seatWithHistory, { nowMs, soonMinutes: 10, timeMode: 'remain' });
    assert.equal(res1.cls, 'paused');
    assert.deepEqual(res1.colors, BEAD_COLORS.paused);
    // 3h20m elapsed - 15m paused = 3h05m used -> 0:55 remaining
    assert.equal(res1.timeText, '0:55');

    const currentlyPaused = {
      code: 'A3-4',
      state: 'paused',
      origin_at: '2026-11-22T13:00:00+08:00',
      paused_at: '2026-11-22T13:30:00+08:00',
      mode: 'hourly',
      hours: 2,
      paused_seconds: 0,
      has_board: false
    };
    const res2 = computeSeatVisualState(currentlyPaused, { nowMs, soonMinutes: 10, timeMode: 'used' });
    assert.equal(res2.cls, 'paused');
    assert.equal(res2.timeText, '0:30');
  });

  await t.test('booked (not seated yet) seat', () => {
    const seat = {
      code: 'B1-1',
      state: 'booked',
      origin_at: '2026-11-22T15:00:00+08:00',
      mode: 'hourly',
      hours: 2,
      paused_seconds: 0,
      has_board: false
    };
    const res = computeSeatVisualState(seat, { nowMs, soonMinutes: 10, timeMode: 'remain' });
    assert.equal(res.cls, 'booked');
    assert.deepEqual(res.colors, BEAD_COLORS.booked);
    assert.equal(res.timeText, '15:00');
  });
});

test('getClosingWarning checks closing time window accurately', () => {
  const dateStr = '2026-11-22';

  // 20:00 -> 60m left > 30m -> empty
  assert.equal(
    getClosingWarning({
      closingWarn: true,
      closingMinutes: 30,
      openTime: '10:00',
      closeTime: '21:00',
      dateStr,
      nowMs: new Date('2026-11-22T20:00:00+08:00').getTime()
    }),
    ''
  );

  // 20:40 -> 20m left <= 30m -> warning
  const warnMsg = getClosingWarning({
    closingWarn: true,
    closingMinutes: 30,
    openTime: '10:00',
    closeTime: '21:00',
    dateStr,
    nowMs: new Date('2026-11-22T20:40:00+08:00').getTime()
  });
  assert.match(warnMsg, /還有 20 分鐘打烊（21:00）/);

  // 21:05 -> closed 5m ago -> already closed message
  const closedMsg = getClosingWarning({
    closingWarn: true,
    closingMinutes: 30,
    openTime: '10:00',
    closeTime: '21:00',
    dateStr,
    nowMs: new Date('2026-11-22T21:05:00+08:00').getTime()
  });
  assert.match(closedMsg, /已經打烊（21:00）/);

  // 22:05 -> >60m past close -> empty
  assert.equal(
    getClosingWarning({
      closingWarn: true,
      closingMinutes: 30,
      openTime: '10:00',
      closeTime: '21:00',
      dateStr,
      nowMs: new Date('2026-11-22T22:05:00+08:00').getTime()
    }),
    ''
  );

  // Disabled -> empty
  assert.equal(
    getClosingWarning({
      closingWarn: false,
      closingMinutes: 30,
      openTime: '10:00',
      closeTime: '21:00',
      dateStr,
      nowMs: new Date('2026-11-22T20:45:00+08:00').getTime()
    }),
    ''
  );

  // Overnight close time (e.g. 00:30 next day when openTime is 10:00)
  const lateMsg = getClosingWarning({
    closingWarn: true,
    closingMinutes: 30,
    openTime: '10:00',
    closeTime: '00:30',
    dateStr: '2026-12-31',
    nowMs: new Date('2027-01-01T00:15:00+08:00').getTime()
  });
  assert.match(lateMsg, /還有 15 分鐘打烊（00:30）/);
});

test('rotated floor map places entrance capsule inside room and here marker by fixture', () => {
  const demoPath = path.resolve(__dirname, './fixtures/floor-demo.json');
  const demoFloor = JSON.parse(fs.readFileSync(demoPath, 'utf8'));

  // Test across 0, 90, 180, 270
  for (const deg of [0, 90, 180, 270]) {
    const data = computeDisplayMapData({
      floor: demoFloor,
      rotation: deg,
      hereElement: 'fixture:櫃檯'
    });
    assert.ok(data.doorTag, `doorTag present at ${deg}°`);
    assert.ok(data.hereTag, `hereTag present at ${deg}°`);

    // Entrance capsule must be inside the room (strictly inside [0, roomW] x [0, roomH])
    assert.ok(data.doorTag.cx > 0 && data.doorTag.cx < data.roomW, `entrance cx inside room at ${deg}°`);
    assert.ok(data.doorTag.cy > 0 && data.doorTag.cy < data.roomH, `entrance cy inside room at ${deg}°`);

    // At 90°, bottom door moves to left edge, so doorTag must be to the right of doorPt
    if (deg === 90) {
      assert.ok(data.doorTag.cx > data.doorPt[0], 'at 90°, entrance tag pushed right into room');
    }
    if (deg === 270) {
      assert.ok(data.doorTag.cx < data.doorPt[0], 'at 270°, entrance tag pushed left into room');
    }
    if (deg === 0) {
      assert.ok(data.doorTag.cy < data.doorPt[1], 'at 0°, entrance tag pushed up into room');
    }
    if (deg === 180) {
      assert.ok(data.doorTag.cy > data.doorPt[1], 'at 180°, entrance tag pushed down into room');
    }
  }

  // Empty hereElement -> no hereTag
  const noHere = computeDisplayMapData({
    floor: demoFloor,
    rotation: 90,
    hereElement: ''
  });
  assert.equal(noHere.hereTag, null);
  assert.equal(findHereShape(demoFloor.shapes, '不存在設施'), null);
});

test('computeBurnInShift and msUntilNextTaipei0400', () => {
  const offShift = computeBurnInShift(1700000000000, 3, true);
  assert.deepEqual(offShift, { dx: 0, dy: 0 });

  const onShift = computeBurnInShift(1700000000000, 3, false);
  const dist = Math.hypot(onShift.dx, onShift.dy);
  assert.ok(dist >= 1 && dist <= 8, `shift distance ${dist} should be 1..8px`);

  // Before 04:00 Taipei -> waits until today 04:00
  const at0330 = new Date('2026-11-22T03:30:00+08:00').getTime();
  assert.equal(msUntilNextTaipei0400(at0330), 30 * 60 * 1000);

  // After 04:00 Taipei -> waits until tomorrow 04:00
  const at0430 = new Date('2026-11-22T04:30:00+08:00').getTime();
  assert.equal(msUntilNextTaipei0400(at0430), 23.5 * 3600 * 1000);
});
