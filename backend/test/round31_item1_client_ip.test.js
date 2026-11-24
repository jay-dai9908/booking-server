import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import { createTestApp } from './helpers/testServer.js';
import { getClientIp } from '../src/utils/deviceParser.js';
import { resolveTrustProxy } from '../src/utils/trustProxy.js';

function startIpTestApp(trustProxy) {
  const app = createTestApp();
  app.set('trust proxy', trustProxy);
  app.get('/__test-client-ip', (req, res) => {
    res.json({ ip: getClientIp(req, { publicIp: '198.51.100.6' }) });
  });

  const server = http.createServer(app);
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', (err) => {
      if (err) return reject(err);
      const port = server.address().port;
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        close: () => new Promise((res) => server.close(res))
      });
    });
  });
}

test('Round 31 Item 1: resolveTrustProxy defaults to loopback and parses false/numbers/CIDR', () => {
  assert.equal(resolveTrustProxy(undefined), 'loopback');
  assert.equal(resolveTrustProxy(''), 'loopback');
  assert.equal(resolveTrustProxy('loopback'), 'loopback');
  assert.equal(resolveTrustProxy('false'), false);
  assert.equal(resolveTrustProxy('FALSE'), false);
  assert.equal(resolveTrustProxy('1'), 1);
  assert.equal(resolveTrustProxy('10.0.0.1, 172.16.0.0/12'), '10.0.0.1, 172.16.0.0/12');
});

test('Round 31 Item 1: getClientIp uses req.ip strictly and ignores ?ip=, X-Real-IP, CF-Connecting-IP, clientInfo.publicIp', async (t) => {
  const srvLoopback = await startIpTestApp(resolveTrustProxy(undefined));
  t.after(() => srvLoopback.close());

  // 1. trust proxy = 'loopback' from 127.0.0.1 with X-Forwarded-For -> 203.0.113.9
  const resXff = await fetch(`${srvLoopback.baseUrl}/__test-client-ip`, {
    headers: {
      'X-Forwarded-For': '203.0.113.9'
    }
  });
  assert.equal(resXff.status, 200);
  assert.equal((await resXff.json()).ip, '203.0.113.9');

  // 2. Spoofed ?ip=, X-Real-IP, CF-Connecting-IP, clientInfo.publicIp must ALL be ignored
  const resSpoof = await fetch(`${srvLoopback.baseUrl}/__test-client-ip?ip=198.51.100.7`, {
    headers: {
      'X-Real-IP': '198.51.100.8',
      'CF-Connecting-IP': '198.51.100.9',
      'True-Client-IP': '198.51.100.10'
    }
  });
  assert.equal(resSpoof.status, 200);
  const spoofIp = (await resSpoof.json()).ip;
  assert.equal(spoofIp, '127.0.0.1');
  assert.equal(['198.51.100.6', '198.51.100.7', '198.51.100.8', '198.51.100.9', '198.51.100.10'].includes(spoofIp), false);

  // 3. trust proxy = false -> even X-Forwarded-For is ignored, returns 127.0.0.1
  const srvFalse = await startIpTestApp(resolveTrustProxy('false'));
  t.after(() => srvFalse.close());

  const resFalse = await fetch(`${srvFalse.baseUrl}/__test-client-ip?ip=198.51.100.7`, {
    headers: {
      'X-Forwarded-For': '203.0.113.9',
      'X-Real-IP': '198.51.100.8',
      'CF-Connecting-IP': '198.51.100.9'
    }
  });
  assert.equal(resFalse.status, 200);
  assert.equal((await resFalse.json()).ip, '127.0.0.1');
});
