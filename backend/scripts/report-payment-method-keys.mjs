// Read-only diagnostic script for Payment.method keys vs GlobalSetting.payment_methods_json
// Usage: node backend/scripts/report-payment-method-keys.mjs
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import prisma from '../src/prismaClient.js';
import { normalizeMethodKey, methodLabel } from '../../shared/paymentMethods.js';
import { getConfiguredPaymentMethods } from '../src/services/accounting/methodAggregation.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env') });

export async function generatePaymentMethodKeyReport(client = prisma) {
  const configuredMethods = await getConfiguredPaymentMethods(client);
  const normToConfig = new Map(configuredMethods.map((m) => [normalizeMethodKey(m.key), m]));

  const groups = await client.payment.groupBy({
    by: ['method'],
    _count: { _all: true },
    _sum: { amount: true },
    orderBy: { method: 'asc' }
  });

  return groups.map((g) => {
    const rawKey = g.method;
    const norm = normalizeMethodKey(rawKey);
    const matched = normToConfig.get(norm);
    const mappedKey = rawKey === 'pass' ? 'pass' : (matched?.key || norm || rawKey);
    return {
      raw_method: rawKey,
      count: g._count?._all || 0,
      amount: g._sum?.amount || 0,
      mapped_key: mappedKey,
      mapped_label: methodLabel(mappedKey, configuredMethods),
      in_config: Boolean(matched)
    };
  });
}

async function main() {
  const rows = await generatePaymentMethodKeyReport(prisma);
  if (rows.length === 0) {
    console.log('Payment 資料表目前無任何收款紀錄。');
  } else {
    console.log('raw_method\tcount\tamount\tmapped_key\tmapped_label\tin_config');
    for (const r of rows) {
      console.log(`${r.raw_method}\t${r.count}\t${r.amount}\t${r.raw_method} → ${r.mapped_key}\t${r.mapped_label}\t${r.in_config ? 'yes' : 'no'}`);
    }
  }
  await prisma.$disconnect();
}

const isEntrypoint = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntrypoint) {
  main().catch(async (err) => {
    console.error('[report-payment-method-keys] Error:', err);
    await prisma.$disconnect().catch(() => {});
    process.exit(1);
  });
}
