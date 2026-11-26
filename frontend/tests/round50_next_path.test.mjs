import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { safeNextPath } from '../src/utils/customer/nextPath.js';

describe('Round 50 Item 1: safeNextPath validation', () => {
  test('accepts safe relative paths with query strings', () => {
    assert.equal(safeNextPath('/history?tab=orders'), '/history?tab=orders');
    assert.equal(safeNextPath('/booking?step=1'), '/booking?step=1');
  });

  test('rejects protocol-relative, external URLs, backslashes, JS URIs, and empty values', () => {
    assert.equal(safeNextPath('//evil.example'), null);
    assert.equal(safeNextPath('https://evil.example'), null);
    assert.equal(safeNextPath('/\\evil'), null);
    assert.equal(safeNextPath('javascript:alert(1)'), null);
    assert.equal(safeNextPath(''), null);
    assert.equal(safeNextPath(null), null);
  });
});
