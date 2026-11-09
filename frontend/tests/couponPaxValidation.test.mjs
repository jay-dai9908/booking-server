import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { validateCouponPax } from '../src/utils/customer/couponPaxValidation.js';

describe('Coupon Pax Validation (Round 18 Item 2)', () => {
  const couponMin3 = {
    code: 'GROUP3',
    name: '三人成行折100',
    min_pax: 3
  };

  test('3 人時保留 (valid: true, cancelled: false)', () => {
    const result = validateCouponPax(couponMin3, 3);
    assert.strictEqual(result.valid, true);
    assert.strictEqual(result.cancelled, false);
    assert.strictEqual(result.message, undefined);
  });

  test('4 人時保留 (valid: true, cancelled: false)', () => {
    const result = validateCouponPax(couponMin3, 4);
    assert.strictEqual(result.valid, true);
    assert.strictEqual(result.cancelled, false);
  });

  test('2 人時回傳取消和訊息 (valid: false, cancelled: true, message: 此優惠券需滿 3 人方可使用，已自動取消套用)', () => {
    const result = validateCouponPax(couponMin3, 2);
    assert.strictEqual(result.valid, false);
    assert.strictEqual(result.cancelled, true);
    assert.strictEqual(result.message, '此優惠券需滿 3 人方可使用，已自動取消套用');
  });

  test('1 人時回傳取消和訊息', () => {
    const result = validateCouponPax(couponMin3, 1);
    assert.strictEqual(result.valid, false);
    assert.strictEqual(result.cancelled, true);
    assert.strictEqual(result.message, '此優惠券需滿 3 人方可使用，已自動取消套用');
  });

  test('無優惠券時回傳 valid: true, cancelled: false', () => {
    const result = validateCouponPax(null, 2);
    assert.strictEqual(result.valid, true);
    assert.strictEqual(result.cancelled, false);
  });

  test('無 min_pax 限制的優惠券時回傳 valid: true, cancelled: false', () => {
    const couponNoMin = { code: 'ANYONE', min_pax: 1 };
    const result = validateCouponPax(couponNoMin, 1);
    assert.strictEqual(result.valid, true);
    assert.strictEqual(result.cancelled, false);
  });
});
