// shared/__tests__/twqr.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTransferPayload, normalizePayload, parsePayload, maskTwqrPayload } from '../twqr.js';

test('buildTransferPayload formats bank 822 and fake account 000123456789 accurately', () => {
  const expected = encodeURIComponent('TWQRP://個人轉帳/158/02/V1?D5=822&D6=0000000123456789&D10=901');
  assert.equal(buildTransferPayload('822', '000123456789'), expected);
  // Invalid bank or too-short account returns empty string
  assert.equal(buildTransferPayload('82', '000123456789'), '');
  assert.equal(buildTransferPayload('822', '12345'), '');
});

test('normalizePayload handles raw TWQRP://, encoded TWQRP%3A, and rejects https://', () => {
  const raw = 'TWQRP://個人轉帳/158/02/V1?D5=822&D6=0000000123456789&D10=901';
  const encoded = encodeURIComponent(raw);

  assert.equal(normalizePayload(raw), encoded);
  assert.equal(normalizePayload(encoded), encoded);
  assert.equal(normalizePayload('https://example.com/pay/123'), null);
  assert.equal(normalizePayload('not-a-twqr'), null);
  assert.equal(normalizePayload(''), null);
});

test('parsePayload extracts transaction type, bank code, and last 4 digits of account', () => {
  const encoded = buildTransferPayload('822', '000123456789');
  const parsed = parsePayload(encoded);
  assert.deepEqual(parsed, {
    name: '個人轉帳',
    country_code: '158',
    type: '02',
    version: 'V1',
    bank_code: '822',
    account: '0000000123456789',
    account_last4: '6789',
    currency: '901'
  });

  // Also works on unencoded raw string
  const rawParsed = parsePayload('TWQRP://個人轉帳/158/02/V1?D5=013&D6=0000999988887777&D10=901');
  assert.equal(rawParsed?.bank_code, '013');
  assert.equal(rawParsed?.account_last4, '7777');
  assert.equal(rawParsed?.type, '02');

  // Invalid input returns null
  assert.equal(parsePayload('https://example.com'), null);

  // Masking hides middle digits while keeping last 4
  const masked = maskTwqrPayload(encoded);
  assert.ok(!masked.includes('0000000123456789'));
  assert.ok(masked.includes('6789'));
});
