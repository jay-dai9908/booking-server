import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeDraftConflict, mergeDraftConflict } from '../src/utils/admin/draftConflict.js';

test('Round 37 Item 5: 3-way mergeDraftConflict preserves server additions alongside local changes', () => {
  const baseDraft = {
    rev: 0,
    persons: [{ person_no: 1, mode: 'hourly' }],
    order_addons: [],
    order_promos: [],
    manual_discount: null,
    total_override: null,
    note: ''
  };
  const serverDraft = {
    rev: 1,
    persons: [{ person_no: 1, mode: 'hourly' }],
    order_addons: [{ key: 'k-a', name: '鑰匙圈', price: 100, qty: 1 }],
    order_promos: [{ code: 'VIP', discount_amount: 50 }],
    manual_discount: null,
    total_override: null,
    note: ''
  };
  const localDraft = {
    rev: 0,
    persons: [{ person_no: 1, mode: 'hourly' }],
    order_addons: [{ key: 'k-b', name: '磁鐵', price: 80, qty: 1 }],
    order_promos: [],
    manual_discount: null,
    total_override: null,
    note: ''
  };

  const analysis = analyzeDraftConflict({ baseDraft, localDraft, serverDraft });
  assert.deepEqual(analysis.bothChangedLabels, ['整單加購']);

  const merged = mergeDraftConflict({ baseDraft, localDraft, serverDraft });
  assert.equal(merged.rev, 1);
  assert.equal(merged.order_addons.length, 2);
  assert.ok(merged.order_addons.some(a => a.name === '鑰匙圈'));
  assert.ok(merged.order_addons.some(a => a.name === '磁鐵'));
  // Promos stay strictly on serverDraft
  assert.deepEqual(merged.order_promos, [{ code: 'VIP', discount_amount: 50 }]);
});
