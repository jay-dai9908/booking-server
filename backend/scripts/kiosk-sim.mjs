#!/usr/bin/env node
// 模擬報到機（用戶端）：對任何照協定實作的伺服器送 sync／access。
// 用法：node backend/scripts/kiosk-sim.mjs "<配對字串>" sync
//       node backend/scripts/kiosk-sim.mjs "<配對字串>" phone 0912345678
//       node backend/scripts/kiosk-sim.mjs "<配對字串>" qr SG1-XXXXXXXXXX-XXXXXXXX
//       node backend/scripts/kiosk-sim.mjs "<配對字串>" replay
import * as S from '../src/services/kiosk/sgk1.js';

const [, , pairing, cmd, value] = process.argv;
const p = S.parsePairing(pairing || '');
if (!p || !cmd) {
  console.error('用法：node backend/scripts/kiosk-sim.mjs "<配對字串>" <sync|phone|qr|replay> [payload]');
  process.exit(2);
}

const keys = S.deriveKeys(p.pairKey);
let clockOffset = 0;

async function call(op, body, fixed) {
  const sealed =
    fixed ||
    S.sealRequest(keys, p.deviceId, op, body, {
      ts: Math.floor(Date.now() / 1000) + clockOffset
    });
  const r = await fetch(`${p.baseUrl}/api/kiosk/v1/${op}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(sealed.httpBody)
  });
  if (r.status !== 200) {
    return { http: r.status, body: await r.text() };
  }
  const res = S.openResponse(keys, p.deviceId, op, sealed.rid, await r.json());
  if (res.code === 'CLOCK_SKEW' && !fixed) {
    clockOffset = res.ts - Math.floor(Date.now() / 1000);
    return call(op, body);
  }
  return res;
}

const status = {
  fw: 'sim',
  boot_id: 'simboot1',
  uptime_s: 1,
  reset_reason: 'poweron',
  heap_kb: 0,
  psram_kb: 0,
  rssi: -50,
  scanner_ok: true,
  have: {},
  events: []
};

let out;
if (cmd === 'sync') {
  out = await call('sync', status);
} else if (cmd === 'phone') {
  out = await call('access', { method: 'phone', payload: value });
} else if (cmd === 'qr') {
  out = await call('access', { method: 'qr', payload: value });
} else if (cmd === 'replay') {
  const s = S.sealRequest(keys, p.deviceId, 'sync', status);
  out = [await call('sync', null, s), await call('sync', null, s)];
} else {
  console.error(`不支援的指令：${cmd}`);
  process.exit(2);
}

console.log(JSON.stringify(out, null, 2));
