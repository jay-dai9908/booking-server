export const MONEY_WRITE = ['accounting', 'reservations'];
export const COUPON_WRITE = ['coupons'];
export const PASS_GRANT = ['coupons'];
export const KIOSK_SETTINGS_WRITE = ['settings'];

export const GLOBAL_SETTING_FIELD_GROUPS = {
  sessions: [
    'weekday_hourly_price',
    'weekday_unlimited_price',
    'weekend_hourly_price',
    'weekend_unlimited_price',
    'show_price_cards',
    'price_notice_text',
    'show_announcement',
    'announcement_text',
  ],
  equipment: [
    'allow_equipment_exceed_pax',
    'show_equipment_live_stock',
    'equipment_discount_enabled',
    'equipment_discount_buy_hours',
    'equipment_discount_free_hours',
    'equipment_discount_stackable',
    'equipment_discount2_enabled',
    'equipment_discount2_buy_hours',
    'equipment_discount2_free_hours',
  ],
  settings: [
    'show_line_button',
    'line_button_url',
    'official_line_url',
    'store_phone',
    'store_address',
    'store_map_url',
    'store_hours_text',
    'cancel_policy_text',
    'privacy_notice_text',
    'line_messaging_token',
    'line_auto_notify_booking',
    'line_auto_notify_cancel',
    'require_line_login_every_time',
    'enable_preview_page',
    'preview_disabled_text',
    'show_shop_button',
    'shop_enabled',
    'payment_methods_json',
    'print_enabled',
    'cancel_pending_jobs',
    'cancel_unprinted_jobs',
    'business_hours_json',
    'default_session_capacity',
    'max_active_bookings_per_user',
    'max_pax_per_booking',
    'booking_note_chips',
    'guest_line_hint_text',
    'billing_grace_minutes',
    'billing_block_minutes',
    'board_swap_grace_minutes',
    'early_leave_mode',
    'default_split_mode',
    'cash_float_amount',
    'auto_print_receipt',
    'auto_print_summary',
    'receipt_footer_text',
  ],
};

export const PERMISSION_LABELS = {
  sessions: '營業時段設定',
  reservations: '預約訂單總覽',
  shop: '商品預購與對帳',
  members: '會員管理',
  weekly: '周營業狀況',
  seating: '帶位圖管理',
  accounting: '帳務管理',
  equipment: '智能板庫存管理',
  coupons: '卡券與優惠管理',
  settings: '系統全域設定',
};

/** Return the permission group ('sessions' | 'equipment' | 'settings') that owns a GlobalSetting field. */
export function findSettingGroupForField(field) {
  if (GLOBAL_SETTING_FIELD_GROUPS.sessions.includes(field)) return 'sessions';
  if (GLOBAL_SETTING_FIELD_GROUPS.equipment.includes(field)) return 'equipment';
  return 'settings';
}

/** Check whether an admin user object or permissions array satisfies a required permission or any-of list. */
export function canAdminPermission(userOrPerms, permOrList) {
  if (!userOrPerms) return false;
  const required = Array.isArray(permOrList)
    ? permOrList.filter(Boolean)
    : (permOrList ? [permOrList] : []);
  if (required.length === 0) return false;

  let isSuperAdmin = false;
  let perms = [];

  if (Array.isArray(userOrPerms)) {
    perms = userOrPerms;
  } else if (typeof userOrPerms === 'object') {
    if (userOrPerms.role && userOrPerms.role !== 'admin') return false;
    isSuperAdmin = Boolean(userOrPerms.isSuperAdmin || userOrPerms.is_super_admin);
    if (Array.isArray(userOrPerms.permissions)) {
      perms = userOrPerms.permissions;
    }
  } else {
    return false;
  }

  if (isSuperAdmin || perms.includes('all')) return true;
  return required.some((p) => perms.includes(p));
}
