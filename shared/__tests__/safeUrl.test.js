import test from 'node:test';
import assert from 'node:assert/strict';
import { isSafeHttpUrl, safeHttpUrl } from '../safeUrl.js';

test('Round 32 Item 2: isSafeHttpUrl & safeHttpUrl validate http(s) URLs and reject dangerous schemes', () => {
  assert.equal(isSafeHttpUrl('https://lin.ee/abc'), true);
  assert.equal(isSafeHttpUrl('http://example.com/x?y=1'), true);
  assert.equal(isSafeHttpUrl('  https://lin.ee/abc  '), true);
  assert.equal(safeHttpUrl('  https://lin.ee/abc  '), 'https://lin.ee/abc');

  const unsafe = [
    'javascript:alert(1)',
    'JavaScript:alert(1)',
    ' javascript:alert(1)',
    'data:text/html,x',
    'vbscript:x',
    '//example.com',
    'example.com',
    '',
    '   ',
    null,
    undefined,
    { url: 'https://lin.ee/abc' },
    ['https://lin.ee/abc']
  ];

  for (const val of unsafe) {
    assert.equal(isSafeHttpUrl(val), false, `Expected isSafeHttpUrl(${JSON.stringify(val)}) to be false`);
    assert.equal(safeHttpUrl(val), null, `Expected safeHttpUrl(${JSON.stringify(val)}) to be null`);
    assert.equal(safeHttpUrl(val, 'https://fallback.example'), 'https://fallback.example');
  }
});
