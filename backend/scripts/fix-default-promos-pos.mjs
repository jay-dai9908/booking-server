import '../src/loadEnv.js';
import { pathToFileURL } from 'url';
import prisma from '../src/prismaClient.js';
import { DEFAULT_PROMO_CODES } from '../src/controllers/checkoutController.js';
import auditService from '../src/services/audit/auditService.js';

const COMPARE_FIELDS = [
  'name',
  'description',
  'discount_type',
  'discount_value',
  'max_discount_amount',
  'target_scope',
  'day_type_limit',
  'mode_limit',
  'channel',
  'min_pax',
  'min_hours',
  'min_amount',
  'max_uses',
  'max_uses_per_user'
];

export async function runFixDefaultPromosPos({ apply = false, client = prisma } = {}) {
  const results = [];

  for (const def of DEFAULT_PROMO_CODES) {
    const legacyDefault = {
      ...def,
      channel: 'all',
      max_uses: null,
      max_uses_per_user: null
    };

    const row = await client.promoCode.findUnique({ where: { code: def.code } });
    if (!row) {
      results.push({ code: def.code, status: 'missing', label: '不存在', changed: false });
      continue;
    }

    if (row.channel === 'pos') {
      results.push({ code: def.code, status: 'already_pos', label: '已經是 pos（不動）', changed: false });
      continue;
    }

    const diffs = [];
    for (const field of COMPARE_FIELDS) {
      const actual = row[field] ?? null;
      const expected = legacyDefault[field] ?? null;
      if (actual !== expected) {
        diffs.push(field);
      }
    }

    if (diffs.length > 0) {
      results.push({
        code: def.code,
        status: 'modified',
        label: `已被店主改過（不動，差異欄位：${diffs.join(', ')}）`,
        diffs,
        changed: false
      });
      continue;
    }

    if (apply) {
      await client.$transaction(async (tx) => {
        await tx.promoCode.update({
          where: { code: def.code },
          data: { channel: 'pos' }
        });
        await auditService.log(tx, {
          event_type: 'promo_channel_changed',
          category: 'setting',
          summary: `將預設優惠碼 ${def.code} 的適用管道從 all 改為 pos`,
          before_json: { code: def.code, channel: 'all' },
          after_json: { code: def.code, channel: 'pos' },
          staff_name: '伺服器腳本',
          device_label: 'cli'
        });
      });
      results.push({
        code: def.code,
        status: 'updated',
        label: '仍是預設值 -> 已改為 channel: pos',
        changed: true
      });
    } else {
      results.push({
        code: def.code,
        status: 'would_update',
        label: '仍是預設值（dry-run：會改成 channel: pos）',
        changed: false
      });
    }
  }

  return results;
}

async function main() {
  const apply = process.argv.includes('--apply');
  console.log(`[fix-default-promos-pos] mode=${apply ? 'APPLY' : 'DRY-RUN'}`);
  try {
    const results = await runFixDefaultPromosPos({ apply, client: prisma });
    for (const r of results) {
      console.log(`- ${r.code}: ${r.label}`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error('[fix-default-promos-pos] Error:', err?.message || err);
    process.exit(1);
  });
}
