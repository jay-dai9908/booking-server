import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeMethodKey, methodLabel } from '../paymentMethods.js';

test('Round 43 Item 5: normalizeMethodKey normalizes case, whitespace, hyphens, and underscores', () => {
  assert.equal(normalizeMethodKey('line_pay'), 'linepay');
  assert.equal(normalizeMethodKey('LinePay'), 'linepay');
  assert.equal(normalizeMethodKey('line-pay'), 'linepay');
  assert.equal(normalizeMethodKey('  custom_1  '), 'custom1');
});

test('Round 43 Item 5: methodLabel resolves configured label, falls back to built-in map, then raw key', () => {
  assert.equal(methodLabel('line_pay', [{ key: 'linepay', label: 'LINE Pay' }]), 'LINE Pay');
  assert.equal(methodLabel('custom_1', [{ key: 'custom_1', label: '街口' }]), '街口');
  assert.equal(methodLabel('custom_1', [{ key: 'custom_1', label: '街口支付' }]), '街口支付');
  assert.equal(methodLabel('cash', []), '現金');
  assert.equal(methodLabel('unknown', []), 'unknown');
});
