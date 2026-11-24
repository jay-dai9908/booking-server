import test from 'node:test';
import assert from 'node:assert/strict';
import {
  base32Decode,
  base32Encode,
  buildOtpauthUri,
  decryptTotpSecret,
  encryptTotpSecret,
  generateBackupCodes,
  generateSecret,
  hashBackupCode,
  totpAt,
  verifyBackupCodeHash,
  verifyTotp
} from '../src/services/auth/totp.js';

test('Round 31 Item 3: RFC 6238 Appendix B SHA1 test vectors (last 6 digits)', () => {
  const asciiSecret = '12345678901234567890';
  const secretBase32 = base32Encode(Buffer.from(asciiSecret, 'ascii'));

  const vectors = [
    [59, '287082'],
    [1111111109, '081804'],
    [1111111111, '050471'],
    [1234567890, '005924'],
    [2000000000, '279037'],
    [20000000000, '353130']
  ];

  for (const [unixSec, expected] of vectors) {
    const step = Math.floor(unixSec / 30);
    assert.equal(totpAt(secretBase32, step), expected, `Failed RFC 6238 vector at T=${unixSec}`);
  }
});

test('Round 31 Item 3: Base32 round-trip, verifyTotp window + replay guard, and buildOtpauthUri', () => {
  const secret = generateSecret();
  assert.match(secret, /^[A-Z2-7]{32}$/);
  assert.equal(base32Encode(base32Decode(secret)), secret);

  const nowMs = 1700000010000;
  const currentStep = Math.floor(nowMs / 1000 / 30);
  const codePrev = totpAt(secret, currentStep - 1);
  const codeCur = totpAt(secret, currentStep);
  const codeNext = totpAt(secret, currentStep + 1);

  assert.deepEqual(verifyTotp(secret, codePrev, { nowMs }), { ok: true, step: currentStep - 1 });
  assert.deepEqual(verifyTotp(secret, codeCur, { nowMs }), { ok: true, step: currentStep });
  assert.deepEqual(verifyTotp(secret, codeNext, { nowMs }), { ok: true, step: currentStep + 1 });

  // Replay guard: lastStep >= matched step must fail
  assert.deepEqual(verifyTotp(secret, codeCur, { nowMs, lastStep: currentStep }), { ok: false, step: null });
  assert.deepEqual(verifyTotp(secret, codePrev, { nowMs, lastStep: currentStep }), { ok: false, step: null });
  assert.deepEqual(verifyTotp(secret, codeNext, { nowMs, lastStep: currentStep }), { ok: true, step: currentStep + 1 });

  // Non-6-digit strings rejected
  assert.deepEqual(verifyTotp(secret, '12345', { nowMs }), { ok: false, step: null });
  assert.deepEqual(verifyTotp(secret, 'abcdef', { nowMs }), { ok: false, step: null });

  const uri = buildOtpauthUri(secret);
  assert.ok(uri.startsWith('otpauth://totp/'));
  assert.ok(uri.includes(`secret=${secret}`));
  assert.ok(uri.includes('algorithm=SHA1&digits=6&period=30'));
});

test('Round 31 Item 3: AES-256-GCM sealing hides plaintext and detects tampering / wrong JWT_SECRET', () => {
  const jwtSecret = 'test-jwt-secret-at-least-32-chars-long-0001';
  const secret = generateSecret();
  const sealed = encryptTotpSecret(secret, jwtSecret);

  assert.ok(sealed.startsWith('v1:'));
  assert.equal(sealed.includes(secret), false);
  assert.equal(decryptTotpSecret(sealed, jwtSecret), secret);

  // Tamper 1 character in ciphertext section
  const parts = sealed.split(':');
  const lastChar = parts[3].slice(-1);
  parts[3] = parts[3].slice(0, -1) + (lastChar === 'A' ? 'B' : 'A');
  const tampered = parts.join(':');
  assert.throws(() => decryptTotpSecret(tampered, jwtSecret));

  // Wrong JWT_SECRET fails
  assert.throws(() => decryptTotpSecret(sealed, 'different-jwt-secret-at-least-32-chars-0002'));
});

test('Round 31 Item 3: backup code generation, normalization, and HMAC-SHA256 verification', () => {
  const jwtSecret = 'test-jwt-secret-at-least-32-chars-long-0001';
  const codes = generateBackupCodes(8);
  assert.equal(codes.length, 8);
  for (const c of codes) {
    assert.match(c, /^[A-HJ-KM-NP-Z2-9]{5}-[A-HJ-KM-NP-Z2-9]{5}$/);
  }

  const hash = hashBackupCode(codes[0], jwtSecret);
  assert.equal(hash.includes(codes[0]), false);
  assert.equal(verifyBackupCodeHash(codes[0], hash, jwtSecret), true);
  assert.equal(verifyBackupCodeHash(codes[0].replace('-', '').toLowerCase(), hash, jwtSecret), true);
  assert.equal(verifyBackupCodeHash('WRONG-CODES', hash, jwtSecret), false);
});
