import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import fs from 'fs';
import { fileURLToPath } from 'url';
import prisma from '../src/prismaClient.js';
import {
  deriveKeys,
  sealRequest,
  openRequest,
  sealResponse,
  openResponse,
  qrKeyFrom,
  entryCodeOf,
  bookingRefPrefix,
  qrCodeFor,
  parseQr,
  verifyQrMac,
  parsePairing,
  wrapPairKey,
  unwrapPairKey
} from '../src/services/kiosk/sgk1.js';
import { createKioskEnvelope, resetKioskEnvelopeStateForTest } from '../src/middlewares/kioskEnvelope.js';

const vectorsPath = fileURLToPath(new URL('../../docs/kiosk-vectors.json', import.meta.url));
const VECTORS = JSON.parse(fs.readFileSync(vectorsPath, 'utf8'));

function createMockRes() {
  return {
    statusCode: 200,
    body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; }
  };
}

function makeReq(body, ip = '10.0.0.10') {
  return {
    body,
    ip,
    headers: { 'x-forwarded-for': ip },
    socket: { remoteAddress: ip }
  };
}

test('Round 26 Item 1: SGK1 vectors match protocol specification identically', () => {
  const e = VECTORS.envelope;
  const keys = deriveKeys(Buffer.from(e.K_hex, 'hex'));
  assert.equal(keys.req.toString('hex'), e.k_req_hex);
  assert.equal(keys.res.toString('hex'), e.k_res_hex);

  const reqPlain = JSON.parse(e.request.plaintext);
  const sealedReq = sealRequest(keys, e.device_id, e.op, reqPlain.body, {
    rid: reqPlain.rid,
    ts: reqPlain.ts,
    nonce: Buffer.from(e.request.nonce_hex, 'hex')
  });
  assert.deepEqual(sealedReq.httpBody, e.request.http_body);
  assert.deepEqual(openRequest(keys, e.op, e.request.http_body), reqPlain);

  const resPlain = JSON.parse(e.response.plaintext);
  const sealedRes = sealResponse(keys, e.device_id, e.op, resPlain.rid, resPlain, {
    ts: resPlain.ts,
    nonce: Buffer.from(e.response.nonce_hex, 'hex')
  });
  assert.deepEqual(sealedRes, e.response.http_body);
  assert.deepEqual(openResponse(keys, e.device_id, e.op, resPlain.rid, e.response.http_body), resPlain);

  const q = VECTORS.qr;
  const qk = qrKeyFrom(q.jwt_secret);
  assert.equal(qk.toString('hex'), q.qr_key_hex);
  assert.equal(qrCodeFor(qk, q.booking_ref, q.unix).code, q.code);
  const parsed = parseQr(q.code);
  assert.equal(bookingRefPrefix(parsed.entry), q.booking_ref.slice(0, 11));
  assert.equal(verifyQrMac(qk, q.booking_ref, parsed.mac, q.unix), 'ok');
  assert.equal(verifyQrMac(qk, q.booking_ref, parseQr(q.prev_window_code).mac, q.unix), 'ok');
  assert.equal(verifyQrMac(qk, q.booking_ref, parsed.mac, q.unix + 600), 'expired');

  const pr = parsePairing(VECTORS.pairing_qr);
  assert.equal(pr.deviceId, e.device_id);
  assert.equal(pr.pairKey.toString('hex'), e.K_hex);
  assert.equal(entryCodeOf(q.booking_ref), '3F2A9C1E7B');
});

