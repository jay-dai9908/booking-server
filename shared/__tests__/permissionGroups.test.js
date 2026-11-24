import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MONEY_WRITE,
  COUPON_WRITE,
  PASS_GRANT,
  KIOSK_SETTINGS_WRITE,
  GLOBAL_SETTING_FIELD_GROUPS,
  PERMISSION_LABELS,
  findSettingGroupForField,
  canAdminPermission,
} from '../permissionGroups.js';

test('Round 33 Item 1: canAdminPermission handles superadmin, all, single, any-of array, and empty permissions', () => {
  // Superadmin (either camelCase or snake_case) always passes when valid permission requested
  assert.equal(canAdminPermission({ isSuperAdmin: true, permissions: [] }, 'coupons'), true);
  assert.equal(canAdminPermission({ is_super_admin: true, permissions: [] }, MONEY_WRITE), true);

  // 'all' permission always passes
  assert.equal(canAdminPermission({ permissions: ['all'] }, 'settings'), true);
  assert.equal(canAdminPermission(['all'], MONEY_WRITE), true);

  // Single permission match
  assert.equal(canAdminPermission({ permissions: ['coupons'] }, COUPON_WRITE), true);
  assert.equal(canAdminPermission({ permissions: ['coupons'] }, 'coupons'), true);
  assert.equal(canAdminPermission({ permissions: ['accounting'] }, COUPON_WRITE), false);

  // Array any-of match
  assert.equal(canAdminPermission({ permissions: ['reservations'] }, MONEY_WRITE), true);
  assert.equal(canAdminPermission({ permissions: ['accounting'] }, MONEY_WRITE), true);
  assert.equal(canAdminPermission({ permissions: ['seating', 'weekly', 'equipment', 'coupons'] }, MONEY_WRITE), false);

  // Empty array / missing user / non-admin / empty required
  assert.equal(canAdminPermission([], 'seating'), false);
  assert.equal(canAdminPermission({ permissions: [] }, MONEY_WRITE), false);
  assert.equal(canAdminPermission(null, 'seating'), false);
  assert.equal(canAdminPermission({ role: 'customer', isSuperAdmin: true, permissions: ['all'] }, 'seating'), false);
  assert.equal(canAdminPermission(['all'], []), false);

  assert.deepEqual(MONEY_WRITE, ['accounting', 'reservations']);
  assert.deepEqual(COUPON_WRITE, ['coupons']);
  assert.deepEqual(PASS_GRANT, ['coupons']);
  assert.deepEqual(KIOSK_SETTINGS_WRITE, ['settings']);
  assert.equal(Object.keys(PERMISSION_LABELS).length, 10);
});

test('Round 33 Item 1: GLOBAL_SETTING_FIELD_GROUPS & findSettingGroupForField categorize fields properly', () => {
  for (const field of GLOBAL_SETTING_FIELD_GROUPS.sessions) {
    assert.equal(findSettingGroupForField(field), 'sessions');
  }
  for (const field of GLOBAL_SETTING_FIELD_GROUPS.equipment) {
    assert.equal(findSettingGroupForField(field), 'equipment');
  }
  for (const field of GLOBAL_SETTING_FIELD_GROUPS.settings) {
    assert.equal(findSettingGroupForField(field), 'settings');
  }

  assert.equal(findSettingGroupForField('weekday_hourly_price'), 'sessions');
  assert.equal(findSettingGroupForField('announcement_text'), 'sessions');
  assert.equal(findSettingGroupForField('equipment_discount_buy_hours'), 'equipment');
  assert.equal(findSettingGroupForField('line_messaging_token'), 'settings');
  assert.equal(findSettingGroupForField('line_button_url'), 'settings');
  assert.equal(findSettingGroupForField('payment_methods_json'), 'settings');
  assert.equal(findSettingGroupForField('future_unlisted_field'), 'settings');
});
