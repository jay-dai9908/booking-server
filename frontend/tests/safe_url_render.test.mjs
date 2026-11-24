import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { safeHttpUrl, isSafeHttpUrl } from '../../shared/safeUrl.js';

describe('safeHttpUrl frontend render sanitization (Round 32 Item 2)', () => {
  test('rejects javascript: and unsafe protocols with null', () => {
    assert.equal(safeHttpUrl('javascript:alert(1)'), null);
    assert.equal(safeHttpUrl('JavaScript:alert(document.cookie)'), null);
    assert.equal(safeHttpUrl(' javascript:void(0)'), null);
    assert.equal(safeHttpUrl('data:text/html,<script>alert(1)</script>'), null);
    assert.equal(safeHttpUrl('vbscript:msgbox(1)'), null);
    assert.equal(safeHttpUrl('//evil.example/path'), null);
    assert.equal(isSafeHttpUrl('javascript:alert(1)'), false);
  });

  test('preserves trimmed http/https URLs and supports fallback', () => {
    assert.equal(safeHttpUrl('https://lin.ee/vsZhRW5'), 'https://lin.ee/vsZhRW5');
    assert.equal(safeHttpUrl('  http://example.com/pay?a=1  '), 'http://example.com/pay?a=1');
    assert.equal(safeHttpUrl('javascript:alert(1)', 'https://lin.ee/vsZhRW5'), 'https://lin.ee/vsZhRW5');
  });
});