test('Round 26 Item 1: kioskEnvelope auth, bit-flip, wrong op, clock skew, replay, disabled device, rate limit, and key wrapping', async () => {
  const pairKey = crypto.randomBytes(32);
  const keys = deriveKeys(pairKey);
  const jwtSecret = process.env.JWT_SECRET;
  const keyWrapped = wrapPairKey(pairKey, jwtSecret);

  assert.notEqual(keyWrapped, pairKey.toString('hex'));
  assert.notEqual(keyWrapped, pairKey.toString('base64url'));
  assert.notEqual(keyWrapped, pairKey.toString('base64'));
  assert.deepEqual(unwrapPairKey(keyWrapped, jwtSecret), pairKey);
  assert.throws(() => unwrapPairKey(keyWrapped, 'different-secret-that-breaks-wrapping-1234'));

  let device = null;
  try {
    resetKioskEnvelopeStateForTest();
    device = await prisma.kioskDevice.create({
      data: {
        name: 'R26 測試報到機',
        key_wrapped: keyWrapped,
        is_active: true,
        paired_at: new Date()
      }
    });

    const fixedNowSec = 1794700000;
    const getNow = () => fixedNowSec * 1000;

    // 1. Valid request succeeds
    {
      let nextCalled = 0;
      const mw = createKioskEnvelope('access', { getNow });
      const sealed = sealRequest(keys, device.id, 'access', { method: 'phone', payload: '0912345678' }, { ts: fixedNowSec });
      const res = createMockRes();
      const req = makeReq(sealed.httpBody);
      await mw(req, res, () => {
        nextCalled++;
        res.kioskReply({ ok: true, code: 'OK', body: { accepted: true, dev: req.kiosk.device.id } });
      });
      assert.equal(nextCalled, 1);
      assert.equal(res.statusCode, 200);
      const reply = openResponse(keys, device.id, 'access', sealed.rid, res.body);
      assert.equal(reply.ok, true);
      assert.equal(reply.code, 'OK');
      assert.deepEqual(reply.body, { accepted: true, dev: device.id });
    }

    // 2. Wrong key -> 401 KIOSK_AUTH
    {
      let nextCalled = 0;
      const badKeys = deriveKeys(crypto.randomBytes(32));
      const mw = createKioskEnvelope('access', { getNow });
      const sealed = sealRequest(badKeys, device.id, 'access', {}, { ts: fixedNowSec });
      const res = createMockRes();
      await mw(makeReq(sealed.httpBody, '10.0.0.11'), res, () => { nextCalled++; });
      assert.equal(nextCalled, 0);
      assert.equal(res.statusCode, 401);
      assert.deepEqual(res.body, { error: 'KIOSK_AUTH' });
    }

    // 3. Ciphertext modified by 1 bit -> 401 KIOSK_AUTH
    {
      let nextCalled = 0;
      const mw = createKioskEnvelope('access', { getNow });
      const sealed = sealRequest(keys, device.id, 'access', { hello: 'world' }, { ts: fixedNowSec });
      const buf = Buffer.from(sealed.httpBody.c, 'base64');
      buf[0] ^= 0x01;
      const tampered = { ...sealed.httpBody, c: buf.toString('base64') };
      const res = createMockRes();
      await mw(makeReq(tampered, '10.0.0.12'), res, () => { nextCalled++; });
      assert.equal(nextCalled, 0);
      assert.equal(res.statusCode, 401);
      assert.deepEqual(res.body, { error: 'KIOSK_AUTH' });
    }

    // 4. Send sync envelope to access endpoint -> 401 KIOSK_AUTH
    {
      let nextCalled = 0;
      const mwAccess = createKioskEnvelope('access', { getNow });
      const syncSealed = sealRequest(keys, device.id, 'sync', { fw: '0.2.0' }, { ts: fixedNowSec });
      const res = createMockRes();
      await mwAccess(makeReq(syncSealed.httpBody, '10.0.0.13'), res, () => { nextCalled++; });
      assert.equal(nextCalled, 0);
      assert.equal(res.statusCode, 401);
      assert.deepEqual(res.body, { error: 'KIOSK_AUTH' });
    }

    // 5. Clock skew of 121 seconds -> encrypted CLOCK_SKEW, handler not called
    {
      let nextCalled = 0;
      const mw = createKioskEnvelope('sync', { getNow });
      const skewSealed = sealRequest(keys, device.id, 'sync', {}, { ts: fixedNowSec - 121 });
      const res = createMockRes();
      await mw(makeReq(skewSealed.httpBody), res, () => { nextCalled++; });
      assert.equal(nextCalled, 0);
      assert.equal(res.statusCode, 200);
      const reply = openResponse(keys, device.id, 'sync', skewSealed.rid, res.body);
      assert.equal(reply.ok, false);
      assert.equal(reply.code, 'CLOCK_SKEW');
      assert.equal(reply.ts, fixedNowSec);
    }

    // 6. Replay same request twice -> 1st OK, 2nd encrypted REPLAY without calling handler
    {
      let nextCalled = 0;
      const mw = createKioskEnvelope('sync', { getNow });
      const sealed = sealRequest(keys, device.id, 'sync', { step: 1 }, { ts: fixedNowSec });
      const res1 = createMockRes();
      const res2 = createMockRes();
      await mw(makeReq(sealed.httpBody), res1, () => {
        nextCalled++;
        res1.kioskReply({ ok: true, code: 'OK', body: { n: 1 } });
      });
      await mw(makeReq(sealed.httpBody), res2, () => {
        nextCalled++;
        res2.kioskReply({ ok: true, code: 'OK', body: { n: 2 } });
      });
      assert.equal(nextCalled, 1);
      assert.equal(openResponse(keys, device.id, 'sync', sealed.rid, res1.body).code, 'OK');
      const reply2 = openResponse(keys, device.id, 'sync', sealed.rid, res2.body);
      assert.equal(reply2.ok, false);
      assert.equal(reply2.code, 'REPLAY');
    }

    // 7. Disabled device -> 401 KIOSK_AUTH
    {
      await prisma.kioskDevice.update({ where: { id: device.id }, data: { is_active: false } });
      let nextCalled = 0;
      const mw = createKioskEnvelope('sync', { getNow });
      const sealed = sealRequest(keys, device.id, 'sync', {}, { ts: fixedNowSec });
      const res = createMockRes();
      await mw(makeReq(sealed.httpBody, '10.0.0.14'), res, () => { nextCalled++; });
      assert.equal(nextCalled, 0);
      assert.equal(res.statusCode, 401);
      assert.deepEqual(res.body, { error: 'KIOSK_AUTH' });
      await prisma.kioskDevice.update({ where: { id: device.id }, data: { is_active: true } });
    }

    // 8. 10 failed auth attempts from same IP -> 11th returns 429
    {
      resetKioskEnvelopeStateForTest();
      const mw = createKioskEnvelope('sync', { getNow });
      const badIp = '10.0.0.99';
      for (let i = 0; i < 10; i++) {
        const res = createMockRes();
        await mw(makeReq({ v: 1, d: device.id, n: 'bad', c: 'bad' }, badIp), res, () => {});
        assert.equal(res.statusCode, 401);
      }
      const blockedRes = createMockRes();
      await mw(makeReq({ v: 1, d: device.id, n: 'bad', c: 'bad' }, badIp), blockedRes, () => {});
      assert.equal(blockedRes.statusCode, 429);
    }

    // 9. Device > 60 requests in 1 minute -> 61st returns 429
    {
      resetKioskEnvelopeStateForTest();
      const mw = createKioskEnvelope('sync', { getNow });
      for (let i = 0; i < 60; i++) {
        const sealed = sealRequest(keys, device.id, 'sync', { i }, { ts: fixedNowSec });
        const res = createMockRes();
        await mw(makeReq(sealed.httpBody, '10.0.0.20'), res, () => {
          res.kioskReply({ ok: true, code: 'OK', body: {} });
        });
        assert.equal(res.statusCode, 200);
      }
      const sealed61 = sealRequest(keys, device.id, 'sync', { i: 61 }, { ts: fixedNowSec });
      const res61 = createMockRes();
      await mw(makeReq(sealed61.httpBody, '10.0.0.20'), res61, () => {});
      assert.equal(res61.statusCode, 429);
    }
  } finally {
    resetKioskEnvelopeStateForTest();
    if (device?.id) {
      await prisma.kioskDevice.deleteMany({ where: { id: device.id } });
    }
  }
});
