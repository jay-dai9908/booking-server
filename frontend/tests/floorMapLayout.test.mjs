// frontend/tests/floorMapLayout.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { wrap, rotateFloorMap, computeFloorLayout, bbox } from '../../shared/floorMapLayout.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

test('wrap balances characters and respects manual newlines', () => {
  // 「燙豆區」每行最多 2 個字 -> 兩行，且平均為 ['燙豆', '區']
  const wrapped = wrap('燙豆區', 2);
  assert.deepEqual(wrapped, ['燙豆', '區']);

  // 手動換行優先
  const manual = wrap('沙發\n休息區', 2);
  assert.deepEqual(manual, ['沙發', '休息區']);

  // 4 個字每行最多 2 個 -> ['櫃檯', '服務']
  const wrapped4 = wrap('櫃檯服務', 2);
  assert.deepEqual(wrapped4, ['櫃檯', '服務']);
});

test('rotateFloorMap rotates door and shapes when rotation is 90', () => {
  const map = {
    w: 720,
    h: 1167,
    rotation: 90,
    door: [375, 1160],
    shapes: [
      {
        kind: 'door',
        pts: [[330, 1153], [420, 1153], [420, 1167], [330, 1167]]
      }
    ],
    tables: [],
    seats: []
  };

  const rotated = rotateFloorMap(map);
  assert.equal(rotated.w, 1167);
  assert.equal(rotated.h, 720);
  assert.equal(rotated.rotation, 0);

  // 原 door 在底部 (y = 1160)，90度順時針旋轉後，x' = h - y = 1167 - 1160 = 7, y' = x = 375
  assert.equal(rotated.door[0], 7);
  assert.equal(rotated.door[1], 375);
  // 入口轉到了左側（x 靠近 0），旋轉方向正確
  assert.ok(rotated.door[0] < 50);
});

test('computeFloorLayout with floor-demo.json places labels without overlapping tables or each other', () => {
  const demoPath = path.resolve(__dirname, '../../kiosk-handoff-web/1-shared/floor-demo.json');
  const demoFloor = JSON.parse(fs.readFileSync(demoPath, 'utf8'));

  // 每個字寬當成 13
  const measureText = (text) => [...text].length * 13;

  const result = computeFloorLayout({
    floor: demoFloor,
    seatCodes: ['A3-2'],
    containerWidth: 375,
    measureText
  });

  const { placedLabels } = result;

  // 「拼豆牆」的標籤在色塊外面 (placement === 'outside')
  const beadsLabel = placedLabels.find(l => l.shape.label === '拼豆牆');
  assert.ok(beadsLabel, '拼豆牆標籤應被放置');
  assert.equal(beadsLabel.placement, 'outside', '「拼豆牆」的標籤應在色塊外面');

  // 算出來的標籤彼此不重疊，也不和任何桌子重疊
  const labelBoxes = placedLabels
    .filter(l => l.placement === 'outside' && l.box)
    .map(l => l.box);

  const tableBoxes = (demoFloor.tables || []).map(t => bbox(t.pts));

  // 檢驗標籤與桌子之間沒有重疊
  for (const lb of labelBoxes) {
    for (const tb of tableBoxes) {
      const xOverlap = Math.max(0, Math.min(lb.x2, tb.x2) - Math.max(lb.x1, tb.x1));
      const yOverlap = Math.max(0, Math.min(lb.y2, tb.y2) - Math.max(lb.y1, tb.y1));
      const overlapArea = xOverlap * yOverlap;
      assert.equal(overlapArea, 0, `標籤不應與桌子重疊 (xOverlap: ${xOverlap}, yOverlap: ${yOverlap})`);
    }
  }

  // 檢驗外部標籤彼此之間沒有重疊
  for (let i = 0; i < labelBoxes.length; i++) {
    for (let j = i + 1; j < labelBoxes.length; j++) {
      const b1 = labelBoxes[i];
      const b2 = labelBoxes[j];
      const xOverlap = Math.max(0, Math.min(b1.x2, b2.x2) - Math.max(b1.x1, b2.x1));
      const yOverlap = Math.max(0, Math.min(b1.y2, b2.y2) - Math.max(b1.y1, b2.y1));
      const overlapArea = xOverlap * yOverlap;
      assert.equal(overlapArea, 0, '外部標籤彼此不應重疊');
    }
  }
});
