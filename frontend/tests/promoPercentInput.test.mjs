import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parsePercentInput,
  initPercentInputFromPromo,
  formatPercentConversionHint,
  formatPercentageBadge
} from '../src/utils/promoPercent.js';

test('Round 34 Item 5: promoPercentInput parses 打幾折 and 折掉幾 % cleanly', () => {
  const zhe85 = parsePercentInput({ mode: 'zhe', value: '8.5' });
  assert.deepEqual(zhe85, { valid: true, percent_off: 15, error: null });

  const zhe9 = parsePercentInput({ mode: 'zhe', value: '9' });
  assert.deepEqual(zhe9, { valid: true, percent_off: 10, error: null });

  const pct60 = parsePercentInput({ mode: 'pct', value: '60' });
  assert.deepEqual(pct60, { valid: true, percent_off: 60, error: null });

  assert.equal(parsePercentInput({ mode: 'zhe', value: '0' }).valid, false);
  assert.equal(parsePercentInput({ mode: 'zhe', value: '10' }).valid, false);
  assert.equal(parsePercentInput({ mode: 'zhe', value: '8.55' }).valid, false);
  assert.equal(parsePercentInput({ mode: 'pct', value: '0' }).valid, false);
  assert.equal(parsePercentInput({ mode: 'pct', value: '100' }).valid, false);

  assert.equal(formatPercentConversionHint(15, 600), '顧客付 85%（8.5 折），600 元折 90 元');
  assert.equal(formatPercentConversionHint(10, 600), '顧客付 90%（9 折），600 元折 60 元');

  assert.equal(formatPercentageBadge({ discount_type: 'percentage', discount_value: 90 }), '9 折（折 10%）');
  assert.equal(formatPercentageBadge({ discount_type: 'percentage', discount_value: 60, percent_off: 60 }), '4 折（折 60%）');
  assert.deepEqual(initPercentInputFromPromo({ discount_type: 'percentage', discount_value: 85 }), { mode: 'zhe', value: '8.5' });
});
