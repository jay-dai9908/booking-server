import crypto from 'crypto';
import prisma from '../../prismaClient.js';
import { DEFAULT_PAYMENT_METHODS } from '../../controllers/dailySettingController.js';
import { buildTransferPayload, normalizePayload, parsePayload, maskTwqrPayload } from '../../../../shared/twqr.js';

export function resolveEnabledPaymentMethodsFromJson(rawJson) {
  const list = Array.isArray(rawJson) && rawJson.length > 0 ? rawJson : DEFAULT_PAYMENT_METHODS;
  const out = [];
  const seen = new Set();

  for (const m of list) {
    if (!m || typeof m !== 'object') continue;
    const key = String(m.key || m.code || '').trim();
    if (!key) continue;
    const lower = key.toLowerCase();
    if (lower === 'pass' || seen.has(lower)) continue;

    const isCash = lower === 'cash';
    const enabled = isCash ? true : Boolean(m.enabled);
    if (!enabled) continue;

    seen.add(lower);
    out.push({
      key,
      label: String(m.label || (isCash ? '現金' : key)).trim() || key
    });
  }

  if (!seen.has('cash')) {
    out.unshift({ key: 'cash', label: '現金' });
  }
  return out;
}

export async function getEnabledPaymentMethods(txOrPrisma = prisma) {
  const gs = await txOrPrisma.globalSetting.findUnique({
    where: { id: 1 },
    select: { payment_methods_json: true }
  });
  return resolveEnabledPaymentMethodsFromJson(gs?.payment_methods_json);
}

function hashShort(str) {
  if (!str) return '';
  return crypto.createHash('sha256').update(String(str)).digest('hex').slice(0, 16);
}

/**
 * Resolves TWQR metadata.
 * Note: For `GET /api/display/state` (public/display), NEVER expose account/bank/payload!
 * Only the `checkout` SSE event (when `method === 'transfer'`) receives `payload` when configured.
 */
export function resolveTwqrConfig(displaySetting) {
  const mode = displaySetting?.twqr_mode || 'acct';
  const useRawImage = Boolean(displaySetting?.twqr_use_raw_image);
  const rawImageData = displaySetting?.twqr_raw_image || '';
  const logoEnabled = displaySetting?.twqr_logo_enabled !== false;
  const customLogoData = displaySetting?.twqr_logo_image || '';

  let payload = '';
  if (mode === 'acct') {
    payload = buildTransferPayload(displaySetting?.twqr_bank_code || '', displaySetting?.twqr_account || '');
  } else if (displaySetting?.twqr_payload) {
    payload = normalizePayload(displaySetting.twqr_payload) || '';
  }

  const hasRawImage = useRawImage && Boolean(rawImageData);
  const hasTwqr = hasRawImage || Boolean(payload);

  const rawImageUrl = hasRawImage ? `/api/display/files/twqr-raw/${hashShort(rawImageData)}` : null;
  const logoUrl = customLogoData ? `/api/display/files/twqr-logo/${hashShort(customLogoData)}` : null;

  const parsed = payload ? parsePayload(payload) : null;

  return {
    mode,
    use_raw_image: useRawImage,
    has_raw_image: hasRawImage,
    has_twqr: hasTwqr,
    payload,
    payload_masked: payload ? maskTwqrPayload(payload) : '',
    parsed,
    raw_image_url: rawImageUrl,
    logo_enabled: logoEnabled,
    logo_url: logoUrl
  };
}
