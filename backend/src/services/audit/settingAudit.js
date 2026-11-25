import auditService from './auditService.js';

export const SETTING_FIELD_LABELS = {
  weekday_hourly_price: '平日每小時價格',
  weekday_unlimited_price: '平日不限時價格',
  weekend_hourly_price: '假日每小時價格',
  weekend_unlimited_price: '假日不限時價格',
  show_price_cards: '顯示價格說明卡',
  price_notice_text: '價格備註文字',
  show_announcement: '顯示頂部公告欄',
  announcement_text: '公告文字',
  show_line_button: '顯示官方 LINE 按鈕',
  line_button_url: '官方 LINE 按鈕連結',
  official_line_url: '官方 LINE 網址',
  require_line_login_every_time: '每次皆須 LINE 登入',
  enable_preview_page: '開放空位預覽頁',
  preview_disabled_text: '預覽關閉提示文字',
  allow_equipment_exceed_pax: '智能板可超過人數',
  show_equipment_live_stock: '顯示智能板即時庫存',
  equipment_discount_enabled: '智能板買送優惠開關',
  equipment_discount_buy_hours: '智能板一階買時數',
  equipment_discount_free_hours: '智能板一階送時數',
  equipment_discount_stackable: '智能板買送可疊加',
  equipment_discount2_enabled: '智能板二階買送開關',
  equipment_discount2_buy_hours: '智能板二階買時數',
  equipment_discount2_free_hours: '智能板二階送時數',
  line_messaging_token: 'LINE 推播金鑰',
  line_auto_notify_booking: 'LINE 自動通知預約',
  line_auto_notify_cancel: 'LINE 自動通知取消',
  show_shop_button: '顯示商城按鈕',
  shop_enabled: '商城總開關',
  business_hours_json: '預設營業時間',
  booking_note_chips: '預約備註快速選項',
  guest_line_hint_text: '訪客 LINE 提示文字',
  default_session_capacity: '預設時段人數上限',
  payment_methods_json: '現場付款方式',
  print_enabled: '啟用列印總開關',
  billing_grace_minutes: '超時寬限',
  billing_block_minutes: '計費單位',
  board_swap_grace_minutes: '換板寬限',
  early_leave_mode: '提早離開計費',
  default_split_mode: '預設分攤方式',
  cash_float_amount: '零用金',
  auto_print_receipt: '自動印收據',
  auto_print_summary: '自動印總表',
  receipt_footer_text: '收據頁尾',
};

const SECRET_SETTING_FIELDS = new Set(['line_messaging_token']);

function valuesEqual(a, b) {
  if (a === b) return true;
  if (a == null && b == null) return true;
  if (a instanceof Date || b instanceof Date) {
    const da = a ? new Date(a).getTime() : null;
    const db = b ? new Date(b).getTime() : null;
    return da === db;
  }
  if (typeof a === 'object' || typeof b === 'object') {
    return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  }
  return false;
}

/**
 * Compute changed fields between before and after objects.
 * Returns { beforeChanged, afterChanged, changedKeys }.
 */
export function diffFields(before = {}, after = {}, { secretFields = [] } = {}) {
  const secretSet = new Set(secretFields);
  const beforeChanged = {};
  const afterChanged = {};
  const changedKeys = [];

  if (!after || typeof after !== 'object') {
    return { beforeChanged, afterChanged, changedKeys };
  }

  for (const field of Object.keys(after)) {
    const nextVal = after[field];
    if (nextVal === undefined) continue;

    if (secretSet.has(field)) {
      const hadSecret = Boolean(before?.[field]);
      const nextStr = typeof nextVal === 'string' ? nextVal.trim() : '';
      const hasNext = Boolean(nextStr);
      if (!hadSecret && !hasNext) continue;
      if (typeof before?.[field] === 'string' && typeof nextVal === 'string' && before[field].trim() === nextStr) {
        continue;
      }
      beforeChanged[field] = hadSecret ? '已設定' : null;
      afterChanged[field] = hasNext ? '已更換' : '已清除';
      changedKeys.push(field);
      continue;
    }

    const prevVal = before ? before[field] : undefined;
    if (valuesEqual(prevVal, nextVal)) continue;

    beforeChanged[field] = prevVal ?? null;
    afterChanged[field] = nextVal ?? null;
    changedKeys.push(field);
  }

  return { beforeChanged, afterChanged, changedKeys };
}

/**
 * Mask bank account numbers down to last 4 digits before storing in audit logs.
 */
export function maskBankAccountsForAudit(accounts) {
  if (!Array.isArray(accounts)) return accounts ?? null;
  return accounts.map((acc) => {
    if (!acc || typeof acc !== 'object') return acc;
    const rawNum = acc.account_number != null ? String(acc.account_number).trim() : '';
    return {
      ...acc,
      account_number: rawNum ? `****${rawNum.slice(-4)}` : null
    };
  });
}

/**
 * Append a category='setting' audit log capturing only changed fields.
 * Sensitive token values are never recorded in before_json, after_json, or summary.
 */
export async function logSettingChange(tx, { before = {}, after = {}, staff = {}, scope = 'global', summaryPrefix = '' } = {}) {
  if (!after || typeof after !== 'object') return null;

  const normBefore = {
    ...(before || {}),
    ...(before?.line_messaging_token === undefined && before?.has_line_messaging_token
      ? { line_messaging_token: '__MASKED__' }
      : {})
  };

  const { beforeChanged, afterChanged, changedKeys } = diffFields(normBefore, after, {
    secretFields: Array.from(SECRET_SETTING_FIELDS)
  });

  const changedLabels = changedKeys.map((field) => {
    if (SECRET_SETTING_FIELDS.has(field)) {
      return `${SETTING_FIELD_LABELS[field] || field}（${afterChanged[field]}）`;
    }
    return SETTING_FIELD_LABELS[field] || field;
  });

  if (changedLabels.length === 0) return null;

  const prefix = summaryPrefix || (scope === 'global' ? '修改全店設定：' : '修改設定：');
  const summary = `${prefix}${changedLabels.join('、')}`.slice(0, 200);

  return await auditService.log(tx, {
    event_type: 'setting_changed',
    category: 'setting',
    target_type: scope === 'global' ? 'global_setting' : scope,
    target_ref: scope === 'global' ? '1' : null,
    summary,
    before_json: beforeChanged,
    after_json: afterChanged,
    staff_name: staff?.name || '管理員',
    staff_id: staff?.id || null,
    device_id: staff?.device_id || null,
    device_label: staff?.device_label || '後台'
  });
}
