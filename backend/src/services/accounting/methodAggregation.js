// backend/src/services/accounting/methodAggregation.js
// 付款方式正規化分組與動態清單解析（第 44 輪第 2 項）

import prisma from '../../prismaClient.js';
import { normalizeMethodKey, methodLabel, RESERVED_PAYMENT_KEYS } from '../../../../shared/paymentMethods.js';

export const DEFAULT_ACCOUNTING_PAYMENT_METHODS = [
  { key: 'cash', label: '現金', enabled: true },
  { key: 'linepay', label: 'LINE Pay', enabled: true },
  { key: 'transfer', label: '銀行轉帳', enabled: true }
];

export async function getConfiguredPaymentMethods(txOrPrisma = prisma) {
  const gs = await txOrPrisma.globalSetting.findUnique({
    where: { id: 1 },
    select: { payment_methods_json: true }
  });
  const raw = Array.isArray(gs?.payment_methods_json) && gs.payment_methods_json.length > 0
    ? gs.payment_methods_json
    : DEFAULT_ACCOUNTING_PAYMENT_METHODS;

  const out = [];
  const seen = new Set();
  for (const m of raw) {
    if (!m || typeof m !== 'object') continue;
    const key = String(m.key || m.code || '').trim();
    const norm = normalizeMethodKey(key);
    if (!norm || RESERVED_PAYMENT_KEYS.has(norm) || seen.has(norm)) continue;
    seen.add(norm);
    const isCash = norm === 'cash';
    out.push({
      key,
      label: isCash ? '現金' : (String(m.label || key).trim() || key),
      enabled: isCash ? true : Boolean(m.enabled)
    });
  }
  if (!seen.has('cash')) {
    out.unshift({ key: 'cash', label: '現金', enabled: true });
  }
  return out;
}

/**
 * 依正規化代碼將收款與退款分組，對到 GlobalSetting.payment_methods_json 設定順序，清單外有金額者排在最後。
 */
export function buildMethodBreakdown(charges = [], refundsList = [], configuredMethods = []) {
  const normToConfig = new Map();
  for (const cm of configuredMethods) {
    normToConfig.set(normalizeMethodKey(cm.key), cm);
  }

  const resolveKey = (rawMethod) => {
    const raw = String(rawMethod || '').trim();
    const norm = normalizeMethodKey(raw);
    const matched = normToConfig.get(norm);
    if (matched) return matched.key;
    return norm || raw || 'other';
  };

  const byMethod = {};
  for (const p of charges) {
    const k = resolveKey(p.method);
    if (!byMethod[k]) byMethod[k] = { count: 0, amount: 0 };
    byMethod[k].count += 1;
    byMethod[k].amount += (p.amount || 0);
  }

  const refunds = {};
  for (const p of refundsList) {
    const k = resolveKey(p.method);
    if (!refunds[k]) refunds[k] = { count: 0, amount: 0 };
    refunds[k].count += 1;
    refunds[k].amount += (p.amount || 0);
  }

  const seenKeys = new Set();
  const methods = [];

  for (const cm of configuredMethods) {
    seenKeys.add(cm.key);
    const cStats = byMethod[cm.key] || { count: 0, amount: 0 };
    const rStats = refunds[cm.key] || { count: 0, amount: 0 };
    methods.push({
      key: cm.key,
      label: methodLabel(cm.key, configuredMethods),
      enabled: cm.enabled !== false,
      count: cStats.count,
      amount: cStats.amount,
      refund_count: rStats.count,
      refund_amount: rStats.amount,
      net_amount: cStats.amount - rStats.amount
    });
  }

  const extraKeys = new Set([...Object.keys(byMethod), ...Object.keys(refunds)]);
  for (const k of extraKeys) {
    if (seenKeys.has(k)) continue;
    const cStats = byMethod[k] || { count: 0, amount: 0 };
    const rStats = refunds[k] || { count: 0, amount: 0 };
    methods.push({
      key: k,
      label: methodLabel(k, configuredMethods),
      enabled: false,
      count: cStats.count,
      amount: cStats.amount,
      refund_count: rStats.count,
      refund_amount: rStats.amount,
      net_amount: cStats.amount - rStats.amount
    });
  }

  return { by_method: byMethod, refunds, methods };
}

/**
 * 查詢所有正規化後符合 targetMethod 的原始 Payment.method 值清單（供 SQL IN 篩選使用）
 */
export async function resolveRawMethodsMatchingFilter(client, targetMethod) {
  const norm = normalizeMethodKey(targetMethod);
  if (!norm) return [targetMethod];
  if (norm === 'pass') return ['pass'];

  const distinctRows = await client.payment.findMany({
    distinct: ['method'],
    select: { method: true }
  });
  const matches = distinctRows
    .map((r) => r.method)
    .filter((m) => normalizeMethodKey(m) === norm);

  if (!matches.includes(targetMethod)) {
    matches.push(targetMethod);
  }
  return matches;
}
