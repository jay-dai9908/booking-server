#!/usr/bin/env node
import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

function diffValue(path, a, b, out) {
  if (Object.is(a, b)) return;
  if (typeof a !== typeof b || a === null || b === null) {
    out.push(`${path}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
    return;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) {
      out.push(`${path}: array mismatch ${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
      return;
    }
    const maxLen = Math.max(a.length, b.length);
    if (a.length !== b.length) {
      out.push(`${path}.length: ${a.length} !== ${b.length}`);
    }
    for (let i = 0; i < maxLen; i++) {
      diffValue(`${path}[${i}]`, a[i], b[i], out);
    }
    return;
  }
  if (typeof a === 'object') {
    const keys = Array.from(new Set([...Object.keys(a), ...Object.keys(b)])).sort();
    for (const k of keys) {
      diffValue(`${path}.${k}`, a[k], b[k], out);
    }
    return;
  }
  out.push(`${path}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
}

export function compareSnapshots(beforeSnap, afterSnap) {
  const diffs = [];
  const beforeBookings = new Map((beforeSnap?.bookings || []).map((b) => [b.booking_ref, b]));
  const afterBookings = new Map((afterSnap?.bookings || []).map((b) => [b.booking_ref, b]));
  const allRefs = Array.from(new Set([...beforeBookings.keys(), ...afterBookings.keys()])).sort();
  for (const ref of allRefs) {
    diffValue(`booking[${ref}]`, beforeBookings.get(ref), afterBookings.get(ref), diffs);
  }

  const beforeMonths = new Map((beforeSnap?.months || []).map((m) => [m.month, m]));
  const afterMonths = new Map((afterSnap?.months || []).map((m) => [m.month, m]));
  const allMonths = Array.from(new Set([...beforeMonths.keys(), ...afterMonths.keys()])).sort();
  for (const ym of allMonths) {
    diffValue(`month[${ym}]`, beforeMonths.get(ym), afterMonths.get(ym), diffs);
  }

  return {
    identical: diffs.length === 0,
    diffs
  };
}

async function main() {
  const [, , beforePath, afterPath] = process.argv;
  if (!beforePath || !afterPath) {
    console.error('用法：node backend/scripts/compare-bill-snapshots.mjs <before.json> <after.json>');
    process.exit(2);
  }
  const [beforeRaw, afterRaw] = await Promise.all([
    fs.readFile(beforePath, 'utf8'),
    fs.readFile(afterPath, 'utf8')
  ]);
  const res = compareSnapshots(JSON.parse(beforeRaw), JSON.parse(afterRaw));
  if (res.identical) {
    console.log('完全相同');
    process.exit(0);
  }
  console.log(`發現 ${res.diffs.length} 處差異：`);
  for (const d of res.diffs) {
    console.log(`- ${d}`);
  }
  process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error('[compare-bill-snapshots] Failed:', err);
    process.exit(1);
  });
}
